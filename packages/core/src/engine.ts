import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentRunResult,
  AsyncTaskRecord,
  ChatMessage,
  CompactBoundary,
  ContextCompactionRecord,
  ContextComposition,
  ContextHistory,
  ContextRequestDetail,
  ContextRequestRecord,
  GoalCompletionClaim,
  MessageAttachment,
  ModelConfig,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
  OutputStyle,
  PermissionDecision,
  PermissionMode,
  ProviderState,
  RolloutItem,
  SessionConfigChanges,
  SessionState,
  ReinaConfig,
  TokenCategoryBreakdown,
  TokenToolDetail,
  TokenUsage,
  ToolCallRecord,
  ToolDescriptor,
  ToolName,
  ToolObservation,
  UserGoalCommand,
  ToolPermissionLevel,
} from "@reina/protocol";
import { GLOBAL_NOTES_DIRNAME, createId, errorMessage, modelConfigSchema, nowIso } from "@reina/protocol";
import {
  RolloutRecorder,
  type RolloutLogger,
  legacyJsonPathFor,
  loadRolloutAsSession,
  migrateJsonSnapshotToJsonl,
  rolloutPathFor,
} from "./rollout.js";
import {
  nextModelTurnStream,
  isRetryableStreamError,
  isContextWindowError,
  isAuthError,
  formatSystemReminders,
  toolInputJsonSchema,
} from "@reina/providers";
import {
  deferredToolDescriptors,
  listBackgroundShellTasks,
  loadMcpRuntimeTools,
  precomputeMcpServers,
  previewTool,
  reinaConfigHome,
  toolDescriptors,
} from "@reina/tools";
import { NotesService, GLOBAL_WIKI_SCHEMA_SEED } from "./notes.js";
import { apportionContextTokens, captureContextSections, contextMessageCategory, ContextHistoryStore, type ContextHistoryOwner } from "./context-history.js";
import { loadSelfEvolveDirective, summarizeSelfReview } from "./self-evolve.js";
import { buildSideChatSeed, SIDE_CHAT_BOUNDARY_PROMPT } from "./side-chat.js";
import { SubtaskStore } from "./subtasks.js";
import {
  availableTools,
  filterMcpTools,
  filterSkillsByProfile,
  matchesToolAllowList,
  profiles,
  requiresApproval,
  resolveProfile,
  waitForRequiredMcp,
} from "./profiles.js";
import {
  isSessionModeName,
  modeExitReminder,
  modeTurnReminders,
  SESSION_MODE_NAMES,
  type SessionModeName,
} from "./session-modes.js";
import { formatSkillsPrompt } from "./skills.js";
import { rollupSideUsage } from "./side-usage.js";
import { pushTrace, toolTraceData } from "./trace.js";
import { trackCacheUsage, type CacheTrackerState } from "./cache-stats.js";
import {
  autoCompactThreshold,
  buildSummaryRestoredContextMessage,
  compactSessionContext,
  contextWindowTokens,
  estimateObservationTokens,
  estimateTextTokens,
  POST_COMPACT_CONTEXT_PREFIX,
  POST_COMPACT_SUMMARY_SECTION,
  sessionContextTokens,
  shouldAutoCompactSession,
  upsertRecentFile,
} from "./compaction.js";
import { extractChunks, isCompactionOffloadEnabled } from "./chunks.js";
import { configPathFor, ensureConfig, loadMcpResidencyPolicy, mcpConfigPathFor, readRuntimeConfig } from "./engine-config.js";
import { RuntimeModelCatalog } from "./runtime-model-catalog.js";
import {
  buildHiddenToolsReminder,
  buildSystemPrompt,
  buildVolatileContextSections,
  formatUserRulesPrompt,
  snapshotMcpServersIfNeeded,
} from "./engine-prompt.js";
import {
  CONTEXT_STATE_VERSION,
  buildContextStateUpdate,
  latestContextStateSnapshot,
  type ModelContextSection,
} from "./context-state.js";
import { runHooks } from "./hooks.js";
import {
  isReadOnlyShellCommand,
  matchesSessionApproval,
  sessionApprovalRule,
  type SessionApprovalRule,
} from "./shell-approval.js";
import { ToolLoopBudget, type ToolLoopStop } from "./loop-budget.js";
import { TaskCompletionsController } from "./controllers/task-completions.js";
import { StormBreaker } from "./storm-breaker.js";
import { evaluatePermission, loadPermissions, type PermissionVerdict } from "./permissions.js";
import { SessionStore } from "./store/index.js";
import { sweepOrphanWorktrees, sweepStaleTaskDirs } from "./gc.js";
import {
  COORDINATOR_RECIPIENT,
  SubagentManager,
  buildForkContext,
  formatIdleNotification,
  subagentTimeoutMs,
  type SubagentHost,
  type BubbleApprovalDecision,
} from "./subagent/index.js";
import { TodosController } from "./controllers/todos.js";
import { GoalService } from "./goal/service.js";
import { GoalRuntime, type GoalVerificationResult } from "./goal/runtime.js";
import { makeGoalEvent, migrateLegacyGoalState } from "./goal/domain.js";
import { SubmitResponseController } from "./controllers/submit-response.js";
import { MemoryController } from "./controllers/memory.js";
import { PlanController } from "./controllers/plan.js";
import { AuditController } from "./controllers/audit.js";
import { buildCompletionVerifyTrace, runCompletionVerify } from "./completion-verifier.js";
import { QuestionController } from "./controllers/question.js";
import { NotesController } from "./controllers/notes.js";
import { SubtaskController } from "./controllers/subtask.js";
import { DEFAULT_SESSION_TITLE, TitleController } from "./title.js";
import { TurnContextController } from "./controllers/turn-context.js";
import {
  MAX_INFLIGHT_ATTACHMENT_BYTES,
  TOOL_RESULT_MESSAGE_PREFIX,
  ToolOutputController,
  capInflightAttachmentBytes,
  toolOutputPreviewCap,
  toolResultMessage,
  truncateToolOutputForModel,
} from "./tool-output.js";
import { blockedToolsForSession, createToolDispatch, type ToolDispatch } from "./tool-dispatch.js";

function allowedDecisionsFor(permission: ToolPermissionLevel): PermissionDecision[] {
  // Reject is always available. Edit only makes sense when the input is meaningful
  // to revise (writes and shell commands); for read tools and simple queries, edit
  // would clutter the UI without adding value.
  if (permission === "write") return ["approve", "edit", "reject"];
  if (permission === "execute") return ["approve", "edit", "reject"];
  return ["approve", "reject"];
}

type RecoverableToolLoopStop = ToolLoopStop & { reason: "no_progress" | "repeated_action" | "consecutive_errors" };

/** Tools excluded from the generic same-batch identical-call dedup: the
 * subagent dispatch family runs its own domain-aware same-brief dedup inside
 * SubagentManager, whose merged observation carries the live task id — more
 * useful to the model than the generic "duplicate call" pointer. */
const BATCH_DEDUP_EXEMPT = new Set<string>(["task", "start_async_task", "start_task_batch"]);

/** Bridge for tools that need host-side capabilities (Electron Notification,
 * desktopCapturer, persistent wake-up timers). Implementations live in the
 * agent-host process and forward calls to the main process over the JSON-line
 * channel. `null`/undefined in tests means those tools fail closed with a
 * "not supported in this environment" error rather than crashing. */
export type HostBridge = (kind: string, params: unknown) => Promise<unknown>;

const HOST_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "notify",
  "schedule_wakeup",
  "kimi_web_search",
  "kimi_web_fetch",
]);

function isToolAvailableToHost(name: string, hostBridge: HostBridge | undefined): boolean {
  return hostBridge !== undefined || !HOST_BRIDGE_TOOL_NAMES.has(name);
}

export type CreateSessionInput = {
  cwd: string;
  agent?: string;
  permissionMode?: PermissionMode;
  model?: ModelConfig;
  titleModel?: Partial<ModelConfig>;
  compactionModel?: Partial<ModelConfig>;
  autoTitle?: ReinaConfig["autoTitle"];
  goal?: ReinaConfig["goal"];
  autopilot?: ReinaConfig["autopilot"];
  outputStyle?: OutputStyle;
  outputStyleCustom?: string;
  toolLoop?: ReinaConfig["toolLoop"];
  hooks?: ReinaConfig["hooks"];
  tui?: ReinaConfig["tui"];
  subagent?: ReinaConfig["subagent"];
  selfEvolve?: ReinaConfig["selfEvolve"];
  memory?: ReinaConfig["memory"];
  hostBridge?: HostBridge;
  /** Mark the engine as a subagent BEFORE construction side effects run.
   * The constructor's notes-service boot checks this flag; without it a
   * spawned child would kick off its own detached init (writing into the
   * child's cwd — a throwaway worktree for isolated dispatches) that gets
   * orphaned when spawnChildEngine overwrites the promises with the
   * parent's, leaving writers nothing can await. */
  isSubagent?: boolean;
  /** Nesting depth for subagent engines (parent depth + 1). Constructor
   * input for the same reason as `isSubagent`: session identity should be
   * complete before construction side effects observe it. */
  subagentDepth?: number;
  /** Workspace-scoped SQLite store. When provided, the engine mirrors every
   * meaningful state change into it (in addition to the JSONL rollout log).
   * The store outlives the engine; the engine never closes it. Pass `null`
   * to opt out (used by tests that don't care about persistence). */
  sessionStore?: SessionStore | null;
};

type PrefixStripResult = { kind: "matched"; tail: string } | { kind: "mismatch" } | { kind: "partial" };

function stripPrefix(current: string, prefix: string): PrefixStripResult {
  if (!prefix) return { kind: "matched", tail: current };
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let i = 0;
  let j = 0;
  while (i < prefix.length && j < current.length) {
    const pc = prefix[i];
    const cc = current[j];
    if (pc === cc) {
      i++;
      j++;
      continue;
    }
    if (isWs(pc)) {
      i++;
      continue;
    }
    if (isWs(cc)) {
      j++;
      continue;
    }
    return { kind: "mismatch" };
  }
  while (i < prefix.length && isWs(prefix[i])) i++;
  if (i === prefix.length) {
    return { kind: "matched", tail: current.slice(j).replace(/^\s+/, "") };
  }
  return { kind: "partial" };
}

export function stripReplayPrefix(current: string, priorBlocks: string[]): PrefixStripResult {
  const blocks = priorBlocks.filter(Boolean);
  const full = blocks.join("");
  const fullResult = stripPrefix(current, full);
  if (!full || fullResult.kind !== "mismatch") return fullResult;

  for (let i = 1; i < blocks.length; i++) {
    const result = stripPrefix(current, blocks.slice(i).join(""));
    if (result.kind !== "mismatch") return result;
  }
  return { kind: "mismatch" };
}

function currentTurnAssistantBlocks(messages: ChatMessage[], field: "content" | "reasoning"): string[] {
  const blocks: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    const value = field === "content" ? message.content : message.reasoning;
    if (typeof value === "string" && value) blocks.unshift(value);
  }
  return blocks;
}

/** Provider stop/finish reasons that mean the model ended its turn normally
 * (or hit the output-token cap, which the engine already flags via
 * `ModelTurn.truncated`). Anything else — most importantly `content_filter`
 * from provider-side output moderation — is an abnormal early termination the
 * engine surfaces so a cut stream isn't mistaken for the agent finishing. */
const NORMAL_STOP_REASONS = new Set([
  "stop",
  "tool_calls",
  "function_call",
  "end_turn",
  "tool_use",
  "pause_turn",
  "length",
  "max_tokens",
  "max_output_tokens",
]);

function isAbnormalStop(stopReason?: string): boolean {
  return typeof stopReason === "string" && stopReason.length > 0 && !NORMAL_STOP_REASONS.has(stopReason);
}

/** A finish/stop reason that signals the request exceeded the model's context
 * window, reported as a 200-stream finish_reason rather than a thrown error.
 * Some OpenAI-compatible relays surface overflow this way (e.g.
 * `model_context_window_exceeded`), so it never reaches `isContextWindowError`,
 * which only inspects thrown errors. The engine routes these to the same
 * `recoverFromContextOverflow` (trim/compact + retry) path instead of treating
 * them as an opaque abnormal stop. */
function isContextOverflowStop(stopReason?: string): boolean {
  if (typeof stopReason !== "string" || stopReason.length === 0) return false;
  const s = stopReason.toLowerCase();
  return /context[_ ]?(window|length)/.test(s) && /(exceed|overflow|too[_ ]?long|larger)/.test(s);
}

const EMERGENCY_OBSERVATION_TOTAL_CHARS = 24_000;
const EMERGENCY_OBSERVATION_MAX_CHARS = 6_000;
const EMERGENCY_OBSERVATION_MIN_CHARS = 800;

// Routine per-turn budget for the pending observations of ONE tool round,
// applied on every request regardless of context-window proximity. The
// per-tool caps inside @reina/tools bound each built-in output (~50 KB), but
// nothing bounds the AGGREGATE of a many-tool round, and MCP tool outputs
// bypass Reina's truncation entirely. Any single output over `perResult`, then
// the largest outputs while the round total exceeds `total`, are replaced with
// a head+tail excerpt plus a read_file pointer to the full on-disk copy that
// `persistToolOutput` already wrote — lossless, unlike the EMERGENCY_* trim
// above, which is the lossy last resort when the request is about to overflow
// the window itself.
const TURN_OBSERVATION_RESULT_CHARS = 100_000;
const TURN_OBSERVATION_TOTAL_CHARS = 200_000;

/** Budget for `enforceTurnObservationBudget`, scaled down for small-window
 * models (15% / 30% of the window in chars) and clamped to the defaults so a
 * 1M-window model doesn't get a multi-megabyte round waved through. */
function turnObservationBudget(model: ModelConfig): { perResult: number; total: number } {
  const windowChars = contextWindowTokens(model) * 4;
  return {
    perResult: Math.max(8_000, Math.min(TURN_OBSERVATION_RESULT_CHARS, Math.floor(windowChars * 0.15))),
    total: Math.max(16_000, Math.min(TURN_OBSERVATION_TOTAL_CHARS, Math.floor(windowChars * 0.3))),
  };
}

// Tool-output materialization helpers (preview caps, in-band result messages,
// inline-attachment budget) live in tool-output.ts. Re-exported here because
// attachment-budget.test.ts imports them from ./engine.js.
export { MAX_INFLIGHT_ATTACHMENT_BYTES, capInflightAttachmentBytes } from "./tool-output.js";

/** Background-task lifecycle tools. Deferred by default (noise when nothing is
 * running), but promoted into the visible tools array WHILE a background shell
 * is live so the model invokes them as TOOLS — not by typing the tool name into
 * run_shell, which bash then rejects with "command not found" (exit 127). */
const BACKGROUND_LIFECYCLE_TOOLS = ["task_output", "kill_shell", "monitor", "write_stdin"] as const;

export class AgentEngine {
  session: SessionState;
  configPath: string;
  mcpConfigPath: string;
  private pending = new Map<string, ToolCallRecord>();
  private sessionApprovals: SessionApprovalRule[] = [];
  private pendingObservations: ToolObservation[] = [];
  /** Latest authoritative context-window base for the live footprint: the
   * provider total from the last completed request, or the post-compaction
   * estimate. `emitLiveContext` adds the pending-observation tail on top so the
   * ring climbs between model responses. Reset when a different session loads;
   * falls back to deriving from `session.usage` when unset. */
  private lastContextBase: number | undefined;
  /** Mid-turn user "steers". When the renderer sends a message with
   * intent "steer" while a turn is in flight (and no interrupt is
   * pending — the host gates on `!session.interrupting`), agent-host
   * calls `injectSteer`; continueLoop drains this at iteration
   * boundaries so the model sees the new input on its next call.
   * Matches codex's pending-steer behavior — the in-flight model stream
   * is NOT aborted, so the current assistant response still commits to
   * the transcript, and the steer is answered on the following
   * iteration. Until drained, an entry can be pulled back out via
   * `retractSteer`. */
  private pendingSteers: Array<{ id: string; message: string; attachments?: MessageAttachment[] }> = [];
  /** One-shot system reminders that ride with the current turn only.
   * Populated by `runTurn` / `injectSteer` from the renderer's slash
   * commands (`/team`, `/goal`, `/verify`, `/cancel`) so directive text
   * is delivered to the model via `ModelRequest.systemReminders` rather
   * than wrapped into the visible user message bubble. This source array is
   * in-memory only; OpenAI-family requests materialize the consumed formatted
   * snapshot as ephemeral model history so the cache prefix remains append-only.
   * Cleared at the start of the next fresh `runTurn`. */
  private pendingTurnReminders: string[] = [];
  /** Guard so a slow background memory consolidation doesn't stack with the
   * next turn's trigger (mirror of selfReviewInFlight). */
  private consolidationInFlight = false;
  /** In-flight background consolidation, tracked so dispose() can quiesce it
   * (interrupt the child, await settlement) instead of racing its writers
   * during teardown. Null when idle. */
  private consolidationPromise: Promise<void> | null = null;
  private consolidationChild: AgentEngine | null = null;
  /** Same tracking for the self-evolve review fork (identical detached shape). */
  private selfReviewPromise: Promise<void> | null = null;
  private selfReviewChild: AgentEngine | null = null;
  /** Side chat ("/btw"): the ephemeral read-only companion child the user can
   * question without disturbing the main turn. Lazily created on the first
   * prompt, reused for follow-ups (kimi-style), torn down on close/dispose.
   * Never persisted — a reload starts fresh. */
  private sideChatChild: AgentEngine | null = null;
  private sideChatPromise: Promise<void> | null = null;
  private sideChatUnsub: (() => void) | null = null;
  private sideChatBusy = false;
  /** Queued one-shot transition notices for session modes that flipped ON→OFF
   * since the last turn (e.g. Team turned off → "你不再是协调者，恢复直接执行").
   * Unlike `pendingTurnReminders` these are NOT cleared by `runTurn`'s reset —
   * the toggle happens BETWEEN turns via `updateConfig`, so they must survive
   * until the next turn folds them in, then they're drained (one-shot). */
  private pendingModeExitReminders: string[] = [];
  /** Pre-dispatch repeat-loop guard. Tracks recent (toolName, normalized
   * input) pairs and suppresses identical calls past a small threshold,
   * so a model stuck reading the same file three times in a row gets a
   * pointed "try something else" observation instead of burning real I/O.
   * Reset at the start of each user-initiated turn — new intent should
   * not inherit storm state from the previous request. */
  private stormBreaker = new StormBreaker();
  private abortController = new AbortController();
  private streamListeners = new Set<(event: ModelStreamEvent) => void>();
  private toolLoopConfig?: ReinaConfig["toolLoop"];
  private runtimeConfigSnapshot?: ReinaConfig;
  private readonly runtimeModelCatalog = new RuntimeModelCatalog();
  private hooksConfig?: ReinaConfig["hooks"];
  private compactionModel?: Partial<ModelConfig>;
  private contextHistoryOwner?: ContextHistoryOwner;
  private contextPreviewMcpPool: readonly ToolDescriptor[] = [];
  private contextPreview?: { key: string; createdAt: number; detail: ContextRequestDetail };
  private goalConfig?: ReinaConfig["goal"];
  private autopilotConfig?: ReinaConfig["autopilot"];
  /** Prefix fingerprint from the previous turn — used to diagnose
   * unexpected Anthropic prompt-cache misses. When `cachedInputTokens`
   * is 0 we compare these hashes against the just-sent request to tell
   * "prefix actually changed (something invalidated it)" apart from
   * "prefix unchanged but provider returned no cached tokens (TTL
   * expired)". Reset on `loadSession` / `rollbackToMessage`. */
  private lastSystemHash?: string;
  private lastToolsHash?: string;
  /** Last model round's prompt size, for quantified cache-miss tracking
   * (cache-stats.ts). In-memory only — after a reload the first round isn't
   * counted. Reset when a compaction boundary lands (trackCacheWaste). */
  private cachePrev?: CacheTrackerState;
  /** Append-only event log for this session. Opened by `create` (with an
   * initial session_meta line) and by `loadSession` (which replays the file
   * into `this.session` before reopening the recorder for further appends).
   * `null` until opened — methods that emit events guard for this. */
  private recorder: RolloutRecorder | null = null;
  /** Workspace-scoped SQLite store, when one was passed in. Mirrors the
   * session into a query-friendly format alongside the JSONL log. */
  private sessionStore: SessionStore | null = null;
  private hostBridge?: HostBridge;
  readonly tuiConfig?: ReinaConfig["tui"];
  /** Snapshot of `ReinaConfig.subagent.forkEnabled` taken at session
   * create time. Surfaced to the SubagentManager via the host adapter so
   * `start_async_task({fork: true})` can be gated without a config re-read
   * on every dispatch. Default true. */
  private forkEnabledFlag: boolean = true;
  /** Snapshot of `ReinaConfig.subagent.secondaryModel` — the "all subagents
   * run on a cheap model" knob. Surfaced to the SubagentManager, which merges
   * it over each spawned child's session.model (forks excluded — see the
   * protocol docs on the field). Undefined → children inherit the parent
   * model unchanged. */
  private subagentSecondaryModel?: Partial<ModelConfig>;
  /** Background self-improvement review (Hermes-style learning loop) config,
   * snapshotted from reina.json. Undefined/disabled → the loop never fires. */
  private selfEvolveConfig: ReinaConfig["selfEvolve"];
  private memoryDreamConfig: ReinaConfig["memory"];
  /** Top-level turns since the last self-evolve review fired. */
  private turnsSinceSelfReview = 0;
  /** Guard so a slow review doesn't stack with the next turn's trigger. */
  private selfReviewInFlight = false;
  /** MCP tools the residency policy ships in the visible tools array from
   * turn 1 (tools of servers NOT listed in `reina.json` →
   * `mcp.deferredServers`). Derived again before each request and never
   * persisted. resolveTools separately adds discovered names and removes tools
   * no longer present in the live, cwd-bound MCP pool. */
  private residentMcpToolNames: ReadonlySet<string> = new Set();
  /** Subagent subsystem: owns the children Map, async task lifecycle,
   * brief-retry counters, dispatch reservations, and worktree isolation.
   * Constructed in the body below (needs `this` for the host adapter). */
  private subagent!: SubagentManager;
  /** Owns the write_todos tool. session.todos stays the read-side source
   * of truth (system prompt + persistence read it directly) but every
   * write goes through this controller so the auto-reset + bookkeeping
   * + rollout event live in one place. */
  private todos!: TodosController;
  /** Goal v2 lifecycle is a dedicated state machine. GoalService is the only
   * writer; GoalRuntime owns idle-boundary continuation and verification. */
  private goals!: GoalService;
  private goalRuntime!: GoalRuntime;
  /** Owns the synthetic submit_response tool. Validates payloads against
   * the active profile's responseSchema and pins the JSON form onto
   * session.submittedResponse for the parent's task plumbing. */
  private submitResponseCtl!: SubmitResponseController;
  /** Owns the deferred recall tools (recall_memory_chunk /
   * list_memory_chunks) that surface compacted-out chat slices from the
   * SessionStore-backed memory chunk table. */
  private memory!: MemoryController;
  /** Owns the plan + exit_plan_mode tools. Mode-switch on approval still
   * lives in answerQuestion (post-answer hook); the controller only
   * stages the plan and opens the HITL gate. */
  private plan!: PlanController;
  /** Owns the legacy declare_audit_done tool for legacy autopilot only. */
  private audit!: AuditController;
  /** Owns the `question` tool handler (single + batch + subagent escalation).
   * Public answer methods (answerQuestion / answerQuestionGroup) stay on
   * the engine as IPC-facing API. */
  private question!: QuestionController;
  /** Owns the shared-notebook tools (note / list_notes / read_note /
   * update_note / delete_note / send_to_worker). The disk-backed
   * NotesService is owned by the engine because subagents share it. */
  private notes!: NotesController;
  /** Owns the team-mode coordinator tools (create_subtask / update_subtask
   * / get_dag / set_phase). Also exposes the direct DAG API (list, ready,
   * remove, setPhase) the engine uses internally. */
  private subtasks!: SubtaskController;
  /** Owns session titling: the model-driven auto-title side call and the
   * first-user-message fallback. session.title stays the read-side source
   * of truth (persistence + renderer read it directly); every auto-title
   * write goes through the controller (title.ts). */
  private title!: TitleController;
  /** Owns the start-of-turn context weave (skills refresh, stale-read
   * notice, async-task delta snapshot, completion-notification injection).
   * All state stays on session (skills, readFileTimestamps,
   * lastTurnTaskStatuses); only the write paths live in the controller.
   * runTurn calls it in a fixed order before appending the user prompt. */
  private turnContext!: TurnContextController;
  /** Owns tool-output materialization (tool-output.ts): persisting each
   * tool call's full output to `.reina/tool_outputs/` and materializing the
   * pending round's observations into the durable transcript. Observations
   * stay on the engine's loop state and records on session.toolCalls; only
   * the write paths live in the controller. */
  private toolOutput!: ToolOutputController;
  private taskCompletions!: TaskCompletionsController;
  /** Tool-name → handler registry plus the fallback dispatch path
   * (tool-dispatch.ts). Built LAST in the constructor — the handlers capture
   * the controllers above by value (each assigned exactly once), while the
   * reassignable engine fields (session, abortController) flow through
   * getter-backed host access. executeToolOrEngine stays as a thin
   * same-named delegate. */
  private toolDispatch!: ToolDispatch;
  /** Shared audit notebook. Backed by .reina/notes/<id>.md files. Init
   * is async (scans dir) but cheap — handled in initNotesService below.
   * Subagents share their parent's instance so all writes land in the
   * same dossier (the whole point of the design). */
  private notesService: NotesService | null = null;
  private notesInitPromise: Promise<void> | null = null;
  /** Global cross-project notebook. Backed by `<REINA_HOME>/notes/g_*.md`,
   * injected into every session in every repo. Same NotesService machinery
   * as the workspace notebook, different root + `g_` id prefix. Subagents
   * share the parent's instance (like `notesService`). */
  private globalNotesService: NotesService | null = null;
  private globalNotesInitPromise: Promise<void> | null = null;
  /** Team-mode (Phase C) subtask DAG. Lazily wired by startSubtaskStore.
   * Like NotesService, subagents share the parent's instance so the
   * coordinator can read worker-pushed updates without round-tripping
   * through a file. */
  private subtasksStore: SubtaskStore | null = null;
  private subtaskUnsubscribe: (() => void) | null = null;
  /** Set by the parent engine on EVERY spawned child engine (fork or not):
   * when the child hits a tool that needs approval, it calls this instead of
   * stashing in its own `pending` map — which no one could ever answer.
   * The Promise resolves when the parent's user decides. */
  private bubbleApprovalHandler?: (record: ToolCallRecord) => Promise<BubbleApprovalDecision>;
  /** Parent-side: pending bubble resolvers keyed by the parent's mirror
   * record id. `resolveApproval` looks here first; a hit short-circuits
   * the local execution path and forwards the decision to the child. */
  private bubbleResolvers = new Map<string, (decision: BubbleApprovalDecision) => void>();
  /** Set by the parent engine on every spawned child: when a subagent worker
   * calls `question`, it routes the prompt here instead of stashing in its own
   * (UI-less) session. The Promise resolves when the parent's user answers. */
  private userQuestionHandler?: (input: {
    prompt: string;
    options?: string[];
  }) => Promise<{ answer: string } | { cancelled: true }>;
  /** Child-side: parent-mediated sibling-message delivery (send_task_message).
   * Installed by the parent's SubagentManager on every spawned child. */
  private siblingMessageHandler?: (input: { targetRef: string; message: string }) => { ok: boolean; detail: string };
  /** Parent-side: pending escalation resolvers keyed by the parent's mirror
   * question id. `answerQuestion` looks here first; a hit forwards the answer
   * to the awaiting child and skips the local observation path. */
  private userQuestionResolvers = new Map<string, (result: { answer: string } | { cancelled: true }) => void>();

  static async create(input: Partial<CreateSessionInput> = {}): Promise<AgentEngine> {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const { config, path: configPath, mcpPath } = await ensureConfig(cwd);
    // Read-only compatibility for existing configs. New settings are written
    // under `goal.verify`; legacy `autopilot.verify` is never mutated here.
    const legacyGoalVerify = (input.autopilot ?? config.autopilot)?.verify;
    const engine = new AgentEngine({
      cwd: input.cwd ?? config.cwd ?? cwd,
      agent: input.agent ?? config.agent ?? "default",
      permissionMode: input.permissionMode ?? config.permissionMode ?? "default",
      model: modelConfigSchema.parse({
        provider: "deterministic",
        model: "reina-deterministic",
        ...config.model,
        ...input.model,
      }),
      titleModel: input.titleModel ?? config.titleModel,
      compactionModel: input.compactionModel ?? config.compactionModel,
      autoTitle: input.autoTitle ?? config.autoTitle,
      goal: input.goal ?? config.goal ?? (legacyGoalVerify ? { verify: legacyGoalVerify } : undefined),
      autopilot: input.autopilot ?? config.autopilot,
      outputStyle: input.outputStyle ?? config.outputStyle,
      outputStyleCustom: input.outputStyleCustom ?? config.outputStyleCustom,
      toolLoop: input.toolLoop ?? config.toolLoop,
      subagent: input.subagent ?? config.subagent,
      selfEvolve: input.selfEvolve ?? config.selfEvolve,
      memory: input.memory ?? config.memory,
      hooks: input.hooks ?? config.hooks,
      tui: input.tui ?? config.tui,
      hostBridge: input.hostBridge,
      sessionStore: input.sessionStore ?? null,
    });
    engine.configPath = configPath;
    engine.mcpConfigPath = mcpPath;
    engine.runtimeConfigSnapshot = config;
    // Open the rollout recorder and seed it with the session_meta line. This
    // becomes the source of truth for the session — every subsequent
    // mutation gets appended as its own event.
    engine.recorder = await RolloutRecorder.open(rolloutPathFor(engine.session.cwd, engine.session.id), {
      firstMeta: {
        id: engine.session.id,
        title: engine.session.title,
        agent: engine.session.agent,
        cwd: engine.session.cwd,
        permissionMode: engine.session.permissionMode,
        model: engine.session.model,
        outputStyle: engine.session.outputStyle,
        outputStyleCustom: engine.session.outputStyleCustom,
        createdAt: engine.session.createdAt,
      },
      logger: engine.rolloutLogger(),
    });
    // Settle the constructor's detached notes-service inits before handing
    // the engine out: the first prompt wants the dossier anyway, and callers
    // (tests especially) may delete cwd right after using the engine — an
    // un-awaited init would still be writing index/schema files into it.
    // Engines built via `new AgentEngine(...)` skip this; pair those with
    // `dispose()` (or a retrying rm) before removing their directories.
    await engine.notesInitPromise;
    await engine.globalNotesInitPromise;
    await engine.refreshModelCatalog();
    return engine;
  }

  /** Fire-and-forget enqueue onto the rollout log. Safe to call before the
   * recorder is open (no-ops) so the engine constructor's `pushTrace` doesn't
   * blow up. Errors are logged inside the recorder; they never propagate. */
  private record(item: RolloutItem): void {
    if (!this.recorder) return;
    void this.recorder.append(item);
  }

  private commitProviderState(state: ProviderState | undefined): void {
    const hadState = this.session.providerState !== undefined;
    this.session.providerState = state;
    if (state) {
      this.record({ type: "provider_state", state });
    } else if (hadState) {
      this.record({ type: "provider_state_clear" });
    }
  }

  constructor(input: CreateSessionInput) {
    const now = nowIso();
    this.configPath = configPathFor(input.cwd);
    this.mcpConfigPath = mcpConfigPathFor(input.cwd);
    this.session = {
      id: createId("ses"),
      title: DEFAULT_SESSION_TITLE,
      agent: resolveProfile(input.agent ?? "default").name,
      cwd: path.resolve(input.cwd),
      permissionMode: input.permissionMode ?? "default",
      ...(input.isSubagent ? { isSubagent: true } : {}),
      ...(input.subagentDepth !== undefined ? { subagentDepth: input.subagentDepth } : {}),
      model: input.model ?? { provider: "deterministic", model: "reina-deterministic" },
      outputStyle: input.outputStyle,
      outputStyleCustom: input.outputStyleCustom,
      messages: [],
      toolCalls: [],
      readFileTimestamps: {},
      todos: [],
      pendingQuestions: [],
      skills: [],
      asyncTasks: [],
      trace: [],
      createdAt: now,
      updatedAt: now,
    };
    this.toolLoopConfig = input.toolLoop;
    this.hooksConfig = input.hooks;
    this.compactionModel = input.compactionModel;
    // The fallback is a one-way compatibility read for configs written before
    // Goal v2 had its own namespace. All new settings writes target `goal`.
    this.goalConfig = input.goal ?? (input.autopilot?.verify ? { verify: input.autopilot.verify } : undefined);
    this.autopilotConfig = input.autopilot;
    this.tuiConfig = input.tui;
    this.forkEnabledFlag = input.subagent?.forkEnabled !== false;
    this.subagentSecondaryModel = input.subagent?.secondaryModel;
    this.selfEvolveConfig = input.selfEvolve;
    this.memoryDreamConfig = input.memory;
    this.hostBridge = input.hostBridge;
    this.sessionStore = input.sessionStore ?? null;
    this.session.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, turns: 0 };
    pushTrace(this.session, "session.created", { cwd: this.session.cwd, agent: this.session.agent });
    // Warm up MCP connections in the background. The first turn's
    // resolveTools() call still gates on listMcpToolDefs, but by then the
    // connections are usually already established, so the user pays the
    // cold-start cost in parallel with whatever else they're doing instead of
    // mid-turn. Errors are swallowed — they're already recorded in the status
    // map and will surface again on the real call.
    void precomputeMcpServers(this.session.cwd).catch((error) => {
      this.reportBackgroundError("mcp.preconnect", error, { cwd: this.session.cwd });
    });
    // Both GC sweeps (gc.ts) read cwd and the running-task roster through
    // lazy getters, not snapshots — they run concurrently with anything,
    // including a loadSession that swaps this.session (same reassignable-
    // field hazard the controller hosts below document).
    const runningTaskIds = () =>
      new Set((this.session.asyncTasks ?? []).filter((t) => t.status === "running").map((t) => t.id));
    const reportSweepError = (category: string, error: unknown, context?: Record<string, unknown>) =>
      this.reportBackgroundError(category, error, context);
    // Sweep stale per-task event log directories so .reina/tasks/ doesn't
    // grow without bound across long-lived workspaces. Runs in the
    // background so engine construction stays cheap; failures are logged.
    void sweepStaleTaskDirs(() => this.session.cwd, runningTaskIds, reportSweepError).catch((error) => {
      this.reportBackgroundError("task_dir.sweep", error, { cwd: this.session.cwd });
    });
    // Background scan for orphan worktrees: dirs under .reina/worktrees/
    // whose age exceeds a generous threshold and whose taskId isn't in
    // this session's roster. Cross-session orphans (from a crashed sibling
    // session that never got loadSession's recovery) get reaped here.
    void sweepOrphanWorktrees(() => this.session.cwd, runningTaskIds, reportSweepError).catch((error) => {
      this.reportBackgroundError("worktree.sweep", error, { cwd: this.session.cwd });
    });
    // Notes service: scans .reina/notes/ on disk and builds the in-memory
    // index. Fire-and-forget; the first tool call awaits the promise. We
    // skip this for subagent engines — they share their parent's
    // NotesService instance, set in spawnChildEngine.
    this.startNotesService();
    this.startSubtaskStore();
    // Wire the subagent subsystem last — the host adapter closes over
    // `this`, so all engine-side methods it forwards (spawnChild,
    // rollupChildUsage, fireCompletionHooks) are already defined.
    this.subagent = new SubagentManager(this.createSubagentHost());
    // Every controller host below uses `get session()` (and getters for any
    // other engine field that gets reassigned, e.g. subtasksStore)
    // rather than capturing the current value. loadSession
    // and rollbackToMessage replace `this.session` with a fresh object;
    // a captured value would leave controllers writing into the orphan.
    // See the "routes controller writes to the live session" regression
    // test in engine.test.ts.
    const engine = this;
    this.taskCompletions = new TaskCompletionsController({
      get session() { return engine.session; },
      get subagent() { return engine.subagent; },
      onStream: (listener) => this.onStream(listener),
      appendMessage: async (item) => {
        await this.recorder?.appendDurable({ type: "message", message: item });
        this.session.messages.push(item);
        if (this.session.modelMessages) this.session.modelMessages.push(item);
      },
      reportError: (error) => this.reportBackgroundError("task_completion.ack", error),
    });
    this.todos = new TodosController({
      get session() {
        return engine.session;
      },
      record: (item) => this.record(item),
    });
    this.goals = new GoalService({
      get session() {
        return engine.session;
      },
      record: (item) => this.record(item),
      emitStream: (event) => this.emitStream(event),
      touch: () => this.touch(),
      persist: () => this.flushToStore(),
    });
    this.goalRuntime = new GoalRuntime(
      {
        get session() {
          return engine.session;
        },
        get goals() {
          return engine.goals;
        },
        hasPendingUserGate: () => this.hasPendingUserGate(),
        progressKey: () => this.goalProgressKey(),
        verify: (claim) => this.verifyGoalClaim(claim),
      },
      {
        maxContinuationRounds: this.goalConfig?.maxContinuationRounds,
        stagnationLimit: this.goalConfig?.stagnationLimit,
      },
    );
    this.submitResponseCtl = new SubmitResponseController({
      get session() {
        return engine.session;
      },
    });
    this.memory = new MemoryController({
      get session() {
        return engine.session;
      },
      get sessionStore() {
        return engine.sessionStore;
      },
      get memoryConfig() {
        return engine.memoryDreamConfig;
      },
    });
    this.plan = new PlanController({
      get session() {
        return engine.session;
      },
      record: (item) => this.record(item),
    });
    this.audit = new AuditController({
      get session() {
        return engine.session;
      },
      emitStream: (event) => this.emitStream(event),
      verifyCompletion: (record) => this.verifyAutopilotCompletion(record),
    });
    this.question = new QuestionController({
      get session() {
        return engine.session;
      },
      get userQuestionHandler() {
        return engine.userQuestionHandler;
      },
      record: (item) => this.record(item),
    });
    this.notes = new NotesController({
      get session() {
        return engine.session;
      },
      resolveNotesService: (scope) => this.resolveNotesService(scope),
      noteAuthor: () => this.noteAuthor(),
    });
    this.subtasks = new SubtaskController({
      get session() {
        return engine.session;
      },
      get subtasksStore() {
        return engine.subtasksStore;
      },
      record: (item) => this.record(item),
      emitStream: (event) => this.emitStream(event),
      touch: () => this.touch(),
    });
    this.title = new TitleController(
      {
        get session() {
          return engine.session;
        },
        record: (item) => this.record(item),
        touch: () => this.touch(),
        flushToStore: () => this.flushToStore(),
        reportBackgroundError: (category, error, context) => this.reportBackgroundError(category, error, context),
      },
      input.titleModel,
      input.autoTitle,
    );
    this.turnContext = new TurnContextController({
      get session() {
        return engine.session;
      },
      get subagent() {
        return engine.subagent;
      },
      record: (item) => this.record(item),
      appendMessage: (item) => this.appendMessage(item),
    });
    this.toolOutput = new ToolOutputController({
      get session() {
        return engine.session;
      },
      // Getter-backed like `session`: the engine REASSIGNS this field at
      // every loop reset/filter site, so a captured array would be stale.
      get pendingObservations() {
        return engine.pendingObservations;
      },
      appendMessage: (item) => this.appendMessage(item),
      reportBackgroundError: (category, error, context) => this.reportBackgroundError(category, error, context),
    });
    // Built AFTER every controller assignment above: the registry captures
    // the controllers by value (each is assigned exactly once, never
    // reassigned), while session/abortController — which ARE reassigned by
    // loadSession/rollbackToMessage/interrupt — flow through getters so
    // dispatch always reads the live objects.
    this.toolDispatch = createToolDispatch(
      {
        get session() {
          return engine.session;
        },
        get signal() {
          return engine.abortController.signal;
        },
        get taskEvents() {
          return engine.taskCompletions;
        },
        get hostBridge() {
          return engine.hostBridge;
        },
        emitStream: (event) => this.emitStream(event),
        sendTaskMessage: (record) => this.toolSendTaskMessage(record),
      },
      {
        subagent: this.subagent,
        todos: this.todos,
        submitResponse: this.submitResponseCtl,
        memory: this.memory,
        question: this.question,
        plan: this.plan,
        notes: this.notes,
        audit: this.audit,
        subtasks: this.subtasks,
        goals: this.goals,
      },
    );
  }

  /** Build the minimal callback surface SubagentManager needs from the
   * engine. Keeps the manager testable in isolation (a fake host suffices)
   * and documents which engine capabilities subagent code actually uses. */
  private createSubagentHost(): SubagentHost {
    // Getter-backed so loadSession / rollbackToMessage (which replace
    // `this.session` with a fresh object) don't strand the host on a
    // dead reference. Same pattern as the controllers wired in the
    // constructor — see the regression test in engine.test.ts.
    const engine = this;
    return {
      get session() {
        return engine.session;
      },
      get cwd() {
        return engine.session.cwd;
      },
      get signal() {
        return engine.abortController.signal;
      },
      get taskEvents() {
        return engine.taskCompletions;
      },
      forkEnabled: this.forkEnabledFlag,
      secondaryModel: this.subagentSecondaryModel,
      spawnChild: (input) => this.spawnChildEngine(input),
      record: (item) => this.record(item),
      persistAsyncTask: ({ task, eventType, payload }) => {
        if (!this.sessionStore) return;
        try {
          this.sessionStore.upsertAsyncTask(this.session.id, task);
          this.sessionStore.appendAsyncTaskEvent(this.session.id, task.id, eventType, {
            status: task.status,
            taskSnapshot: task,
            ...payload,
          });
        } catch (error) {
          this.reportBackgroundError("store.async_task", error, { taskId: task.id, eventType });
        }
      },
      tryAcquireAsyncTaskLease: ({ taskId, leaseOwner, leaseExpiresAt }) => {
        if (!this.sessionStore) return true;
        try {
          return this.sessionStore.tryAcquireAsyncTaskLease(this.session.id, taskId, leaseOwner, leaseExpiresAt);
        } catch (error) {
          this.reportBackgroundError("store.async_task.lease", error, { taskId });
          return false;
        }
      },
      enqueueAsyncTaskUpdate: ({ taskId, message }) => {
        if (!this.sessionStore) return undefined;
        try {
          return this.sessionStore.enqueueAsyncTaskUpdate(this.session.id, taskId, message);
        } catch (error) {
          this.reportBackgroundError("store.async_task.update_queue", error, { taskId });
          return undefined;
        }
      },
      claimAsyncTaskUpdates: ({ taskId, leaseOwner, leaseExpiresAt, limit }) => {
        if (!this.sessionStore) return [];
        try {
          return this.sessionStore.claimPendingAsyncTaskUpdates(
            this.session.id,
            taskId,
            leaseOwner,
            leaseExpiresAt,
            limit,
          );
        } catch (error) {
          this.reportBackgroundError("store.async_task.update_claim", error, { taskId });
          return [];
        }
      },
      markAsyncTaskUpdatesApplied: ({ updateIds }) => {
        if (!this.sessionStore || updateIds.length === 0) return;
        try {
          this.sessionStore.markAsyncTaskUpdatesApplied(this.session.id, updateIds);
        } catch (error) {
          this.reportBackgroundError("store.async_task.update_apply", error, { updateIds });
        }
      },
      dropPendingAsyncTaskUpdates: ({ taskId, reason }) => {
        if (!this.sessionStore) return;
        try {
          this.sessionStore.dropPendingAsyncTaskUpdates(this.session.id, taskId, reason);
        } catch (error) {
          this.reportBackgroundError("store.async_task.update_drop", error, { taskId });
        }
      },
      emitStream: (event) => this.emitStream(event),
      reportBackgroundError: (category, error, context) => this.reportBackgroundError(category, error, context),
      onStream: (listener) => this.onStream(listener),
      rollupChildUsage: (child) => this.rollupChildUsage(child),
      fireCompletionHooks: (task) => {
        void this.refreshRuntimeConfig().then(() => runHooks(this.hooksConfig, "onAsyncTaskComplete", {
          sessionId: this.session.id,
          cwd: this.session.cwd,
          task,
        })).catch((error) => this.reportBackgroundError("hooks.onAsyncTaskComplete", error, { taskId: task.id }));
      },
      notifyCoordinatorIdle: (task) => {
        // Only emit when team mode is active (the parent session has
        // pushed at least one subtask onto the DAG). Outside team mode
        // the coordinator inbox has no meaningful consumer, so the note
        // would just be noise in the workspace dossier.
        if (!this.session.subtasks?.length) return;
        void this.writeCoordinatorIdleNotification(task).catch((error) =>
          this.reportBackgroundError("mailbox.idle", error, { taskId: task.id }),
        );
      },
      bindSubtaskToTask: (input) => this.subtasks.bindOnDispatch(input.subtaskId, input.taskId),
      syncSubtaskFromTask: (task) => this.subtasks.syncFromSettledTask(task),
      awaitRequiredMcp: async (profileName) => {
        const profile = resolveProfile(profileName);
        await waitForRequiredMcp(this.session.cwd, profile);
      },
      requestBubbleApproval: (input) => this.requestBubbleApproval(input),
      requestUserQuestion: (input) => this.requestUserQuestion(input),
    };
  }

  /** Parent-side bubble adapter. Mints a mirror `pending_approval` record
   * on the parent session (attributed with `bubbledFromTask`) so the
   * supervisor's UI shows the prompt, then returns a Promise that resolves
   * when `resolveApproval` is called on the mirror id. The child engine
   * awaits this Promise inline; the parent's UI flow stays unchanged. */
  private requestBubbleApproval(input: {
    taskId: string;
    taskName?: string;
    childRecord: ToolCallRecord;
  }): Promise<BubbleApprovalDecision> {
    const childRecord = input.childRecord;
    const mirrorId = `bub_${createId("bub").slice(-10)}`;
    const mirror: ToolCallRecord = {
      ...childRecord,
      id: mirrorId,
      bubbledFromTask: input.taskName ? { id: input.taskId, name: input.taskName } : { id: input.taskId },
    };
    return new Promise<BubbleApprovalDecision>((resolve) => {
      this.bubbleResolvers.set(mirrorId, resolve);
      this.pending.set(mirrorId, mirror);
      this.session.toolCalls.push(mirror);
      this.record({ type: "tool_call", record: mirror });
      pushTrace(this.session, "tool.pending", { ...toolTraceData(mirror), bubbledFromTask: mirror.bubbledFromTask });
      // Real-time surfacing: the parent's turn may be blocked driving a sync
      // child (the turn-end permission_request can then never fire), so push
      // the mirror to the HITL dock NOW via the stream. agent-host translates
      // this into the top-level `permission_request` the renderer handles.
      this.emitStream({ type: "permission-request", toolCall: mirror });
      this.emitStream({
        type: "tool-progress",
        id: mirror.id,
        name: mirror.name,
        status: "running",
        message: `awaiting approval (bubbled from ${input.taskName ?? input.taskId})`,
        input: mirror.input,
      });
    });
  }

  /** Test/manager seam: install a bubble approval handler on a child
   * engine. The handler is invoked from the child's tool loop whenever a
   * call needs approval; the manager wires it on every spawned child so
   * no child ever parks an unanswerable prompt in its own pending map. */
  setBubbleApprovalHandler(handler: ((record: ToolCallRecord) => Promise<BubbleApprovalDecision>) | undefined): void {
    this.bubbleApprovalHandler = handler;
  }

  /** Test/manager seam: install a user-question (escalation) handler on a
   * child engine. Invoked from the child's `question` dispatch whenever the
   * child is a subagent, routing the prompt up to the parent's HITL flow. */
  setUserQuestionHandler(
    handler:
      | ((input: { prompt: string; options?: string[] }) => Promise<{ answer: string } | { cancelled: true }>)
      | undefined,
  ): void {
    this.userQuestionHandler = handler;
  }

  /** Manager seam: install the sibling-message delivery handler on a child
   * engine. send_task_message from the child routes here; the parent's
   * SubagentManager resolves the target task in ITS roster and delivers. */
  setSiblingMessageHandler(
    handler: ((input: { targetRef: string; message: string }) => { ok: boolean; detail: string }) | undefined,
  ): void {
    this.siblingMessageHandler = handler;
  }

  /** send_task_message dispatch. Only meaningful on a subagent child (the
   * manager installs the handler at spawn); a supervisor calling it gets
   * pointed at update_async_task instead. */
  private toolSendTaskMessage(record: ToolCallRecord): ToolObservation {
    const input = record.input as { taskRef?: string; taskId?: string; message?: string };
    const ref = input.taskRef ?? input.taskId;
    const message = input.message;
    if (!ref)
      return {
        callId: record.id,
        name: record.name,
        error: "send_task_message requires taskRef (sibling task id or name)",
      };
    if (!message) return { callId: record.id, name: record.name, error: "send_task_message requires message" };
    if (!this.siblingMessageHandler) {
      return {
        callId: record.id,
        name: record.name,
        error: this.session.isSubagent
          ? "Sibling messaging is not wired for this worker (no parent channel)."
          : "send_task_message is the worker→worker channel. As the supervisor, use update_async_task to steer a task.",
      };
    }
    const result = this.siblingMessageHandler({ targetRef: ref, message });
    return result.ok
      ? { callId: record.id, name: record.name, output: result.detail }
      : { callId: record.id, name: record.name, error: result.detail };
  }

  /** Parent-side escalation adapter. Mints a mirror pending question on the
   * parent session (attributed with `bubbledFromTask`), surfaces it on the
   * HITL dock via the real-time `question-request` stream event, and resolves
   * when `answerQuestion` is called on the mirror id. The child engine awaits
   * this inline. A wall-clock timeout resolves `cancelled` so a worker never
   * blocks forever on an unattended prompt. */
  private requestUserQuestion(input: {
    taskId: string;
    taskName?: string;
    prompt: string;
    options?: string[];
  }): Promise<{ answer: string } | { cancelled: true }> {
    const mirrorId = `q_${createId("q").slice(-10)}`;
    const question = {
      id: mirrorId,
      question: input.prompt,
      ...(input.options && input.options.length > 0 ? { options: input.options.map((label) => ({ label })) } : {}),
      status: "pending" as const,
      bubbledFromTask: input.taskName ? { id: input.taskId, name: input.taskName } : { id: input.taskId },
      createdAt: nowIso(),
    };
    return new Promise<{ answer: string } | { cancelled: true }>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: { answer: string } | { cancelled: true }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.userQuestionResolvers.delete(mirrorId);
        resolve(result);
      };
      this.userQuestionResolvers.set(mirrorId, finish);
      this.session.pendingQuestions.push(question);
      this.record({ type: "question", question });
      pushTrace(this.session, "question.pending", { id: mirrorId, bubbledFromTask: question.bubbledFromTask });
      this.emitStream({ type: "question-request", question });
      // Unattended-prompt safety valve: 5 minutes, then let the worker proceed.
      timer = setTimeout(() => {
        this.session.pendingQuestions = this.session.pendingQuestions.filter((q) => q.id !== mirrorId);
        finish({ cancelled: true });
      }, 5 * 60_000);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /** Append an idle notification to the shared notes dossier addressed
   * to the team coordinator inbox. Best-effort — failure surfaces via
   * reportBackgroundError but never blocks the worker's settlement. */
  private async writeCoordinatorIdleNotification(task: AsyncTaskRecord): Promise<void> {
    const service = await this.resolveNotesService();
    if (!service) return;
    const { title, body, tags } = formatIdleNotification(task);
    await service.append({
      title,
      body,
      tags,
      refs: [],
      status: "open",
      author: this.noteAuthor(),
      recipient: COORDINATOR_RECIPIENT,
    });
  }

  /** Boot the team-mode subtask DAG store. Hydrates from any subtasks
   * already on this.session (rollout replay populated them) and wires
   * an onChange forwarder onto the model stream so the renderer can
   * keep the DAG view live. Idempotent across loadSession calls. */
  private startSubtaskStore(): void {
    if (this.session.isSubagent) return;
    // Detach any prior store first (loadSession path).
    if (this.subtaskUnsubscribe) {
      this.subtaskUnsubscribe();
      this.subtaskUnsubscribe = null;
    }
    const store = new SubtaskStore();
    if (this.session.subtasks && this.session.subtasks.length > 0) {
      store.hydrate(this.session.subtasks);
      this.session.subtasks = store.list();
    }
    this.subtasksStore = store;
    this.subtaskUnsubscribe = store.onChange(({ subtask, change }) => {
      // Keep session.subtasks in sync with the store's authoritative state.
      const list = this.session.subtasks ?? [];
      if (change === "removed") {
        this.session.subtasks = list.filter((node) => node.id !== subtask.id);
      } else {
        const idx = list.findIndex((node) => node.id === subtask.id);
        if (idx === -1) this.session.subtasks = [...list, subtask];
        else {
          const next = list.slice();
          next[idx] = subtask;
          this.session.subtasks = next;
        }
      }
      // Forward to the renderer and persist via rollout.
      this.emitStream({ type: "subtask-updated", subtask, change });
      this.record(change === "created" ? { type: "subtask", subtask } : { type: "subtask_update", subtask });
    });
  }

  /** Boot the workspace's shared notebook service. Called once per
   * top-level engine (constructor) and after loadSession swaps the
   * session state. Idempotent. Subagents inherit the parent's instance
   * via spawnChildEngine and do NOT call this. */
  private startNotesService(): void {
    if (this.session.isSubagent) return;
    const service = new NotesService(path.join(this.session.cwd, ".reina", "notes"));
    this.notesService = service;
    this.notesInitPromise = service
      .init()
      .then(() => {
        // Hydrate session.notes from the on-disk dossier so prompt building
        // sees the index immediately on the next turn.
        this.session.notes = service.list();
      })
      .catch((error) => {
        this.reportBackgroundError("notes.init", error, { cwd: this.session.cwd });
      });
    this.startGlobalNotesService();
    // Forward NotesService change events onto the engine's stream so
    // renderers (and the rollout recorder) can react in real time.
    service.onChange(({ note, change }) => {
      // Keep session.notes in sync. The Notes index is small enough that
      // a full splice on every change is fine.
      const existing = this.session.notes ?? [];
      const idx = existing.findIndex((entry) => entry.id === note.id);
      if (change === "deleted") {
        if (idx !== -1) {
          const next = existing.slice();
          next.splice(idx, 1);
          this.session.notes = next;
        }
      } else if (idx === -1) {
        this.session.notes = [...existing, note];
      } else {
        const next = existing.slice();
        next[idx] = note;
        this.session.notes = next;
      }
      this.emitStream({ type: "notes-updated", note, change });
    });
  }

  /** Boot the global cross-project notebook (`<REINA_HOME>/notes`, `g_`
   * prefix). Mirrors startNotesService but keeps its own in-memory index in
   * `session.globalNotes`. Deliberately does NOT emit `notes-updated` — that
   * stream feeds the per-project Notes cache / rollout; global writes get
   * their own payload-free `global-notes-updated` signal instead, so the
   * workspace window's Global tab can live-refresh without global entries
   * ever leaking into per-project consumers. */
  private startGlobalNotesService(): void {
    const service = new NotesService(path.join(reinaConfigHome(), GLOBAL_NOTES_DIRNAME), {
      idPrefix: "g",
      schemaSeed: GLOBAL_WIKI_SCHEMA_SEED,
    });
    this.globalNotesService = service;
    this.globalNotesInitPromise = service
      .init()
      .then(() => {
        this.session.globalNotes = service.list();
      })
      .catch((error) => {
        this.reportBackgroundError("notes.init.global", error, {});
      });
    service.onChange(() => {
      // In-memory sync, so a same-turn append is visible to a following
      // list_notes(scope:"global"). Full re-list is cheap for this small tier.
      this.session.globalNotes = service.list();
      // Live signal for the workspace window's Global tab. Fires for the
      // parent's own writes AND the self-evolve fork's (the child shares this
      // service instance, so this parent-registered callback sees them all).
      this.emitStream({ type: "global-notes-updated" });
    });
  }

  /** Mirror the live session into the SQLite store. Cheap (single
   * upsert + state-blob rewrite + bulk replace of messages/tools/trace
   * inside one transaction) but not free — call from turn boundaries and
   * explicit save flows, not from every internal touch. */
  private flushToStore(): void {
    if (!this.sessionStore) return;
    try {
      this.sessionStore.persistSession(this.session);
    } catch (error) {
      this.reportBackgroundError("store.persist", error, { sessionId: this.session.id });
    }
  }

  listAgents() {
    return profiles.filter((profile) => !profile.hidden);
  }

  async availableTools() {
    return this.resolveTools();
  }

  onStream(listener: (event: ModelStreamEvent) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  onTaskCompletion(listener: () => void): () => void {
    return this.taskCompletions.subscribe(listener);
  }

  taskCompletionRevision(): number {
    return this.taskCompletions.revision;
  }

  backgroundShellTaskCount(): number {
    return listBackgroundShellTasks(this.session.id).filter((task) => task.status === "running").length;
  }

  setAgent(agent: string): void {
    this.session.agent = resolveProfile(agent).name;
    this.session.providerState = undefined;
    this.touch();
    this.record({ type: "config", changes: { agent: this.session.agent } });
  }

  setModel(model: ModelConfig): void {
    // Full replacement, NOT a shallow merge. A saved model entry is a complete
    // tuple — merging with the previous session.model risks leaking the old
    // baseUrl/apiKey into the new entry when the new entry doesn't explicitly
    // set them (JSON-IPC drops undefined fields, so the agent-host sees a
    // stripped object and old fields would otherwise survive). Callers always
    // pass a complete ModelConfig; updateConfig builds it from the incoming
    // partial below.
    this.session.model = model;
    // Provider-specific replay state (Anthropic assistantContent vs openai-chat
    // assistantMessage) is invalid against the new provider — clear it so the
    // next turn doesn't send a stale tool_use snapshot to a mismatched API.
    this.session.providerState = undefined;
    this.touch();
    this.record({ type: "config", changes: { model } });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.session.permissionMode = mode;
    this.touch();
    this.record({ type: "config", changes: { permissionMode: mode } });
  }

  setCwd(cwd: string): void {
    this.session.cwd = path.resolve(cwd);
    this.touch();
    this.record({ type: "config", changes: { cwd: this.session.cwd } });
  }

  setOutputStyle(style?: OutputStyle, custom?: string): void {
    this.session.outputStyle = style;
    if (custom !== undefined) this.session.outputStyleCustom = custom;
    this.touch();
    const changes: SessionConfigChanges = { outputStyle: style };
    if (custom !== undefined) changes.outputStyleCustom = custom;
    this.record({ type: "config", changes });
  }

  setTitle(title: string): void {
    const clean = title.trim().slice(0, 120);
    if (!clean) return;
    this.session.title = clean;
    this.touch();
    this.record({ type: "config", changes: { title: clean } });
    // Title changes are user-visible immediately — flush so the sidebar's
    // SessionStore-backed query reflects the new name without waiting for
    // the next turn boundary.
    this.flushToStore();
  }

  /** Codex-style toggle setter. Flips `session.sessionModes[name]` and
   * persists the change via a `config` rollout event with a sparse
   * `sessionModes` delta. Idempotent: if the requested state already
   * matches, the call short-circuits and no event is recorded. */
  setSessionMode(name: SessionModeName, on: boolean): void {
    const current = this.session.sessionModes ?? {};
    const before = current[name] === true;
    const next = on === true;
    if (before === next) return;
    this.session.sessionModes = { ...current, [name]: next };
    this.touch();
    this.record({ type: "config", changes: { sessionModes: { [name]: next } } });
    pushTrace(this.session, "session.config.updated", { sessionMode: name, on: next });
    // ON→OFF: queue a one-shot transition notice for the next turn. While ON the
    // model wrote a coordinator persona into durable history; the per-turn
    // reminder simply vanishing isn't enough to dislodge it on a weak model, so
    // re-ground it explicitly (codex's collaboration-mode OFF diff). Replay never
    // reaches here — rollout replays config events straight onto sessionModes —
    // so this only fires on a live toggle.
    if (before && !next) this.pendingModeExitReminders.push(modeExitReminder(name));
  }

  /**
   * Apply a config change to the live session. Takes effect at the next turn
   * boundary; the in-flight turn (if any) keeps the previous config.
   * Returns a summary of what actually changed, suitable for an audit message.
   */
  updateConfig(input: {
    agent?: string;
    model?: Partial<ModelConfig>;
    permissionMode?: PermissionMode;
    outputStyle?: OutputStyle;
    outputStyleCustom?: string;
    title?: string;
    sessionModes?: Partial<Record<SessionModeName, boolean>>;
  }): {
    changed: string[];
    previous: { agent?: string; model?: string; permissionMode?: PermissionMode; outputStyle?: OutputStyle };
  } {
    const before = {
      agent: this.session.agent,
      model: `${this.session.model.provider}/${this.session.model.model}`,
      permissionMode: this.session.permissionMode,
      outputStyle: this.session.outputStyle,
      title: this.session.title,
    };
    const changed: string[] = [];

    if (input.title !== undefined) {
      const next = input.title.trim().slice(0, 120);
      if (next && next !== this.session.title) {
        this.setTitle(next);
        changed.push(`title: ${before.title || "(empty)"} → ${this.session.title}`);
      }
    }
    if (input.agent !== undefined && input.agent !== this.session.agent) {
      this.setAgent(input.agent);
      changed.push(`agent: ${before.agent} → ${this.session.agent}`);
    }
    if (input.model !== undefined) {
      // Build the full target ModelConfig from the incoming partial. We
      // explicitly do NOT spread `this.session.model` over the new fields —
      // see setModel for why a shallow merge is unsafe across model entries.
      // Only `provider` and `model` (the identity) fall back to the previous
      // value when the caller didn't include them; the rest are taken as-is
      // (undefined → cleared), so switching to an entry with no baseUrl
      // doesn't inherit the old entry's baseUrl.
      const next: ModelConfig = {
        provider: input.model.provider ?? this.session.model.provider,
        model: input.model.model ?? this.session.model.model,
        baseUrl: input.model.baseUrl,
        apiKey: input.model.apiKey,
        contextWindowTokens: input.model.contextWindowTokens,
        maxOutputTokens: input.model.maxOutputTokens,
        reasoningEffort: input.model.reasoningEffort,
        // Per-model capability fields (models.json). Dropping them here would
        // silently revert the model to the providers' built-in heuristics on
        // the very update that changes effort — the field they gate.
        thinkingMode: input.model.thinkingMode,
        supportedEfforts: input.model.supportedEfforts,
        reasoningLevels: input.model.reasoningLevels,
        reasoningDialect: input.model.reasoningDialect,
        // offEffort is the wire encoding for "thinking off" on endpoints that
        // only disable via an explicit reasoning_effort:"none" (grok-4-class).
        // Dropping it here would silently re-enable thinking on the very update
        // that was meant to keep it off.
        offEffort: input.model.offEffort,
        // Subscription/OAuth fields ride along as-is. Dropping them here would
        // silently revert an OAuth (Claude) model to x-api-key auth, or strip a
        // Codex account id — both surface as upstream 401/400 on the next turn.
        // subscriptionUserAgent included: main re-injects the live value on
        // every update, and losing it would degrade the forged CLI fingerprint
        // to the providers' stale fallback literals.
        authMode: input.model.authMode,
        headers: input.model.headers,
        accountId: input.model.accountId,
        subscriptionId: input.model.subscriptionId,
        subscriptionUserAgent: input.model.subscriptionUserAgent,
        // Subscription-declared server tools (Kimi's kimi_web_search /
        // kimi_web_fetch). Dropping them here would silently strip the
        // server-side tools the engine promotes into the tools array
        // (see the subscriptionTools block in resolveTools) on ANY settings
        // update to a subscription model.
        subscriptionTools: input.model.subscriptionTools,
      };
      const prev = this.session.model;
      // Every ModelConfig field must appear here: a field missing from the
      // comparison makes setModel silently SKIP when only that field changed
      // (e.g. re-resolving an OAuth token changed only authMode/accountId —
      // the session kept the stale identity and the next turn 401'd).
      const fieldsChanged =
        next.provider !== prev.provider ||
        next.model !== prev.model ||
        next.baseUrl !== prev.baseUrl ||
        next.apiKey !== prev.apiKey ||
        next.contextWindowTokens !== prev.contextWindowTokens ||
        next.maxOutputTokens !== prev.maxOutputTokens ||
        next.reasoningEffort !== prev.reasoningEffort ||
        next.thinkingMode !== prev.thinkingMode ||
        next.reasoningDialect !== prev.reasoningDialect ||
        next.offEffort !== prev.offEffort ||
        next.authMode !== prev.authMode ||
        next.accountId !== prev.accountId ||
        next.subscriptionId !== prev.subscriptionId ||
        next.subscriptionUserAgent !== prev.subscriptionUserAgent ||
        JSON.stringify(next.supportedEfforts ?? null) !== JSON.stringify(prev.supportedEfforts ?? null) ||
        JSON.stringify(next.reasoningLevels ?? null) !== JSON.stringify(prev.reasoningLevels ?? null) ||
        JSON.stringify(next.headers ?? null) !== JSON.stringify(prev.headers ?? null) ||
        JSON.stringify(next.subscriptionTools ?? null) !== JSON.stringify(prev.subscriptionTools ?? null);
      if (fieldsChanged) {
        this.setModel(next);
        const identityChanged = next.provider !== prev.provider || next.model !== prev.model;
        if (identityChanged) {
          changed.push(`model: ${before.model} → ${next.provider}/${next.model}`);
        } else if (next.reasoningEffort !== prev.reasoningEffort) {
          changed.push(`reasoning effort: ${prev.reasoningEffort ?? "default"} → ${next.reasoningEffort ?? "default"}`);
        } else {
          changed.push("model settings updated");
        }
      }
    }
    if (input.permissionMode !== undefined && input.permissionMode !== this.session.permissionMode) {
      this.setPermissionMode(input.permissionMode);
      changed.push(`permission mode: ${before.permissionMode} → ${input.permissionMode}`);
    }
    if (input.outputStyle !== undefined && input.outputStyle !== this.session.outputStyle) {
      this.setOutputStyle(input.outputStyle, input.outputStyleCustom);
      changed.push(`output style: ${before.outputStyle ?? "default"} → ${input.outputStyle}`);
    } else if (input.outputStyleCustom !== undefined && input.outputStyleCustom !== this.session.outputStyleCustom) {
      this.session.outputStyleCustom = input.outputStyleCustom;
      changed.push("output style instructions updated");
    }
    if (input.sessionModes) {
      // Sparse delta — only properties present here get applied. Each is
      // routed through setSessionMode so the per-mode rollout event and
      // touch/trace fire identically whether the toggle comes via the
      // composer popover, a slash command, or another IPC client.
      for (const [name, on] of Object.entries(input.sessionModes)) {
        if (typeof on !== "boolean") continue;
        if (!isSessionModeName(name)) continue;
        const wasOn = this.session.sessionModes?.[name] === true;
        if (wasOn === on) continue;
        this.setSessionMode(name, on);
        changed.push(`mode ${name}: ${wasOn ? "on" : "off"} → ${on ? "on" : "off"}`);
      }
    }

    if (changed.length > 0) {
      this.appendMessage(message("system", `Session updated · ${changed.join(" · ")}`));
      pushTrace(this.session, "session.config.updated", {
        changed,
        agent: this.session.agent,
        model: this.session.model,
      });
    }
    return {
      changed,
      previous: before,
    };
  }

  interrupt(): void {
    if (this.session.interrupted) return;
    this.abortController.abort();
    this.abortController = new AbortController();
    // Unblock children awaiting a bubbled approval BEFORE clearing pending:
    // resolve each promise as rejected and stamp its mirror. Without this the
    // child's tool loop awaits forever — the subagent watchdog pauses on
    // pending_approval, so nothing else reaps it, and a sync `task` would
    // never return the parent's turn.
    for (const [mirrorId, resolveBubble] of [...this.bubbleResolvers]) {
      this.bubbleResolvers.delete(mirrorId);
      const mirror = this.pending.get(mirrorId);
      if (mirror) {
        mirror.allowedDecisions = undefined;
        mirror.status = "rejected";
        mirror.error = "Rejected: parent turn interrupted.";
        mirror.completedAt = nowIso();
        this.record({ type: "tool_update", record: mirror });
        pushTrace(this.session, "tool.rejected", toolTraceData(mirror));
      }
      resolveBubble({ approved: false, options: { reason: "Parent turn interrupted." } });
    }
    // Same for children awaiting a bubbled QUESTION: resolve `cancelled` (the
    // shape the unattended-prompt timer uses) so a sync `task` settles now
    // instead of parking the parent's turn on the 5-minute safety valve —
    // the host's close paths await that settle since the shutdown rework.
    // `finish` removes itself from the map; iterate a copy.
    for (const [mirrorId, finishQuestion] of [...this.userQuestionResolvers]) {
      this.session.pendingQuestions = this.session.pendingQuestions.filter((q) => q.id !== mirrorId);
      finishQuestion({ cancelled: true });
    }
    this.pending.clear();
    // Completed tool outputs may still be waiting for the model response
    // that normally materializes them. Preserve them before an interrupted
    // child (or user session) resumes with a new requirement.
    this.materializePendingToolResults();
    this.pendingObservations = [];
    this.session.interrupted = true;
    this.pendingSteers = [];
    this.record({ type: "interrupted", at: nowIso() });
    this.appendMessage(message("system", "Current turn was interrupted."));
    pushTrace(this.session, "session.interrupted", {});
    this.touch();
  }

  /** Quiesce the engine: await the background work the constructor /
   * loadSession started detached (workspace + global notes-service init,
   * which writes index/schema/log files under `cwd/.reina` and REINA_HOME)
   * and close the rollout recorder's write stream. Callers that delete the
   * engine's directories afterwards — tests tearing down a temp cwd, host
   * shutdown — MUST await this first, or the delete races the writers
   * (EBUSY/ENOTEMPTY on Windows). Idempotent; does NOT interrupt a live
   * turn (dispose of a working engine is the caller's bug, not ours to
   * mask with an implicit interrupt). */
  async dispose(): Promise<void> {
    this.taskCompletions.dispose();
    // Quiesce the detached background forks (memory dream / self-evolve
    // review) the engine itself launched: interrupt the child so its model
    // call aborts fast, then await the run's settlement — otherwise teardown
    // races the child's note/recorder writers (EBUSY/ENOTEMPTY on Windows).
    // Both promises already .catch into reportBackgroundError; the extra
    // catch keeps dispose from rejecting regardless.
    this.consolidationChild?.interrupt();
    this.selfReviewChild?.interrupt();
    await this.consolidationPromise?.catch(() => undefined);
    await this.selfReviewPromise?.catch(() => undefined);
    // Side chat dies with its parent engine (ephemeral by design).
    await this.closeSideChat().catch(() => undefined);
    // Both init promises carry their own .catch at creation, but keep the
    // defensive catch so dispose never rejects on an engine whose init
    // failed for unrelated reasons.
    await this.notesInitPromise?.catch(() => undefined);
    await this.globalNotesInitPromise?.catch(() => undefined);
    await this.contextHistoryStore().flush();
    await this.recorder?.close();
    this.recorder = null;
  }

  /** Mid-turn user input (codex-style "steer"). Queues a user message
   * to be appended after the current model iteration commits, before
   * any tool calls from that iteration execute. Does NOT abort the
   * in-flight stream — by design, matching codex: the user sees their
   * message in the transcript immediately while the previous model
   * response finishes streaming above it. continueLoop then calls the
   * model again with the steer as the latest user turn. */
  injectSteer(prompt: string, attachments?: MessageAttachment[], reminders?: string[], steerId?: string): string {
    const id = steerId ?? createId("steer");
    this.pendingSteers.push({ id, message: prompt, attachments });
    this.acceptTurnReminders(reminders);
    pushTrace(this.session, "turn.steered", { prompt, steerId: id });
    this.touch();
    return id;
  }

  /** Pull a not-yet-drained steer back out of the queue (the UI's "撤回" on a
   * pending steer row). Addressed by steerId when the caller has one (exact-
   * row semantics — two same-text steers stay distinguishable); message text
   * is the fallback for id-less callers, first occurrence. A provided id that
   * doesn't match does NOT fall back to text: the id identifies a specific
   * entry, and "not found" means it already drained. Returns false when
   * nothing was removed — the caller must NOT pretend it was withdrawn then. */
  retractSteer(ref: { steerId?: string; message?: string }): boolean {
    const index = ref.steerId
      ? this.pendingSteers.findIndex((steer) => steer.id === ref.steerId)
      : this.pendingSteers.findIndex((steer) => steer.message === ref.message);
    if (index === -1) return false;
    const [removed] = this.pendingSteers.splice(index, 1);
    pushTrace(this.session, "turn.steer_retracted", { prompt: removed!.message, steerId: removed!.id });
    this.touch();
    return true;
  }

  /** Normalize and stash one-shot reminders for the current/next turn.
   * Trims and drops empties so trace logs and the spliced reminder array
   * stay clean. Idempotent — call from any entry point (`runTurn` /
   * `injectSteer`) that accepts caller-supplied directive text. */
  private acceptTurnReminders(reminders?: string[]): void {
    if (!reminders || reminders.length === 0) return;
    const cleaned = reminders.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean);
    if (cleaned.length === 0) return;
    this.pendingTurnReminders.push(...cleaned);
    pushTrace(this.session, "turn.reminders.injected", { count: cleaned.length });
  }

  /** Append every queued steer as a user message and clear the queue.
   * Called at iteration boundaries in continueLoop. Returns true when
   * anything was drained — callers use that to force another model
   * iteration after a tool-less response. */
  private drainPendingSteers(): boolean {
    if (this.pendingSteers.length === 0) return false;
    const drained = this.pendingSteers;
    this.pendingSteers = [];
    for (const steer of drained) {
      const userMessage = message("user", steer.message, steer.attachments);
      this.appendMessage(userMessage);
      pushTrace(this.session, "message.created", { message: userMessage });
      // Tell the renderer to materialize the user bubble in the transcript
      // and reset its in-progress assistant buffer. This is the signal that
      // a queued steer has crossed from "pending" to "committed".
      this.emitStream({
        type: "user-message",
        text: steer.message,
        steerId: steer.id,
        ...(steer.attachments && steer.attachments.length > 0 ? { attachments: steer.attachments } : {}),
      });
    }
    return true;
  }

  /** External (UI-driven) cancel for a specific async subagent task. Mirrors
   * the engine-internal `cancelAsyncTask` tool handler — interrupts the
   * child if it's still running, no-ops otherwise. The driveAsyncChild
   * observer detects the interrupt and flips the AsyncTaskRecord to
   * "cancelled" with the appropriate timestamps. Returns true when a
   * cancellation was actually fired (caller may want to log this). */
  cancelAsyncTaskExternal(taskId: string): boolean {
    return this.subagent.cancelExternal(taskId);
  }

  /** A human follow-up uses the same queue/reopen path as the supervisor. */
  updateAsyncTaskExternal(taskId: string, message: string): ToolObservation {
    return this.subagent.update({
      id: createId("call"),
      name: "update_async_task",
      input: { taskId, message },
      summary: "Send a message to a subagent",
      permission: "state",
      status: "running",
      createdAt: nowIso(),
    }, "user");
  }

  /** A child writes under its parent's durable task identity, even after a
   * completed task is reopened with a different child session/worktree. */
  setContextHistoryOwner(owner: ContextHistoryOwner): void {
    this.contextHistoryOwner = { ...owner };
  }

  async getContextHistory(taskId?: string): Promise<ContextHistory> {
    const history = await this.contextHistoryStore(taskId).history();
    if (taskId) return history;
    try {
      return { ...history, live: await this.previewContextRequest(history) };
    } catch (error) {
      this.reportBackgroundError("context.preview", error);
      return history;
    }
  }

  async getContextRequest(requestId: string, taskId?: string): Promise<ContextRequestDetail | null> {
    if (requestId === "live" && !taskId) return (await this.getContextHistory()).live ?? null;
    return this.contextHistoryStore(taskId).request(requestId);
  }

  private async previewContextRequest(history: ContextHistory): Promise<ContextRequestDetail> {
    const latest = history.requests.at(-1);
    const currentMessages = this.modelMessages();
    const lastMessage = currentMessages.at(-1);
    const key = JSON.stringify([
      this.session.id, this.session.updatedAt, this.session.model, this.session.modelOverride,
      this.session.agent, this.session.cwd, this.session.permissionMode, this.session.sessionModes, this.session.activeDeferredTools,
      currentMessages.length, lastMessage?.id, lastMessage?.content.length, this.session.toolCalls.length,
      latest?.id, latest?.status, latest?.completedAt, history.events.at(-1),
      this.pendingObservations.map((entry) => [entry.callId, (entry.output ?? entry.error ?? "").length]),
      this.pendingSteers.map((entry) => [entry.id, entry.message.length]),
      this.pendingTurnReminders, this.pendingModeExitReminders,
    ]);
    // Repeated inspector reads should not repeatedly tokenize a large prompt.
    // The short TTL also picks up rule-file edits without watching the files.
    if (this.contextPreview?.key === key && Date.now() - this.contextPreview.createdAt < 2_000) return this.contextPreview.detail;
    const profile = resolveProfile(this.session.agent);
    const model = { ...this.session.model, ...profile.model, ...this.session.modelOverride };
    const pool = this.filterPermittedMcpRuntimePool(this.contextPreviewMcpPool, profile);
    const tools = await this.resolveTools(pool, true);
    const observations = this.toolOutput.modelObservations();
    const pendingBytes = observations.reduce((sum, entry) => sum + (entry.attachments ?? []).reduce((size, attachment) => size + attachment.dataBase64.length, 0), 0);
    const queuedMessages: ChatMessage[] = this.pendingSteers.map((entry) => ({
      id: `preview-steer:${entry.id}`, role: "user", content: entry.message,
      attachments: entry.attachments, createdAt: this.session.updatedAt,
    }));
    const messages = capInflightAttachmentBytes([...this.modelMessages(), ...queuedMessages], Math.max(0, MAX_INFLIGHT_ATTACHMENT_BYTES - pendingBytes));
    // buildSystemPrompt freezes one top-level MCP-name field. Use a copy so
    // opening inspection cannot freeze the real prompt or append rollout data.
    const systemPrompt = buildSystemPrompt({ ...this.session });
    const reminders = this.requestContextReminders(messages, tools, pool, model);
    const systemReminders = [...new Set([...reminders.systemReminders, ...this.pendingModeExitReminders])];
    const breakdown = this.measureModelRequest(systemPrompt, messages, observations, tools, model, pool, systemReminders,
      systemReminders.includes(reminders.hiddenToolsReminder) ? reminders.hiddenToolsReminder : "");
    // Provider usage belongs to a completed attempt. Calibrate only within the
    // same context window and model; a running request has no input anchor yet.
    const compactedAt = history.events.filter((event) => event.status === "completed" && event.boundary).at(-1)?.createdAt;
    const providerInput = latest?.usage?.inputTokens;
    if (latest?.status === "completed" && latest.provider === model.provider && latest.model === model.model &&
        (!compactedAt || compactedAt < latest.startedAt) && typeof providerInput === "number" && Number.isFinite(providerInput) && providerInput > 0) {
      breakdown.projectedInputTokens = Math.max(0, Math.round(providerInput + breakdown.estimatedInputTokens - latest.breakdown.estimatedInputTokens));
    }
    const detail: ContextRequestDetail = {
      request: { id: "live", sessionId: this.session.id, turnId: "live", attempt: 0, startedAt: breakdown.createdAt,
        status: "preview", provider: model.provider, model: model.model, breakdown },
      sections: captureContextSections({ messages, observations, tools, systemPrompt, systemReminders }, breakdown.composition, this.session.toolCalls),
    };
    this.contextPreview = { key, createdAt: Date.now(), detail };
    return detail;
  }

  private contextHistoryStore(taskId?: string): ContextHistoryStore {
    if (taskId && !this.session.asyncTasks?.some((task) => task.id === taskId)) {
      throw new Error(`Task ${taskId} does not belong to this session`);
    }
    const owner = taskId
      ? { cwd: this.session.cwd, sessionId: this.session.id, taskId }
      : this.contextHistoryOwner ?? { cwd: this.session.cwd, sessionId: this.session.id };
    return new ContextHistoryStore(owner, (error) => this.reportBackgroundError("context.history", error));
  }

  private beginContextRequest(
    request: ModelRequest,
    breakdown: ContextRequestRecord["breakdown"],
    turnId: string,
    attempt: number,
  ): { store: ContextHistoryStore; request: ContextRequestRecord } | undefined {
    try {
      const record: ContextRequestRecord = {
        id: createId("ctx"), sessionId: this.session.id, turnId, attempt,
        startedAt: nowIso(), status: "running", provider: breakdown.provider, model: breakdown.model, breakdown,
      };
      const store = this.contextHistoryStore();
      store.recordRequest(record, captureContextSections(request, breakdown.composition, this.session.toolCalls));
      this.emitStream({ type: "context-request", request: record });
      return { store, request: record };
    } catch (error) {
      this.reportBackgroundError("context.history", error);
      return undefined;
    }
  }

  private finishContextRequest(
    capture: ReturnType<AgentEngine["beginContextRequest"]>,
    status: "completed" | "failed" | "cancelled",
    usage?: TokenUsage,
    error?: string,
  ): void {
    if (!capture) return;
    try {
      const request: ContextRequestRecord = {
        ...capture.request, completedAt: nowIso(), status,
        ...(usage ? { usage: { ...usage } } : {}), ...(error ? { error: error.slice(0, 2_000) } : {}),
      };
      capture.store.recordRequest(request);
      this.emitStream({ type: "context-request", request });
    } catch (failure) {
      this.reportBackgroundError("context.history", failure);
    }
  }

  private recordContextCompaction(event: ContextCompactionRecord): void {
    try {
      this.contextHistoryStore().recordEvent(event);
      this.emitStream({ type: "context-history-event", event });
    } catch (error) {
      this.reportBackgroundError("context.history", error);
    }
  }

  /** True when one or more background tasks have settled but their
   * `<task-notification>` has not yet been surfaced to the model — the
   * inbox drains at model boundaries. The host uses this to decide
   * whether to wake an idle session so the result isn't stranded until the
   * next user message. */
  hasPendingCompletionNotifications(): boolean {
    return this.taskCompletions.hasPending();
  }

  async runTurn(
    prompt: string,
    options?: { attachments?: MessageAttachment[]; reminders?: string[]; ephemeral?: boolean },
  ): Promise<AgentRunResult> {
    this.session.interrupted = false;
    await this.refreshRuntimeConfig();
    await this.turnContext.refreshContext();
    // Stop may arrive while skills/context are loading. Do not clear it after
    // that await and accidentally revive this (possibly automatic) turn.
    if (this.session.interrupted) return this.result();
    // Any steers queued but never drained (e.g. a previous turn failed
    // before continueLoop reached an iteration boundary) are stale —
    // the user's prompt this turn supersedes them. Drop them silently.
    this.pendingSteers = [];
    // One-shot reminders are scoped to a single turn. A fresh runTurn
    // entry means whatever directives the previous turn injected no
    // longer apply, so clear before accepting this turn's reminders.
    this.pendingTurnReminders = [];
    this.stormBreaker.reset();
    this.acceptTurnReminders(options?.reminders);
    // Drain any mode ON→OFF transition notices queued since the last turn into
    // this turn's one-shot reminders (they survive the reset above precisely so
    // a between-turn toggle lands here). One-shot: cleared after draining, so the
    // re-grounding shows once and doesn't churn the prompt-cache thereafter.
    if (this.pendingModeExitReminders.length > 0) {
      this.pendingTurnReminders.push(...this.pendingModeExitReminders);
      this.pendingModeExitReminders = [];
    }
    const submitHook = await runHooks(this.hooksConfig, "userPromptSubmit", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      prompt,
    }).catch(() => ({}) as { block?: boolean; message?: string });
    if (submitHook.block) {
      const note = submitHook.message || "Prompt blocked by userPromptSubmit hook";
      this.appendMessage(message("assistant", `(blocked) ${note}`));
      pushTrace(this.session, "turn.completed", { blocked: note });
      this.touch();
      return this.result();
    }
    const userMessage = message("user", prompt, options?.attachments);
    // Goal-continuation turns mark their anchor message ephemeral: the model
    // still sees it (it's a real user turn for the request) but the renderer
    // hides it from the visible transcript, so autonomous "keep going" cues
    // don't pile up as fake user bubbles. See projectMessageParts.
    if (options?.ephemeral) userMessage.ephemeral = true;
    // Inject context-setting notices BEFORE the user prompt so it stays
    // the last message in the array. Order matters for two reasons:
    //   (1) the deterministic test provider matches on the last user
    //       message; snapshot-then-prompt keeps tests stable.
    //   (2) it's semantically right — "here's the current state, now act
    //       on this request" reads better than "act, by the way state...".
    await this.turnContext.injectStaleReadNotice();
    await this.turnContext.injectAsyncTaskSnapshot();
    await this.taskCompletions.drain();
    this.appendMessage(userMessage);
    pushTrace(this.session, "turn.started", { prompt });
    pushTrace(this.session, "message.created", { message: userMessage });
    this.pending.clear();
    this.pendingObservations = [];
    await this.continueLoop();
    await this.refreshRuntimeConfig();
    void runHooks(this.hooksConfig, "onStop", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
    }).catch((error) => this.reportBackgroundError("hooks.onStop", error));
    pushTrace(this.session, "turn.completed", {
      pendingApprovals: this.pending.size,
      messages: this.session.messages.length,
      toolCalls: this.session.toolCalls.length,
    });
    this.touch();
    // Turn boundary: mirror full session state into the SQLite store. The
    // JSONL recorder caught every intermediate event; this is the
    // query-friendly snapshot that powers sidebar listing + FTS5 search.
    this.flushToStore();
    this.maybeSelfEvolve();
    this.maybeConsolidateMemory();
    return this.result();
  }

  /** grok's "dream" adapted to Reina: when the workspace's consolidation gate
   * opens (≥N sessions since the last run + cooldown — MemoryController owns
   * the math), fire a detached background fork that folds the accumulated
   * session briefs into the global notebook. Runs AFTER the turn settles and
   * never rides the user's own turn (the old in-turn nudge did, which made it
   * pure overhead for multi-project users). Fire-and-forget — a consolidation
   * must never block or fail the turn it followed. */
  private maybeConsolidateMemory(): void {
    if (this.session.isSubagent) return; // forks/subagents drive runTurn too
    // The user just halted this turn — don't answer a Stop by launching new
    // billable background work; the gate re-checks after the next clean turn.
    if (this.session.interrupted) return;
    if (this.consolidationInFlight) return;
    if (!this.memory.consolidationDue()) return;
    this.consolidationInFlight = true;
    this.consolidationPromise = this.runMemoryConsolidation()
      .catch((error) => this.reportBackgroundError("memory.consolidate", error))
      .finally(() => {
        this.consolidationInFlight = false;
        this.consolidationPromise = null;
      });
  }

  /** Fork a restricted `memory-consolidate` child (notes tools only) with the
   * consolidation material as its task. Same detached shape as
   * runSelfEvolveReview: bypass mode is safe because the profile's allow-list
   * has no shell/network/file tools; the watchdog bounds a wedged run.
   * beginConsolidation() stamps the workspace clocks BEFORE the model call
   * (grok stamps via its dream lock the same way) so concurrent sessions in
   * this workspace can't double-fire. No retry of a flaked run's batch: the
   * material cursor has moved, so the next run sees only newer sessions —
   * the raw material stays reachable via search_memory. */
  private async runMemoryConsolidation(): Promise<void> {
    const directive = this.memory.beginConsolidation();
    if (!directive) return;
    const child = this.spawnChildEngine({ cwd: this.session.cwd, agent: "memory-consolidate" });
    this.consolidationChild = child;
    // No user is watching a background consolidation — auto-approve within
    // the locked notes-only toolset instead of deadlocking on approval.
    child.session.permissionMode = "bypass";
    try {
      await this.subagent.runChildWithWatchdog(child, directive);
    } finally {
      this.rollupChildUsage(child); // consolidation tokens count toward the session bill
      child.interrupt(); // stop any lingering child timers
      await child.dispose().catch(() => undefined); // close the child's rollout recorder — this run never reopens it
      this.consolidationChild = null;
    }
    // Refresh the in-memory global-notes snapshot so the next turn's prompt
    // sees whatever the consolidation just wrote.
    if (this.globalNotesService) this.session.globalNotes = this.globalNotesService.list();
    pushTrace(this.session, "memory.consolidated", {});
  }

  /** Hermes-style learning loop: every `selfEvolve.everyTurns` top-level turns,
   * fire a detached background review that folds durable learnings into global
   * memory + skills. Guarded so it never recurses into forks/subagents (they
   * drive `runTurn` too) and never stacks two reviews. Fire-and-forget — a
   * review must never block or fail the turn it followed. */
  private maybeSelfEvolve(): void {
    if (this.session.isSubagent) return; // the review fork itself must not recurse
    // Same Stop courtesy as maybeConsolidateMemory: an interrupted turn
    // doesn't advance the cadence into new background billing.
    if (this.session.interrupted) return;
    const cfg = this.selfEvolveConfig;
    if (!cfg?.enabled) return;
    this.turnsSinceSelfReview += 1;
    const every = Math.max(1, cfg.everyTurns ?? 5);
    if (this.turnsSinceSelfReview < every) return;
    if (this.selfReviewInFlight) return; // prior review still running — try again next cadence
    this.turnsSinceSelfReview = 0;
    this.selfReviewInFlight = true;
    this.selfReviewPromise = this.runSelfEvolveReview()
      .catch((error) => this.reportBackgroundError("self_evolve.review", error))
      .finally(() => {
        this.selfReviewInFlight = false;
        this.selfReviewPromise = null;
      });
  }

  /** Fork a restricted `self-review` child that reviews the recent
   * conversation and writes durable learnings to the GLOBAL notebook +
   * skills. The child shares the parent's global NotesService (spawnChildEngine
   * wires it), so its `note(scope:"global")` writes land in the same dossier
   * the parent's next turn sees. Runs detached in `bypass` mode — safe because
   * the `self-review` profile's tool allow-list permits only note + file/skill
   * tools (no shell/network). Driven through the subagent watchdog so a wedged
   * review can't hang forever. */
  private async runSelfEvolveReview(): Promise<void> {
    const directive = await loadSelfEvolveDirective();
    const child = this.spawnChildEngine({ cwd: this.session.cwd, agent: "self-review" });
    this.selfReviewChild = child;
    // No user is watching a background review, so auto-approve within the
    // locked toolset instead of deadlocking on an approval prompt.
    child.session.permissionMode = "bypass";
    // Give the review a token-budgeted tail of the conversation to reflect on
    // (same deep-copied context builder the fork subagent uses).
    child.session.messages = buildForkContext(this.session).inheritedMessages;
    try {
      await this.subagent.runChildWithWatchdog(child, directive);
    } finally {
      this.rollupChildUsage(child); // review tokens count toward the session bill
      child.interrupt(); // stop any lingering child timers
      await child.dispose().catch(() => undefined); // close the child's rollout recorder — this run never reopens it
      this.selfReviewChild = null;
    }
    // The review wrote through the shared global NotesService; refresh our
    // in-memory snapshot so the very next turn's prompt shows the new memory.
    if (this.globalNotesService) this.session.globalNotes = this.globalNotesService.list();
    if (this.selfEvolveConfig?.notify === false) return;
    const summary = summarizeSelfReview(child.session.toolCalls);
    if (!summary) return;
    const at = nowIso();
    // Durable UI/audit record (never enters the model context) so a reloaded
    // session can restore the transcript notice. Cap to the most recent 50.
    const log = (this.session.selfEvolveLog ??= []);
    log.push({ summary, at });
    if (log.length > 50) log.splice(0, log.length - 50);
    pushTrace(this.session, "self_evolve.review", { summary });
    // Persist NOW: this review runs detached AFTER the turn's flushToStore,
    // and relaunch rebuilds the session by replaying the rollout — so the
    // entry needs its own rollout line (and a store mirror for the sidebar
    // snapshot) or it only survives if another turn happens before quit.
    this.record({ type: "self_evolve", entry: { summary, at } });
    this.flushToStore();
    // Live surface: a persistent "💾 self-evolve" notice in the transcript.
    this.emitStream({ type: "self-evolve-review", summary, at });
    process.stderr.write(`[reina-self-evolve] ${summary}\n`);
  }

  // ─── Side chat ("/btw") ────────────────────────────────────────────────────
  // An ephemeral child agent forked from THIS session so the user can ask
  // side questions while the main turn keeps running. kimi's skeleton
  // (in-process child, full-context copy, execution-layer tool veto — see
  // tool-dispatch.ts isSideChat gate) with codex's boundary-prompt semantics
  // (inherited history is reference material; read-only exploration allowed).

  /** Lazily create the side-chat child. Full parent history copy (exact
   * prefix → prompt-cache hit on the first call), boundary prompt appended,
   * same profile/model as the parent (a different model would be a different
   * cache namespace). `bypass` is safe: the dispatcher hard-vetoes every
   * non-read tool before permission checks matter, and a parked approval
   * would deadlock a panel that has no HITL surface. */
  private ensureSideChat(): AgentEngine {
    if (this.sideChatChild) return this.sideChatChild;
    const child = this.spawnChildEngine({ cwd: this.session.cwd, agent: this.session.agent });
    const seed = buildSideChatSeed(this.session);
    child.session.messages = seed.inheritedMessages;
    child.session.skills = seed.inheritedSkills;
    child.session.activeDeferredTools = seed.activeDeferredTools;
    child.session.isSideChat = true;
    child.session.permissionMode = "bypass";
    child.session.messages.push(message("user", SIDE_CHAT_BOUNDARY_PROMPT));
    this.sideChatUnsub = child.onStream((event) => {
      this.emitStream({ type: "side-chat-event", childSessionId: child.session.id, event });
    });
    this.sideChatChild = child;
    pushTrace(this.session, "side_chat.started", { childSessionId: child.session.id });
    return child;
  }

  /** Drive one side-chat turn, detached. Throws synchronously on bad input /
   * busy so the host can surface the error to the caller; the turn itself is
   * fire-and-forget with lifecycle mirrored via `side-chat-state` events. */
  sideChatPrompt(prompt: string): void {
    const text = prompt.trim();
    if (!text) throw new Error("Side chat prompt is empty.");
    if (this.session.isSubagent) throw new Error("Side chat is only available on top-level sessions.");
    if (this.sideChatBusy) throw new Error("Side chat is still answering — wait or interrupt it first.");
    const child = this.ensureSideChat();
    this.sideChatBusy = true;
    this.emitStream({ type: "side-chat-state", status: "started" });
    this.sideChatPromise = child
      .runTurn(text)
      .then(() => {
        this.emitStream({ type: "side-chat-state", status: "completed" });
      })
      .catch((error) => {
        this.reportBackgroundError("side_chat.turn", error);
        this.emitStream({ type: "side-chat-state", status: "failed", error: errorMessage(error) });
      })
      .finally(() => {
        this.sideChatBusy = false;
        this.sideChatPromise = null;
      });
  }

  /** Stop the in-flight side-chat turn (keeps the child + its history for
   * follow-ups). No-op when idle. */
  interruptSideChat(): void {
    this.sideChatChild?.interrupt();
  }

  /** Tear the side chat down: interrupt, await settlement, roll usage into
   * the parent's bill, close the child's recorder. Idempotent. */
  async closeSideChat(): Promise<void> {
    const child = this.sideChatChild;
    if (!child) return;
    this.sideChatChild = null;
    this.sideChatUnsub?.();
    this.sideChatUnsub = null;
    child.interrupt();
    await this.sideChatPromise?.catch(() => undefined);
    this.sideChatBusy = false;
    this.rollupChildUsage(child);
    await child.dispose().catch(() => undefined);
    pushTrace(this.session, "side_chat.closed", {});
    this.emitStream({ type: "side-chat-state", status: "closed" });
  }

  /** Fire the `sessionStart` lifecycle hook. The host calls this right after
   * the engine is registered, so it covers fresh creation, fork, and resume —
   * `source` distinguishes them. Fire-and-forget: a slow or failing hook must
   * never delay the session becoming usable. */
  fireSessionStart(source?: string): void {
    void this.refreshRuntimeConfig().then(() => runHooks(this.hooksConfig, "sessionStart", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      reason: source,
    })).catch((error) => this.reportBackgroundError("hooks.sessionStart", error));
  }

  /** Fire the `sessionEnd` lifecycle hook. The host calls this from
   * `closeSession` before the engine is dropped. Fire-and-forget for the same
   * reason as `fireSessionStart`. */
  fireSessionEnd(reason?: string): void {
    void this.refreshRuntimeConfig().then(() => runHooks(this.hooksConfig, "sessionEnd", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      reason,
    })).catch((error) => this.reportBackgroundError("hooks.sessionEnd", error));
  }

  /** True when the last turn ended parked on the user — a tool pending
   * approval (`this.pending`) or an unanswered question
   * (`session.pendingQuestions`). The autopilot loop checks this before
   * issuing a continuation round so it never talks over a HITL prompt;
   * mirrors the `status === "pending"` predicate `hasPendingQuestion` uses. */
  hasPendingUserGate(): boolean {
    if (this.pending.size > 0) return true;
    return this.session.pendingQuestions.some((question) => question.status === "pending");
  }

  /** Delegate an idle turn boundary to the dedicated Goal runtime. The host
   * contributes only the queue/HITL facts it owns; Goal state, continuation,
   * budgets, stagnation and completion verification stay inside GoalRuntime. */
  async maybeAdvanceGoalRuntime(opts: { hasQueuedInput: boolean }): Promise<boolean> {
    await this.refreshRuntimeConfig();
    return this.goalRuntime.maybeAdvance(opts);
  }

  /** Build the ephemeral, model-only cue for the next Goal continuation. */
  goalContinuationPrompt(): string {
    return this.goalRuntime.continuationPrompt();
  }

  private async verifyGoalClaim(claim: GoalCompletionClaim): Promise<GoalVerificationResult> {
    const verifyCfg = this.goalConfig?.verify;
    const run = this.session.goal?.run;
    if (verifyCfg?.enabled === false) return { pass: true };

    const modelConfig = modelConfigSchema.parse({
      ...this.session.model,
      ...(verifyCfg?.model ?? this.compactionModel),
    });
    if (modelConfig.provider === "deterministic") return { pass: true };

    const maxRounds = verifyCfg?.maxRounds && verifyCfg.maxRounds > 0 ? Math.floor(verifyCfg.maxRounds) : 3;
    const priorRounds = run?.verifyRounds ?? 0;
    if (priorRounds >= maxRounds) {
      this.emitStream({
        type: "goal-verification",
        claimId: claim.id,
        round: priorRounds,
        pass: true,
        reason: `accepted after ${maxRounds} verification round(s)`,
      });
      return { pass: true };
    }

    const round = priorRounds + 1;
    try {
      const trace = buildCompletionVerifyTrace(this.session, { status: "complete", summary: claim.evidence });
      const verdict = await runCompletionVerify(modelConfig, trace, {
        signal: this.abortController.signal,
        onUsage: (usage) => rollupSideUsage(this.session, usage),
      });
      this.emitStream({
        type: "goal-verification",
        claimId: claim.id,
        round,
        pass: verdict.pass,
        reason: verdict.reason,
      });
      return verdict.pass
        ? { pass: true }
        : {
            pass: false,
            reason: verdict.reason || "The supplied evidence did not prove the full objective.",
            feedback: verdict.feedback || "Gather concrete evidence for every completion requirement and try again.",
          };
    } catch (error) {
      if (this.abortController.signal.aborted || this.session.interrupted) return { suspended: true };
      this.reportBackgroundError("goal.verify", error, { provider: modelConfig.provider, model: modelConfig.model });
      if (verifyCfg?.failOpen !== false) return { pass: true };
      return {
        pass: false,
        reason: "Independent verification could not run.",
        feedback: "Re-check the current evidence and retry after the verifier is available.",
      };
    }
  }

  /** Independent verifier for the legacy autopilot close signal. Goal v2 uses
   * verifyGoalClaim above and never touches this state slot. */
  private async verifyAutopilotCompletion(
    record: ToolCallRecord,
  ): Promise<{ ok: true } | { ok: false; feedback: string }> {
    const ap = this.session.autopilot;
    const verifyCfg = this.autopilotConfig?.verify;
    // Default ON; only an explicit `enabled: false` disables it.
    if (!ap || verifyCfg?.enabled === false) return { ok: true };

    // Resolve the judge model: configured verifier model → compactionModel →
    // session model. The deterministic provider can't judge, so accept — this
    // makes the gate a no-op for unconfigured installs and deterministic tests.
    const modelConfig = modelConfigSchema.parse({
      ...this.session.model,
      ...(verifyCfg?.model ?? this.compactionModel),
    });
    if (modelConfig.provider === "deterministic") return { ok: true };

    const maxRounds = verifyCfg?.maxRounds && verifyCfg.maxRounds > 0 ? Math.floor(verifyCfg.maxRounds) : 3;
    const priorRounds = ap.verifyRounds ?? 0;
    if (priorRounds >= maxRounds) {
      // Exhausted independent checks — accept rather than trap a finished run.
      this.emitStream({
        type: "autopilot-verify",
        round: priorRounds,
        pass: true,
        reason: `accepted after ${maxRounds} verify round(s)`,
      });
      return { ok: true };
    }

    const failOpen = verifyCfg?.failOpen !== false;
    const round = priorRounds + 1;
    const input = record.input as { status?: string; summary?: string };
    try {
      const trace = buildCompletionVerifyTrace(this.session, { status: input.status, summary: input.summary });
      const verdict = await runCompletionVerify(modelConfig, trace, {
        signal: this.abortController.signal,
        onUsage: (usage) => rollupSideUsage(this.session, usage),
      });
      this.emitStream({ type: "autopilot-verify", round, pass: verdict.pass, reason: verdict.reason });
      if (verdict.pass) return { ok: true };
      // Rejected: keep the legacy autopilot running and surface feedback.
      ap.verifyRounds = round;
      ap.lastVerifyReason = verdict.reason;
      ap.lastVerifyFeedback = verdict.feedback || undefined;
      this.emitStream({ type: "autopilot-updated", state: { ...ap } });
      const feedback = [
        `Independent verification did NOT confirm completion (round ${round}/${maxRounds}).`,
        verdict.reason ? `Reason: ${verdict.reason}` : "",
        verdict.feedback ? `Next: ${verdict.feedback}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { ok: false, feedback };
    } catch (error) {
      // A user Stop while the judge stream is in flight aborts this.abortController
      // and rejects the verify. That is an interrupt, not a verifier failure:
      // don't report a background error, and don't take the fail-open accept
      // path (which would mark the run done as a side effect of the interrupt).
      // Returning ok:false leaves the run open; the turn's interrupt handling
      // stops the loop.
      if (this.abortController.signal.aborted || this.session.interrupted) {
        return { ok: false, feedback: "Independent verification was interrupted." };
      }
      this.reportBackgroundError("autopilot-verify", error, {
        provider: modelConfig.provider,
        model: modelConfig.model,
      });
      if (failOpen) return { ok: true };
      return {
        ok: false,
        feedback:
          "Independent verification could not run (verifier error). Re-check your work against the goal and continue if it is not yet fully achieved.",
      };
    }
  }

  /** Progress signature supplied to GoalRuntime for stagnation detection. */
  private goalProgressKey(): string {
    const writes = this.session.toolCalls.filter(
      (call) => call.status === "completed" && AUTOPILOT_PROGRESS_TOOLS.has(call.name),
    ).length;
    const settled = (this.session.asyncTasks ?? []).filter(
      (task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled",
    ).length;
    const reads = this.session.toolCalls.filter(
      (call) => call.status === "completed" && AUTOPILOT_INVESTIGATION_TOOLS.has(call.name),
    ).length;
    return `${writes}/${settled}/${reads}`;
  }

  /** Host/user Goal command entrypoint. This is the only IPC-facing mutation
   * path; model tools reach the same GoalService with actor=model. */
  executeGoalCommand(command: UserGoalCommand): ReturnType<GoalService["execute"]> {
    const result = this.goals.execute(command, "user");
    if (result.ok && result.changed) {
      pushTrace(this.session, "session.config.updated", {
        goalCommand: command.type,
        goalId: result.state.current?.id,
        revision: result.state.revision,
      });
      this.flushToStore();
    }
    return result;
  }

  async resolveApproval(
    callId: string,
    approved: boolean,
    options: { remember?: "session"; updatedInput?: unknown; reason?: string } = {},
  ): Promise<AgentRunResult> {
    const record = this.pending.get(callId);
    if (!record) return this.result();
    // Bubbled approval short-circuit: this mirror record stands in for a
    // fork child's pending call. Stamp the mirror as completed/rejected so
    // the supervisor's timeline reflects the decision, then forward the
    // verdict to the awaiting child via the resolver. The child runs the
    // real tool in its own context — the parent never executes here.
    const bubbleResolver = this.bubbleResolvers.get(callId);
    if (bubbleResolver) {
      this.bubbleResolvers.delete(callId);
      this.pending.delete(callId);
      record.allowedDecisions = undefined;
      record.completedAt = nowIso();
      if (approved) {
        if (options.updatedInput !== undefined) record.input = options.updatedInput;
        record.status = "completed";
        record.output =
          `Bubbled approval forwarded to fork ${record.bubbledFromTask?.name ?? record.bubbledFromTask?.id ?? ""}.`.trim();
      } else {
        const reason = options.reason?.trim();
        record.status = "rejected";
        record.error = reason ? `Rejected by user: ${reason}` : "Rejected by user.";
      }
      this.record({ type: "tool_update", record });
      pushTrace(this.session, approved ? "tool.completed" : "tool.rejected", toolTraceData(record));
      this.emitStream({
        type: "tool-progress",
        id: record.id,
        name: record.name,
        status: approved ? "completed" : "failed",
        message: record.output ?? record.error ?? "",
        input: record.input,
      });
      bubbleResolver({
        approved,
        options: approved
          ? { remember: options.remember, updatedInput: options.updatedInput }
          : { reason: options.reason },
      });
      return this.result();
    }
    this.pending.delete(callId);
    if (!approved) {
      const reason = options.reason?.trim();
      record.status = "rejected";
      record.error = reason ? `Rejected by user: ${reason}` : "Rejected by user.";
      record.completedAt = nowIso();
      this.record({ type: "tool_update", record });
      pushTrace(this.session, "tool.rejected", toolTraceData(record));
      this.pendingObservations.push({ callId: record.id, name: record.name, error: record.error });
      await this.continueLoop();
      return this.result();
    }
    if (options.updatedInput !== undefined) record.input = options.updatedInput;
    if (options.remember === "session")
      this.sessionApprovals.push({ ...sessionApprovalRule(record), cwd: this.session.cwd });
    record.allowedDecisions = undefined;
    this.record({ type: "tool_update", record });
    await this.executeRecord(record);
    await this.continueLoop();
    return this.result();
  }

  async answerQuestion(questionId: string, answer: string): Promise<AgentRunResult> {
    // Bubbled subagent question: forward the answer to the awaiting child and
    // clear the mirror. The child's tool loop resumes inline with the answer;
    // the parent does NOT run continueLoop here (it's already driving the child).
    const escalationResolver = this.userQuestionResolvers.get(questionId);
    if (escalationResolver) {
      const mirror = this.session.pendingQuestions.find((item) => item.id === questionId);
      if (mirror) {
        mirror.status = "answered";
        mirror.answer = answer;
        mirror.answeredAt = nowIso();
        this.record({ type: "question_update", question: mirror });
      }
      pushTrace(this.session, "question.answered", { id: questionId, answer, bubbled: true });
      escalationResolver({ answer });
      return this.result();
    }
    const question = this.session.pendingQuestions.find((item) => item.id === questionId);
    if (!question) return this.result();
    question.status = "answered";
    question.answer = answer;
    question.answeredAt = nowIso();
    this.record({ type: "question_update", question });
    pushTrace(this.session, "question.answered", { id: questionId, answer });
    // Side effects when this answer closes an exit_plan_mode gate. We detect
    // approval by checking the answer against the first option's label
    // (which the renderer should echo back verbatim). If approved we flip
    // session.plan.status and, if currently in plan mode, switch to default
    // so writes can proceed. Otherwise we leave the user in plan mode to
    // iterate. We also tag the observation with the original tool name so
    // the model sees a context-appropriate confirmation.
    const isExitPlan = question.intent === "exit_plan_mode";
    const approveLabel = question.options?.[0]?.label;
    const approved = isExitPlan && Boolean(approveLabel) && answer.trim() === approveLabel;
    if (isExitPlan) {
      if (approved) {
        if (this.session.plan) {
          this.session.plan.status = "approved";
          this.session.plan.updatedAt = nowIso();
          this.record({ type: "plan", plan: this.session.plan });
        }
        if (this.session.permissionMode === "plan") this.setPermissionMode("default");
        // Plan→Todo seam: decompose the approved plan's top-level steps into a
        // starting checklist so the plan isn't a dead artifact after approval.
        // Seeds nothing when the plan is prose-only or todos already exist —
        // then we just nudge the model to write_todos itself.
        const seededTodos = this.session.plan ? this.todos.seedFromPlan(this.session.plan.content) : 0;
        this.pendingObservations.push({
          callId: questionId,
          name: "exit_plan_mode",
          output:
            seededTodos > 0
              ? `User approved the plan. Permission mode is now \`default\`; you may proceed with writes and other state-changing tools as the plan describes. The plan was decomposed into a ${seededTodos}-item todo list (already in your todo state) — work through it and keep it current with write_todos, refining items as you go.`
              : "User approved the plan. Permission mode is now `default`; you may proceed with writes and other state-changing tools as the plan describes. Track your progress with write_todos.",
        });
        pushTrace(this.session, "exit_plan_mode.approved", { questionId, seededTodos });
      } else {
        this.pendingObservations.push({
          callId: questionId,
          name: "exit_plan_mode",
          output: `User chose to keep iterating on the plan. Their response: ${answer}. Refine the plan and call exit_plan_mode again when ready.`,
        });
        pushTrace(this.session, "exit_plan_mode.iterating", { questionId });
      }
    } else {
      this.pendingObservations.push({ callId: questionId, name: "question", output: `User answered: ${answer}` });
    }
    // Patch the original tool-call record so the timeline shows the real
    // answer instead of the "Question pending: …" placeholder forever.
    // tool_update event lets the renderer re-render the row in place.
    const toolRecord = this.session.toolCalls.find((call) => call.id === questionId);
    if (toolRecord) {
      toolRecord.output = isExitPlan
        ? approved
          ? `User approved the plan.`
          : `User: ${answer}`
        : `User answered: ${answer}`;
      this.record({ type: "tool_update", record: toolRecord });
    }
    await this.continueLoop();
    return this.result();
  }

  async saveSession(): Promise<string> {
    // The append-only rollout JSONL is the source of truth for crash
    // recovery; the SQLite store is the source of truth for queryable
    // state. Flush both so callers that await `save_session` can trust the
    // bytes are durable on disk.
    await this.recorder?.flush();
    this.flushToStore();
    return rolloutPathFor(this.session.cwd, this.session.id);
  }

  async rollbackToMessage(messageId: string): Promise<{ session: SessionState; restoredMessage: ChatMessage }> {
    const messageIndex = this.session.messages.findIndex((item) => item.id === messageId);
    if (messageIndex < 0) throw new Error(`Message not found: ${messageId}`);
    const target = this.session.messages[messageIndex]!;
    if (target.role !== "user") throw new Error("Only user messages can be rolled back.");
    await this.truncateFromMessageIndex(messageIndex, target.createdAt);
    return { session: this.session, restoredMessage: target };
  }

  /** Delete a message and everything after it, in place. Mirrors
   * `rollbackToMessage`'s truncation but accepts any message role (used by the
   * assistant message right-click "删除消息" → truncate-from-here). The clicked
   * message itself is removed along with its trailing tool calls / files. */
  async deleteFromMessage(messageId: string): Promise<{ session: SessionState }> {
    const messageIndex = this.session.messages.findIndex((item) => item.id === messageId);
    if (messageIndex < 0) throw new Error(`Message not found: ${messageId}`);
    const target = this.session.messages[messageIndex]!;
    await this.truncateFromMessageIndex(messageIndex, target.createdAt);
    return { session: this.session };
  }

  /** Compaction reuse for rewind/fork truncation (codex parity: a fork/rollback
   * truncates the rollout stream, so a Compacted checkpoint inside the kept
   * prefix survives). When the cut message still exists in the compacted model
   * view, everything the summary describes predates the cut — return the model
   * view sliced at the cut so callers can carry `summary`/`compactBoundaries`
   * over instead of replaying the raw uncompacted history (which re-triggers a
   * full re-compaction on the branch's first preflight). Returns undefined when
   * the cut sits INSIDE the compacted-away region: that summary covers messages
   * the caller just dropped, and reusing it would leak the rewound future. */
  private sliceModelViewAt(messageId: string, inclusive: boolean): ChatMessage[] | undefined {
    const view = this.session.modelMessages;
    if (!view) return undefined;
    const index = view.findIndex((item) => item.id === messageId);
    if (index < 0) return undefined;
    const kept = view.slice(0, inclusive ? index + 1 : index);
    return kept.length > 0 ? kept : undefined;
  }

  /** Shared truncation: keep messages before `messageIndex`, drop that message
   * and everything after, and prune tool calls / async tasks / files / trace
   * created at or after `cutAt`. Resets the same volatile per-turn state
   * rollback always has. Persists via session_replace + store flush. */
  private async truncateFromMessageIndex(messageIndex: number, cutAt: string): Promise<void> {
    const cutMessageId = this.session.messages[messageIndex]?.id;
    const keptModelMessages = cutMessageId !== undefined ? this.sliceModelViewAt(cutMessageId, false) : undefined;
    const keptMessages = this.session.messages.slice(0, messageIndex);
    const keptToolCalls = this.session.toolCalls.filter((call) => call.createdAt < cutAt);
    const keptTaskIds = new Set(
      (this.session.asyncTasks ?? []).filter((task) => task.startedAt < cutAt).map((task) => task.id),
    );

    this.subagent.pruneChildren(keptTaskIds);

    const recentFiles = (this.session.recentFiles ?? []).filter((file) => file.readAt < cutAt);
    const recentFilePaths = new Set(recentFiles.map((file) => file.path));
    const readFileTimestamps = Object.fromEntries(
      Object.entries(this.session.readFileTimestamps ?? {}).filter(([file]) => recentFilePaths.has(file)),
    );
    const now = nowIso();

    this.session = {
      ...this.session,
      messages: keptMessages,
      modelMessages: keptModelMessages,
      toolCalls: keptToolCalls,
      readFileTimestamps,
      recentFiles,
      todos: [],
      lastWriteTodosToolCallIndex: undefined,
      pendingQuestions: [],
      plan: undefined,
      asyncTasks: (this.session.asyncTasks ?? []).filter((task) => keptTaskIds.has(task.id)),
      lastTurnTaskStatuses: Object.fromEntries(
        Object.entries(this.session.lastTurnTaskStatuses ?? {}).filter(([taskId]) => keptTaskIds.has(taskId)),
      ),
      autopilot: undefined,
      submittedResponse: undefined,
      trace: this.session.trace.filter((event) => event.createdAt < cutAt),
      summary: keptModelMessages ? this.session.summary : undefined,
      compactBoundaries: keptModelMessages ? this.session.compactBoundaries : undefined,
      providerState: undefined,
      interrupted: false,
      usage: undefined,
      updatedAt: now,
    };
    this.pending.clear();
    this.pendingObservations = [];
    this.taskCompletions.prune();
    // Reset cache-prefix diagnostic — truncation changes the message history
    // so the next turn's prefix legitimately differs from the prior turn.
    this.lastSystemHash = undefined;
    this.lastToolsHash = undefined;
    await this.recorder?.append({ type: "session_replace", session: this.session });
    this.flushToStore();
  }

  /** Non-destructive fork: build a NEW session (new id) that contains history
   * up to AND INCLUDING `messageId`, persist it as its own rollout + store row,
   * and return it. The source session is left untouched. The host loads the
   * returned id into a fresh engine so the user lands on a separate branch they
   * can continue independently. */
  async forkToMessage(messageId: string, opts: { inclusive?: boolean } = {}): Promise<SessionState> {
    const inclusive = opts.inclusive !== false;
    const messageIndex = this.session.messages.findIndex((item) => item.id === messageId);
    if (messageIndex < 0) throw new Error(`Message not found: ${messageId}`);
    // `inclusive` (assistant "创建分支"): keep up to AND including the clicked
    // message, cutting tool calls / files at the next message's timestamp.
    // `inclusive === false` (user-message "撤回" → branch to before this message):
    // drop the clicked message and everything after, cutting at its own timestamp
    // so the branch resumes from the state just before it was sent.
    const cutAt = inclusive
      ? (this.session.messages[messageIndex + 1]?.createdAt ?? nowIso())
      : this.session.messages[messageIndex]!.createdAt;
    const keptMessages = this.session.messages.slice(0, inclusive ? messageIndex + 1 : messageIndex);
    // Compaction reuse — see sliceModelViewAt. undefined means the cut predates
    // the compaction and the branch must rebuild from raw history.
    const keptModelMessages = this.sliceModelViewAt(messageId, inclusive);
    const keptToolCalls = this.session.toolCalls.filter((call) => call.createdAt < cutAt);
    const recentFiles = (this.session.recentFiles ?? []).filter((file) => file.readAt < cutAt);
    const recentFilePaths = new Set(recentFiles.map((file) => file.path));
    const readFileTimestamps = Object.fromEntries(
      Object.entries(this.session.readFileTimestamps ?? {}).filter(([file]) => recentFilePaths.has(file)),
    );
    const now = nowIso();
    const forkedId = createId("ses");
    const baseTitle =
      this.session.title && this.session.title !== DEFAULT_SESSION_TITLE ? this.session.title : "Session";

    const forked: SessionState = {
      ...this.session,
      id: forkedId,
      parentSessionId: this.session.id,
      title: `${baseTitle} (分支)`,
      messages: keptMessages,
      modelMessages: keptModelMessages,
      toolCalls: keptToolCalls,
      readFileTimestamps,
      recentFiles,
      todos: [],
      lastWriteTodosToolCallIndex: undefined,
      pendingQuestions: [],
      plan: undefined,
      // Async subagent tasks don't carry over to a fork — they're tied to the
      // source session's live children. Start the branch with a clean roster.
      asyncTasks: [],
      lastTurnTaskStatuses: {},
      autopilot: undefined,
      submittedResponse: undefined,
      trace: this.session.trace.filter((event) => event.createdAt < cutAt),
      summary: keptModelMessages ? this.session.summary : undefined,
      // Sliced copy: the branch must never share the source's boundary array.
      compactBoundaries: keptModelMessages ? this.session.compactBoundaries?.slice() : undefined,
      providerState: undefined,
      interrupted: false,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, turns: 0 },
      createdAt: now,
      updatedAt: now,
    };

    const recorder = await RolloutRecorder.open(rolloutPathFor(forked.cwd, forked.id), {
      firstMeta: {
        id: forked.id,
        title: forked.title,
        agent: forked.agent,
        cwd: forked.cwd,
        permissionMode: forked.permissionMode,
        model: forked.model,
        outputStyle: forked.outputStyle,
        outputStyleCustom: forked.outputStyleCustom,
        createdAt: forked.createdAt,
      },
    });
    await recorder.append({ type: "session_replace", session: forked });
    await recorder.flush();
    await recorder.close();
    this.sessionStore?.upsertSession(forked);
    return forked;
  }

  async listSessions(): Promise<string[]> {
    const dir = path.join(this.session.cwd, ".reina", "sessions");
    return readdir(dir).catch(() => []);
  }

  async loadSession(sessionId: string): Promise<void> {
    // Tolerate both bare ids and ".json" / ".jsonl" suffixes for backward
    // compat with the old saveSession that returned a `<id>.json` path.
    const baseId = sessionId.replace(/\.(jsonl?|json)$/i, "");
    const cwd = this.session.cwd;
    const jsonlPath = rolloutPathFor(cwd, baseId);
    const jsonPath = legacyJsonPathFor(cwd, baseId);

    // Close any recorder from the previous in-memory session before we swap
    // state — we're about to open a new file handle. Awaited so the old
    // stream is fully flushed/released before the caller sees the swap.
    await this.recorder?.close();
    this.recorder = null;

    // Preferred path: replay the append-only JSONL into a SessionState.
    let loaded = await loadRolloutAsSession(jsonlPath);

    if (!loaded) {
      // Legacy migration: parse the old whole-file snapshot, decompose it
      // into events, and seed a fresh .jsonl from them. The .json on disk
      // stays untouched as a fallback until the user is comfortable.
      const migrated = await migrateJsonSnapshotToJsonl(jsonPath, jsonlPath);
      if (migrated) {
        loaded = await loadRolloutAsSession(jsonlPath);
      }
    }

    let loadedFromStore = false;
    if (!loaded) {
      // Fallback: load straight from the legacy JSON (no event log yet).
      // We still create a recorder so future mutations are captured.
      const raw = await readFile(jsonPath, "utf8").catch(() => null);
      if (raw == null) {
        // Deferred materialization means a session that was created but never
        // appended has NO .jsonl on disk, while its row in the workspace
        // SQLite mirror (upserted at create / persisted at turn boundaries)
        // still exists. Hydrate from the mirror so those sessions stay
        // openable — pre-deferral the eagerly-seeded session_meta line made
        // this cold open succeed with an empty transcript, and the mirror
        // fallback restores that behavior (and rescues sessions whose files
        // were deleted out-of-band but whose SQLite state survived). Only
        // when the mirror has nothing either do we surface a clean error —
        // the bare ENOENT from readFile would bubble up to the IPC handler
        // as an unhelpful path-leaking stack.
        loaded = this.sessionStore?.loadSession(baseId) ?? null;
        if (!loaded) {
          throw new Error(
            `Session ${baseId} not found in ${path.join(cwd, ".reina", "sessions")}. ` +
              `Neither <id>.jsonl nor <id>.json exists. The record may have been deleted ` +
              `externally; remove it from the workspace sidebar or rescan to refresh.`,
          );
        }
        loadedFromStore = true;
      } else {
        try {
          loaded = JSON.parse(raw) as SessionState;
        } catch (error) {
          throw new Error(`Session ${baseId} legacy snapshot at ${jsonPath} is not valid JSON: ${errorMessage(error)}`);
        }
      }
    }

    this.session = loaded;
    const migratedLegacyGoal = migrateLegacyGoalState(this.session);
    this.pending.clear();
    this.pendingObservations = [];
    // Drop the live-footprint anchor from the prior session; liveContextBase()
    // re-derives it from the loaded session's restored usage.
    this.lastContextBase = undefined;
    this.contextPreview = undefined;
    this.contextPreviewMcpPool = [];
    // Reset cache-prefix diagnostic — comparing against the prior in-memory
    // session's hashes would always misfire as "prefix changed".
    this.lastSystemHash = undefined;
    this.lastToolsHash = undefined;
    // Reopen the recorder for further appends. The replay/migration paths need
    // no initial meta (the file already starts with one); the store-mirror
    // fallback has NO file, so seed firstMeta — otherwise the first append
    // would materialize a headless jsonl that replay rejects ("… before
    // session_meta").
    this.recorder = await RolloutRecorder.open(rolloutPathFor(this.session.cwd, this.session.id), {
      logger: this.rolloutLogger(),
      ...(loadedFromStore
        ? {
            firstMeta: {
              id: this.session.id,
              title: this.session.title,
              agent: this.session.agent,
              cwd: this.session.cwd,
              permissionMode: this.session.permissionMode,
              model: this.session.model,
              outputStyle: this.session.outputStyle,
              outputStyleCustom: this.session.outputStyleCustom,
              createdAt: this.session.createdAt,
            },
          }
        : {}),
    });
    if (migratedLegacyGoal && this.session.goal) {
      this.record({ type: "goal_event", event: makeGoalEvent("migrated", "system", this.session.goal) });
    }
    this.rehydrateMemoryChunksFromStore();
    // Restart recovery: reconcile rollout state with the durable SQLite
    // projection, then classify process-local running attempts whose child
    // engines cannot exist in this fresh process.
    await this.recoverStaleAsyncTasks();
    await this.taskCompletions.restore();
    // Same restart recovery for the MAIN turn: a user message recorded with
    // no assistant follow-up, or tool calls still in `running` state, means
    // the previous process died mid-turn. Mark the session interrupted so
    // the supervisor / UI can prompt to resume rather than silently waiting.
    this.recoverInterruptedTurn();
    // Migrate pre-in-band sessions: materialize their out-of-band tool outputs
    // into the transcript once so the model keeps seeing them now that the
    // replay subsystem is gone. After recovery (which inspects the trailing
    // message) and before flushToStore (so the backfill is persisted). No-op
    // for new / already-backfilled sessions.
    this.backfillInbandToolResults();
    // Same one-time migration for the compaction summary: pre-fold sessions kept
    // it only in session.summary; with the per-turn summary reminder removed it
    // must be materialized into modelMessages so the model still sees it. After
    // backfillInbandToolResults, before flushToStore (so it lands in SQLite too).
    this.backfillCompactionSummaryMessage();
    // First load after a JSONL-only era: mirror what we replayed into the
    // SQLite store so future sidebar listings + searches see this session.
    // Cheap: persistSession is idempotent and runs inside one transaction.
    this.flushToStore();
    // Re-bootstrap the shared notebook for the (possibly new) cwd of the
    // loaded session. NotesService is stateful per cwd; the previous
    // instance is GC'd. Await BOTH inits like create() does so the caller
    // gets a quiescent engine (no detached writes racing a later teardown)
    // — startNotesService also restarts the global service, and the new
    // session object needs its globalNotes hydrated too.
    this.startNotesService();
    await this.notesInitPromise;
    await this.globalNotesInitPromise;
    // Re-hydrate the subtask DAG from the replayed state. Without this
    // a reloaded session would have its session.subtasks populated but
    // the store empty, so coordinator tool calls would mis-report
    // "unknown subtask".
    this.startSubtaskStore();
    await this.refreshModelCatalog();
  }

  /** Reconcile durable async task state after rollout replay. Called from
   * loadSession; the manager owns lifecycle classification and preserves
   * worktrees for explicit resume or inspection. */
  private async recoverStaleAsyncTasks(): Promise<void> {
    let persistedTasks: AsyncTaskRecord[] | undefined;
    if (this.sessionStore) {
      try {
        this.sessionStore.rebuildAsyncTaskProjectionFromEvents(this.session.id);
        persistedTasks = this.sessionStore.fetchAsyncTasks(this.session.id);
      } catch (error) {
        this.reportBackgroundError("store.async_task.reconcile", error, { sessionId: this.session.id });
      }
    }
    await this.subagent.recoverStaleOnLoad({ persistedTasks });
  }

  /** Detect a main turn the previous process never finished: either the last
   * non-system message is a user message with no assistant reply, or there
   * are tool calls still flagged `running` (the engine recorded the start
   * but the completion event never made it to disk). Mark the session
   * interrupted and reap the orphaned tool calls so the timeline stops
   * advertising in-flight work that died with the process.
   *
   * Distinct from recoverStaleAsyncTasks: that one is for SUBAGENT
   * lifecycles; this one is for the parent engine's own turn. Called from
   * loadSession right after the rollout replay; no-op on fresh sessions or
   * sessions that ended cleanly. */
  private recoverInterruptedTurn(): void {
    // Stale approval prompts first, and BEFORE the interrupted early-return:
    // a pending_approval record revived by replay is unanswerable no matter
    // how the previous process ended — the runtime pending map (and any
    // bubble resolver) died with it, so the dock would show a button whose
    // click no-ops and gets re-populated by the next snapshot forever. This
    // also covers sessions interrupt()ed before close: interrupt clears the
    // map but plain records keep pending_approval, and the session replays
    // with `interrupted: true`.
    const staleApprovals = this.session.toolCalls.filter((call) => call.status === "pending_approval");
    if (staleApprovals.length > 0) {
      const reapedAt = nowIso();
      for (const call of staleApprovals) {
        call.status = "failed";
        call.allowedDecisions = undefined;
        call.error =
          call.error ?? "Approval prompt did not survive the restart — re-run the command to be asked again.";
        call.completedAt = call.completedAt ?? reapedAt;
        this.record({ type: "tool_update", record: call });
      }
      pushTrace(this.session, "session.stale_approvals_reaped", {
        ids: staleApprovals.map((call) => call.id),
      });
    }
    if (this.session.interrupted) return;
    const runningCalls = this.session.toolCalls.filter((call) => call.status === "running");
    const lastConversational = [...this.session.messages]
      .reverse()
      .find((m) => m.role === "user" || m.role === "assistant");
    const userUnreplied = lastConversational?.role === "user";
    if (runningCalls.length === 0 && !userUnreplied) return;
    const recoveredAt = nowIso();
    for (const call of runningCalls) {
      call.status = "failed";
      call.error = call.error ?? "Tool call did not survive the previous process — observation was never recorded.";
      call.completedAt = call.completedAt ?? recoveredAt;
      this.record({ type: "tool_update", record: call });
    }
    this.session.interrupted = true;
    this.record({ type: "interrupted", at: recoveredAt });
    pushTrace(this.session, "session.interrupted", {
      recovered: true,
      reason: userUnreplied ? "no_assistant_response" : "running_tool_calls",
      orphanedToolCalls: runningCalls.map((c) => c.id),
    });
  }

  /** Model-driven auto-title side call. Body lives on TitleController
   * (title.ts); kept as a thin delegate — agent-host calls it after every
   * turn (frozen public API). */
  async generateAutoTitle(expectedProvisionalTitle?: string): Promise<string | null> {
    await this.refreshRuntimeConfig();
    return this.title.generateAutoTitle(expectedProvisionalTitle);
  }

  ensureTitleFromFirstUserMessage(pendingUserText?: string): string | null {
    return this.title.ensureTitleFromFirstUserMessage(pendingUserText);
  }

  /** Look up the descriptor for a model-issued tool call. If the model named a
   * deferred tool (native OR MCP) that wasn't in the current `tools` array,
   * auto-unmask it and push it onto `tools` so the rest of the turn can use
   * it. Mutates `tools` intentionally — the caller wants the descriptor
   * visible for the rest of this turn's batching pass too.
   *
   * Phase 2b: MCP runtime tools fall through the deferred path now — when the
   * model "just knows" an `mcp__server__tool` name and calls it directly
   * without going through search_tool, we look it up in the prefetched
   * profile-filtered pool and unmask. Eligibility is checked before unmasking:
   * a stale/guessed name must not bypass the profile allow-list, explicit deny,
   * subagent block-list, or host availability. */
  private resolveOrUnmaskDescriptor(
    call: ModelToolCall,
    tools: ToolDescriptor[],
    mcpRuntimePool: ReadonlyArray<ToolDescriptor>,
    profile: ReturnType<typeof resolveProfile>,
  ): ToolDescriptor | undefined {
    const direct = tools.find((tool) => tool.name === call.name);
    if (direct) return direct;
    const deferredFallback = deferredToolDescriptors.find((tool) => tool.name === call.name);
    const legacyFallback = toolDescriptors.find((tool) => tool.internal && tool.name === call.name);
    const mcpFallback = call.name.startsWith("mcp__")
      ? mcpRuntimePool.find((tool) => tool.name === call.name)
      : undefined;
    const fallback = deferredFallback ?? legacyFallback ?? mcpFallback;
    if (
      !fallback ||
      profile.toolPermissions[call.name] === "deny" ||
      !matchesToolAllowList(profile, fallback) ||
      blockedToolsForSession(this.session).has(call.name) ||
      !isToolAvailableToHost(call.name, this.hostBridge)
    ) {
      return undefined;
    }
    if (deferredFallback) {
      this.unmaskDeferredTool(call.name);
      tools.push(deferredFallback);
      return deferredFallback;
    }
    // Internal descriptors are compatibility-only aliases: never advertise
    // them in a provider tools array or deferred catalog, but still accept a
    // stale model call / persisted rollout that uses the old name.
    if (legacyFallback) return legacyFallback;
    if (mcpFallback) {
      this.unmaskDeferredTool(call.name);
      tools.push(mcpFallback);
      return mcpFallback;
    }
    return undefined;
  }

  /** Build the initial running ToolCallRecord for a model-issued call. Used by
   * both the leading-call path and the concurrent-batch peel-off in continueLoop. */
  private buildPendingToolCallRecord(call: ModelToolCall, descriptor: ToolDescriptor): ToolCallRecord {
    const mcpTarget =
      typeof descriptor.mcpServer === "string" && typeof descriptor.mcpTool === "string"
        ? { mcpServer: descriptor.mcpServer, mcpTool: descriptor.mcpTool }
        : {};
    return {
      id: call.id,
      name: call.name,
      input: call.input,
      summary: call.summary,
      permission: descriptor.permission,
      ...mcpTarget,
      status: "running",
      createdAt: nowIso(),
    };
  }

  /** Apply changed disk settings at request/action boundaries. Unchanged
   * settings never overwrite explicit construction or per-session choices. */
  async refreshRuntimeConfig(): Promise<void> {
    await this.refreshModelCatalog();
    let next: ReinaConfig | null;
    try {
      next = await readRuntimeConfig(this.session.cwd);
    } catch (error) {
      this.reportBackgroundError("settings.refresh", error);
      return;
    }
    if (!next) return;
    const previous = this.runtimeConfigSnapshot;
    this.runtimeConfigSnapshot = next;
    if (!previous) return;
    const changed = (key: keyof ReinaConfig) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]);
    if (changed("hooks")) this.hooksConfig = next.hooks;
    if (changed("toolLoop")) this.toolLoopConfig = next.toolLoop;
    if (changed("compactionModel")) this.compactionModel = next.compactionModel;
    if (changed("selfEvolve")) this.selfEvolveConfig = next.selfEvolve;
    if (changed("memory")) this.memoryDreamConfig = next.memory;
    if (changed("autopilot")) this.autopilotConfig = next.autopilot;
    if (changed("goal") || (changed("autopilot") && !next.goal)) {
      this.goalConfig = next.goal ?? (next.autopilot?.verify ? { verify: next.autopilot.verify } : undefined);
      this.goalRuntime.updateConfig(this.goalConfig);
    }
    if (previous.subagent?.forkEnabled !== next.subagent?.forkEnabled) {
      this.forkEnabledFlag = next.subagent?.forkEnabled !== false;
    }
    if (JSON.stringify(previous.subagent?.secondaryModel) !== JSON.stringify(next.subagent?.secondaryModel)) {
      this.subagentSecondaryModel = next.subagent?.secondaryModel;
    }
    if (changed("titleModel")) this.title.updateConfig({ titleModel: next.titleModel });
    if (changed("autoTitle")) this.title.updateConfig({ autoTitle: next.autoTitle });
    if (changed("permissionMode")) this.setPermissionMode(next.permissionMode ?? "default");
  }

  private async refreshModelCatalog(): Promise<void> {
    try {
      const model = await this.runtimeModelCatalog.resolve(this.session.cwd, this.session.model);
      if (model) this.updateConfig({ model });
    } catch (error) {
      this.reportBackgroundError("settings.models", error);
    }
  }

  private async continueLoop(): Promise<void> {
    const contextTurnId = createId("turn");
    const initialProfile = resolveProfile(this.session.agent);
    const budget = new ToolLoopBudget({
      baseSteps: initialProfile.maxSteps ?? 48,
      hardMaxSteps: toolLoopHardMax(initialProfile.maxSteps ?? 48, this.toolLoopConfig?.hardMaxSteps),
      stagnationLimit: this.toolLoopConfig?.stagnationLimit,
      repeatedActionLimit: this.toolLoopConfig?.repeatedActionLimit,
      consecutiveErrorLimit: this.toolLoopConfig?.consecutiveErrorLimit,
    });
    let autoRepairUsed = false;
    // Dead turns (reasoning-only or fully empty) get up to two structural
    // re-prompts (the second with firmer grounding — Codex-tuned models
    // sometimes stall waiting for an approval flow that doesn't exist here)
    // before we give up and surface the notice.
    const reasoningOnlyRepairLimit = 2;
    let reasoningOnlyRepairAttempts = 0;
    let loopRepairReminder: string | undefined;
    // One-shot per turn: a 401 triggers a single subscription-token refresh +
    // retry; if that still 401s we surface the error instead of looping.
    let subscriptionRefreshUsed = false;
    const contextOverflowRecoveryUsed = new Set<"observations" | "compaction">();
    // Bounded retries for a context-overflow finish_reason that arrives as a
    // 200-stream stop (not a thrown error) — trim/compact + retry. Each
    // completed turn clears `contextOverflowRecoveryUsed`, so this counter is
    // the real loop bound when compaction can't free enough room.
    const contextOverflowFinishLimit = 2;
    let contextOverflowFinishRetries = 0;
    continueLoop: while (true) {
      if (this.session.interrupted) return;
      await this.refreshRuntimeConfig();
      await this.turnContext.refreshContext();
      await this.turnContext.injectStaleReadNotice({ skillsOnly: true });
      if (this.session.interrupted) return;
      const profile = resolveProfile(this.session.agent);
      budget.updateConfig({
        baseSteps: profile.maxSteps ?? 48,
        hardMaxSteps: toolLoopHardMax(profile.maxSteps ?? 48, this.toolLoopConfig?.hardMaxSteps),
        stagnationLimit: this.toolLoopConfig?.stagnationLimit,
        repeatedActionLimit: this.toolLoopConfig?.repeatedActionLimit,
        consecutiveErrorLimit: this.toolLoopConfig?.consecutiveErrorLimit,
      });
      if (!budget.canContinue()) break;
      // Pick up any steers that arrived during the previous iteration —
      // both those from the previous tool execution AND those from the
      // previous model stream that planned tools (codex-aligned: the planned
      // tools run first, then the steer drains here, after their results have
      // been appended, so it lands in the right transcript order). The no-tool
      // path still drains inline below, so a steer after a final text response
      // becomes the next user turn directly.
      this.drainPendingSteers();
      await this.taskCompletions.drain();
      if (this.session.interrupted) return;
      // Prefetch the profile-filtered MCP runtime pool ONCE per loop
      // iteration and thread it through resolveTools / hidden-tools
      // reminder / measureModelRequest / unwrap / auto-unmask. The pool is
      // cached per-cwd by mcp.json hash (mcp-runtime.ts), so repeated calls
      // within a turn are essentially free, but threading the same instance
      // keeps every request surface and direct-call fallback consistent.
      const mcpRuntimePool = await loadMcpRuntimeTools(this.session.cwd)
        .then((runtimeTools) => this.filterPermittedMcpRuntimePool(runtimeTools, profile))
        .catch(() => [] as ToolDescriptor[]);
      this.contextPreviewMcpPool = mcpRuntimePool;
      await this.applyMcpResidencyPolicy(mcpRuntimePool);
      const tools = await this.resolveTools(mcpRuntimePool);
      // Request-aware context preflight before issuing the model call. Runs on
      // EVERY iteration — including follow-ups that carry pending tool results,
      // goal continuations, and recovery retries — so a large observation can't
      // push the next request past the window the way the old
      // `pendingObservations.length === 0` guard silently allowed.
      await this.preflightContext();
      const pendingObservations = this.toolOutput.modelObservations();
      // Bound total inline-media bytes per request so accumulated image/PDF
      // base64 can't push us past the provider's hard size ceiling (413
      // request_too_large). The current turn's pending media is charged first
      // (the model needs it NOW and is never evicted); the rest of the budget
      // goes to the most recent history media, older blobs fall back to a
      // re-read pointer. Non-destructive: durable history keeps the originals.
      const pendingAttachmentBytes = pendingObservations.reduce(
        (sum, observation) => sum + (observation.attachments ?? []).reduce((b, att) => b + att.dataBase64.length, 0),
        0,
      );
      const historyBudget = Math.max(0, MAX_INFLIGHT_ATTACHMENT_BYTES - pendingAttachmentBytes);
      const modelMessages = capInflightAttachmentBytes(this.modelMessages(), historyBudget);
      const systemPrompt = this.systemPrompt();
      const effectiveModel = { ...this.session.model, ...profile.model, ...this.session.modelOverride };
      const { hiddenToolsReminder, materializesContextState, contextStateUpdate, systemReminders } =
        this.requestContextReminders(modelMessages, tools, mcpRuntimePool, effectiveModel, loopRepairReminder);
      loopRepairReminder = undefined;
      const requestBreakdown = this.measureModelRequest(
        systemPrompt,
        modelMessages,
        pendingObservations,
        tools,
        effectiveModel,
        mcpRuntimePool,
        systemReminders,
        hiddenToolsReminder && contextStateUpdate.reminders.includes(hiddenToolsReminder) ? hiddenToolsReminder : "",
      );
      const formattedSystemReminder = formatSystemReminders(systemReminders);
      const pendingContextMessage =
        materializesContextState && formattedSystemReminder
          ? {
              ...message("user", formattedSystemReminder),
              ephemeral: true,
              contextState: {
                version: CONTEXT_STATE_VERSION,
                sections: contextStateUpdate.snapshot,
              },
            }
          : undefined;
      const requestSystemReminders = systemReminders.length > 0 ? systemReminders : undefined;
      // Some OpenAI/Anthropic-compatible bridges replay prior tool-loop text
      // or reasoning at the start of the next model call. Strip that replay
      // live and from the saved assistant message.
      const priorAssistantTextBlocks = currentTurnAssistantBlocks(this.session.messages, "content");
      const priorReasoningBlocks = currentTurnAssistantBlocks(this.session.messages, "reasoning");
      let roundAssistantText = "";
      let emittedAssistantText = "";
      let roundReasoning = "";
      let emittedReasoning = "";
      const onModelEvent = (event: ModelStreamEvent): void => {
        if (event.type === "text-delta" && priorAssistantTextBlocks.length > 0) {
          roundAssistantText += event.text;
          const result = stripReplayPrefix(roundAssistantText, priorAssistantTextBlocks);
          let cleanRound: string | null = null;
          if (result.kind === "matched") cleanRound = result.tail;
          else if (result.kind === "mismatch") cleanRound = roundAssistantText;
          if (cleanRound !== null && cleanRound.length > emittedAssistantText.length) {
            const nextEmit = cleanRound.slice(emittedAssistantText.length);
            emittedAssistantText = cleanRound;
            this.emitStream({ type: "text-delta", text: nextEmit });
          }
          return;
        }
        if (event.type === "reasoning-delta" && priorReasoningBlocks.length > 0) {
          roundReasoning += event.text;
          const result = stripReplayPrefix(roundReasoning, priorReasoningBlocks);
          let cleanRound: string | null = null;
          if (result.kind === "matched") cleanRound = result.tail;
          else if (result.kind === "mismatch") cleanRound = roundReasoning;
          if (cleanRound !== null && cleanRound.length > emittedReasoning.length) {
            const nextEmit = cleanRound.slice(emittedReasoning.length);
            emittedReasoning = cleanRound;
            this.emitStream({ type: "reasoning-delta", text: nextEmit });
          }
          return;
        }
        this.emitStream(event);
      };
      // Resilient model call. A transient API failure (provider overload, 5xx,
      // 429, a stream that drops after the provider already exhausted its own
      // connect + mid-stream retries) must NOT silently end the turn — for a
      // subagent that path produces a task that "completes" with the literal
      // text `Model request failed: ...` as its result, and for the top-level
      // agent it ends the turn with an error message. Instead we re-issue the
      // SAME request (messages unchanged — nothing was committed this round)
      // with exponential backoff until it succeeds or the retry budget is
      // spent. Non-retryable errors (auth / quota / bad request) and user
      // interrupts break out immediately — re-issuing those would just fail or
      // abort again. This is the OUTER backstop on top of the provider's own
      // retries (see driveStreamingTurn / SDK maxRetries in @reina/providers).
      let turn: Awaited<ReturnType<typeof nextModelTurnStream>> | undefined;
      let contextAttempt = 0;
      const maxTurnRetries = turnMaxRetries();
      let turnAttempt = 0;
      for (;;) {
        // Reset per-attempt accumulators so a retry's replay-stripping starts
        // clean — the failed attempt's partial is discarded via stream-reset.
        roundAssistantText = "";
        emittedAssistantText = "";
        roundReasoning = "";
        emittedReasoning = "";
        const modelRequest: ModelRequest = {
          messages: modelMessages, observations: pendingObservations, tools, systemPrompt,
          providerState: this.session.providerState, sessionId: this.session.id,
          systemReminders: requestSystemReminders,
        };
        const contextCapture = this.beginContextRequest(modelRequest, requestBreakdown, contextTurnId, ++contextAttempt);
        try {
          turn = await nextModelTurnStream(
            effectiveModel,
            modelRequest,
            onModelEvent,
            this.abortController.signal,
          );
          this.finishContextRequest(contextCapture, this.session.interrupted ? "cancelled" : "completed", turn.usage);
          break;
        } catch (error) {
          const inspectionError = effectiveModel.apiKey
            ? errorMessage(error).split(effectiveModel.apiKey).join("[redacted]")
            : errorMessage(error);
          this.finishContextRequest(contextCapture, this.session.interrupted ? "cancelled" : "failed", undefined, inspectionError);
          // A user interrupt / session teardown aborts the in-flight request
          // via the signal above. interrupt() already records the
          // interruption, so swallow the abort instead of retrying or
          // surfacing a "failed" message.
          if (this.session.interrupted) {
            turn = undefined;
            break;
          }
          const failureText = errorMessage(error);
          if (isContextWindowError(error)) {
            const recovered = await this.recoverFromContextOverflow(failureText, contextOverflowRecoveryUsed);
            if (recovered) {
              this.emitStream({ type: "stream-reset" });
              continue continueLoop;
            }
          } else if (
            !subscriptionRefreshUsed &&
            isAuthError(error) &&
            effectiveModel.subscriptionId &&
            this.hostBridge
          ) {
            // A subscription (OAuth) access token was rejected mid-session — the
            // short-lived token expired between turns. Ask main to mint a fresh
            // one from the stored refresh token and re-issue the SAME request
            // once. The refresh token never leaves main; we only get back a new
            // access token (+ account id).
            subscriptionRefreshUsed = true;
            const refreshed = await this.refreshSubscriptionToken(effectiveModel.subscriptionId);
            if (refreshed) {
              effectiveModel.apiKey = refreshed.access;
              if (refreshed.accountId) effectiveModel.accountId = refreshed.accountId;
              // Carry the fresh token onto the session model so later turns reuse
              // it instead of 401-ing again.
              this.session.model = {
                ...this.session.model,
                apiKey: refreshed.access,
                ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
              };
              pushTrace(this.session, "model.retry", { reason: "subscription_token_refresh" });
              this.emitStream({ type: "stream-reset" });
              continue;
            }
            // Refresh unavailable/failed (revoked refresh token) — surface a
            // clear reconnect hint instead of a bare 401.
            this.appendMessage(
              message(
                "assistant",
                `Model request failed: the subscription access token was rejected and could not be refreshed — reconnect this account in Settings → 订阅账号. (${failureText})`,
              ),
            );
            pushTrace(this.session, "message.created", { error: failureText, subscriptionRefreshFailed: true });
            turn = undefined;
            break;
          } else if (turnAttempt < maxTurnRetries && isRetryableStreamError(error)) {
            turnAttempt += 1;
            const delayMs = turnRetryBackoffMs(turnAttempt);
            pushTrace(this.session, "model.retry", {
              attempt: turnAttempt,
              maxRetries: maxTurnRetries,
              delayMs,
              error: failureText,
            });
            // Tell the renderer to drop whatever partial the failed attempt
            // streamed, then back off before re-issuing the same request.
            this.emitStream({ type: "stream-reset" });
            await this.backoffSleep(delayMs);
            if (this.session.interrupted) {
              turn = undefined;
              break;
            }
            continue;
          }
          // Non-retryable, or the retry budget is spent: surface and end.
          const suffix = turnAttempt > 0 ? ` after ${turnAttempt} ${turnAttempt === 1 ? "retry" : "retries"}` : "";
          this.appendMessage(message("assistant", `Model request failed${suffix}: ${failureText}`));
          pushTrace(this.session, "message.created", { error: failureText, retries: turnAttempt });
          turn = undefined;
          break;
        }
      }
      if (!turn) return;
      contextOverflowRecoveryUsed.clear();
      this.accumulateUsage(turn.usage, requestBreakdown);
      this.diagnoseCachePrefix(turn.usage, systemPrompt, tools);
      this.trackCacheWaste(turn.usage);
      // Materialize the round just consumed natively into the durable transcript
      // (ephemeral user messages) BEFORE clearing — from here it is normal
      // history that compaction owns. See materializePendingToolResults.
      this.materializePendingToolResults();
      if (pendingContextMessage) {
        this.appendMessage(pendingContextMessage);
        // A mode can be turned off while this tool loop is still active. Its
        // context-state diff then delivers the exit reminder here, before the
        // next runTurn has a chance to drain the fallback queue. Consume only
        // reminders confirmed by a successful model response so retries cannot
        // lose the event.
        if (this.pendingModeExitReminders.length > 0) {
          const deliveredReminders = new Set(systemReminders);
          this.pendingModeExitReminders = this.pendingModeExitReminders.filter(
            (reminder) => !deliveredReminders.has(reminder),
          );
        }
        // One-shot directives are now durable model history. Keeping their
        // source array populated would append the same event on every tool-loop
        // iteration even though the model already sees the consumed message.
        this.pendingTurnReminders = [];
      }
      this.pendingObservations = [];
      let assistantText = turn.content ?? "";
      if (assistantText) {
        const result = stripReplayPrefix(assistantText, priorAssistantTextBlocks);
        if (result.kind === "matched") assistantText = result.tail;
        else if (result.kind === "partial") assistantText = "";
      }
      if (turn.truncated) {
        // The model stopped at its output-token cap. Like Codex/Claude we do
        // NOT auto-continue; instead surface it so the cut-off isn't silent.
        // Emit live so the streaming view shows it, and fold it into the saved
        // message so it survives reload.
        const notice = `${assistantText ? "\n\n" : ""}⚠️ Output truncated: the model hit its output-token limit. Raise this model's maxOutputTokens for longer replies.`;
        this.emitStream({ type: "text-delta", text: notice });
        assistantText += notice;
      }
      let storeReasoning: string | undefined;
      // A reasoning-only dead turn (no answer + no tool call, normal stop) gets
      // the notice appended as content below, which would otherwise make its
      // reasoningTrace look replayable. Track it so we keep the trace for the
      // Thoughts UI but never seed cross-turn replay from a dead-end thought.
      let reasoningOnlyDeadTurn = false;
      if (turn.reasoning) {
        const result = stripReplayPrefix(turn.reasoning, priorReasoningBlocks);
        if (result.kind === "matched") storeReasoning = result.tail || undefined;
        else if (result.kind === "mismatch") storeReasoning = turn.reasoning;
        // "partial" → leave undefined; the round added no clean new reasoning.
      }
      // Surface abnormal/early stream terminations so a moderated or dropped
      // response isn't mistaken for the agent finishing. `truncated`
      // (output-token cap) is handled above; here we catch `content_filter` and
      // other abnormal finish reasons, plus the fully-empty turn — all of which
      // otherwise end the turn silently, leaving the user with a bare Thoughts
      // disclosure and no explanation.
      if (!turn.truncated && turn.toolCalls.length === 0) {
        let reason: string | undefined;
        if (isAbnormalStop(turn.stopReason)) {
          // A context-window-overflow finish_reason. Some OpenAI-compatible
          // relays report overflow as a 200-stream finish_reason instead of
          // throwing, so `isContextWindowError` (which only inspects thrown
          // errors) never routes it to recovery. Run the SAME trim/compact
          // recovery and retry — common in Team mode, where the coordinator
          // fans in many subagent results into one window. Bounded so a window
          // that can't be compacted below the limit surfaces the notice below
          // instead of looping.
          if (isContextOverflowStop(turn.stopReason) && contextOverflowFinishRetries < contextOverflowFinishLimit) {
            contextOverflowFinishRetries += 1;
            const recovered = await this.recoverFromContextOverflow(
              `finish_reason: ${turn.stopReason}`,
              contextOverflowRecoveryUsed,
            );
            if (recovered) {
              this.emitStream({ type: "stream-reset" });
              continue continueLoop;
            }
          }
          reason = isContextOverflowStop(turn.stopReason)
            ? `The model provider ended this response early because the request exceeded the model's context window (finish_reason: ${turn.stopReason}) and automatic compaction could not free enough room. Start a new session or run /compact, then retry.`
            : `The model provider ended this response early (finish_reason: ${turn.stopReason}) — the stream was terminated before completion, commonly output-side content moderation. No tool calls were returned.`;
        } else if (!assistantText) {
          // Dead turn: no answer and no tool call, on a normal stop. Two
          // flavors: reasoning-only (a thinking block but nothing else —
          // DeepSeek via the Anthropic-compat path, codex-tuned models) and
          // fully empty (codex models whose short internal reasoning yields
          // no summary text surface this way). Both are structurally
          // incomplete — re-prompt off that structural signal (never off the
          // prose), mirroring how production agents recover from an
          // incomplete stream instead of ending on a bare Thoughts
          // disclosure. Bounded: if every retry is still dead we fall through
          // to the notice below rather than loop.
          if (reasoningOnlyRepairAttempts < reasoningOnlyRepairLimit) {
            reasoningOnlyRepairAttempts += 1;
            loopRepairReminder =
              "Your previous response contained no user-visible answer and no tool call. " +
              "Continue the same request now: call the next tool you need, or write the final answer. Do not reply with reasoning alone." +
              (reasoningOnlyRepairAttempts > 1
                ? " There is no approval step, plan mode, or commentary channel in this environment — tool calls execute directly and immediately. Act now."
                : "");
            this.emitStream({ type: "stream-reset" });
            pushTrace(this.session, "model.retry", {
              reason: storeReasoning ? "reasoning_only" : "empty_response",
              attempt: reasoningOnlyRepairAttempts,
              stopReason: turn.stopReason ?? null,
            });
            continue;
          }
          if (storeReasoning) {
            reason = "The model returned reasoning only, with no user-visible response and no tool calls.";
            reasoningOnlyDeadTurn = true;
          } else {
            reason = `The model returned an empty response${turn.stopReason ? ` (finish_reason: ${turn.stopReason})` : ""} — no text, reasoning, or tool calls.`;
          }
        }
        if (reason) {
          const notice = `${assistantText ? "\n\n" : ""}⚠️ ${reason}`;
          this.emitStream({ type: "text-delta", text: notice });
          assistantText += notice;
        }
      }
      if (assistantText || storeReasoning || turn.reasoningTrace) {
        // Capture reasoning even when the model only emitted thinking before
        // a tool call (no visible text). The renderer hangs the Thoughts
        // disclosure off any assistant message with a reasoning field; the
        // structured `reasoningTrace` rides along so later turns can replay the
        // signed/encrypted blocks back into context.
        const assistantMessage = message("assistant", assistantText);
        if (storeReasoning) assistantMessage.reasoning = storeReasoning;
        // Tag this round's finish reason + per-request token usage onto the
        // message so the renderer can show them read-only in the assistant
        // right-click menu ("Turn 结束原因" / "用量"). Per-request, not a session
        // running total — distinct from session.usage.
        if (turn.stopReason) assistantMessage.stopReason = turn.stopReason;
        if (turn.usage) {
          assistantMessage.tokenUsage = {
            inputTokens: turn.usage.inputTokens ?? 0,
            outputTokens: turn.usage.outputTokens ?? 0,
            ...(turn.usage.cachedInputTokens ? { cachedInputTokens: turn.usage.cachedInputTokens } : {}),
            ...(turn.usage.reasoningTokens ? { reasoningTokens: turn.usage.reasoningTokens } : {}),
            ...(typeof turn.usage.totalTokens === "number" && turn.usage.totalTokens > 0
              ? { totalTokens: Math.floor(turn.usage.totalTokens) }
              : {}),
          };
        }
        // Keep the trace for display, but a reasoning-only dead turn must not
        // seed cross-turn replay: re-feeding a dead-end thinking block invites
        // the model to narrate-then-stop again. Mirrors codex/pi, which drop
        // such turns from replayed history (provider replay reads reasoningTrace,
        // the Thoughts UI reads reasoning — they are independent fields).
        if (turn.reasoningTrace && !reasoningOnlyDeadTurn) assistantMessage.reasoningTrace = turn.reasoningTrace;
        this.appendMessage(assistantMessage);
        pushTrace(this.session, "message.created", { message: assistantMessage });
      }
      // Steer ordering (codex-aligned): if the model planned tool calls, let
      // them execute and pick the steer up at the next iteration boundary
      // (top of the loop), so the steer's user message lands in the transcript
      // AFTER the tool results — the same path a steer that arrives during
      // tool execution takes. We deliberately do NOT discard the planned calls
      // here: codex runs the in-flight tool batch first, then steers on the
      // following turn, rather than dropping work the model already committed
      // to. Only the no-tool path drains inline: a steer after a final text
      // response has no pending tool output to order against, so it becomes
      // the next user turn immediately (re-run the loop instead of returning).
      if (turn.toolCalls.length === 0) {
        const steeredAfterStream = this.drainPendingSteers();
        this.commitProviderState(turn.providerState);
        if (steeredAfterStream || this.taskCompletions.hasPending()) continue;
        return;
      }

      this.commitProviderState(turn.providerState);

      const executedRecords: ToolCallRecord[] = [];
      // Same-batch dedup ledger (kimi tool-dedup's same-step layer): an
      // identical (name, canonical-args) call issued TWICE in one assistant
      // response is always redundant — executing it again doubles cost for
      // reads and doubles side effects for writes. The first occurrence
      // registers here; later twins short-circuit to a pointer observation
      // instead of re-executing. Keyed per batch — cross-step repeats stay
      // the loop-budget/storm-breaker's job.
      const batchSeen = new Map<string, ToolCallRecord>();
      for (let i = 0; i < turn.toolCalls.length; i++) {
        // A user interrupt can land mid-batch, while a prior tool in this same
        // round is awaiting. interrupt() eagerly swaps in a fresh
        // AbortController, so every tool dispatched from here on reads a
        // NON-aborted signal and would run to completion despite the stop. The
        // loop-top guard (line ~2270) only fires between continueLoop
        // iterations, not within a single tool batch — so re-check here before
        // dispatching each remaining call. Mirrors that guard's `return`.
        if (this.session.interrupted) return;
        const call = turn.toolCalls[i]!;
        // Auto-unmask deferred tools the model named directly without going
        // through `search_tool` first — keeps cold-start prompts small without
        // forcing a mandatory search_tool round-trip on every model that
        // "just knows" the name from training data. MCP runtime tools unmask
        // the same way via the prefetched mcpRuntimePool.
        const descriptor = this.resolveOrUnmaskDescriptor(call, tools, mcpRuntimePool, profile);
        if (!descriptor || profile.toolPermissions[call.name] === "deny") {
          this.pendingObservations.push({
            callId: call.id,
            name: call.name,
            error: "Tool blocked by active agent profile.",
          });
          continue;
        }
        // Background self-review runs in bypass mode (no user to approve) with
        // write_file/edit_file in its allow-list ONLY to author SKILL.md files.
        // Bypass skips approval, so without a path guard a prompt-injected review
        // (it reads a tail of the conversation, which may include untrusted
        // material) could silently overwrite product code. Confine its writes to
        // skill files — the only legitimate target; durable facts go through the
        // note tool, not write_file. See runSelfEvolveReview + the self-review
        // profile. Slash-agnostic, matches summarizeSelfReview's skill test.
        if (profile.name === "self-review" && (call.name === "write_file" || call.name === "edit_file")) {
          const p = (call.input as { path?: unknown }).path;
          if (typeof p !== "string" || !/(^|[\\/])skills[\\/]/.test(p)) {
            this.pendingObservations.push({
              callId: call.id,
              name: call.name,
              error:
                'self-review may only write skill files (a path under a `skills/` directory, e.g. .claude/skills/<name>/SKILL.md). Record durable facts with note(scope:"global") instead.',
            });
            continue;
          }
        }

        const record = this.buildPendingToolCallRecord(call, descriptor);

        // A `length`/`max_tokens` stop means every tool call in this message
        // may carry truncated arguments — and repairTruncatedJson (providers/
        // tool-compat.ts) closes cut-off JSON so they parse cleanly and look
        // valid. None are safe to execute (e.g. a write_file whose `content`
        // lost its tail would still write). Reject them all with a re-issue
        // observation and let the loop continue. Mirrors pi #6285.
        // `pause_turn` gets the same treatment (kimi-code turn-step): the
        // provider paused the generation server-side, so a trailing tool call
        // may be cut mid-arguments — never execute it, let the model re-issue.
        if (turn.truncated || turn.stopReason === "pause_turn") {
          const reason = turn.truncated
            ? `Tool call "${record.name}" was not executed: the response hit the output-token limit, so its arguments may be truncated even if they parsed cleanly. Re-issue the tool call with complete arguments.`
            : `Tool call "${record.name}" was not executed: the provider paused the response mid-generation (stop_reason: pause_turn), so its arguments may be incomplete. Re-issue the tool call with complete arguments.`;
          record.status = "rejected";
          record.error = reason;
          record.completedAt = nowIso();
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.rejected", {
            ...toolTraceData(record),
            suppressed: turn.truncated ? "truncated" : "pause_turn",
          });
          this.pendingObservations.push({ callId: record.id, name: record.name, error: reason });
          continue;
        }

        if (call.parseFailed) {
          const preview = parseFailedRawPreview(record.input);
          const reason = `Your tool_call arguments for ${record.name} could not be parsed as JSON (likely truncated mid-output or malformed). Re-emit the call with complete, valid JSON.${preview ? ` Original raw bytes: ${preview}` : ""}`;
          record.status = "rejected";
          record.error = reason;
          record.completedAt = nowIso();
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.rejected", { ...toolTraceData(record), suppressed: "parse_failed" });
          this.pendingObservations.push({ callId: record.id, name: record.name, error: reason });
          continue;
        }

        // Same-batch duplicate: mirror the original's outcome as a short
        // pointer (NOT the full output — the twin result sits right next to
        // it in the same request, so repeating the bytes only wastes tokens).
        // Registered before the storm/permission gates so a duplicate never
        // double-counts the storm window or re-prompts for approval.
        // Subagent dispatch tools are exempt: SubagentManager has its own
        // domain-aware same-brief dedup whose merged observation carries the
        // live task id (`<merged_with>`) — strictly more useful to the model
        // than this generic pointer.
        const dedupKey = BATCH_DEDUP_EXEMPT.has(record.name)
          ? undefined
          : `${record.name}:${serializeForCompare(record.input)}`;
        const dupOf = dedupKey ? batchSeen.get(dedupKey) : undefined;
        if (dupOf) {
          record.completedAt = nowIso();
          if (dupOf.error) {
            record.status = "failed";
            record.error = `Duplicate tool call: an identical ${record.name} call in this same response (${dupOf.id}) already ran and failed. See that call's error — the tool was not re-executed.`;
          } else {
            record.status = "completed";
            record.output = `Duplicate tool call: an identical ${record.name} call in this same response (${dupOf.id}) already ran. See that call's result — the tool was not re-executed. Avoid issuing identical duplicate calls.`;
          }
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.deduplicated", { ...toolTraceData(record), duplicateOf: dupOf.id });
          this.pendingObservations.push({
            callId: record.id,
            name: record.name,
            ...(record.error ? { error: record.error } : { output: record.output }),
          });
          executedRecords.push(record);
          continue;
        }
        if (dedupKey) batchSeen.set(dedupKey, record);

        const stormVerdict = this.stormBreaker.inspect(
          record.name,
          record.input,
          isMutatingPermission(record.permission),
        );
        if (stormVerdict.suppress) {
          const reason = stormVerdict.reason ?? "repeat-loop guard tripped";
          record.status = "rejected";
          record.error = reason;
          record.completedAt = nowIso();
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.rejected", { ...toolTraceData(record), suppressed: "storm" });
          this.pendingObservations.push({ callId: record.id, name: record.name, error: reason });
          executedRecords.push(record);
          continue;
        }

        const verdict = this.permissionVerdict(record);
        if (verdict.kind === "deny") {
          record.status = "rejected";
          record.error = verdict.reason;
          record.completedAt = nowIso();
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.rejected", toolTraceData(record));
          this.pendingObservations.push({ callId: record.id, name: record.name, error: verdict.reason });
          continue;
        }

        const ruleSkips = verdict.kind === "allow";
        const ruleForces = verdict.kind === "ask";
        const heuristicNeeds = this.needsApproval(profile, descriptor) && !this.canSkipApproval(record);
        const needsPrompt = ruleForces || (heuristicNeeds && !ruleSkips);

        if (needsPrompt) {
          record.preview = await previewTool(record.name, record.input, {
            cwd: this.session.cwd,
            signal: this.abortController.signal,
          }).catch((error: unknown) => `Preview failed: ${errorMessage(error)}`);
          record.status = "pending_approval";
          record.allowedDecisions = allowedDecisionsFor(descriptor.permission);

          // Bubble bridge: a child engine forwards its approval prompt up to
          // the parent's HITL flow instead of stashing it in its own pending
          // map — a child session has no approval UI, so a parked prompt
          // could never be answered (the silent approval gap). The child's
          // turn does NOT return — it awaits the parent's decision inline,
          // then executes the tool in the child's context (or pushes an
          // error observation on rejection) and continues. The mirror record
          // on the parent carries `bubbledFromTask` attribution; the child's
          // own record stays in the child's timeline for audit purposes.
          // Keyed on handler presence (the manager wires it on every child);
          // `permissionMode: "bubble"` remains fork-only strictness — it
          // controls WHAT prompts via needsApproval, not where prompts go.
          if (this.bubbleApprovalHandler) {
            this.session.toolCalls.push(record);
            this.record({ type: "tool_call", record });
            pushTrace(this.session, "tool.pending", { ...toolTraceData(record), bubbled: true });
            this.emitStream({
              type: "tool-progress",
              id: record.id,
              name: record.name,
              status: "running",
              message: "awaiting parent approval (bubble)",
              input: record.input,
            });
            const decision = await this.bubbleApprovalHandler(record);
            record.allowedDecisions = undefined;
            if (!decision.approved) {
              const reason = decision.options?.reason?.trim();
              record.status = "rejected";
              record.error = reason ? `Rejected by parent: ${reason}` : "Rejected by parent.";
              record.completedAt = nowIso();
              this.record({ type: "tool_update", record });
              pushTrace(this.session, "tool.rejected", toolTraceData(record));
              this.pendingObservations.push({ callId: record.id, name: record.name, error: record.error });
              executedRecords.push(record);
              continue;
            }
            if (decision.options?.updatedInput !== undefined) record.input = decision.options.updatedInput;
            // "Remember for this session" lands in the session registry —
            // which subagent children SHARE with the parent (spawnChildEngine
            // hands them the same array), so the rule also covers the parent
            // and every later sibling child in the same tree. cwd-tagged so a
            // worktree-isolated child (different tree, same relative paths)
            // still re-asks.
            if (decision.options?.remember === "session") {
              this.sessionApprovals.push({ ...sessionApprovalRule(record), cwd: this.session.cwd });
            }
            record.status = "running";
            this.record({ type: "tool_update", record });
            await this.executeRecord(record);
            executedRecords.push(record);
            continue;
          }

          this.pending.set(record.id, record);
          this.session.toolCalls.push(record);
          this.record({ type: "tool_call", record });
          pushTrace(this.session, "tool.pending", toolTraceData(record));
          return;
        }
        if (descriptor.concurrencySafe) {
          const batch: ToolCallRecord[] = [record];
          while (i + 1 < turn.toolCalls.length) {
            const nextCall = turn.toolCalls[i + 1]!;
            // Auto-unmask works in the peel-off too: a deferred / MCP tool
            // named directly inside a concurrent batch still resolves through
            // the shared helper instead of falling out via `tools.find`.
            const nextDescriptor = this.resolveOrUnmaskDescriptor(nextCall, tools, mcpRuntimePool, profile);
            if (
              !nextDescriptor ||
              !nextDescriptor.concurrencySafe ||
              this.needsApproval(profile, nextDescriptor) ||
              profile.toolPermissions[nextCall.name] === "deny" ||
              // parseFailed and storm are checked in the outer for-loop with
              // dedicated short-circuit branches that push a clear observation;
              // bail out of the peel-off so the next iteration takes that path
              // instead of silently executing a doomed/looping call here.
              nextCall.parseFailed
            ) {
              break;
            }
            const nextRecord = this.buildPendingToolCallRecord(nextCall, nextDescriptor);
            const nextVerdict = this.permissionVerdict(nextRecord);
            if (nextVerdict.kind === "deny" || nextVerdict.kind === "ask") break;
            // Storm inspect has side effects (adds to the window on non-
            // suppress), so we only call it ONCE per call: if it suppresses,
            // break and let the outer for-loop handle it; that next inspect
            // will see the same count and suppress again (no double-count
            // since suppressed calls don't push to the window).
            // A twin of a call already in this batch must NOT join the
            // Promise.all group (it would execute concurrently with its
            // original). Break and let the outer loop's dedup branch mirror it.
            const nextDedupKey = BATCH_DEDUP_EXEMPT.has(nextRecord.name)
              ? undefined
              : `${nextRecord.name}:${serializeForCompare(nextRecord.input)}`;
            if (nextDedupKey && batchSeen.has(nextDedupKey)) break;
            const nextStorm = this.stormBreaker.inspect(
              nextRecord.name,
              nextRecord.input,
              isMutatingPermission(nextRecord.permission),
            );
            if (nextStorm.suppress) break;
            if (nextDedupKey) batchSeen.set(nextDedupKey, nextRecord);
            batch.push(nextRecord);
            i++;
          }
          await Promise.all(batch.map((item) => this.executeRecord(item)));
          executedRecords.push(...batch);
          const pendingQuestionIds = new Set(
            batch.filter((item) => item.name === "question" && this.hasPendingQuestion(item.id)).map((item) => item.id),
          );
          if (pendingQuestionIds.size > 0) {
            // Drop the placeholder "Question pending: …" observations that
            // executeRecord pushed for each pending question. answerQuestion
            // will push the real "User answered: …" observation under the
            // same callId once the user responds; carrying the placeholder
            // forward would put two tool messages with the same tool_call_id
            // in the next replay and OpenAI rejects with 400 (duplicate tool
            // result).
            this.pendingObservations = this.pendingObservations.filter((obs) => !pendingQuestionIds.has(obs.callId));
            return;
          }
        } else {
          await this.executeRecord(record);
          executedRecords.push(record);
          if (record.name === "question" && this.hasPendingQuestion(record.id)) {
            this.pendingObservations = this.pendingObservations.filter((obs) => obs.callId !== record.id);
            return;
          }
        }
      }
      const stop = budget.recordTurn(executedRecords);
      if (stop) {
        if ((this.toolLoopConfig?.autoRepair ?? true) && !autoRepairUsed && canAutoRepairToolLoop(stop)) {
          this.autoRepairToolLoop(stop);
          // Give a different strategy a full recovery window without refunding
          // consumed turns or allowing the blocked call to execute again.
          budget.resetStagnation();
          autoRepairUsed = true;
          continue;
        }
        this.stopAtToolLoopLimit(stop);
        return;
      }
    }
    this.stopAtToolLoopLimit(budget.exhaustedStop());
  }

  private stopAtToolLoopLimit(stop: ToolLoopStop): void {
    const preservedObservations = this.pendingObservations.length;
    if (this.pendingObservations.length > 0) {
      this.appendMessage(message("user", formatToolLoopLimitObservations(stop, this.pendingObservations)));
      this.pendingObservations = [];
      this.session.providerState = undefined;
    }
    pushTrace(this.session, "loop.limit", { ...stop, preservedObservations });
    this.emitStream({ type: "loop-limit", ...stop, preservedObservations });
    // In autopilot mode, hitting the loop limit means the model couldn't make
    // forward progress this turn AND auto-repair (if applicable) already
    // failed. Without this, the autopilot driver would just spin up another
    // "Continue the audit loop" turn that immediately hits the same wall —
    // burning tokens and wall-clock budget while accomplishing nothing. Treat
    // it as an `exhausted` outcome on the agent's behalf so the loop exits
    // cleanly, mirroring what `declare_audit_done(status: "exhausted", ...)`
    // would have done if the model had self-diagnosed.
    const autopilot = this.session.autopilot;
    if (autopilot?.running) {
      autopilot.running = false;
      autopilot.doneStatus = "exhausted";
      autopilot.doneSummary = `Autopilot auto-exhausted at round ${autopilot.rounds}: ${stop.message} (reason=${stop.reason}, turns=${stop.turnCount}).`;
      autopilot.doneAt = nowIso();
      this.emitStream({ type: "autopilot-updated", state: { ...autopilot } });
      pushTrace(this.session, "session.config.updated", {
        autopilot: {
          done: true,
          status: "exhausted",
          autoExhausted: true,
          reason: stop.reason,
          message: stop.message,
          turnCount: stop.turnCount,
          rounds: autopilot.rounds,
        },
      });
    }
  }

  private autoRepairToolLoop(stop: RecoverableToolLoopStop): void {
    const preservedObservations = this.pendingObservations.length;
    this.appendMessage(message("user", formatToolLoopRepairPrompt(stop, this.pendingObservations)));
    this.pendingObservations = [];
    this.session.providerState = undefined;
    pushTrace(this.session, "loop.repair", { ...stop, preservedObservations });
    this.emitStream({
      type: "loop-repair",
      reason: stop.reason,
      message: stop.message,
      turnCount: stop.turnCount,
      maxSteps: stop.maxSteps,
      hardMaxSteps: stop.hardMaxSteps,
      preservedObservations,
    });
  }

  private needsApproval(profile: ReturnType<typeof resolveProfile>, descriptor: ToolDescriptor): boolean {
    if (this.session.permissionMode === "bypass") return false;
    // exit_plan_mode is the designated escape hatch from plan mode — gating
    // it on plan-mode approval would deadlock the model (it would need to be
    // approved before it can run, but the user's approval *is* the tool's
    // semantics). It's also harmless on its own: the side effect is a HITL
    // gate the user must still answer.
    if (descriptor.name === "exit_plan_mode") return false;
    if (this.session.permissionMode === "plan" && descriptor.permission !== "read") return true;
    if (this.session.permissionMode === "accept-edits" && descriptor.permission === "write") return false;
    return requiresApproval(profile, descriptor);
  }

  private canSkipApproval(record: ToolCallRecord): boolean {
    // cwd gate first: the registry is shared across the parent and its
    // subagent children, and exact-input rules can embed relative paths — a
    // rule vetted in one tree must not transfer to a worktree-isolated child.
    const matched = this.sessionApprovals.some(
      (rule) => (rule.cwd === undefined || rule.cwd === this.session.cwd) && matchesSessionApproval(rule, record),
    );
    if (matched) return true;
    return this.session.permissionMode !== "plan" && isReadOnlyShellCommand(record);
  }

  /**
   * Consult persistent permission rules from `~/.reina/permissions.json` and
   * `<workspace>/.reina/permissions.json`. Workspace rules win.
   *
   * - `allow` → auto-approve (skip prompt)
   * - `deny`  → block without prompting; observation carries the rule's reason
   * - `ask`   → force prompt even if heuristics would skip
   * - `pass`  → no opinion; fall back to other logic
   */
  private permissionVerdict(record: ToolCallRecord): PermissionVerdict {
    const rules = loadPermissions(this.session.cwd).rules;
    if (rules.length === 0) return { kind: "pass" };
    return evaluatePermission(rules, record);
  }

  private hasPendingQuestion(id: string): boolean {
    // Matches both the single-question shape (pq.id === id) and the batch
    // shape where the tool call's record.id is shared as groupId across
    // multiple synthetic pendingQuestion ids.
    return this.session.pendingQuestions.some(
      (question) => (question.id === id || question.groupId === id) && question.status === "pending",
    );
  }

  private async executeRecord(record: ToolCallRecord): Promise<void> {
    await this.refreshRuntimeConfig();
    const isNew = !this.session.toolCalls.some((call) => call.id === record.id);
    if (isNew) {
      this.session.toolCalls.push(record);
      this.record({ type: "tool_call", record });
    }
    this.emitStream({
      type: "tool-progress",
      id: record.id,
      name: record.name,
      status: "running",
      message: "executing",
      input: record.input,
    });
    const preHook = await runHooks(this.hooksConfig, "preToolUse", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      tool: { name: record.name, input: record.input },
    }).catch(() => ({}) as { block?: boolean; message?: string });
    if (preHook.block) {
      const observation: ToolObservation = {
        callId: record.id,
        name: record.name,
        error: preHook.message || "Blocked by preToolUse hook",
      };
      record.status = "rejected";
      record.error = observation.error;
      record.completedAt = nowIso();
      this.record({ type: "tool_update", record });
      pushTrace(this.session, "tool.rejected", toolTraceData(record));
      this.emitStream({
        type: "tool-progress",
        id: record.id,
        name: record.name,
        status: "failed",
        message: observation.error,
        input: record.input,
      });
      this.pendingObservations.push(observation);
      this.emitLiveContext();
      return;
    }
    // Hard loop-gate: when the immediately preceding calls are this exact
    // call (same tool + same input) and every one failed, refuse to execute
    // yet another identical attempt. Escalation ladder: 1st failure → plain
    // error; 2nd → repeated_failure banner (below); 3rd → synthesized error
    // here WITHOUT executing. Consecutive-only on purpose: any different
    // call or success in between resets the streak, so edit-then-retry
    // loops (fix code, rerun the same test command) are never blocked.
    const priorStreak = this.consecutiveIdenticalFailures(record);
    if (priorStreak >= LOOP_GATE_CONSECUTIVE_FAILURES) {
      const observation: ToolObservation = {
        callId: record.id,
        name: record.name,
        error: formatLoopGateBlocked(record, priorStreak),
      };
      record.status = "failed";
      record.error = observation.error;
      record.completedAt = nowIso();
      this.record({ type: "tool_update", record });
      pushTrace(this.session, "tool.failed", { ...toolTraceData(record), loopGate: true });
      this.emitStream({
        type: "tool-progress",
        id: record.id,
        name: record.name,
        status: "failed",
        message: observation.error,
        input: record.input,
      });
      this.pendingObservations.push(observation);
      this.emitLiveContext();
      return;
    }
    const observation: ToolObservation = await this.executeToolOrEngine(record).catch((error: unknown) => ({
      callId: record.id,
      name: record.name,
      error: errorMessage(error),
    }));
    observation.callId = record.id;
    if (observation.error) {
      // If the model is producing the same failing call (same tool + same
      // input) repeatedly, augment the observation with a hard-to-ignore
      // banner that explicitly names the loop. Without this, some models
      // re-emit the same call up to 5 or 6 times before changing strategy.
      const repeatCount = this.countRecentIdenticalFailures(record);
      if (repeatCount >= 1) {
        observation.error = formatRepeatedFailure(record, observation.error, repeatCount + 1);
      }
    }
    this.recordToolMetadata(observation);
    record.status = observation.error ? "failed" : "completed";
    record.output = observation.output;
    record.error = observation.error;
    record.completedAt = nowIso();
    this.stormBreaker.recordResult(record);
    // Persist every tool output to disk before recording, so the complete
    // result is always available to read back — both as an audit trail and for
    // the model to re-read on demand — independent of preview truncation. The
    // materialized in-context message shows a short excerpt; when it truncates,
    // materializePendingToolResults appends a read_file pointer to this file.
    // Skip only empty results.
    const fullOutput = observation.error ?? observation.output ?? "";
    if (fullOutput.length > 0) {
      await this.persistToolOutput(record, fullOutput);
    }
    this.record({ type: "tool_update", record });
    pushTrace(this.session, observation.error ? "tool.failed" : "tool.completed", toolTraceData(record));
    void runHooks(this.hooksConfig, "postToolUse", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      tool: { name: record.name, input: record.input },
      output: observation.output,
      error: observation.error,
    }).catch((error) => this.reportBackgroundError("hooks.postToolUse", error, { tool: record.name }));
    this.emitStream({
      type: "tool-progress",
      id: record.id,
      name: record.name,
      status: observation.error ? "failed" : "completed",
      message: observation.error,
      input: record.input,
      output: observation.output,
    });
    this.pendingObservations.push(observation);
    this.emitLiveContext();
  }

  /** Thin delegate to ToolOutputController.persistToolOutput (tool-output.ts).
   * Kept as a same-named private method so engine.test.ts internals casts
   * keep reaching it by name. */
  private async persistToolOutput(record: ToolCallRecord, text: string): Promise<void> {
    return this.toolOutput.persistToolOutput(record, text);
  }

  /** Thin delegate to the tool-dispatch registry (tool-dispatch.ts): blocked
   * defense-in-depth → registry lookup → fallback (MCP runtime / runTool).
   * Kept as a same-named private method so the executeRecord call site and
   * the engine.test.ts internals casts keep reaching it by name. */
  private async executeToolOrEngine(record: ToolCallRecord): Promise<ToolObservation> {
    return this.toolDispatch.run(record);
  }

  /** Count prior failed calls for the same (tool, input) pair within a
   * recency window. We hash the input as canonical JSON so order-stable
   * objects compare equal. Only looks back at the most recent N tool
   * calls to keep this O(N) and to ignore failures from way earlier in
   * the session that the model has already moved past. */
  /** Length of the streak of immediately-preceding tool calls that are this
   * exact call (same tool + canonical input) with status "failed". Any
   * different call, success, or rejection breaks the streak — only a
   * zero-progress repeat loop counts. Feeds the hard loop-gate in
   * executeRecord; the softer banner below uses a windowed count instead. */
  private consecutiveIdenticalFailures(record: ToolCallRecord): number {
    const targetKey = serializeForCompare(record.input);
    let streak = 0;
    for (let i = this.session.toolCalls.length - 1; i >= 0; i -= 1) {
      const prior = this.session.toolCalls[i]!;
      if (prior.id === record.id) continue;
      if (prior.name !== record.name || prior.status !== "failed" || serializeForCompare(prior.input) !== targetKey)
        break;
      streak += 1;
    }
    return streak;
  }

  private countRecentIdenticalFailures(record: ToolCallRecord): number {
    const lookback = 12;
    const targetKey = serializeForCompare(record.input);
    const start = Math.max(0, this.session.toolCalls.length - lookback);
    let count = 0;
    for (let i = this.session.toolCalls.length - 1; i >= start; i -= 1) {
      const prior = this.session.toolCalls[i]!;
      if (prior.id === record.id) continue;
      if (prior.name !== record.name) continue;
      if (prior.status !== "failed") continue;
      if (serializeForCompare(prior.input) !== targetKey) continue;
      count += 1;
    }
    return count;
  }

  private recordToolMetadata(observation: ToolObservation): void {
    const metadata = (
      observation as ToolObservation & {
        metadata?: { readFiles?: Array<{ path: string; mtimeMs: number }>; unmaskTools?: string[] };
      }
    ).metadata;
    if (!metadata) return;
    if (metadata.readFiles?.length) {
      this.session.readFileTimestamps ??= {};
      for (const file of metadata.readFiles) {
        const readAt = nowIso();
        this.session.readFileTimestamps[file.path] = file.mtimeMs;
        this.session.recentFiles = upsertRecentFile(this.session.recentFiles ?? [], {
          path: file.path,
          mtimeMs: file.mtimeMs,
          readAt,
        });
        this.record({ type: "read_file", path: file.path, mtimeMs: file.mtimeMs, readAt });
      }
    }
    if (metadata.unmaskTools?.length) {
      this.unmaskDeferredTool(...metadata.unmaskTools);
    }
  }

  /** Record one or more deferred tool names as discovered by this session
   * and emit a rollout event so the record persists across reload.
   * Subsequent requests include the discovered definitions, subject to the
   * current profile and runtime availability. Idempotent: a no-op if every
   * requested name is already recorded. Invoked by both
   * `search_tool` (via metadata.unmaskTools) and the direct-call fallback
   * in continueLoop (when the model invokes a deferred tool without
   * searching first). */
  private unmaskDeferredTool(...names: string[]): void {
    if (names.length === 0) return;
    const current = new Set(this.session.activeDeferredTools ?? []);
    let added = false;
    for (const name of names) {
      if (!current.has(name)) {
        current.add(name);
        added = true;
      }
    }
    if (!added) return;
    const next = [...current].sort();
    this.session.activeDeferredTools = next;
    this.record({ type: "active_deferred_tools", names: next });
  }

  /** Apply Reina's MCP residency policy: every enabled server NOT named in
   * `reina.json` → `mcp.deferredServers` gets its tools recorded in
   * `residentMcpToolNames` so they appear in the tools array from turn 1.
   * Servers in the deferred list stay hidden until search_tool or a direct
   * invocation discovers them (see resolveTools). Servers disabled in
   * mcp.json aren't in the pool at all so they're a no-op here.
   *
   * Failures are swallowed and logged as background errors — a malformed
   * reina.json or unreachable MCP server shouldn't crash session start.
   * The user just loses the residency promotion for this run. */
  private async applyMcpResidencyPolicy(runtimePool?: readonly ToolDescriptor[]): Promise<void> {
    try {
      const [policy, pool] = await Promise.all([
        loadMcpResidencyPolicy(this.session.cwd),
        runtimePool ?? loadMcpRuntimeTools(this.session.cwd),
      ]);
      const residentNames: string[] = [];
      for (const tool of pool) {
        // Match on the descriptor's raw server name, NOT a `split("__")[1]`
        // of the tool name — a server name can itself contain `__` (see
        // resolveMcpRuntimeToolName), and a blind first-segment split would
        // silently treat an explicitly deferred server as resident.
        if (tool.mcpServer && !policy.deferredServers.has(tool.mcpServer)) {
          residentNames.push(tool.name);
        }
      }
      this.residentMcpToolNames = new Set(residentNames);
    } catch (error) {
      this.reportBackgroundError("mcp.residency", error, { cwd: this.session.cwd });
    }
  }

  // ─── Subagent subsystem ────────────────────────────────────────────────
  //
  // The async/sync subagent lifecycle (runSync, startAsync, check, cancel,
  // update, list, gather, wait) plus the children Map, brief-retry guard,
  // dispatch reservations, watchdog/conclude phases and per-task stream
  // writer all live in `packages/core/src/subagent/manager.ts`. The engine
  // forwards tool dispatch to `this.subagent.*` and exposes a thin
  // SubagentHost adapter (createSubagentHost below) that gives the manager
  // the few engine capabilities it needs: child spawning, rollout writes,
  // stream emission, usage rollup, and onAsyncTaskComplete hook firing.
  //
  // The two methods kept here — spawnChildEngine and rollupChildUsage —
  // belong to the engine because they touch the parent session's
  // NotesService snapshot, skill/deferred-tool inheritance, and usage
  // accumulator. They're invoked by the manager via the host adapter.

  /** Build a fresh AgentEngine for a subagent. Shares hostBridge, takes a
   * cwd override (for worktree isolation), bumps subagentDepth by one, and
   * deep-copies skills+memory so the child can't mutate parent state. The
   * caller owns the child reference and is responsible for invoking its
   * cleanup (e.g. interrupt + worktree teardown). Every spawned child is a
   * leaf — depth is capped at 1 and the BLOCKED_FOR_SUBAGENT set strips
   * delegation/HITL/memory tools from its toolset. */
  private spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine {
    const child = new AgentEngine({
      cwd: input.cwd,
      agent: input.agent,
      permissionMode: this.session.permissionMode,
      model: this.session.model,
      hostBridge: this.hostBridge,
      hooks: this.hooksConfig,
      toolLoop: this.toolLoopConfig,
      compactionModel: this.compactionModel,
      goal: this.goalConfig,
      autopilot: this.autopilotConfig,
      memory: this.memoryDreamConfig,
      subagent: { forkEnabled: this.forkEnabledFlag, secondaryModel: this.subagentSecondaryModel },
      // In the constructor input (not assigned after) so the notes-service
      // boot is suppressed before it can start a detached init the promise
      // overwrites below would orphan.
      isSubagent: true,
      subagentDepth: (this.session.subagentDepth ?? 0) + 1,
    });
    // Share the parent's session-approval registry BY REFERENCE: the HITL
    // surface belongs to the parent session, so "remember for this session"
    // means the parent's session no matter which engine minted the rule —
    // a child's bubbled remember covers later siblings and the parent, and
    // the parent's own remembered approvals cover its children. Rules are
    // cwd-tagged (see canSkipApproval) so worktree children stay isolated.
    child.sessionApprovals = this.sessionApprovals;
    child.runtimeConfigSnapshot = this.runtimeConfigSnapshot;
    // Copy the parent's skill snapshot, then narrow to whatever the child
    // profile's `skills` allow-list permits. When the profile leaves it
    // unset, the full snapshot rides through unchanged.
    const childProfile = resolveProfile(input.agent);
    child.session.skills = filterSkillsByProfile(
      this.session.skills.map((skill) => ({ ...skill })),
      childProfile,
    );
    // Carry the parent's discovered-tools record into the child so allowed,
    // currently available definitions remain active without another search.
    // The compact capability index stays static; resolveTools still reapplies
    // the child profile, session blocks, host availability, and live MCP pool.
    // resume.ts intersects this copy against the parent's current set on rebuild.
    if (this.session.activeDeferredTools?.length) {
      child.session.activeDeferredTools = [...this.session.activeDeferredTools];
    }
    // Share the parent's NotesService instance so subagent writes land in
    // the same on-disk dossier and the parent's session.notes index is
    // updated via the shared listener. This is the cross-pollination
    // channel: a Scout can write n_042, a sibling Scout (or the next
    // parent turn) immediately sees it in list_notes.
    child.notesService = this.notesService;
    child.notesInitPromise = this.notesInitPromise;
    // Same for the global notebook — subagents read and write the shared
    // cross-project memory through the parent's instance.
    child.globalNotesService = this.globalNotesService;
    child.globalNotesInitPromise = this.globalNotesInitPromise;
    // Seed the subagent's session.notes snapshot from the parent's
    // current index so prompt injection at the child's first turn already
    // shows the existing dossier.
    child.session.notes = (this.session.notes ?? []).map((entry) => ({
      ...entry,
      tags: [...entry.tags],
      refs: [...entry.refs],
    }));
    child.session.globalNotes = (this.session.globalNotes ?? []).map((entry) => ({
      ...entry,
      tags: [...entry.tags],
      refs: [...entry.refs],
    }));
    return child;
  }

  /** Fold a settled child's token usage into the parent's running counter so
   * the UI's token tally reflects the true cost of a subagent-heavy turn.
   * Does not bump `turns` — the parent's own model turns are the authoritative
   * source for that counter (matching Hermes' rollup behavior). */
  private rollupChildUsage(child: AgentEngine): void {
    const u = child.session.usage;
    if (!u) return;
    if (!this.session.usage) {
      this.session.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, turns: 0 };
    }
    this.session.usage.inputTokens += u.inputTokens ?? 0;
    this.session.usage.outputTokens += u.outputTokens ?? 0;
    this.session.usage.cachedInputTokens += u.cachedInputTokens ?? 0;
    this.session.usage.cacheCreationInputTokens =
      (this.session.usage.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    this.session.usage.reasoningTokens += u.reasoningTokens ?? 0;
    this.session.usage.childInputTokens = (this.session.usage.childInputTokens ?? 0) + (u.inputTokens ?? 0);
    this.session.usage.childOutputTokens = (this.session.usage.childOutputTokens ?? 0) + (u.outputTokens ?? 0);
    this.session.usage.childCachedInputTokens =
      (this.session.usage.childCachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0);
    this.session.usage.childCacheCreationInputTokens =
      (this.session.usage.childCacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    this.session.usage.childReasoningTokens = (this.session.usage.childReasoningTokens ?? 0) + (u.reasoningTokens ?? 0);
    this.publishUsage();
  }

  /** Test back-compat: forward to the subagent manager's upsertAsyncTask.
   * Accessed via test-side casts through `unknown`. Production code should
   * call `this.subagent.upsertAsyncTask` directly. */
  private upsertAsyncTask(task: AsyncTaskRecord): void {
    this.subagent.upsertAsyncTask(task);
  }

  /** Test back-compat: expose the subagent children Map under the legacy
   * `asyncTaskChildren` name so existing tests that cast through `unknown`
   * keep working without modification. Production code should access
   * `this.subagent.children` directly. */
  private get asyncTaskChildren(): Map<string, AgentEngine> {
    return this.subagent.children;
  }

  /** Test back-compat: forward to manager. */
  private gatherAsyncTasks(record: ToolCallRecord): ToolObservation {
    return this.subagent.gather(record);
  }

  /** Test back-compat: forward to manager. */
  private async waitAsyncTasks(record: ToolCallRecord): Promise<ToolObservation> {
    return this.subagent.wait(record);
  }

  /** Test back-compat: forward to manager. */
  private async runChildWithWatchdog(
    child: AgentEngine,
    description: string,
    taskId?: string,
    options?: { timeoutMsOverride?: number },
  ): Promise<{ disposition: "completed" | "cancelled" | "timeout" | "stale"; durationMs: number; timeoutMs: number }> {
    return this.subagent.runChildWithWatchdog(child, description, taskId, options);
  }

  /** Test back-compat: expose the manager's brief-failure counter. */
  private get failedBriefCounts(): Map<string, number> {
    return this.subagent.failedBriefCounts;
  }

  /** Test back-compat: static re-export of the per-child timeout resolver
   * (was a `private static` on the engine before the subagent module split). */
  private static subagentTimeoutMs = subagentTimeoutMs;

  /** Deterministic manual compaction. Runs the exact `compactSessionContext`
   * machinery the auto-compactor uses — no model round-trip to "decide" to
   * compact. The user-driven `/compact` control op (via the host's
   * `compact_session`) calls it only when the session is idle. Automatic
   * compaction uses the same machinery at a loop boundary in `preflightContext`.
   * Returns the boundary, or undefined when there was nothing to compact. */
  async compactNow(reason: string): Promise<CompactBoundary | undefined> {
    await this.refreshRuntimeConfig();
    const boundary = await this.compactWithLifecycle("manual", reason);
    if (boundary) this.recordCompaction(boundary);
    return boundary;
  }

  /** Request-aware context preflight — runs before EVERY model request in the
   * tool loop (the first call of a user turn, follow-up calls carrying tool
   * results, goal continuations, recovery retries), not just at turn start.
   *
   * Sizes the *prospective* request: session history (provider-measured when
   * available, else estimated) PLUS the pending tool observations that will be
   * woven in but aren't in history yet. That observation term is the key
   * difference from a plain history check — after a large tool result the
   * provider's last total under-counts what we're about to send, which is the
   * classic way a long autonomous run walks into a context-too-long the
   * loop never saw coming.
   *
   * Ladder: compact history first (most reclaimable); if a single oversized
   * observation still pushes the request over the line, trim observations as
   * the last proactive lever. The reactive `recoverFromContextOverflow` stays
   * as the hard backstop for anything this estimate misses (e.g. provider-side
   * framing the o200k estimate omits). */
  private async preflightContext(): Promise<void> {
    // Pending approvals mean the loop is parked waiting on the user, not about
    // to issue a request — leave history and observations untouched.
    if (this.pending.size > 0) return;
    // Routine (lossless) budget first, so the compaction decision below sees
    // the post-spill observation sizes instead of compacting history to make
    // room for outputs that were about to be spilled to disk anyway.
    this.enforceTurnObservationBudget();
    const decision = shouldAutoCompactSession(this.session, estimateObservationTokens(this.pendingObservations));
    if (decision.shouldCompact) {
      const boundary = await this.compactWithLifecycle("auto", decision.reason);
      if (boundary) this.recordCompaction(boundary);
    }
    // After compaction the history is small, but a single oversized tool
    // observation can still exceed the window on its own — compacting history
    // can't offset it. Re-check the projected request directly (the
    // min-messages floor inside shouldAutoCompactSession would otherwise mask
    // this once history is tiny) and trim observations if they're still over.
    const observationTokens = estimateObservationTokens(this.pendingObservations);
    if (observationTokens > 0) {
      const { tokens } = sessionContextTokens(this.session);
      if (tokens + observationTokens >= autoCompactThreshold(this.session.model)) {
        this.trimPendingObservationsForContextOverflow();
      }
    }
  }

  private async compactWithLifecycle(
    compactType: "manual" | "auto",
    reason: string,
  ): Promise<CompactBoundary | undefined> {
    await this.refreshRuntimeConfig();
    let started = false;
    const contextEventId = createId("compact");
    // Fire-and-forget the preCompact lifecycle hook before any history is
    // folded. Non-blocking on purpose: a slow or failing hook must never stall
    // (or, for auto-compaction, veto) the reclaim that keeps the session under
    // the context window. The hook still sees compactType + reason to route on.
    void runHooks(this.hooksConfig, "preCompact", {
      sessionId: this.session.id,
      cwd: this.session.cwd,
      compactType,
      reason,
    }).catch((error) => this.reportBackgroundError("hooks.preCompact", error));
    // Cache-reuse fast path for the summary call: only when the summary runs on
    // the SAME model+provider the main agent caches against. A configured
    // `compactionModel` routes the summary to a different model whose cache the
    // main agent never warmed, so the reuse can't hit — leave it off then.
    // Gated to Anthropic Messages: it's the provider whose explicit
    // `cache_control` prefix this reuse is tuned for (openai-responses can be
    // added once its auto-prefix shaping is verified). Reusing the live
    // `[system + tools]` here lets the bulk of the compacted slice bill at
    // cache-read (~10%) instead of full price; the summary builder falls back to
    // the fenced no-tools path if the model defects to a tool call.
    const cacheReuseEligible = !this.compactionModel && this.session.model.provider === "anthropic-messages";
    const cacheReuse = cacheReuseEligible
      ? { systemPrompt: this.systemPrompt(), tools: await this.resolveTools() }
      : undefined;
    try {
      const boundary = await compactSessionContext(this.session, compactType, reason, {
        onStart: () => {
          started = true;
          this.recordContextCompaction({ id: contextEventId, createdAt: nowIso(), status: "started", reason });
          this.emitStream({ type: "context-compaction-started", compactType, reason });
        },
        onCompactedMessages: (compacted) => this.persistMemoryChunks(compacted),
        signal: this.abortController.signal,
        // Config `compactionModel` merged over the session model — same
        // contract as `titleModel` (partial override; apiKey/baseUrl ride
        // along when the summary model lives on a different provider).
        summaryModel: this.compactionModel
          ? modelConfigSchema.parse({ ...this.session.model, ...this.compactionModel })
          : undefined,
        cacheReuse,
      });
      if (boundary) {
        this.recordContextCompaction({ id: contextEventId, createdAt: nowIso(), status: "completed", reason, boundary });
        // The old provider total now describes a history that no longer exists.
        // Re-anchor the live footprint to the post-compaction estimate so the
        // ring drops immediately; the next response replaces it with a real total.
        this.lastContextBase = boundary.estimatedTokensAfter;
        // Reset the codex-style auto-compaction window. Replace the stale
        // provider peak with the post-compaction estimate, marked "estimate" so
        // nothing mistakes it for an authoritative total: sessionContextTokens
        // ignores non-provider sources and recomputes its own live estimate
        // (the "does not re-trigger on a stale peak" contract), while the
        // renderer can show the drop NOW — with the field merely deleted it
        // fell back to `lastTurn.totalTokens`, which predates the compaction,
        // so the ring sat at the old peak until the next response. The window
        // baseline is cleared so `updateUsage` re-seeds it from the next
        // provider total (the new stable-prefix size).
        if (this.session.usage) {
          this.session.usage.contextTokens = boundary.estimatedTokensAfter;
          this.session.usage.contextTokensSource = "estimate";
          delete this.session.usage.autoCompactBaseline;
        }
        this.emitLiveContext();
      }
      return boundary;
    } catch (error) {
      if (started) {
        this.recordContextCompaction({ id: contextEventId, createdAt: nowIso(), status: "failed", reason, error: errorMessage(error).slice(0, 2_000) });
        this.emitStream({
          type: "context-compaction-failed",
          compactType,
          reason,
          error: errorMessage(error),
        });
      }
      throw error;
    }
  }

  private async recoverFromContextOverflow(error: string, used: Set<"observations" | "compaction">): Promise<boolean> {
    if (!used.has("observations")) {
      used.add("observations");
      const trim = this.trimPendingObservationsForContextOverflow();
      if (trim.changed) {
        pushTrace(this.session, "model.context_overflow_recovery", {
          strategy: "trim_observations",
          observations: trim.count,
          beforeChars: trim.beforeChars,
          afterChars: trim.afterChars,
          error,
        });
        return true;
      }
    }

    if (!used.has("compaction")) {
      used.add("compaction");
      try {
        const reason = `emergency context trim after provider context-too-long: ${oneLine(error).slice(0, 160)}`;
        const boundary = await this.compactWithLifecycle("auto", reason);
        if (boundary) {
          this.recordCompaction(boundary);
          pushTrace(this.session, "model.context_overflow_recovery", {
            strategy: "compact_context",
            boundaryId: boundary.id,
            messagesCompacted: boundary.messagesCompacted,
            estimatedTokensAfter: boundary.estimatedTokensAfter,
            error,
          });
          return true;
        }
      } catch (recoveryError) {
        this.reportBackgroundError("context_overflow.recovery", recoveryError, { originalError: error });
      }
    }

    return false;
  }

  /** Ask the main process to mint a fresh access token for a subscription
   * account (the refresh token lives only in main, keyed by `subscriptionId`).
   * Returns null when there's no host bridge or the refresh failed, so the
   * caller can surface a clear "reconnect" error instead of looping. */
  private async refreshSubscriptionToken(
    subscriptionId: string,
  ): Promise<{ access: string; accountId?: string } | null> {
    if (!this.hostBridge) return null;
    try {
      const result = (await this.hostBridge("refresh_subscription_token", { subscriptionId })) as
        | { access?: unknown; accountId?: unknown }
        | null
        | undefined;
      const access = typeof result?.access === "string" ? result.access : "";
      if (!access) return null;
      const accountId = typeof result?.accountId === "string" ? result.accountId : undefined;
      return accountId ? { access, accountId } : { access };
    } catch {
      return null;
    }
  }

  /** Routine (lossless) per-turn budget on pending tool observations — the
   * aggregate backstop over the per-tool caps inside @reina/tools, and the only
   * cap MCP tool outputs get at all. Runs from `preflightContext` on every
   * request. Spills largest-first: any output over the per-result cap, then the
   * largest outputs while the round total exceeds the turn budget, each replaced
   * by a head+tail excerpt plus a read_file pointer to the full copy that
   * `persistToolOutput` already wrote. Errors and observations with no on-disk
   * copy (non-tool observations like question answers, or a failed persist) are
   * left alone — the lossy EMERGENCY_* trim still backstops those when the
   * request is about to overflow the window. */
  private enforceTurnObservationBudget(): void {
    if (this.pendingObservations.length === 0) return;
    const { perResult, total } = turnObservationBudget(this.session.model);
    const previewCap = toolOutputPreviewCap(this.session.model);
    let totalChars = this.pendingObservations.reduce(
      (sum, observation) => sum + (observation.error ?? observation.output ?? "").length,
      0,
    );
    const beforeChars = totalChars;
    const spillable = this.pendingObservations
      .map((observation, index) => ({
        observation,
        index,
        length: observation.error === undefined ? (observation.output ?? "").length : 0,
        outputFile: this.session.toolCalls.find((call) => call.id === observation.callId)?.outputFile,
      }))
      .filter((entry) => entry.outputFile !== undefined && entry.length > previewCap)
      .sort((a, b) => b.length - a.length);
    let spilled = 0;
    for (const entry of spillable) {
      if (entry.length <= perResult && totalChars <= total) break;
      const raw = entry.observation.output ?? "";
      const next =
        `${truncateToolOutputForModel(raw, previewCap)}\n` +
        `[Output over the per-turn budget: ${raw.length} chars total, excerpt above. ` +
        `Full output saved to ${entry.outputFile} — read_file it (with offset/limit) for the omitted part.]`;
      if (next.length >= raw.length) continue;
      totalChars -= raw.length - next.length;
      this.pendingObservations[entry.index] = { ...entry.observation, output: next };
      spilled += 1;
    }
    if (spilled > 0) {
      pushTrace(this.session, "observation.turn_budget_spill", {
        spilled,
        count: this.pendingObservations.length,
        beforeChars,
        afterChars: totalChars,
        perResult,
        total,
      });
    }
  }

  private trimPendingObservationsForContextOverflow(): {
    changed: boolean;
    count: number;
    beforeChars: number;
    afterChars: number;
  } {
    if (this.pendingObservations.length === 0) {
      return { changed: false, count: 0, beforeChars: 0, afterChars: 0 };
    }
    let remaining = EMERGENCY_OBSERVATION_TOTAL_CHARS;
    let changed = false;
    let beforeChars = 0;
    let afterChars = 0;
    const next = this.pendingObservations.map((observation) => {
      const key: "error" | "output" = observation.error !== undefined ? "error" : "output";
      const raw = observation[key] ?? "";
      beforeChars += raw.length;
      let value = raw;
      // The full output is on disk (persistToolOutput) — say so, so even the
      // emergency-trimmed form stays recoverable instead of a dead end.
      const outputFile = this.session.toolCalls.find((call) => call.id === observation.callId)?.outputFile;
      const pointer = outputFile ? ` Full output saved to ${outputFile} — read_file it if needed.` : "";
      if (remaining <= 0) {
        value = `[omitted during emergency context recovery; original ${raw.length} chars.${pointer}]`;
      } else {
        const cap = Math.min(EMERGENCY_OBSERVATION_MAX_CHARS, Math.max(EMERGENCY_OBSERVATION_MIN_CHARS, remaining));
        value = truncateMiddleForEmergency(raw, cap);
        if (value !== raw && pointer) value = `${value}\n[${pointer.trim()}]`;
      }
      remaining -= value.length;
      afterChars += value.length;
      if (value !== raw) changed = true;
      return { ...observation, [key]: value };
    });
    if (changed) this.pendingObservations = next;
    return { changed, count: this.pendingObservations.length, beforeChars, afterChars };
  }

  /** Phase B compaction offload — fires from `compactSessionContext`'s
   * onCompactedMessages hook right before the slice gets dropped from
   * `modelMessages`. Skips silently when the feature is off or no
   * SessionStore is wired (e.g. unit-tested engines).
   *
   * On success: chunks are written to SQLite, `session.memoryChunks`
   * is extended with their metadata, and the deferred recall tools are
   * unmasked so the model sees them in the very next turn. */
  private async persistMemoryChunks(compacted: readonly ChatMessage[]): Promise<void> {
    if (!isCompactionOffloadEnabled()) return;
    if (!this.sessionStore) return;
    if (compacted.length === 0) return;
    const existingCount = this.session.memoryChunks?.length ?? 0;
    const toolCalls = this.session.toolCalls ?? [];
    const chunks = extractChunks({
      messages: [...compacted],
      toolCalls,
      sessionId: this.session.id,
      startOrdinal: existingCount + 1,
      estimateTokens: estimateTextTokens,
    });
    if (chunks.length === 0) return;
    try {
      this.sessionStore.upsertSession(this.session);
      this.sessionStore.insertMemoryChunks(this.session.id, chunks);
    } catch (error) {
      // Best-effort per the offload contract: a failed chunk write (disk
      // full, SQLITE_BUSY) degrades this boundary to plain compaction. It
      // must NOT bubble — the user's message is already in the transcript,
      // and an exception here would abort the whole turn. Skipping the
      // metadata/unmask below keeps session.memoryChunks consistent with
      // what actually landed in the store.
      this.reportBackgroundError("memory.chunks", error, { sessionId: this.session.id });
      return;
    }
    const meta = chunks.map(({ content: _content, ...rest }) => rest);
    this.session.memoryChunks = [...(this.session.memoryChunks ?? []), ...meta];

    // Record the recall tools as discovered so their full definitions join the
    // next request. The volatile memory index gives the model their exact names
    // when chunks exist, while the compact catalog advertises the capability.
    // Idempotent — set semantics dedupe repeat compactions.
    this.unmaskDeferredTool("recall_memory_chunk", "list_memory_chunks");
  }

  private rehydrateMemoryChunksFromStore(): void {
    if (!this.sessionStore) return;
    const chunks = this.sessionStore.listMemoryChunks(this.session.id);
    this.session.memoryChunks = chunks.length > 0 ? chunks : undefined;
    if (chunks.length > 0 && isCompactionOffloadEnabled()) {
      this.unmaskDeferredTool("recall_memory_chunk", "list_memory_chunks");
    }
  }

  private recordCompaction(boundary: CompactBoundary): void {
    this.record({ type: "compacted", boundary });
    pushTrace(this.session, "context.compacted", { boundary });
    this.emitStream({ type: "context-compacted", boundary });
    this.touch();
    this.record({ type: "session_replace", session: this.session });
    this.flushToStore();
  }

  /** Atomic answer for a batch group: marks all questions answered, then
   * pushes ONE observation back to the model keyed by groupId (which is
   * the original `question` tool_use_id) with a JSON-encoded answer map. */
  async answerQuestionGroup(groupId: string, answers: Record<string, string>): Promise<AgentRunResult> {
    const groupQuestions = this.session.pendingQuestions.filter((q) => q.groupId === groupId);
    if (groupQuestions.length === 0) return this.result();
    const summary: Array<{ question: string; header?: string; answer: string }> = [];
    for (const q of groupQuestions) {
      const answer = answers[q.id];
      if (typeof answer !== "string") continue;
      q.status = "answered";
      q.answer = answer;
      q.answeredAt = nowIso();
      this.record({ type: "question_update", question: q });
      summary.push({ question: q.question, ...(q.header ? { header: q.header } : {}), answer });
    }
    pushTrace(this.session, "question.answered", { groupId, count: summary.length });
    const aggregatedOutput = `User answers:\n${JSON.stringify(summary, null, 2)}`;
    this.pendingObservations.push({
      callId: groupId,
      name: "question",
      output: aggregatedOutput,
    });
    // Patch the group's tool-call record so timeline displays the answers
    // instead of the "N questions pending" placeholder.
    const toolRecord = this.session.toolCalls.find((call) => call.id === groupId);
    if (toolRecord) {
      toolRecord.output = aggregatedOutput;
      this.record({ type: "tool_update", record: toolRecord });
    }
    await this.continueLoop();
    return this.result();
  }

  // ─── Notes (shared audit notebook) ─────────────────────────────────

  /** Resolve a NotesService instance, awaiting initial disk scan if it
   * hasn't completed yet. `scope` picks the workspace notebook (default) or
   * the global cross-project one. Subagents share the parent's services
   * (set in spawnChildEngine). Returns null if the service is somehow absent
   * (shouldn't happen for any reachable code path). */
  private async resolveNotesService(scope: "workspace" | "global" = "workspace"): Promise<NotesService | null> {
    const service = scope === "global" ? this.globalNotesService : this.notesService;
    const initPromise = scope === "global" ? this.globalNotesInitPromise : this.notesInitPromise;
    if (!service) return null;
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Init error is reported via reportBackgroundError; tool still
        // returns service for best-effort behavior.
      }
    }
    return service;
  }

  private noteAuthor(): string {
    if (!this.session.isSubagent) return "parent";
    return this.session.id;
  }

  private systemPrompt(): string {
    // Lift the MCP-server-name snapshot decision out of buildSystemPrompt so
    // we can persist it to the rollout the first time it's taken. Without
    // this, the snapshot lives only in memory — a restart or loadSession
    // would re-freeze against the current MCP live set on the next prompt
    // build, silently changing the cached prefix bytes. buildSystemPrompt's
    // internal call is still idempotent (returns null when already set), so
    // standalone callers (tests, prompt-size measurements) keep working.
    const taken = snapshotMcpServersIfNeeded(this.session);
    if (taken) this.record({ type: "mcp_servers_snapshot", names: taken });
    return buildSystemPrompt(this.session);
  }

  /** Apply every profile/session visibility gate before an MCP descriptor is
   * used by the request array, hidden roster, budget accounting, or direct-call
   * fallback. Keeping one permitted snapshot per iteration prevents those four
   * surfaces from disagreeing if the live MCP pool changes mid-turn. */
  private filterPermittedMcpRuntimePool(
    runtimeTools: ReadonlyArray<ToolDescriptor>,
    profile: ReturnType<typeof resolveProfile>,
  ): ToolDescriptor[] {
    const blocked = blockedToolsForSession(this.session);
    return filterMcpTools(runtimeTools, profile)
      .filter((tool) => matchesToolAllowList(profile, tool))
      .filter((tool) => profile.toolPermissions[tool.name] !== "deny")
      .filter((tool) => !blocked.has(tool.name))
      .filter((tool) => isToolAvailableToHost(tool.name, this.hostBridge));
  }

  private async resolveTools(mcpRuntimePool?: ReadonlyArray<ToolDescriptor>, preview = false) {
    const profile = resolveProfile(this.session.agent);
    const blocked = blockedToolsForSession(this.session);
    let base = availableTools(profile, this.session.activeDeferredTools, this.session.sessionModes);
    // Discover lifecycle tools when a background shell first needs them, then
    // retain them for the session so task completion/restart cannot churn the
    // cached tools prefix. Use the normal ordering from the first promotion.
    if (this.backgroundShellTaskCount() > 0) {
      const present = new Set(base.map((tool) => tool.name));
      const discovered: string[] = [];
      for (const name of BACKGROUND_LIFECYCLE_TOOLS) {
        const desc = deferredToolDescriptors.find((tool) => tool.name === name);
        if (
          !desc ||
          present.has(name) ||
          blocked.has(name) ||
          profile.toolPermissions[name] === "deny" ||
          !matchesToolAllowList(profile, desc)
        )
          continue;
        discovered.push(name);
      }
      if (discovered.length > 0) {
        if (!preview) this.unmaskDeferredTool(...discovered);
        base = availableTools(profile, preview ? [...(this.session.activeDeferredTools ?? []), ...discovered] : this.session.activeDeferredTools, this.session.sessionModes);
      }
    }
    // Resolve live, cwd-bound definitions each turn: removed servers must not
    // be resurrected by a persisted discovery. Discovery is not a permission grant.
    const mcpAll = mcpRuntimePool
      ? [...mcpRuntimePool]
      : this.filterPermittedMcpRuntimePool(await loadMcpRuntimeTools(this.session.cwd), profile);
    const activeDeferred = new Set(this.session.activeDeferredTools ?? []);
    const mcp = mcpAll
      .filter((tool) => this.residentMcpToolNames.has(tool.name) || activeDeferred.has(tool.name))
      .filter((tool) => matchesToolAllowList(profile, tool))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Host-backed tools are unusable in headless sessions. Hiding their
    // definitions keeps the model from selecting a schema that can only fail.
    const resolved = [...base, ...mcp]
      .filter((tool) => profile.toolPermissions[tool.name] !== "deny")
      .filter((tool) => !blocked.has(tool.name))
      .filter((tool) => isToolAvailableToHost(tool.name, this.hostBridge));
    // Goal tools are state-shaped, not mode-shaped. Once a host-created Goal
    // exists, expose read directly and expose update only while it is active.
    // create_goal stays deferred and is mechanically hidden while an
    // unfinished Goal exists, so stale discovery state cannot reintroduce the
    // duplicate-create loop.
    const currentGoal = this.session.goal?.current;
    if (currentGoal) {
      const present = new Set(resolved.map((tool) => tool.name));
      const names: ToolName[] = currentGoal.status === "active" ? ["get_goal", "update_goal"] : ["get_goal"];
      for (const name of names) {
        const desc = deferredToolDescriptors.find((tool) => tool.name === name);
        if (
          !desc ||
          present.has(name) ||
          blocked.has(name) ||
          profile.toolPermissions[name] === "deny" ||
          !matchesToolAllowList(profile, desc)
        )
          continue;
        resolved.push(desc);
      }
    }
    // Subscription server-side tools (declared by the host at model-resolve
    // time, e.g. Kimi's kimi_web_search/kimi_web_fetch): when the session
    // model rides a subscription that ships tools, they are guaranteed live —
    // expose them natively from turn 1 instead of behind a search_tool
    // discovery round-trip. The engine promotes whatever the model config
    // lists and knows no vendor names; every other session keeps the deferred
    // path. This subscription list is session-stable, so the promotion itself
    // adds no turn-to-turn churn (discovery may still extend the overall tools
    // array); a model switch busts the cache anyway. Sorted for determinism.
    if (this.session.model.subscriptionTools?.length) {
      const present = new Set(resolved.map((tool) => tool.name));
      for (const name of [...this.session.model.subscriptionTools].sort() as ToolName[]) {
        const desc = deferredToolDescriptors.find((tool) => tool.name === name);
        if (
          !desc ||
          present.has(name) ||
          blocked.has(name) ||
          profile.toolPermissions[name] === "deny" ||
          !matchesToolAllowList(profile, desc) ||
          !isToolAvailableToHost(name, this.hostBridge)
        )
          continue;
        resolved.push(desc);
      }
    }
    // Synthetic submit_response tool: only present when the profile opts in
    // via responseSchema. Lets fan-out children return structured JSON the
    // parent can aggregate without re-LLM-parsing. The descriptor's
    // inputSchema is the per-profile Zod schema directly — the provider
    // sends that shape to the model, and the engine re-validates on the
    // way in (provider edges don't always enforce the schema strictly).
    if (profile.responseSchema) {
      resolved.push({
        name: "submit_response",
        description: [
          "Submit your final structured result and finish the task.",
          "Call this EXACTLY ONCE when your work is complete — the parent receives the validated arguments verbatim as JSON, in place of any free-form text you produce.",
          "The arguments must match the profile's response schema. If your draft doesn't fit the schema, fix it before calling rather than guessing — invalid payloads come back as a tool error and you'll have to retry.",
        ].join(" "),
        permission: "state",
        requiresApproval: false,
        inputSchema: profile.responseSchema,
      });
    }
    return resolved.filter((tool) => {
      if (tool.name === "create_goal" && currentGoal && currentGoal.status !== "complete") return false;
      if (tool.name === "update_goal" && currentGoal?.status !== "active") return false;
      return true;
    });
  }

  /** Detect unexpected Anthropic prompt-cache misses by hashing the
   * [system + tools] prefix we just sent and comparing to the previous
   * turn. Logs one line to stderr when a miss happens, distinguishing:
   *   - Provider didn't return cached tokens BUT rewrote cache tokens for an
   *     identical prefix → likely TTL expiration or provider-side eviction.
   *   - Prefix changed → calls out which part (system / tools) so a real
   *     bug (e.g. a timestamp leaking into the system prompt) is easy to
   *     pinpoint. Reasonix's `prefixHash` transcript field plays the same
   *     role; we just log instead of persisting until anyone needs it in
   *     the UI. Silent on cache hits, on first turn, on providers that report
   *     neither cache field, and on 0-read/0-write responses from
   *     Anthropic-compatible gateways that accept cache fields without
   *     actually creating cache entries.
   *
   * OpenAI-family providers (incl. Codex) report no write side — for them a
   * reported `cachedInputTokens: 0` on a non-trivial request is the miss
   * signal. Codex replays the whole history (+ encrypted reasoning) every
   * turn, so a silently-cold cache is exactly the expensive failure mode
   * this exists to surface.
   *
   * The tools hash covers the FULL descriptor (name + description + input
   * schema) — not just names — because a description or schema edit changes
   * the provider's serialized tool block without changing the name list,
   * and the diagnostic would otherwise mislabel that case as "unchanged
   * prefix / TTL expiration" when it's really a self-inflicted miss. */
  private diagnoseCachePrefix(
    usage: TokenUsage | undefined,
    systemPrompt: string,
    tools: ReadonlyArray<ToolDescriptor>,
  ): void {
    const sysHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
    const toolFingerprint = tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Hash the exact schema shape the provider serializes so cache-prefix
      // diagnostics change iff the request's tool descriptor changes.
      schema: toolInputJsonSchema(t),
    }));
    const toolsHash = createHash("sha256").update(serializeForCompare(toolFingerprint)).digest("hex").slice(0, 16);
    const prevSys = this.lastSystemHash;
    const prevTools = this.lastToolsHash;
    this.lastSystemHash = sysHash;
    this.lastToolsHash = toolsHash;
    const created = usage?.cacheCreationInputTokens;
    if (created === undefined) {
      // OpenAI-family path: no write-side reporting exists, but when the
      // provider returns prompt details at all, `cached_tokens` still
      // separates hit from miss. Silent when details are absent, on the
      // first turn, on a hit, or below OpenAI's 1024-token minimum
      // cacheable prefix (those can never hit).
      const cachedRead = usage?.cachedInputTokens;
      if (cachedRead === undefined || cachedRead > 0 || prevSys === undefined) return;
      const input = usage?.inputTokens ?? 0;
      if (input < 1024) return;
      const what: string[] = [];
      if (prevSys !== sysHash) what.push("system");
      if (prevTools !== toolsHash) what.push("tools");
      process.stderr.write(
        what.length > 0
          ? `[reina-cache] miss — prefix changed (${what.join("+")}); 0 of ${input} input tokens cached.\n`
          : `[reina-cache] miss with unchanged prefix — 0 of ${input} input tokens cached (cold route or cache evicted).\n`,
      );
      return;
    }
    const cached = usage?.cachedInputTokens ?? 0;
    if (cached > 0 || prevSys === undefined) return; // hit, or first turn
    if (created <= 0) return; // no read and no write: unsupported/too small, not a TTL miss
    if (prevSys === sysHash && prevTools === toolsHash) {
      process.stderr.write(
        `[reina-cache] miss with unchanged prefix — provider rewrote ${created} cache tokens (TTL expired or cache evicted).\n`,
      );
      return;
    }
    const what: string[] = [];
    if (prevSys !== sysHash) what.push("system");
    if (prevTools !== toolsHash) what.push("tools");
    process.stderr.write(
      `[reina-cache] miss — prefix changed (${what.join("+")}). Wrote ${created} new cache tokens.\n`,
    );
  }

  /** Quantified companion to diagnoseCachePrefix: fold this round's provider
   * usage into the cache tracker and accumulate any counted miss into
   * `session.usage.cacheWaste` (persisted, snapshot-visible) plus a
   * `cache.miss` trace entry. A compaction boundary that landed after the
   * tracked round resets the tracker — the context legitimately changed, so
   * the next prompt is new content, not re-billed content. */
  private trackCacheWaste(usage: TokenUsage | undefined): void {
    // v1 assumed the entire previous prompt was reusable. Tool/provider
    // serialization and relay policies do not guarantee that, so discard its
    // inflated persisted total as soon as another round is observed.
    if (this.session.usage?.cacheWaste?.method !== "reusable-prefix-v2") {
      delete this.session.usage?.cacheWaste;
    }
    const lastBoundary = this.session.compactBoundaries?.at(-1);
    if (this.cachePrev && lastBoundary && Date.parse(lastBoundary.createdAt) > this.cachePrev.at) {
      this.cachePrev = undefined;
    }
    const { next, miss } = trackCacheUsage(this.cachePrev, usage, Date.now());
    this.cachePrev = next;
    if (!miss) return;
    if (this.session.usage) {
      const waste = (this.session.usage.cacheWaste ??= {
        missedTokens: 0,
        missCount: 0,
        method: "reusable-prefix-v2",
      });
      waste.missedTokens += miss.missedTokens;
      waste.missCount += 1;
    }
    // Trace key is `missed` (not `missedTokens`): the trace redactor blanks
    // any key matching /token/i, and this is a count, not a secret.
    pushTrace(this.session, "cache.miss", {
      missed: miss.missedTokens,
      idleMs: miss.idleMs,
      ttlExpired: miss.ttlExpired,
    });
  }

  private appendMessage(item: ChatMessage): void {
    this.session.messages.push(item);
    if (this.session.modelMessages) this.session.modelMessages.push(item);
    this.record({ type: "message", message: item });
  }

  private modelMessages(): ChatMessage[] {
    return this.session.modelMessages ?? this.session.messages;
  }

  /** Thin delegate to ToolOutputController.materializePendingToolResults
   * (tool-output.ts). Kept as a same-named private method so engine.test.ts
   * internals casts keep reaching it by name. */
  private materializePendingToolResults(): void {
    this.toolOutput.materializePendingToolResults();
  }

  /** One-time backfill for sessions persisted BEFORE tool results went in-band.
   * Those sessions hold completed tool calls only in `session.toolCalls` (the
   * old out-of-band store) and have zero in-band tool-result messages — so with
   * the replay subsystem gone the model would lose every pre-update tool output
   * on resume. Detect that shape and materialize the in-window tool outputs as
   * `ephemeral` messages, once. Idempotent: a session that already has in-band
   * tool-result messages (new sessions, or one already backfilled) is skipped.
   * Bounded to the live `modelMessages` window so outputs whose conversation was
   * already compacted away are NOT resurrected. */
  private backfillInbandToolResults(): void {
    const msgs = this.modelMessages();
    if (msgs.length === 0) return;
    if (msgs.some((m) => m.ephemeral === true && m.content.startsWith(TOOL_RESULT_MESSAGE_PREFIX))) return;
    const firstAt = msgs[0]!.createdAt;
    const cap = toolOutputPreviewCap(this.session.model);
    const done = this.session.toolCalls
      .filter(
        (call) =>
          call.completedAt !== undefined &&
          (call.output !== undefined || call.error !== undefined) &&
          call.createdAt >= firstAt,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const call of done) {
      const item = toolResultMessage(
        call.name,
        call.id,
        call.error ?? call.output ?? "",
        call.outputFile,
        cap,
        call.input,
      );
      if (item) this.appendMessage(item);
    }
  }

  /** One-time migration for sessions compacted BEFORE the summary was folded
   * into history. Those sessions hold the rolling summary ONLY in the
   * `session.summary` field (rollout/SQLite), with NO summary-bearing message in
   * `modelMessages`. Now that the per-turn summary reminder is gone
   * (buildVolatileContextReminder), such a session would lose summary visibility
   * on resume until the next full compaction. Detect that shape and prepend a
   * cacheable summary-bearing message once.
   *
   * Idempotent via a content sentinel (the post-compact prefix + summary header,
   * which both new-code compactions and a prior backfill produce). Self-skips
   * never-compacted sessions (no modelMessages view). Mutates modelMessages
   * DIRECTLY — not via appendMessage, which dual-pushes into the visible
   * transcript and appends at the end; the summary must lead the model view and
   * stay out of session.messages. Persisted via session_replace like
   * recordCompaction so both the JSONL and SQLite projections heal. */
  private backfillCompactionSummaryMessage(): void {
    const summary = this.session.summary;
    if (!summary) return;
    const msgs = this.session.modelMessages;
    if (!msgs || msgs.length === 0) return; // never compacted → no orphaned summary
    const first = msgs[0];
    if (
      first &&
      first.content.startsWith(POST_COMPACT_CONTEXT_PREFIX) &&
      first.content.includes(POST_COMPACT_SUMMARY_SECTION)
    ) {
      return; // already folded (new-code compaction) or already backfilled
    }
    this.session.modelMessages = [buildSummaryRestoredContextMessage(summary), ...msgs];
    this.record({ type: "session_replace", session: this.session });
  }

  private result(): AgentRunResult {
    return {
      session: this.session,
      pendingApprovals: [...this.pending.values()],
      pendingQuestions: this.session.pendingQuestions.filter((question) => question.status === "pending"),
    };
  }

  private emitStream(event: ModelStreamEvent): void {
    for (const listener of this.streamListeners) {
      try {
        listener(event);
      } catch (error) {
        // Listener errors must not poison subsequent listeners or the caller
        // (this is the hottest emitter — it fires from finally blocks and
        // settlement paths). console.error, NOT reportBackgroundError: that
        // would re-enter emitStream and loop on a persistently-throwing
        // listener.
        console.error(`[engine] stream listener failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Abortable backoff used by the model-call retry loop. Resolves after `ms`,
   * or early if the turn is interrupted (so a user interrupt during a long
   * overload backoff feels instant rather than waiting out the full delay). */
  private backoffSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Surface a non-fatal side-effect failure that we deliberately swallow so
   * the in-flight turn can complete. Emits a stream event (renderers
   * console.warn or surface a toast) and pushes a trace entry so the failure
   * shows up in the session's debug log on reload. Callers MUST still
   * recover gracefully — this is reporting, not error handling. */
  private reportBackgroundError(category: string, error: unknown, context?: Record<string, unknown>): void {
    const message = errorMessage(error);
    this.emitStream({ type: "background-error", category, message, ...(context ? { context } : {}) });
    pushTrace(this.session, "background.error", { category, message, ...(context ? { context } : {}) });
  }

  /** Rollout I/O logger wired into the recorder. Deferred materialization
   * moved mkdir/open failures out of the loud create_session path into the
   * append chain, whose errors the recorder swallows into its logger — so
   * `error` level must ALSO flow through the background-error stream or an
   * unwritable sessions dir silently loses the whole transcript. warn/info
   * keep the stderr-only behavior of the recorder's default logger. */
  private rolloutLogger(): RolloutLogger {
    return (level, message) => {
      if (level === "error") {
        console.error(`[rollout] ${message}`);
        this.reportBackgroundError("rollout", new Error(message), { sessionId: this.session.id });
      } else if (level === "warn") console.warn(`[rollout] ${message}`);
      else console.info(`[rollout] ${message}`);
    };
  }

  private touch(): void {
    this.session.updatedAt = nowIso();
    this.contextPreview = undefined;
  }

  private requestContextReminders(
    messages: ChatMessage[],
    tools: ToolDescriptor[],
    mcpRuntimePool: ReadonlyArray<ToolDescriptor>,
    model: ModelConfig,
    repairReminder?: string,
  ) {
    // Per-turn hidden roster covers MCP tools only (the pool is runtime-
    // dynamic); the static native deferred catalog lives in the cached
    // system prompt (formatDeferredToolsCatalog). Exclude exactly the
    // names shipping in THIS request's tools array — derived from the
    // resolved array itself (not re-sampled from profile/mode/background
    // state, which could flip between two samples and de-sync roster from
    // array). Discovered MCP tools carry schemas and no longer need the roster.
    const inArrayNames = tools.map((tool) => tool.name);
    const hiddenToolsReminder = buildHiddenToolsReminder(mcpRuntimePool, inArrayNames);
    // Volatile turn state (plan / todos / notes / autopilot / memory)
    // stays outside the stable system prompt. Each section is hashed below,
    // so unchanged state adds zero messages while a changed section appends
    // one replacement/clear update at the history tail.
    const volatileContextSections = buildVolatileContextSections(this.session);
    // One-shot turn reminders (from `/team`, `/verify`, etc.)
    // ride alongside the standard reminders for every iteration of the
    // current tool loop — the directive should still be visible after
    // the model fans out into tool calls. Cleared at the next fresh
    // `runTurn` entry; not persisted to session history.
    // Persistent session toggles (currently Team) participate in the same
    // state diff. Wrapped in <session-mode> so the
    // model can distinguish persistent steers from one-shot slash
    // reminders. Placed AFTER volatile/hidden but BEFORE pending
    // one-shot reminders so the per-turn directive (if any) reads as
    // the most-recent instruction.
    const activeModeReminders = new Map(
      modeTurnReminders(this.session.sessionModes).map(({ name, body }) => [
        name,
        `<session-mode name="${name}">\n${body}\n</session-mode>`,
      ]),
    );
    const contextSections: ModelContextSection[] = [
      ...volatileContextSections,
      {
        id: "hidden_mcp_tools",
        content: hiddenToolsReminder,
        cleared:
          "The previously advertised hidden MCP-tool roster no longer applies. Use the tools currently visible in the request or search_tool for deferred tools.",
      },
      ...SESSION_MODE_NAMES.map((name) => ({
        id: `session_mode:${name}`,
        content: activeModeReminders.get(name) ?? "",
        cleared: modeExitReminder(name),
      })),
    ];
    // These providers serialize systemReminders as trailing user content, so
    // persisting the consumed message reproduces the exact previous request
    // prefix. The deterministic provider is a local test double that routes
    // on the literal last user message and does not serialize reminders.
    const materializesContextState =
      model.provider === "openai-chat" ||
      model.provider === "openai-responses" ||
      model.provider === "openai-codex-responses" ||
      model.provider === "anthropic-messages";
    const previousContextState = materializesContextState ? latestContextStateSnapshot(messages) : undefined;
    const contextStateUpdate = buildContextStateUpdate(contextSections, previousContextState);
    const systemReminders = [
      ...new Set(
        [...contextStateUpdate.reminders, repairReminder, ...this.pendingTurnReminders].filter(
          (item): item is string => Boolean(item),
        ),
      ),
    ];
    return { hiddenToolsReminder, materializesContextState, contextStateUpdate, systemReminders };
  }

  private measureModelRequest(
    systemPrompt: string,
    messages: ChatMessage[],
    observations: ToolObservation[],
    tools: ToolDescriptor[],
    model: ModelConfig,
    mcpRuntimePool: ReadonlyArray<ToolDescriptor>,
    systemReminders: string[],
    includedHiddenToolsReminder: string,
  ): ContextRequestRecord["breakdown"] {
    // A message's reasoningTrace is replayed into context (Anthropic thinking /
    // Responses encrypted reasoning) only when reasoning is on this turn and the
    // trace matches the active provider+model — mirror that gate so the
    // context-budget estimate (which drives auto-compaction) counts the replayed
    // bytes. The encrypted_content blob especially is far larger than the visible
    // reasoning summary, so undercounting it would let compaction fire too late.
    const replaysReasoning = (item: ChatMessage): boolean =>
      // "off" is a real tier (truthy string) but disables thinking — mirror the
      // providers' gate, which skips replay for it, or the estimate overcounts.
      model.reasoningEffort !== undefined &&
      model.reasoningEffort !== "off" &&
      Boolean(item.content) &&
      item.reasoningTrace !== undefined &&
      item.reasoningTrace.provider === model.provider &&
      item.reasoningTrace.model === model.model &&
      (model.provider === "anthropic-messages" || model.provider === "openai-responses");
    // A trace from a DIFFERENT provider+model can't replay natively; the
    // providers downgrade its plain reasoning text into the assistant message
    // instead (model-switch continuity). Count that text here too.
    const downgradesReasoning = (item: ChatMessage): boolean =>
      Boolean(item.content) &&
      Boolean(item.reasoning) &&
      item.reasoningTrace !== undefined &&
      (item.reasoningTrace.provider !== model.provider || item.reasoningTrace.model !== model.model);
    const messageParts = messages.map((item) => {
      const attachments = item.attachments?.length
        ? ` attachments=${JSON.stringify(item.attachments.map((a) => ({ mime: a.mime, name: a.name, bytes: a.dataBase64.length })))}`
        : "";
      const reasoning = replaysReasoning(item)
        ? ` reasoning=${JSON.stringify(item.reasoningTrace!.blocks)}`
        : downgradesReasoning(item)
          ? ` reasoning=${JSON.stringify(item.reasoning)}`
          : "";
      return `${item.role}: ${item.content}${attachments}${reasoning}`;
    });
    const messageText = messageParts.join("\n");
    const observationText = observations.map((item) => `${item.name}: ${item.error ?? item.output ?? ""}`).join("\n");
    let toolsDescriptionChars = 0;
    let toolsSchemaChars = 0;
    let toolsTokens = 0;
    const toolDetails: TokenToolDetail[] = [];
    let toolsCoreTokens = 0;
    let toolsMcpTokens = 0;
    // Names of tools that were originally declared deferred. Used to
    // identify "active deferred" — tools shipping on this request only
    // because the model unmasked them mid-session. Sub-bucket of the
    // core/mcp totals, not additive.
    const originallyDeferredNames = new Set(deferredToolDescriptors.map((t) => t.name));
    let toolsCoreActiveDeferredTokens = 0;
    let toolsMcpActiveDeferredTokens = 0;
    for (const tool of tools) {
      const schemaJson = JSON.stringify(toolInputJsonSchema(tool));
      const tokens = estimateTextTokens(tool.description) + estimateTextTokens(schemaJson);
      toolsDescriptionChars += tool.description.length;
      toolsSchemaChars += schemaJson.length;
      toolsTokens += tokens;
      const mcp = tool.name.startsWith("mcp__");
      const activeDeferred = mcp ? !this.residentMcpToolNames.has(tool.name) : originallyDeferredNames.has(tool.name);
      toolDetails.push({ name: tool.name, tokens, deferred: false, mcp, activeDeferred });
      if (mcp) {
        toolsMcpTokens += tokens;
        if (activeDeferred) toolsMcpActiveDeferredTokens += tokens;
      } else {
        toolsCoreTokens += tokens;
        if (activeDeferred) toolsCoreActiveDeferredTokens += tokens;
      }
    }
    // Hidden definitions are reserved capacity, not active request tokens.
    // The name check excludes both resident and newly discovered tools.
    const requestToolNames = new Set(tools.map((tool) => tool.name));
    let toolsCoreDeferredTokens = 0;
    let toolsMcpDeferredTokens = 0;
    for (const tool of deferredToolDescriptors) {
      if (requestToolNames.has(tool.name)) continue;
      const schemaJson = JSON.stringify(toolInputJsonSchema(tool));
      const tokens = estimateTextTokens(tool.description) + estimateTextTokens(schemaJson);
      const mcp = tool.name.startsWith("mcp__");
      toolDetails.push({ name: tool.name, tokens, deferred: true, mcp });
      if (mcp) toolsMcpDeferredTokens += tokens;
      else toolsCoreDeferredTokens += tokens;
    }
    for (const tool of mcpRuntimePool) {
      if (requestToolNames.has(tool.name)) continue;
      const schemaJson = JSON.stringify(toolInputJsonSchema(tool));
      const tokens = estimateTextTokens(tool.description) + estimateTextTokens(schemaJson);
      toolDetails.push({ name: tool.name, tokens, deferred: true, mcp: true });
      toolsMcpDeferredTokens += tokens;
    }
    toolDetails.sort((a, b) => b.tokens - a.tokens);

    const systemPromptTokens = estimateTextTokens(systemPrompt);
    const messagesTokens = estimateTextTokens(messageText);
    const observationsTokens = estimateTextTokens(observationText);
    const composition: ContextComposition = { system: systemPromptTokens, tools: toolsTokens, user: 0, injected: 0, assistant: 0, toolResults: observationsTokens };
    const messageCategories = [...new Set(messages.map(contextMessageCategory))];
    const groupedMessages = new Map<keyof ContextComposition, string[]>();
    messages.forEach((item, index) => {
      const category = contextMessageCategory(item);
      const group = groupedMessages.get(category) ?? [];
      group.push(messageParts[index]!);
      groupedMessages.set(category, group);
    });
    // Reuse the full-message estimate for the largest category instead of
    // encoding a potentially enormous tool-output history a second time.
    // Join-boundary differences belong to that residual category, keeping the
    // existing request-budget total unchanged.
    const groupedText = messageCategories.map((category) => groupedMessages.get(category)!.join("\n"));
    const largest = groupedText.reduce((best, text, index) => text.length > (groupedText[best]?.length ?? -1) ? index : best, 0);
    const categoryWeights = groupedText.map((text, index) => index === largest ? 0 : estimateTextTokens(text));
    if (categoryWeights.length) categoryWeights[largest] = Math.max(0, messagesTokens - categoryWeights.reduce((sum, tokens) => sum + tokens, 0));
    const categoryTokens = apportionContextTokens(categoryWeights, messagesTokens);
    messageCategories.forEach((category, index) => { composition[category] += categoryTokens[index]!; });
    const totalChars =
      systemPrompt.length + messageText.length + observationText.length + toolsDescriptionChars + toolsSchemaChars;

    // System prompt sub-bucket measurement. We measure skills + user rules
    // separately so the UI can break them out of the system prompt total;
    // `systemPromptBase` is everything else (base prompt, profile, goals,
    // capabilities, output style, task guidance, shell, tool selection,
    // mcp guidance). The arithmetic can drift by ±1 token vs the joined
    // total because tiktoken segmentation is non-linear across "\n\n"
    // joins — surface the residual under `systemPromptBase` so the UI
    // total still reconciles to systemPromptTokens.
    const skillsText = formatSkillsPrompt(this.session.skills ?? []);
    const userRulesText = formatUserRulesPrompt(this.session.cwd);
    const skillsTokens = estimateTextTokens(skillsText);
    const userRulesTokens = estimateTextTokens(userRulesText);
    const systemPromptBaseTokens = Math.max(0, systemPromptTokens - skillsTokens - userRulesTokens);

    // Measure the exact reminder delta sent with this request. Persisted
    // context-state sections already live in `messages`; rebuilding the full
    // volatile context here would count them twice and trigger compaction too
    // early. This also covers one-shot and loop-repair reminders because the
    // caller passes the finalized request array.
    const remindersText = formatSystemReminders(systemReminders) ?? "";
    const remindersTokens = estimateTextTokens(remindersText);
    composition.injected += remindersTokens;
    // Standalone token cost of the hidden-tools reminder. Reported as a
    // sub-bucket of `reminders` so Phase 1 cache-stability work can watch
    // this number turn-to-turn. May differ from the joined arithmetic by
    // ±1 token because tiktoken segmentation isn't strictly linear across
    // "\n\n" joins.
    const hiddenToolsReminderTokens = includedHiddenToolsReminder ? estimateTextTokens(includedHiddenToolsReminder) : 0;

    // Reserved capacity: deferred tools above + autocompact buffer
    // (space the engine holds back so compaction can fire before the
    // hard window cap is hit).
    const contextWindow = contextWindowTokens(model);
    const autocompactThresholdValue = autoCompactThreshold(model);
    const autocompactBuffer = Math.max(0, contextWindow - autocompactThresholdValue);
    const activeTotal = systemPromptTokens + messagesTokens + observationsTokens + remindersTokens + toolsTokens;
    // "Estimate now" mirrors the REAL request footprint the auto-compaction
    // trigger converges to — system prompt (summary is woven in here),
    // tools, reminders, pending observations, and the WOVEN message view whose
    // `messagesTokens` already counts the replayed historical tool outputs.
    // The old `estimateSessionContextTokens` saw only raw modelMessages+summary
    // and was blind to that replay, so on a tool-heavy session it under-reported
    // by 3-4x (e.g. ~20k shown while the provider total — the actual trigger
    // basis — sat near ~90k), which read as "compaction did nothing".
    const autocompactEstimate = activeTotal;
    const reservedTotal = toolsCoreDeferredTokens + toolsMcpDeferredTokens + autocompactBuffer;
    const freeSpace = Math.max(0, contextWindow - activeTotal - reservedTotal);

    const categories: TokenCategoryBreakdown = {
      systemPromptBase: systemPromptBaseTokens,
      systemPromptSkills: skillsTokens,
      systemPromptUserRules: userRulesTokens,
      messages: messagesTokens,
      observations: observationsTokens,
      reminders: remindersTokens,
      hiddenToolsReminder: hiddenToolsReminderTokens,
      toolsCore: toolsCoreTokens,
      toolsMcp: toolsMcpTokens,
      toolsCoreDeferred: toolsCoreDeferredTokens,
      toolsMcpDeferred: toolsMcpDeferredTokens,
      toolsCoreActiveDeferred: toolsCoreActiveDeferredTokens,
      toolsMcpActiveDeferred: toolsMcpActiveDeferredTokens,
      autocompactBuffer,
      autocompactThreshold: autocompactThresholdValue,
      autocompactEstimate,
      freeSpace,
      contextWindow,
    };

    return {
      createdAt: nowIso(),
      provider: model.provider,
      model: model.model,
      messagesCount: messages.length,
      observationsCount: observations.length,
      toolsCount: tools.length,
      systemPromptChars: systemPrompt.length,
      systemPromptTokens,
      messagesChars: messageText.length,
      messagesTokens,
      observationsChars: observationText.length,
      observationsTokens,
      toolsDescriptionChars,
      toolsSchemaChars,
      toolsTokens,
      totalChars,
      estimatedInputTokens: systemPromptTokens + messagesTokens + observationsTokens + remindersTokens + toolsTokens,
      toolNames: tools.map((tool) => tool.name),
      composition,
      categories,
      toolDetails,
    };
  }

  private accumulateUsage(
    usage: TokenUsage | undefined,
    requestBreakdown?: NonNullable<SessionState["usage"]>["lastRequest"],
  ): void {
    if (!this.session.usage) {
      this.session.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, turns: 0 };
    }
    if (requestBreakdown) {
      this.session.usage.lastRequest = requestBreakdown;
      const totals = this.session.usage.requestTotals ?? {
        estimatedInputTokens: 0,
        systemPromptTokens: 0,
        messagesTokens: 0,
        observationsTokens: 0,
        toolsTokens: 0,
      };
      totals.estimatedInputTokens += requestBreakdown.estimatedInputTokens;
      totals.systemPromptTokens += requestBreakdown.systemPromptTokens;
      totals.messagesTokens += requestBreakdown.messagesTokens;
      totals.observationsTokens += requestBreakdown.observationsTokens;
      totals.toolsTokens += requestBreakdown.toolsTokens;
      this.session.usage.requestTotals = totals;
    }
    if (!usage) {
      delete this.session.usage.contextTokens;
      delete this.session.usage.contextTokensSource;
      this.seedEstimateAutoCompactBaseline(requestBreakdown);
      this.publishUsage();
      return;
    }
    this.session.usage.inputTokens += usage.inputTokens ?? 0;
    this.session.usage.outputTokens += usage.outputTokens ?? 0;
    if (usage.cachedInputTokens) this.session.usage.cachedInputTokens += usage.cachedInputTokens;
    if (usage.cacheCreationInputTokens) {
      this.session.usage.cacheCreationInputTokens =
        (this.session.usage.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
    }
    if (usage.reasoningTokens) this.session.usage.reasoningTokens += usage.reasoningTokens;
    const lastTotalTokens: number | undefined =
      typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
        ? Math.floor(usage.totalTokens)
        : undefined;
    this.session.usage.lastTurn = {
      createdAt: nowIso(),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      ...(lastTotalTokens !== undefined ? { totalTokens: lastTotalTokens } : {}),
    };
    this.session.usage.turns += 1;
    if (lastTotalTokens !== undefined) {
      this.session.usage.contextTokens = lastTotalTokens;
      this.session.usage.contextTokensSource = "provider";
      // Seed the codex-style auto-compaction window baseline on the FIRST
      // provider total of a window (compaction clears it). This total is the
      // stable-prefix size the next window's body growth is measured against;
      // later responses in the same window leave it untouched.
      if (this.session.usage.autoCompactBaseline === undefined) {
        this.session.usage.autoCompactBaseline = lastTotalTokens;
      }
      // Re-anchor the live footprint to this authoritative total. The pending
      // observations that fed this request are about to be cleared by the
      // caller, so the tail is effectively zero right now.
      this.lastContextBase = lastTotalTokens;
      this.session.usage.liveContextTokens = lastTotalTokens;
    } else {
      delete this.session.usage.contextTokens;
      delete this.session.usage.contextTokensSource;
      this.seedEstimateAutoCompactBaseline(requestBreakdown);
    }
    this.publishUsage();
  }

  /** Estimate-path counterpart of the provider-total baseline seed above: when
   * a provider never reports usage, the engine's request measure is the only
   * request-shaped total. Seed the body-after-prefix window from the FIRST
   * measure of a window (compaction clears the baseline) so a post-compaction
   * footprint the compactor cannot shrink — prefix + the launching directive
   * kept verbatim — can't re-fire the trigger on every message. */
  private seedEstimateAutoCompactBaseline(requestBreakdown?: NonNullable<SessionState["usage"]>["lastRequest"]): void {
    if (!this.session.usage || this.session.usage.autoCompactBaseline !== undefined) return;
    const measured = requestBreakdown?.categories?.autocompactEstimate;
    if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
      this.session.usage.autoCompactBaseline = Math.floor(measured);
    }
  }

  /** Authoritative base for the live context footprint: the explicitly set
   * base (last provider total or post-compaction estimate) when known,
   * otherwise derived from the restored session usage so a reloaded session
   * still has an anchor before its first new response. */
  private liveContextBase(): number | undefined {
    if (this.lastContextBase !== undefined) return this.lastContextBase;
    const usage = this.session.usage;
    if (
      usage?.contextTokensSource === "provider" &&
      typeof usage.contextTokens === "number" &&
      Number.isFinite(usage.contextTokens) &&
      usage.contextTokens > 0
    ) {
      return Math.floor(usage.contextTokens);
    }
    const total = usage?.lastTurn?.totalTokens;
    return typeof total === "number" && Number.isFinite(total) && total > 0 ? Math.floor(total) : undefined;
  }

  /** Republish a live context-window footprint = authoritative base + an
   * o200k estimate of the pending tool observations not yet sent. Lets the
   * renderer's ring climb as tools produce output mid-turn instead of freezing
   * until the next model response. No model call, so it is cheap to call on
   * every tool result. No-op until there is an authoritative base to build on
   * (first turn falls back to the renderer's local estimate). */
  private emitLiveContext(): void {
    const usage = this.session.usage;
    if (!usage) return;
    const base = this.liveContextBase();
    if (base === undefined) return;
    usage.liveContextTokens = base + estimateObservationTokens(this.pendingObservations);
    this.publishUsage();
  }

  /** Persist the cumulative usage to the rollout AND mirror it onto the model
   * stream so renderers update the context ring in step with the engine (per
   * model response / tool result / child rollup) instead of waiting for the
   * end-of-turn session snapshot. Mirrors codex's per-response TokenCount
   * event. */
  private publishUsage(): void {
    const usage = this.session.usage;
    if (!usage) return;
    this.record({ type: "usage", usage });
    this.emitStream({ type: "usage-updated", usage });
  }
}

function message(role: ChatMessage["role"], content: string, attachments?: MessageAttachment[]): ChatMessage {
  const msg: ChatMessage = { id: createId("msg"), role, content, createdAt: nowIso() };
  if (attachments && attachments.length > 0) msg.attachments = attachments;
  return msg;
}

function canAutoRepairToolLoop(stop: ToolLoopStop): stop is RecoverableToolLoopStop {
  return stop.reason === "no_progress" || stop.reason === "repeated_action" || stop.reason === "consecutive_errors";
}

/** Canonical-stringify a value so structurally-equal inputs hash equal
 * regardless of key order. JSON.stringify with sorted keys is enough —
 * we don't need cryptographic strength, just collision-resistance for
 * UI-driven tool inputs. Non-serializable values fall back to String(). */
function serializeForCompare(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key];
        return sorted;
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

/** Maps Reina's tool permission taxonomy onto storm-breaker's
 * mutating/read-only axis. `write` / `execute` / `state` all change
 * observable state (files, shell side effects, session/agent state like
 * todos, goals, async tasks, wakeups) so a follow-up read after one of
 * these is a legitimate verify step, not a repeat. `read` and `network`
 * are pure queries (web_fetch is GET-only by design) — treat as
 * read-only so repeats are tracked. */
function isMutatingPermission(permission: ToolPermissionLevel): boolean {
  return permission === "write" || permission === "execute" || permission === "state";
}

/** Extracts the original raw-args string from a parse-failed input
 * (parseToolJson wraps unparseable bytes as `{ raw: value }`). Truncated
 * to a preview so giant payloads don't bloat the next model turn. */
function parseFailedRawPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const raw = (input as { raw?: unknown }).raw;
  if (typeof raw !== "string") return "";
  const max = 300;
  return raw.length <= max ? raw : `${raw.slice(0, max)} …[+${raw.length - max} chars]`;
}

/** Wrap a repeated-failure error in a banner the model can't politely
 * ignore. The escalating language ("STOP", "do not retry this exact
 * call") is a deliberate prompt-shaping choice: weak hints get glossed
 * over by some models when the underlying call looked plausible. We
 * preserve the original error verbatim below the banner so the model
 * still has the actionable details (e.g. the parent dir listing). */
/** Two prior consecutive identical failures block the third attempt. The
 * repeated_failure banner already fired on the second, so by the third the
 * model has ignored an explicit STOP — re-executing only burns time and,
 * for side-effectful tools, may not be harmless. */
const LOOP_GATE_CONSECUTIVE_FAILURES = 2;

/** Synthesized WITHOUT running the tool (unlike formatRepeatedFailure,
 * which is a banner glued onto a real execution's error). */
function formatLoopGateBlocked(record: ToolCallRecord, streak: number): string {
  return [
    `<loop_gate tool="${record.name}" priorFailures="${streak}">`,
    `BLOCKED: this exact ${record.name} call already failed ${streak} times in a row, so it was NOT executed again.`,
    "The previous error is unchanged — re-read it in the transcript above. Change the input, use a different tool, or ask the user a focused question.",
    "</loop_gate>",
  ].join("\n");
}

function formatRepeatedFailure(record: ToolCallRecord, originalError: string, attempt: number): string {
  return [
    `<repeated_failure tool="${record.name}" attempt="${attempt}">`,
    `STOP. You have called ${record.name} with the same input ${attempt} times and it has failed every time. Do NOT retry this exact call.`,
    "Required next step: change the strategy — pick a different path / argument from the error details below, or call a different tool (e.g. run_shell `ls` on a parent directory to discover the real layout).",
    "If the goal is impossible with this approach, summarize what you've learned and ask the user a focused question instead of looping.",
    "</repeated_failure>",
    "",
    "Original error follows:",
    originalError,
  ].join("\n");
}

function formatToolLoopRepairPrompt(stop: ToolLoopStop, observations: ToolObservation[]): string {
  return [
    `Automatic recovery triggered: ${stop.message}`,
    `Loop state: reason=${stop.reason}, turns=${stop.turnCount}, budget=${stop.maxSteps}, hardMax=${stop.hardMaxSteps}.`,
    "Do not repeat the same tool call or failing command. First summarize what changed, identify the blocker, and choose a different next action. If the task is blocked or ambiguous, ask the user a focused question instead of continuing to use tools.",
    "Latest tool results:",
    ...formatToolObservationSections(observations),
  ].join("\n\n");
}

function formatToolLoopLimitObservations(stop: ToolLoopStop, observations: ToolObservation[]): string {
  return [
    `The previous assistant turn paused: ${stop.message}`,
    `Loop state: reason=${stop.reason}, turns=${stop.turnCount}, budget=${stop.maxSteps}, hardMax=${stop.hardMaxSteps}.`,
    "Latest tool results are preserved below so the next turn can continue without losing context:",
    ...formatToolObservationSections(observations),
  ].join("\n\n");
}

function formatToolObservationSections(observations: ToolObservation[]): string[] {
  return observations.map((observation) => {
    const result = observation.error ? `ERROR: ${observation.error}` : (observation.output ?? "");
    return [
      `Tool ${observation.name} (${observation.callId}) result before tool loop limit:`,
      truncateText(result, 6000),
    ].join("\n");
  });
}

function toolLoopHardMax(baseSteps: number, configured?: number): number {
  if (Number.isFinite(configured) && configured !== undefined && configured >= 0) return Math.floor(configured);
  const envConfigured = Number(process.env.REINA_TOOL_LOOP_HARD_MAX_STEPS);
  if (Number.isFinite(envConfigured) && envConfigured >= 0) return Math.floor(envConfigured);
  return Math.max(0, baseSteps * 8);
}

/** Tool calls counted as "real progress" when deciding whether autopilot
 * stagnated across rounds. Reads, searches, and pure questions don't count —
 * only acts that produce a durable artifact (note, file write) or kick off
 * concrete work (subagent dispatch / plan / todo update). Async task
 * settlement is counted separately via session.asyncTasks. */
const AUTOPILOT_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  "note",
  "declare_audit_done",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "write_todos",
  "plan",
]);

/** Read-side tools that signal "the model is actively investigating, not
 * stuck". Counted into progressKey so deep audit thinking (rounds of pure
 * code reading, note recall, or grepping) does NOT trip the stagnation
 * exhaust path. A round with any of these completed is by definition not
 * stagnant. Pure no-tool-call thinking turns still count toward stagnation
 * — that's the intended escape from a model that has truly hung. */
const AUTOPILOT_INVESTIGATION_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_note",
  "list_notes",
  "run_shell",
  "web_fetch",
  "read_skill",
  "list_skills",
  "get_async_tasks",
  "wait_async_tasks",
  "list_memory_chunks",
  "recall_memory_chunk",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_status",
  "get_dag",
  "search_tool",
]);

/** How many times a single model call inside the tool loop is re-issued after
 * a transient/retryable API failure (overload, 5xx, 429, a stream dropped
 * after the provider exhausted its own retries) before the turn gives up. This
 * is the OUTER backstop on top of the provider's connect + mid-stream retries,
 * so it defaults generous — an unstable upstream (common with some
 * OpenAI-compatible gateways) shouldn't kill a subagent mid-task. Override via
 * `REINA_TURN_MAX_RETRIES` (0 disables). */
export function turnMaxRetries(): number {
  const raw = process.env.REINA_TURN_MAX_RETRIES;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 4;
}

/** Exponential backoff with jitter for the model-call retry loop, capped at
 * 30s. Longer cap than the provider's per-stream backoff (8s) because the
 * failures that reach this layer are persistent-overload shaped, where a
 * longer pause between whole-request re-issues is more likely to clear. */
export function turnRetryBackoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function truncateMiddleForEmergency(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n...[truncated ${text.length - maxChars} chars during emergency context recovery]...\n`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const headChars = Math.max(0, Math.floor((maxChars - marker.length) * 0.7));
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
