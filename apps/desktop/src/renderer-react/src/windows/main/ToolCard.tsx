// ToolCard.tsx — React port of the legacy tool-call card.
// Reproduces the EXACT DOM that conversation.js createToolRow / updateToolRow
// builds, so the verbatim-reused chat.css renders identically.
//
// Legacy DOM (from createToolRow + updateToolRow in conversation.js):
//
//   <details class="entry tool-call status-{s}" data-status="{s}" data-tool-name="{n}">
//     <summary class="tool-call-summary">
//       <span class="tool-icon" aria-hidden="true">
//         <svg><use href="#i-{icon}"/></svg>
//       </span>
//       <span class="tool-title">{title}</span>
//       <span class="tool-target">
//         <span class="tool-subtitle[ tool-subtitle-link]">{subtitle}</span>
//         <span class="tool-args">
//           <span class="tool-arg">{arg}</span>…
//         </span>
//       </span>
//       <span class="tool-meta">{metaText}</span>
//       <span class="tool-status">{statusLabel}</span>
//     </summary>
//     <div class="tool-call-body">
//       [flat input block | todo list | diff | command pre | error pre | output pre]
//     </div>
//   </details>
//
// Body blocks mirror tool-blocks.js:
//   .tool-body-input / .tool-body-input-line / .tool-body-input-key / .tool-body-input-val
//   .tool-diff / .tool-diff-head / .tool-diff-hunks / .tool-diff-hunk / .tool-diff-line
//   .tool-todo-list / .tool-todo-item.status-{s} / .tool-todo-mark / .tool-todo-text
//   .tool-body-block / .tool-body-block-head / .tool-body-copy / .tool-body-expand
//   pre.tool-body-cmd | pre.tool-body-output | pre.tool-body-error

import { memo, useEffect, useState } from "react";
import type { TimelineToolDetail, TimelineToolPart, ToolCallStatus } from "./protocol";
import { bridge } from "~/lib/bridge";
import { humanToolName } from "./toolLabels";

// ─── Helpers mirroring conversation.js / tool-blocks.js ──────────────────────

function statusCls(status: ToolCallStatus): string {
  if (status === "pending_approval") return "status-pending";
  return `status-${status}`;
}

function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "running": return "Running";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "rejected": return "Rejected";
    case "pending_approval": return "Approval";
    default: return status;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pathLike(value: string): string {
  if (!value) return "";
  return truncate(value.replace(/\\/g, "/"), 72);
}

function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 5) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// Elapsed time for the tool's meta. A completed/failed card uses its fixed
// createdAt→completedAt span; a RUNNING card counts up against `now` (driven by
// the 500ms ticker below) so long shell/read ops show live "· 1.3s" instead of a
// blank, frozen meta (mirror legacy manageTicker).
function computeElapsedMs(part: TimelineToolPart, now: number): number | undefined {
  if (!part.createdAt) return undefined;
  const a = Date.parse(part.createdAt);
  if (!Number.isFinite(a)) return undefined;
  const b = part.completedAt ? Date.parse(part.completedAt) : now;
  if (!Number.isFinite(b)) return undefined;
  return Math.max(0, b - a);
}

// Re-render every 500ms while `active` so a running tool's elapsed meta ticks up.
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

// ─── Display data: mirrors adaptProjectedPartToData ──────────────────────────

const TOOL_ICONS: Record<string, string> = {
  run_shell: "terminal", task_output: "terminal", kill_shell: "x",
  monitor: "alert-circle", read_file: "file", write_file: "file-plus",
  edit_file: "edit", multi_edit: "edit", apply_patch: "edit",
  list_files: "folder", glob: "search", grep: "search", code_search: "search",
  git_status: "git-branch", git_diff: "git-branch", repo_overview: "book",
  task: "sparkles", write_todos: "list", plan: "book-open",
  exit_plan_mode: "book-open", question: "alert-circle",
  compact_conversation: "minus", list_skills: "book", read_skill: "book",
  web_fetch: "globe", mcp_list_resources: "cube", mcp_read_resource: "cube",
  notify: "alert-circle", schedule_wakeup: "alert-circle",
  start_async_task: "sparkles", check_async_task: "sparkles",
  get_async_tasks: "list", cancel_async_task: "x", list_async_tasks: "list", tool_group: "list",
};

function toolIconName(name: string): string {
  return TOOL_ICONS[name] ?? "dot";
}

interface DisplayData {
  title: string;
  subtitle: string;
  args: string[];
  iconName: string;
  metaText: string;
  toolName: string;
  commandText: string;
  outputText: string;
  errorText: string;
  inputJson: string;
}

// Human verb for a tool name — now delegates to the shared TOOL_LABELS map
// (toolLabels.ts) so the committed-transcript projection and the live card stay
// in sync. Add new tools there, not here.
function toolVerb(name: string): string {
  return humanToolName(name);
}

// Human target/subtitle from a tool's input (mirror legacy toolTargetFromInput).
function toolTargetFromInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const tp = (p: unknown) => truncate(String(p ?? ""), 60);
  if (name === "run_shell") return truncate(String(i.command ?? ""), 80);
  if (name === "read_file" || name === "write_file" || name === "edit_file") return tp(i.path ?? "");
  if (name === "multi_edit") {
    const count = Array.isArray(i.edits) ? i.edits.length : 0;
    return i.path ? `${tp(i.path)} (${count} edits)` : `${count} edits`;
  }
  if (name === "apply_patch") {
    const changes = Array.isArray(i.changes) ? i.changes.length : typeof i.patch === "string" ? "patch" : 0;
    return typeof changes === "number" ? `${changes} files` : changes;
  }
  if (name === "grep") {
    const pat = `"${truncate(String(i.pattern ?? ""), 40)}"`;
    return i.path ? `${pat} in ${tp(i.path)}` : pat;
  }
  if (name === "glob") return truncate(String(i.pattern ?? ""), 60);
  if (name === "code_search") return `"${truncate(String(i.query ?? ""), 40)}"`;
  if (name === "list_files") return tp(i.path ?? ".");
  if (name === "task") return truncate(String(i.prompt ?? i.subagent ?? i.task ?? ""), 60);
  if (name === "task_output") return truncate(String(i.taskId ?? ""), 40);
  if (name === "kill_shell") return truncate(String(i.taskId ?? ""), 40);
  if (name === "monitor") {
    const pat = i.pattern ? `"${truncate(String(i.pattern), 40)}"` : "";
    const id = i.taskId ? truncate(String(i.taskId), 20) : "";
    return [pat, id].filter(Boolean).join(" in ");
  }
  if (name === "web_fetch") return truncate(String(i.url ?? ""), 70);
  if (name === "write_todos") return Array.isArray(i.todos) ? `${i.todos.length} items` : "";
  if (name === "plan") return truncate(String(i.summary ?? i.title ?? ""), 60);
  if (name === "exit_plan_mode") return truncate(String(i.plan ?? "").split("\n")[0] ?? "", 60);
  if (name === "notify") return truncate(String(i.title ?? ""), 60);
  if (name === "schedule_wakeup") return `+${String(i.delaySeconds ?? "?")}s: ${truncate(String(i.reason ?? ""), 50)}`;
  if (name === "start_async_task") {
    const agent = i.agent ? `[${String(i.agent)}]` : "";
    const desc = truncate(String(i.description ?? ""), 50);
    return [agent, desc].filter(Boolean).join(" ");
  }
  if (name === "get_async_tasks") {
    const refs = Array.isArray(i.taskRefs) ? `${i.taskRefs.length} tasks` : "all tasks";
    return `${String(i.detail ?? "headers")}: ${refs}`;
  }
  if (name === "check_async_task") return truncate(String(i.taskId ?? ""), 30);
  if (name === "cancel_async_task") return truncate(String(i.taskId ?? ""), 30);
  if (name === "question") return truncate(String(i.question ?? ""), 60);
  if (name === "read_skill") return truncate(String(i.name ?? ""), 40);
  if (name === "mcp_read_resource") return truncate(String(i.uri ?? ""), 60);
  return "";
}

function buildDisplay(part: TimelineToolPart, now: number): DisplayData {
  const firstDetail = part.detail.length === 1 ? part.detail[0] : null;
  const toolName = firstDetail?.name ?? part.name ?? "";
  const iconName = toolIconName(toolName);

  // Title + subtitle from the first detail's input, mirroring toolDisplay().
  let title = part.title || toolName;
  let subtitle = part.summary || "";
  const args: string[] = [];

  if (firstDetail) {
    const inp = (firstDetail.input && typeof firstDetail.input === "object")
      ? firstDetail.input as Record<string, unknown>
      : {};
    const file = pathLike(String(inp["path"] ?? inp["filePath"] ?? ""));
    switch (toolName) {
      case "run_shell":
        title = "Shell";
        subtitle = truncate(String(inp["command"] ?? ""), 96);
        break;
      case "read_file":
        title = "Read";
        subtitle = file;
        if (inp["offset"]) args.push(`offset=${inp["offset"]}`);
        if (inp["limit"]) args.push(`limit=${inp["limit"]}`);
        break;
      case "write_file": title = "Write"; subtitle = file; break;
      case "edit_file": title = "Edit"; subtitle = file; break;
      case "multi_edit": {
        title = "Edit"; subtitle = file;
        const cnt = Array.isArray(inp["edits"]) ? inp["edits"].length : 0;
        if (cnt) args.push(`${cnt} edits`);
        break;
      }
      case "apply_patch": title = "Patch"; subtitle = toolTargetFromInput("apply_patch", inp); break;
      case "grep":
        title = "grep";
        subtitle = String(inp["pattern"] ?? "");
        if (inp["glob"]) args.push(`glob=${inp["glob"]}`);
        if (inp["type"]) args.push(`type=${inp["type"]}`);
        break;
      case "glob": title = "Glob"; subtitle = String(inp["pattern"] ?? ""); break;
      case "list_files": title = "List"; subtitle = pathLike(String(inp["path"] ?? ".")); break;
      case "web_fetch": title = "Web fetch"; subtitle = String(inp["url"] ?? ""); break;
      case "task": title = "Task"; subtitle = truncate(String(inp["description"] ?? inp["prompt"] ?? ""), 60); break;
      case "write_todos": {
        title = "Todos";
        const todos = Array.isArray(inp["todos"]) ? inp["todos"] : [];
        const done = todos.filter((t: unknown) => (t as { status?: string })?.status === "completed").length;
        subtitle = todos.length ? `${done}/${todos.length} done` : "";
        break;
      }
      case "question": title = "Question"; subtitle = truncate(String(inp["question"] ?? ""), 60); break;
      case "compact_conversation": title = "Compact"; subtitle = ""; break;
      default: {
        // Human verb + target for the ~30 tools without an explicit case above
        // (mirror legacy toolDisplay's default → toolVerb / toolTargetFromInput).
        const target = toolTargetFromInput(toolName, firstDetail.input);
        title = part.title || toolVerb(toolName);
        // Drop the provider's "Call <name>" placeholder summary — it's just the
        // tool id again, which the title already shows. Keep a real summary.
        const detailSummary = firstDetail.summary === `Call ${toolName}` ? "" : (firstDetail.summary ?? "");
        subtitle = target || detailSummary;
      }
    }
  }

  // Meta text: elapsed duration (live while running).
  const elapsed = computeElapsedMs(part, now);
  const metaText = elapsed !== undefined ? formatDurationCompact(elapsed) : "";

  // Body content from first detail.
  const commandText = firstDetail
    ? (toolName === "run_shell" && firstDetail.input && typeof firstDetail.input === "object"
        ? String((firstDetail.input as Record<string, unknown>)["command"] ?? "")
        : "")
    : "";
  const outputText = firstDetail?.output
    ? truncateForBody(displayToolOutput(toolName, firstDetail.output), 4000)
    : "";
  const errorText = firstDetail?.error ? cleanToolErrorForDisplay(firstDetail.error) : "";
  const inputJson = firstDetail?.input
    ? safeJson(firstDetail.input)
    : "";

  return { title, subtitle, args, iconName, metaText, toolName, commandText, outputText, errorText, inputJson };
}

function truncateForBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.4));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.55));
  return `${head}\n…\n[${text.length - head.length - tail.length} chars omitted]\n…\n${tail}`;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// read_file wraps its result in a <path>/<type>/<content> envelope for the model;
// the card's subtitle already shows the path, so show only what's inside <content>
// (mirror legacy displayToolOutput). Non-matching output renders as-is.
function displayToolOutput(name: string, output: string): string {
  if (name !== "read_file" || !output) return output;
  const match = /<content>\n([\s\S]*)\n<\/content>\s*$/.exec(output);
  return match ? match[1] : output;
}

// Strip the structured <tool_error> envelope the runtime wraps around failures
// (mirror legacy cleanToolErrorForDisplay). For input-validation failures, surface
// the <issues> block so the user sees which field tripped instead of raw XML.
function cleanToolErrorForDisplay(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "Operation failed.";
  const errorMatch = text.match(/<tool_error\b([^>]*)>([\s\S]*?)<\/tool_error>/);
  const attrs = errorMatch ? errorMatch[1] : "";
  const inner = errorMatch ? errorMatch[2] : text;
  const phase = (attrs.match(/phase="([^"]+)"/) || [])[1];
  const message = (inner.match(/<message>([\s\S]*?)<\/message>/) || [])[1]?.trim() ?? "";
  const issues = (inner.match(/<issues>([\s\S]*?)<\/issues>/) || [])[1]?.trim() ?? "";
  if (phase === "input_validation" && message && issues) return `${message}\n${issues}`;
  if (message) return message;
  if (issues) return `Invalid input:\n${issues}`;
  return inner.trim();
}

// ─── Diff extraction ──────────────────────────────────────────────────────────

interface DiffHunk {
  del?: string;
  add?: string;
  patch?: string;
}

interface Diff {
  hunks: DiffHunk[];
}

function extractDiff(toolName: string, input: unknown): Diff | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  if (toolName === "edit_file" && typeof i["oldText"] === "string" && typeof i["newText"] === "string") {
    return { hunks: [{ del: i["oldText"] as string, add: i["newText"] as string }] };
  }
  if (toolName === "multi_edit" && Array.isArray(i["edits"])) {
    const hunks = (i["edits"] as unknown[])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => typeof e["oldText"] === "string" && typeof e["newText"] === "string")
      .map((e) => ({ del: e["oldText"] as string, add: e["newText"] as string }));
    return hunks.length ? { hunks } : null;
  }
  if (toolName === "write_file" && typeof i["content"] === "string") {
    return { hunks: [{ del: "", add: i["content"] as string }] };
  }
  if (toolName === "apply_patch" && typeof i["patch"] === "string") {
    return { hunks: [{ del: "", add: "", patch: i["patch"] as string }] };
  }
  return null;
}

// ─── Todo extraction ──────────────────────────────────────────────────────────

interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "completed" | "in_progress";
}

function extractTodos(toolName: string, input: unknown): TodoItem[] | null {
  if (toolName !== "write_todos" || !input || typeof input !== "object") return null;
  const todos = (input as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return null;
  return todos.map((t: unknown) => {
    const todo = t as Record<string, unknown>;
    return {
      content: typeof todo["content"] === "string" ? todo["content"] : "",
      activeForm: typeof todo["activeForm"] === "string" ? todo["activeForm"] : "",
      status:
        todo["status"] === "completed" ? "completed"
        : todo["status"] === "in_progress" ? "in_progress"
        : "pending",
    };
  });
}

// ─── Body sub-components (mirror tool-blocks.js) ──────────────────────────────

// .tool-body-input / .tool-body-input-line / .tool-body-input-key / .tool-body-input-val
function FlatInputBlock({ inputJson }: { inputJson: string }) {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(inputJson) as Record<string, unknown>; } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;

  function formatVal(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(formatVal).join(", ");
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  return (
    <div className="tool-body-input">
      {entries.map(([k, v]) => (
        <div key={k} className="tool-body-input-line">
          <span className="tool-body-input-key">{k}:</span>{" "}
          <span className="tool-body-input-val">{formatVal(v)}</span>
        </div>
      ))}
    </div>
  );
}

// .tool-todo-list / .tool-todo-item.status-{s} / .tool-todo-mark / .tool-todo-text
function TodoList({ todos }: { todos: TodoItem[] }) {
  const mark = (s: string) =>
    s === "completed" ? "✓" : s === "in_progress" ? "◐" : "○";
  return (
    <ul className="tool-todo-list">
      {todos.map((todo, i) => (
        <li key={i} className={`tool-todo-item status-${todo.status}`}>
          <span className="tool-todo-mark" aria-hidden="true">{mark(todo.status)}</span>
          <span className="tool-todo-text">
            {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// .tool-diff / .tool-diff-head / .tool-diff-hunks / .tool-diff-hunk / .tool-diff-line
const DIFF_FOLD_LINES = 30;

function DiffBlock({ diff }: { diff: Diff }) {
  const [expanded, setExpanded] = useState(false);

  let added = 0;
  let removed = 0;
  let renderedLines = 0;

  // Pre-count lines and build hunk data.
  const hunkData: Array<Array<{ cls: string; text: string }>> = diff.hunks.map((hunk) => {
    const rows: Array<{ cls: string; text: string }> = [];
    if (hunk.patch) {
      for (const line of hunk.patch.split("\n")) {
        if (!line) continue;
        const lead = line[0];
        const cls =
          lead === "+" && !line.startsWith("+++") ? "add"
          : lead === "-" && !line.startsWith("---") ? "del"
          : lead === "@" ? "hunk"
          : "context";
        if (cls === "add") added++;
        else if (cls === "del") removed++;
        rows.push({ cls: `tool-diff-line ${cls}`, text: line });
        renderedLines++;
      }
    } else {
      const delLines = (hunk.del ?? "").split("\n");
      if (delLines.length > 1 || delLines[0]) {
        if (delLines[delLines.length - 1] === "") delLines.pop();
        for (const line of delLines) {
          rows.push({ cls: "tool-diff-line del", text: `- ${line}` });
          removed++;
          renderedLines++;
        }
      }
      const addLines = (hunk.add ?? "").split("\n");
      if (addLines.length > 1 || addLines[0]) {
        if (addLines[addLines.length - 1] === "") addLines.pop();
        for (const line of addLines) {
          rows.push({ cls: "tool-diff-line add", text: `+ ${line}` });
          added++;
          renderedLines++;
        }
      }
    }
    return rows;
  });

  const headerParts: string[] = [];
  if (added) headerParts.push(`+${added}`);
  if (removed) headerParts.push(`-${removed}`);
  const headLabel = headerParts.length ? `diff · ${headerParts.join(" ")}` : "diff";
  const foldable = renderedLines > DIFF_FOLD_LINES;

  return (
    <div className="tool-diff">
      <div className="tool-diff-head">
        <span>{headLabel}</span>
        {foldable && (
          <button
            type="button"
            className="tool-body-expand"
            style={{ marginLeft: "auto" }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((x) => !x); }}
          >
            {expanded ? "Collapse" : `Show all ${renderedLines} lines`}
          </button>
        )}
      </div>
      <div className="tool-diff-hunks" hidden={foldable && !expanded}>
        {hunkData.map((rows, hi) => (
          <div key={hi} className="tool-diff-hunk">
            {rows.map((row, ri) => (
              <div key={ri} className={row.cls}>{row.text}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// .tool-body-block / .tool-body-block-head / pre.{className}
// Mirrors createToolPre / createFoldableBlock from tool-blocks.js.
const FOLDABLE_MAX_LINES = { cmd: 10, output: 12 };

function BodyBlock({
  className,
  text,
  label,
  maxLines,
}: {
  className: string;
  text: string;
  label: string;
  maxLines: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const foldable = lines.length > maxLines;

  const headLines = Math.max(2, Math.floor(maxLines * 0.6));
  const tailLines = Math.max(1, maxLines - headLines - 1);
  const folded = foldable
    ? [
        ...lines.slice(0, headLines),
        `… (${lines.length - headLines - tailLines} more lines)`,
        ...lines.slice(-tailLines),
      ].join("\n")
    : text;

  const displayed = foldable && !expanded ? folded : text;

  const copyText = async () => {
    await navigator.clipboard.writeText(text).catch(() => undefined);
  };

  return (
    <div className="tool-body-block">
      <div className="tool-body-block-head">
        <span>{foldable ? `${label} · ${lines.length} lines` : label}</span>
        <span style={{ display: "flex", gap: "6px" }}>
          {foldable && (
            <button
              type="button"
              className="tool-body-expand"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((x) => !x); }}
            >
              {expanded ? "Collapse" : `Show all ${lines.length} lines`}
            </button>
          )}
          <button
            type="button"
            className="tool-body-copy"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void copyText(); }}
          >
            Copy
          </button>
        </span>
      </div>
      <pre className={className}>{displayed}</pre>
    </div>
  );
}

// Error pre — mirrors createToolPre("tool-body-error", …).
// Renders in a .tool-body-block but CSS strips the block chrome for error pres.
function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="tool-body-block">
      <div className="tool-body-block-head" />
      <pre className="tool-body-error">{text}</pre>
    </div>
  );
}


// ─── ToolCard component ───────────────────────────────────────────────────────

interface ToolCardProps {
  part: TimelineToolPart;
}

// Wrap a single grouped detail back into a one-call TimelineToolPart so the
// regular ToolCard rendering (buildDisplay's per-tool title/subtitle/body) drives
// each child row — mirror legacy's `.tool-group-body > .tool-call` where every
// child is a full tool card. title is left empty so buildDisplay derives it from
// the detail's own tool name + input.
function detailToPart(d: TimelineToolDetail): TimelineToolPart {
  return {
    id: d.id,
    type: "tool",
    createdAt: d.createdAt,
    completedAt: d.completedAt,
    name: d.name,
    status: d.status,
    title: "",
    summary: d.summary,
    count: 1,
    callIds: [d.id],
    detail: [d],
  };
}

/**
 * A grouped tool part (host projects adjacent read_file calls into one
 * `tool_group` with N details). Renders the legacy `.tool-group` disclosure: a
 * "Read N files" summary + a count badge, with one full ToolCard per child detail
 * inside `.tool-group-body`. Without this, the multi-detail card showed only a
 * title with an EMPTY body (buildDisplay bails when detail.length !== 1).
 */
function ToolGroup({ part }: ToolCardProps) {
  // Collapsed by default; open when something failed so the error is visible
  // (mirror the legacy `.tool-group:has(.status-failed)` emphasis).
  const defaultOpen = part.status === "failed";
  return (
    <details className="entry tool-group" data-status={part.status} open={defaultOpen}>
      <summary className="tool-group-summary">
        <span className="tool-group-title">{part.title}</span>
        <span className="tool-group-count">{part.count > 1 ? String(part.count) : ""}</span>
      </summary>
      <div className="tool-group-body">
        {part.detail.map((d) => (
          <ToolCard key={d.id} part={detailToPart(d)} />
        ))}
      </div>
    </details>
  );
}

/**
 * Reproduces the exact DOM that conversation.js createToolRow / updateToolRow
 * builds for a TimelineToolPart. chat.css renders it identically.
 *
 * Memoized: part objects are referentially stable across streaming re-renders
 * (tool-progress upserts replace only the updated tool's object), so settled
 * cards skip the per-delta re-render; the internal ticker still drives a live
 * card's elapsed meta.
 */
export const ToolCard = memo(function ToolCard({ part }: ToolCardProps) {
  // Hook must run unconditionally (before the group early-return). Only a live
  // single-tool card ticks; a group delegates to its child cards.
  const now = useTickingNow(part.detail.length <= 1 && part.status === "running");

  // Grouped parts (adjacent read_file calls folded by the host projection) render
  // as a .tool-group disclosure of child cards, not a single empty-body card.
  if (part.detail.length > 1) return <ToolGroup part={part} />;

  const display = buildDisplay(part, now);
  const firstDetail = part.detail.length === 1 ? part.detail[0] : null;

  const diff = firstDetail
    ? extractDiff(firstDetail.name, firstDetail.input)
    : null;
  const todos = firstDetail
    ? extractTodos(firstDetail.name, firstDetail.input)
    : null;

  // Default open state mirrors defaultOpenFor() in conversation.js.
  const hasBody =
    !!display.commandText ||
    !!display.outputText ||
    !!display.errorText ||
    !!display.inputJson ||
    !!todos ||
    !!diff;
  const defaultOpen =
    part.status === "failed"
      ? hasBody
      : !!todos
        ? (todos?.length ?? 0) > 0
        : !!diff;

  // The pending result is an internal placeholder; the question input must
  // remain available when opening its timeline disclosure.
  const suppressPendingOutput =
    display.toolName === "question" &&
    !display.errorText &&
    (display.outputText.trimStart().startsWith("Question pending:") ||
      /^\d+ questions? pending/i.test(display.outputText.trimStart()));

  const showInputBlock =
    !!display.inputJson &&
    !display.commandText &&
    !todos &&
    !diff &&
    !display.errorText;

  const cls = [
    "entry",
    "tool-call",
    statusCls(part.status),
  ].join(" ");

  return (
    <details
      className={cls}
      data-status={part.status}
      data-tool-name={display.toolName}
      open={defaultOpen}
    >
      <summary className="tool-call-summary">
        {/* Icon column — CSS hides it (.tool-call > .tool-call-summary .tool-icon { display: none }) */}
        <span className="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <use href={`#i-${display.iconName}`} />
          </svg>
        </span>
        <span className="tool-title">{display.title}</span>
        <span className="tool-target">
          <span className="tool-subtitle">{display.subtitle}</span>
          {display.args.length > 0 && (
            <span className="tool-args">
              {display.args.map((arg, i) => (
                <span key={i} className="tool-arg">{arg}</span>
              ))}
            </span>
          )}
        </span>
        <span className="tool-meta">{display.metaText}</span>
        <span className="tool-status">{statusLabel(part.status)}</span>
      </summary>

      <div className="tool-call-body">
        {showInputBlock && <FlatInputBlock inputJson={display.inputJson} />}
        {todos && <TodoList todos={todos} />}
        {diff && <DiffBlock diff={diff} />}
        {display.commandText && (
          <BodyBlock
            className="tool-body-cmd"
            text={display.commandText}
            label="command"
            maxLines={FOLDABLE_MAX_LINES.cmd}
          />
        )}
        {display.errorText && <ErrorBlock text={display.errorText} />}
        {display.outputText && !suppressPendingOutput && !todos && (
          <BodyBlock
            className="tool-body-output"
            text={display.outputText}
            label="output"
            maxLines={FOLDABLE_MAX_LINES.output}
          />
        )}
      </div>
    </details>
  );
});
