import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { AgentEngine } from "../engine.js";
import type { BubbleApprovalDecision } from "./types.js";

/** Fork-mode bubble (P0-1 supplement): a child engine running in
 * `permissionMode: "bubble"` forwards its pending tool approvals to the
 * parent's HITL flow instead of stashing them in its own pending map.
 * The parent mirrors the request, awaits the user's decision, then
 * forwards the verdict back to the awaiting child Promise.
 *
 * These tests exercise the parent-side adapter directly so we don't have
 * to drive a real fork tool loop end-to-end — that's covered by the
 * existing async-task tests; here we want to pin the bubble contract. */

let cwd: string;
let oldConfigHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-bubble-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hi", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function fakeChildRecord(name = "write_file", input: unknown = { path: "x.txt", content: "z" }): ToolCallRecord {
  return {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    name: name as ToolCallRecord["name"],
    input,
    summary: `${name}`,
    permission: "write",
    status: "pending_approval",
    createdAt: nowIso(),
  };
}

/** Reach into the private subagent host adapter for the test. The bubble
 * adapter is intentionally not part of the engine's public API — tests
 * use the same cast-to-`unknown` seam that other engine internals tests
 * rely on (e.g., `asyncTaskChildren`, `upsertAsyncTask`). */
type HostSeam = {
  requestBubbleApproval: (input: {
    taskId: string;
    taskName?: string;
    childRecord: ToolCallRecord;
  }) => Promise<BubbleApprovalDecision>;
};

function hostOf(engine: AgentEngine): HostSeam {
  // `createSubagentHost` is private, but the engine constructs one and
  // hands it to its SubagentManager. The manager is what we want.
  // We don't keep a reference, so build a fresh adapter via the same
  // private factory.
  const callable = (engine as unknown as { createSubagentHost: () => HostSeam }).createSubagentHost;
  return callable.call(engine);
}

describe("requestBubbleApproval (parent-side adapter)", () => {
  it("mints a mirror record on the parent with bubbledFromTask attribution", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const child = fakeChildRecord();

    // Fire-and-forget: the promise resolves only after resolveApproval.
    const pending = host.requestBubbleApproval({
      taskId: "sub_abc",
      taskName: "audit",
      childRecord: child,
    });

    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_abc");
    expect(mirror).toBeDefined();
    expect(mirror?.bubbledFromTask).toEqual({ id: "sub_abc", name: "audit" });
    expect(mirror?.status).toBe("pending_approval");
    expect(mirror?.id).not.toBe(child.id); // mirror gets a fresh id

    // Resolve so the dangling Promise doesn't leak between tests.
    await engine.resolveApproval(mirror!.id, false, { reason: "cleanup" });
    await pending;
  });

  it("omits the name field when the task is unnamed", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const child = fakeChildRecord();

    const pending = host.requestBubbleApproval({ taskId: "sub_xyz", childRecord: child });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_xyz");
    expect(mirror?.bubbledFromTask).toEqual({ id: "sub_xyz" });

    await engine.resolveApproval(mirror!.id, false, {});
    await pending;
  });

  it("resolves with approved=true and forwards updatedInput when the user approves", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const child = fakeChildRecord("run_shell", { command: "ls" });

    const pending = host.requestBubbleApproval({ taskId: "sub_1", childRecord: child });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_1")!;

    await engine.resolveApproval(mirror.id, true, { updatedInput: { command: "ls -la" }, remember: "session" });
    const decision = await pending;

    expect(decision.approved).toBe(true);
    expect(decision.options?.updatedInput).toEqual({ command: "ls -la" });
    expect(decision.options?.remember).toBe("session");
    // Mirror is stamped completed for the parent's audit trail.
    expect(mirror.status).toBe("completed");
    expect(mirror.completedAt).toBeDefined();
  });

  it("resolves with approved=false and forwards the rejection reason", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const child = fakeChildRecord();

    const pending = host.requestBubbleApproval({ taskId: "sub_2", childRecord: child });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_2")!;

    await engine.resolveApproval(mirror.id, false, { reason: "too risky" });
    const decision = await pending;

    expect(decision.approved).toBe(false);
    expect(decision.options?.reason).toBe("too risky");
    expect(mirror.status).toBe("rejected");
    expect(mirror.error).toContain("too risky");
  });

  it("never executes the tool locally on the parent (the child runs it)", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    // Use write_file — if the parent mistakenly ran this, the file would appear on disk.
    const targetPath = path.join(cwd, "should-not-exist.txt");
    const child = fakeChildRecord("write_file", { path: targetPath, content: "leak" });

    const pending = host.requestBubbleApproval({ taskId: "sub_safe", childRecord: child });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_safe")!;
    await engine.resolveApproval(mirror.id, true, {});
    await pending;

    // The parent's "execution" is purely bookkeeping — no file should have been written.
    await expect(rm(targetPath)).rejects.toThrow();
  });
});

describe("real-time surfacing + interrupt cleanup", () => {
  it("emits a permission-request stream event when the mirror is minted", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const stop = engine.onStream((event) => events.push(event as unknown as { type: string } & Record<string, unknown>));

    const pending = host.requestBubbleApproval({ taskId: "sub_rt", taskName: "writer", childRecord: fakeChildRecord() });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_rt")!;

    // The mirror must surface in real time: the parent's turn may be blocked
    // driving a sync child, so the turn-end permission_request can never fire.
    const pushed = events.find((e) => e.type === "permission-request") as
      | { toolCall?: ToolCallRecord }
      | undefined;
    expect(pushed).toBeDefined();
    expect(pushed?.toolCall?.id).toBe(mirror.id);
    expect(pushed?.toolCall?.bubbledFromTask?.id).toBe("sub_rt");

    stop();
    await engine.resolveApproval(mirror.id, false, {});
    await pending;
  });

  it("interrupt() rejects outstanding bubbled approvals so awaiting children unblock", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);

    const pending = host.requestBubbleApproval({ taskId: "sub_int", childRecord: fakeChildRecord() });
    const mirror = engine.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_int")!;

    engine.interrupt();

    // Without the drain, the child would await this promise forever (the
    // watchdog pauses on pending_approval, so nothing else unblocks it).
    const decision = await Promise.race([
      pending,
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 250)),
    ]);
    expect(decision).not.toBe("stuck");
    expect((decision as BubbleApprovalDecision).approved).toBe(false);
    expect(mirror.status).toBe("rejected");
  });
});

describe("setBubbleApprovalHandler + bubble loop", () => {
  it("installs a handler that the engine can later invoke", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    let called = false;
    engine.setBubbleApprovalHandler(async () => {
      called = true;
      return { approved: true };
    });
    // The handler is private state; exercise it indirectly through the engine.
    const handler = (engine as unknown as { bubbleApprovalHandler?: (r: ToolCallRecord) => Promise<BubbleApprovalDecision> })
      .bubbleApprovalHandler;
    expect(typeof handler).toBe("function");
    await handler!(fakeChildRecord());
    expect(called).toBe(true);
  });

  it("clears the handler when passed undefined", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.setBubbleApprovalHandler(async () => ({ approved: true }));
    engine.setBubbleApprovalHandler(undefined);
    const handler = (engine as unknown as { bubbleApprovalHandler?: unknown }).bubbleApprovalHandler;
    expect(handler).toBeUndefined();
  });
});

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** E2E for the silent approval gap: non-fork children (sync `task` and
 * plain start_async_task) must bubble gated tool calls to the parent
 * exactly like fork children do, instead of parking them in their own
 * unreachable pending map and returning a half answer. Drives REAL child
 * engines through the deterministic provider ("run echo ..." needs
 * approval in default mode — pinned by engine.test.ts). */
describe("non-fork children bubble approvals (E2E)", () => {
  it("sync task: the child's gated shell command bubbles up; approve → child executes and the task completes", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const turn = engine.runTurn("task run echo bubble-e2e");

    const mirror = await waitFor(() =>
      engine.session.toolCalls.find((c) => c.bubbledFromTask && c.status === "pending_approval"),
    );
    expect(mirror.name).toBe("run_shell");

    await engine.resolveApproval(mirror.id, true, {});
    const result = await turn;

    const task = result.session.toolCalls.find((c) => c.name === "task");
    expect(task?.status).toBe("completed");
    expect(task?.error).toBeUndefined();
    expect(task?.output ?? "").not.toMatch(/approval/i);
    expect(mirror.status).toBe("completed");
  });

  it("background async (non-fork): bubbles while the parent is idle; approve → task settles completed", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const events: Array<{ type: string }> = [];
    const stop = engine.onStream((event) => events.push(event as unknown as { type: string }));

    await engine.runTurn("async_start_bg run echo bg-bubble");

    const mirror = await waitFor(() =>
      engine.session.toolCalls.find((c) => c.bubbledFromTask && c.status === "pending_approval"),
    );
    // The real-time stream event fired even though the parent turn is over.
    expect(events.some((e) => e.type === "permission-request")).toBe(true);

    await engine.resolveApproval(mirror.id, true, {});
    const task = await waitFor(() => {
      const entry = engine.session.asyncTasks?.[0];
      return entry && entry.status !== "running" ? entry : undefined;
    });
    stop();
    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
  });

  it('remember:"session" from a bubbled approval suppresses the child\'s next identical prompt', async () => {
    // The dock offers "always allow (session)" on bubbled approvals; the
    // parent forwards it in the decision. The child must apply it to its own
    // sessionApprovals, or the same subagent re-asks for every identical call.
    const child = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    let handlerCalls = 0;
    child.setBubbleApprovalHandler(async () => {
      handlerCalls++;
      return { approved: true, options: { remember: "session" } };
    });

    await child.runTurn("run echo remember-me");
    expect(handlerCalls).toBe(1);

    await child.runTurn("run echo remember-me");
    expect(handlerCalls).toBe(1);

    const shells = child.session.toolCalls.filter((c) => c.name === "run_shell");
    expect(shells).toHaveLength(2);
    expect(shells.every((c) => c.status === "completed")).toBe(true);
  });

  it('remember:"session" is parent-session scoped: a later sibling child skips the prompt', async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const turn1 = engine.runTurn("task run echo remember-sib");
    const mirror1 = await waitFor(() =>
      engine.session.toolCalls.find((c) => c.bubbledFromTask && c.status === "pending_approval"),
    );
    await engine.resolveApproval(mirror1.id, true, { remember: "session" });
    await turn1;

    // Fresh dispatch → fresh child engine. The shared session registry must
    // give it a free pass for the identical command — no second bubble.
    let secondMirror: ToolCallRecord | undefined;
    const turn2 = engine.runTurn("task run echo remember-sib");
    await waitFor(() => {
      secondMirror = engine.session.toolCalls.find((c) => c.bubbledFromTask && c.status === "pending_approval");
      if (secondMirror) return true;
      const tasks = engine.session.toolCalls.filter((c) => c.name === "task");
      return tasks.length === 2 && tasks[1]!.status !== "running" ? true : undefined;
    });
    // Unblock a wrong second bubble so the failure is an assertion, not a hang.
    if (secondMirror) await engine.resolveApproval(secondMirror.id, true, {});
    await turn2;
    expect(secondMirror).toBeUndefined();
  });

  it("shared remember rules are cwd-scoped: same-cwd child skips, different-cwd child re-asks", async () => {
    const parent = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    // Reverse direction: the PARENT's own remembered approval mints the rule.
    const r1 = await parent.runTurn("run echo iso-check");
    await parent.resolveApproval(r1.pendingApprovals[0]!.id, true, { remember: "session" });

    const spawn = (parent as unknown as { spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine })
      .spawnChildEngine.bind(parent);

    const sameCwdChild = spawn({ cwd, agent: "default" });
    let sameCwdPrompts = 0;
    sameCwdChild.setBubbleApprovalHandler(async () => {
      sameCwdPrompts++;
      return { approved: true };
    });
    await sameCwdChild.runTurn("run echo iso-check");
    expect(sameCwdPrompts).toBe(0);

    // A worktree-isolated child runs in a different cwd: the exact-input rule
    // was vetted against the parent's tree, so it must NOT transfer.
    const otherCwd = await mkdtemp(path.join(os.tmpdir(), "reina-bubble-other-"));
    try {
      const otherChild = spawn({ cwd: otherCwd, agent: "default" });
      let otherPrompts = 0;
      otherChild.setBubbleApprovalHandler(async () => {
        otherPrompts++;
        return { approved: true };
      });
      await otherChild.runTurn("run echo iso-check");
      expect(otherPrompts).toBe(1);
    } finally {
      await rmTempDirWithRetry(otherCwd);
    }
  });

  it("a bypass-mode parent's child inherits bypass — no prompt, no bubble", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "bypass" });
    const result = await engine.runTurn("task run echo no-bubble");

    const task = result.session.toolCalls.find((c) => c.name === "task");
    expect(task?.status).toBe("completed");
    expect(result.session.toolCalls.some((c) => c.bubbledFromTask)).toBe(false);
  });
});
