// Derive the committed transcript locally from the session snapshot already
// returned by load_session, without another full-session IPC round-trip.

import type {
  MessageAttachment,
  MessageRole,
  TimelinePart,
  TimelineToolDetail,
  TimelineToolPart,
  ToolCallStatus,
  TokenUsage,
} from "./protocol";
import { humanToolName } from "./toolLabels";

// Loose shapes for the snapshot's messages/toolCalls (SessionSnapshot types
// them as unknown[]). Mirrors the @reina/protocol ChatMessage / ToolCallRecord
// fields this projection reads.
interface SnapshotMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
  ephemeral?: boolean;
  /** Typed provenance of engine-injected model-facing notices (ChatMessage.origin). */
  origin?: string;
  stopReason?: string;
  tokenUsage?: TokenUsage;
}

interface SnapshotToolCall {
  id: string;
  name: string;
  status: ToolCallStatus;
  summary: string;
  preview?: string;
  input: unknown;
  output?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

interface ProjectionInput {
  messages?: unknown[];
  toolCalls?: unknown[];
}

type ProjectedTextPart = {
  id: string;
  type: "text";
  content: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
};

type ProjectedToolCallPart = Omit<TimelineToolPart, "type"> & { type: "tool_call" };

type ProjectedMessagePart = ProjectedTextPart | ProjectedToolCallPart;

type ProjectedMessage = {
  id: string;
  role: MessageRole;
  createdAt: string;
  completedAt?: string;
  stopReason?: string;
  tokenUsage?: TokenUsage;
  parts: ProjectedMessagePart[];
};

type TimelineItem =
  | { kind: "message"; createdAt: string; value: SnapshotMessage }
  | { kind: "tool"; createdAt: string; value: SnapshotToolCall };

// Tools whose repeated calls are pure bookkeeping noise (DAG/subtask/notes
// coordination + cheap reads): consecutive same-name calls fold into one
// collapsible group ("Update subtask ×4") instead of N near-identical rows.
// Excludes meaningful one-off actions (shell / edits / writes / subagent
// launches) and rich-bodied cards (write_todos) — those stay individual.
const GROUPABLE_TOOLS = new Set<string>([
  "read_file",
  "grep",
  "glob",
  "update_subtask",
  "add_subtask",
  "get_subtask",
  "list_subtasks",
  "get_dag",
  "set_phase",
  "note",
  "get_async_tasks",
  "check_async_task",
  "list_async_tasks",
]);

// A provider placeholder summary ("Call <name>") carries no information — drop
// it so the card subtitle stays empty rather than echoing the tool name.
function isPlaceholderSummary(summary: string | undefined, name: string): boolean {
  return !summary || summary === `Call ${name}`;
}

/** Project a committed session snapshot into the renderer's transcript parts. */
export function projectTimelineParts(session: ProjectionInput | null): TimelinePart[] {
  if (!session) return [];
  return projectMessageParts(session).flatMap((message) =>
    message.parts.flatMap((part): TimelinePart[] => {
      if (part.type === "text") {
        return [
          {
            id: part.id,
            type: "text",
            role: message.role,
            createdAt: message.createdAt,
            content: part.content,
            ...(part.attachments ? { attachments: part.attachments } : {}),
            ...(part.reasoning ? { reasoning: part.reasoning } : {}),
            ...(message.stopReason ? { stopReason: message.stopReason } : {}),
            ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
          },
        ];
      }
      return [{ ...part, type: "tool" }];
    }),
  );
}

// Model-only context the engine injects as `user`-role messages at the top of a
// turn: the async-subtask state diff, the stale-file re-read nudge, and the
// background-task completion block. They're written for the model, not the
// reader, but (unlike tool results) aren't flagged `ephemeral`, so they'd
// otherwise surface as bubbles in the transcript. Match on their stable leading
// markers and keep them out of the rendered view (the model still receives them
// — this is purely presentational). The authoritative signal is the typed
// `ChatMessage.origin` field stamped at the inject sites (turn-context.ts
// injectAsyncTaskSnapshot / injectStaleReadNotice / injectCompletionNotifications);
// the prefix list below survives ONLY as a fallback for messages persisted
// before the field existed. Do not extend it — stamp `origin` instead.
const INJECTED_NOTICE_PREFIXES = [
  "(system) Subagent task state changes since last turn:",
  "(system) These files changed on disk since you last read them:",
  "<task-notifications",
];

function isInjectedModelNotice(m: SnapshotMessage): boolean {
  if (m.role !== "user") return false;
  if (m.origin) return true;
  const content = (m.content || "").trimStart();
  return INJECTED_NOTICE_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function projectMessageParts(session: ProjectionInput): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  let pendingToolGroup: SnapshotToolCall[] = [];

  for (const item of sortedTimelineItems(session)) {
    if (item.kind === "message") {
      const m = item.value;
      // A message joins the visible transcript only if it actually shows
      // something — text, attachments, or reasoning. System + ephemeral
      // (goal-continuation cues) are model-only. An empty tool-only assistant
      // turn (the model called a tool and said nothing) renders nothing, so we
      // skip it entirely: that keeps a run of same-tool calls split across such
      // turns (the team-mode `update_subtask` / `get_dag` loop) folding into one
      // group instead of one card per turn, and avoids blank bubbles.
      const visible =
        m.role !== "system" &&
        !m.ephemeral &&
        !isInjectedModelNotice(m) &&
        ((m.content || "").trim().length > 0 ||
          (m.attachments && m.attachments.length > 0) ||
          (m.role === "assistant" && !!m.reasoning));
      if (!visible) continue;
      // A real message ends the current tool run.
      flushToolGroup();
      const textPart: ProjectedTextPart = { id: `${m.id}:text`, type: "text", content: m.content };
      if (m.attachments && m.attachments.length > 0) textPart.attachments = m.attachments;
      if (m.role === "assistant" && m.reasoning) textPart.reasoning = m.reasoning;
      const projected: ProjectedMessage = {
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        parts: [textPart],
      };
      if (m.role === "assistant") {
        if (m.stopReason) projected.stopReason = m.stopReason;
        if (m.tokenUsage) projected.tokenUsage = m.tokenUsage;
      }
      messages.push(projected);
      continue;
    }

    if (isGroupableTool(item.value)) {
      // Only fold a RUN of the SAME tool — a different groupable name ends the
      // current group (so "update_subtask ×3" and "get_dag ×2" stay distinct).
      if (pendingToolGroup.length > 0 && pendingToolGroup[0].name !== item.value.name) {
        flushToolGroup();
      }
      pendingToolGroup.push(item.value);
      continue;
    }

    flushToolGroup();
    pushToolMessage([item.value]);
  }

  flushToolGroup();
  return messages;

  function flushToolGroup(): void {
    if (pendingToolGroup.length === 0) return;
    pushToolMessage(pendingToolGroup);
    pendingToolGroup = [];
  }

  function pushToolMessage(calls: SnapshotToolCall[]): void {
    const part = toolPartFromCalls(calls);
    messages.push({
      id: `message:${part.id}`,
      role: "assistant",
      createdAt: part.createdAt,
      completedAt: part.completedAt,
      parts: [part],
    });
  }
}

function sortedTimelineItems(session: ProjectionInput): TimelineItem[] {
  const messages = Array.isArray(session.messages) ? (session.messages as SnapshotMessage[]) : [];
  const toolCalls = Array.isArray(session.toolCalls) ? (session.toolCalls as SnapshotToolCall[]) : [];
  return [
    ...messages.map((message) => ({ kind: "message" as const, createdAt: message.createdAt, value: message })),
    ...toolCalls.map((tool) => ({ kind: "tool" as const, createdAt: tool.createdAt, value: tool })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isGroupableTool(tool: SnapshotToolCall): boolean {
  return GROUPABLE_TOOLS.has(tool.name) && tool.status !== "pending_approval" && !tool.error;
}

function toolPartFromCalls(calls: SnapshotToolCall[]): ProjectedToolCallPart {
  const first = calls[0];
  const last = calls.at(-1) ?? first;
  const status = mergedStatus(calls);
  return {
    id: calls.length === 1 ? `tool:${first.id}` : `tool-group:${first.id}:${last.id}`,
    type: "tool_call",
    createdAt: first.createdAt,
    completedAt: last.completedAt,
    name: calls.length === 1 ? first.name : "tool_group",
    status,
    title: toolTitle(calls, status),
    summary: toolSummary(calls),
    count: calls.length,
    callIds: calls.map((call) => call.id),
    detail: calls.map(
      (call): TimelineToolDetail => ({
        id: call.id,
        name: call.name,
        status: call.status,
        summary: call.summary,
        preview: call.preview,
        input: call.input,
        output: call.output,
        error: call.error,
        createdAt: call.createdAt,
        completedAt: call.completedAt,
      }),
    ),
  };
}

function mergedStatus(calls: SnapshotToolCall[]): ToolCallStatus {
  if (calls.some((call) => call.status === "failed")) return "failed";
  if (calls.some((call) => call.status === "pending_approval")) return "pending_approval";
  if (calls.some((call) => call.status === "running")) return "running";
  if (calls.every((call) => call.status === "rejected")) return "rejected";
  return "completed";
}

function toolTitle(calls: SnapshotToolCall[], status: ToolCallStatus): string {
  // Grouped run of the same tool. read_file keeps its "Read N files" phrasing;
  // everything else folds as "<label> ×N". The group disclosure shows no status
  // badge, so carry a non-completed status in the title.
  if (calls.length > 1) {
    const name = calls[0].name;
    const base = name === "read_file" ? `Read ${calls.length} files` : `${toolLabel(name)} ×${calls.length}`;
    return status === "completed" ? base : `${base} ${statusText(status)}`;
  }

  const call = calls[0];
  if (call.name === "run_shell") return `Shell ${statusText(status)}`;
  if (call.name === "edit_file" || call.name === "multi_edit" || call.name === "apply_patch") return `Patch ${statusText(status)}`;
  if (call.name === "write_file") return `Write file ${statusText(status)}`;
  if (call.name === "read_file") return `Read file ${statusText(status)}`;
  // Single call of an otherwise-unhandled tool: a clean humanized label. No
  // status text — the single card shows a status badge of its own (unlike the
  // group disclosure), so baking "completed" in would just be redundant.
  return toolLabel(call.name);
}

function toolLabel(name: string): string {
  return humanToolName(name);
}

function toolSummary(calls: SnapshotToolCall[]): string {
  if (calls.length > 1) {
    const failed = calls.filter((call) => call.status === "failed").length;
    const suffix = failed > 0 ? `, ${failed} failed` : "";
    return `${calls.length} tool calls${suffix}`;
  }

  const call = calls[0];
  if (call.name === "run_shell") {
    const command = commandFromInput(call.input);
    if (command) return command;
  }
  // Drop the provider's "Call <name>" placeholder — it's noise next to the
  // humanized title. Keep a real summary / preview when there is one.
  if (isPlaceholderSummary(call.summary, call.name)) return call.preview || "";
  return call.summary || call.preview || "";
}

function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function statusText(status: ToolCallStatus): string {
  switch (status) {
    case "pending_approval":
      return "needs approval";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
  }
}
