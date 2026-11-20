// toolRunGroups.ts — render-side batching of consecutive tool calls into one
// collapsed "Ran 7 commands, used a tool" disclosure (the Claude Code desktop
// pattern). Pure functions over TimelinePart[]; Timeline.tsx maps the returned
// items to <ToolRunGroup> / <AgentChipRow> / loose parts.
//
// Grouping rules:
//   - Settled tools (completed / failed / rejected) AND running tools join a
//     run — a live command folds straight into the collapsed group, whose
//     header shows a pulsing dot while any child runs. Only pending_approval
//     stays loose so the approval card / HITL flow is never hidden.
//   - Reasoning-only assistant rounds (Thoughts, no content) do NOT break a
//     run; they fold in as items so alternating think→tool→think chains still
//     batch. Any text with visible content (or a user message) breaks the run.
//   - A run becomes a group only when it has 2+ items including at least one
//     tool. A lone tool keeps today's single collapsed card; reasoning-only
//     stretches stay as their one-line Thoughts disclosures.
//   - Subagent dispatches (`task` / `start_async_task`) never join a run: each
//     adjacent stretch becomes ONE `chips` item (the codex-style AgentChipRow),
//     running dispatches included. Only pending_approval stays loose so the
//     approval card / HITL flow is untouched.

import type { TimelinePart, TimelineToolPart } from "./protocol";

export type ToolRunItem =
  | { kind: "part"; part: TimelinePart }
  | { kind: "run"; id: string; parts: TimelinePart[] }
  | { kind: "chips"; id: string; parts: TimelineToolPart[] };

// Subagent dispatch tools that render as agent chips.
const AGENT_CHIP_TOOLS = new Set(["task", "start_async_task"]);

function isAgentChipPart(part: TimelinePart): part is TimelineToolPart {
  return (
    part.type === "tool" &&
    AGENT_CHIP_TOOLS.has(part.name) &&
    part.status !== "pending_approval"
  );
}

function isRunGroupableTool(part: TimelinePart): part is TimelineToolPart {
  return part.type === "tool" && part.status !== "pending_approval";
}

// Reasoning-only assistant round — rendered as a one-line Thoughts disclosure,
// safe to fold into a run without hiding prose.
function isReasoningOnly(part: TimelinePart): boolean {
  return (
    part.type === "text" &&
    part.role === "assistant" &&
    !(part.content ?? "").trim() &&
    !!(part.reasoning ?? "").trim()
  );
}

/** Batch consecutive tools (+ interleaved reasoning rounds) into runs, and
 * consecutive subagent dispatches into chip rows. */
export function groupToolRuns(parts: TimelinePart[]): ToolRunItem[] {
  const out: ToolRunItem[] = [];
  let run: TimelinePart[] = [];
  let chips: TimelineToolPart[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const toolCount = run.filter((p) => p.type === "tool").length;
    if (run.length >= 2 && toolCount >= 1) {
      out.push({ kind: "run", id: `run:${run[0].id}`, parts: run });
    } else {
      for (const part of run) out.push({ kind: "part", part });
    }
    run = [];
  };

  const flushChips = () => {
    if (chips.length === 0) return;
    // Even a single dispatch renders as a (one-chip) row — the chip IS the
    // dedicated subagent presentation, not a fallback for batches.
    out.push({ kind: "chips", id: `chips:${chips[0].id}`, parts: chips });
    chips = [];
  };

  for (const part of parts) {
    if (isAgentChipPart(part)) {
      flushRun();
      chips.push(part);
    } else if (isRunGroupableTool(part) || isReasoningOnly(part)) {
      flushChips();
      run.push(part);
    } else {
      flushRun();
      flushChips();
      out.push({ kind: "part", part });
    }
  }
  flushRun();
  flushChips();
  return out;
}

// ── Summary phrase ────────────────────────────────────────────────────────────
// Category → phrase fragments, joined "Ran 3 commands, read a file, used 2
// tools" with the first letter capitalized (mirrors CC desktop). Subagent
// dispatches never reach a run (they get chip rows), so there is no "agent"
// category anymore.

type RunCategory = "command" | "file" | "tool";

const CATEGORY_BY_TOOL: Record<string, RunCategory> = {
  run_shell: "command",
  read_file: "file",
};

const FRAGMENTS: Record<RunCategory, { one: string; many: string }> = {
  command: { one: "ran a command", many: "ran ! commands" },
  file: { one: "read a file", many: "read ! files" },
  tool: { one: "used a tool", many: "used ! tools" },
};

export interface RunSummary {
  label: string;
  /** Total tool calls in the run (host-folded parts count as their fold size). */
  count: number;
  failed: boolean;
  /** Any child still executing — the group header shows a live pulsing dot. */
  running: boolean;
}

export function summarizeToolRun(parts: TimelinePart[]): RunSummary {
  const counts: Record<RunCategory, number> = { command: 0, file: 0, tool: 0 };
  let total = 0;
  let failed = false;
  let running = false;
  for (const part of parts) {
    if (part.type !== "tool") continue;
    // Host projection folds adjacent read_file calls into one part with
    // count > 1 — each folded call counts toward the phrase.
    const n = Math.max(1, part.count || 1);
    counts[CATEGORY_BY_TOOL[part.name] ?? "tool"] += n;
    total += n;
    if (part.status === "failed") failed = true;
    if (part.status === "running") running = true;
  }
  const fragments = (Object.keys(FRAGMENTS) as RunCategory[])
    .filter((key) => counts[key] > 0)
    .map((key) => {
      const { one, many } = FRAGMENTS[key];
      return counts[key] === 1 ? one : many.replace("!", String(counts[key]));
    });
  const joined = fragments.join(", ") || "used tools";
  return {
    label: joined.charAt(0).toUpperCase() + joined.slice(1),
    count: total,
    failed,
    running,
  };
}
