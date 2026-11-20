import { PassThrough } from "node:stream";
import type { ResultPromise } from "execa";
import { errorMessage } from "@reina/protocol";

/**
 * PTY (pseudo-terminal) backing for `run_shell` interactive sessions.
 *
 * Reina is a security-research tool as much as a coding agent. The default shell
 * path runs commands under a plain pipe (execa) — correct for build/test/grep
 * and easy to parse. But offensive work needs a REAL terminal: `ssh`/`sudo`/`su`
 * read passwords straight from /dev/tty (a pipe can't answer them), and
 * `msfconsole`, interactive `mysql`, reverse-shell upgrades, and ncurses TUIs
 * need raw mode / a TTY to function at all. A PTY also makes line-buffered tools
 * stream output live instead of block-buffering until exit.
 *
 * This module spawns a command under node-pty and adapts the resulting `IPty`
 * to the SUBSET of execa's `ResultPromise` interface that the background-shell
 * registry and its tools (`task_output`, `monitor`, `write_stdin`, `kill_shell`)
 * touch — so the entire downstream pipeline is reused unchanged:
 *   - `.stdout`   → a PassThrough fed from `pty.onData` (PTY merges stdout+stderr)
 *   - `.stderr`   → undefined (everything arrives on the merged `.stdout`)
 *   - `.stdin`    → a thin writable shim over `pty.write` (write_stdin)
 *   - `.pid`      → `pty.pid`
 *   - `.kill()`   → `pty.kill()`
 *   - `.unref()`  → no-op (node-pty has no event-loop ref to drop)
 *   - thenable    → resolves `{ exitCode }` when `pty.onExit` fires
 */

/** The slice of node-pty's `IPty` this adapter relies on. */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
  resize?(columns: number, rows: number): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  name: string;
}

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

// Test seam: inject a fake spawner so adapter wiring can be exercised without
// loading the native node-pty addon (whose ABI is tied to the host runtime).
let injectedSpawner: PtySpawner | null = null;

/** Override the PTY spawner (tests only). Pass `null` to restore the real one. */
export function __setPtySpawnerForTest(spawner: PtySpawner | null): void {
  injectedSpawner = spawner;
}

/**
 * Resolve a PTY spawner. node-pty is a native module loaded lazily so (a) the
 * common pipe path never pays for it and (b) a missing / ABI-mismatched build
 * surfaces as an actionable tool error instead of crashing the agent-host at
 * import time. node-pty is marked external in the agent-host bundle so this
 * resolves against the installed module at runtime.
 */
export async function resolvePtySpawner(): Promise<PtySpawner> {
  if (injectedSpawner) return injectedSpawner;
  try {
    type PtyModule = { spawn: (file: string, args: string[], options: PtySpawnOptions) => PtyLike };
    const mod = (await import("node-pty")) as unknown as PtyModule & { default?: PtyModule };
    // node-pty is CJS; under ESM dynamic-import interop `spawn` may live on the
    // namespace directly or on `.default` (module.exports). Accept either.
    const spawn = typeof mod.spawn === "function" ? mod.spawn : mod.default?.spawn;
    if (typeof spawn !== "function") throw new Error("node-pty loaded but exposes no spawn() function");
    return (file, args, options) => spawn(file, args, options);
  } catch (error) {
    throw new Error(
      `PTY mode (pty:true) requires the native node-pty module, which failed to load: ${errorMessage(error)}. ` +
        `Rebuild it for this runtime (npm --workspace=@reina/desktop run rebuild-native) or drop pty:true to use the plain pipe shell.`,
    );
  }
}

/** Minimal stdin shim matching what `write_stdin` reads off `task.process.stdin`. */
interface PtyStdin {
  writableEnded: boolean;
  destroyed: boolean;
  write(payload: string | Buffer, callback?: (error?: Error | null) => void): boolean;
  end(): void;
}

/**
 * Wrap a spawned `PtyLike` as an execa-`ResultPromise`-shaped object. The
 * returned value IS a Promise that resolves to `{ exitCode }` on exit, with the
 * stream/stdin/pid/kill/unref properties attached — exactly what
 * `registerBackgroundShellProcess` and the task tools consume.
 */
export function adaptPtyProcess(pty: PtyLike, options: { timeoutMs?: number }): ResultPromise {
  const stdout = new PassThrough();
  let exited = false;
  let stdinEnded = false;

  let resolveExit!: (result: { exitCode: number }) => void;
  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  const clearTimeoutTimer = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
  };
  // A PTY session has no execa-style timeout. Honor an EXPLICIT timeoutMs only
  // (the caller's run_shell default is intentionally not applied to PTY in
  // shell.ts, so interactive ssh/mysql sessions aren't reaped at 2 minutes).
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        // already gone
      }
    }, options.timeoutMs);
  }

  pty.onData((data) => {
    // Drop stragglers that arrive after onExit ended the stream: node-pty's
    // data/exit ordering isn't guaranteed on every platform (Windows ConPTY in
    // particular), and a write() after end() emits ERR_STREAM_WRITE_AFTER_END —
    // which, with no 'error' listener on this PassThrough, would crash the host.
    if (!exited) stdout.write(data);
  });
  pty.onExit(({ exitCode }) => {
    if (exited) return;
    exited = true;
    clearTimeoutTimer();
    stdout.end(); // emits "end" so the registry's decoder flush runs
    resolveExit({ exitCode: exitCode ?? 0 });
  });

  const stdin: PtyStdin = {
    get writableEnded() {
      return stdinEnded || exited;
    },
    get destroyed() {
      return exited;
    },
    write(payload, callback) {
      try {
        const text = typeof payload === "string" ? payload : payload.toString("utf8");
        // ConPTY submits a line on CR (Enter), not LF, so a write_stdin("…\n")
        // would echo but never submit — leaving ssh/sudo/mysql password prompts
        // hanging. Translate \n → \r on Windows so the standard "append newline =
        // submit" semantics work; Unix ptys take LF as-is.
        pty.write(globalThis.process.platform === "win32" ? text.replace(/\r?\n/g, "\r") : text);
        callback?.(null);
      } catch (error) {
        callback?.(error as Error);
      }
      return true;
    },
    end() {
      stdinEnded = true;
      try {
        // A PTY has no master-fd close to signal EOF; in canonical mode the
        // kernel turns the VEOF control char (^D / 0x04, at line start) into a
        // zero-length read — i.e. EOF — for the foreground program. Writing an
        // empty string would be a no-op, so send the actual ^D byte.
        pty.write("");
      } catch {
        // session already gone
      }
    },
  };

  // NOTE: this object is a thenable (resolves `{ exitCode }`). The registry uses
  // it synchronously (`.stdout`, `.kill`, etc.) and only `.then`s it to observe
  // exit. It must NEVER be `return`ed from an `async` function / `await`ed as a
  // value — JS recursively unwraps a returned thenable, which would block on the
  // process exiting AND discard the attached properties. Compose it via the
  // (non-thenable) spawner from `resolvePtySpawner` instead.
  const adapter = exitPromise as unknown as ResultPromise;
  Object.assign(adapter, {
    stdout,
    stderr: undefined,
    stdin,
    pid: pty.pid,
    kill: (signal?: NodeJS.Signals): boolean => {
      try {
        pty.kill(signal);
      } catch {
        // already gone
      }
      return true;
    },
    unref: (): void => {
      // node-pty holds no Node event-loop ref to release.
    },
  });
  return adapter;
}

/** A generous default terminal size so wrapping-sensitive tools don't fold
 * output at 80 columns. */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 40;
