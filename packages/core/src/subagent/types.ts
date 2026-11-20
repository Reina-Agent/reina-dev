import type { AsyncTaskRecord, ModelConfig, ModelStreamEvent, RolloutItem, SessionState, ToolCallRecord } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";

/** Result of a bubbled approval. Mirrors the shape of
 * `AgentEngine.resolveApproval`'s `options` argument so the child engine
 * can apply the parent's decision in-place. */
export type BubbleApprovalDecision = {
  approved: boolean;
  options?: {
    remember?: "session";
    updatedInput?: unknown;
    reason?: string;
  };
};

export type AsyncTaskUpdateRecord = {
  id: string;
  taskId: string;
  message: string;
  createdAt: string;
};

/** Minimal callback surface the SubagentManager needs from the host engine.
 *
 * Manager state (the children Map, pending updates, brief-failure counters)
 * lives inside SubagentManager itself; the host only owns the parent session,
 * stream pump, rollout writer, and child-engine factory.
 *
 * Keeping this surface small (instead of passing the whole AgentEngine) means
 * SubagentManager can be unit-tested with a stub host without spinning up a
 * real engine — and it documents exactly which engine capabilities the
 * subagent subsystem depends on. */
export interface SubagentHost {
  /** Direct access to the parent session. The manager reads + mutates
   * `session.asyncTasks`, `session.lastTurnTaskStatuses`, `session.subagentDepth`. */
  readonly session: SessionState;
  /** Convenience alias for `session.cwd`. */
  readonly cwd: string;
  /** Current parent turn cancellation. Waiting stops without cancelling workers. */
  readonly signal?: AbortSignal;
  /** Session-owned background completions that should return control to the model. */
  readonly taskEvents?: {
    hasPending(): boolean;
    subscribe(listener: () => void): () => void;
  };
  /** Per-user toggle for `start_async_task({fork: true})`. Sourced from
   * the supervisor engine's snapshot of `ReinaConfig.subagent.forkEnabled`.
   * Optional on the interface so test stubs can omit it — undefined is
   * treated as the default (enabled). */
  readonly forkEnabled?: boolean;
  /** Default model override for spawned children, snapshotted from
   * `ReinaConfig.subagent.secondaryModel`. The manager merges it over each
   * non-fork child's `session.model` right after spawn — lowest priority
   * (an AgentProfile model pin and per-skill overrides win at request
   * time). Optional so test stubs can omit it. */
  readonly secondaryModel?: Partial<ModelConfig>;
  /** Spawn a fresh child engine. The host is responsible for:
   *   - bumping `subagentDepth` on the child
   *   - marking `isSubagent = true`
   *   - sharing the parent's NotesService instance + skill snapshot
   *   - inheriting `activeDeferredTools`
   * Returns the constructed AgentEngine so the manager can drive it. */
  spawnChild(input: { cwd: string; agent: string }): AgentEngine;
  /** Append a rollout event (async_task, async_task_update, etc.). */
  record(item: RolloutItem): void;
  /** Mirror task projection + append-only recovery events into the
   * workspace store when SQLite is available. Rollout remains the model
   * history source; this is the queryable durable task ledger. */
  persistAsyncTask?(input: {
    task: AsyncTaskRecord;
    eventType: string;
    payload?: Record<string, unknown>;
  }): void;
  /** Compare-and-swap recovery lease for cross-process duplicate
   * prevention. Returns true only for the worker that won the lease. */
  tryAcquireAsyncTaskLease?(input: {
    taskId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
  }): boolean;
  /** Durable FIFO queue for update_async_task messages. Hosts without a
   * store can omit these and the manager falls back to its in-memory queue. */
  enqueueAsyncTaskUpdate?(input: {
    taskId: string;
    message: string;
  }): string | undefined;
  claimAsyncTaskUpdates?(input: {
    taskId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    limit?: number;
  }): AsyncTaskUpdateRecord[];
  markAsyncTaskUpdatesApplied?(input: {
    updateIds: string[];
  }): void;
  dropPendingAsyncTaskUpdates?(input: {
    taskId: string;
    reason: string;
  }): void;
  /** Forward a stream event to all of the parent's listeners. */
  emitStream(event: ModelStreamEvent): void;
  /** Report a non-fatal side-effect failure. The manager catches and reports
   * write failures (task stream files, worktree cleanup) here. */
  reportBackgroundError(category: string, error: unknown, context?: Record<string, unknown>): void;
  /** Subscribe to the parent's own stream. Used by wait_async_tasks /
   * waitForTaskTerminal to push-await terminal task transitions. */
  onStream(listener: (event: ModelStreamEvent) => void): () => void;
  /** Fold a settled child's usage into the parent's session.usage. The host
   * owns this because it knows the parent's preferred rollup shape (split
   * between primary and child token counters). */
  rollupChildUsage(child: AgentEngine): void;
  /** Fire the user-configured onAsyncTaskComplete hooks. The host owns
   * hook dispatch because it carries the hooksConfig + reporter. */
  fireCompletionHooks(task: AsyncTaskRecord): void;
  /** Write an idle-notification note addressed to the COORDINATOR_RECIPIENT
   * inbox. Called by the manager when a worker settles AND the parent
   * session is running team mode (has subtasks). The host implements
   * the actual notes-service write since the manager doesn't carry a
   * notes handle. Safe to no-op when team mode is inactive. */
  notifyCoordinatorIdle(task: AsyncTaskRecord): void;
  /** Team mode: bind a DAG node to a freshly-dispatched worker task. Marks
   * the node `in_progress` and records the async task id (so it leaves the
   * `ready` list and can't be double-dispatched). Returns `{ ok: false }`
   * with a message when the node id is unknown — the manager surfaces that
   * in the dispatch observation but still runs the worker (a typo'd id
   * shouldn't kill real work). No-op host when team mode is inactive. */
  bindSubtaskToTask?(input: { subtaskId: string; taskId: string }): { ok: boolean; error?: string };
  /** Team mode: mirror a settled worker's terminal status back onto its
   * bound DAG node (completed / failed / cancelled) + a short resultSummary,
   * which cascades `blockedBy` unblocking downstream. Called from the settle
   * path; no-ops when the task carries no `subtaskId`, the node is gone, or
   * this task is no longer the node's active binding (a later retry won). */
  syncSubtaskFromTask?(task: AsyncTaskRecord): void;
  /** Block until every server named in `profile.requiredMcpServers`
   * reaches `connected` for the host's cwd, or throw with a structured
   * gate error on timeout. The host implements the actual MCP status
   * polling — the manager just awaits this before spawning the child
   * so a misconfigured server fails the dispatch fast instead of
   * surfacing as a broken tool mid-turn. No-op when the profile has
   * no required servers. */
  awaitRequiredMcp(profileName: string): Promise<void>;
  /** Bubble a child's pending tool approval up to the parent's HITL flow.
   * The parent engine creates a mirror `pending_approval` record (attributed
   * with `bubbledFromTask`), surfaces it in real time via the
   * `permission-request` stream event, then forwards the user's decision
   * back via the returned Promise. Called by the child engine whenever a
   * tool call needs approval and a bubble handler is installed — the
   * manager wires one onto every spawned child (fork or not), so no child
   * ever parks an unanswerable prompt in its own pending map. The parent's
   * adapter is responsible for cleanup whether the user approves, rejects,
   * or the parent turn is interrupted (interrupt() rejects outstanding
   * bubbles). */
  requestBubbleApproval(input: {
    taskId: string;
    taskName?: string;
    childRecord: ToolCallRecord;
  }): Promise<BubbleApprovalDecision>;
  /** Bubble a subagent worker's `question` up to the parent's HITL flow.
   * The worker can't reach the user from its own (UI-less) child session, so
   * when it calls `question` the engine routes the prompt here. The parent
   * mints a mirror pending question (attributed with `bubbledFromTask`),
   * surfaces it via the real-time `question-request` stream event, and
   * resolves the returned Promise when the user answers (or `cancelled` on
   * timeout / dismissal). The child's tool loop awaits this inline, then
   * continues with the answer. Wired onto every spawned child regardless of
   * fork / permission mode. */
  requestUserQuestion(input: {
    taskId: string;
    taskName?: string;
    prompt: string;
    options?: string[];
  }): Promise<{ answer: string } | { cancelled: true }>;
}

/** Tail-of-stream summary the supervisor sees when it inspects a still-
 * running async task. Derived from the per-task `.reina/tasks/<id>/stream.jsonl`
 * by readAsyncTaskActivity. */
export interface AsyncTaskActivitySnapshot {
  activity: string;
  lastAssistantText?: string;
  recentToolCalls: Array<{ name: string; status: string }>;
  errors: string[];
  /** Milliseconds since the child emitted its last stream event. THE
   * liveness signal for "is it stuck": a tool that has been running 20
   * minutes but emitted output 5s ago is alive; one silent for 10
   * minutes is what stuck actually looks like. Undefined before the
   * first event / when the stream tail carries no timestamps. */
  lastEventAgoMs?: number;
  /** Milliseconds the currently-active tool has been running. Only set
   * while `activity` is `tool:<name>`. */
  activeToolRunningMs?: number;
}
