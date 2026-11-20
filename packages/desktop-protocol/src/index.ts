import { z } from "zod";
import { modelConfigSchema, outputStyles, permissionModes, reasoningEfforts, type AgentRunResult, type MessageAttachment, type ModelStreamEvent, type SessionState, type ReinaConfig, type ToolCallRecord } from "@reina/protocol";

const messageAttachmentSchema = z.object({
  kind: z.enum(["image", "pdf"]),
  mime: z.string(),
  dataBase64: z.string(),
  name: z.string().optional(),
}) satisfies z.ZodType<MessageAttachment>;

const userGoalCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    objective: z.string().min(1).max(4000),
    completionCriterion: z.string().min(1).max(4000).optional(),
    tokenBudget: z.number().int().positive().optional(),
    turnBudget: z.number().int().positive().optional(),
    wallClockBudgetMs: z.number().int().positive().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("replace"),
    objective: z.string().min(1).max(4000),
    completionCriterion: z.string().min(1).max(4000).optional(),
    tokenBudget: z.number().int().positive().optional(),
    turnBudget: z.number().int().positive().optional(),
    wallClockBudgetMs: z.number().int().positive().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("edit"), goalId: z.string().min(1), objective: z.string().min(1).max(4000), expectedRevision: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("pause"), goalId: z.string().min(1), expectedRevision: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("resume"), goalId: z.string().min(1), expectedRevision: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("clear"), goalId: z.string().min(1), reason: z.string().max(1000).optional(), expectedRevision: z.number().int().nonnegative().optional() }),
]);

export const compactionSettingsSchema = z.object({
  compactionAuto: z.boolean(),
  compactionOffload: z.boolean(),
  compactionTriggerPercent: z.union([z.literal(0), z.number().int().min(30).max(95)]),
  compactionBufferTokens: z.number().int().min(1_000).max(500_000),
  compactionKeepRecent: z.number().int().min(2).max(64),
}).strict();

export type CompactionSettings = z.infer<typeof compactionSettingsSchema>;

export const subagentConcurrencySchema = z.number().int().min(1).max(32);

export const agentSettingsPatchSchema = z.object({
  agent: z.string().min(1).optional(),
  outputStyle: z.enum(outputStyles).optional(),
  outputStyleCustom: z.string().optional(),
  effort: z.enum(reasoningEfforts).optional(),
}).strict();

export type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>;

export const desktopRequestSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().optional(),
    type: z.literal("get_context_history"),
    sessionId: z.string().min(1),
    taskId: z.string().min(1).optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("get_context_request"),
    sessionId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    requestId: z.string().min(1),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("refresh_session_settings"),
    sessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("patch_agent_settings"),
    sessionId: z.string().optional(),
    patch: agentSettingsPatchSchema,
  }),
  // Host-wide preferences are read at the next engine operation, including
  // operations in existing sessions and their children.
  z.object({
    id: z.string().optional(),
    type: z.literal("update_compaction_settings"),
    settings: compactionSettingsSchema,
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("update_subagent_concurrency"),
    concurrency: subagentConcurrencySchema,
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("goal_command"),
    sessionId: z.string(),
    command: userGoalCommandSchema,
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("create_session"),
    cwd: z.string(),
    agent: z.string().optional(),
    permissionMode: z.enum(permissionModes).optional(),
    model: modelConfigSchema.partial().optional(),
    outputStyle: z.enum(outputStyles).optional(),
    outputStyleCustom: z.string().optional(),
    toolLoop: z.custom<ReinaConfig["toolLoop"]>().optional(),
    hooks: z.custom<ReinaConfig["hooks"]>().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("send_message"),
    sessionId: z.string(),
    message: z.string(),
    attachments: z.array(messageAttachmentSchema).optional(),
    /** One-shot system reminders that ride with this turn only. They never
     * become visible user bubbles or part of the cached system prompt. The
     * engine splices them into the per-turn `systemReminders` array alongside
     * hidden-tools / volatile-context reminders; OpenAI-family requests retain
     * the consumed snapshot as hidden model history for prefix-cache stability. */
    reminders: z.array(z.string()).optional(),
    /** How to treat this message when a turn is already running. The host
     * is the single authority here — the renderer cannot make a fresh
     * message steer by racing the activity state.
     *   - "fresh" (default): never injected into the in-flight turn. If the
     *     session is busy, it is queued to run as its OWN turn once the
     *     current one settles. Every plain user message uses this, so a
     *     typed message can never silently steer the model mid-output.
     *   - "steer": explicitly injected into the running turn at the next
     *     loop boundary (codex-style steering). Reserved for slash
     *     directives (`/verify`, `/team`, …) where interjecting into the
     *     current turn is the intended effect. Ignored once an interrupt is
     *     already in flight (the message is queued for the clean restart). */
    intent: z.enum(["fresh", "steer"]).optional(),
    /** Caller-supplied identity for a steer (renderer-generated). Rides into
     * `injectSteer`, comes back on the drain's `user-message` stream event,
     * and addresses `retract_steer` exactly — so two same-text steers stay
     * distinguishable. Ignored for intent "fresh". */
    steerId: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("update_session_config"),
    sessionId: z.string(),
    agent: z.string().optional(),
    permissionMode: z.enum(permissionModes).optional(),
    model: modelConfigSchema.partial().optional(),
    outputStyle: z.enum(outputStyles).optional(),
    outputStyleCustom: z.string().optional(),
    /** Rename the session in-place. Persists onto the engine's in-memory
     * SessionState so the next save_session writes the new title to disk;
     * without this, `desktop.renameSession` only updates the sidebar index
     * and the engine clobbers it on the next snapshot. */
    title: z.string().optional(),
    /** Sparse session-mode toggle delta. Each property set
     * here flips that mode on or off in `SessionState.sessionModes` —
     * properties not set are left alone. See packages/core/src/session-modes.ts
     * for the canonical effect of each mode (extraDirectTools overlay +
     * per-turn system reminder). */
    sessionModes: z.object({
      team: z.boolean().optional(),
    }).strict().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("approve_tool"),
    sessionId: z.string(),
    callId: z.string(),
    approved: z.boolean(),
    remember: z.literal("session").optional(),
    updatedInput: z.unknown().optional(),
    /** When rejecting, an optional user-supplied reason that becomes part of the
     * tool observation the model sees. Helps the model adapt instead of retrying. */
    reason: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("answer_question"),
    sessionId: z.string(),
    questionId: z.string(),
    answer: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("answer_question_group"),
    sessionId: z.string(),
    groupId: z.string(),
    /** Map of pendingQuestion.id → user's answer. Questions present in the
     * group but absent from this map are left unanswered (defensive). */
    answers: z.record(z.string()),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("interrupt"),
    sessionId: z.string(),
  }),
  /** Side chat ("/btw") control — the ephemeral read-only companion agent
   * forked from the session so the user can ask side questions while the
   * main turn keeps running.
   *   - prompt: send `message` to the side chat (starts the child lazily).
   *     Streaming rides the parent's model_stream as `side-chat-event` /
   *     `side-chat-state` envelopes.
   *   - interrupt: stop the in-flight side answer (child + history kept).
   *   - close: tear the child down (usage rolls up into the session). */
  z.object({
    id: z.string().optional(),
    type: z.literal("side_chat"),
    sessionId: z.string(),
    action: z.enum(["prompt", "interrupt", "close"]),
    /** The side question; required when action is "prompt". */
    message: z.string().optional(),
  }),
  /** Withdraw a steer that was injected into the running turn but has not
   * drained into the transcript yet (the queue panel's pending-steer rows).
   * Addressed by `steerId` when the caller has one (exact-row semantics);
   * `message` text is the fallback for id-less callers. Responds
   * `{ retracted: boolean }` — false means the steer already committed (or
   * was never queued) and the renderer must leave it to the normal
   * `user-message` drain instead. */
  z.object({
    id: z.string().optional(),
    type: z.literal("retract_steer"),
    sessionId: z.string(),
    steerId: z.string().optional(),
    message: z.string(),
  }),
  /** Deterministic manual compaction (the `/compact` control op). Drives the
   * engine's `compactSessionContext` machinery directly, the same path auto-compaction
   * uses. No synthetic user prompt enters the transcript. The host requires
   * the session to be idle (interrupt first if a turn is running), mirroring
   * `rollback_session`. */
  z.object({
    id: z.string().optional(),
    type: z.literal("compact_session"),
    sessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("rollback_session"),
    sessionId: z.string(),
    messageId: z.string(),
  }),
  /** Non-destructive branch: fork the conversation up to and including
   * `messageId` into a NEW session, leaving the source untouched. Driven by the
   * assistant message right-click "创建分支". The host loads the new branch into a
   * fresh engine and returns its snapshot so the renderer can switch to it. */
  z.object({
    id: z.string().optional(),
    type: z.literal("fork_session"),
    sessionId: z.string(),
    messageId: z.string(),
    /** When false, the branch keeps history UP TO BUT NOT INCLUDING `messageId`
     * (used by a user message's "撤回" → resume from just before it was sent).
     * Defaults to true (assistant "创建分支" keeps the clicked message). */
    inclusive: z.boolean().optional(),
  }),
  /** Delete `messageId` and everything after it, in place. Driven by the
   * assistant message right-click "删除消息" (truncate-from-here). Like
   * `rollback_session`, requires the session to be idle (interrupt first). */
  z.object({
    id: z.string().optional(),
    type: z.literal("delete_message"),
    sessionId: z.string(),
    messageId: z.string(),
  }),
  /** UI-initiated cancellation of a specific async subagent task. Different
   * from the model-driven `cancel_async_task` tool — this comes from the
   * user clicking Stop in the Agent Team panel and reaches the engine
   * directly. The child is interrupted; the AsyncTaskRecord settles as
   * "cancelled"; the main agent sees the new status on its next
   * check_async_task. */
  z.object({
    id: z.string().optional(),
    type: z.literal("cancel_async_task_external"),
    sessionId: z.string(),
    taskId: z.string(),
  }),
  /** Human follow-up to one child task, without starting a parent turn. */
  z.object({
    id: z.string().optional(),
    type: z.literal("update_async_task_external"),
    sessionId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    message: z.string().trim().min(1),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("save_session"),
    sessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("list_sessions"),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("load_session"),
    // cwd of the workspace owning the saved session. Required when the host has
    // no engine for `savedSessionId` yet — it tells the host where to read
    // `.reina/sessions/<id>.json` from. Ignored when the engine is already
    // hot (warm switch). `sessionId` is accepted for backward compatibility:
    // when present the host falls back to that engine's cwd if `cwd` is unset.
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
    savedSessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("close_session"),
    sessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("shutdown"),
  }),
  // ─── Workspace lifecycle ───────────────────────────────────────────────
  // The agent-host owns one SessionStore per opened workspace cwd. Renderers
  // call these to list / switch / close the active workspace; sidebar data
  // is sourced from the store of the currently-open workspace.
  z.object({
    id: z.string().optional(),
    type: z.literal("list_workspaces"),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("open_workspace"),
    cwd: z.string(),
    /** Optional friendly name; defaults to the directory basename. */
    name: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("close_workspace"),
    cwd: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("remove_workspace"),
    cwd: z.string(),
    /** Also delete the workspace's on-disk Reina data (`<cwd>/.reina` —
     * sessions DB, rollouts, notes). Project source files are never touched. */
    deleteData: z.boolean().optional(),
  }),
  // ─── SessionStore-backed queries ───────────────────────────────────────
  z.object({
    id: z.string().optional(),
    type: z.literal("list_workspace_sessions"),
    cwd: z.string(),
    includeArchived: z.boolean().optional(),
    includeSubagents: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("search_workspace_messages"),
    cwd: z.string(),
    query: z.string(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("delete_workspace_session"),
    cwd: z.string(),
    savedSessionId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("rename_workspace_session"),
    cwd: z.string(),
    savedSessionId: z.string(),
    title: z.string(),
  }),
  // ─── Workspace background shell tasks ─────────────────────────────────
  z.object({
    id: z.string().optional(),
    type: z.literal("list_background_shell_tasks"),
    cwd: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("get_background_shell_task_output"),
    cwd: z.string(),
    taskId: z.string(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("stop_background_shell_task"),
    cwd: z.string(),
    taskId: z.string(),
  }),
  // ─── MCP status ────────────────────────────────────────────────────────
  // Returns the connection state of every configured MCP server for `cwd`.
  // Settings UI uses this to render a colored dot per server; the model can
  // also reach it via the `mcp_status` tool.
  z.object({
    id: z.string().optional(),
    type: z.literal("list_mcp_status"),
    cwd: z.string(),
  }),
  /** Reply from main process to a `host_request` event. The bridge is
   * bidirectional: agent-host child emits `host_request` events that need
   * Electron-side capabilities (Notification, desktopCapturer, scheduled
   * wake-up timers); the main process dispatches them and answers here.
   * `hostRequestId` is the id of the original request — it's separate from
   * the JSON-RPC `id` field which identifies this transport-level
   * acknowledgement. */
  z.object({
    id: z.string().optional(),
    type: z.literal("host_response"),
    hostRequestId: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);

export type DesktopRequest = z.infer<typeof desktopRequestSchema>;

/** Distributive Omit so `DesktopRequestWithout<"id">` preserves every variant of
 * the discriminated union (TypeScript's built-in Omit collapses to just the
 * first variant when applied to a union). */
export type DesktopRequestWithout<K extends keyof DesktopRequest> = DesktopRequest extends infer T
  ? T extends DesktopRequest ? Omit<T, K> : never
  : never;

export type DesktopResponse =
  | { id?: string; type: "response"; command: DesktopRequest["type"]; success: true; data?: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

export type TurnSource = "user" | "scheduled_wakeup" | "background_completion" | "goal_initial" | "goal_continuation";

export type DesktopEvent =
  | { type: "host_ready"; version: string }
  | { type: "session_created"; sessionId: string; session: SessionState }
  | { type: "session_snapshot"; sessionId: string; session: SessionState }
  | {
      type: "session_title_updated";
      sessionId: string;
      title: string;
      expectedTitle: string;
      source: "provisional" | "generated" | "fallback";
    }
  | { type: "session_activity"; sessionId: string; active: boolean; interrupting?: boolean; turnStartedAt?: number }
  | { type: "turn_started"; sessionId: string; source?: TurnSource }
  | { type: "turn_completed"; sessionId: string; result: AgentRunResult; source?: TurnSource }
  | { type: "turn_failed"; sessionId: string; error: string }
  | { type: "turn_interrupted"; sessionId: string }
  | { type: "model_stream"; sessionId: string; event: ModelStreamEvent }
  | { type: "permission_request"; sessionId: string; toolCall: ToolCallRecord }
  | { type: "question_request"; sessionId: string; question: SessionState["pendingQuestions"][number] }
  /** Reverse RPC: child asks the main process to perform an Electron-side
   * operation (notify, schedule_wakeup). Main process handles
   * the work and replies with a `host_response` request. */
  | { type: "host_request"; id: string; kind: string; params: unknown; sessionId?: string };

export type DesktopOutbound = DesktopResponse | DesktopEvent;

export function parseDesktopRequest(input: unknown): DesktopRequest {
  return desktopRequestSchema.parse(input);
}

export function serializeJsonLine(value: DesktopOutbound | DesktopRequest): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}
