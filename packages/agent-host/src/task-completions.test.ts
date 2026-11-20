import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEngine } from "@reina/core";
import type { DesktopOutbound, DesktopRequest } from "@reina/desktop-protocol";
import type { ToolCallRecord } from "@reina/protocol";
import { getBackgroundShellTaskSnapshot, runTool, stopBackgroundShellTask } from "@reina/tools";
import { AgentHost } from "./index.js";

type LiveSession = {
  engine: AgentEngine;
  active: boolean;
  turnPromise: Promise<void> | null;
};

type HostInternals = {
  sessions: Map<string, LiveSession>;
  wakeForBackgroundCompletions(sessionId: string): void;
};

let root: string;
let cwd: string;
const hosts: AgentHost[] = [];
const shells: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "reina-host-completions-"));
  cwd = path.join(root, "workspace");
  await mkdir(cwd);
  vi.stubEnv("REINA_CONFIG_HOME", path.join(root, "config"));
  // Stdin is a deterministic latch: the command can only finish after the test
  // has established the host's idle, Stop, approval, or restore state.
  await writeFile(path.join(cwd, "completion-worker.cjs"),
    "process.stdin.resume(); process.stdin.once('data', () => { process.stdout.write('HOST_COMPLETION_OK'); process.exit(0); });\n");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const taskId of shells.splice(0)) {
    await stopBackgroundShellTask(cwd, taskId).catch(() => undefined);
    // Snapshot waits for the task's metadata/output persistence queue.
    await getBackgroundShellTaskSnapshot(cwd, taskId).catch(() => undefined);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("reina-host-completions-")) {
    throw new Error(`Unexpected temporary directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fixture(): { host: AgentHost; events: DesktopOutbound[]; internals: HostInternals } {
  const events: DesktopOutbound[] = [];
  const host = new AgentHost((event) => events.push(event));
  hosts.push(host);
  return { host, events, internals: host as unknown as HostInternals };
}

async function createSession(host: AgentHost, hooks?: Extract<DesktopRequest, { type: "create_session" }>["hooks"]): Promise<LiveSession> {
  const response = await host.handle({
    id: "create", type: "create_session", cwd, hooks,
    model: { provider: "deterministic", model: "reina-deterministic" },
  });
  expect(response).toMatchObject({ success: true });
  const sessionId = (response as { data: { sessionId: string } }).data.sessionId;
  return (host as unknown as HostInternals).sessions.get(sessionId)!;
}

async function startShell(session: LiveSession): Promise<string> {
  const result = await runTool("run_shell", {
    command: "node completion-worker.cjs", runInBackground: true,
  }, { cwd, sessionId: session.engine.session.id });
  expect(result.output).toEqual(expect.any(String));
  const taskId = (JSON.parse(result.output!) as { taskId: string }).taskId;
  expect(taskId).toMatch(/^shell_/);
  shells.push(taskId);
  return taskId;
}

async function finishShell(taskId: string): Promise<void> {
  await runTool("write_stdin", { taskId, data: "finish" }, { cwd });
  await runTool("task_output", { taskId, block: true, timeoutMs: 8_000 }, { cwd });
  const snapshot = await getBackgroundShellTaskSnapshot(cwd, taskId);
  expect(snapshot.task.status).toBe("completed");
  expect(snapshot.output).toContain("HOST_COMPLETION_OK");
}

function started(events: DesktopOutbound[], sessionId: string): Array<Extract<DesktopOutbound, { type: "turn_started" }>> {
  return events.filter((event): event is Extract<DesktopOutbound, { type: "turn_started" }> =>
    event.type === "turn_started" && event.sessionId === sessionId);
}

async function awaitCompletion(events: DesktopOutbound[], session: LiveSession): Promise<void> {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === "turn_completed" && event.sessionId === session.engine.session.id)).toBe(true);
    expect(session.active).toBe(false);
  }, { timeout: 10_000, interval: 10 });
}

async function flushDeferredWakes(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("AgentHost task completion delivery", () => {
  test("a real background shell wakes its idle owning session and not a sibling", async () => {
    const { host, events } = fixture();
    const owner = await createSession(host);
    const sibling = await createSession(host);
    const taskId = await startShell(owner);
    await finishShell(taskId);
    await awaitCompletion(events, owner);

    expect(started(events, owner.engine.session.id).map((event) => event.source)).toEqual(["background_completion"]);
    const notices = owner.engine.session.messages.filter((message) => message.origin === "task-notify");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain(taskId);
    expect(notices[0]!.content).toContain('status="completed"');
    expect(owner.engine.hasPendingCompletionNotifications()).toBe(false);
    expect((await getBackgroundShellTaskSnapshot(cwd, taskId)).task.injectedAt).toBeTruthy();
    expect(started(events, sibling.engine.session.id)).toHaveLength(0);
    expect(sibling.engine.session.messages.some((message) => message.origin === "task-notify")).toBe(false);
  });

  test("Stop suppresses automatic resumption but the next user turn consumes the completion", async () => {
    const { host, events } = fixture();
    const live = await createSession(host);
    const sessionId = live.engine.session.id;
    const taskId = await startShell(live);
    await host.handle({ id: "stop", type: "interrupt", sessionId });
    await finishShell(taskId);
    await flushDeferredWakes();

    expect(live.engine.session.interrupted).toBe(true);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(true);
    expect(started(events, sessionId)).toHaveLength(0);

    await host.handle({ id: "continue", type: "send_message", sessionId, message: "Continue with the finished command." });
    await awaitCompletion(events, live);
    expect(started(events, sessionId).map((event) => event.source)).toEqual(["user"]);
    expect(live.engine.session.messages.some((message) => message.origin === "task-notify" && message.content.includes(taskId))).toBe(true);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(false);
  });

  test.each(["approval", "question"] as const)("a completion preserves an idle pending %s gate", async (gate) => {
    const { host, events } = fixture();
    const live = await createSession(host);
    const sessionId = live.engine.session.id;
    const pending = (live.engine as unknown as { pending: Map<string, ToolCallRecord> }).pending;
    const approval: ToolCallRecord = {
      id: "approval", name: "run_shell", input: { command: "echo needs-approval" },
      summary: "Await approval", permission: "execute", status: "pending_approval", createdAt: new Date().toISOString(),
    };
    if (gate === "approval") pending.set(approval.id, approval);
    else live.engine.session.pendingQuestions.push({
      id: "question", question: "Choose the next action", status: "pending", createdAt: new Date().toISOString(),
    });
    const taskId = await startShell(live);
    await finishShell(taskId);
    await flushDeferredWakes();

    expect(started(events, sessionId)).toHaveLength(0);
    expect(live.engine.hasPendingUserGate()).toBe(true);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(true);
    if (gate === "approval") expect(pending.get(approval.id)).toBe(approval);
    else expect(live.engine.session.pendingQuestions[0]).toMatchObject({ id: "question", status: "pending" });

    // Once the user resolves the gate, their next turn can consume the queued
    // completion. The notification itself must never resolve or clear the gate.
    pending.clear();
    live.engine.session.pendingQuestions = [];
    await host.handle({ id: "continue", type: "send_message", sessionId, message: "Continue." });
    await awaitCompletion(events, live);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(false);
  });

  test("a prompt hook that blocks delivery is attempted only once for the same completion", async () => {
    const { host, events, internals } = fixture();
    await writeFile(path.join(cwd, "block-prompt.cjs"), "process.stdout.write(JSON.stringify({ block: true, message: 'blocked for test' }));\n");
    const live = await createSession(host, { userPromptSubmit: [{ command: "node block-prompt.cjs" }] });
    const runTurn = vi.spyOn(live.engine, "runTurn");
    const taskId = await startShell(live);
    await finishShell(taskId);
    await awaitCompletion(events, live);
    for (let i = 0; i < 3; i++) internals.wakeForBackgroundCompletions(live.engine.session.id);
    await flushDeferredWakes();

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(started(events, live.engine.session.id)).toHaveLength(1);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(true);
    expect(live.engine.session.messages.some((message) => message.content.includes("(blocked)"))).toBe(true);
    expect((await getBackgroundShellTaskSnapshot(cwd, taskId)).task.injectedAt).toBeUndefined();
  });

  test("a rejected turn does not spin in finally while its completion remains pending", async () => {
    const { host, events, internals } = fixture();
    const live = await createSession(host);
    let attempts = 0;
    vi.spyOn(live.engine, "runTurn").mockImplementation(async () => {
      attempts++;
      // Bound the regression too: a broken host would otherwise spin forever
      // in microtasks and prevent the test runner from reaching its timeout.
      if (attempts > 3) live.engine.session.interrupted = true;
      throw new Error("controlled failure before notification consumption");
    });
    const taskId = await startShell(live);
    await finishShell(taskId);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "turn_failed")).toBe(true);
      expect(live.active).toBe(false);
    });
    for (let i = 0; i < 3; i++) internals.wakeForBackgroundCompletions(live.engine.session.id);
    await flushDeferredWakes();

    expect(attempts).toBe(1);
    expect(started(events, live.engine.session.id)).toHaveLength(1);
    expect(live.engine.hasPendingCompletionNotifications()).toBe(true);
    expect(live.engine.session.interrupted).not.toBe(true);
  });

  test("cold loading detects a persisted completion queued before the host subscribes", async () => {
    const { host, events, internals } = fixture();
    const original = await createSession(host);
    const sessionId = original.engine.session.id;
    const taskId = await startShell(original);
    await original.engine.saveSession();
    expect(await host.handle({ id: "close", type: "close_session", sessionId })).toMatchObject({ success: true });
    await finishShell(taskId);
    expect((await getBackgroundShellTaskSnapshot(cwd, taskId)).task.injectedAt).toBeUndefined();
    expect(started(events, sessionId)).toHaveLength(0);

    expect(await host.handle({ id: "load", type: "load_session", cwd, savedSessionId: sessionId })).toMatchObject({ success: true });
    const restored = internals.sessions.get(sessionId)!;
    expect(restored.engine).not.toBe(original.engine);
    await awaitCompletion(events, restored);
    expect(started(events, sessionId).map((event) => event.source)).toEqual(["background_completion"]);
    expect(restored.engine.session.messages.some((message) => message.origin === "task-notify" && message.content.includes(taskId))).toBe(true);
    expect(restored.engine.hasPendingCompletionNotifications()).toBe(false);
    expect((await getBackgroundShellTaskSnapshot(cwd, taskId)).task.injectedAt).toBeTruthy();
  });
});
