import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncTaskRecord, ModelStreamEvent, ToolCallRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

function task(id: string, overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id,
    agent: "default",
    description: id,
    status: "running",
    startedAt: nowIso(),
    isolation: "none",
    background: true,
    ...overrides,
  };
}

function waitCall(input: Record<string, unknown> = {}): ToolCallRecord {
  return {
    id: "call_wait",
    name: "wait_async_tasks",
    input,
    summary: "wait",
    permission: "read",
    status: "running",
    createdAt: nowIso(),
  };
}

function fixture(tasks: AsyncTaskRecord[] = [task("slow"), task("fast")]) {
  const session = testSession({ asyncTasks: tasks });
  const controller = new AbortController();
  const streamListeners = new Set<(event: ModelStreamEvent) => void>();
  const completionListeners = new Set<() => void>();
  let pending = false;
  const { host, emitted, recorded } = testHost(session, {
    signal: controller.signal,
    onStream: (listener) => {
      streamListeners.add(listener);
      return () => { streamListeners.delete(listener); };
    },
    taskEvents: {
      hasPending: () => pending,
      subscribe: (listener) => {
        completionListeners.add(listener);
        return () => { completionListeners.delete(listener); };
      },
    },
  });
  const manager = new SubagentManager(host);
  const emit = (event: ModelStreamEvent): void => {
    for (const listener of streamListeners) listener(event);
  };
  const settle = (id: string): void => {
    const current = session.asyncTasks!.find((entry) => entry.id === id)!;
    Object.assign(current, { status: "completed", result: `${id} result`, completedAt: nowIso() });
    emit({ type: "async-task-updated", task: current });
  };
  const notify = (): void => {
    pending = true;
    for (const listener of completionListeners) listener();
  };
  const expectClean = (): void => {
    expect(streamListeners.size).toBe(0);
    expect(completionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  };
  return { session, host, manager, controller, emitted, recorded, emit, settle, notify, expectClean };
}

describe("subagent waits yield to completions and cancellation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the default all-target settlement behavior", async () => {
    const f = fixture();
    let resolved = false;
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow", "fast"] })).then((value) => {
      resolved = true;
      return value;
    });
    f.settle("fast");
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.settle("slow");
    expect((await waiting).output).toContain('completed="2"');
    f.expectClean();
  });

  it("until any returns the first completed target while its sibling keeps running", async () => {
    const f = fixture();
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow", "fast"], until: "any" }));
    f.settle("fast");
    const result = await waiting;
    expect(result.output).toContain('running="1"');
    expect(result.output).toContain("fast result");
    expect(f.session.asyncTasks![0]!.status).toBe("running");
    f.expectClean();
  });

  it("until any immediately returns an already completed target", async () => {
    const f = fixture();
    f.settle("fast");
    const result = await f.manager.wait(waitCall({ taskIds: ["slow", "fast"], until: "any" }));
    expect(result.output).toContain("fast result");
    f.expectClean();
  });

  it("until activity still observes target stream activity only", async () => {
    const f = fixture();
    let resolved = false;
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow"], until: "activity" })).then((value) => {
      resolved = true;
      return value;
    });
    f.emit({ type: "subagent-event", taskId: "fast", childSessionId: "child_fast", event: { type: "text-delta", text: "tick" } });
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.emit({ type: "subagent-event", taskId: "slow", childSessionId: "child_slow", event: { type: "text-delta", text: "tick" } });
    expect((await waiting).output).toContain('running="1"');
    f.expectClean();
  });

  it("a session completion ends a wait for a different task without acknowledging that completion", async () => {
    const f = fixture();
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow"] }));
    f.settle("fast");
    f.manager.injector.enqueue(f.session.asyncTasks![1]!);
    f.notify();
    const result = await waiting;
    expect(result.output).toContain('id="slow"');
    expect(result.output).toContain('running="1"');
    expect(result.output).not.toContain("fast result");
    expect(f.manager.injector.size()).toBe(1);
    expect(f.session.asyncTasks![1]!.injectedAt).toBeUndefined();
    f.expectClean();
  });

  it("does not sleep when a completion is already pending", async () => {
    const f = fixture();
    f.notify();
    expect((await f.manager.wait(waitCall({ taskIds: ["slow"] }))).output).toContain('running="1"');
    f.expectClean();
  });

  it("aborting only ends the wait and leaves unread completions queued", async () => {
    const f = fixture();
    const interrupt = vi.fn();
    f.manager.children.set("slow", { interrupt } as unknown as AgentEngine);
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow", "fast"] }));
    f.settle("fast");
    f.manager.injector.enqueue(f.session.asyncTasks![1]!);
    f.controller.abort();
    expect((await waiting).error).toContain("Waiting interrupted");
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.session.asyncTasks![0]!.status).toBe("running");
    expect(f.session.asyncTasks![1]!.injectedAt).toBeUndefined();
    expect(f.manager.injector.size()).toBe(1);
    f.expectClean();
  });

  it("an already cancelled wait does not gather or acknowledge results", async () => {
    const f = fixture();
    f.settle("fast");
    f.controller.abort();
    expect((await f.manager.wait(waitCall({ taskIds: ["fast"] }))).error).toContain("Waiting interrupted");
    expect(f.session.asyncTasks![1]!.injectedAt).toBeUndefined();
    f.expectClean();
  });

  it("times out with current results and removes both subscriptions", async () => {
    const f = fixture();
    const waiting = f.manager.wait(waitCall({ taskIds: ["slow"], timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await waiting).output).toContain('running="1"');
    f.expectClean();
  });

  it("a resuming lease remains a live wait target", async () => {
    const f = fixture([task("leased", { status: "resuming" })]);
    let resolved = false;
    const waiting = f.manager.wait(waitCall()).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.settle("leased");
    expect((await waiting).output).toContain("leased result");
    f.expectClean();
  });

  it("internal synchronous waiting ignores unrelated task events but responds to parent abort", async () => {
    const f = fixture();
    const internal = f.manager as unknown as { waitForTaskTerminal(id: string, timeoutMs: number): Promise<void> };
    let resolved = false;
    const waiting = internal.waitForTaskTerminal("slow", 60_000).then(() => { resolved = true; });
    f.notify();
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.controller.abort();
    await waiting;
    expect(f.session.asyncTasks![0]!.status).toBe("running");
    f.expectClean();
  });

  it("synchronous dispatch detaches promptly on parent abort and later notifies its result", async () => {
    const f = fixture([]);
    const child = {
      session: testSession({ id: "child_sync", submittedResponse: "finished later" }),
      interrupt: vi.fn(),
      setBubbleApprovalHandler: vi.fn(),
      setUserQuestionHandler: vi.fn(),
      setSiblingMessageHandler: vi.fn(),
    } as unknown as AgentEngine;
    f.host.spawnChild = () => child;
    const internal = f.manager as unknown as {
      bridgeChildStream(taskId: string, child: AgentEngine): () => void;
    };
    vi.spyOn(internal, "bridgeChildStream").mockReturnValue(() => undefined);
    let complete!: () => void;
    const watchdog = vi.spyOn(f.manager, "runChildWithWatchdog").mockImplementation(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
      return { disposition: "completed", durationMs: 100, timeoutMs: 60_000 };
    });
    const waiting = f.manager.runSync({ ...waitCall({ description: "work" }), name: "task" });
    await Promise.resolve();
    expect(watchdog).toHaveBeenCalledOnce();
    f.controller.abort();
    const result = await waiting;
    expect(result.output).toContain("Foreground waiting was interrupted");
    expect(result.output).toContain("<background>true</background>");
    expect(child.interrupt).not.toHaveBeenCalled();
    expect(f.session.asyncTasks![0]!.status).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.session.asyncTasks![0]!.status).toBe("completed");
    expect(f.manager.injector.drainAtSafeBoundary()[0]!.result).toBe("finished later");
  });
});

describe("subagent completion recovery", () => {
  it("rehydrates only unread terminal background tasks and acknowledges once", async () => {
    const f = fixture([
      task("completed", { status: "completed", result: "saved result" }),
      task("failed", { status: "failed", error: "saved failure" }),
      task("read", { status: "completed", injectedAt: nowIso() }),
      task("foreground", { status: "completed", background: undefined }),
      task("batch", { status: "completed", batchId: "batch_1" }),
    ]);
    await f.manager.recoverStaleOnLoad();
    await f.manager.recoverStaleOnLoad();
    const notifications = f.manager.injector.drainAtSafeBoundary();
    expect(notifications.map((entry) => entry.id)).toEqual(["completed", "failed"]);
    expect(notifications[0]!.result).toBe("saved result");
    expect(notifications[1]!.error).toBe("saved failure");
    await f.manager.recoverStaleOnLoad();
    expect(f.manager.injector.size()).toBe(0);
  });

  it("restores a durable completion and keeps an unexpired recovery lease", async () => {
    const f = fixture([
      task("repaired"),
      task("leased", { status: "resuming", leaseOwner: "other", leaseExpiresAt: "2099-01-01T00:00:00.000Z" }),
    ]);
    await f.manager.recoverStaleOnLoad({
      persistedTasks: [task("repaired", { status: "completed", result: "durable result", completedAt: nowIso() })],
    });
    expect(f.manager.injector.drainAtSafeBoundary().map((entry) => entry.result)).toEqual(["durable result"]);
    expect(f.session.asyncTasks!.find((entry) => entry.id === "leased")!.status).toBe("resuming");
  });

  it("clears a previous session's completion queue even when the loaded session is empty", async () => {
    const f = fixture([]);
    f.manager.injector.enqueue(task("old-session", { status: "completed" }));
    await f.manager.recoverStaleOnLoad();
    expect(f.manager.injector.size()).toBe(0);
  });

  it("persists manual result acknowledgement so recovery does not replay it", async () => {
    const completed = task("read", { status: "completed", result: "read result" });
    const f = fixture([completed]);
    f.manager.injector.enqueue(completed);
    f.manager.gather(waitCall({ taskIds: ["read"] }));
    const record = f.recorded.find((entry) => entry.type === "async_task_update");
    expect(record?.type === "async_task_update" && record.task.injectedAt).toBeTruthy();
    await f.manager.recoverStaleOnLoad();
    expect(f.manager.injector.size()).toBe(0);
  });

  it("rollback removes discarded completions while retaining unread results on the kept branch", () => {
    const f = fixture([]);
    const kept = task("keep", { status: "completed" });
    f.manager.injector.enqueue(kept);
    f.manager.injector.enqueue(task("discard", { status: "completed" }));
    f.manager.pruneChildren(new Set(["keep"]));
    expect(kept.injectedAt).toBeUndefined();
    expect(f.manager.injector.drainAtSafeBoundary().map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("a pruned worker finishing later cannot resurrect its task or inject a result", async () => {
    const f = fixture([task("pruned")]);
    const child = {
      session: testSession({ id: "child_pruned" }),
      interrupt: vi.fn(),
    } as unknown as AgentEngine;
    f.manager.children.set("pruned", child);
    let complete!: () => void;
    vi.spyOn(f.manager, "runChildWithWatchdog").mockImplementation(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
      return { disposition: "completed", durationMs: 100, timeoutMs: 60_000 };
    });
    const unsubscribe = vi.fn();
    const internal = f.manager as unknown as {
      driveAsyncChild(id: string, child: AgentEngine, description: string, unsubscribe: () => void): Promise<void>;
    };
    const driving = internal.driveAsyncChild("pruned", child, "work", unsubscribe);
    f.manager.pruneChildren(new Set());
    f.session.asyncTasks = [];
    complete();
    await driving;
    expect(child.interrupt).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(f.session.asyncTasks).toEqual([]);
    expect(f.manager.injector.size()).toBe(0);
    expect(f.emitted).toEqual([]);
    expect(f.recorded).toEqual([]);
  });
});
