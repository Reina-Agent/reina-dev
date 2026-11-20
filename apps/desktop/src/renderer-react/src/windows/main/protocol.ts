// Renderer timeline-part + agent-event shapes. timelineProjection.ts derives
// the committed transcript from session snapshots; a streaming overlay carries
// only in-flight deltas.

export type MessageRole = "user" | "assistant" | "system";

export type ToolCallStatus = "pending_approval" | "running" | "completed" | "rejected" | "failed";

export interface MessageAttachment {
  kind?: string;
  mime?: string;
  dataBase64?: string;
  name?: string;
  previewUrl?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface TimelineTextPart {
  id: string;
  type: "text";
  role: MessageRole;
  createdAt: string;
  content: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
  // Per-turn finish reason + token usage, carried down from the message by the
  // renderer's projectTimelineParts. Present only on assistant text parts. Drives
  // the ⓘ info button + usage panel in ChatEntry.
  stopReason?: string;
  tokenUsage?: TokenUsage;
}

export interface TimelineToolDetail {
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

export interface TimelineToolPart {
  id: string;
  type: "tool";
  createdAt: string;
  completedAt?: string;
  name: string;
  status: ToolCallStatus;
  title: string;
  summary: string;
  count: number;
  callIds: string[];
  detail: TimelineToolDetail[];
}

export type TimelinePart = TimelineTextPart | TimelineToolPart;

// ── HITL (human-in-the-loop) — permission prompts + questions ────────────────
// Shapes the legacy renderer/hitl.js reads. Kept structural (extra fields pass
// through) because the dock renderer only touches the documented ones.

export interface PermissionToolCall {
  id: string;
  name: string;
  status?: string;
  summary?: string;
  input?: unknown;
  allowedDecisions?: string[];
  [key: string]: unknown;
}

export interface PendingQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface PendingQuestionItem {
  id: string;
  question: string;
  header?: string;
  options?: PendingQuestionOption[];
  multiSelect?: boolean;
  groupId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface SessionModelRef {
  provider: string;
  model: string;
}

export interface SessionSnapshot {
  id: string;
  messages?: unknown[];
  toolCalls?: unknown[];
  interrupted?: boolean;
  [key: string]: unknown;
}

export interface SessionListItem {
  id: string;
  projectId?: string;
  workspaceId?: string;
  cwd: string;
  title?: string;
  model?: SessionModelRef | string;
  agent?: string;
  messageCount?: number;
  toolCount?: number;
  createdAt?: string;
  updatedAt?: string;
  pinnedAt?: string;
  // Archive state is an ISO timestamp on the backend index (desktop-state.ts
  // `archivedAt`), NOT a boolean. Reading a non-existent `archived` boolean made
  // the whole archive feature a silent no-op: archived sessions never left the
  // normal list, the "Archived" group never appeared, and unarchive (`!archived`
  // → always true) could never toggle off.
  archivedAt?: string;
  /** Manual drag-order override (effective timestamp). When present the sidebar
   * sorts + time-buckets the session by this instead of `updatedAt`, so a
   * dragged row keeps its position and group. The age chip still uses
   * `updatedAt`. See desktop-state.ts `orderTs`. */
  orderTs?: string;
  draft?: boolean;
  parentId?: string;
}

export interface DesktopProject {
  id: string;
  root: string;
  name?: string;
}

export interface DesktopWorkspace {
  id: string;
  projectId?: string;
  cwd: string;
  branch?: string;
  lastUsedAt?: string;
}

export interface DesktopState {
  activeProjectId?: string;
  activeWorkspaceId?: string;
  activeSessionId?: string;
  projects: DesktopProject[];
  workspaces: DesktopWorkspace[];
  sessions: SessionListItem[];
}

export interface AgentModelStreamSub {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type AgentEvent =
  | { type: "host_ready" }
  | { type: "session_created"; sessionId: string; session: SessionSnapshot }
  | { type: "session_snapshot"; sessionId: string; session: SessionSnapshot }
  | {
      type: "session_title_updated";
      sessionId: string;
      title: string;
      expectedTitle: string;
      source: "provisional" | "generated" | "fallback";
    }
  | { type: "session_activity"; sessionId: string; active?: boolean; stopping?: boolean }
  | { type: "turn_started"; sessionId: string }
  | { type: "turn_completed"; sessionId: string; result?: { session?: SessionSnapshot } }
  | { type: "model_stream"; sessionId: string; event: AgentModelStreamSub }
  | { type: "permission_request"; sessionId: string; toolCall: { id?: string; callId?: string; name: string; summary?: string } }
  | { type: "question_request"; sessionId: string; question: { id?: string; questionId?: string; question: string } }
  | { type: string; sessionId?: string; [key: string]: unknown };

export interface SendMessagePayload {
  sessionId: string;
  message: string;
  attachments?: Array<{ kind: string; mime?: string; dataBase64?: string; name?: string }>;
  reminders?: string[];
  intent?: "steer";
  /** Renderer-generated identity for a steer: rides into the engine's pending
   * queue, comes back on the drain's `user-message` event, and addresses
   * `retract_steer` exactly. Only meaningful with intent "steer". */
  steerId?: string;
}
