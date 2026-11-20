import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBackgroundShellTaskSnapshot,
  killShellTool,
  listBackgroundShellTaskRecords,
  monitorTool,
  startBackgroundShell,
  stopBackgroundShellTask,
  taskOutputTool,
  writeStdinTool,
} from "./background-shell.js";

const exec = (tool: typeof writeStdinTool, input: unknown, cwd: string) => tool.execute(input, { cwd });

describe("write_stdin", () => {
  const started: string[] = [];

  afterEach(async () => {
    // Best-effort cleanup so stray node processes don't linger between tests.
    for (const id of started.splice(0)) {
      await killShellTool.execute({ taskId: id }, { cwd: os.tmpdir() }).catch(() => undefined);
    }
  });

  it("feeds a line into a running background task's stdin", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reina-stdin-"));
    const scriptPath = path.join(dir, "echo-stdin.js");
    // Read stdin until the first newline, echo it back prefixed, then exit.
    writeFileSync(
      scriptPath,
      "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');if(i>=0){process.stdout.write('GOT:'+b.slice(0,i));process.exit(0);}});",
    );
    const taskId = startBackgroundShell({ command: `node "${scriptPath}"`, cwd: dir, workdir: dir });
    started.push(taskId);

    const write = await exec(writeStdinTool, { taskId, data: "hello" }, dir);
    expect(write).toContain("\"bytesWritten\"");

    const output = await exec(taskOutputTool, { taskId, block: true, timeoutMs: 8000 }, dir);
    expect(output).toContain("GOT:hello");
  });

  it("rejects unknown taskIds", async () => {
    await expect(exec(writeStdinTool, { taskId: "shell_does_not_exist", data: "x" }, os.tmpdir())).rejects.toThrow(
      /background task not found/,
    );
  });

  it("rejects writing to a task that has already exited", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reina-stdin-"));
    const taskId = startBackgroundShell({ command: "node -e \"process.exit(0)\"", cwd: dir, workdir: dir });
    started.push(taskId);
    // Let it run to completion.
    await exec(taskOutputTool, { taskId, block: true, timeoutMs: 8000 }, dir);
    await expect(exec(writeStdinTool, { taskId, data: "x" }, dir)).rejects.toThrow(/is not running/);
  });
});

describe("monitor concurrent waiters", () => {
  const started: string[] = [];

  afterEach(async () => {
    for (const id of started.splice(0)) {
      await killShellTool.execute({ taskId: id }, { cwd: os.tmpdir() }).catch(() => undefined);
    }
  });

  // Regression: when 2+ concurrent monitor() waiters match the SAME emitted line,
  // matchAgainstWaiters must resolve every one. settle() splices the waiter out of
  // task.waiters, so iterating the live array would make for...of skip a waiter and
  // orphan it (its monitor() would hang to its own timeout and return "timeout").
  it("resolves every concurrent waiter that matches the same emitted line", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reina-monitor-"));
    const scriptPath = path.join(dir, "echo-stdin.js");
    // Echo each stdin chunk straight to stdout; keep the process alive on stdin.
    writeFileSync(scriptPath, "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d));");
    const taskId = startBackgroundShell({ command: `node "${scriptPath}"`, cwd: dir, workdir: dir });
    started.push(taskId);

    // Three monitors whose patterns all match ONE line. Do NOT await: execute()
    // pushes its waiter synchronously (before the `await new Promise`), so all
    // three are parked before we emit the line. The short timeout makes a
    // regression fail fast (orphaned waiter -> "timeout") instead of hanging.
    const opts = { cwd: dir };
    const p1 = monitorTool.execute({ taskId, pattern: "READY", timeoutMs: 5000 }, opts);
    const p2 = monitorTool.execute({ taskId, pattern: "x=1", timeoutMs: 5000 }, opts);
    const p3 = monitorTool.execute({ taskId, pattern: "y=2", timeoutMs: 5000 }, opts);

    // Emit the single line all three match, only after the waiters are parked.
    await exec(writeStdinTool, { taskId, data: "READY x=1 y=2" }, dir);

    const results = await Promise.all([p1, p2, p3]);
    for (const r of results) expect(r).toContain("<reason>matched</reason>");
  });
});

describe("background task history", () => {
  const roots: string[] = [];
  const started: string[] = [];

  afterEach(async () => {
    for (const id of started.splice(0)) {
      await killShellTool.execute({ taskId: id }, { cwd: os.tmpdir() }).catch(() => undefined);
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists completed task metadata and output under the workspace", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reina-task-history-"));
    roots.push(root);
    const workdir = path.join(root, "nested");
    mkdirSync(workdir);
    const taskId = startBackgroundShell({
      command: "node -e \"process.stdout.write('persisted-output')\"",
      cwd: workdir,
      workdir,
      workspaceRoot: root,
    });
    started.push(taskId);

    await taskOutputTool.execute({ taskId, block: true, timeoutMs: 8000 }, { cwd: root });
    const records = await listBackgroundShellTaskRecords(root);
    const record = records.find((task) => task.id === taskId);
    expect(record).toMatchObject({
      id: taskId,
      status: "completed",
      workspaceRoot: path.resolve(root),
      workdir,
      exitCode: 0,
    });

    const snapshot = await getBackgroundShellTaskSnapshot(root, taskId);
    expect(snapshot.output).toContain("persisted-output");
    expect(snapshot.truncated).toBe(false);
  });

  it("marks a persisted running task as lost when no live process owns it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reina-task-lost-"));
    roots.push(root);
    const taskDir = path.join(root, ".reina", "background-shells");
    mkdirSync(taskDir, { recursive: true });
    const taskId = "shell_stale123";
    writeFileSync(
      path.join(taskDir, `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        command: "long-running-command",
        workdir: root,
        workspaceRoot: root,
        startedAt: "2026-08-27T00:00:00.000Z",
        background: "requested",
        status: "running",
        pty: false,
        outputBytes: 0,
        outputTruncated: false,
      }),
    );

    const records = await listBackgroundShellTaskRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: taskId,
      status: "lost",
      error: "Agent host restarted before the task completed.",
    });
    expect(records[0]?.endedAt).toBeTruthy();
  });

  it("stops a live task through the workspace API", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reina-task-stop-"));
    roots.push(root);
    const taskId = startBackgroundShell({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      cwd: root,
      workdir: root,
      workspaceRoot: root,
    });
    started.push(taskId);

    const stopped = await stopBackgroundShellTask(root, taskId);
    expect(stopped.status).toBe("killed");
    expect(stopped.endedAt).toBeTruthy();
    const snapshot = await getBackgroundShellTaskSnapshot(root, taskId);
    expect(snapshot.task.status).toBe("killed");
  });
});
