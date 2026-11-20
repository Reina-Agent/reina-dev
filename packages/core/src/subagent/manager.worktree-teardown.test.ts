import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord, SessionState } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { SubagentManager, withWorktreeCleared } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** After a worktree-isolated subagent settles, the manager removes the clean
 * worktree and re-upserts the record with the worktree-provisioning fields
 * cleared. That second upsert must start from the SETTLED record — starting
 * from the pre-settle `current` snapshot (still `running`, no result) rolls
 * the terminal status/result back and strands a completed task as "running". */

function session(): SessionState {
  return testSession({ id: "sess_wt", cwd: "/tmp/wt" });
}

const WORKTREE_FIELDS = {
  isolation: "worktree" as const,
  worktreePath: "/tmp/wt/.reina/worktrees/sub_wt",
  worktreeBranch: "reina/sub/sub_wt",
  worktreeBaseSha: "base000",
};

function runningRecord(): AsyncTaskRecord {
  return {
    id: "sub_wt",
    agent: "default",
    description: "audit the auth module in isolation",
    status: "running",
    startedAt: nowIso(),
    background: true,
    ...WORKTREE_FIELDS,
  } as AsyncTaskRecord;
}

function settledRecord(): AsyncTaskRecord {
  return {
    ...runningRecord(),
    status: "completed",
    completedAt: nowIso(),
    result: "found 2 confirmed IDOR chains",
    turns: 4,
    toolCalls: 11,
    usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 3200 },
  };
}

describe("withWorktreeCleared", () => {
  it("clears only the worktree-provisioning fields and preserves the terminal record", () => {
    const settled = settledRecord();
    const cleared = withWorktreeCleared(settled);
    expect(cleared.status).toBe("completed");
    expect(cleared.result).toBe("found 2 confirmed IDOR chains");
    expect(cleared.completedAt).toBe(settled.completedAt);
    expect(cleared.usage).toEqual(settled.usage);
    expect(cleared.worktreePath).toBeUndefined();
    expect(cleared.worktreeBranch).toBeUndefined();
    expect(cleared.worktreeBaseSha).toBeUndefined();
    // isolation is intentionally kept — it records HOW the task ran.
    expect(cleared.isolation).toBe("worktree");
  });

  // Pins the regression: clearing worktree fields from the pre-settle `current`
  // snapshot (the historical teardown bug) throws away the terminal status and
  // result. This is exactly what `this.upsertAsyncTask({ ...current, ... })`
  // used to do, and why the teardown must clear from `updated` instead.
  it("would strand a completed task as running if fed the pre-settle snapshot", () => {
    const regressed = withWorktreeCleared(runningRecord());
    expect(regressed.status).toBe("running");
    expect(regressed.result).toBeUndefined();
    expect(regressed.completedAt).toBeUndefined();
  });
});

describe("worktree teardown upsert sequence", () => {
  it("keeps the task terminal after the clean-worktree teardown re-upsert", () => {
    const s = session();
    const mgr = new SubagentManager(testHost(s).host);

    // 1. task is running under worktree isolation
    mgr.upsertAsyncTask(runningRecord());
    // 2. settlement writes the terminal record (driveAsyncChild line ~1605)
    const settled = settledRecord();
    mgr.upsertAsyncTask(settled);
    // 3. worktree teardown re-upsert — the FIXED call clears from the settled record
    mgr.upsertAsyncTask(withWorktreeCleared(settled));

    const final = (s.asyncTasks ?? []).find((t) => t.id === "sub_wt");
    expect(final?.status).toBe("completed");
    expect(final?.result).toBe("found 2 confirmed IDOR chains");
    expect(final?.worktreePath).toBeUndefined();
    expect(final?.worktreeBranch).toBeUndefined();
    // exactly one record, not a duplicate
    expect((s.asyncTasks ?? []).filter((t) => t.id === "sub_wt")).toHaveLength(1);
  });
});

describe("upsertAsyncTask chokepoint guards", () => {
  // The teardown bug class at the shared mutator: ANY future call site that
  // passes a stale pre-settle snapshot after the terminal write must not roll
  // the record back to running and drop its result.
  it("refuses to overwrite a terminal record with a stale non-terminal snapshot", () => {
    const s = session();
    const mgr = new SubagentManager(testHost(s).host);
    const settled = settledRecord();
    mgr.upsertAsyncTask(runningRecord());
    mgr.upsertAsyncTask(settled);
    // Stale snapshot arrives late (e.g. a callback held the pre-settle record).
    mgr.upsertAsyncTask(runningRecord());
    const final = (s.asyncTasks ?? []).find((t) => t.id === "sub_wt");
    expect(final?.status).toBe("completed");
    expect(final?.result).toBe("found 2 confirmed IDOR chains");
    // Terminal→terminal rewrites still pass (the legitimate teardown write).
    mgr.upsertAsyncTask(withWorktreeCleared(settled));
    expect((s.asyncTasks ?? []).find((t) => t.id === "sub_wt")?.worktreePath).toBeUndefined();
  });

  // The teardown's second upsert sits behind multi-second git awaits; if a
  // sweep archived the task in that window, the late write must update the
  // archived copy instead of pushing a duplicate back into the live roster.
  it("updates an archived task in place instead of resurrecting it into the live roster", () => {
    const s = session();
    const mgr = new SubagentManager(testHost(s).host);
    const settled = { ...settledRecord(), archived: true, notifiedAt: nowIso() };
    s.asyncTasksArchived = [settled];
    s.asyncTasks = [];
    mgr.upsertAsyncTask(withWorktreeCleared(settled));
    expect(s.asyncTasks).toHaveLength(0);
    const archived = (s.asyncTasksArchived ?? []).filter((t) => t.id === "sub_wt");
    expect(archived).toHaveLength(1);
    expect(archived[0]?.status).toBe("completed");
    expect(archived[0]?.archived).toBe(true);
    expect(archived[0]?.worktreePath).toBeUndefined();
  });
});
