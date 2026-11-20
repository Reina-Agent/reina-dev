import type { AsyncTaskRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import type { WorktreeHealth } from "./resume.js";

export type SubagentReconcileInput = {
  sessionTasks: AsyncTaskRecord[];
  persistedTasks?: AsyncTaskRecord[];
  liveTaskIds?: ReadonlySet<string>;
  checkedAt?: string;
  checkWorktreeHealth: (worktreePath?: string) => Promise<WorktreeHealth>;
};

export type SubagentReconcileResult = {
  tasks: AsyncTaskRecord[];
  changed: AsyncTaskRecord[];
  recovered: AsyncTaskRecord[];
  mergedFromStore: AsyncTaskRecord[];
};

const RESTART_REASON =
  "Process restart - child engine state was lost. Resume starts a fresh child attempt; it does not restore hidden child memory.";

export async function reconcileSubagentTasks(input: SubagentReconcileInput): Promise<SubagentReconcileResult> {
  const checkedAt = input.checkedAt ?? nowIso();
  const liveTaskIds = input.liveTaskIds ?? new Set<string>();
  const byId = new Map<string, AsyncTaskRecord>();
  const order: string[] = [];

  for (const task of input.sessionTasks) {
    byId.set(task.id, task);
    order.push(task.id);
  }

  const mergedFromStore: AsyncTaskRecord[] = [];
  for (const persisted of input.persistedTasks ?? []) {
    const current = byId.get(persisted.id);
    if (!current) {
      byId.set(persisted.id, persisted);
      order.push(persisted.id);
      mergedFromStore.push(persisted);
      continue;
    }
    const merged = mergeTaskProjection(current, persisted);
    if (!sameTaskProjection(current, merged)) {
      byId.set(persisted.id, merged);
      mergedFromStore.push(merged);
    }
  }

  const changed: AsyncTaskRecord[] = [...mergedFromStore];
  const recovered: AsyncTaskRecord[] = [];
  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;
    if (!isPossiblyLive(task.status)) continue;
    if (liveTaskIds.has(task.id)) continue;
    if (task.status === "resuming" && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.parse(checkedAt)) {
      continue;
    }
    const worktreeStatus = await input.checkWorktreeHealth(task.worktreePath);
    const safeToResume = task.isolation !== "worktree" || worktreeStatus === "preserved";
    const next: AsyncTaskRecord = {
      ...task,
      status: safeToResume ? "recoverable" : "needs_attention",
      completedAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      recovery: {
        status: safeToResume ? "recoverable" : "needs_attention",
        reason: safeToResume
          ? RESTART_REASON
          : `${RESTART_REASON} The task used worktree isolation, but the worktree is missing; inspect or re-dispatch before continuing.`,
        checkedAt,
        worktreeStatus,
      },
      error: safeToResume
        ? RESTART_REASON
        : `${RESTART_REASON} Worktree missing; recovery requires attention before execution.`,
    };
    byId.set(id, next);
    changed.push(next);
    recovered.push(next);
  }

  return {
    tasks: order.map((id) => byId.get(id)).filter((task): task is AsyncTaskRecord => Boolean(task)),
    changed: dedupeByTaskId(changed),
    recovered,
    mergedFromStore: dedupeByTaskId(mergedFromStore),
  };
}

function mergeTaskProjection(sessionTask: AsyncTaskRecord, persistedTask: AsyncTaskRecord): AsyncTaskRecord {
  const sameAttempt = taskAttempt(sessionTask) === taskAttempt(persistedTask);
  if (!persistedLifecycleWins(sessionTask, persistedTask)) {
    if (!sameAttempt) return sessionTask;
    // Acknowledgement does not change completedAt. Merge it independently of
    // lifecycle freshness so an equally recent durable projection suppresses
    // replay, while a previous attempt can never acknowledge a new result.
    return {
      ...sessionTask,
      notifiedAt: sessionTask.notifiedAt ?? persistedTask.notifiedAt,
      injectedAt: sessionTask.injectedAt ?? persistedTask.injectedAt,
    };
  }
  return {
    ...persistedTask,
    ...sessionTask,
    status: persistedTask.status,
    result: persistedTask.result,
    error: persistedTask.error,
    worktreePath: persistedTask.worktreePath ?? sessionTask.worktreePath,
    worktreeBranch: persistedTask.worktreeBranch ?? sessionTask.worktreeBranch,
    childSessionId: persistedTask.childSessionId ?? sessionTask.childSessionId,
    worktreeHead: persistedTask.worktreeHead ?? sessionTask.worktreeHead,
    turns: persistedTask.turns ?? sessionTask.turns,
    toolCalls: persistedTask.toolCalls ?? sessionTask.toolCalls,
    attemptCount: persistedTask.attemptCount ?? sessionTask.attemptCount,
    resumeCount: persistedTask.resumeCount ?? sessionTask.resumeCount,
    completedAt: persistedTask.completedAt,
    notifiedAt: persistedTask.notifiedAt ?? (sameAttempt ? sessionTask.notifiedAt : undefined),
    injectedAt: persistedTask.injectedAt ?? (sameAttempt ? sessionTask.injectedAt : undefined),
    lastHeartbeatAt: persistedTask.lastHeartbeatAt ?? sessionTask.lastHeartbeatAt,
    leaseOwner: persistedTask.leaseOwner,
    leaseExpiresAt: persistedTask.leaseExpiresAt,
    recovery: persistedTask.recovery ?? sessionTask.recovery,
    usage: persistedTask.usage ?? sessionTask.usage,
  };
}

function persistedLifecycleWins(sessionTask: AsyncTaskRecord, persistedTask: AsyncTaskRecord): boolean {
  const persistedAttempt = taskAttempt(persistedTask);
  const sessionAttempt = taskAttempt(sessionTask);
  if (persistedAttempt !== sessionAttempt) return persistedAttempt > sessionAttempt;
  const persistedRank = statusRank(persistedTask.status);
  const sessionRank = statusRank(sessionTask.status);
  if (persistedRank !== sessionRank) return persistedRank > sessionRank;
  return taskTimestamp(persistedTask) > taskTimestamp(sessionTask);
}

function taskAttempt(task: AsyncTaskRecord): number {
  // Legacy projections serialize an omitted initial attempt as zero.
  return Math.max(1, task.attemptCount ?? 1);
}

function statusRank(status: AsyncTaskRecord["status"]): number {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "failed_unrecoverable":
      return 5;
    case "needs_attention":
      return 4;
    case "recoverable":
    case "evicted":
    case "orphaned":
      return 3;
    case "resuming":
      return 2;
    case "running":
      return 1;
  }
}

function taskTimestamp(task: AsyncTaskRecord): number {
  const value = task.completedAt ?? task.lastHeartbeatAt ?? task.notifiedAt ?? task.startedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPossiblyLive(status: AsyncTaskRecord["status"]): boolean {
  return status === "running" || status === "resuming";
}

function sameTaskProjection(a: AsyncTaskRecord, b: AsyncTaskRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function dedupeByTaskId(tasks: AsyncTaskRecord[]): AsyncTaskRecord[] {
  const byId = new Map<string, AsyncTaskRecord>();
  for (const task of tasks) byId.set(task.id, task);
  return [...byId.values()];
}
