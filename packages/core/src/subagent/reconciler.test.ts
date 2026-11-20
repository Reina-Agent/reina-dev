import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord } from "@reina/protocol";
import { reconcileSubagentTasks } from "./reconciler.js";
import type { WorktreeHealth } from "./resume.js";

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id: overrides.id ?? "task_a",
    agent: overrides.agent ?? "default",
    description: overrides.description ?? "do work",
    status: overrides.status ?? "running",
    isolation: overrides.isolation ?? "none",
    startedAt: overrides.startedAt ?? "2026-05-14T11:00:00.000Z",
    ...overrides,
  };
}

describe("reconcileSubagentTasks", () => {
  it("keeps live in-process children running", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [task({ id: "task_live", status: "running" })],
      liveTaskIds: new Set(["task_live"]),
      checkWorktreeHealth: async () => "none",
      checkedAt: "2026-05-14T11:05:00.000Z",
    });

    expect(result.changed).toEqual([]);
    expect(result.tasks[0]?.status).toBe("running");
  });

  it("classifies stale running tasks as recoverable without worktree isolation", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [task({ id: "task_stale", status: "running" })],
      checkWorktreeHealth: async () => "none",
      checkedAt: "2026-05-14T11:05:00.000Z",
    });

    expect(result.recovered).toHaveLength(1);
    expect(result.tasks[0]?.status).toBe("recoverable");
    expect(result.tasks[0]?.recovery?.worktreeStatus).toBe("none");
  });

  it("classifies stale isolated tasks with missing worktrees as needs_attention", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [
        task({
          id: "task_missing",
          status: "running",
          isolation: "worktree",
          worktreePath: "/tmp/missing",
        }),
      ],
      checkWorktreeHealth: async (): Promise<WorktreeHealth> => "missing",
      checkedAt: "2026-05-14T11:05:00.000Z",
    });

    expect(result.tasks[0]?.status).toBe("needs_attention");
    expect(result.tasks[0]?.error).toContain("Worktree missing");
  });

  it("lets persisted lifecycle state repair a stale rollout projection", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [
        task({
          id: "task_repaired",
          status: "running",
          name: "reviewer",
          background: true,
        }),
      ],
      persistedTasks: [
        task({
          id: "task_repaired",
          status: "completed",
          completedAt: "2026-05-14T11:10:00.000Z",
          result: "finished",
        }),
      ],
      checkWorktreeHealth: async () => "none",
      checkedAt: "2026-05-14T11:11:00.000Z",
    });

    expect(result.mergedFromStore).toHaveLength(1);
    expect(result.recovered).toEqual([]);
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[0]?.result).toBe("finished");
    expect(result.tasks[0]?.name).toBe("reviewer");
    expect(result.tasks[0]?.background).toBe(true);
  });

  it("does not take over an unexpired resuming lease", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [
        task({
          id: "task_leased",
          status: "resuming",
          leaseOwner: "other-process",
          leaseExpiresAt: "2026-05-14T11:10:00.000Z",
        }),
      ],
      checkWorktreeHealth: async () => "none",
      checkedAt: "2026-05-14T11:05:00.000Z",
    });

    expect(result.changed).toEqual([]);
    expect(result.tasks[0]?.status).toBe("resuming");
  });

  it("merges durable acknowledgement when completion timestamps are equal", async () => {
    const completed = task({ status: "completed", completedAt: "2026-05-14T11:10:00.000Z", result: "done" });
    const result = await reconcileSubagentTasks({
      sessionTasks: [completed],
      persistedTasks: [{ ...completed, injectedAt: "2026-05-14T11:11:00.000Z", notifiedAt: "2026-05-14T11:11:00.000Z" }],
      checkWorktreeHealth: async () => "none",
    });

    expect(result.changed).toHaveLength(1);
    expect(result.tasks[0]?.injectedAt).toBe("2026-05-14T11:11:00.000Z");
    expect(result.tasks[0]?.notifiedAt).toBe("2026-05-14T11:11:00.000Z");
  });

  it("treats legacy store attempt zero as the omitted initial attempt", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [task({ status: "running" })],
      persistedTasks: [task({ status: "completed", attemptCount: 0, result: "legacy result", injectedAt: "2026-05-14T11:11:00.000Z" })],
      checkWorktreeHealth: async () => "none",
    });

    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[0]?.result).toBe("legacy result");
    expect(result.tasks[0]?.injectedAt).toBe("2026-05-14T11:11:00.000Z");
  });

  it("does not let an acknowledged previous attempt replace a resumed task", async () => {
    const current = task({ status: "running", attemptCount: 2, injectedAt: undefined });
    const result = await reconcileSubagentTasks({
      sessionTasks: [current],
      persistedTasks: [task({ status: "completed", attemptCount: 1, injectedAt: "2026-05-14T11:11:00.000Z" })],
      liveTaskIds: new Set([current.id]),
      checkWorktreeHealth: async () => "none",
    });

    expect(result.changed).toEqual([]);
    expect(result.tasks[0]?.status).toBe("running");
    expect(result.tasks[0]?.attemptCount).toBe(2);
    expect(result.tasks[0]?.injectedAt).toBeUndefined();
  });

  it("never carries a previous attempt's acknowledgement into a newer persisted result", async () => {
    const result = await reconcileSubagentTasks({
      sessionTasks: [task({ status: "completed", attemptCount: 1, injectedAt: "2026-05-14T11:11:00.000Z", notifiedAt: "2026-05-14T11:11:00.000Z" })],
      persistedTasks: [task({ status: "completed", attemptCount: 2, result: "new result", completedAt: "2026-05-14T11:12:00.000Z" })],
      checkWorktreeHealth: async () => "none",
    });

    expect(result.tasks[0]?.result).toBe("new result");
    expect(result.tasks[0]?.attemptCount).toBe(2);
    expect(result.tasks[0]?.injectedAt).toBeUndefined();
    expect(result.tasks[0]?.notifiedAt).toBeUndefined();
  });
});
