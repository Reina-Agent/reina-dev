import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentProfile,
  AsyncTaskRecord,
  ModelStreamEvent,
  ToolCallRecord,
  ToolObservation,
} from "@reina/protocol";
import { errorMessage, createId, nowIso } from "@reina/protocol";
import { resolveProfile } from "../profiles.js";
import { pushTrace } from "../trace.js";
import { createWorktree, removeWorktree, worktreeHasChanges } from "../worktree.js";
import { ActivityTracker, readAsyncTaskActivity } from "./activity.js";
import type { AsyncTaskActivitySnapshot, AsyncTaskUpdateRecord } from "./types.js";
import { escapeXml, formatAsyncTaskStatus } from "./format.js";
import { buildForkContext, isForkEnabled, wrapForkDirective } from "./fork.js";
import { CompletionInjector } from "./injector.js";
import { resolveTaskRef, validateName } from "./registry.js";
import { reconcileSubagentTasks } from "./reconciler.js";
import { buildFollowUpPrompt, buildResumePrompt, checkWorktreeHealth, isResumable, resumeRefusalMessage } from "./resume.js";
import type { SubagentHost } from "./types.js";
import type { AgentEngine } from "../engine.js";

/** Flat fan-out only: parent (depth 0) spawns child (depth 1); the child
 * cannot spawn further. Matches Hermes' default delegation.max_spawn_depth=1.
 * Deeper trees explode token cost without buying meaningful decomposition
 * for current UX. */
export const MAX_SUBAGENT_DEPTH = 1;
/** Default per-child hard timeout. Reuses Hermes' 10-minute default — long
 * enough for legitimate multi-tool work, short enough that a wedged child
 * doesn't sit forever. Override via REINA_SUBAGENT_TIMEOUT_MS env var. */
const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;
/** How often the watchdog wakes up to compare lastEventAt vs. now. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Default idle stale budget: no stream event from the child for this
 * long → stale. Resolved per child via staleIdleMs() (env / profile). */
export const STALE_IDLE_MS = 450_000;
/** Default in-tool stale budget: while one of the child's tool calls is
 * in `running` status, give it 20 min before declaring stale. Resolved
 * per child via staleInToolMs() (env / profile). */
const STALE_IN_TOOL_MS = 1_200_000;
/** Liveness window for the wall-clock cap. When the hard timer fires,
 * a child that has emitted any stream event within the last
 * HEALTHY_RECENT_MS is treated as "still alive" and the cap defers
 * instead of killing. STALE_IDLE_MS / STALE_IN_TOOL_MS remain the
 * safety net for children that genuinely stop producing. */
const HEALTHY_RECENT_MS = 30_000;
/** Extension granted to a healthy child when the wall-clock timer
 * fires. Re-checked at each extension cycle. */
const HEALTHY_EXTEND_MS = 300_000;
/** How many times the same normalized (agent, brief) pair may fail in a
 * session before subsequent start_async_task calls with that pair are
 * rejected. Overridable via REINA_MAX_BRIEF_RETRIES so projects with
 * legitimately flaky external deps (network-bound work, MCP servers
 * that hiccup) can raise the ceiling. */
const DEFAULT_MAX_BRIEF_RETRIES = 3;

function maxBriefRetries(): number {
  const raw = process.env.REINA_MAX_BRIEF_RETRIES;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_BRIEF_RETRIES;
}

/** Compose the persistent key for the failure counter. Hashing per
 * (agent, brief) means a brief that fails under `default` doesn't
 * lock out the same brief under `scout` — different profiles bring
 * different tools and the outcome is genuinely independent. */
function briefRetryKey(agent: string, description: string): string {
  return `${agent}::${normalizeBriefForRetryGuard(description)}`;
}
/** Automatic re-dispatch budget for a batch member whose settle was a provider
 * rate limit (kimi AgentSwarm parity: 429s are requeued, not terminal). Per
 * task, on top of the child engine's own in-turn retry/backoff — by the time a
 * member settles rate-limited the provider is genuinely saturated. */
const BATCH_RATE_LIMIT_MAX_RETRIES = 2;
/** Batch-wide dispatch cooldown after a rate-limited settle. Doubles per
 * consecutive rate-limited settle (a member completing cleanly resets the
 * streak) so the whole batch backs off the saturated provider instead of
 * piling on. Base overridable via REINA_BATCH_RATE_LIMIT_COOLDOWN_MS. */
const BATCH_RATE_LIMIT_COOLDOWN_BASE_MS = 15_000;
const BATCH_RATE_LIMIT_COOLDOWN_MAX_MS = 120_000;

function batchRateLimitCooldownMs(streak: number): number {
  const raw = process.env.REINA_BATCH_RATE_LIMIT_COOLDOWN_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : BATCH_RATE_LIMIT_COOLDOWN_BASE_MS;
  return Math.min(base * 2 ** Math.max(0, streak - 1), BATCH_RATE_LIMIT_COOLDOWN_MAX_MS);
}

/** Rate-limit markers in settled text. Quota/billing/subscription-window
 * exhaustion is excluded — those won't clear on a retry timescale, so a
 * re-dispatch would just burn the retry budget (mirrors the providers-package
 * isQuotaOrBillingError carve-out, but over settled text: by settle time the
 * original Error object is gone and only its message survived). */
const RATE_LIMITED_SETTLE_TEXT = /rate.?limit|too many requests|overloaded|\b429\b/i;
const NON_CLEARING_LIMIT_TEXT = /insufficient_quota|credit balance|quota|usage.?limit/i;

/** A rate-limited child settles in one of two shapes: driveAsyncChild caught a
 * thrown provider error (status "failed" with the provider text in `error`),
 * or the child engine exhausted its own turn retries and ended the turn
 * gracefully with a "Model request failed…" assistant message — which the
 * completed path then reads back as the entire result. Both are the provider
 * saturating, not a property of the brief. */
function isRateLimitedSettle(task: AsyncTaskRecord): boolean {
  const text =
    task.status === "failed"
      ? (task.error ?? "")
      : task.status === "completed" && (task.result ?? "").startsWith("Model request failed")
        ? (task.result ?? "")
        : "";
  if (!text || NON_CLEARING_LIMIT_TEXT.test(text)) return false;
  return RATE_LIMITED_SETTLE_TEXT.test(text);
}

/** Follow-up prompt for an automatic rate-limit re-dispatch. */
const RATE_LIMIT_RETRY_MESSAGE =
  "The previous attempt was cut short by a provider rate limit (see the prior outcome above) — nothing about the task itself failed. This is an automatic retry: redo the original task from scratch and report the result.";
/** Maximum concurrently-running async subagent children per parent session.
 * Override via REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS. */
const DEFAULT_MAX_CONCURRENT_ASYNC = 8;
/** Grace period for terminal-state async tasks before eviction. */
const TASK_EVICTION_GRACE_MS = 600_000;
/** Hard cap on the live async-task roster carried in session.asyncTasks.
 * Overflow gets moved to session.asyncTasksArchived (oldest-acknowledged
 * first) so long autopilot sessions don't drag a growing array through
 * every rollout write + prompt injection. Override via
 * REINA_MAX_LIVE_ASYNC_TASKS. */
const DEFAULT_MAX_LIVE_ASYNC_TASKS = 200;
/** Minimum token delta (input + output) between two runningUsage
 * updates on a running async task. Sub-threshold deltas are absorbed
 * silently — without this, a streaming child would push a runningUsage
 * write on every short turn and the UI / rollout would churn. */
const RUNNING_USAGE_DELTA_TOKENS = 1_000;
/** Minimum interval between two sweepEvictable runs. The sweep is O(n)
 * and was previously fired from every upsertAsyncTask, including pure
 * timestamp updates — on long sessions that's O(n²) busywork. Debounce
 * keeps it bounded. */
const SWEEP_DEBOUNCE_MS = 30_000;

/** In-memory dispatch queue for one start_task_batch fan-out. Dispatched
 * members live as normal AsyncTaskRecords (tagged batchId); only the
 * not-yet-dispatched tail + dispatch failures live here. */
type BatchState = {
  id: string;
  agent: string;
  briefTemplate?: string;
  isolate: "none" | "worktree";
  maxConcurrent: number;
  pending: string[];
  taskIds: string[];
  dispatchFailures: Array<{ item: string; error: string }>;
  createdAt: string;
  /** taskId → automatic rate-limit re-dispatches consumed (capped at
   * BATCH_RATE_LIMIT_MAX_RETRIES per member). */
  rateLimitRetries: Map<string, number>;
  /** Members with a rate-limit retry timer armed but not yet re-dispatched.
   * check_task_batch must not report done while this is non-empty — the
   * member LOOKS terminal but is about to re-open. */
  scheduledRetries: Set<string>;
  /** Consecutive rate-limited settles (clean completion resets) — drives
   * exponential cooldown growth. */
  rateLimitStreak: number;
  /** Epoch ms; pumpBatch admits no new dispatches before this. */
  cooldownUntil?: number;
  cooldownTimer?: ReturnType<typeof setTimeout>;
};

type QueuedTaskUpdate = {
  id?: string;
  message: string;
};

/** Tools no subagent may use. The spawn family is blocked because depth is
 * capped at 1 anyway (defense in depth); `question` and `exit_plan_mode`
 * are blocked because the subagent has no user to talk to. */
export const BLOCKED_FOR_SUBAGENT: ReadonlySet<string> = new Set([
  "task",
  "start_async_task",
  "start_task_batch",
  "check_task_batch",
  "get_async_tasks",
  "check_async_task",
  "cancel_async_task",
  "update_async_task",
  "list_async_tasks",
  "gather_async_tasks",
  "question",
  "exit_plan_mode",
]);

/** Return the settled task record with its worktree-provisioning fields
 * cleared, for the post-teardown upsert. Takes the FINAL (settled) record so
 * the second upsert preserves terminal status/result/completedAt. Spreading
 * the pre-settle `current` snapshot instead — which is still `running` with no
 * result — would roll the just-written terminal record back to running and
 * drop the subagent's result (the teardown-regression bug this guards). */
export function withWorktreeCleared(settled: AsyncTaskRecord): AsyncTaskRecord {
  return { ...settled, worktreePath: undefined, worktreeBranch: undefined, worktreeBaseSha: undefined };
}

/** Loud-failure guard for the silent approval gap: a child whose turn
 * returned while a tool call is still `pending_approval` parked that call in
 * its OWN pending map — unreachable, a child session has no HITL surface —
 * so the gated tool never ran and never will. Settlement must not read the
 * half answer as success; both settle paths (runSync / driveAsyncChild) call
 * this and downgrade a "completed" disposition to failed when it returns an
 * error string. */
function parkedApprovalError(child: AgentEngine): string | undefined {
  const parked = child.session.toolCalls.filter((call) => call.status === "pending_approval");
  if (parked.length === 0) return undefined;
  const names = [...new Set(parked.map((call) => call.name))].join(", ");
  return `Subagent stopped awaiting approval for: ${names}. The gated tool never ran, so the reply is incomplete. Approve the bubbled prompt if one is shown, or re-dispatch under a permission mode that does not gate it (accept-edits/bypass).`;
}

/** Owns the async subagent subsystem: child engine references, brief retry
 * counters, dispatch reservations, and the lifecycle for both the sync `task`
 * and the seven `*_async_task` tools. Engine.ts wires one of these per
 * AgentEngine and forwards tool-dispatch cases here. */
export class SubagentManager {
  /** Running async subagent children, keyed by task id. Public so tests can
   * inspect or seed the map; in production, only the manager mutates it. */
  readonly children = new Map<string, AgentEngine>();
  /** Pending follow-up messages from update_async_task. Keyed by taskId.
   * driveAsyncChild's loop detects this after an interrupt and starts a
   * fresh turn on the same child with the queued message instead of
   * finalizing the task as cancelled. */
  private pendingTaskUpdates = new Map<string, string>();
  private taskStreams = new Map<string, {
    emit: (event: ModelStreamEvent) => void;
    turnId?: string;
  }>();
  private taskStreamClosures = new Map<string, Promise<void>>();
  /** Per-brief failure counter. Keys are normalized descriptions. Public
   * so the engine's test-seam shim can expose it under the legacy name. */
  readonly failedBriefCounts = new Map<string, number>();
  /** Synchronous in-flight dispatch reservations. */
  private pendingDispatchReservations = 0;
  /** Same-turn (agent, normalized brief) → taskId map. Populated
   * synchronously inside `startAsync` between minting the task id and
   * the first `await`, so two batched `start_async_task` calls in the
   * same model response that share an (agent, brief) collapse to one
   * child. Released the moment the task lands in `session.asyncTasks`
   * — later concurrent dispatches see the running task there via the
   * session-level duplicate check below. Key shape matches
   * `briefRetryKey` so existing normalization rules apply. */
  private inFlightDispatches = new Map<string, string>();
  /** Pending completion notifications for background tasks. The engine
   * drains this at safe boundaries (start of runTurn, between
   * continueLoop iterations) and emits the formatted batch as a
   * user-role observation so the supervisor sees background work
   * settle without having to poll. */
  readonly injector = new CompletionInjector();
  /** In-memory snapshot of each running child's recent activity. The
   * stream bridge updates this on every observed event so
   * `check_async_task` / `injectAsyncTaskSnapshot` can read O(1)
   * instead of stat+reading 64KB of stream.jsonl per task per turn. */
  readonly activity = new ActivityTracker();

  /** Live start_task_batch queues, keyed by batch id. In-memory only —
   * dispatched workers persist as records; queued items do not survive a
   * restart (check_task_batch discloses that). */
  private readonly batches = new Map<string, BatchState>();

  constructor(private host: SubagentHost) {}

  // ─── External entry points (called by engine.ts) ──────────────────────────

  /** External (UI-driven) cancel for a specific async subagent task. Returns
   * true when a cancellation was actually fired. */
  cancelExternal(taskId: string): boolean {
    const child = this.children.get(taskId);
    if (!child) return false;
    child.interrupt();
    return true;
  }

  /** Interrupt and forget all children whose taskId is NOT in keptTaskIds.
   * Used by rollbackToMessage when slicing the session timeline. */
  pruneChildren(keptTaskIds: ReadonlySet<string>): void {
    this.injector.retain(keptTaskIds);
    for (const [taskId, child] of this.children.entries()) {
      if (keptTaskIds.has(taskId)) continue;
      this.children.delete(taskId);
      this.dropQueuedTaskUpdates(taskId, "task_pruned");
      this.activity.drop(taskId);
      child.interrupt();
    }
  }

  /** Walk session.asyncTasks and classify entries still flagged
   * `running` or `resuming` after a process restart. Recoverable tasks
   * can be resumed via `update_async_task`, which spawns a fresh child
   * driven with the original brief + the supervisor's new message.
   * Worktree-isolated tasks whose worktree disappeared become
   * `needs_attention` instead of being executed blindly.
   *
   * Also rehydrates the in-memory failedBriefCounts map from the
   * persisted session.failedBriefs array so the retry guard remains
   * effective across process restarts. */
  async recoverStaleOnLoad(input: { persistedTasks?: AsyncTaskRecord[] } = {}): Promise<void> {
    this.injector.clear();
    this.rehydrateFailedBriefs();
    const session = this.host.session;
    const sessionTasks = session.asyncTasks ?? [];
    if (sessionTasks.length === 0 && !input.persistedTasks?.length) return;
    const reconciled = await reconcileSubagentTasks({
      sessionTasks,
      persistedTasks: input.persistedTasks,
      liveTaskIds: new Set(this.children.keys()),
      checkWorktreeHealth,
    });
    for (const task of reconciled.changed) {
      this.upsertAsyncTask(task);
    }
    const recovered = reconciled.recovered;
    if (recovered.length > 0) {
      pushTrace(session, "async_task.recovered", {
        recovered: true,
        recoverable: recovered.filter((task) => task.status === "recoverable").length,
        needsAttention: recovered.filter((task) => task.status === "needs_attention").length,
        count: recovered.length,
        mergedFromStore: reconciled.mergedFromStore.length,
        taskIds: recovered.map((t) => t.id),
      });
      // Single bulk stream event instead of N async-task-updated pings.
      // The pings were thundering through listeners that may not even
      // be attached on cold boot (UI hadn't subscribed yet); a single
      // batch is both cheaper AND lossless: the listener can either
      // apply all N at once, or skip the event entirely and read
      // session.asyncTasks on subscribe — equivalent outcomes.
      this.host.emitStream({ type: "async-task-evicted-batch", tasks: recovered });
    }
    // Completion delivery is acknowledged only when the model receives it.
    // Rebuild the volatile queue after reconciliation, including completions
    // repaired from the durable task store. Batch members remain poll-only.
    for (const task of session.asyncTasks ?? []) {
      if (!task.background || task.batchId || !isTaskTerminal(task) || task.injectedAt) continue;
      this.injector.enqueue(task);
      this.host.emitStream({ type: "async-task-injected", task });
    }
  }

  /** Reload the in-memory failure counter from session.failedBriefs.
   * Called at boot from recoverStaleOnLoad so a previous incarnation's
   * "this brief is broken" verdict survives the process restart. Safe
   * to call multiple times — entries already in memory are overwritten
   * with the persisted value (persisted is authoritative). */
  private rehydrateFailedBriefs(): void {
    const persisted = this.host.session.failedBriefs;
    if (!persisted?.length) return;
    for (const entry of persisted) {
      const key = `${entry.agent}::${entry.briefKey}`;
      this.failedBriefCounts.set(key, entry.count);
    }
  }

  /** Mirror an in-memory failure-count update back to session.failedBriefs
   * so it survives a process restart. Idempotent upsert keyed on
   * (agent, briefKey). */
  private persistFailedBriefCount(agent: string, description: string, count: number): void {
    const session = this.host.session;
    session.failedBriefs ??= [];
    const briefKey = normalizeBriefForRetryGuard(description);
    const idx = session.failedBriefs.findIndex(
      (entry) => entry.agent === agent && entry.briefKey === briefKey,
    );
    const lastFailedAt = nowIso();
    if (idx === -1) {
      session.failedBriefs.push({ agent, briefKey, count, lastFailedAt });
    } else {
      session.failedBriefs[idx] = { agent, briefKey, count, lastFailedAt };
    }
  }

  /** Guard against subagents spawning subagents past MAX_SUBAGENT_DEPTH. */
  assertDepth(): void {
    const depth = this.host.session.subagentDepth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(`subagent depth limit reached (${MAX_SUBAGENT_DEPTH}). A subagent cannot spawn another subagent past this depth.`);
    }
  }

  /** Insert or replace an async task record in `session.asyncTasks` and
   * emit the matching rollout event + live stream ping. Public so engine
   * test helpers can seed records directly.
   *
   * Two efficiency knobs that matter for long sessions / many children:
   *
   *   1. Stream emit is gated on "substantive" diff. Pure timestamp
   *      updates (notifiedAt / injectedAt / archived flip) still go
   *      through the rollout (durability) but skip the live stream —
   *      otherwise the UI churns on every check_async_task call.
   *   2. sweepEvictable is debounced. Was previously fired on every
   *      upsert (~5 per task lifecycle × N tasks = O(n²) on the
   *      asyncTasks array). Now runs at most every SWEEP_DEBOUNCE_MS. */
  upsertAsyncTask(task: AsyncTaskRecord, options?: { allowReopen?: boolean }): void {
    const session = this.host.session;
    session.asyncTasks ??= [];
    const index = session.asyncTasks.findIndex((entry) => entry.id === task.id);
    const prior = index === -1 ? undefined : session.asyncTasks[index];
    // Chokepoint guard: a stale pre-settle snapshot must never roll a
    // terminal record back to running and drop its result. Legitimate
    // transitions are unaffected — resume restarts only from
    // recoverable/evicted (non-terminal), terminal→terminal rewrites (e.g.
    // clearing worktree fields post-teardown) still pass, and the ONE
    // deliberate terminal→running transition — a settled-task follow-up —
    // declares itself via options.allowReopen (guarded by an attemptCount
    // bump, so a stale snapshot can never sneak through this door).
    const isDeclaredReopen =
      options?.allowReopen === true && (task.attemptCount ?? 1) > (prior?.attemptCount ?? 1);
    if (!isDeclaredReopen && prior && isTaskTerminal(prior) && !isTaskTerminal(task)) {
      this.host.reportBackgroundError("async_task.upsert", new Error(
        `Ignored terminal→${task.status} rollback for task ${task.id} (stale snapshot upsert).`,
      ), { taskId: task.id });
      return;
    }
    if (index === -1) {
      // Late-settlement writes (e.g. the worktree teardown's second upsert
      // sits behind multi-second git awaits) can land after a sweep archived
      // the task. Update the archived copy in place — pushing the snapshot
      // back into the live roster would duplicate the task across both arrays.
      const archive = session.asyncTasksArchived;
      const archivedIndex = archive?.findIndex((entry) => entry.id === task.id) ?? -1;
      if (archive && archivedIndex !== -1) {
        const merged = { ...task, archived: true };
        archive[archivedIndex] = merged;
        this.host.record({ type: "async_task_update", task: merged });
        return;
      }
    }
    const eventType = taskEventType(prior, task);
    if (index === -1) {
      session.asyncTasks.push(task);
      this.host.record({ type: "async_task", task });
    } else {
      session.asyncTasks[index] = task;
      this.host.record({ type: "async_task_update", task });
    }
    this.host.persistAsyncTask?.({
      task,
      eventType,
      payload: {
        priorStatus: prior?.status,
        recovery: task.recovery,
      },
    });
    // Live ping so the renderer can refresh the Agent Team panel without
    // waiting for the end-of-turn snapshot. Skipped for metadata-only
    // edits — see substantiveTaskDiff.
    if (!prior || substantiveTaskDiff(prior, task)) {
      this.host.emitStream({ type: "async-task-updated", task });
    }
    this.maybeSweep();
  }

  /** Find a still-LIVE (running or resuming) async task that shares the
   * same (agent, normalized brief) as a new dispatch. Both the sync `task`
   * path and start_async_task consult this so a re-issued identical brief
   * collapses onto the original child instead of spawning a second one —
   * re-dispatching in-flight work just doubles cost and yields two
   * half-cooked answers. Mirrors Claude Code's coordinator contract
   * ("don't re-dispatch; the worker will report back"). Exact-match on the
   * normalized brief keeps false positives near zero — a genuinely
   * different brief still spawns. */
  private findLiveDuplicateDispatch(agent: string, description: string): AsyncTaskRecord | undefined {
    const wantKey = normalizeBriefForRetryGuard(description);
    return (this.host.session.asyncTasks ?? []).find(
      (t) =>
        (t.status === "running" || t.status === "resuming") &&
        t.agent === agent &&
        normalizeBriefForRetryGuard(t.description) === wantKey,
    );
  }

  /** Apply the global `subagent.secondaryModel` default to a freshly spawned
   * child ("all workers on a cheap model"). Merged over the inherited parent
   * model so a Partial (just `{model}`) keeps the parent's provider/apiKey.
   * Lowest priority by construction: the request-time merge in engine.ts is
   * `{...session.model, ...profile.model, ...session.modelOverride}`, so an
   * AgentProfile pin or per-skill override still wins. Callers skip forks —
   * a fork's value is prompt-cache prefix reuse, and a different model is a
   * different cache namespace, which would turn the fork into a cold start. */
  private applySecondaryModel(child: AgentEngine): void {
    const secondary = this.host.secondaryModel;
    if (!secondary || Object.keys(secondary).length === 0) return;
    child.session.model = { ...child.session.model, ...secondary };
  }

  // ─── Tool dispatch entry points ───────────────────────────────────────────

  /** Sync `task` tool — block the model turn on one child's result.
   *
   * Unlike start_async_task, this blocks the supervisor's runTurn until
   * the child settles. Despite being synchronous, we DO write an
   * AsyncTaskRecord (sync=true) so:
   *   - the child is externally cancellable via cancelExternal,
   *   - crash recovery (recoverStaleOnLoad) can detect a sync task
   *     that was running when the process died and mark it recoverable,
   *   - check/list/the UI can show "supervisor is currently blocked
   *     on subagent X" without grepping tool-call records.
   * The sync record is marked notifiedAt at settlement so the sweep
   * cleans it up promptly (the supervisor already saw the result). */
  /** Wire the parent-escalation channels onto a fresh child: `question`
   * prompts and bubbled tool approvals both route to the parent's HITL flow,
   * because a child session has no UI of its own. Wired on EVERY spawned
   * child (sync task, async, fork, recovery) — the silent approval gap was
   * exactly the non-fork paths missing the bubble half of this. Fork
   * children additionally switch `permissionMode` to "bubble" at their spawn
   * site for supervisor-grade prompt strictness; that mode only affects WHAT
   * prompts, never where prompts go. */
  private wireChildEscalation(taskId: string, child: AgentEngine, taskName?: string): void {
    child.setUserQuestionHandler((input) =>
      this.host.requestUserQuestion({
        taskId,
        taskName,
        prompt: input.prompt,
        options: input.options,
      }),
    );
    child.setBubbleApprovalHandler((childRecord) =>
      this.host.requestBubbleApproval({
        taskId,
        taskName,
        childRecord,
      }),
    );
    child.setSiblingMessageHandler((input) =>
      this.deliverSiblingMessage({ taskId, name: taskName }, input.targetRef, input.message),
    );
  }

  /** Parent-mediated sibling channel (send_task_message). Delivers with
   * update semantics — enqueue + interrupt — so the target actually reacts
   * this turn instead of maybe noticing a note later. Codex V2's
   * inter-agent send_message equivalent, scoped to live siblings. */
  private deliverSiblingMessage(
    from: { taskId: string; name?: string },
    targetRef: string,
    message: string,
  ): { ok: boolean; detail: string } {
    const target = resolveTaskRef(targetRef, this.host.session);
    if (!target) return { ok: false, detail: `no such task: ${targetRef}` };
    if (target.id === from.taskId) return { ok: false, detail: "cannot send a message to yourself" };
    if (target.status !== "running") {
      return { ok: false, detail: `Task ${target.id} is ${target.status} — only running siblings accept messages. Report to the supervisor instead if its outcome matters to you.` };
    }
    const child = this.children.get(target.id);
    if (!child) {
      return { ok: false, detail: `Task ${target.id} is marked running but its child engine is gone (stale record from a previous process).` };
    }
    const fromLabel = from.name ? `${from.taskId} (${from.name})` : from.taskId;
    this.enqueueTaskUpdate(target.id, `[Message from sibling worker ${fromLabel}]\n${message}`);
    child.interrupt();
    pushTrace(this.host.session, "async_task.started", { id: target.id, siblingMessage: true, from: from.taskId });
    return {
      ok: true,
      detail: `Message delivered to ${target.id}${target.name ? ` (${target.name})` : ""}. Its current turn is being interrupted; it will react to your message next.`,
    };
  }

  async runSync(record: ToolCallRecord): Promise<ToolObservation> {
    let wtPath: string | undefined;
    let wtBranch: string | undefined;
    let wtBaseSha: string | undefined;
    let taskId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let child: AgentEngine | undefined;
    let driveStarted = false;
    try {
      const input = record.input as {
        description?: string;
        subagentType?: string;
        subagent_type?: string;
        isolate?: "none" | "worktree";
      };
      const description = input.description;
      if (!description) throw new Error("task requires description");
      this.assertDepth();
      const agent = input.subagentType ?? input.subagent_type ?? "default";
      // Same-brief dedup (parity with start_async_task). The sync `task`
      // path previously had NONE, so a coordinator that re-issued an
      // identical brief — common with weaker models replaying prior tool
      // output — spawned a duplicate child every time. Bail to a pointer
      // at the live original instead.
      const existingLive = this.findLiveDuplicateDispatch(agent, description);
      if (existingLive) {
        return mergedDispatchObservation(record, existingLive.id, `same brief is already ${existingLive.status}`);
      }
      // Mirrors start_async_task: opt-in worktree isolation. Default is
      // shared parent cwd. Mirrors Claude Code's Agent tool — isolation
      // is always explicit at dispatch time.
      const isolate: "none" | "worktree" = input.isolate === "worktree" ? "worktree" : "none";
      // MCP gating (P2-8) — same fail-fast contract as startAsync.
      await this.host.awaitRequiredMcp(agent);
      taskId = `sub_${createId("sub").slice(-8)}`;
      let cwd = this.host.cwd;
      if (isolate === "worktree") {
        const wt = await createWorktree(this.host.cwd, taskId);
        cwd = wt.path;
        wtPath = wt.path;
        wtBranch = wt.branch;
        wtBaseSha = wt.baseSha;
      }
      child = this.host.spawnChild({ cwd, agent });
      this.applySecondaryModel(child);
      this.wireChildEscalation(taskId, child);
      // Insert the sync record up-front so cancelExternal + crash
      // recovery can find it. status="running" until settlement.
      const taskRecord: AsyncTaskRecord = {
        id: taskId,
        agent: child.session.agent,
        description,
        status: "running",
        startedAt: nowIso(),
        childSessionId: child.session.id,
        isolation: isolate,
        worktreePath: wtPath,
        worktreeBranch: wtBranch,
        worktreeBaseSha: wtBaseSha,
        attemptCount: 1,
        lastHeartbeatAt: nowIso(),
        turns: 0,
        toolCalls: 0,
        sync: true,
      };
      this.upsertAsyncTask(taskRecord);
      this.children.set(taskId, child);
      unsubscribe = this.bridgeChildStream(taskId, child);
      const firstPrompt = assembleFirstTurnPrompt(resolveProfile(agent), description);
      // Settlement (terminal record, salvage on stale-kill, usage rollup,
      // hooks, worktree teardown) is owned by the shared async driver — the
      // exact path start_async_task runs. runSync only adds a bounded
      // foreground wait on top, so sync and async children can never drift
      // apart in how they settle.
      driveStarted = true;
      const driven = this.driveAsyncChild(taskId, child, firstPrompt, unsubscribe)
        .catch((error) => this.host.reportBackgroundError("subagent.drive", error, { taskId }));
      unsubscribe = undefined; // ownership transferred to the driver

      // Foreground budget: block the parent turn for at most
      // subagentTimeoutMs. On expiry the child is NOT killed — it detaches
      // to the background (grok-build-style) and settlement auto-injects a
      // completion notification at the parent's next safe boundary. Racing
      // the driver promise directly (not the async-task-updated stream)
      // means settlement is observed even where the host's stream plumbing
      // is inert, and `driven` resolving guarantees post-settle teardown
      // (worktree cleanup) has finished before we read the record.
      const budgetMs = subagentTimeoutMs(resolveProfile(agent));
      const signal = this.host.signal;
      let timer: ReturnType<typeof setTimeout>;
      let onAbort: () => void;
      const budgetTimer = new Promise<"budget" | "interrupted">((resolve) => {
        timer = setTimeout(() => resolve("budget"), budgetMs);
        timer.unref?.();
        onAbort = () => resolve("interrupted");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      const first = await Promise.race([driven.then(() => "settled" as const), budgetTimer]).finally(() => {
        clearTimeout(timer!);
        signal?.removeEventListener("abort", onAbort!);
      });
      if (first !== "settled") {
        const detachedObs = this.detachForegroundTask(record, taskId, budgetMs);
        if (detachedObs) {
          wtPath = undefined; // worktree now belongs to the live background task
          wtBranch = undefined;
          wtBaseSha = undefined;
          return detachedObs;
        }
        if (first === "interrupted") {
          return { callId: record.id, name: record.name, error: "Foreground waiting was interrupted; the subagent result has not been acknowledged." };
        }
        // Settled right at the buzzer — give the driver a beat to finish
        // teardown, then fall through and read the terminal record.
        await Promise.race([driven, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      wtPath = undefined; // teardown handled by the driver
      wtBranch = undefined;
      wtBaseSha = undefined;
      const settled = this.host.session.asyncTasks?.find((t) => t.id === taskId);
      if (!settled) {
        return { callId: record.id, name: record.name, error: `Subagent ${taskId} settled but its record vanished — likely an eviction race. Retry the dispatch.` };
      }
      // Reading the result here counts as the supervisor's acknowledgement,
      // so the sweep can evict the record after its grace period.
      if (!settled.notifiedAt) settled.notifiedAt = nowIso();
      // Dirty worktrees survive teardown with their pointer intact.
      const wtNote = settled.worktreePath
        ? [
            "",
            "",
            `<worktree>${settled.worktreePath}</worktree>`,
            settled.worktreeBranch ? `<branch>${settled.worktreeBranch}</branch>` : "",
            `<hint>The subagent made changes; the worktree is preserved at the path above for inspection. Run \`git worktree remove --force ${settled.worktreePath}\` once you've reviewed or merged the branch.</hint>`,
          ].filter(Boolean).join("\n")
        : "";
      if (settled.status === "cancelled") {
        return { callId: record.id, name: record.name, error: `Subagent was cancelled before producing a result.${wtNote}` };
      }
      if (settled.status !== "completed") {
        // failed: stale-kill (salvaged self-report rides in result), parked
        // approval, or a turn error — the record carries the details.
        return {
          callId: record.id,
          name: record.name,
          error: `${settled.error ?? `Subagent ${settled.status}.`}${wtNote}${settled.result ? `\n\n${settled.result}` : ""}`,
        };
      }
      return {
        callId: record.id,
        name: record.name,
        output: (settled.result ?? "Subagent completed.") + wtNote,
      };
    } catch (error) {
      // Defensive cleanup for PRE-dispatch failures (worktree creation,
      // spawn, MCP gating). Once the driver has started it owns settlement;
      // finalizing here would race its terminal upsert.
      if (taskId && !driveStarted) {
        const existing = this.host.session.asyncTasks?.find((t) => t.id === taskId);
        if (existing && existing.status === "running") {
          this.upsertAsyncTask({
            ...existing,
            status: "failed",
            completedAt: nowIso(),
            notifiedAt: nowIso(),
            error: errorMessage(error),
          });
        }
        this.children.delete(taskId);
        this.activity.drop(taskId);
      }
      unsubscribe?.();
      if (wtPath && !driveStarted) await this.finalizeSyncWorktree(wtPath, wtBranch, wtBaseSha).catch(() => {});
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  /** Async `start_async_task` — spawn one child; sync mode blocks until
   * it settles, background mode returns the dispatch handle immediately. */
  async startAsync(record: ToolCallRecord): Promise<ToolObservation> {
    // Lifted out of the try so the catch block can release the in-flight
    // dedup slot on the error path (declared inside the try would scope
    // it out of reach of the catch handler).
    let dedupClaimedKey: string | undefined;
    try {
      this.assertDepth();
      const input = record.input as {
        description?: string;
        agent?: string;
        subagentType?: string;
        subagent_type?: string;
        isolate?: "none" | "worktree";
        background?: boolean;
        name?: string;
        fork?: boolean;
        subtaskId?: string;
        skill?: string;
      };
      const description = input.description?.trim();
      if (!description) throw new Error("task requires description");
      const subtaskId = input.subtaskId?.trim() || undefined;
      // Team-mode DAG bind: appended to the dispatch observation so a bad
      // subtaskId surfaces immediately without failing the (still-useful) worker.
      let subtaskBindNote = "";
      const background = input.background === true;
      // Fork mode (P1-4): inherit parent's recent message tail + skills
      // for prompt-cache reuse. Enabled by default; the user can turn it
      // off in desktop Settings → Agents → Parallel subagents (persists
      // to ReinaConfig.subagent.forkEnabled). Daisy-chaining forks (fork
      // of fork) is rejected — depth=1 cap covers it, but a clearer error
      // message is friendlier.
      const wantFork = input.fork === true;
      if (wantFork && !isForkEnabled(this.host.forkEnabled)) {
        throw new Error("Fork mode is disabled in Settings → Agents → Parallel subagents. Toggle it on to allow task({fork: true}).");
      }
      if (wantFork && this.host.session.isFork) {
        throw new Error("A fork cannot spawn another fork (daisy-chaining forks produces incoherent results).");
      }
      const fork = wantFork;
      // Optional named handle: when set, the supervisor can address this
      // child by name in check/update/cancel even after compaction has
      // evicted the original dispatch call. Reject duplicates explicitly
      // rather than silently overwriting.
      let validatedName: string | undefined;
      if (typeof input.name === "string" && input.name.trim().length > 0) {
        const check = validateName(input.name, this.host.session.asyncTasks ?? []);
        if (!check.ok) throw new Error(check.error);
        validatedName = input.name.trim();
      }
      // Brief retry guard: if the same (agent, normalized brief) pair
      // has already failed N times across this session OR a prior
      // process incarnation that wrote session.failedBriefs, refuse.
      const agentForKey = input.agent?.trim() || input.subagentType?.trim() || input.subagent_type?.trim() || "default";
      const briefKey = briefRetryKey(agentForKey, description);
      const priorFailures = this.failedBriefCounts.get(briefKey) ?? 0;
      const cap = maxBriefRetries();
      if (priorFailures >= cap) {
        throw new Error(
          `This brief has already failed ${priorFailures} times for agent "${agentForKey}" (cap ${cap}). Refine the description (be more specific, narrow the scope, change tools) or try a different agent profile — re-firing the same prompt won't help.`,
        );
      }
      // Same-brief dedup. Two cases collapse onto the original child:
      //   1. A prior-turn dispatch for this (agent, brief) is still
      //      `running` in session.asyncTasks. Spawning a second child
      //      for the same brief just doubles cost and produces two
      //      half-cooked answers; better to point the supervisor at
      //      the live task.
      //   2. A sibling start_async_task in the SAME batched assistant
      //      response already claimed this brief synchronously (see
      //      `inFlightDispatches` claim below). Without this check,
      //      concurrent Promise.all dispatches with identical briefs
      //      would each pass the asyncTasks check (neither has
      //      upsertAsyncTask'd yet) and spawn duplicate children.
      // Both paths return a `<status>merged</status>` observation
      // pointing at the original task id; the supervisor reads the
      // result from the original call's observation (batched case) or
      // via check/wait later (cross-turn case).
      const existingLive = this.findLiveDuplicateDispatch(agentForKey, description);
      if (existingLive) {
        return mergedDispatchObservation(record, existingLive.id, `same brief is already ${existingLive.status}`);
      }
      const inFlightTaskId = this.inFlightDispatches.get(briefKey);
      if (inFlightTaskId) {
        return mergedDispatchObservation(record, inFlightTaskId, "same brief dispatched concurrently in this turn");
      }
      // Concurrency cap: refuse new spawns while N children are already running.
      const maxConcurrent = maxConcurrentAsync();
      const inFlight = this.children.size + this.pendingDispatchReservations;
      if (inFlight >= maxConcurrent) {
        throw new Error(
          `Too many concurrent async subagents (${inFlight}/${maxConcurrent}). Inspect existing work with get_async_tasks before spawning more.`,
        );
      }
      // Reservation acquired here is released the moment we either register
      // the child engine or fall into the catch block.
      this.pendingDispatchReservations++;
      const agent = agentForKey;
      const isolate: "none" | "worktree" = input.isolate === "worktree" ? "worktree" : "none";

      // Prefix `sub_` so the ID self-describes as a subagent thread.
      const taskId = `sub_${createId("sub").slice(-8)}`;
      // Claim the dedup slot SYNCHRONOUSLY before the first await below.
      // JS is single-threaded, so any other concurrent start_async_task
      // running through this method in the same Promise.all batch will
      // observe this slot on its early check above and merge instead of
      // spawning a sibling child for the same brief.
      this.inFlightDispatches.set(briefKey, taskId);
      dedupClaimedKey = briefKey;
      let child: AgentEngine;
      let cwd = this.host.cwd;
      let worktreeBranch: string | undefined;
      let worktreePath: string | undefined;
      let worktreeBaseSha: string | undefined;
      let unsubscribe: () => void;
      try {
        // MCP gating (P2-8): wait until the child profile's required
        // MCP servers are connected before provisioning anything.
        // Failure here is preferable to a half-broken dispatch — the
        // child would otherwise hit "tool not registered" errors on
        // its first turn with no clear recovery path.
        await this.host.awaitRequiredMcp(agent);
        if (isolate === "worktree") {
          const wt = await createWorktree(this.host.cwd, taskId);
          cwd = wt.path;
          worktreePath = wt.path;
          worktreeBranch = wt.branch;
          worktreeBaseSha = wt.baseSha;
        }

        child = this.host.spawnChild({ cwd, agent });
        // Fork children keep the parent's model verbatim (cache-namespace
        // constraint — see applySecondaryModel).
        if (!fork) this.applySecondaryModel(child);
        this.wireChildEscalation(taskId, child, validatedName);
        // Fork mode (P1-4): seed the child with the parent's recent
        // message tail + skills snapshot + active deferred tools BEFORE
        // its first runTurn, so the model call's prefix matches the
        // parent's cached prefix. The directive itself gets appended
        // as a normal user message by runTurn (see prompt assembly
        // below) — wrapped in <fork-directive> so the model can tell
        // "the task" apart from the supervisor's own history.
        if (fork) {
          const ctx = buildForkContext(this.host.session);
          child.session.messages = ctx.inheritedMessages;
          child.session.skills = ctx.inheritedSkills;
          child.session.activeDeferredTools = ctx.activeDeferredTools;
          child.session.isFork = true;
          // Forks additionally run in bubble mode: prompt-cache reuse
          // implies the supervisor stays the principal, so the child
          // prompts with supervisor-grade strictness (needsApproval falls
          // through to the profile default even where the parent's own
          // mode would skip). The bubble BRIDGE itself is not fork-only —
          // wireChildEscalation installs it on every child.
          child.session.permissionMode = "bubble";
        }
        // Per-skill model/effort override: when the dispatch declares which
        // skill it executes, record that skill's frontmatter `model:`/`effort:`
        // as the session's modelOverride — merged LAST at request time, so it
        // wins over an AgentProfile.model pin too (writing into session.model
        // directly would be silently clobbered by the profile merge).
        // Unknown skill names are ignored: the directive already carries the
        // body, so the dispatch is still useful on the inherited model.
        const skillName = input.skill?.trim();
        if (skillName) {
          const skillMeta = this.host.session.skills.find((s) => s.name === skillName);
          if (skillMeta && (skillMeta.model || skillMeta.effort)) {
            child.session.modelOverride = {
              ...(skillMeta.model ? { model: skillMeta.model } : {}),
              ...(skillMeta.effort ? { reasoningEffort: skillMeta.effort } : {}),
            };
            pushTrace(this.host.session, "async_task.skill_override", {
              taskId,
              skill: skillName,
              model: skillMeta.model,
              effort: skillMeta.effort,
            });
          }
        }
        const task: AsyncTaskRecord = {
          id: taskId,
          name: validatedName,
          agent: child.session.agent,
          description,
          status: "running",
          startedAt: nowIso(),
          childSessionId: child.session.id,
          isolation: isolate,
          worktreePath,
          worktreeBranch,
          worktreeBaseSha,
          attemptCount: 1,
          lastHeartbeatAt: nowIso(),
          turns: 0,
          toolCalls: 0,
          // Persisted so settlement (driveAsyncChild) can decide whether
          // to push a completion notification onto the injector queue.
          background: background || undefined,
          fork: fork || undefined,
          // Team mode: carried on the record so the settle path can mirror
          // this worker's outcome back onto the DAG node without re-parsing
          // the tool input.
          subtaskId,
        };
        this.upsertAsyncTask(task);
        // The task is now visible in session.asyncTasks, so a follow-up
        // duplicate dispatch will hit the `existingRunning` branch
        // above instead of needing the in-flight slot.
        this.inFlightDispatches.delete(briefKey);
        dedupClaimedKey = undefined;
        this.children.set(taskId, child);
        unsubscribe = this.bridgeChildStream(taskId, child);
        // Team mode: bind the DAG node now so it leaves the ready list this
        // turn (prevents double-dispatch). Best-effort — a bad id is a
        // coordinator typo, surfaced in the observation, not a reason to
        // discard the worker that's already spawned.
        if (subtaskId) {
          const bind = this.host.bindSubtaskToTask?.({ subtaskId, taskId });
          if (bind && !bind.ok) {
            subtaskBindNote = `\n<subtask_bind subtask_id="${subtaskId}" bound="false">${bind.error ?? "unknown subtask"}</subtask_bind>`;
          } else if (bind?.ok) {
            subtaskBindNote = `\n<subtask_bind subtask_id="${subtaskId}" bound="true" />`;
          }
        }
        pushTrace(this.host.session, "async_task.started", { id: taskId, agent, isolation: isolate, subtaskId });
      } finally {
        // Release the cap reservation once the child is registered (or
        // we've bailed out before that).
        this.pendingDispatchReservations = Math.max(0, this.pendingDispatchReservations - 1);
      }

      // driveAsyncChild is always fire-and-forget at the engine level.
      // Profile-level initialPrompt rides on the first user message only;
      // update_async_task follow-ups use the supervisor's new message
      // verbatim (no re-prepend) since they go through pendingTaskUpdates.
      // Fork mode wraps the description in <fork-directive> so the model
      // distinguishes the assigned task from inherited supervisor history.
      const wrapped = fork ? wrapForkDirective(description) : description;
      const firstPrompt = assembleFirstTurnPrompt(resolveProfile(agent), wrapped);
      void this.driveAsyncChild(taskId, child, firstPrompt, unsubscribe)
        .catch((error) => this.host.reportBackgroundError("subagent.drive", error, { taskId }));

      if (background) {
        return {
          callId: record.id,
          name: record.name,
          output: [
            `<async_task>`,
            `<task_id>${taskId}</task_id>`,
            `<agent>${child.session.agent}</agent>`,
            `<isolation>${isolate}</isolation>`,
            worktreePath ? `<worktree>${worktreePath}</worktree>` : "",
            worktreeBranch ? `<branch>${worktreeBranch}</branch>` : "",
            `<status>running</status>`,
            `<background>true</background>`,
            `<hint>Background dispatch. Use get_async_tasks in a LATER turn to inspect the result, or wait_async_tasks to block until settlement.</hint>`,
            `</async_task>`,
          ].filter(Boolean).join("\n") + subtaskBindNote,
        };
      }

      // Sync (default) path: block until this child reaches terminal state,
      // capped by the foreground budget. On expiry the child is NOT killed —
      // it detaches to the background and settlement auto-injects the result.
      const budgetMs = subagentTimeoutMs(resolveProfile(agent));
      await this.waitForTaskTerminal(taskId, budgetMs);
      const detachedObs = this.detachForegroundTask(record, taskId, budgetMs, subtaskBindNote);
      if (detachedObs) return detachedObs;
      const settled = this.host.session.asyncTasks?.find((t) => t.id === taskId);
      if (!settled) {
        return { callId: record.id, name: record.name, error: `Subagent ${taskId} dispatched but its record vanished — likely an internal eviction race. Retry the dispatch.` };
      }
      // Reading a settled task here counts as the supervisor's
      // acknowledgement.
      if (settled.status !== "running" && !settled.notifiedAt) {
        settled.notifiedAt = nowIso();
      }
      if (settled.status === "completed") {
        return {
          callId: record.id,
          name: record.name,
          output: [
            `<async_task>`,
            `<task_id>${settled.id}</task_id>`,
            `<agent>${settled.agent}</agent>`,
            `<status>completed</status>`,
            settled.worktreePath ? `<worktree>${settled.worktreePath}</worktree>` : "",
            settled.worktreeBranch ? `<branch>${settled.worktreeBranch}</branch>` : "",
            settled.usage?.durationMs ? `<duration_ms>${Math.round(settled.usage.durationMs)}</duration_ms>` : "",
            settled.turns ? `<turns>${settled.turns}</turns>` : "",
            settled.toolCalls ? `<tool_calls>${settled.toolCalls}</tool_calls>` : "",
            `<result>${escapeXml(settled.result ?? "Subagent completed without producing a final message.")}</result>`,
            `</async_task>`,
          ].filter(Boolean).join("\n") + subtaskBindNote,
        };
      }
      return {
        callId: record.id,
        name: record.name,
        error: `Subagent ${settled.id} ${settled.status}: ${settled.error ?? "no error details"}`,
      };
    } catch (error) {
      // If we claimed the dedup slot but never reached upsertAsyncTask
      // (e.g. MCP wait or worktree creation threw), release it now so
      // a retry isn't permanently masked by a stale claim.
      if (dedupClaimedKey !== undefined) {
        this.inFlightDispatches.delete(dedupClaimedKey);
      }
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  // ─── Batch fan-out (start_task_batch / check_task_batch) ─────────────────
  // Lightweight analog of codex's Agent Jobs: each item becomes a normal
  // background async task (full existing machinery — watchdog, settle,
  // records, recovery), the batch layer only adds a bounded-concurrency
  // dispatch queue + a grouped progress view. Queue state is in-memory;
  // dispatched workers survive a restart as plain tasks, undispatched
  // items are dropped (check_task_batch says so).

  async startBatch(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      this.assertDepth();
      const input = record.input as {
        items?: unknown;
        briefTemplate?: string;
        agent?: string;
        maxConcurrent?: number;
        isolate?: "none" | "worktree";
      };
      const items = Array.isArray(input.items)
        ? input.items.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
        : [];
      if (items.length === 0) {
        return { callId: record.id, name: record.name, error: "start_task_batch requires items: a non-empty string array" };
      }
      if (items.length > 200) {
        return { callId: record.id, name: record.name, error: `start_task_batch caps at 200 items (got ${items.length}) — split into multiple batches.` };
      }
      const template = typeof input.briefTemplate === "string" && input.briefTemplate.trim().length > 0 ? input.briefTemplate : undefined;
      if (template && !template.includes("{item}")) {
        return { callId: record.id, name: record.name, error: "briefTemplate must contain the {item} placeholder (or be omitted to use each item verbatim)." };
      }
      const batch: BatchState = {
        id: `batch_${createId("batch").slice(-8)}`,
        agent: input.agent?.trim() || "default",
        briefTemplate: template,
        isolate: input.isolate === "worktree" ? "worktree" : "none",
        maxConcurrent: Math.min(8, Math.max(1, Math.floor(input.maxConcurrent ?? 4))),
        pending: [...items],
        taskIds: [],
        dispatchFailures: [],
        createdAt: nowIso(),
        rateLimitRetries: new Map(),
        scheduledRetries: new Set(),
        rateLimitStreak: 0,
      };
      this.batches.set(batch.id, batch);
      pushTrace(this.host.session, "async_task.started", { batchId: batch.id, batch: true, items: items.length });
      await this.pumpBatch(batch);
      return {
        callId: record.id,
        name: record.name,
        output: [
          `<task_batch>`,
          `<batch_id>${batch.id}</batch_id>`,
          `<items>${items.length}</items>`,
          `<dispatched>${batch.taskIds.length}</dispatched>`,
          `<queued>${batch.pending.length}</queued>`,
          batch.dispatchFailures.length > 0 ? `<dispatch_failures>${batch.dispatchFailures.length}</dispatch_failures>` : "",
          batch.taskIds.length > 0 ? `<task_ids>${batch.taskIds.join(",")}</task_ids>` : "",
          `<hint>Queued items launch automatically as workers settle. Poll with check_task_batch("${batch.id}"); block with wait_async_tasks({taskIds:[...]}); read results with get_async_tasks({taskRefs:[...],detail:"full"}).</hint>`,
          `</task_batch>`,
        ].filter(Boolean).join("\n"),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  /** Dispatch queued items while the batch + global windows have room.
   * Called at batch start and again from the settle path each time a
   * member finishes. During a rate-limit cooldown no new dispatches are
   * admitted; a deferred pump is armed so queued items aren't stranded
   * when no further settles arrive to re-trigger the pump. */
  private async pumpBatch(batch: BatchState): Promise<void> {
    const cooldownMs = (batch.cooldownUntil ?? 0) - Date.now();
    if (cooldownMs > 0) {
      if (batch.pending.length > 0) this.armBatchCooldownPump(batch, cooldownMs);
      return;
    }
    while (batch.pending.length > 0) {
      const runningInBatch = (this.host.session.asyncTasks ?? []).filter(
        (t) => t.batchId === batch.id && (t.status === "running" || t.status === "resuming"),
      ).length;
      if (runningInBatch >= batch.maxConcurrent) return;
      if (this.children.size + this.pendingDispatchReservations >= maxConcurrentAsync()) return;
      const item = batch.pending.shift()!;
      await this.dispatchBatchItem(batch, item);
    }
  }

  private async dispatchBatchItem(batch: BatchState, item: string): Promise<void> {
    const description = batch.briefTemplate ? batch.briefTemplate.replaceAll("{item}", item) : item;
    const synthetic = {
      id: `call_${createId("call").slice(-10)}`,
      name: "task",
      input: { description, agent: batch.agent, isolate: batch.isolate, background: true },
      summary: "task",
      permission: "state",
      status: "running",
      createdAt: nowIso(),
    } as unknown as ToolCallRecord;
    const obs = await this.startAsync(synthetic);
    const taskId = (obs.output ?? "").match(/<task_id>(\S+?)<\/task_id>/)?.[1];
    if (obs.error || !taskId) {
      batch.dispatchFailures.push({ item, error: obs.error ?? "dispatch returned no task id" });
      return;
    }
    if (!batch.taskIds.includes(taskId)) batch.taskIds.push(taskId);
    const task = this.host.session.asyncTasks?.find((t) => t.id === taskId);
    // Tag the worker with the batch id and strip the background flag: batch
    // members must NOT each enqueue an injector notification (20 items = 20
    // interruptions) — progress is read via check_task_batch instead.
    if (task && !task.batchId) {
      this.upsertAsyncTask({ ...task, batchId: batch.id, background: undefined });
    }
  }

  /** One deferred pump per cooling-down batch (never stacked). unref'd so a
   * pending timer can't hold the process open. */
  private armBatchCooldownPump(batch: BatchState, waitMs: number): void {
    if (batch.cooldownTimer) return;
    const timer = setTimeout(() => {
      batch.cooldownTimer = undefined;
      if (this.batches.get(batch.id) !== batch) return;
      void this.pumpBatch(batch).catch((error) =>
        this.host.reportBackgroundError("subagent.batch", error, { batchId: batch.id }),
      );
    }, waitMs + 25);
    timer.unref?.();
    batch.cooldownTimer = timer;
  }

  /** kimi AgentSwarm parity: a batch member whose settle was a provider rate
   * limit is re-dispatched (same task id, via the follow-up machinery) after a
   * batch-wide cooldown instead of staying terminal. The cooldown also gates
   * NEW dispatches (pumpBatch), so the whole batch backs off together. Returns
   * true when a retry was scheduled — the caller then skips the brief-failure
   * counter, since a saturated provider says nothing about the brief. */
  private maybeRequeueRateLimited(updated: AsyncTaskRecord): boolean {
    if (!updated.batchId) return false;
    const batch = this.batches.get(updated.batchId);
    if (!batch || !isRateLimitedSettle(updated)) return false;
    const used = batch.rateLimitRetries.get(updated.id) ?? 0;
    if (used >= BATCH_RATE_LIMIT_MAX_RETRIES) return false;
    batch.rateLimitRetries.set(updated.id, used + 1);
    batch.rateLimitStreak += 1;
    const cooldownMs = batchRateLimitCooldownMs(batch.rateLimitStreak);
    batch.cooldownUntil = Math.max(batch.cooldownUntil ?? 0, Date.now() + cooldownMs);
    batch.scheduledRetries.add(updated.id);
    const expectedAttempt = updated.attemptCount ?? 1;
    const timer = setTimeout(() => this.fireRateLimitedRetry(batch, updated.id, expectedAttempt), cooldownMs);
    timer.unref?.();
    return true;
  }

  /** Cooldown expired — re-open the rate-limited member if nothing changed it
   * in the meantime (manual re-open bumps attemptCount; cancellation/eviction
   * drops the record). At the global concurrency ceiling the retry re-arms
   * rather than dropping. */
  private fireRateLimitedRetry(batch: BatchState, taskId: string, expectedAttempt: number): void {
    if (this.batches.get(batch.id) !== batch) return;
    const task = this.host.session.asyncTasks?.find((t) => t.id === taskId);
    if (
      !task ||
      task.batchId !== batch.id ||
      (task.attemptCount ?? 1) !== expectedAttempt ||
      (task.status !== "failed" && task.status !== "completed")
    ) {
      batch.scheduledRetries.delete(taskId);
      return;
    }
    if (this.children.size + this.pendingDispatchReservations >= maxConcurrentAsync()) {
      const timer = setTimeout(() => this.fireRateLimitedRetry(batch, taskId, expectedAttempt), 5_000);
      timer.unref?.();
      return;
    }
    batch.scheduledRetries.delete(taskId);
    try {
      this.followUpSettledTask(task, RATE_LIMIT_RETRY_MESSAGE);
    } catch (error) {
      this.host.reportBackgroundError("subagent.batch", error, { taskId, batchId: batch.id });
      return;
    }
    // followUpSettledTask marks the attempt background:true (auto-inject on
    // settle) — batch members must stay poll-only, same as dispatchBatchItem.
    const reopened = this.host.session.asyncTasks?.find((t) => t.id === taskId);
    if (reopened?.background) this.upsertAsyncTask({ ...reopened, background: undefined });
    pushTrace(this.host.session, "async_task.started", {
      id: taskId,
      batchId: batch.id,
      rateLimitRetry: batch.rateLimitRetries.get(taskId) ?? 0,
    });
  }

  checkBatch(record: ToolCallRecord): ToolObservation {
    const input = record.input as { batchId?: string };
    const id = input.batchId?.trim();
    if (!id) return { callId: record.id, name: record.name, error: "check_task_batch requires batchId" };
    const batch = this.batches.get(id);
    const members = (this.host.session.asyncTasks ?? []).filter((t) => t.batchId === id);
    if (!batch && members.length === 0) {
      return { callId: record.id, name: record.name, error: `no such batch: ${id} (batch queue state does not survive an engine restart; dispatched workers, if any, appear in get_async_tasks as normal tasks)` };
    }
    const counts: Record<string, number> = {};
    for (const t of members) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const queued = batch?.pending.length ?? 0;
    const settledLines = members
      .filter((t) => isTaskTerminal(t))
      .map((t) => {
        const outcome = t.status === "completed" ? (t.result ?? "").slice(0, 120) : (t.error ?? "").slice(0, 120);
        return `  [${t.status}] ${t.id} — ${t.description.slice(0, 60)}${t.description.length > 60 ? "…" : ""}${outcome ? ` → ${outcome}` : ""}`;
      });
    const failures = (batch?.dispatchFailures ?? []).map((f) => `  [dispatch-failed] ${f.item.slice(0, 60)} — ${f.error.slice(0, 120)}`);
    // Members with a rate-limit retry armed look terminal but are about to
    // re-open — the batch is not done until those retries have played out.
    const retryPending = batch?.scheduledRetries.size ?? 0;
    const coolingMs = Math.max(0, (batch?.cooldownUntil ?? 0) - Date.now());
    const allDone = queued === 0 && retryPending === 0 && members.length > 0 && members.every((t) => isTaskTerminal(t));
    return {
      callId: record.id,
      name: record.name,
      output: [
        `<task_batch>`,
        `<batch_id>${id}</batch_id>`,
        `<done>${allDone}</done>`,
        `<counts>${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}</counts>`,
        `<queued>${queued}</queued>`,
        retryPending > 0 || coolingMs > 0
          ? `<note>provider rate-limited: ${retryPending} member${retryPending === 1 ? "" : "s"} awaiting automatic retry${coolingMs > 0 ? `, dispatch paused ~${Math.ceil(coolingMs / 1000)}s` : ""} — do not re-dispatch these manually</note>`
          : "",
        !batch ? `<note>batch queue state was lost (engine restart); showing dispatched workers only</note>` : "",
        settledLines.length > 0 ? `<settled>\n${settledLines.join("\n")}\n</settled>` : "",
        failures.length > 0 ? `<dispatch_failures>\n${failures.join("\n")}\n</dispatch_failures>` : "",
        allDone
          ? `<hint>All members settled — get_async_tasks({taskRefs:[${members.map((t) => `"${t.id}"`).join(",")}],detail:"full"}) for full bodies.</hint>`
          : `<hint>Still working. wait_async_tasks({taskIds:[...]}) blocks until members settle; queued items launch as slots free up.</hint>`,
        `</task_batch>`,
      ].filter(Boolean).join("\n"),
    };
  }

  /** `check_async_task` — single-task status snapshot. Accepts either the
   * raw `task_<id>` or the name assigned at start_async_task time. */
  async check(record: ToolCallRecord): Promise<ToolObservation> {
    const input = record.input as { taskId?: string; taskRef?: string };
    const ref = input.taskRef ?? input.taskId;
    if (!ref) return { callId: record.id, name: record.name, error: "check_async_task requires taskId (id or assigned name)" };
    const task = resolveTaskRef(ref, this.host.session);
    if (!task) return { callId: record.id, name: record.name, error: `no such task: ${ref}` };
    this.acknowledgeCompletion(task);
    const snapshot = task.status === "running"
      ? await this.readActivity(task.id)
      : undefined;
    return { callId: record.id, name: record.name, output: formatAsyncTaskStatus(task, snapshot) };
  }

  /** Canonical non-blocking read API. The three legacy read tools remain
   * registered for rollout compatibility; new model turns select their view
   * through one stable schema instead. */
  async get(record: ToolCallRecord): Promise<ToolObservation> {
    const input = record.input as { taskRefs?: unknown; detail?: unknown };
    const detail = input.detail;
    if (detail !== "headers" && detail !== "activity" && detail !== "full") {
      return {
        callId: record.id,
        name: record.name,
        error: "get_async_tasks requires detail: headers, activity, or full",
      };
    }
    const taskRefs = Array.isArray(input.taskRefs)
      ? input.taskRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : typeof input.taskRefs === "string" && input.taskRefs.trim().length > 0
        ? [input.taskRefs]
        : undefined;
    const all = this.host.session.asyncTasks ?? [];
    const rosterRefs = all
      .filter((task) => !task.sync || task.status === "running")
      .map((task) => task.id);

    if (detail === "headers") {
      return this.list({ ...record, input: taskRefs ? { taskRefs } : {} });
    }
    if (detail === "full") {
      const refs = taskRefs ?? rosterRefs;
      if (refs.length === 0) {
        return { callId: record.id, name: record.name, output: '<async_tasks_summary count="0">No tasks in this session.</async_tasks_summary>' };
      }
      const taskIds = refs.map((ref) => resolveTaskRef(ref, this.host.session)?.id ?? ref);
      return this.gather({ ...record, input: { taskIds } });
    }

    const refs = taskRefs ?? rosterRefs;
    if (refs.length === 0) {
      return { callId: record.id, name: record.name, output: "<async_task_activity count=\"0\">No tasks yet.</async_task_activity>" };
    }
    const bodies: string[] = [];
    for (const ref of refs) {
      const task = resolveTaskRef(ref, this.host.session);
      if (!task) {
        bodies.push(`<async_task ref="${escapeXml(ref)}" missing="true" />`);
        continue;
      }
      const observation = await this.check({ ...record, input: { taskRef: task.id } });
      bodies.push(observation.output ?? `<async_task ref="${escapeXml(ref)}"><error>${escapeXml(observation.error ?? "unknown read error")}</error></async_task>`);
    }
    return {
      callId: record.id,
      name: record.name,
      output: [`<async_task_activity count="${refs.length}">`, ...bodies, "</async_task_activity>"].join("\n"),
    };
  }

  /** `update_async_task` — interrupt + queue follow-up message. Accepts
   * either the raw `task_<id>` or the assigned name. When the target
   * is recoverable (process restart wiped the child engine), acquires
   * a lease and spawns a fresh child driven with a resume prompt that
   * pairs the original brief with the new message. */
  update(record: ToolCallRecord, sender: "user" | "supervisor" = "supervisor"): ToolObservation {
    const input = record.input as { taskId?: unknown; taskRef?: unknown; message?: unknown } | undefined;
    const rawRef = input?.taskRef ?? input?.taskId;
    const ref = typeof rawRef === "string" ? rawRef.trim() : "";
    const newMessage = typeof input?.message === "string" ? input.message.trim() : "";
    if (!ref) return { callId: record.id, name: record.name, error: "update_async_task requires taskId (id or assigned name)" };
    if (!newMessage) return { callId: record.id, name: record.name, error: "update_async_task requires message" };
    const task = resolveTaskRef(ref, this.host.session);
    if (!task) return { callId: record.id, name: record.name, error: `no such task: ${ref}` };
    if (isResumable(task)) {
      const leased = this.prepareResumeAttempt(task);
      if (!leased) {
        return { callId: record.id, name: record.name, error: `Task ${task.id} is already being resumed by another worker. Check it again before retrying.` };
      }
      // Resume path (P1-6): spawn a fresh child and drive it with the
      // resume prompt. The child does NOT inherit the dead child's
      // conversation — that state was lost with the previous process.
      // Worktree (if any) is reused so any half-finished work on disk
      // is visible to the resumed run.
      try {
        this.resumeRecoverable(leased, newMessage, sender);
      } catch (error) {
        this.upsertAsyncTask({ ...task, leaseOwner: undefined, leaseExpiresAt: undefined });
        return { callId: record.id, name: record.name, error: `Could not resume task ${task.id}: ${errorMessage(error)}` };
      }
      pushTrace(this.host.session, "async_task.started", { id: task.id, resume: true });
      return { callId: record.id, name: record.name, output: `Resuming recoverable task ${task.id}${task.name ? ` (${task.name})` : ""} with a fresh child attempt. The child will see the original brief plus your new message and must re-orient from durable evidence.` };
    }
    // Settled follow-up (codex V2 resume parity): a completed/failed/
    // cancelled task can be re-opened with a new message. A fresh child is
    // seeded with the original brief + the prior outcome + the follow-up,
    // and the record continues under the same task id (attemptCount+1).
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      const maxConcurrent = maxConcurrentAsync();
      const inFlight = this.children.size + this.pendingDispatchReservations;
      if (inFlight >= maxConcurrent) {
        return { callId: record.id, name: record.name, error: `Too many concurrent async subagents (${inFlight}/${maxConcurrent}) — cannot re-open ${task.id} right now. Wait for a task to finish first.` };
      }
      this.followUpSettledTask(task, newMessage, sender);
      pushTrace(this.host.session, "async_task.started", { id: task.id, followUp: true });
      return {
        callId: record.id,
        name: record.name,
        output: `Re-opened settled task ${task.id}${task.name ? ` (${task.name})` : ""} (attempt ${Math.max(1, task.attemptCount ?? 1) + 1}). A fresh child sees the original brief, the previous outcome, and your follow-up; it has no hidden memory of the previous run. The result will be injected automatically when it settles.`,
      };
    }
    if (task.status !== "running") {
      return { callId: record.id, name: record.name, error: resumeRefusalMessage(task) };
    }
    const child = this.children.get(task.id);
    if (!child) {
      return { callId: record.id, name: record.name, error: `Task ${task.id} is marked running but the child engine is gone — likely a stale record from a previous process. Use task to re-fire.` };
    }
    // Queue the update first, then interrupt — driveAsyncChild's catch
    // path checks the queue under disposition === "cancelled" to decide
    // whether to settle or re-loop.
    this.enqueueTaskUpdate(task.id, newMessage);
    this.emitTaskMessage(task.id, newMessage, sender);
    child.interrupt();
    pushTrace(this.host.session, "async_task.started", { id: task.id, update: true });
    return { callId: record.id, name: record.name, output: `Update queued for ${task.id}${task.name ? ` (${task.name})` : ""}. The subagent's current turn is being interrupted; it will start a new turn with your message.` };
  }

  /** Re-open a settled task with a follow-up message. Fresh child, same
   * task id, attemptCount+1. The child gets the original brief + the prior
   * outcome + the follow-up (no hidden memory — child engines are not
   * persisted). background:true so settlement auto-injects the new result
   * instead of waiting to be polled. */
  private followUpSettledTask(task: AsyncTaskRecord, newMessage: string, sender?: "user" | "supervisor"): void {
    const cwd = task.worktreePath ?? this.host.cwd;
    const child = this.host.spawnChild({ cwd, agent: task.agent });
    if (!task.fork) this.applySecondaryModel(child);
    this.wireChildEscalation(task.id, child, task.name);
    const reopened: AsyncTaskRecord = {
      ...task,
      status: "running",
      childSessionId: child.session.id,
      error: undefined,
      result: undefined,
      completedAt: undefined,
      notifiedAt: undefined,
      injectedAt: undefined,
      lastHeartbeatAt: nowIso(),
      attemptCount: Math.max(1, task.attemptCount ?? 1) + 1,
      background: true,
    };
    this.upsertAsyncTask(reopened, { allowReopen: true });
    this.children.set(task.id, child);
    const unsubscribe = this.bridgeChildStream(task.id, child);
    if (task.result) {
      this.taskStreams.get(task.id)?.emit({
        type: "task-turn-completed",
        id: `prior-${task.id}-${task.attemptCount ?? 1}`,
        text: task.result,
        createdAt: task.completedAt ?? nowIso(),
      });
    }
    if (sender) this.emitTaskMessage(task.id, newMessage, sender);
    const prompt = buildFollowUpPrompt(
      { description: task.description, status: task.status, result: task.result, error: task.error },
      newMessage,
      { taskId: task.id, attemptCount: reopened.attemptCount },
    );
    void this.driveAsyncChild(task.id, child, prompt, unsubscribe)
      .catch((error) => this.host.reportBackgroundError("subagent.drive", error, { taskId: task.id }));
  }

  private enqueueTaskUpdate(taskId: string, message: string): void {
    const id = this.host.enqueueAsyncTaskUpdate?.({ taskId, message });
    if (id) return;
    const existing = this.pendingTaskUpdates.get(taskId);
    this.pendingTaskUpdates.set(taskId, existing ? `${existing}\n\n${message}` : message);
  }

  private claimQueuedTaskUpdates(taskId: string): QueuedTaskUpdate[] {
    const leaseOwner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const durable = this.host.claimAsyncTaskUpdates?.({ taskId, leaseOwner, leaseExpiresAt, limit: 16 }) ?? [];
    const updates: QueuedTaskUpdate[] = durable.map((update: AsyncTaskUpdateRecord) => ({
      id: update.id,
      message: update.message,
    }));
    const fallback = this.pendingTaskUpdates.get(taskId);
    if (fallback !== undefined) {
      this.pendingTaskUpdates.delete(taskId);
      updates.push({ message: fallback });
    }
    return updates;
  }

  private markQueuedTaskUpdatesApplied(updates: QueuedTaskUpdate[]): void {
    const updateIds = updates.map((update) => update.id).filter((id): id is string => Boolean(id));
    if (updateIds.length === 0) return;
    this.host.markAsyncTaskUpdatesApplied?.({ updateIds });
  }

  private dropQueuedTaskUpdates(taskId: string, reason: string): void {
    this.pendingTaskUpdates.delete(taskId);
    this.host.dropPendingAsyncTaskUpdates?.({ taskId, reason });
  }

  private prepareResumeAttempt(task: AsyncTaskRecord): AsyncTaskRecord | undefined {
    const now = nowIso();
    if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.parse(now)) {
      return undefined;
    }
    const leaseOwner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.host.persistAsyncTask?.({
      task,
      eventType: "task.resume_requested",
      payload: { status: task.status },
    });
    const wonLease = this.host.tryAcquireAsyncTaskLease?.({ taskId: task.id, leaseOwner, leaseExpiresAt }) ?? true;
    if (!wonLease) return undefined;
    const attemptCount = Math.max(1, task.attemptCount ?? 1) + 1;
    const resumeCount = (task.resumeCount ?? 0) + 1;
    const updated: AsyncTaskRecord = {
      ...task,
      status: "resuming",
      attemptCount,
      resumeCount,
      leaseOwner,
      leaseExpiresAt,
      recovery: {
        status: "resuming",
        reason: task.recovery?.reason ?? "Recoverable task is being resumed by a fresh child attempt.",
        checkedAt: now,
        worktreeStatus: task.recovery?.worktreeStatus,
        leaseOwner,
        leaseExpiresAt,
      },
    };
    this.upsertAsyncTask(updated);
    return updated;
  }

  /** Spawn a fresh child for a recoverable task and drive it with the
   * resume prompt. Wired from `update` when the target task is
   * `isResumable(task)`. Mutates the original record back to
   * `running`, swaps in the new child, and reuses the worktree if
   * one was provisioned for the prior run. */
  private resumeRecoverable(task: AsyncTaskRecord, newMessage: string, sender: "user" | "supervisor" = "supervisor"): void {
    const cwd = task.worktreePath ?? this.host.cwd;
    const child = this.host.spawnChild({ cwd, agent: task.agent });
    if (!task.fork) this.applySecondaryModel(child);
    this.wireChildEscalation(task.id, child, task.name);
    const resumed: AsyncTaskRecord = {
      ...task,
      status: "running",
      childSessionId: child.session.id,
      error: undefined,
      completedAt: undefined,
      injectedAt: undefined,
      lastHeartbeatAt: nowIso(),
      recovery: {
        status: "resuming",
        reason: task.recovery?.reason ?? "Fresh child attempt started for recovered task.",
        checkedAt: nowIso(),
        worktreeStatus: task.recovery?.worktreeStatus,
        leaseOwner: task.leaseOwner,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    };
    this.upsertAsyncTask(resumed);
    this.children.set(task.id, child);
    const unsubscribe = this.bridgeChildStream(task.id, child);
    this.emitTaskMessage(task.id, newMessage, sender);
    const prompt = buildResumePrompt(task.description, newMessage, {
      forkContextLost: task.forkContextLost,
      worktreeStatus: task.recovery?.worktreeStatus,
      recoveryReason: task.recovery?.reason ?? task.error,
      taskId: task.id,
      attemptCount: resumed.attemptCount,
    });
    void this.driveAsyncChild(task.id, child, prompt, unsubscribe)
      .catch((error) => this.host.reportBackgroundError("subagent.drive", error, { taskId: task.id }));
  }

  /** `cancel_async_task` — request cancellation. Accepts either the raw
   * `task_<id>` or the assigned name. */
  cancel(record: ToolCallRecord): ToolObservation {
    const input = record.input as { taskId?: string; taskRef?: string };
    const ref = input.taskRef ?? input.taskId;
    if (!ref) return { callId: record.id, name: record.name, error: "cancel_async_task requires taskId (id or assigned name)" };
    const task = resolveTaskRef(ref, this.host.session);
    if (!task) return { callId: record.id, name: record.name, error: `no such task: ${ref}` };
    if (task.status !== "running") {
      return { callId: record.id, name: record.name, output: `Task ${task.id} is already ${task.status}.` };
    }
    const child = this.children.get(task.id);
    child?.interrupt();
    // We don't flip status to "cancelled" here — driveAsyncChild detects
    // the interrupt and writes the final record.
    return { callId: record.id, name: record.name, output: `Cancellation requested for ${task.id}${task.name ? ` (${task.name})` : ""}.` };
  }

  /** `list_async_tasks` — header roster. By default, sync tasks
   * that have already settled are filtered out (the supervisor saw
   * their result on the same turn they ran). Pass
   * `include_sync: true` to see them. */
  list(record: ToolCallRecord): ToolObservation {
    const input = record.input as { include_sync?: boolean; taskRefs?: string[] } | undefined;
    const includeSync = input?.include_sync === true;
    const all = this.host.session.asyncTasks ?? [];
    const requested = input?.taskRefs?.length
      ? input.taskRefs.map((ref) => ({ ref, task: resolveTaskRef(ref, this.host.session) }))
      : undefined;
    const tasks = requested
      ? requested.flatMap(({ task }) => task ? [task] : [])
      : all.filter((task) => {
          if (!task.sync) return true;
          if (includeSync) return true;
          // Hide sync tasks that have already settled — they pollute the
          // roster with one-off blocking dispatches. A still-running sync
          // task is shown because the supervisor (or a UI watcher) may
          // want to cancel it.
          return task.status === "running";
        });
    if (tasks.length === 0) {
      const missing = requested?.map(({ ref }) => `  [missing] ${ref}`).join("\n");
      return {
        callId: record.id,
        name: record.name,
        output: missing ? `<async_tasks count="0">\n${missing}\n</async_tasks>` : "<async_tasks>No tasks yet.</async_tasks>",
      };
    }
    const body = [
      ...tasks.map((task) => `  [${task.status}] ${task.id}${task.name ? ` (${task.name})` : ""}${task.sync ? " (sync)" : ""} agent=${task.agent} turns=${task.turns ?? 0} tools=${task.toolCalls ?? 0} desc=${task.description.slice(0, 80)}${task.description.length > 80 ? "…" : ""}`),
      ...(requested ?? []).filter(({ task }) => !task).map(({ ref }) => `  [missing] ${ref}`),
    ].join("\n");
    return { callId: record.id, name: record.name, output: `<async_tasks count="${tasks.length}">\n${body}\n</async_tasks>` };
  }

  /** `gather_async_tasks` — full bodies of multiple tasks in one shot. */
  gather(record: ToolCallRecord): ToolObservation {
    const input = record.input as { taskIds?: string[] };
    const all = this.host.session.asyncTasks ?? [];
    type Item = { kind: "present"; task: AsyncTaskRecord } | { kind: "missing"; id: string };
    let items: Item[];
    if (input.taskIds?.length) {
      items = input.taskIds.map((id): Item => {
        const found = all.find((task) => task.id === id);
        return found ? { kind: "present", task: found } : { kind: "missing", id };
      });
    } else {
      items = all.map((task): Item => ({ kind: "present", task }));
    }

    if (items.length === 0) {
      return { callId: record.id, name: record.name, output: `<async_tasks_summary count="0">No tasks in this session.</async_tasks_summary>` };
    }

    const counts: Record<string, number> = { missing: 0 };
    const totalUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 0 };
    const bodies: string[] = [];
    for (const item of items) {
      if (item.kind === "missing") {
        counts.missing += 1;
        bodies.push(`<task id="${item.id}" missing="true" />`);
        continue;
      }
      const t = item.task;
      counts[t.status] = (counts[t.status] ?? 0) + 1;
      this.acknowledgeCompletion(t);
      if (t.usage) {
        totalUsage.inputTokens += t.usage.inputTokens;
        totalUsage.outputTokens += t.usage.outputTokens;
        totalUsage.cachedInputTokens += t.usage.cachedInputTokens;
        totalUsage.reasoningTokens += t.usage.reasoningTokens;
        totalUsage.durationMs += t.usage.durationMs;
      }
      const parts: string[] = [];
      parts.push(`<task id="${t.id}" agent="${t.agent}" status="${t.status}">`);
      parts.push(`<description>${escapeXml(t.description)}</description>`);
      if (t.result) parts.push(`<result>${escapeXml(t.result)}</result>`);
      if (t.error) parts.push(`<error>${escapeXml(t.error)}</error>`);
      if (typeof t.turns === "number") parts.push(`<turns>${t.turns}</turns>`);
      if (typeof t.toolCalls === "number") parts.push(`<tool_calls>${t.toolCalls}</tool_calls>`);
      if (t.usage) {
        const u = t.usage;
        const totalTokens = u.inputTokens + u.outputTokens;
        parts.push(
          `<usage input_tokens="${u.inputTokens}" output_tokens="${u.outputTokens}" cached_input_tokens="${u.cachedInputTokens}" reasoning_tokens="${u.reasoningTokens}" total_tokens="${totalTokens}" duration_ms="${u.durationMs}" />`,
        );
      }
      parts.push(`</task>`);
      bodies.push(parts.join("\n"));
    }

    const totalTokens = totalUsage.inputTokens + totalUsage.outputTokens;
    const headerAttrs = [
      `count="${items.length}"`,
      `running="${counts.running ?? 0}"`,
      `completed="${counts.completed ?? 0}"`,
      `failed="${counts.failed ?? 0}"`,
      `cancelled="${counts.cancelled ?? 0}"`,
    ];
    for (const status of ["evicted", "orphaned", "recoverable", "needs_attention", "resuming", "failed_unrecoverable"]) {
      if ((counts[status] ?? 0) > 0) headerAttrs.push(`${status}="${counts[status]}"`);
    }
    if ((counts.missing ?? 0) > 0) headerAttrs.push(`missing="${counts.missing}"`);
    const usageLine = `<total_usage input_tokens="${totalUsage.inputTokens}" output_tokens="${totalUsage.outputTokens}" cached_input_tokens="${totalUsage.cachedInputTokens}" reasoning_tokens="${totalUsage.reasoningTokens}" total_tokens="${totalTokens}" duration_ms="${totalUsage.durationMs}" />`;
    return {
      callId: record.id,
      name: record.name,
      output: [`<async_tasks_summary ${headerAttrs.join(" ")}>`, usageLine, ...bodies, `</async_tasks_summary>`].join("\n"),
    };
  }

  /** `wait_async_tasks` — wait for target settlement or a session completion. */
  async wait(record: ToolCallRecord): Promise<ToolObservation> {
    const input = record.input as { taskIds?: string[]; timeoutMs?: number; until?: string };
    // until:"activity" resolves on the FIRST sign of life from any watched
    // task (stream event or status flip) instead of requiring full terminal
    // settlement — codex wait_agent's mailbox-activity semantics. Default
    // stays "terminal" (existing behavior).
    const untilActivity = input.until === "activity";
    const untilAny = input.until === "any";
    const signal = this.host.signal;
    const taskEvents = this.host.taskEvents;
    const interrupted = (): ToolObservation => ({
      callId: record.id,
      name: record.name,
      error: "Waiting interrupted. Background tasks continue running; their results have not been acknowledged.",
    });
    if (signal?.aborted) return interrupted();
    const all = this.host.session.asyncTasks ?? [];

    const userSpecifiedIds = (input.taskIds?.length ?? 0) > 0;
    const targetIds: string[] = userSpecifiedIds
      ? input.taskIds!
      // Default: wait on every CURRENTLY-running task.
      : all.filter((t) => t.status === "running" || t.status === "resuming").map((t) => t.id);

    const gatherForResult = (): ToolObservation =>
      this.gather({
        ...record,
        input: userSpecifiedIds
          ? { ...(input as Record<string, unknown>), taskIds: targetIds }
          : input,
      });

    if (targetIds.length === 0) {
      return gatherForResult();
    }

    const isTerminal = (id: string): boolean => {
      const t = (this.host.session.asyncTasks ?? []).find((x) => x.id === id);
      if (!t) return true;
      return t.status !== "running" && t.status !== "resuming";
    };
    const targetsReady = (): boolean => untilAny ? targetIds.some(isTerminal) : targetIds.every(isTerminal);

    if (targetsReady() || taskEvents?.hasPending()) {
      return gatherForResult();
    }

    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? 600_000, 1_000),
      1_800_000,
    );

    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      let unsubscribeTaskEvents = (): void => undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeTaskEvents();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      unsubscribe = this.host.onStream((event) => {
        if (untilActivity && event.type === "subagent-event") {
          const taskId = (event as { taskId?: string }).taskId;
          if (taskId && targetIds.includes(taskId)) finish();
          return;
        }
        if (event.type !== "async-task-updated") return;
        if (!targetIds.includes(event.task.id)) return;
        if (untilActivity) {
          finish();
          return;
        }
        if (targetsReady()) finish();
      });
      unsubscribeTaskEvents = taskEvents?.subscribe(finish) ?? unsubscribeTaskEvents;
      // Race guard: a task may have flipped terminal in the microtask
      // window between the initial check and the listener registration.
      if (signal?.aborted || taskEvents?.hasPending() || targetsReady()) finish();
    });

    if (signal?.aborted) return interrupted();
    return gatherForResult();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /** Manual result reads consume the same completion as automatic delivery.
   * Persist the acknowledgement so recovery cannot replay an already read result. */
  private acknowledgeCompletion(task: AsyncTaskRecord): void {
    if (!isTaskTerminal(task)) return;
    const changed = !task.notifiedAt || (task.background && !task.injectedAt);
    const stamp = nowIso();
    task.notifiedAt ??= stamp;
    if (task.background) {
      this.injector.remove(task.id);
      task.injectedAt ??= stamp;
    }
    if (changed) this.upsertAsyncTask(task);
  }

  /** Last wall-clock time sweepEvictable actually ran. The debounce
   * gate (maybeSweep) checks this to avoid O(n²) sweeps from every
   * upsert in long sessions. */
  private lastSweepAt = 0;

  /** Debounced entry point — call freely from upsertAsyncTask without
   * worrying about sweep cost. Forces a sweep when the live array
   * exceeds the cap (we can't defer the archive eviction safely,
   * unbounded growth would defeat the cap). */
  private maybeSweep(): void {
    const now = Date.now();
    const session = this.host.session;
    const overCap = (session.asyncTasks?.length ?? 0) > maxLiveAsyncTasks();
    if (overCap || now - this.lastSweepAt >= SWEEP_DEBOUNCE_MS) {
      this.lastSweepAt = now;
      this.sweepEvictable();
    }
  }

  /** Drop terminal-state async tasks the supervisor has already
   * acknowledged after a 10-minute grace period, then archive overflow.
   *
   * Archive policy: when the live roster (post grace-sweep) is still
   * above MAX_LIVE_ASYNC_TASKS, move the oldest notifiedAt entries to
   * session.asyncTasksArchived until under cap. Running tasks and not-
   * yet-notified terminal tasks are NEVER archived — they're the
   * supervisor's outstanding work. */
  private sweepEvictable(): void {
    const session = this.host.session;
    if (!session.asyncTasks?.length) return;
    const cutoff = Date.now() - TASK_EVICTION_GRACE_MS;
    const before = session.asyncTasks.length;
    session.asyncTasks = session.asyncTasks.filter((task) => {
      if (!isTaskTerminal(task)) return true;
      if (!task.notifiedAt) return true;
      return Date.parse(task.notifiedAt) > cutoff;
    });
    const removed = before - session.asyncTasks.length;
    if (removed > 0) {
      pushTrace(session, "async_task.completed", { sweep: true, removed });
    }
    // Archive cap enforcement — separate from the grace-eviction above
    // because archived tasks SURVIVE (in asyncTasksArchived) whereas
    // grace-evicted ones are dropped entirely.
    const cap = maxLiveAsyncTasks();
    if (session.asyncTasks.length <= cap) return;
    // Sort archivable candidates by notifiedAt ASC (oldest first); only
    // notified terminal tasks are eligible.
    const candidates = session.asyncTasks
      .map((task, idx) => ({ task, idx }))
      .filter(({ task }) => isTaskTerminal(task) && task.notifiedAt)
      .sort((a, b) => Date.parse(a.task.notifiedAt!) - Date.parse(b.task.notifiedAt!));
    const overflow = session.asyncTasks.length - cap;
    const toArchive = candidates.slice(0, overflow).map((entry) => entry.task);
    if (toArchive.length === 0) return;
    session.asyncTasksArchived ??= [];
    const archivedIds = new Set<string>();
    for (const task of toArchive) {
      task.archived = true;
      session.asyncTasksArchived.push(task);
      archivedIds.add(task.id);
      // Single rollout record per archived task so a future load can
      // reconstruct without scanning the rollout for old async_task
      // events.
      this.host.record({ type: "async_task_update", task });
    }
    session.asyncTasks = session.asyncTasks.filter((task) => !archivedIds.has(task.id));
    pushTrace(session, "async_task.completed", { archived: toArchive.length, ids: toArchive.map((t) => t.id) });
  }

  /** Subscribe to async-task-updated events and resolve when the named
   * task reaches a terminal status, or the timeout fires. Push-based. */
  private waitForTaskTerminal(taskId: string, timeoutMs: number): Promise<void> {
    const signal = this.host.signal;
    return new Promise<void>((resolve) => {
      const isTerminal = (): boolean => {
        const t = (this.host.session.asyncTasks ?? []).find((x) => x.id === taskId);
        if (!t) return true;
        return t.status !== "running" && t.status !== "resuming";
      };
      if (signal?.aborted || isTerminal()) {
        resolve();
        return;
      }
      let settled = false;
      let unsubscribe = (): void => undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1_000, timeoutMs));
      signal?.addEventListener("abort", finish, { once: true });
      unsubscribe = this.host.onStream((event) => {
        if (event.type !== "async-task-updated") return;
        if (event.task.id !== taskId) return;
        if (isTerminal()) finish();
      });
      if (signal?.aborted || isTerminal()) finish();
    });
  }

  /** Foreground budget expired with the child still working: flip the task
   * to background semantics instead of killing it (the "don't hard-kill a
   * working child" contract — grok-build's backgrounding, improved by the
   * injector auto-notifying the supervisor when the task settles). Returns
   * null when the task actually settled in the meantime — the caller then
   * re-reads the terminal record and returns the real result. */
  private detachForegroundTask(
    record: ToolCallRecord,
    taskId: string,
    budgetMs: number,
    extraNote = "",
  ): ToolObservation | null {
    const fresh = this.host.session.asyncTasks?.find((t) => t.id === taskId);
    if (!fresh || fresh.status !== "running") return null;
    // Synchronous read-modify-write: no await between the read above and
    // this upsert, so the driver's terminal upsert can't interleave here
    // and get rolled back to `running`.
    this.upsertAsyncTask({ ...fresh, background: true });
    pushTrace(this.host.session, "async_task.backgrounded", { id: taskId, budgetMs });
    return {
      callId: record.id,
      name: record.name,
      output: [
        `<async_task>`,
        `<task_id>${taskId}</task_id>`,
        `<agent>${fresh.agent}</agent>`,
        fresh.worktreePath ? `<worktree>${fresh.worktreePath}</worktree>` : "",
        fresh.worktreeBranch ? `<branch>${fresh.worktreeBranch}</branch>` : "",
        `<status>running</status>`,
        `<background>true</background>`,
        `<hint>${this.host.session.interrupted || this.host.signal?.aborted ? "Foreground waiting was interrupted" : `Foreground budget (${Math.round(budgetMs / 1000)}s) elapsed`}; the subagent keeps working in the background. Its result will be injected automatically when it settles — or inspect with get_async_tasks, steer with update_async_task, cancel with cancel_async_task if it is no longer needed.</hint>`,
        `</async_task>`,
      ].filter(Boolean).join("\n") + extraNote,
    };
  }

  /** Smart cleanup for a sync `task`-tool worktree. */
  private async finalizeSyncWorktree(
    worktreePath: string | undefined,
    worktreeBranch: string | undefined,
    worktreeBaseSha: string | undefined,
  ): Promise<string> {
    if (!worktreePath) return "";
    const dirty = await worktreeHasChanges(worktreePath, worktreeBaseSha);
    if (!dirty) {
      await removeWorktree(this.host.cwd, worktreePath).catch(() => {});
      return "";
    }
    return [
      "",
      "",
      `<worktree>${worktreePath}</worktree>`,
      worktreeBranch ? `<branch>${worktreeBranch}</branch>` : "",
      `<hint>The subagent made changes; the worktree is preserved at the path above for inspection. Run \`git worktree remove --force ${worktreePath}\` once you've reviewed or merged the branch.</hint>`,
    ].filter(Boolean).join("\n");
  }

  /** Run a child engine's first turn under the event-driven staleness
   * watchdog. A child is only ever killed for being STUCK (no stream events
   * within the stale budget) — never for merely running long. The wall-clock
   * hard timer exists solely for `timeoutMsOverride` callers (the conclude
   * phase), whose one short summarize turn must not be allowed to wander.
   * Foreground callers bound their own blocking wait via waitForTaskTerminal
   * and detach to background on budget expiry instead of killing (see
   * runSync / startAsync). Public so the engine's test-seam shim can forward
   * to it for the watchdog tests. */
  async runChildWithWatchdog(
    child: AgentEngine,
    description: string,
    taskId?: string,
    options?: { timeoutMsOverride?: number },
  ): Promise<{ disposition: "completed" | "cancelled" | "timeout" | "stale"; durationMs: number; timeoutMs: number }> {
    const profile = resolveProfile(child.session.agent);
    const hardKill = Boolean(options?.timeoutMsOverride && options.timeoutMsOverride > 0);
    const timeoutMs = options?.timeoutMsOverride && options.timeoutMsOverride > 0
      ? Math.max(50, options.timeoutMsOverride)
      : subagentTimeoutMs(profile);
    // Stale budgets resolved once per child (env / profile / default).
    const idleLimitMs = staleIdleMs(profile);
    const inToolLimitMs = staleInToolMs(profile);
    const started = Date.now();
    let disposition: "completed" | "cancelled" | "timeout" | "stale" = "completed";

    let lastEventAt = Date.now();
    // Separate from `lastEventAt` (which starts at "now" so the staleness
    // watchdog's first-turn grace works): only a real event flips this.
    // The wall-clock cap consults it so a child that has produced
    // nothing yet still gets killed on schedule.
    let hasEmittedEvent = false;
    const unsubFreshness = child.onStream((event) => {
      if (event.type === "context-request" || event.type === "context-history-event"
        || (event.type === "background-error" && event.category === "context.history")) return;
      hasEmittedEvent = true;
      lastEventAt = Date.now();
    });

    let warnedForLimit: number | null = null;

    // Bubble HITL is the one case where "the child is stuck" is the
    // correct, expected behavior: a fork in bubble mode is waiting on
    // the supervisor's user to approve a write, which can take hours
    // when the user is away. Both the stale watchdog AND the hard
    // timeout must pause for as long as a pending_approval is on the
    // child's tool list — otherwise legitimate HITL flows get reaped.
    // Implementation: every heartbeat tick that observes a pending
    // approval resets lastEventAt (suppresses stale kill) and stamps
    // bubbleWaitingMs (cumulative time we owe the hard-timeout deadline).
    let bubbleWaitingTotalMs = 0;
    let lastBubbleObservedAt: number | null = null;

    const heartbeat = setInterval(() => {
      if (child.session.interrupted) return;
      const now = Date.now();
      const pendingApproval = child.session.toolCalls.some((call) => call.status === "pending_approval");
      if (pendingApproval) {
        // While the user is being asked, the child isn't really idle.
        // Reset the staleness clock continuously and accumulate the
        // delta so the hard timer below can extend itself by the same
        // amount.
        if (lastBubbleObservedAt !== null) {
          bubbleWaitingTotalMs += now - lastBubbleObservedAt;
        }
        lastBubbleObservedAt = now;
        lastEventAt = now;
        return;
      }
      // Pending approval cleared — stop accruing waiting time.
      lastBubbleObservedAt = null;

      const idleMs = now - lastEventAt;
      const inFlightTool = child.session.toolCalls.some((call) => call.status === "running");
      const toolCount = child.session.toolCalls.length;
      const turns = child.session.usage?.turns ?? 0;
      const beforeFirstProgress = toolCount === 0 && turns === 0;
      // First-turn grace: while we haven't seen any tool call or turn
      // boundary yet, treat the budget as in-tool (longer) so a slow
      // first model response doesn't get falsely killed.
      const limit = inFlightTool || beforeFirstProgress
        ? inToolLimitMs
        : idleLimitMs;
      const warningThreshold = limit / 2;

      // Reset warning state if the child recovered (events flowing again).
      if (idleMs < warningThreshold) {
        warnedForLimit = null;
      }

      // Emit a pre-kill warning when we cross the halfway point. Async
      // tasks only — sync `task` blocks the supervisor so a warning is
      // both unactionable and never seen until the call returns.
      if (taskId && idleMs > warningThreshold && warnedForLimit !== limit) {
        warnedForLimit = limit;
        this.host.emitStream({
          type: "async-task-warning",
          taskId,
          reason: inFlightTool ? "stale-in-tool" : "stale-idle",
          idleMs,
          remainingMs: Math.max(0, limit - idleMs),
        });
      }

      if (idleMs > limit) {
        disposition = "stale";
        child.interrupt();
      }
      // Best-effort: ride the heartbeat to refresh the task's
      // runningUsage so check_async_task can show "this worker has
      // burned 80k tokens so far" without waiting for settlement.
      // Sub-threshold deltas are skipped (see updateRunningUsage).
      if (taskId) this.updateRunningUsage(taskId, child);
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    // Hard timeout uses a self-rescheduling pattern so bubble HITL
    // waits don't count against the per-child wall-clock cap. When the
    // timer fires: if a pending approval is currently in flight, defer
    // by the bubble-extension grace; otherwise, kill.
    const TIMER_DEFER_MS = 60_000;
    const scheduleTimeout = (delay: number): NodeJS.Timeout => {
      const t = setTimeout(() => {
        if (child.session.interrupted) return;
        const pendingApproval = child.session.toolCalls.some((call) => call.status === "pending_approval");
        if (pendingApproval) {
          // Defer and let the next tick decide.
          timer = scheduleTimeout(TIMER_DEFER_MS);
          return;
        }
        // Bubble waits we've absorbed get added to the deadline so the
        // child gets its full wall-clock budget of NON-bubble work.
        if (bubbleWaitingTotalMs > 0) {
          const grace = bubbleWaitingTotalMs;
          bubbleWaitingTotalMs = 0;
          timer = scheduleTimeout(grace);
          return;
        }
        // Liveness extension: a child that has produced a stream event
        // within HEALTHY_RECENT_MS is still doing work — extend rather
        // than kill. STALE_IDLE_MS / STALE_IN_TOOL_MS in the heartbeat
        // above stay as the safety net for truly stuck children.
        if (hasEmittedEvent && Date.now() - lastEventAt < HEALTHY_RECENT_MS) {
          timer = scheduleTimeout(HEALTHY_EXTEND_MS);
          return;
        }
        disposition = "timeout";
        child.interrupt();
      }, delay);
      if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
        (t as unknown as { unref: () => void }).unref();
      }
      return t;
    };
    // The wall-clock kill timer only arms for timeoutMsOverride callers
    // (conclude phase). Normal runs rely on the stale heartbeat above: a
    // child that keeps producing events is working, not stuck, no matter
    // how long it has been running.
    let timer = hardKill ? scheduleTimeout(timeoutMs) : undefined;

    try {
      const stream = taskId ? this.taskStreams.get(taskId) : undefined;
      if (stream) {
        stream.turnId = createId("turn");
        stream.emit({ type: "task-turn-started", id: stream.turnId, createdAt: nowIso() });
      }
      await child.runTurn(description);
    } finally {
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      unsubFreshness();
    }
    if (child.session.interrupted && disposition === "completed") {
      disposition = "cancelled";
    }
    return { disposition, durationMs: Date.now() - started, timeoutMs };
  }

  /** Two-phase salvage: ask the killed child for a short self-report. */
  private async runChildConcludePhase(
    child: AgentEngine,
    taskId: string | undefined,
    triggeredBy: "timeout" | "stale",
    originalDurationMs: number,
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    child.session.interrupted = false;
    child.session.providerState = undefined;
    const concludePrompt = [
      `[CONCLUDE PHASE — your previous turn was halted by the supervisor (reason: ${triggeredBy} after ${Math.round(originalDurationMs)}ms).]`,
      "Do NOT call any more tools or continue the original task. Reply with a short structured self-report so the supervisor can decide next steps:",
      "1. What was the original task?",
      "2. What concrete steps did you complete (files touched, observations made, hypotheses tested)?",
      "3. What's still incomplete and what would the next reasonable step be?",
      "Keep the response under 800 words. Do not start exploration; only describe and recommend.",
    ].join("\n");
    try {
      const { disposition } = await this.runChildWithWatchdog(child, concludePrompt, taskId, {
        timeoutMsOverride: concludeTimeoutMs(),
      });
      if (disposition !== "completed") {
        return { ok: false, error: `Conclude phase ended with disposition="${disposition}"` };
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const lastAssistant = child.session.messages.filter((item) => item.role === "assistant").at(-1);
    const raw = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "Conclude phase returned no assistant message" };
    return { ok: true, result: trimmed };
  }

  /** The background driver: awaits the child's runTurn, then updates the
   * AsyncTaskRecord based on outcome. Supports update_async_task by looping. */
  private async driveAsyncChild(taskId: string, child: AgentEngine, description: string, unsubscribe: () => void): Promise<void> {
    let outcome: { status: "completed" | "failed" | "cancelled"; result?: string; error?: string } = {
      status: "completed",
    };
    let stopReason: "completed" | "cancelled" | "timeout" | "stale" | "error" = "completed";
    let currentPrompt = description;
    let pruned = false;
    try {
      // Loop only fires when an update_async_task tool call interrupts a
      // turn and queues a follow-up. Without that, this runs once.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { disposition, durationMs } = await this.runChildWithWatchdog(child, currentPrompt, taskId);
        if (this.children.get(taskId) !== child) return;
        stopReason = disposition;
        if (disposition === "cancelled") {
          const queuedUpdates = this.claimQueuedTaskUpdates(taskId);
          if (queuedUpdates.length > 0) {
            currentPrompt = mergeQueuedUpdateMessages(queuedUpdates);
            this.markQueuedTaskUpdatesApplied(queuedUpdates);
            continue;
          }
        }
        let salvageResult: string | undefined;
        if (disposition === "stale") {
          const concluded = await this.runChildConcludePhase(child, taskId, disposition, durationMs);
          if (concluded.ok && concluded.result) salvageResult = concluded.result;
          if (this.children.get(taskId) !== child) return;
          // A message can interrupt the conclude phase after the original
          // watchdog returned stale. Honor it before terminal cleanup drops
          // the queue, just as for an interrupted normal turn above.
          const queuedUpdates = this.claimQueuedTaskUpdates(taskId);
          if (queuedUpdates.length > 0) {
            currentPrompt = mergeQueuedUpdateMessages(queuedUpdates);
            this.markQueuedTaskUpdatesApplied(queuedUpdates);
            continue;
          }
        }
        const lastAssistant = child.session.messages.filter((item) => item.role === "assistant").at(-1);
        if (disposition === "stale") {
          outcome = {
            status: "failed",
            result: salvageResult
              ? `[Salvaged self-report — original task did not complete; this is the subagent's summary of what it did before the stall]\n\n${salvageResult}`
              : undefined,
            error: `Subagent appeared stuck (no stream events for ~${Math.round(staleIdleMs(resolveProfile(child.session.agent)) / 1000)}s) and was interrupted.${salvageResult ? " Conclude summary attached as result." : ""}`,
          };
        } else if (disposition === "cancelled") {
          outcome = { status: "cancelled", error: "Cancelled by parent." };
        } else {
          const captured = child.session.submittedResponse;
          // Silent-approval-gap guard (same as runSync): a turn that ended
          // still awaiting an approval is a blocked half answer, not success.
          const parkedError = parkedApprovalError(child);
          if (parkedError) {
            outcome = {
              status: "failed",
              result: captured ?? lastAssistant?.content,
              error: parkedError,
            };
          } else {
            outcome = {
              status: "completed",
              result: captured ?? lastAssistant?.content ?? "Subagent completed without producing a final message.",
            };
          }
        }
        break;
      }
    } catch (error) {
      stopReason = "error";
      outcome = { status: "failed", error: errorMessage(error) };
    } finally {
      const stream = this.taskStreams.get(taskId);
      if (this.children.get(taskId) === child && stream?.turnId && outcome.result) {
        stream.emit({ type: "task-turn-completed", id: stream.turnId, text: outcome.result, createdAt: nowIso() });
      }
      unsubscribe();
      pruned = this.children.get(taskId) !== child;
      if (!pruned) {
        this.children.delete(taskId);
        this.dropQueuedTaskUpdates(taskId, "task_settled");
        this.activity.drop(taskId);
        this.host.rollupChildUsage(child);
      }
    }
    if (pruned) return;
    // Settlement below must never throw: by this point `children` has already
    // been cleaned up, so an exception would strand the task record at
    // "running" forever (gather/wait would never see it settle) and — since
    // callers fire this promise without awaiting the tail — surface only as
    // an unhandled rejection. Report instead, then best-effort terminalize.
    try {
      const current = this.host.session.asyncTasks?.find((entry) => entry.id === taskId);
      const turns = child.session.usage?.turns ?? 0;
      const toolCalls = child.session.toolCalls.length;
      const completedAt = nowIso();
      const startedAtIso = current?.startedAt ?? completedAt;
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAtIso));
      const usage = {
        inputTokens: child.session.usage?.inputTokens ?? 0,
        outputTokens: child.session.usage?.outputTokens ?? 0,
        cachedInputTokens: child.session.usage?.cachedInputTokens ?? 0,
        reasoningTokens: child.session.usage?.reasoningTokens ?? 0,
        durationMs,
      };
      const updated: AsyncTaskRecord = {
        ...(current ?? {
          id: taskId,
          agent: child.session.agent,
          description,
          status: "running",
          startedAt: startedAtIso,
          isolation: "none",
        }),
        status: outcome.status,
        completedAt,
        result: outcome.result,
        error: outcome.error,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        recovery: undefined,
        turns,
        toolCalls,
        usage,
      };
      this.upsertAsyncTask(updated);
      // Event-driven completion injection: when a fire-and-forget task
      // settles, queue a <task-notification> so the supervisor sees the
      // result on its next safe boundary instead of having to poll. Sync
      // dispatches already block on their own observation so the model
      // sees the result directly — re-injecting would duplicate it.
      if (updated.background) {
        this.injector.enqueue(updated);
        this.host.emitStream({ type: "async-task-injected", task: updated });
        pushTrace(this.host.session, "async_task.injected", { id: updated.id, status: updated.status });
      }
      // Rate-limited batch members are requeued (kimi AgentSwarm parity)
      // instead of staying terminal: schedules a delayed same-id re-open and
      // opens the batch-wide dispatch cooldown that pumpBatch honors below.
      const rateLimitRequeued = this.maybeRequeueRateLimited(updated);
      // Brief retry guard: increment failure counter on non-clean outcomes.
      // Persisted to session.failedBriefs so a crash + restart preserves the
      // "this brief is structurally broken" signal across processes. A
      // requeued rate-limit settle is the provider saturating, not a broken
      // brief — it must not eat into the brief's retry budget.
      if (outcome.status !== "completed" && !rateLimitRequeued) {
        const briefKey = briefRetryKey(child.session.agent, description);
        const next = (this.failedBriefCounts.get(briefKey) ?? 0) + 1;
        this.failedBriefCounts.set(briefKey, next);
        this.persistFailedBriefCount(child.session.agent, description, next);
      }
      const traceType =
        stopReason === "stale"
          ? "async_task.stale"
          : outcome.status === "completed"
            ? "async_task.completed"
            : outcome.status === "cancelled"
              ? "async_task.cancelled"
              : "async_task.failed";
      pushTrace(this.host.session, traceType, {
        id: taskId,
        turns,
        toolCalls,
        stopReason,
      });
      // Fire onAsyncTaskComplete user hooks via the host.
      this.host.fireCompletionHooks(updated);
      // Batch refill: a settled member frees a slot in its batch's
      // concurrency window — launch the next queued item(s).
      if (updated.batchId) {
        const batch = this.batches.get(updated.batchId);
        if (batch) {
          // A member finishing cleanly means the provider is serving again.
          if (!rateLimitRequeued && updated.status === "completed") batch.rateLimitStreak = 0;
          if (batch.pending.length > 0) {
            void this.pumpBatch(batch).catch((error) =>
              this.host.reportBackgroundError("subagent.batch", error, { batchId: batch.id }),
            );
          }
        }
      }
      // Team mode: mirror this worker's terminal status back onto its bound
      // DAG node (completed / failed / cancelled), which cascades blockedBy
      // unblocking. No-ops when the task has no subtaskId or the node is gone.
      this.host.syncSubtaskFromTask?.(updated);
      // P1-5 mailbox: notify the coordinator that this worker is idle. The host
      // no-ops when team mode is inactive (no subtasks on the parent
      // session), so this is safe to call unconditionally here.
      this.host.notifyCoordinatorIdle(updated);
      // Worktree teardown follows Claude Code's Agent tool semantics.
      if (current?.isolation === "worktree" && current.worktreePath) {
        const dirty = await worktreeHasChanges(current.worktreePath, current.worktreeBaseSha);
        if (!dirty) {
          await removeWorktree(this.host.cwd, current.worktreePath).catch((error) => {
            this.host.reportBackgroundError("worktree.cleanup", error, {
              taskId,
              worktreePath: current.worktreePath,
            });
          });
          // Clear worktree-provisioning fields FROM the settled record
          // (`updated`), NOT the pre-settle `current` snapshot: `current` is
          // still `running` with no result/completedAt, so spreading it here
          // would roll the just-written terminal record back to running and drop
          // the subagent's result. See withWorktreeCleared.
          const latest = [...(this.host.session.asyncTasks ?? []), ...(this.host.session.asyncTasksArchived ?? [])]
            .find((task) => task.id === taskId);
          if (latest && (latest.attemptCount ?? 1) === (updated.attemptCount ?? 1) && latest.childSessionId === updated.childSessionId) {
            this.upsertAsyncTask(withWorktreeCleared(latest));
          }
        }
      }
    } catch (error) {
      this.host.reportBackgroundError("subagent.settle", error, { taskId });
      // The upsert itself may be what threw — guard again so the record does
      // not stay parked at "running".
      try {
        const record = this.host.session.asyncTasks?.find((entry) => entry.id === taskId);
        if (record && (record.status === "running" || record.status === "resuming")) {
          this.upsertAsyncTask({
            ...record,
            status: outcome.status,
            completedAt: nowIso(),
            result: outcome.result,
            error: outcome.error ?? errorMessage(error),
          });
        }
      } catch {
        // Already reported above — nothing safer left to do.
      }
    }
  }

  /** Forward every stream event from a child engine up to the parent's
   * stream, wrapped so the renderer can attribute it. Also persists each
   * event to `.reina/tasks/<taskId>/stream.jsonl` and feeds the
   * in-memory activity tracker so check_async_task is O(1). */
  private bridgeChildStream(taskId: string, child: AgentEngine): () => void {
    child.setContextHistoryOwner?.({ cwd: this.host.cwd, sessionId: this.host.session.id, taskId });
    const childSessionId = child.session.id;
    const writer = this.openTaskStreamWriter(taskId);
    const emit = (event: ModelStreamEvent): void => {
      this.host.emitStream({ type: "subagent-event", taskId, childSessionId, event });
      writer.append(event);
      this.activity.observe(taskId, event);
    };
    this.taskStreams.set(taskId, { emit });
    const unsubscribe = child.onStream(emit);
    return () => {
      unsubscribe();
      if (this.taskStreams.get(taskId)?.emit === emit) this.taskStreams.delete(taskId);
      // Fire-and-forget — settlement drives downstream cleanup and we
      // don't want to block here. The writer's close() handles its own
      // flush errors via reportBackgroundError.
      const closing = writer.close();
      this.taskStreamClosures.set(taskId, closing);
      void closing.finally(() => {
        if (this.taskStreamClosures.get(taskId) === closing) this.taskStreamClosures.delete(taskId);
      });
    };
  }

  private emitTaskMessage(taskId: string, text: string, sender: "user" | "supervisor"): void {
    this.taskStreams.get(taskId)?.emit({ type: "task-message", id: createId("msg"), text, sender, createdAt: nowIso() });
  }

  /** Refresh the AsyncTaskRecord.runningUsage snapshot from the child
   * engine's live session.usage. Skipped when the change is below the
   * delta threshold (default ~1k tokens) so the UI / rollout don't
   * churn on every short turn. Emits async-task-updated only when an
   * update actually happens — substantiveTaskDiff doesn't fire on
   * runningUsage alone, so we bypass it here intentionally. */
  private updateRunningUsage(taskId: string, child: AgentEngine): void {
    const tasks = this.host.session.asyncTasks;
    if (!tasks) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "running") return;
    const u = child.session.usage;
    if (!u) return;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const prev = task.runningUsage;
    const totalNow = inputTokens + outputTokens;
    const totalPrev = (prev?.inputTokens ?? 0) + (prev?.outputTokens ?? 0);
    const delta = Math.abs(totalNow - totalPrev);
    if (prev && delta < RUNNING_USAGE_DELTA_TOKENS) return;
    const startedAt = Date.parse(task.startedAt);
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    task.runningUsage = {
      inputTokens,
      outputTokens,
      cachedInputTokens: u.cachedInputTokens ?? 0,
      reasoningTokens: u.reasoningTokens ?? 0,
      durationMs,
      turns: u.turns ?? 0,
    };
    // Live UI ping — supervisor's check_async_task / Agent Team panel
    // gets the fresh number. Skipping record() here: runningUsage is
    // transient (settlement overwrites with the authoritative `usage`
    // field) and we don't want rollout growth from per-tick updates.
    this.host.emitStream({ type: "async-task-updated", task });
  }

  /** Public read path for activity snapshots. Prefers the in-memory
   * cache (populated by the live stream bridge); falls back to the
   * on-disk stream tail for tasks whose child engine has already been
   * torn down or for cross-process inspection. The engine's
   * check_async_task / injectAsyncTaskSnapshot call this instead of
   * touching readAsyncTaskActivity directly. */
  async readActivity(taskId: string): Promise<AsyncTaskActivitySnapshot | undefined> {
    const cached = this.activity.get(taskId);
    if (cached) return cached;
    return readAsyncTaskActivity(this.host.cwd, taskId);
  }

  /** Lazy-open a JSONL writer for the per-task event log.
   *
   * Three properties that matter for long sessions / high fan-out:
   *
   *   1. close() returns a Promise that resolves after the underlying
   *      stream has flushed + the FD is released. Callers can await it
   *      when they need the file to be fully written (e.g., before
   *      compacting or shipping the rollout); fire-and-forget callers
   *      can ignore the returned Promise without leaking FDs.
   *   2. Pending in-memory buffer is flushed even if the open races
   *      with close (previously was dropped silently).
   *   3. Per-process open-writer counter — protects against FD
   *      exhaustion when the supervisor spawns many concurrent
   *      children. Soft warning via reportBackgroundError when we
   *      cross the warn threshold; no hard block (we still write,
   *      we just want the breadcrumb in telemetry). */
  private openTaskStreamWriter(taskId: string): {
    append: (event: ModelStreamEvent) => void;
    close: () => Promise<void>;
  } {
    const dir = path.join(this.host.cwd, ".reina", "tasks", taskId);
    const file = path.join(dir, "stream.jsonl");
    let stream: WriteStream | undefined;
    let pending: string[] = [];
    let closed = false;
    let openPromise: Promise<void>;

    SubagentManager.activeStreamWriters += 1;
    if (SubagentManager.activeStreamWriters === STREAM_WRITER_WARN_THRESHOLD) {
      this.host.reportBackgroundError(
        "task.stream.writers.high",
        new Error(`open subagent stream writers at ${STREAM_WRITER_WARN_THRESHOLD}; check for orphaned tasks`),
        { taskId },
      );
    }

    // A same-task follow-up can start before the previous writer has
    // flushed. Serialize writer lifetimes to preserve conversation order.
    openPromise = (this.taskStreamClosures.get(taskId) ?? Promise.resolve())
      .then(() => mkdir(dir, { recursive: true }))
      .then(() => {
        const opened = createWriteStream(file, { flags: "a" });
        opened.on("error", (error) => {
          this.host.reportBackgroundError("task.stream.write", error, { taskId });
          stream = undefined;
        });
        stream = opened;
        if (pending.length > 0) {
          for (const line of pending) opened.write(line);
          pending = [];
        }
      })
      .catch((error) => {
        this.host.reportBackgroundError("task.stream.open", error, { taskId });
      });

    const releaseSlot = (): void => {
      SubagentManager.activeStreamWriters = Math.max(0, SubagentManager.activeStreamWriters - 1);
    };

    return {
      append: (event) => {
        if (closed) return;
        const line = `${JSON.stringify({ timestamp: nowIso(), event })}\n`;
        if (stream) {
          stream.write(line);
        } else {
          pending.push(line);
        }
      },
      close: async () => {
        closed = true;
        // Wait for any in-flight open so we don't drop buffered events
        // that the .then handler would have flushed.
        await openPromise.catch(() => undefined);
        if (stream) {
          await new Promise<void>((resolve) => {
            // stream.end() takes a final chunk + callback; we pass an
            // empty callback so the resolve fires once the underlying
            // FD has been released.
            stream!.end(() => resolve());
          });
          stream = undefined;
        }
        pending = [];
        releaseSlot();
      },
    };
  }

  /** Process-wide counter — set across SubagentManager instances so a
   * desktop app running multiple AgentEngines doesn't get surprised by
   * a per-instance number that masks a real cumulative leak. */
  private static activeStreamWriters = 0;
}

/** Soft threshold at which we surface a "lots of stream writers open"
 * background-error. Loud enough to catch in telemetry, not so loud as
 * to spam under legitimate fan-out workloads. */
const STREAM_WRITER_WARN_THRESHOLD = 32;

// ─── Module-level static helpers ──────────────────────────────────────────

/** Resolve the per-child timeout. Env override wins so tests can drop it
 * to ~100ms without touching code. Exported for tests; production code
 * reaches it through SubagentManager.runChildWithWatchdog. */
export function subagentTimeoutMs(profile?: AgentProfile): number {
  const raw = process.env.REINA_SUBAGENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(50, parsed);
  }
  if (profile?.subagentTimeoutMs && profile.subagentTimeoutMs > 0) {
    return Math.max(50, profile.subagentTimeoutMs);
  }
  return DEFAULT_SUBAGENT_TIMEOUT_MS;
}

/** Resolve the idle stale budget (no tool in flight). Env wins, then the
 * profile's staleIdleMs, then the default. Floored at 1s so a typo can't
 * make the heartbeat reap instantly. Slow-thinking models can widen this
 * per profile (grok-build's per-model inference_idle_timeout equivalent). */
export function staleIdleMs(profile?: AgentProfile): number {
  const raw = process.env.REINA_SUBAGENT_STALE_IDLE_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1_000, parsed);
  }
  if (profile?.staleIdleMs && profile.staleIdleMs > 0) {
    return Math.max(1_000, profile.staleIdleMs);
  }
  return STALE_IDLE_MS;
}

/** Resolve the in-tool stale budget (a tool call is running, or the first
 * turn hasn't produced anything yet). Same precedence as staleIdleMs. */
export function staleInToolMs(profile?: AgentProfile): number {
  const raw = process.env.REINA_SUBAGENT_STALE_IN_TOOL_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1_000, parsed);
  }
  if (profile?.staleInToolMs && profile.staleInToolMs > 0) {
    return Math.max(1_000, profile.staleInToolMs);
  }
  return STALE_IN_TOOL_MS;
}

function maxConcurrentAsync(): number {
  const raw = process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CONCURRENT_ASYNC;
}

function maxLiveAsyncTasks(): number {
  const raw = process.env.REINA_MAX_LIVE_ASYNC_TASKS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_LIVE_ASYNC_TASKS;
}

/** Decide whether an upsert carries something the UI cares about
 * (status change, usage update, new result/error, name set,
 * settlement timestamps appearing) vs. pure bookkeeping (notifiedAt,
 * injectedAt, archived flip, runningUsage tick within delta). The
 * latter still hit the rollout (durability) but skip the live stream
 * to avoid renderer thrash on long sessions. */
function substantiveTaskDiff(prev: AsyncTaskRecord, next: AsyncTaskRecord): boolean {
  if (prev.status !== next.status) return true;
  if (prev.result !== next.result) return true;
  if (prev.error !== next.error) return true;
  if (prev.name !== next.name) return true;
  if (prev.completedAt !== next.completedAt) return true;
  if (prev.turns !== next.turns) return true;
  if (prev.toolCalls !== next.toolCalls) return true;
  if (prev.recovery?.status !== next.recovery?.status) return true;
  if (prev.recovery?.reason !== next.recovery?.reason) return true;
  if (prev.usage?.inputTokens !== next.usage?.inputTokens) return true;
  if (prev.usage?.outputTokens !== next.usage?.outputTokens) return true;
  // worktree clearance after teardown matters to UI tools that surface
  // "branch X is no longer present".
  if (prev.worktreePath !== next.worktreePath) return true;
  // runningUsage ticks are surfaced via dedicated emit path (engine),
  // not the generic async-task-updated event — that's why they don't
  // count as substantive here.
  return false;
}

function taskEventType(prev: AsyncTaskRecord | undefined, next: AsyncTaskRecord): string {
  if (!prev) return "task.created";
  if (prev.status !== next.status) return `task.status.${next.status}`;
  if (next.lastHeartbeatAt && prev.lastHeartbeatAt !== next.lastHeartbeatAt) return "task.heartbeat";
  if (next.leaseOwner && prev.leaseOwner !== next.leaseOwner) return "task.lease_acquired";
  return "task.updated";
}

function isTaskTerminal(task: AsyncTaskRecord): boolean {
  return ["completed", "failed", "cancelled", "failed_unrecoverable"].includes(task.status);
}

function mergeQueuedUpdateMessages(updates: QueuedTaskUpdate[]): string {
  if (updates.length === 1) return updates[0]?.message ?? "";
  return updates.map((update, index) => `[Update ${index + 1}]\n${update.message}`).join("\n\n");
}

/** Wall-clock cap for the conclude phase that fires after a subagent gets
 * killed by timeout/stale. */
function concludeTimeoutMs(): number {
  const raw = process.env.REINA_SUBAGENT_CONCLUDE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1_000) return parsed;
  }
  return 90_000;
}

/** Normalize a subagent brief into a stable key for the retry-failure
 * counter. Whitespace collapsed, lowercased, capped at 240 chars. */
function normalizeBriefForRetryGuard(description: string): string {
  return description.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 240);
}

/** Observation returned when start_async_task is called with the same
 * (agent, normalized brief) as a task that is either already running
 * from a prior turn or being dispatched concurrently in the same
 * model-response batch. The duplicate call does NOT spawn a child —
 * it gets a pointer to the original task so the supervisor reads the
 * result from the original observation (batched case) or via
 * check_async_task later (cross-turn case). */
function mergedDispatchObservation(
  record: ToolCallRecord,
  existingTaskId: string,
  reason: string,
): ToolObservation {
  return {
    callId: record.id,
    name: record.name,
    output: [
      `<async_task>`,
      `<task_id>${existingTaskId}</task_id>`,
      `<status>merged</status>`,
      `<merged_with>${existingTaskId}</merged_with>`,
      `<reason>${escapeXml(reason)}</reason>`,
      `<hint>Duplicate dispatch (same agent + brief) — merged into ${existingTaskId} to avoid duplicate work. Read that task's observation for the result, or use get_async_tasks({taskRefs:["${existingTaskId}"],detail:"activity"}) in a later turn.</hint>`,
      `</async_task>`,
    ].join("\n"),
  };
}

/** Prepend the profile's `initialPrompt` (if any) to a subagent's first
 * user message. Used by both `runSync` and `startAsync` so a profile can
 * carry standing context (project conventions, preferred libraries)
 * without the supervisor having to repeat it in every brief. Follow-up
 * messages via update_async_task are NOT re-prepended — the supervisor's
 * new message is treated verbatim. */
function assembleFirstTurnPrompt(profile: AgentProfile, description: string): string {
  const initial = profile.initialPrompt?.trim();
  return initial ? `${initial}\n\n${description}` : description;
}
