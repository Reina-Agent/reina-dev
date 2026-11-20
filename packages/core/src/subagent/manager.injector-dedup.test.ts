import { describe, expect, it } from "vitest";
import type {
  AsyncTaskRecord,
  SessionState,
  ToolCallRecord,
} from "@reina/protocol";
import { nowIso, createId } from "@reina/protocol";
import type { SubagentHost } from "./types.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** Pin the contract between the manual gather/check tools and the
 * event-driven completion injector: if the supervisor manually reads
 * a settled background task, the injector must NOT also push the
 * same payload on the next safe boundary. Without this dedup, the
 * supervisor pays for the same result twice (gather output + later
 * `<task-notification>` injection). */

function session(): SessionState {
  return testSession({ id: "sess_dedup", cwd: "/tmp/dedup" });
}

function host(s: SessionState): SubagentHost {
  return testHost(s).host;
}

function settledTask(id: string, over: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id,
    agent: "default",
    description: "x",
    status: "completed",
    startedAt: nowIso(),
    completedAt: nowIso(),
    isolation: "none",
    result: "ok",
    background: true,
    ...over,
  };
}

function gatherCall(taskIds: string[]): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: "gather_async_tasks" as ToolCallRecord["name"],
    input: { taskIds },
    summary: "gather",
    permission: "read",
    status: "running",
    createdAt: nowIso(),
  };
}

function checkCall(taskId: string): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: "check_async_task" as ToolCallRecord["name"],
    input: { taskId },
    summary: "check",
    permission: "read",
    status: "running",
    createdAt: nowIso(),
  };
}

function getCall(input: Record<string, unknown>): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: "get_async_tasks",
    input,
    summary: "get tasks",
    permission: "read",
    status: "running",
    createdAt: nowIso(),
  };
}

describe("gather drains the injector for any background task it reads", () => {
  it("removes the pending entry so the next drain does NOT re-emit it", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    const task = settledTask("sub_bg");
    mgr.upsertAsyncTask(task);
    mgr.injector.enqueue(task);
    expect(mgr.injector.size()).toBe(1);

    await mgr.gather(gatherCall(["sub_bg"]));
    expect(mgr.injector.size()).toBe(0);
    expect(task.injectedAt).toBeTruthy();
  });

  it("stamps injectedAt even when the task was settled after gather started", async () => {
    // Simulates the race where settlement enqueues AFTER gather has
    // already produced its output: injectedAt being stamped means a
    // late enqueue() is a no-op (see CompletionInjector.enqueue guard).
    const s = session();
    const mgr = new SubagentManager(host(s));
    const task = settledTask("sub_race");
    mgr.upsertAsyncTask(task);
    // Note: NOT enqueued upfront.
    await mgr.gather(gatherCall(["sub_race"]));
    expect(task.injectedAt).toBeTruthy();
    mgr.injector.enqueue(task);
    expect(mgr.injector.size()).toBe(0);
  });

  it("leaves non-background tasks alone (no injector activity)", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    const fg = settledTask("sub_fg", { background: undefined });
    mgr.upsertAsyncTask(fg);
    expect(mgr.injector.size()).toBe(0);
    await mgr.gather(gatherCall(["sub_fg"]));
    // No injectedAt stamping needed when there was no background path.
    expect(fg.injectedAt).toBeUndefined();
  });

  it("does not touch the injector for tasks that are still running", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    const running = settledTask("sub_run", { status: "running", completedAt: undefined, result: undefined });
    mgr.upsertAsyncTask(running);
    await mgr.gather(gatherCall(["sub_run"]));
    expect(running.injectedAt).toBeUndefined();
    expect(mgr.injector.size()).toBe(0);
  });
});

describe("check_async_task applies the same dedup as gather", () => {
  it("drains the pending injector entry for the checked id", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    const task = settledTask("sub_chk");
    mgr.upsertAsyncTask(task);
    mgr.injector.enqueue(task);
    expect(mgr.injector.size()).toBe(1);
    await mgr.check(checkCall("sub_chk"));
    expect(mgr.injector.size()).toBe(0);
    expect(task.injectedAt).toBeTruthy();
  });
});

describe("get_async_tasks canonical read views", () => {
  it("resolves assigned names and returns full bodies with missing refs preserved", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    mgr.upsertAsyncTask(settledTask("sub_named", { name: "reviewer", result: "named result" }));

    const observation = await mgr.get(getCall({ taskRefs: ["reviewer", "missing-worker"], detail: "full" }));

    expect(observation.output).toContain('<task id="sub_named"');
    expect(observation.output).toContain("named result");
    expect(observation.output).toContain('<task id="missing-worker" missing="true" />');
  });

  it("returns activity and preserves acknowledgement/injector dedup semantics", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    const task = settledTask("sub_activity", { name: "activity-worker" });
    mgr.upsertAsyncTask(task);
    mgr.injector.enqueue(task);

    const observation = await mgr.get(getCall({ taskRefs: ["activity-worker"], detail: "activity" }));

    expect(observation.output).toContain('<async_task_activity count="1">');
    expect(observation.output).toContain("<task_id>sub_activity</task_id>");
    expect(mgr.injector.size()).toBe(0);
    expect(task.injectedAt).toBeTruthy();
  });

  it("returns compact headers and validates detail", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    mgr.upsertAsyncTask(settledTask("sub_header", { name: "header-worker" }));

    const headers = await mgr.get(getCall({ detail: "headers" }));
    expect(headers.output).toContain("[completed] sub_header (header-worker)");

    const invalid = await mgr.get(getCall({ detail: "unknown" }));
    expect(invalid.error).toContain("requires detail");
  });

  it("omits already-returned foreground tasks when full detail targets the roster", async () => {
    const s = session();
    const mgr = new SubagentManager(host(s));
    mgr.upsertAsyncTask(settledTask("sub_background", { sync: false }));
    mgr.upsertAsyncTask(settledTask("sub_foreground", { sync: true, background: false }));

    const observation = await mgr.get(getCall({ detail: "full" }));

    expect(observation.output).toContain('id="sub_background"');
    expect(observation.output).not.toContain('id="sub_foreground"');
  });
});
