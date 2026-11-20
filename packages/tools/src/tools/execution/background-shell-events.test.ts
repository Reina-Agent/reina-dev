import * as execaModule from "execa";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolRuntimeOptions } from "../../types.js";
import {
  acknowledgeBackgroundShellCompletion,
  getBackgroundShellTaskSnapshot,
  listPendingBackgroundShellCompletions,
  monitorTool,
  startBackgroundShell,
  stopBackgroundShellTask,
  subscribeBackgroundShellCompletions,
  taskOutputTool,
  type BackgroundShellTaskRecord,
} from "./background-shell.js";
import { shellTool } from "./shell.js";

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

describe("background shell completion delivery", () => {
  const roots: string[] = [];
  const started: Array<{ root: string; id: string }> = [];
  const cleanups: Array<() => void> = [];
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const waitingScript = "process.stdin.resume();process.stdout.write('READY\\n');setTimeout(()=>process.exit(0),15000);";

  function workspace(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "reina-shell-events-"));
    roots.push(root);
    return root;
  }

  function command(root: string, script: string): string {
    const scriptPath = path.join(root, `command-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(scriptPath, script);
    return `node ${path.basename(scriptPath)}`;
  }

  function start(root: string, script = waitingScript, sessionId = "owner"): string {
    const id = startBackgroundShell({ command: command(root, script), cwd: root, workdir: root, sessionId, shell });
    started.push({ root, id });
    return id;
  }

  function eventSource() {
    let pending = false;
    const listeners = new Set<() => void>();
    const taskEvents: NonNullable<ToolRuntimeOptions["taskEvents"]> = {
      hasPending: () => pending,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    return {
      taskEvents,
      listeners,
      publish: () => { pending = true; for (const listener of listeners) listener(); },
    };
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const { root, id } of started.splice(0)) {
      await stopBackgroundShellTask(root, id).catch(() => undefined);
      await getBackgroundShellTaskSnapshot(root, id).catch(() => undefined);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^reina-shell-events-/);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes one owned event for each terminal outcome, but none for foreground commands", async () => {
    const root = workspace();
    const events: BackgroundShellTaskRecord[] = [];
    cleanups.push(subscribeBackgroundShellCompletions((event) => events.push(event)));
    await shellTool.execute({ command: command(root, "process.stdout.write('foreground');"), shell }, { cwd: root, sessionId: "owner" });
    expect(events).toHaveLength(0);

    for (const exitCode of [0, 7]) {
      const result = await shellTool.execute(
        { command: command(root, `process.exit(${exitCode});`), shell, runInBackground: true },
        { cwd: root, sessionId: "owner", toolCallId: `call-${exitCode}` },
      );
      const { taskId } = JSON.parse(result as string) as { taskId: string };
      started.push({ root, id: taskId });
      await taskOutputTool.execute({ taskId, block: true, timeoutMs: 5000 }, { cwd: root });
      expect(events.filter((event) => event.id === taskId)).toEqual([
        expect.objectContaining({ id: taskId, sessionId: "owner", toolCallId: `call-${exitCode}`, status: exitCode === 0 ? "completed" : "failed" }),
      ]);
    }
    const killed = start(root);
    await stopBackgroundShellTask(root, killed);
    expect(events.filter((event) => event.id === killed)).toEqual([
      expect.objectContaining({ id: killed, sessionId: "owner", status: "killed" }),
    ]);
  });

  it.each([taskOutputTool, monitorTool])("wakes $descriptor.name when another task completes, without killing the waiting command", async (tool) => {
    const root = workspace();
    const slow = start(root);
    await monitorTool.execute({ taskId: slow, pattern: "READY", timeoutMs: 5000 }, { cwd: root });
    const source = eventSource();
    cleanups.push(subscribeBackgroundShellCompletions((event) => {
      if (event.sessionId === "owner" && event.id !== slow) source.publish();
    }));
    const waiting = tool.execute(
      { taskId: slow, block: true, pattern: "never-matches", timeoutMs: 5000 },
      { cwd: root, taskEvents: source.taskEvents },
    );
    const fast = start(root, "process.exit(0);");
    const result = await waiting;
    expect(result).toContain("<wake_reason>task_event</wake_reason>");
    expect(result).toContain("<status>running</status>");
    expect(source.listeners.size).toBe(0);
    expect((await getBackgroundShellTaskSnapshot(root, fast)).task.status).toBe("completed");
    expect((await getBackgroundShellTaskSnapshot(root, slow)).task.status).toBe("running");
  });

  it.each([taskOutputTool, monitorTool])("aborts $descriptor.name promptly and removes event listeners", async (tool) => {
    const root = workspace();
    const id = start(root);
    const source = eventSource();
    const controller = new AbortController();
    const waiting = tool.execute(
      { taskId: id, block: true, pattern: "never-matches", timeoutMs: 5000 },
      { cwd: root, signal: controller.signal, taskEvents: source.taskEvents },
    );
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(source.listeners.size).toBe(0);
    expect((await getBackgroundShellTaskSnapshot(root, id)).task.status).toBe("running");
    await expect(tool.execute(
      { taskId: id, block: true, pattern: "never-matches", timeoutMs: 5000 },
      { cwd: root, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles pending events and wait timeouts without leaking subscriptions", async () => {
    const root = workspace();
    const id = start(root);
    const source = eventSource();
    const options = { cwd: root, taskEvents: source.taskEvents };
    expect(await taskOutputTool.execute({ taskId: id, block: true, timeoutMs: 10 }, options)).toContain("<wake_reason>timeout</wake_reason>");
    expect(source.listeners.size).toBe(0);
    source.publish();
    expect(await taskOutputTool.execute({ taskId: id, block: true, timeoutMs: 5000 }, options)).toContain("<wake_reason>task_event</wake_reason>");
    expect(source.listeners.size).toBe(0);
  });

  it.each([true, false])("has no implicit hard timeout when runInBackground=$value, including timed handoff", async (runInBackground) => {
    const root = workspace();
    vi.stubEnv("REINA_SHELL_AUTO_BACKGROUND_AFTER_MS", "10");
    const spawn = vi.mocked(execaModule.execa);
    spawn.mockClear();
    const input = { command: command(root, waitingScript), shell, runInBackground };
    expect(await shellTool.preview?.(input, { cwd: root })).toContain("Timeout: none");
    const result = await shellTool.execute(input, { cwd: root, sessionId: "owner", toolCallId: "source-call" });
    const { taskId, background } = JSON.parse(result as string) as { taskId: string; background: string };
    started.push({ root, id: taskId });
    expect(background).toBe(runInBackground ? "requested" : "timed");
    const spawnCall: readonly unknown[] | undefined = spawn.mock.calls[0];
    expect(spawnCall?.[2]).toMatchObject({ timeout: undefined });
    expect((await getBackgroundShellTaskSnapshot(root, taskId)).task).toMatchObject({ sessionId: "owner", toolCallId: "source-call", status: "running" });
  });

  it("preserves explicit command timeouts after timed background handoff", async () => {
    const root = workspace();
    vi.stubEnv("REINA_SHELL_AUTO_BACKGROUND_AFTER_MS", "10");
    const result = await shellTool.execute(
      { command: command(root, "setTimeout(()=>process.exit(0),3000);"), shell, timeoutMs: 1000 },
      { cwd: root, sessionId: "owner" },
    );
    const { taskId } = JSON.parse(result as string) as { taskId: string };
    started.push({ root, id: taskId });
    expect(await taskOutputTool.execute({ taskId, block: true, timeoutMs: 5000 }, { cwd: root })).toContain("<status>failed</status>");
  });

  it("persists acknowledgement and recovers only unacknowledged completions belonging to the session", async () => {
    const root = workspace();
    const live = start(root, "process.stdout.write('done');");
    await taskOutputTool.execute({ taskId: live, block: true, timeoutMs: 5000 }, { cwd: root });
    expect((await listPendingBackgroundShellCompletions(root, "owner")).map((task) => task.id)).toEqual([live]);
    const injectedAt = "2026-09-06T10:00:00.000Z";
    await acknowledgeBackgroundShellCompletion(root, live, injectedAt);
    const history = path.join(root, ".reina", "background-shells");
    expect(JSON.parse(readFileSync(path.join(history, `${live}.json`), "utf8"))).toMatchObject({ sessionId: "owner", injectedAt });
    expect(await listPendingBackgroundShellCompletions(root, "owner")).toEqual([]);

    const record = (await getBackgroundShellTaskSnapshot(root, live)).task;
    mkdirSync(history, { recursive: true });
    for (const [id, owner] of [["shell_restored", "owner"], ["shell_legacy", undefined], ["shell_other", "other"]]) {
      writeFileSync(path.join(history, `${id}.json`), JSON.stringify({ ...record, id, sessionId: owner, status: "running", injectedAt: undefined }));
    }
    writeFileSync(path.join(history, "shell_restored.log"), "restored output");
    expect(await listPendingBackgroundShellCompletions(root, "owner")).toEqual([
      expect.objectContaining({ id: "shell_restored", status: "lost", sessionId: "owner" }),
    ]);
    const restored = await taskOutputTool.execute({ taskId: "shell_restored", block: true }, { cwd: root });
    expect(restored).toContain("<status>lost</status>");
    expect(restored).toContain("restored output");
    await acknowledgeBackgroundShellCompletion(root, "shell_restored", injectedAt);
    expect(await listPendingBackgroundShellCompletions(root, "owner")).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(history, "shell_restored.json"), "utf8"))).toMatchObject({ status: "lost", injectedAt });
  });
});
