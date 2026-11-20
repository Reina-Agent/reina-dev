import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NoteIndexEntry, SessionState, ToolDescriptor } from "@reina/protocol";
import { deferredToolDescriptors, getMcpStatusMap, reinaConfigHome } from "@reina/tools";
import { baseAgentPrompt, formatTaskGuidance } from "./agent-guidance.js";
import { isCompactionOffloadEnabled } from "./chunks.js";
import { profiles, resolveProfile } from "./profiles.js";
import { formatSkillsPrompt } from "./skills.js";
import type { ModelContextSection } from "./context-state.js";

/** Freeze the MCP server name set into the session at first system-prompt
 * build, so the cached prefix stays byte-stable for the rest of the session
 * even if servers connect or drop. Live drift (vs. this snapshot) is
 * surfaced in the volatile reminder by `formatMcpDriftReminder`.
 *
 * Returns the just-taken names when this call actually created the snapshot,
 * `null` when one already existed. The engine uses the return value to emit
 * a one-time rollout event so the snapshot survives restart / loadSession —
 * without that, replaying the session would re-freeze against the CURRENT
 * live MCP set and silently change the cached system-prompt prefix. */
export function snapshotMcpServersIfNeeded(session: SessionState): string[] | null {
  if (session.mcpServerNamesSnapshot) return null;
  const names = Object.keys(getMcpStatusMap()).sort();
  session.mcpServerNamesSnapshot = names;
  return names;
}

export function buildSystemPrompt(session: SessionState): string {
  snapshotMcpServersIfNeeded(session);
  const profile = resolveProfile(session.agent);
  const role = (session.subagentDepth ?? 0) === 0 ? "supervisor" : "worker";
  // STABLE sections only — content here must stay byte-identical across
  // tool-loop iterations and across "user thinking" gaps so the provider
  // cache prefix (Anthropic ephemeral, OpenAI auto-prefix) actually hits.
  // Per-turn volatile state (summary, plan, todos, notes, memory chunks,
  // autopilot status) moved to `buildVolatileContextReminder` — it ships
  // as diffed context messages OUTSIDE the cached prefix only when a section
  // changes.
  return [
    "You are Reina, a local agent.",
    baseAgentPrompt,
    // 天才思考法则 (divergent-thinking overlay) and the Java gadget-chain audit
    // methodology used to live in this always-on prefix. Both are now on-demand
    // skills the user keeps under ~/.claude/skills (`genius`, `security-audit`),
    // surfaced via the skills roster — a general turn no longer pays for them;
    // the model loads each from the absolute location in the skill roster only
    // when the task fits (built-in skills remain available via read_skill).
    `Current agent: ${profile.name}`,
    profile.prompt,
    formatProfileCapabilities(profile),
    formatSkillsPrompt(session.skills),
    formatOutputStyleGuidance(session.outputStyle, session.outputStyleCustom),
    formatTaskGuidance(profiles, role),
    formatShellGuidance(session.cwd),
    formatToolSelectionGuidance(),
    // Native deferred-tool capability index. Static per build (pure function
    // of the compiled-in deferred set), so it belongs INSIDE the cached prefix.
    // Exact names/schemas live behind search_tool instead of adding ~1k tokens
    // of per-tool summaries to every request. Dynamic MCP deferred tools stay
    // per-turn: see `buildHiddenToolsReminder` below.
    formatDeferredToolsCatalog(),
    formatMcpGuidance(session),
    formatUserRulesPrompt(session.cwd),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Current volatile context, retained as a compatibility aggregate. Anything whose
 * value depends on transient session state (todos / plan / autopilot round /
 * notes index / memory chunks index) belongs here, NOT in the cached system
 * prompt. The engine diffs `buildVolatileContextSections` and appends only
 * changed sections. Returns "" when nothing applies.
 *
 * The compaction summary is deliberately NOT here: it is folded once into a
 * cacheable post-compact message in `modelMessages` (see
 * `buildPostCompactContextMessage`), so it is paid once per compaction instead
 * of re-sent uncached on every turn. */
export function buildVolatileContextReminder(session: SessionState): string {
  const sections = buildVolatileContextSections(session)
    .map((section) => section.content)
    .filter(Boolean);
  if (sections.length === 0) return "";
  return sections.join("\n\n");
}

/** Typed, independently diffable pieces of the volatile context. Keep IDs
 * stable: they are persisted in hidden message metadata and form the resume
 * baseline. `cleared` actively retires stale instructions instead of relying
 * on their absence. */
export function buildVolatileContextSections(session: SessionState): ModelContextSection[] {
  return [
    {
      id: "memory_chunks",
      content: formatMemoryChunksIndex(session),
      cleared:
        "The previously provided offloaded-memory index is no longer current. Use search_memory if older details are needed.",
    },
    {
      id: "goal",
      content: formatGoalPrompt(session),
      cleared: "There is no current Goal. Disregard the previously provided Goal state.",
    },
    {
      id: "plan_mode",
      content:
        session.permissionMode === "plan"
          ? [
              "## Plan mode",
              "Plan mode is active. Investigate with read-only tools only; do not modify files or external state.",
              "Ask the user only for choices that materially change the plan.",
              "When the plan is ready, call `exit_plan_mode` with the complete plan for approval.",
            ].join("\n")
          : "",
      cleared: "Plan mode is no longer active; follow the current permission mode.",
    },
    {
      id: "plan",
      content: session.plan
        ? `Current plan (${session.plan.status}) — already shown to the user; reference or update it, don't restate it verbatim:\n${session.plan.content}`
        : "",
      cleared: "The previously provided current plan no longer applies.",
    },
    {
      id: "todos",
      content: formatTodoStatePrompt(session),
      cleared: "The previously provided TODO state is no longer current; there are no active TODO items to follow.",
    },
    {
      id: "todo_nudge",
      content: formatTodoNudge(session),
      cleared: "The previous TODO maintenance nudge is no longer current.",
    },
    {
      id: "workspace_notes",
      content: formatNotesIndexPrompt(session),
      cleared: "The previously provided workspace-notes index is no longer current.",
    },
    {
      id: "global_notes",
      content: formatGlobalNotesPrompt(session),
      cleared: "The previously provided global-notes index is no longer current.",
    },
    {
      id: "autopilot",
      content: formatAutopilotPrompt(session),
      cleared: "Autopilot mode is no longer active; disregard its previous goal, round, and time budget.",
    },
    {
      id: "mcp_status",
      content: formatMcpStatusReminder(session),
      cleared: "The previously reported MCP server failures are no longer current.",
    },
    {
      id: "mcp_drift",
      content: formatMcpDriftReminder(session),
      cleared: "The previously reported MCP server drift is no longer present.",
    },
  ];
}

/** Dynamic context section for hidden MCP tools only. The MCP runtime pool is
 * dynamic (servers connect/drop, residency policy changes), so its roster
 * can't live in the cached system prompt the way the static native catalog
 * does (`formatDeferredToolsCatalog`) — it ships as an uncached per-turn
 * context instead. The engine emits it only when the roster changes. Returns
 * "" when every pooled MCP tool is already visible (or there is no pool).
 *
 * Discovered tools are excluded when their definitions ship in the request,
 * including after compaction or a fork inherits the active tool names. */
export function buildHiddenToolsReminder(
  mcpRuntimePool?: ReadonlyArray<ToolDescriptor>,
  /** Names actually present in the request's visible tools array (resident
   * MCP tools, promotions). These get filtered OUT — listing a tool the
   * model already sees in its tools array is misleading and burns tokens.
   * Pass an empty array / omit when nothing beyond the direct set is in
   * the array. */
  namesInVisibleArray?: ReadonlyArray<string>,
): string {
  const inArray = new Set(namesInVisibleArray ?? []);
  const remainingMcp = (mcpRuntimePool ?? []).filter((tool) => !inArray.has(tool.name));
  if (remainingMcp.length === 0) return "";
  const names = remainingMcp.map((tool) => tool.name).sort();
  const servers = new Set(
    remainingMcp.map((tool) => tool.name.split("__")[1]).filter((server): server is string => Boolean(server)),
  );
  return [
    "## Hidden tools",
    "These MCP tools are hidden from the visible tools array (prompt-cache stability) but callable directly by name — the engine auto-resolves the call, same as the deferred catalog in your system prompt. `search_tool` finds their schemas.",
    `Hidden MCP tools (${remainingMcp.length} across ${servers.size} server${servers.size === 1 ? "" : "s"}): ${names.join(", ")}.`,
  ].join("\n");
}

// Module-level mtime-keyed cache so we don't re-read the rule files on every
// turn. Keyed by cwd because the global + AGENTS.md paths derive from it.
// Invalidated when any source's mtime changes (creating an ancestor AGENTS.md
// flips its mtime 0 -> real), so an in-place edit still flows through next turn.
const userRulesCache = new Map<string, { mtimes: number[]; text: string }>();

/** Collect every `AGENTS.md` from `cwd` up to the filesystem root, ordered
 * root-first so the nearest (most specific) file is appended last and wins
 * on conflict. A monorepo sub-package session therefore still inherits the
 * repo-root AGENTS.md instead of silently dropping it. */
function ancestorAgentsFiles(cwd: string): { label: string; path: string }[] {
  const files: { label: string; path: string }[] = [];
  let dir = resolve(cwd);
  for (;;) {
    files.push({ label: "AGENTS.md", path: join(dir, "AGENTS.md") });
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return files.reverse();
}

/** Inject user-authored rule files into the system prompt, in order of
 * increasing specificity: global rules (`~/.reina/rules.md`), workspace rules
 * (`.reina/rules.md`), then every `AGENTS.md` from the filesystem root down to
 * the workspace (nearest wins). Missing or empty files are skipped silently.
 * Framed as "user rules — take precedence" so the model treats them as
 * authoritative when they conflict with the default guidance.
 *
 * Exported so the token-breakdown UI can measure this section's
 * contribution to the system prompt independently of the rest. */
export function formatUserRulesPrompt(cwd: string): string {
  const sources = [
    { label: "Global rules", path: join(reinaConfigHome(), "rules.md") },
    { label: "Workspace rules", path: join(cwd, ".reina", "rules.md") },
    ...ancestorAgentsFiles(cwd),
  ];
  const mtimes = sources.map((src) => {
    try {
      return statSync(src.path).mtimeMs;
    } catch {
      return 0;
    }
  });
  const cached = userRulesCache.get(cwd);
  if (cached && cached.mtimes.length === mtimes.length && cached.mtimes.every((m, i) => m === mtimes[i])) {
    return cached.text;
  }
  const blocks: string[] = [];
  for (const src of sources) {
    try {
      const text = readFileSync(src.path, "utf8").trim();
      if (text) blocks.push(`### ${src.label} — ${src.path}\n${text}`);
    } catch {
      // ENOENT or unreadable — skip
    }
  }
  const text =
    blocks.length === 0
      ? ""
      : [
          "## User rules",
          "These rules come from the user's rules.md / AGENTS.md files. They take precedence over the default guidance above when they conflict.",
          ...blocks,
        ].join("\n\n");
  userRulesCache.set(cwd, { mtimes, text });
  return text;
}

/** Tell the model which configured MCP servers its profile can use, so it never has
 * to guess a name like `desktop` for mcp_list_resources / mcp_read_resource.
 * Reads from the in-process status map populated by precomputeMcpServers at
 * session boot — synchronous, no IO. Returns an empty string when no servers
 * are configured (don't pollute the prompt with empty-state noise).
 *
 * Lists ONLY the server names — never their live connection status. Pulls
 * from `session.mcpServerNamesSnapshot` (frozen at first system-prompt build,
 * see `snapshotMcpServersIfNeeded`) so the cached prefix stays byte-stable
 * even if servers connect or drop mid-session. Live drift surfaces in the
 * per-turn (uncached) reminder via `formatMcpDriftReminder`. */
function mcpServerNamesVisibleToProfile(session: SessionState, names: ReadonlyArray<string>): string[] {
  const allowed = resolveProfile(session.agent).mcpServers;
  if (!allowed?.length) return [...names];
  const allowedSet = new Set(allowed);
  return names.filter((name) => allowedSet.has(name));
}

function formatMcpGuidance(session: SessionState): string {
  const names = mcpServerNamesVisibleToProfile(
    session,
    session.mcpServerNamesSnapshot ?? Object.keys(getMcpStatusMap()).sort(),
  );
  if (names.length === 0) return "";
  return [
    "## MCP servers",
    "MCP servers available to the current agent profile:",
    ...names.map((name) => `  - ${name}`),
    "When you need MCP resources, pass one of these exact names to mcp_list_resources / mcp_read_resource, or omit `server` to fan out across all of them. Do not invent server names.",
    "Resident or already activated server tools appear in your tool list as `mcp__<server>__<tool>`. For configured tools that are still hidden, use `search_tool` to discover and activate the exact schema before calling them.",
  ].join("\n");
}

/** Surface MCP server-set drift since the snapshot was frozen (at first
 * system-prompt build). When servers connect or drop mid-session, the
 * snapshot keeps the cached system prompt byte-stable but the model would
 * otherwise be misled about what's available — this reminder closes the
 * gap and tells the user how to refresh. Returns "" when the live set
 * matches the snapshot exactly (the common case). */
function formatMcpDriftReminder(session: SessionState): string {
  const snapshot = session.mcpServerNamesSnapshot;
  if (!snapshot) return "";
  const snap = mcpServerNamesVisibleToProfile(session, snapshot);
  const live = mcpServerNamesVisibleToProfile(session, Object.keys(getMcpStatusMap()).sort());
  if (live.length === snap.length && live.every((n, i) => n === snap[i])) return "";
  const added = live.filter((n) => !snap.includes(n));
  const removed = snap.filter((n) => !live.includes(n));
  const lines = ["## MCP server set drifted"];
  lines.push(`Cached tool catalog is frozen to the session-start snapshot: [${snap.join(", ")}].`);
  if (added.length > 0) lines.push(`Connected since: ${added.join(", ")}.`);
  if (removed.length > 0) lines.push(`Disconnected since: ${removed.join(", ")}.`);
  lines.push("Run /new to refresh the cached catalog so the model sees the current server set.");
  return lines.join("\n");
}

/** Live MCP connection status, surfaced as a per-turn system-reminder so it
 * stays OUT of the cached system prefix (companion to the stable name roster
 * in `formatMcpGuidance`). Only lists servers that are NOT connected — when
 * everything is healthy this returns "" and adds zero tokens. The point is to
 * flag servers the model should avoid this turn without letting the volatile
 * status text churn the Anthropic/OpenAI cache prefix. */
function formatMcpStatusReminder(session: SessionState): string {
  const status = getMcpStatusMap();
  const abnormal = mcpServerNamesVisibleToProfile(session, Object.keys(status).sort()).filter(
    (name) => status[name]!.status !== "connected",
  );
  if (abnormal.length === 0) return "";
  const lines = abnormal.map((name) => {
    const entry = status[name]!;
    return entry.status === "failed" ? `  - ${name}: failed (${entry.error})` : `  - ${name}: ${entry.status}`;
  });
  return ["## MCP server status", "These profile-available MCP servers are not currently usable:", ...lines].join("\n");
}

function formatProfileCapabilities(profile: {
  name: string;
  toolPermissions: Record<string, string | undefined>;
}): string {
  const denied = Object.entries(profile.toolPermissions || {})
    .filter(([, mode]) => mode === "deny")
    .map(([name]) => name);
  if (denied.length === 0) return "";
  const friendly = (n: string) => n;
  const lines = [
    `## Profile constraints`,
    `Your current profile (\`${profile.name}\`) denies these tools: ${denied.map(friendly).join(", ")}.`,
    "If the user asks for something that needs a denied tool, do NOT pretend you simply have no tools. Instead, briefly explain which capability the user needs and tell them how to switch:",
    `  → "I'm in the \`${profile.name}\` profile, which can't run shell commands or modify files. To do that, switch the agent in the composer bar (bottom of the screen) to \`default\`, then ask again. Or switch permissionMode to \`default\` if the goal only needs the current agent to be more permissive."`,
    'If the user actively wants read-only mode they can keep the current profile and use \`permissionMode: "plan"\` (top-bar toggle) — that path doesn\'t require switching agents at all.',
  ];
  return lines.join("\n");
}

function formatOutputStyleGuidance(style?: SessionState["outputStyle"], custom?: string): string {
  const sections: string[] = ["## Output style"];
  switch (style) {
    case "concise":
      sections.push(
        "Be maximally terse. Skip preamble and summaries unless explicitly asked. Output the answer or diff and stop.",
      );
      break;
    case "explanatory":
      sections.push(
        "Briefly annotate non-trivial decisions and trade-offs. Mention what you considered and rejected when it would help the reader.",
      );
      break;
    case "learning":
      sections.push(
        "Teach as you go. After each non-trivial step, add a one-line note that helps the user learn the underlying concept or pitfall.",
      );
      break;
    default:
      sections.push("Default tone: clear, direct, no fluff. Use code blocks for code, prose otherwise.");
  }
  if (custom && custom.trim()) sections.push(custom.trim());
  return sections.join("\n");
}

function formatShellGuidance(cwd: string): string {
  const shell = process.platform === "win32" ? "Windows PowerShell" : "the local POSIX shell";
  // The date stays in the STABLE prefix on purpose: it is byte-identical
  // across tool-loop iterations within a day, so the provider cache prefix
  // still hits; it changes (one cache miss) only when the calendar day rolls
  // over. Without it the model has no temporal anchor and misjudges anything
  // date-relative ("recent", "latest", "is X out yet").
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `## Environment\nWorkspace: ${cwd}\nToday's date: ${today}\nrun_shell executes commands through ${shell}.`;
}

/** Render the live todo list at every turn so the model never loses
 * sight of what's left. Without this, the JSON dump returned by
 * write_todos is the only place the list ever appears in context —
 * after a few rounds of tool observations it falls off the back of the
 * model's attention. */
function formatTodoStatePrompt(session: SessionState): string {
  const todos = session.todos ?? [];
  if (todos.length === 0) return "";
  const lines = todos.map((todo) => {
    const mark = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]";
    return `  ${mark} ${todo.id} (${todo.status}) ${todo.content}`;
  });
  const counts = todos.reduce(
    (acc, todo) => {
      acc[todo.status] = (acc[todo.status] ?? 0) + 1;
      return acc;
    },
    { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>,
  );
  return [
    "## Active todos",
    `${todos.length} total — pending: ${counts.pending}, in_progress: ${counts.in_progress}, completed: ${counts.completed}.`,
    "Keep exactly ONE item `in_progress` at a time. Mark items completed via write_todos as soon as they're done — don't batch. Re-evaluate the list when scope changes.",
    ...lines,
  ].join("\n");
}

/** Conditional nudge: if the session has run for a while without a
 * write_todos call AND looks non-trivial, suggest using the tool to
 * track progress. Keep each nudge's text stable so context-state diffing
 * only injects it when the reminder state changes, not on every tool call.
 *
 * Triggers when:
 * - At least 6 tool calls have happened since the last write_todos
 *   (or since session start, if write_todos was never called).
 * - The session has executed at least 6 tool calls total (so we don't
 *   nag on short conversations that legitimately don't need a list).
 * The thresholds are conservative — false positives are worse than
 * false negatives here. */
function formatTodoNudge(session: SessionState): string {
  const total = session.toolCalls?.length ?? 0;
  if (total < 6) return "";
  const lastIdx = session.lastWriteTodosToolCallIndex ?? -1;
  const gap = total - lastIdx;
  if (gap < 6) return "";
  const hasActiveTodos = (session.todos ?? []).some((t) => t.status !== "completed");
  // If there's an active list but the gap is large, the model has stopped
  // maintaining it — that's worth flagging. If there's no list at all,
  // suggest creating one. Skip when the list is fully closed AND we just
  // reset it (gap is short by construction in that case, so we wouldn't
  // be here anyway).
  if (hasActiveTodos) {
    return [
      "## Todo list maintenance reminder",
      "You have an active todo list that may need updating. Update the status of any work you've finished, drop items that are no longer relevant, and add anything new the user has surfaced.",
    ].join("\n");
  }
  return [
    "## Todo list reminder",
    "If the current request has 3+ distinct steps, create a todo list now so you and the user can both track progress. Skip this if the task really is single-step.",
  ].join("\n");
}

/** Phase B compaction-offload: surface the per-session memory-chunk index
 * (id + topicLine + tokenCount + tool hints) so the model can decide
 * whether to `recall_memory_chunk(id)` for an exact older detail.
 *
 * Stays empty when:
 *  - `REINA_COMPACTION_OFFLOAD` is not "1" (feature flag off)
 *  - the session has produced no chunks yet
 *
 * Caps the visible list at 50 most-recent chunks. Older chunks remain
 * recallable by id via `list_memory_chunks` — keeping the index here
 * bounded preserves Anthropic prompt-cache hit rate (the prefix is
 * stable as long as you don't reorder it). */
function formatMemoryChunksIndex(session: SessionState): string {
  if (!isCompactionOffloadEnabled()) return "";
  const chunks = session.memoryChunks ?? [];
  if (chunks.length === 0) return "";
  const VISIBLE = 50;
  const head = chunks.length > VISIBLE ? chunks.slice(-VISIBLE) : chunks;
  const hiddenCount = chunks.length - head.length;
  const lines = head.map((c) => {
    const tools = c.toolNames.length > 0 ? ` [${c.toolNames.join(", ")}]` : "";
    return `  ${c.id} (${c.createdAt}, ~${c.tokenCount}t): ${c.topicLine}${tools}`;
  });
  const tail =
    hiddenCount > 0 ? [`  (${hiddenCount} older chunk(s) hidden — call list_memory_chunks() to see all)`] : [];
  return [
    "## Offloaded memory (compaction chunks)",
    "Older parts of this conversation are lossless-archived as recallable chunks.",
    "Call `recall_memory_chunk(id)` when you need an exact earlier detail; the body returns as a tool observation in this turn only.",
    ...lines,
    ...tail,
  ].join("\n");
}

/** Inject the most recent shared-notebook entries so the model doesn't
 * burn a turn on a cold-start `list_notes` call. Cheap: index-only rows
 * (id + title + tags + status), capped at 30 entries — ~30 tokens each,
 * so even at the cap this stays under 1k tokens.
 *
 * The cap is intentional: subagents in a fan-out should see WHAT exists
 * (titles + tags) so they can cite refs, but they should still call
 * `read_note(id)` to pull bodies on demand. Putting bodies here would
 * pollute every subagent's context with the parent's entire dossier. */
export function formatNotesIndexPrompt(session: SessionState): string {
  const notes = session.notes ?? [];
  if (notes.length === 0) return "";

  // Partition strategy: confirmed findings, ruled-out dead-ends, and active
  // hypotheses are ALWAYS surfaced (capped) so they survive long sessions.
  // - confirmed: an old confirmed finding stays available to combine with a
  //   freshly-discovered one into a chain.
  // - dead: a ruled-out path stays visible so the model does NOT re-explore
  //   it after it falls off the recency window — the "forgot it was a dead
  //   end, walked it again" failure mode.
  // Remaining slots are filled by most-recent open/todo notes. Hard caps
  // keep the system-prompt token budget bounded (each line ~30 tokens).
  const PINNED_CAP = 80;
  const RECENT_CAP = 30;
  const sortedByRecency = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const isPinned = (entry: (typeof sortedByRecency)[number]): boolean =>
    entry.status === "confirmed" ||
    entry.status === "dead" ||
    entry.tags.some((t) => t === "kind:hypothesis" || t === "kind:handoff" || t === "kind:goal");
  const pinned = sortedByRecency.filter(isPinned).slice(0, PINNED_CAP);
  const pinnedIds = new Set(pinned.map((n) => n.id));
  const recent = sortedByRecency.filter((n) => !pinnedIds.has(n.id)).slice(0, RECENT_CAP);
  const merged = [...pinned, ...recent].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Render rows grouped by reasoning role so the index reads as a structured,
  // navigable map (a "目录") instead of a flat recency list — confirmed chains,
  // hypotheses to discharge, ruled-out dead-ends, and the open worklist each
  // get their own section. Grouping keys off EXISTING signals only (status +
  // kind:* tags) — no domain-specific kinds, so it stays principle-level. The
  // set shown, the caps, and the hidden count are unchanged; only the display
  // sectioning differs. Within a group, recency order (from `merged`) is kept.
  const renderRow = (entry: (typeof merged)[number]): string => {
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
    const refs = entry.refs.length > 0 ? ` ←${entry.refs.join(",")}` : "";
    const pin = pinnedIds.has(entry.id) ? "★" : " ";
    return `  ${pin} ${entry.id} (${entry.status}) ${entry.title}${tags}${refs}`;
  };
  const groupKey = (entry: (typeof merged)[number]): string => {
    if (entry.status === "confirmed") return "confirmed";
    if (entry.status === "dead") return "dead";
    if (entry.tags.includes("kind:hypothesis")) return "hypothesis";
    if (entry.tags.includes("kind:goal") || entry.tags.includes("kind:handoff")) return "anchor";
    return "open";
  };
  const GROUP_ORDER: ReadonlyArray<readonly [string, string]> = [
    ["confirmed", "▼ Confirmed findings & chains"],
    ["hypothesis", "▼ Hypotheses — verify or refute"],
    ["dead", "▼ Dead ends — revive conditions are in the body"],
    ["open", "▼ Open leads"],
    ["anchor", "▼ Goals & handoffs"],
  ];
  const lines: string[] = [];
  for (const [key, heading] of GROUP_ORDER) {
    const rows = merged.filter((entry) => groupKey(entry) === key);
    if (rows.length === 0) continue;
    lines.push(heading, ...rows.map(renderRow));
  }
  // Non-lossy truncation signal: when notes outnumber what we can inject, the
  // model must KNOW the list is partial — otherwise it treats the window as
  // the whole dossier and re-runs work whose result already exists below the
  // fold. Tell it exactly how many are hidden and how to pull them.
  const hidden = notes.length - merged.length;
  const headerCounts = [
    `total ${notes.length}`,
    `pinned ${pinned.length} (confirmed + dead-ends + kind:hypothesis + kind:handoff + kind:goal)`,
    `recent ${recent.length}`,
    ...(hidden > 0 ? [`hidden ${hidden}`] : []),
  ].join(", ");
  const note = session.isSubagent
    ? "These are findings other agents (or your past self) wrote. Cross-pollinate: when your work builds on an existing note, set `refs:[\"n_xxx\"]` on your own note so the link is explicit. If your task is investigation/audit, persist results as notes — confirmed findings, open leads, `kind:hypothesis` for suspicions you haven't yet validated, or 2-3 sentence `status=dead` notes when you've ruled something out (so later agents don't re-explore). For pure execution tasks (edit / rename / run-test), notes are only needed for incidental discoveries."
    : "Subagents share this notebook. Encourage them to write findings via `note(...)` so cross-pollination happens. Entries marked ★ are pinned (confirmed findings, ruled-out dead-ends, and active `kind:hypothesis`); look across them when hunting for vulnerability chains, and don't re-explore a `dead` path.";
  const truncationWarning =
    hidden > 0
      ? `⚠ ${hidden} older note(s) are NOT shown above. Before re-investigating anything, call \`list_notes()\` to check the full set — do NOT assume this list is complete.`
      : "";
  return [
    "## Shared notebook",
    `${headerCounts}. Read individual bodies with \`read_note(id)\` when a title looks relevant. Use \`list_notes\` for filtered queries (e.g. by tag or refs). This notebook is a compounding wiki: fold new info into an existing note when it fits (\`update_note\`) rather than always appending, and set \`refs\` to link related notes. Its organizing conventions live in \`.reina/notes/schema.md\` — read it if unsure how to file or tag a note.`,
    note,
    ...lines,
    ...(truncationWarning ? ["", truncationWarning] : []),
  ].join("\n");
}

/** Inject the GLOBAL cross-project notebook (`<REINA_HOME>/notes`, `g_`
 * ids) so durable memory — user preferences, reusable techniques, general
 * knowledge — is present in every session regardless of repo. This is the
 * declarative half of Reina's "grow with you" loop (skills are the
 * procedural half). Kept compact: index rows only, bodies pulled lazily via
 * `read_note(id, scope:"global")`. Global memory is expected to stay small,
 * so a flat kind-grouped list is enough — no pinning/recency machinery. */
export function formatGlobalNotesPrompt(session: SessionState): string {
  const notes = session.globalNotes ?? [];
  if (notes.length === 0) return "";
  const CAP = 40;
  const kindOf = (entry: NoteIndexEntry): string => {
    const k = entry.tags.find((t) => t.startsWith("kind:"));
    return k ? k.slice("kind:".length) || "other" : "other";
  };
  const renderRow = (entry: NoteIndexEntry): string => {
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
    const refs = entry.refs.length > 0 ? ` ←${entry.refs.join(",")}` : "";
    return `  ${entry.id} ${entry.title}${tags}${refs}`;
  };
  const shown = [...notes].sort((a, b) => a.id.localeCompare(b.id)).slice(0, CAP);
  const groups = new Map<string, NoteIndexEntry[]>();
  for (const entry of shown) {
    const g = kindOf(entry);
    const arr = groups.get(g);
    if (arr) arr.push(entry);
    else groups.set(g, [entry]);
  }
  const lines: string[] = [];
  for (const g of [...groups.keys()].sort()) {
    lines.push(`▼ ${g}`, ...groups.get(g)!.map(renderRow));
  }
  const hidden = notes.length - shown.length;
  return [
    "## Global memory (cross-project)",
    `${notes.length} note(s) of durable, cross-project knowledge — the same memory in every repo. Read bodies with \`read_note(id, scope:"global")\`. When you learn something that stays true across projects (a user preference, a reusable technique, a general fact), record it with \`note(..., scope:"global")\` — fold into an existing note (\`update_note(..., scope:"global")\`) rather than appending a near-duplicate. Project-specific findings stay in the workspace notebook above. Notes reflect what was true when written: before acting on a remembered file, flag, or command, verify it still exists — and fix the note if it doesn't.`,
    ...lines,
    ...(hidden > 0 ? ["", `⚠ ${hidden} more not shown — \`list_notes(scope:"global")\` for the full set.`] : []),
  ].join("\n");
}

/** Dynamic snapshot of the one authoritative Goal. It deliberately lives in
 * a diffed context section rather than the cached system prompt: usage,
 * run rounds and state revision can change every turn. */
function formatGoalPrompt(session: SessionState): string {
  const state = session.goal;
  const goal = state?.current;
  if (!state || !goal) return "";
  const lines = [
    "## Current Goal",
    `State revision: ${state.revision}`,
    `Goal: ${goal.id} (objective revision ${goal.revision}, status ${goal.status})`,
    `Objective: ${goal.objective}`,
    ...(goal.completionCriterion ? [`Completion criterion: ${goal.completionCriterion}`] : []),
    `Usage: ${goal.usage.tokensUsed} tokens, ${goal.usage.turnsUsed} turns, ${Math.round(goal.usage.wallClockMs / 1000)}s`,
    ...(state.completionClaim
      ? ["Completion has been claimed and is awaiting independent verification. Do not submit the same claim again."]
      : []),
    ...(state.run?.lastVerifyReason
      ? [
          `Previous verification rejected: ${state.run.lastVerifyReason}`,
          ...(state.run.lastVerifyFeedback ? [`Required next step: ${state.run.lastVerifyFeedback}`] : []),
        ]
      : []),
    "",
  ];
  if (goal.status === "active") {
    lines.push(
      "This Goal was already created by the host. Do NOT call create_goal for it.",
      "Continue toward the full objective. When evidence proves every requirement, call update_goal(status=complete, evidence=...). The Goal remains active until an independent verifier accepts the claim.",
      "If the same blocker has genuinely repeated and no meaningful progress is possible without user/external change, call update_goal(status=blocked, reason=...).",
    );
  } else if (goal.status === "paused") {
    lines.push("The user paused this Goal. Do not pursue or resolve it until the user resumes it.");
  } else if (goal.status === "blocked") {
    lines.push(
      `This Goal is blocked${goal.terminalReason ? `: ${goal.terminalReason}` : "."} Wait for the user to resume, edit, replace, or clear it.`,
    );
  } else {
    lines.push("This Goal is complete. Do not create another Goal unless the user explicitly starts a new one.");
  }
  return lines.join("\n");
}

/** Surface the autopilot loop state into the supervisor prompt. Only
 * appears when autopilot is active. Tells the model the running budget,
 * what's left, and that `declare_audit_done` is its way to exit
 * cleanly. */
function formatAutopilotPrompt(session: SessionState): string {
  const ap = session.autopilot;
  if (!ap || !ap.running) return "";
  const lines: string[] = ["## Autopilot mode"];
  lines.push(`Goal: ${ap.goal}`);
  lines.push(`Round: ${ap.rounds}` + (ap.maxRounds ? ` / ${ap.maxRounds}` : ""));
  if (ap.maxWallClockMs) {
    const elapsedMs = Date.now() - Date.parse(ap.startedAt);
    const remainingMin = Math.max(0, Math.round((ap.maxWallClockMs - elapsedMs) / 60000));
    lines.push(`Time remaining: ~${remainingMin} min`);
  }
  lines.push(
    "You are auto-driving an audit loop. Each turn: (1) read the recent notebook + ★pinned entries; (2) by default, take ONE direct step yourself — read code, run a focused grep, write a note, refine a hypothesis; (3) ONLY when the next step is genuinely fan-out-shaped (2+ independent threads) or context-isolation-shaped (a deep dive that would pollute your main context) should you dispatch a subagent; (4) call `declare_audit_done` once the goal is met or no leads remain.",
  );
  lines.push(
    "Subagent results that aren't written as notes vanish after the dispatching turn — the next round only sees the notebook, not previous tool observations. When you brief a subagent, ask it to persist findings / leads / dead-ends as `note(...)` calls, not just return values.",
  );
  lines.push(
    "Logical-vulnerability and chain hunting: when you suspect something but haven't verified, write a `kind:hypothesis` note (it stays pinned in your notebook across rounds, unlike `open` leads that fall off the recency window). Every ~5 rounds, spend one round reviewing the pinned ★ entries (confirmed + hypotheses) — chains usually emerge from combining two old findings, not from a single deep dive.",
  );
  lines.push(
    "Call `declare_audit_done(status, summary)` when the goal is met (`complete`), no leads remain (`exhausted`), or you need a human (`blocked`). Citing important note ids in the summary makes the auto-generated report stronger.",
  );
  return lines.join("\n");
}

function formatToolSelectionGuidance(): string {
  return [
    "## Tool catalog (deep dive on demand)",
    "For richer usage patterns, sibling-tool tradeoffs, and edge cases, call read_skill:",
    "- `subagent-delegation` — task / get_async_tasks / wait / update / cancel async-task family.",
    "- `tool-selection` — when to pick run_shell vs file tools (read_file/edit_file/etc.), and how to recover from a missing path.",
    "Read the matching skill the moment you're picking between siblings or hit an edge case. Don't paraphrase from a tool's short description alone.",
  ].join("\n");
}

/** Static categorization for the deferred-tool directory. The system prompt
 * exposes capability groups and counts only; exact names, parameter shapes,
 * and examples stay behind search_tool. Order here is the rendered order.
 * Anything not matched falls into "Misc" at the end. */
const HIDDEN_TOOL_CATEGORIES: ReadonlyArray<{ label: string; tools: ReadonlyArray<string> }> = [
  { label: "Team coordination", tools: ["create_subtask", "update_subtask", "get_dag", "set_phase", "send_to_worker"] },
  {
    label: "Async workers",
    tools: [
      "task",
      "get_async_tasks",
      "cancel_async_task",
      "update_async_task",
      "wait_async_tasks",
      "send_task_message",
      "start_task_batch",
      "check_task_batch",
    ],
  },
  { label: "Goal", tools: ["get_goal", "create_goal", "update_goal"] },
  { label: "Audit / handoff", tools: ["declare_audit_done"] },
  {
    label: "Memory",
    tools: ["recall_memory_chunk", "list_memory_chunks", "search_memory", "consolidate_memory"],
  },
  { label: "Background shell", tools: ["task_output", "kill_shell", "monitor", "write_stdin"] },
  { label: "File editing", tools: ["apply_patch"] },
  { label: "MCP resources", tools: ["mcp_list_resources", "mcp_read_resource", "mcp_status"] },
  { label: "Network", tools: ["web_fetch", "kimi_web_search", "kimi_web_fetch"] },
  { label: "Notifications & scheduling", tools: ["notify", "schedule_wakeup"] },
  { label: "Plan mode", tools: ["exit_plan_mode"] },
  { label: "Security", tools: ["search_java_gadgets", "find_java_chains"] },
  { label: "Notes", tools: ["note", "list_notes", "read_note", "update_note", "delete_note"] },
];

/** Render a compact capability index. Per-tool prose used to cost ~1k tokens
 * in every system prompt; search_tool already owns that detailed discovery
 * surface, so repeating names and summaries here was pure fixed overhead. */
function renderDeferredCapabilityGroups(tools: ReadonlyArray<ToolDescriptor>): string[] {
  if (tools.length === 0) return [];
  const remaining = new Set<string>(tools.map((tool) => tool.name));
  const out: string[] = [];
  for (const { label, tools: catTools } of HIDDEN_TOOL_CATEGORIES) {
    const present = catTools.filter((t) => remaining.has(t));
    if (present.length === 0) continue;
    present.forEach((t) => remaining.delete(t));
    out.push(`- ${label} (${present.length})`);
  }
  if (remaining.size > 0) {
    out.push(`- Misc (${remaining.size})`);
  }
  return out;
}

/** Static system-prompt section: a category-level index of native deferred
 * tools. A pure function of the compiled-in deferred set, so it remains
 * byte-stable in the cached prefix. Detailed discovery is intentionally
 * delegated to search_tool instead of repeating every name and summary here.
 *
 * Deliberately NOT filtered by the request's visible array: profile/mode
 * promotions change the tools array, and filtering here would couple the
 * system prompt to per-request state. */
export function formatDeferredToolsCatalog(): string {
  const deferred = deferredToolDescriptors;
  if (deferred.length === 0) return "";
  return [
    "## Deferred tools (on demand)",
    `${deferred.length} additional native tools start hidden to keep requests small; discovered tools join subsequent requests when allowed by the active profile. Capability groups:`,
    ...renderDeferredCapabilityGroups(deferred),
    'Call `search_tool({ query: "<capability>" })` to get exact tool names, parameter shapes, and examples. Then invoke the returned tool by name; the engine auto-resolves it.',
  ].join("\n");
}
