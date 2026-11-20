import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createId, nowIso, type ModelStreamEvent, type ToolCallRecord } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-subagent-chat-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function call(input: Record<string, unknown>, name = "update_async_task"): ToolCallRecord {
  return { id: createId("call"), name, input, summary: name, permission: "state", status: "running", createdAt: nowIso() } as ToolCallRecord;
}

function makeChild(behavior: (prompt: string, child: ReturnType<typeof childState>) => Promise<void>) {
  const child = childState();
  return Object.assign(child, {
    runTurn: async (prompt: string) => {
      child.session.interrupted = false;
      child.session.messages.push({ role: "user", content: prompt });
      await behavior(prompt, child);
    },
  });
}

function childState() {
  const listeners = new Set<(event: ModelStreamEvent) => void>();
  const state = {
    session: {
      id: createId("child"), agent: "default", interrupted: false,
      messages: [] as Array<{ role: string; content: string }>,
      toolCalls: [] as ToolCallRecord[], submittedResponse: undefined as string | undefined,
    },
    onStream: (listener: (event: ModelStreamEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit: (event: ModelStreamEvent) => { for (const listener of listeners) listener(event); },
    interrupt: () => { state.session.interrupted = true; },
    setUserQuestionHandler: () => undefined,
    setBubbleApprovalHandler: () => undefined,
    setSiblingMessageHandler: () => undefined,
  };
  return state;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

async function readEvents(taskId: string, expectedCount: number): Promise<ModelStreamEvent[]> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const source = await readFile(path.join(cwd, ".reina", "tasks", taskId, "stream.jsonl"), "utf8").catch(() => "");
    const events = source.trim().split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line).event as ModelStreamEvent]; } catch { return []; }
    });
    if (events.length >= expectedCount) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Task stream did not flush");
}

function taskEvents(events: ModelStreamEvent[], taskId: string): ModelStreamEvent[] {
  return events.flatMap((event) => event.type === "subagent-event" && event.taskId === taskId ? [event.event] : []);
}

describe("subagent conversation", () => {
  it("persists human and supervisor messages and final answers across settled follow-ups", async () => {
    const session = testSession({ cwd });
    const children: ReturnType<typeof makeChild>[] = [];
    const { host, emitted } = testHost(session, {
      spawnChild: () => {
        const index = children.length;
        const child = makeChild(async (_prompt, live) => {
          live.emit({ type: "text-delta", text: `commentary ${index}` });
          live.session.submittedResponse = `final answer ${index}`;
        });
        children.push(child);
        return child as unknown as AgentEngine;
      },
    });
    const manager = new SubagentManager(host);
    await manager.runSync(call({ description: "original brief" }, "task"));
    const taskId = session.asyncTasks![0]!.id;
    expect(manager.update(call({ taskId, message: "human follow-up" }), "user").error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");
    expect(manager.update(call({ taskId, message: "supervisor follow-up", sender: "user" })).error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");

    const live = taskEvents(emitted, taskId);
    expect(live.filter((event) => event.type === "task-message")).toMatchObject([
      { text: "human follow-up", sender: "user" },
      { text: "supervisor follow-up", sender: "supervisor" },
    ]);
    const starts = live.filter((event) => event.type === "task-turn-started");
    const completions = live.filter((event) => event.type === "task-turn-completed").filter((event) => !event.id.startsWith("prior-"));
    expect(starts).toHaveLength(3);
    expect(completions.map((event) => event.id)).toEqual(starts.map((event) => event.id));
    expect(completions.map((event) => event.text)).toEqual(["final answer 0", "final answer 1", "final answer 2"]);
    const persisted = await readEvents(taskId, live.length);
    expect(persisted).toEqual(live);
    expect(JSON.stringify(persisted)).not.toContain("NO hidden memory");
    expect(children[1]!.session.messages[0]!.content).toContain("original brief");
    expect(children[1]!.session.messages[0]!.content).toContain("final answer 0");
  });

  it("preserves a legacy task's previous final answer before reopening it", async () => {
    const taskId = "legacy-task";
    const session = testSession({ cwd, asyncTasks: [{
      id: taskId, description: "old brief", agent: "default", status: "completed", isolation: "none",
      result: "old answer without a conversation log", startedAt: nowIso(), completedAt: nowIso(),
    }] });
    const child = makeChild(async (_prompt, live) => {
      live.session.messages.push({ role: "assistant", content: "new answer" });
    });
    const { host, emitted } = testHost(session, { spawnChild: () => child as unknown as AgentEngine });
    const manager = new SubagentManager(host);
    expect(manager.update(call({ taskId, message: "follow-up" }), "user").error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");
    const live = taskEvents(emitted, taskId);
    expect(live).toMatchObject([
      { type: "task-turn-completed", id: "prior-legacy-task-1", text: "old answer without a conversation log" },
      { type: "task-message", text: "follow-up", sender: "user" },
      { type: "task-turn-started" },
      { type: "task-turn-completed", text: "new answer" },
    ]);
    expect(await readEvents(taskId, live.length)).toEqual(live);
  });

  it("steers only the targeted running child and starts a separate reply turn", async () => {
    const session = testSession({ cwd });
    let release!: () => void;
    let turns = 0;
    const child = makeChild(async (_prompt, live) => {
      turns++;
      if (turns === 1) {
        live.emit({ type: "text-delta", text: "old partial reply" });
        await new Promise<void>((resolve) => { release = resolve; });
      } else {
        live.emit({ type: "text-delta", text: "new reply" });
        live.session.messages.push({ role: "assistant", content: "new reply" });
      }
    });
    child.interrupt = () => { child.session.interrupted = true; release(); };
    const { host, emitted } = testHost(session, { spawnChild: () => child as unknown as AgentEngine });
    const manager = new SubagentManager(host);
    await manager.startAsync(call({ description: "original brief", name: "worker", background: true }, "start_async_task"));
    const taskId = session.asyncTasks![0]!.id;
    let otherInterrupted = false;
    manager.children.set("other-task", { interrupt: () => { otherInterrupted = true; } } as AgentEngine);
    expect(manager.update(call({ taskRef: "worker", message: "new requirement" }), "user").error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");
    expect(otherInterrupted).toBe(false);
    expect(child.session.messages.filter((message) => message.role === "user").at(-1)?.content).toBe("new requirement");
    const live = taskEvents(emitted, taskId);
    expect(live.map((event) => event.type)).toEqual([
      "task-turn-started", "text-delta", "task-message", "task-turn-started", "text-delta", "task-turn-completed",
    ]);
    expect(await readEvents(taskId, live.length)).toEqual(live);
  });

  it("rejects invalid or unavailable targets without emitting a sent message", () => {
    const session = testSession({ cwd, asyncTasks: [{
      id: "stale", description: "brief", agent: "default", status: "running", startedAt: nowIso(), isolation: "none",
    }] });
    const { host, emitted } = testHost(session);
    const manager = new SubagentManager(host);
    for (const input of [
      { taskId: "stale", message: "   " },
      { taskId: "stale", message: 42 },
      { taskId: {}, message: "new requirement" },
      { taskId: "unknown", message: "new requirement" },
      { taskId: "stale", message: "new requirement" },
    ]) {
      expect(manager.update(call(input), "user").error).toBeTruthy();
    }
    expect(emitted).toEqual([]);
  });

  it("delivers an accepted message that interrupts the stale-task conclude phase", async () => {
    const session = testSession({ cwd });
    let release: (() => void) | undefined;
    let turns = 0;
    const child = makeChild(async (_prompt, live) => {
      turns++;
      if (turns === 1) await new Promise<void>((resolve) => { release = resolve; });
      else live.session.messages.push({ role: "assistant", content: "follow-up delivered" });
    });
    child.interrupt = () => { child.session.interrupted = true; release?.(); };
    const { host, emitted } = testHost(session, { spawnChild: () => child as unknown as AgentEngine });
    const manager = new SubagentManager(host);
    // Enter the real conclude path without waiting for the stale watchdog.
    vi.spyOn(manager, "runChildWithWatchdog").mockResolvedValueOnce({ disposition: "stale", durationMs: 30_000, timeoutMs: 30_000 });
    await manager.startAsync(call({ description: "brief", background: true }, "start_async_task"));
    await waitFor(() => release !== undefined);
    const taskId = session.asyncTasks![0]!.id;
    expect(manager.update(call({ taskId, message: "new requirement during conclude" }), "user").error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");
    expect(child.session.messages.filter((message) => message.role === "user").at(-1)?.content).toBe("new requirement during conclude");
    expect(session.asyncTasks![0]!.result).toBe("follow-up delivered");
    expect(taskEvents(emitted, taskId).filter((event) => event.type === "task-message")).toMatchObject([
      { text: "new requirement during conclude", sender: "user" },
    ]);
  });

  it("rejects failed recovery setup, releases its lease, and allows a later retry", async () => {
    const taskId = "recoverable-task";
    const session = testSession({ cwd, asyncTasks: [{
      id: taskId, description: "brief", agent: "default", status: "recoverable", isolation: "none", startedAt: nowIso(), attemptCount: 1,
    }] });
    let failSetup = true;
    const child = makeChild(async (_prompt, live) => {
      live.session.messages.push({ role: "assistant", content: "recovered" });
    });
    const { host, emitted } = testHost(session, { spawnChild: () => {
      if (failSetup) throw new Error("child setup failed");
      return child as unknown as AgentEngine;
    } });
    const manager = new SubagentManager(host);
    expect(manager.update(call({ taskId, message: "resume" }), "user").error).toContain("child setup failed");
    expect(session.asyncTasks![0]!.status).toBe("recoverable");
    expect(session.asyncTasks![0]!.leaseExpiresAt).toBeUndefined();
    expect(taskEvents(emitted, taskId)).toEqual([]);
    failSetup = false;
    expect(manager.update(call({ taskId, message: "resume" }), "user").error).toBeUndefined();
    await waitFor(() => session.asyncTasks![0]!.status === "completed");
    expect(taskEvents(emitted, taskId).filter((event) => event.type === "task-message")).toHaveLength(1);
  });
});
