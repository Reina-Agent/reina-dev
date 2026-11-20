import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionState, ToolCallRecord } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import type { BubbleApprovalDecision } from "./types.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** The silent approval gap (fork/sync asymmetry): a sync `task` or non-fork
 * async child that hits a tool approval in default mode parks the record in
 * its OWN pending map — unreachable, child sessions have no HITL surface —
 * and its runTurn returns early. The manager used to read that early return
 * as disposition="completed" and hand the supervisor a half answer with no
 * error. These tests pin the settlement guard: a child that ends its turn
 * still awaiting approval settles as a LOUD failure naming the blocked tool. */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-approval-gap-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

type FakeChild = {
  session: {
    id: string;
    agent: string;
    messages: Array<{ role: string; content: string }>;
    toolCalls: ToolCallRecord[];
    usage: { turns: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number };
    interrupted: boolean;
    submittedResponse?: string;
  };
  bubbleHandler?: (record: ToolCallRecord) => Promise<BubbleApprovalDecision>;
  questionHandler?: unknown;
  onStream: (listener: unknown) => () => void;
  setUserQuestionHandler: (handler: unknown) => void;
  setBubbleApprovalHandler: (handler: (record: ToolCallRecord) => Promise<BubbleApprovalDecision>) => void;
  setSiblingMessageHandler: (handler: unknown) => void;
  runTurn: (prompt: string) => Promise<void>;
  interrupt: () => void;
};

/** Child whose first turn parks a write approval exactly the way a real
 * non-bubble child engine does: pending_approval record on its timeline,
 * half an answer in messages, then the turn returns. */
function fakeChild(behavior: (child: FakeChild) => Promise<void>): FakeChild {
  const child: FakeChild = {
    session: {
      id: `child_${createId("sess").slice(-6)}`,
      agent: "default",
      messages: [],
      toolCalls: [],
      usage: { turns: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      interrupted: false,
    },
    onStream: () => () => undefined,
    setUserQuestionHandler: (handler) => {
      child.questionHandler = handler;
    },
    setBubbleApprovalHandler: (handler) => {
      child.bubbleHandler = handler;
    },
    setSiblingMessageHandler: () => undefined,
    runTurn: () => behavior(child),
    interrupt: () => {
      child.session.interrupted = true;
    },
  };
  return child;
}

function parkedApprovalBehavior(child: FakeChild): Promise<void> {
  child.session.toolCalls.push({
    id: `call_${createId("call").slice(-6)}`,
    name: "write_file" as ToolCallRecord["name"],
    input: { path: "x.txt", content: "z" },
    summary: "write_file",
    permission: "write",
    status: "pending_approval",
    createdAt: nowIso(),
  } as ToolCallRecord);
  child.session.messages.push({ role: "assistant", content: "Now writing the fix to x.txt..." });
  return Promise.resolve();
}

function dispatchCall(name: "task" | "start_async_task", input: Record<string, unknown>): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: name as ToolCallRecord["name"],
    input,
    summary: name,
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  } as unknown as ToolCallRecord;
}

function sessionAt(dir: string): SessionState {
  return testSession({ id: "sess_approval_gap", cwd: dir, permissionMode: "default" } as Partial<SessionState>);
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Child that bubbles: pushes a gated write, awaits the installed bubble
 * handler (throws if the manager forgot to wire one — that throw IS the
 * red assertion for the wiring tests), then settles per the decision. */
function bubblingBehavior(child: FakeChild): Promise<void> {
  const record = {
    id: `call_${createId("call").slice(-6)}`,
    name: "write_file" as ToolCallRecord["name"],
    input: { path: "x.txt", content: "z" },
    summary: "write_file",
    permission: "write",
    status: "pending_approval",
    createdAt: nowIso(),
  } as ToolCallRecord;
  child.session.toolCalls.push(record);
  return child.bubbleHandler!(record).then((decision) => {
    record.status = decision.approved ? "completed" : "rejected";
    child.session.messages.push({ role: "assistant", content: `write ${decision.approved ? "ran" : "was rejected"}` });
  });
}

describe("bubble wiring — every dispatch path routes child approvals to the parent", () => {
  it("runSync wires the bubble handler through to host.requestBubbleApproval", async () => {
    const s = sessionAt(cwd);
    const bubbled: Array<{ taskId: string; childRecord: ToolCallRecord }> = [];
    const child = fakeChild(bubblingBehavior);
    const { host } = testHost(s, {
      spawnChild: () => child as unknown as AgentEngine,
      requestBubbleApproval: async (input) => {
        bubbled.push({ taskId: input.taskId, childRecord: input.childRecord });
        return { approved: true };
      },
    });
    const mgr = new SubagentManager(host);

    const obs = await mgr.runSync(dispatchCall("task", { description: "write the fix", subagentType: "default" }));

    expect(bubbled).toHaveLength(1);
    expect(bubbled[0]?.childRecord.name).toBe("write_file");
    expect(obs.error).toBeUndefined();
    expect(obs.output).toContain("write ran");
  });

  it("startAsync wires the bubble handler on non-fork children", async () => {
    const s = sessionAt(cwd);
    const bubbled: Array<{ taskId: string }> = [];
    const child = fakeChild(bubblingBehavior);
    const { host } = testHost(s, {
      spawnChild: () => child as unknown as AgentEngine,
      requestBubbleApproval: async (input) => {
        bubbled.push({ taskId: input.taskId });
        return { approved: true };
      },
    });
    const mgr = new SubagentManager(host);

    const obs = await mgr.startAsync(
      dispatchCall("start_async_task", { description: "write the fix", agent: "default", background: true }),
    );
    expect(obs.error).toBeUndefined();

    const settled = await waitFor(() => {
      const task = s.asyncTasks?.find((t) => !t.sync);
      return task && task.status !== "running" ? task : undefined;
    });
    expect(bubbled).toHaveLength(1);
    expect(settled.status).toBe("completed");
    expect(settled.result).toContain("write ran");
  });

  it("resumeRecoverable wires the bubble handler on the fresh child", async () => {
    const s = sessionAt(cwd);
    const bubbled: Array<{ taskId: string }> = [];
    const child = fakeChild(bubblingBehavior);
    const { host } = testHost(s, {
      spawnChild: () => child as unknown as AgentEngine,
      requestBubbleApproval: async (input) => {
        bubbled.push({ taskId: input.taskId });
        return { approved: true };
      },
    });
    const mgr = new SubagentManager(host);
    const task = {
      id: "sub_recover",
      agent: "default",
      description: "write the fix",
      status: "recoverable",
      startedAt: nowIso(),
      isolation: "none",
      attemptCount: 1,
    } as NonNullable<SessionState["asyncTasks"]>[number];
    s.asyncTasks = [task];

    await (mgr as unknown as { resumeRecoverable: (t: typeof task, m: string) => Promise<void> }).resumeRecoverable(
      task,
      "pick the work back up",
    );

    const settled = await waitFor(() => {
      const entry = s.asyncTasks?.find((t) => t.id === "sub_recover");
      return entry && entry.status !== "running" && entry.status !== "resuming" ? entry : undefined;
    });
    expect(bubbled).toHaveLength(1);
    expect(settled.status).toBe("completed");
  });
});

describe("settlement guard — a child parked on an approval settles loudly", () => {
  it("runSync converts the parked child into a failed observation naming the blocked tool", async () => {
    const s = sessionAt(cwd);
    const child = fakeChild(parkedApprovalBehavior);
    const { host } = testHost(s, { spawnChild: () => child as unknown as AgentEngine });
    const mgr = new SubagentManager(host);

    const obs = await mgr.runSync(dispatchCall("task", { description: "write the fix", subagentType: "default" }));

    expect(obs.error).toBeDefined();
    expect(obs.error).toContain("write_file");
    expect(obs.error).toMatch(/approval/i);
    const record = s.asyncTasks?.find((t) => t.sync);
    expect(record?.status).toBe("failed");
    expect(record?.error).toMatch(/approval/i);
  });

  it("startAsync settles the parked child as failed with the approval error", async () => {
    const s = sessionAt(cwd);
    const child = fakeChild(parkedApprovalBehavior);
    const { host } = testHost(s, { spawnChild: () => child as unknown as AgentEngine });
    const mgr = new SubagentManager(host);

    const obs = await mgr.startAsync(
      dispatchCall("start_async_task", { description: "write the fix", agent: "default", background: true }),
    );
    expect(obs.error).toBeUndefined(); // dispatch itself succeeds

    const settled = await waitFor(() => {
      const task = s.asyncTasks?.find((t) => !t.sync);
      return task && task.status !== "running" ? task : undefined;
    });
    expect(settled.status).toBe("failed");
    expect(settled.error).toContain("write_file");
    expect(settled.error).toMatch(/approval/i);
  });
});
