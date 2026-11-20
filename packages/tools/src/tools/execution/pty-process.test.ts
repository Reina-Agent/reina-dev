import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptPtyProcess, __setPtySpawnerForTest, type PtyLike, type PtySpawner } from "./pty-process.js";
import { killShellTool, monitorTool, startBackgroundPtyShell, taskOutputTool, writeStdinTool } from "./background-shell.js";

// The PTY stdin shim translates a submitted newline to CR on Windows (ConPTY
// treats Enter as \r), so the byte the pty actually receives is platform-specific.
const ENTER = process.platform === "win32" ? "\r" : "\n";

/** A scriptable stand-in for node-pty's IPty — no native addon, fully deterministic. */
class FakePty implements PtyLike {
  pid = 4242;
  writes: string[] = [];
  killed = false;
  killSignal: string | undefined;
  resized: Array<[number, number]> = [];
  private dataCb: ((data: string) => void) | undefined;
  private exitCb: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  private exited = false;

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
    // Real node-pty fires onExit shortly after a kill — mirror that so the
    // kill_shell completion race resolves promptly instead of timing out.
    this.fireExit(signal ? 143 : 0);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  // ---- test helpers ----
  emitData(data: string): void {
    this.dataCb?.(data);
  }
  fireExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.({ exitCode });
  }
}

/** Install a fake spawner and capture every FakePty it hands out. */
function installFakeSpawner(): FakePty[] {
  const spawned: FakePty[] = [];
  const spawner: PtySpawner = () => {
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  };
  __setPtySpawnerForTest(spawner);
  return spawned;
}

afterEach(async () => {
  __setPtySpawnerForTest(null);
  vi.useRealTimers();
});

describe("adaptPtyProcess", () => {
  it("pipes onData to a readable stdout and flushes on exit", async () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const chunks: string[] = [];
    adapter.stdout?.on("data", (c: Buffer | string) => chunks.push(c.toString()));
    let ended = false;
    adapter.stdout?.on("end", () => {
      ended = true;
    });

    pty.emitData("hello ");
    pty.emitData("world\n");
    pty.fireExit(0);

    const result = await adapter; // resolves once, with exitCode
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toBe("hello world\n");
    // microtask for the stream 'end' to flush
    await new Promise((r) => setImmediate(r));
    expect(ended).toBe(true);
  });

  it("merges everything onto stdout (stderr is undefined)", () => {
    const adapter = adaptPtyProcess(new FakePty(), {});
    expect(adapter.stderr).toBeUndefined();
  });

  it("write() forwards to pty.write and reports writability", () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const stdin = adapter.stdin as unknown as {
      writableEnded: boolean;
      destroyed: boolean;
      write(p: string, cb?: (e?: Error | null) => void): boolean;
      end(): void;
    };
    expect(stdin.writableEnded).toBe(false);
    expect(stdin.destroyed).toBe(false);

    let cbErr: Error | null | undefined = undefined;
    stdin.write("password\n", (e) => {
      cbErr = e;
    });
    expect(cbErr).toBeNull();
    expect(pty.writes).toEqual([`password${ENTER}`]); // \n submitted; \r on Windows

    stdin.end();
    expect(stdin.writableEnded).toBe(true);
    // end() sends the EOF char (^D, 0x04)
    expect(pty.writes[1]).toBe("");
  });

  it("marks stdin not writable after the process exits", () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const stdin = adapter.stdin as unknown as { writableEnded: boolean; destroyed: boolean };
    pty.fireExit(0);
    expect(stdin.writableEnded).toBe(true);
    expect(stdin.destroyed).toBe(true);
  });

  it("exposes pid, a no-throw kill, and a no-op unref", () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {}) as unknown as {
      pid: number;
      kill(sig?: string): boolean;
      unref(): void;
    };
    expect(adapter.pid).toBe(4242);
    expect(() => adapter.unref()).not.toThrow();
    expect(adapter.kill("SIGTERM")).toBe(true);
    expect(pty.killed).toBe(true);
    expect(pty.killSignal).toBe("SIGTERM");
  });

  it("kills the session when an explicit timeout elapses", () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    adaptPtyProcess(pty, { timeoutMs: 5000 });
    expect(pty.killed).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(pty.killed).toBe(true);
  });

  it("never arms a timeout when none is requested", () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    adaptPtyProcess(pty, {});
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(pty.killed).toBe(false);
  });

  it("propagates a non-zero exit code", async () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    pty.fireExit(1);
    const result = await adapter;
    expect(result.exitCode).toBe(1);
  });

  it("drops data emitted AFTER exit instead of crashing on write-after-end", async () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const chunks: string[] = [];
    const errors: unknown[] = [];
    adapter.stdout?.on("data", (c: Buffer | string) => chunks.push(c.toString()));
    adapter.stdout?.on("error", (e) => errors.push(e));

    pty.emitData("before ");
    pty.fireExit(0); // ends the readable
    // A late chunk (node-pty data/exit race). Without the `exited` guard this
    // would be a write() after end() → ERR_STREAM_WRITE_AFTER_END.
    expect(() => pty.emitData("after")).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(chunks.join("")).toBe("before "); // straggler dropped, not appended
    expect(errors).toEqual([]); // and no stream error was emitted
  });

  it("resolves on the FIRST exit and ignores a second (the adapter's own guard)", async () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    let endCount = 0;
    adapter.stdout?.on("end", () => {
      endCount++;
    });
    adapter.stdout?.resume(); // flowing mode so the readable's "end" actually fires
    pty.fireExit(0);
    // Drive a second exit through the adapter's listener directly with a DIFFERENT
    // code: FakePty de-dupes, so reach past it to prove the adapter's own `exited`
    // guard (not just the fake) keeps the first result and avoids a double end().
    (pty as unknown as { exitCb?: (e: { exitCode: number }) => void }).exitCb?.({ exitCode: 99 });
    const result = await adapter;
    expect(result.exitCode).toBe(0); // first exit wins; the code-99 second is ignored
    await new Promise((r) => setImmediate(r));
    expect(endCount).toBe(1); // stdout.end() ran exactly once
  });

  it("disarms the timeout when the process exits on its own first", () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    adaptPtyProcess(pty, { timeoutMs: 5000 });
    pty.fireExit(0); // natural exit before the timer elapses
    pty.killed = false; // clear the kill the fake records on exit, to isolate the timer
    vi.advanceTimersByTime(10_000);
    expect(pty.killed).toBe(false); // the cleared timer must NOT fire a late kill
  });

  it("end() signals EOF by writing the ^D (0x04) control char to the pty", () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const stdin = adapter.stdin as unknown as { end(): void };
    stdin.end();
    expect(pty.writes).toEqual(["\x04"]);
  });

  it("translates submitted newlines to CR on Windows, leaves LF on Unix (ConPTY Enter)", () => {
    const pty = new FakePty();
    const adapter = adaptPtyProcess(pty, {});
    const stdin = adapter.stdin as unknown as { write(p: string): boolean };
    stdin.write("a\nb\n");
    // Real-world bug found via E2E: ConPTY only submits a line on CR, so a
    // write_stdin("…\n") echoed but never submitted (ssh/sudo prompts hung).
    expect(pty.writes).toEqual([process.platform === "win32" ? "a\rb\r" : "a\nb\n"]);
  });
});

describe("startBackgroundPtyShell + task tools", () => {
  const started: string[] = [];

  afterEach(async () => {
    for (const id of started.splice(0)) {
      await killShellTool.execute({ taskId: id }, { cwd: os.tmpdir() }).catch(() => undefined);
    }
  });

  it("registers a running PTY task whose output is readable", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "ssh user@host", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    expect(taskId).toMatch(/^shell_/);
    const pty = spawned[0];

    pty.emitData("Password: ");
    const out = await taskOutputTool.execute({ taskId }, { cwd: os.tmpdir() });
    expect(out).toContain("Password:");
  });

  it("routes write_stdin to the PTY (answers a password prompt)", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "sudo whoami", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    await writeStdinTool.execute({ taskId, data: "hunter2" }, { cwd: os.tmpdir() });
    // write_stdin appends a newline by default; the shim submits it as CR on Windows
    expect(pty.writes).toContain(`hunter2${ENTER}`);
  });

  it("monitor matches a line emitted by the PTY", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "msfconsole", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    const waiter = monitorTool.execute({ taskId, pattern: "msf6 >", timeoutMs: 5000 }, { cwd: os.tmpdir() });
    pty.emitData("msf6 > \n");
    const result = await waiter;
    expect(result).toContain("<reason>matched</reason>");
  });

  it("kill_shell terminates the PTY and marks the task killed", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "nc -lvnp 4444", cwd: os.tmpdir(), workdir: os.tmpdir() });
    const pty = spawned[0];

    const res = await killShellTool.execute({ taskId }, { cwd: os.tmpdir() });
    expect(pty.killed).toBe(true);
    expect(res).toContain('"status": "killed"');
  });

  it("captures the exit code when the PTY exits on its own", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "true", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    pty.emitData("done\n");
    pty.fireExit(0);
    const out = await taskOutputTool.execute({ taskId, block: true, timeoutMs: 2000 }, { cwd: os.tmpdir() });
    expect(out).toContain("done");
  });

  it("write_stdin({closeStdin:true}) writes the payload then an EOF (^D) to the PTY", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "cat", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    await writeStdinTool.execute({ taskId, data: "line one", closeStdin: true }, { cwd: os.tmpdir() });
    // payload (newline-appended, CR on Windows) first, then the ^D EOF from stdin.end()
    expect(pty.writes).toEqual([`line one${ENTER}`, "\x04"]);
  });

  it("write_stdin({appendNewline:false}) forwards the payload verbatim (no newline)", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "ssh user@host", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    await writeStdinTool.execute({ taskId, data: "raw", appendNewline: false }, { cwd: os.tmpdir() });
    expect(pty.writes).toEqual(["raw"]);
  });

  it("surfaces a non-zero PTY exit code as a failed task", async () => {
    const spawned = installFakeSpawner();
    const taskId = await startBackgroundPtyShell({ command: "false", cwd: os.tmpdir(), workdir: os.tmpdir() });
    started.push(taskId);
    const pty = spawned[0];

    pty.fireExit(2);
    const out = await taskOutputTool.execute({ taskId, block: true, timeoutMs: 2000 }, { cwd: os.tmpdir() });
    expect(out).toContain("<status>failed</status>");
    expect(out).toContain("<exit_code>2</exit_code>");
  });

  it("kills the PTY when the turn's abort signal fires (user Stop)", async () => {
    const spawned = installFakeSpawner();
    const ac = new AbortController();
    const taskId = await startBackgroundPtyShell({ command: "ssh user@host", cwd: os.tmpdir(), workdir: os.tmpdir(), signal: ac.signal });
    started.push(taskId);
    const pty = spawned[0];
    expect(pty.killed).toBe(false);

    ac.abort();
    expect(pty.killed).toBe(true);
    expect(pty.killSignal).toBe("SIGTERM");
  });

  it("kills immediately when the signal is already aborted before spawn", async () => {
    const spawned = installFakeSpawner();
    const ac = new AbortController();
    ac.abort();
    const taskId = await startBackgroundPtyShell({ command: "ssh user@host", cwd: os.tmpdir(), workdir: os.tmpdir(), signal: ac.signal });
    started.push(taskId);
    expect(spawned[0].killed).toBe(true);
  });

  it("wraps a spawn failure with the interpreter and cwd for context", async () => {
    __setPtySpawnerForTest(() => {
      throw new Error("File not found: bash");
    });
    await expect(
      startBackgroundPtyShell({ command: "ssh user@host", cwd: os.tmpdir(), workdir: os.tmpdir() }),
    ).rejects.toThrow(/failed to start PTY.*File not found: bash/);
  });
});

// Real native node-pty smoke test — proves the actual addon path works on this
// host. Skipped automatically when node-pty can't be loaded (e.g. an Electron
// ABI build under a plain-node test runner) so the suite stays green everywhere.
describe("real node-pty smoke", () => {
  it("spawns a real PTY and captures program output", async () => {
    let loadable = false;
    try {
      await import("node-pty");
      loadable = true;
    } catch {
      loadable = false;
    }
    if (!loadable) {
      console.warn("[pty-process.test] node-pty not loadable in this runtime — skipping real smoke test");
      return;
    }
    __setPtySpawnerForTest(null);
    const dir = os.tmpdir();
    const taskId = await startBackgroundPtyShell({
      command: 'node -e "process.stdout.write(\'PTY_SMOKE_OK\')"',
      cwd: dir,
      workdir: dir,
      timeoutMs: 15000,
    });
    try {
      const out = await taskOutputTool.execute({ taskId, block: true, timeoutMs: 12000 }, { cwd: dir });
      expect(out).toContain("PTY_SMOKE_OK");
    } finally {
      await killShellTool.execute({ taskId }, { cwd: dir }).catch(() => undefined);
    }
  });
});
