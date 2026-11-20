import { execa, type ResultPromise } from "execa";
import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorMessage, createId } from "@reina/protocol";
import type { ToolImplementation, ToolRuntimeOptions } from "../../types.js";
import { sanitizeShellOutput, truncateTextTail } from "../../utils.js";
import { killProcessTree, nonInteractiveShellEnv, ptyCommandSpec, shellCommandSpec, type ShellChoice } from "./shell-resolve.js";
import { adaptPtyProcess, resolvePtySpawner, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, type PtyLike } from "./pty-process.js";
import { createStreamDecoder, type StreamDecoder } from "./stream-decode.js";
import { semanticBoolean, semanticTimeoutMs } from "./coerce.js";
import { description as taskOutputDescription } from "../../prompts/task-output.js";
import { description as killShellDescription } from "../../prompts/kill-shell.js";
import { description as monitorDescription } from "../../prompts/monitor.js";
import { description as writeStdinDescription } from "../../prompts/write-stdin.js";

type MonitorWaiter = {
  pattern?: RegExp;
  resolve(result: MonitorMatch | null): void;
  startedAt: number;
  streams: { stdout: boolean; stderr: boolean };
};

export type MonitorMatch = {
  stream: "stdout" | "stderr";
  line: string;
  match: string;
  capturedGroups: string[];
};

type BackgroundTask = {
  id: string;
  command: string;
  workdir: string;
  workspaceRoot: string;
  sessionId?: string;
  toolCallId?: string;
  injectedAt?: string;
  startedAt: string;
  endedAt?: string;
  background: "requested" | "auto" | "timed";
  status: "running" | "completed" | "failed" | "killed";
  pty: boolean;
  stdout: string[];
  stderr: string[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutResidual: string;
  stderrResidual: string;
  exitCode?: number;
  error?: string;
  process: ResultPromise;
  waiters: MonitorWaiter[];
  persistQueue: Promise<void>;
  persistedOutputBytes: number;
  outputTruncated: boolean;
};

const tasks = new Map<string, BackgroundTask>();
const completionListeners = new Set<(task: BackgroundShellTaskRecord) => void>();
const maxBufferedBytes = 256 * 1024;
const maxPersistedOutputBytes = 16 * 1024 * 1024;
const maxSnapshotOutputBytes = 512 * 1024;
const taskHistoryDirname = "background-shells";
const taskMetadataSuffix = ".json";
const taskOutputSuffix = ".log";
const validTaskId = /^shell_[a-z0-9_-]+$/i;

export type BackgroundShellTaskStatus = BackgroundTask["status"] | "lost";

export type BackgroundShellTaskRecord = {
  id: string;
  command: string;
  workdir: string;
  workspaceRoot: string;
  sessionId?: string;
  toolCallId?: string;
  injectedAt?: string;
  startedAt: string;
  endedAt?: string;
  background: BackgroundTask["background"];
  status: BackgroundShellTaskStatus;
  pty: boolean;
  exitCode?: number;
  error?: string;
  outputBytes: number;
  outputTruncated: boolean;
};

export type BackgroundShellTaskSnapshot = {
  task: BackgroundShellTaskRecord;
  output: string;
  truncated: boolean;
};

export type BackgroundShellTaskSummary = {
  id: string;
  command: string;
  status: BackgroundTask["status"];
  background: BackgroundTask["background"];
  startedAt: string;
};

const outputSchema = z.object({
  taskId: z.string().optional(),
  task_id: z.string().optional(),
  block: semanticBoolean.optional(),
  timeoutMs: semanticTimeoutMs.optional(),
});

const killSchema = z.object({
  taskId: z.string().optional(),
  task_id: z.string().optional(),
});

const outputPublicSchema = z.object({
  taskId: z
    .string()
    .describe("Background shell id returned by run_shell({runInBackground:true}) or by an auto-backgrounded long command. Format: shell_<short>."),
  block: z
    .boolean()
    .optional()
    .describe("When true, wait until the task exits, a related task event arrives, or timeoutMs elapses. Defaults to false — returns whatever output exists right now. Check wake_reason and status after a blocking wait."),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .describe("How long to block when `block: true` (0-600000 ms). Defaults to 30000. Ignored when `block` is false."),
});

const killPublicSchema = z.object({
  taskId: z
    .string()
    .describe("Background shell id (shell_<short>) returned by run_shell({runInBackground:true}). Sends SIGTERM; only running tasks can be killed."),
});

export function startBackgroundShell(args: { command: string; cwd: string; workdir: string; workspaceRoot?: string; sessionId?: string; toolCallId?: string; background?: "requested" | "auto"; timeoutMs?: number; signal?: AbortSignal; shell?: ShellChoice }): string {
  const id = createId("shell");
  const commandSpec = shellCommandSpec(args.command, args.shell);
  const task = registerBackgroundShellProcess({
    id,
    command: args.command,
    workdir: args.workdir,
    workspaceRoot: args.workspaceRoot ?? args.cwd,
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    background: args.background ?? "requested",
    pty: false,
    process: execa(commandSpec.file, commandSpec.args, {
      cwd: args.cwd,
      shell: commandSpec.shell,
      reject: false,
      timeout: args.timeoutMs,
      cancelSignal: args.signal,
      // Keep stdin a writable pipe so `write_stdin` can feed interactive
      // prompts / REPLs on this backgrounded task.
      stdin: "pipe",
      env: nonInteractiveShellEnv(),
      extendEnv: false,
    }),
  });
  tasks.set(id, task);
  return id;
}

/**
 * Start a backgrounded command under a PTY (interactive session). Unlike
 * {@link startBackgroundShell} this is async — node-pty loads lazily. The
 * spawned PTY is wrapped as an execa-`ResultPromise`-shaped adapter so the rest
 * of the task machinery (task_output / monitor / write_stdin / kill_shell) is
 * reused unchanged. PTY merges stdout+stderr, so all output arrives on stdout.
 */
export async function startBackgroundPtyShell(args: {
  command: string;
  cwd: string;
  workdir: string;
  workspaceRoot?: string;
  sessionId?: string;
  toolCallId?: string;
  background?: "requested" | "auto";
  timeoutMs?: number;
  shell?: ShellChoice;
  signal?: AbortSignal;
}): Promise<string> {
  const id = createId("shell");
  const spec = ptyCommandSpec(args.command, args.shell);
  // Only the spawner (a plain function) is awaited — never the adapter, which is
  // a thenable that `await` would recursively unwrap (see pty-process.ts).
  const spawn = await resolvePtySpawner();
  // node-pty throws synchronously on spawn failure (bad cwd, missing
  // interpreter) — unlike execa, which defers it to the result. Wrap it so the
  // tool surfaces which interpreter/cwd failed instead of a bare addon error.
  let pty: PtyLike;
  try {
    pty = spawn(spec.file, spec.args, {
      cwd: args.cwd,
      env: globalThis.process.env,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      name: "xterm-256color",
    });
  } catch (error) {
    throw new Error(`failed to start PTY for \`${spec.file}\` in ${args.cwd}: ${errorMessage(error)}`);
  }
  const child = adaptPtyProcess(pty, { timeoutMs: args.timeoutMs });
  const task = registerBackgroundShellProcess({
    id,
    command: args.command,
    workdir: args.workdir,
    workspaceRoot: args.workspaceRoot ?? args.cwd,
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    background: args.background ?? "requested",
    pty: true,
    process: child,
  });
  // Honor the turn's abort signal (a user Stop) the way the pipe path does via
  // execa's cancelSignal: node-pty has no built-in cancellation, so kill the
  // session on abort. The signal only fires on an explicit interrupt — never at
  // normal turn end — so this does NOT shorten cross-turn interactive sessions.
  if (args.signal) {
    if (args.signal.aborted) child.kill("SIGTERM");
    else {
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      args.signal.addEventListener("abort", onAbort, { once: true });
      // Drop the listener once the session ends on its own, so a long-lived
      // signal doesn't accumulate dead listeners across many PTY sessions.
      void Promise.resolve(child).then(
        () => args.signal?.removeEventListener("abort", onAbort),
        () => args.signal?.removeEventListener("abort", onAbort),
      );
    }
  }
  tasks.set(id, task);
  return id;
}

export function adoptBackgroundShell(args: {
  command: string;
  workdir: string;
  workspaceRoot?: string;
  sessionId?: string;
  toolCallId?: string;
  background: "timed";
  process: ResultPromise;
  initialOutput?: string;
  startedAt?: string;
  // Decoders carried over from the foreground run so a multibyte char split
  // across the fg→bg handoff boundary completes rather than re-decoding to
  // U+FFFD on a fresh decoder.
  stdoutDecoder?: StreamDecoder;
  stderrDecoder?: StreamDecoder;
}): string {
  const id = createId("shell");
  const task = registerBackgroundShellProcess({
    id,
    command: args.command,
    workdir: args.workdir,
    workspaceRoot: args.workspaceRoot ?? args.workdir,
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    background: args.background,
    pty: false,
    process: args.process,
    initialOutput: args.initialOutput,
    startedAt: args.startedAt,
    stdoutDecoder: args.stdoutDecoder,
    stderrDecoder: args.stderrDecoder,
  });
  tasks.set(id, task);
  return id;
}

function registerBackgroundShellProcess(args: {
  id: string;
  command: string;
  workdir: string;
  workspaceRoot: string;
  sessionId?: string;
  toolCallId?: string;
  background: BackgroundTask["background"];
  pty: boolean;
  process: ResultPromise;
  initialOutput?: string;
  startedAt?: string;
  stdoutDecoder?: StreamDecoder;
  stderrDecoder?: StreamDecoder;
}): BackgroundTask {
  const task: BackgroundTask = {
    id: args.id,
    command: args.command,
    workdir: args.workdir,
    workspaceRoot: path.resolve(args.workspaceRoot),
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    startedAt: args.startedAt ?? new Date().toISOString(),
    background: args.background,
    status: "running",
    pty: args.pty,
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutResidual: "",
    stderrResidual: "",
    process: args.process,
    waiters: [],
    persistQueue: Promise.resolve(),
    persistedOutputBytes: 0,
    outputTruncated: false,
  };
  persistTaskMetadata(task);
  if (args.initialOutput) {
    task.stdoutBytes = append(task.stdout, args.initialOutput, task.stdoutBytes);
    persistTaskOutput(task, args.initialOutput);
    feedMonitor(task, "stdout", args.initialOutput);
  }
  task.process.unref();
  // Per-stream streaming UTF-8 decoders (no torn multibyte chars across chunks).
  // The streamed chunks are the SOLE source of task output — we deliberately do
  // NOT also append execa's `result.stdout`/`result.stderr` on completion: when
  // a "data" listener is attached, execa STILL buffers the same bytes into the
  // result, so appending both doubled every byte of output (verified). Stream +
  // end-flush captures everything exactly once.
  const stdoutDecoder = args.stdoutDecoder ?? createStreamDecoder();
  const stderrDecoder = args.stderrDecoder ?? createStreamDecoder();
  task.process.stdout?.on("data", (chunk) => {
    const text = stdoutDecoder.push(chunk);
    if (!text) return;
    task.stdoutBytes = append(task.stdout, text, task.stdoutBytes);
    persistTaskOutput(task, text);
    feedMonitor(task, "stdout", text);
  });
  task.process.stderr?.on("data", (chunk) => {
    const text = stderrDecoder.push(chunk);
    if (!text) return;
    task.stderrBytes = append(task.stderr, text, task.stderrBytes);
    persistTaskOutput(task, text);
    feedMonitor(task, "stderr", text);
  });
  task.process.stdout?.on("end", () => {
    const text = stdoutDecoder.flush();
    if (!text) return;
    task.stdoutBytes = append(task.stdout, text, task.stdoutBytes);
    persistTaskOutput(task, text);
    feedMonitor(task, "stdout", text);
  });
  task.process.stderr?.on("end", () => {
    const text = stderrDecoder.flush();
    if (!text) return;
    task.stderrBytes = append(task.stderr, text, task.stderrBytes);
    persistTaskOutput(task, text);
    feedMonitor(task, "stderr", text);
  });
  task.process
    .then((result) => {
      if (task.status === "killed") return;
      task.exitCode = result.exitCode;
      task.status = result.exitCode === 0 ? "completed" : "failed";
      task.endedAt = new Date().toISOString();
      persistTaskMetadata(task);
      flushMonitorOnExit(task);
      publishCompletion(task);
    })
    .catch((error) => {
      if (task.status === "killed") return;
      task.status = "failed";
      task.error = errorMessage(error);
      task.endedAt = new Date().toISOString();
      persistTaskMetadata(task);
      flushMonitorOnExit(task);
      publishCompletion(task);
    });
  return task;
}

function feedMonitor(task: BackgroundTask, stream: "stdout" | "stderr", text: string): void {
  if (!task.waiters.some((waiter) => waiter.pattern && waiter.streams[stream])) return;
  const buffer = (stream === "stdout" ? task.stdoutResidual : task.stderrResidual) + text;
  const lines = buffer.split(/\r?\n/);
  const residual = lines.pop() ?? "";
  if (stream === "stdout") task.stdoutResidual = residual;
  else task.stderrResidual = residual;
  for (const line of lines) {
    if (task.waiters.length === 0) return;
    matchAgainstWaiters(task, stream, line);
  }
}

function matchAgainstWaiters(task: BackgroundTask, stream: "stdout" | "stderr", line: string): void {
  const remaining: MonitorWaiter[] = [];
  // Iterate a snapshot, not the live array: a matched waiter.resolve() is now
  // settle(), which splices the waiter out of task.waiters. Mutating the array
  // we are iterating with for...of would make the iterator skip the element that
  // shifts into the freed slot — that waiter is then neither resolved nor pushed
  // to `remaining`, so its monitor() Promise hangs until its own timeout. The
  // trailing `task.waiters = remaining` remains the authoritative final state.
  for (const waiter of [...task.waiters]) {
    if (!waiter.streams[stream]) {
      remaining.push(waiter);
      continue;
    }
    const m = waiter.pattern?.exec(line);
    if (!m) {
      remaining.push(waiter);
      continue;
    }
    waiter.resolve({
      stream,
      line,
      match: m[0],
      capturedGroups: m.slice(1).map((value) => value ?? ""),
    });
  }
  task.waiters = remaining;
}

function flushMonitorOnExit(task: BackgroundTask): void {
  if (task.stdoutResidual) {
    const line = task.stdoutResidual;
    task.stdoutResidual = "";
    matchAgainstWaiters(task, "stdout", line);
  }
  if (task.stderrResidual) {
    const line = task.stderrResidual;
    task.stderrResidual = "";
    matchAgainstWaiters(task, "stderr", line);
  }
  const pending = task.waiters;
  task.waiters = [];
  for (const waiter of pending) waiter.resolve(null);
}

export function listBackgroundShellTasks(sessionId?: string): BackgroundShellTaskSummary[] {
  return [...tasks.values()].filter((task) => sessionId === undefined || task.sessionId === sessionId).map((task) => ({
    id: task.id,
    command: task.command,
    status: task.status,
    background: task.background,
    startedAt: task.startedAt,
  }));
}

export function subscribeBackgroundShellCompletions(
  listener: (task: BackgroundShellTaskRecord) => void,
): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}

function publishCompletion(task: BackgroundTask): void {
  const record = toTaskRecord(task);
  for (const listener of completionListeners) {
    try {
      listener(record);
    } catch {
      // A failed notification consumer must not change the command's outcome.
    }
  }
}

export async function listBackgroundShellTaskRecords(
  workspaceRoot: string,
): Promise<BackgroundShellTaskRecord[]> {
  const root = path.resolve(workspaceRoot);
  const live = [...tasks.values()].filter((task) => pathsEqual(task.workspaceRoot, root));
  await Promise.all(live.map((task) => task.persistQueue));

  const persisted = await readPersistedTaskRecords(root);
  const records = new Map<string, BackgroundShellTaskRecord>();
  for (const record of persisted) {
    const liveTask = tasks.get(record.id);
    if (record.status === "running" && (!liveTask || !pathsEqual(liveTask.workspaceRoot, root))) {
      const lost: BackgroundShellTaskRecord = {
        ...record,
        status: "lost",
        endedAt: record.endedAt ?? new Date().toISOString(),
        error: record.error ?? "Agent host restarted before the task completed.",
      };
      records.set(lost.id, lost);
      await writeTaskRecord(root, lost);
      continue;
    }
    records.set(record.id, record);
  }
  for (const task of live) records.set(task.id, toTaskRecord(task));
  return [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listPendingBackgroundShellCompletions(
  workspaceRoot: string,
  sessionId: string,
): Promise<BackgroundShellTaskRecord[]> {
  const records = await listBackgroundShellTaskRecords(workspaceRoot);
  return records.filter((task) => task.sessionId === sessionId && !task.injectedAt && task.status !== "running");
}

export async function acknowledgeBackgroundShellCompletion(
  workspaceRoot: string,
  taskId: string,
  injectedAt: string,
): Promise<void> {
  assertTaskId(taskId);
  const root = path.resolve(workspaceRoot);
  const task = tasks.get(taskId);
  if (task && pathsEqual(task.workspaceRoot, root)) {
    if (task.status === "running") throw new Error(`background task is still running: ${taskId}`);
    const record = { ...toTaskRecord(task), injectedAt: task.injectedAt ?? injectedAt };
    const persisted = task.persistQueue.then(() => writeTaskRecord(root, record));
    // Keep acknowledgement ordered after output/terminal metadata, while
    // exposing a failed write to the caller so it can retry delivery safely.
    task.persistQueue = persisted.catch(() => undefined);
    await persisted;
    task.injectedAt = record.injectedAt;
    return;
  }
  const records = await listBackgroundShellTaskRecords(root);
  const record = records.find((candidate) => candidate.id === taskId);
  if (!record) throw new Error(`background task not found: ${taskId}`);
  await writeTaskRecord(root, { ...record, injectedAt: record.injectedAt ?? injectedAt });
}

export async function getBackgroundShellTaskSnapshot(
  workspaceRoot: string,
  taskId: string,
): Promise<BackgroundShellTaskSnapshot> {
  assertTaskId(taskId);
  const root = path.resolve(workspaceRoot);
  const live = tasks.get(taskId);
  if (live && pathsEqual(live.workspaceRoot, root)) await live.persistQueue;

  const records = await listBackgroundShellTaskRecords(root);
  const record = records.find((candidate) => candidate.id === taskId);
  if (!record) throw new Error(`background task not found: ${taskId}`);

  let stored: Buffer | undefined;
  let storedBytes = 0;
  let tailTruncated = false;
  try {
    const tail = await readTaskOutputTail(root, taskId);
    stored = tail.output;
    storedBytes = tail.totalBytes;
    tailTruncated = tail.truncated;
  } catch {
    stored = undefined;
  }
  if (!stored && live && pathsEqual(live.workspaceRoot, root)) {
    stored = Buffer.from([live.stdout.join(""), live.stderr.join("")].filter(Boolean).join("\n"), "utf8");
    storedBytes = live.persistedOutputBytes;
  }
  const output = stored ?? Buffer.alloc(0);
  return {
    task: { ...record, outputBytes: Math.max(record.outputBytes, storedBytes) },
    output: sanitizeShellOutput(output.toString("utf8")),
    truncated: record.outputTruncated || tailTruncated,
  };
}

export async function stopBackgroundShellTask(
  workspaceRoot: string,
  taskId: string,
): Promise<BackgroundShellTaskRecord> {
  assertTaskId(taskId);
  const root = path.resolve(workspaceRoot);
  const task = tasks.get(taskId);
  if (!task || !pathsEqual(task.workspaceRoot, root)) throw new Error(`background task not found: ${taskId}`);
  await terminateBackgroundShellTask(task);
  return toTaskRecord(task);
}

export const taskOutputTool: ToolImplementation = {
  descriptor: {
    name: "task_output",
    description: taskOutputDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Read stdout/stderr from a background shell task (shell_<uuid>).",
    inputSchema: outputPublicSchema,
    examples: [
      {
        description: "Quick snapshot of current output (don't block)",
        input: { taskId: "shell_a3f9" },
      },
      {
        description: "Block until the task exits, up to 60s",
        input: { taskId: "shell_a3f9", block: true, timeoutMs: 60000 },
      },
    ],
  },
  async execute(input, options) {
    const parsed = outputSchema.parse(input ?? {});
    options.signal?.throwIfAborted();
    const id = parsed.taskId ?? parsed.task_id;
    if (!id) throw new Error("task_output requires taskId");
    const task = tasks.get(id);
    if (!task) {
      const snapshot = await getBackgroundShellTaskSnapshot(options.cwd, id);
      return formatTask({ ...snapshot.task, stdout: [snapshot.output], stderr: [] }, parsed.block ? "exited" : undefined);
    }
    const wake = parsed.block === true
      ? await waitForTask(task, parsed.timeoutMs ?? 30000, options)
      : undefined;
    return formatTask(task, wake?.reason);
  },
};

export const killShellTool: ToolImplementation = {
  descriptor: {
    name: "kill_shell",
    description: killShellDescription,
    permission: "execute",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Terminate a background shell task (SIGTERM).",
    inputSchema: killPublicSchema,
    examples: [
      {
        description: "Stop a still-running background shell",
        input: { taskId: "shell_a3f9" },
      },
    ],
  },
  async execute(input) {
    const parsed = killSchema.parse(input ?? {});
    const id = parsed.taskId ?? parsed.task_id;
    if (!id) throw new Error("kill_shell requires taskId");
    const task = tasks.get(id);
    if (!task) throw new Error(`background task not found: ${id}`);
    if (task.status !== "running") throw new Error(`background task is not running: ${id} (${task.status})`);
    await terminateBackgroundShellTask(task);
    return JSON.stringify({ taskId: id, status: task.status, command: task.command }, null, 2);
  },
};

const writeStdinSchema = z.object({
  taskId: z.string().optional(),
  task_id: z.string().optional(),
  data: z.string().optional(),
  appendNewline: semanticBoolean.optional(),
  append_newline: semanticBoolean.optional(),
  closeStdin: semanticBoolean.optional(),
  close_stdin: semanticBoolean.optional(),
});

const writeStdinPublicSchema = z.object({
  taskId: z
    .string()
    .describe("Background shell id (shell_<short>) returned by run_shell({runInBackground:true}). The task must still be running and its stdin must not have been closed."),
  data: z.string().describe("Text to write to the task's stdin."),
  appendNewline: z.boolean().optional().describe("Append a trailing newline (default true). Most interactive prompts need it to submit."),
  closeStdin: z.boolean().optional().describe("Close stdin (send EOF) after writing. Use for processes that read until end-of-input."),
});

export const writeStdinTool: ToolImplementation = {
  descriptor: {
    name: "write_stdin",
    description: writeStdinDescription,
    permission: "execute",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Write to a background shell task's stdin (answer prompts / feed interactive input).",
    inputSchema: writeStdinPublicSchema,
    examples: [
      {
        description: "Answer a yes/no prompt",
        input: { taskId: "shell_a3f9", data: "y" },
      },
      {
        description: "Feed a multi-line config and close stdin so the process can finish",
        input: { taskId: "shell_a3f9", data: "[server]\nport=4000\n", closeStdin: true },
      },
    ],
  },
  async execute(input) {
    const parsed = writeStdinSchema.parse(input ?? {});
    const id = parsed.taskId ?? parsed.task_id;
    if (!id) throw new Error("write_stdin requires taskId");
    const task = tasks.get(id);
    if (!task) throw new Error(`background task not found: ${id}`);
    if (task.status !== "running") throw new Error(`background task is not running: ${id} (${task.status})`);
    const stdin = task.process.stdin;
    if (!stdin || stdin.writableEnded || stdin.destroyed) {
      throw new Error(`background task stdin is not writable: ${id} (already closed)`);
    }
    const appendNewline = parsed.appendNewline ?? parsed.append_newline ?? true;
    const closeStdin = parsed.closeStdin ?? parsed.close_stdin ?? false;
    const data = parsed.data ?? "";
    const payload = appendNewline && !data.endsWith("\n") ? `${data}\n` : data;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => (error ? reject(error) : resolve()));
    });
    if (closeStdin) stdin.end();
    return JSON.stringify(
      {
        taskId: id,
        status: task.status,
        bytesWritten: Buffer.byteLength(payload, "utf8"),
        stdinClosed: closeStdin,
        next: "Use task_output to read what the process emitted after this input, or monitor to wait for a specific line.",
      },
      null,
      2,
    );
  },
};

const monitorSchema = z.object({
  taskId: z.string().optional(),
  task_id: z.string().optional(),
  pattern: z.string().optional(),
  timeoutMs: semanticTimeoutMs.optional(),
  streams: z.array(z.enum(["stdout", "stderr"])).optional(),
  caseSensitive: semanticBoolean.optional(),
});

const monitorPublicSchema = z.object({
  taskId: z
    .string()
    .describe("Background shell id (shell_<short>) returned by run_shell({runInBackground:true}). The watcher streams lines as they arrive, so it can react to output the task produces AFTER this call."),
  pattern: z.string().describe("ECMAScript regex applied per line. Returns when one line matches, the task exits, a related task event arrives, or the timeout elapses."),
  timeoutMs: z.number().int().min(0).max(600000).optional().describe("Max ms to wait. Defaults to 60000."),
  streams: z.array(z.enum(["stdout", "stderr"])).optional().describe("Which streams to watch. Defaults to both."),
  caseSensitive: z.boolean().optional().describe("Defaults to false (case-insensitive)."),
});

export const monitorTool: ToolImplementation = {
  descriptor: {
    name: "monitor",
    description: monitorDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Block until a regex matches a background shell task's output (push-based wait).",
    inputSchema: monitorPublicSchema,
    examples: [
      {
        description: "Wait for dev server's `ready` line, give it 30s",
        input: {
          taskId: "shell_a3f9",
          pattern: "Local:.*localhost",
          timeoutMs: 30000,
        },
      },
      {
        description: "Wait for a build to either succeed or fail (watching stderr too)",
        input: {
          taskId: "shell_b271",
          pattern: "Build (succeeded|failed)",
          streams: ["stdout", "stderr"],
          caseSensitive: true,
        },
      },
    ],
  },
  async execute(input, options) {
    const parsed = monitorSchema.parse(input ?? {});
    options.signal?.throwIfAborted();
    const id = parsed.taskId ?? parsed.task_id;
    if (!id) throw new Error("monitor requires taskId");
    if (!parsed.pattern) throw new Error("monitor requires pattern (a regex string)");
    const task = tasks.get(id);
    if (!task) throw new Error(`background task not found: ${id}`);
    const timeoutMs = parsed.timeoutMs ?? 60000;
    const streams = parsed.streams && parsed.streams.length > 0 ? parsed.streams : ["stdout", "stderr"];
    const flags = parsed.caseSensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = new RegExp(parsed.pattern, flags);
    } catch (error) {
      throw new Error(`monitor: invalid regex: ${errorMessage(error)}`);
    }

    // Try a synchronous scan of buffered output first. If the pattern is
    // already present in lines we've already received, return immediately
    // without subscribing — this is what makes monitor cheap to call after
    // task_output has already shown the relevant output.
    const synchronous = scanBufferedForPattern(task, regex, streams as Array<"stdout" | "stderr">);
    if (synchronous) return formatMonitorResult(task, synchronous, "matched");

    // If the task is already done, report exit immediately.
    if (task.status !== "running") return formatMonitorResult(task, null, "exited");

    const result = await waitForTask(task, timeoutMs, options, {
      pattern: regex,
      streams: { stdout: streams.includes("stdout"), stderr: streams.includes("stderr") },
    });
    return formatMonitorResult(task, result.match, result.reason);
  },
};

function scanBufferedForPattern(
  task: BackgroundTask,
  pattern: RegExp,
  streams: Array<"stdout" | "stderr">,
): MonitorMatch | null {
  for (const stream of streams) {
    const text = (stream === "stdout" ? task.stdout : task.stderr).join("");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = pattern.exec(line);
      if (!m) continue;
      return { stream, line, match: m[0], capturedGroups: m.slice(1).map((v) => v ?? "") };
    }
  }
  return null;
}

function formatMonitorResult(
  task: BackgroundTask,
  match: MonitorMatch | null,
  reason: TaskWakeReason,
): string {
  const lines: Array<string | undefined> = [
    `<task_id>${task.id}</task_id>`,
    `<command>${task.command}</command>`,
    `<status>${task.status}</status>`,
    task.exitCode === undefined ? undefined : `<exit_code>${task.exitCode}</exit_code>`,
    `<reason>${reason}</reason>`,
    `<wake_reason>${reason}</wake_reason>`,
  ];
  if (match) {
    lines.push(`<stream>${match.stream}</stream>`);
    lines.push("<matched_line>");
    lines.push(sanitizeShellOutput(match.line));
    lines.push("</matched_line>");
    if (match.capturedGroups.length > 0) {
      lines.push("<captured_groups>");
      lines.push(JSON.stringify(match.capturedGroups));
      lines.push("</captured_groups>");
    }
  } else if (reason === "task_event") {
    lines.push("<hint>A related task event arrived. This command has not finished unless its status says so; process the notification before waiting again.</hint>");
  } else if (reason === "timeout") {
    lines.push("<hint>No matching line yet. Inspect task_output for current buffer, increase timeoutMs, or refine the pattern.</hint>");
  } else if (reason === "exited") {
    const stderr = sanitizeShellOutput(task.stderr.join(""));
    if (stderr) {
      lines.push("<stderr_tail>");
      lines.push(truncateTextTail(stderr));
      lines.push("</stderr_tail>");
    }
    if (task.error) lines.push(`<error>${task.error}</error>`);
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

function taskHistoryDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".reina", taskHistoryDirname);
}

function taskMetadataPath(workspaceRoot: string, taskId: string): string {
  assertTaskId(taskId);
  return path.join(taskHistoryDir(workspaceRoot), `${taskId}${taskMetadataSuffix}`);
}

function taskOutputPath(workspaceRoot: string, taskId: string): string {
  assertTaskId(taskId);
  return path.join(taskHistoryDir(workspaceRoot), `${taskId}${taskOutputSuffix}`);
}

function assertTaskId(taskId: string): void {
  if (!validTaskId.test(taskId)) throw new Error(`invalid background task id: ${taskId}`);
}

function toTaskRecord(task: BackgroundTask): BackgroundShellTaskRecord {
  return {
    id: task.id,
    command: task.command,
    workdir: task.workdir,
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    toolCallId: task.toolCallId,
    injectedAt: task.injectedAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    background: task.background,
    status: task.status,
    pty: task.pty,
    exitCode: task.exitCode,
    error: task.error,
    outputBytes: task.persistedOutputBytes,
    outputTruncated: task.outputTruncated,
  };
}

function queueTaskPersistence(task: BackgroundTask, operation: () => Promise<void>): void {
  task.persistQueue = task.persistQueue.then(operation).catch(() => undefined);
}

function persistTaskMetadata(task: BackgroundTask): void {
  const record = toTaskRecord(task);
  queueTaskPersistence(task, () => writeTaskRecord(task.workspaceRoot, record));
}

function persistTaskOutput(task: BackgroundTask, value: string): void {
  if (!value || task.outputTruncated) return;
  const encoded = Buffer.from(value, "utf8");
  const remaining = maxPersistedOutputBytes - task.persistedOutputBytes;
  if (remaining <= 0) {
    task.outputTruncated = true;
    persistTaskMetadata(task);
    return;
  }

  const stored = encoded.byteLength > remaining ? encoded.subarray(0, remaining) : encoded;
  task.persistedOutputBytes += stored.byteLength;
  if (stored.byteLength < encoded.byteLength) task.outputTruncated = true;
  queueTaskPersistence(task, async () => {
    await mkdir(taskHistoryDir(task.workspaceRoot), { recursive: true });
    await appendFile(taskOutputPath(task.workspaceRoot, task.id), stored);
  });
  if (task.outputTruncated) persistTaskMetadata(task);
}

async function writeTaskRecord(workspaceRoot: string, record: BackgroundShellTaskRecord): Promise<void> {
  assertTaskId(record.id);
  await mkdir(taskHistoryDir(workspaceRoot), { recursive: true });
  await writeFile(taskMetadataPath(workspaceRoot, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function readTaskOutputTail(
  workspaceRoot: string,
  taskId: string,
): Promise<{ output: Buffer; totalBytes: number; truncated: boolean }> {
  const handle = await open(taskOutputPath(workspaceRoot, taskId), "r");
  try {
    const info = await handle.stat();
    const totalBytes = Number(info.size);
    const start = Math.max(0, totalBytes - maxSnapshotOutputBytes);
    const output = Buffer.alloc(totalBytes - start);
    let offset = 0;
    while (offset < output.byteLength) {
      const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      output: offset === output.byteLength ? output : output.subarray(0, offset),
      totalBytes,
      truncated: start > 0,
    };
  } finally {
    await handle.close();
  }
}

async function readPersistedTaskRecords(workspaceRoot: string): Promise<BackgroundShellTaskRecord[]> {
  const root = path.resolve(workspaceRoot);
  let entries;
  try {
    entries = await readdir(taskHistoryDir(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(taskMetadataSuffix))
      .map(async (entry): Promise<BackgroundShellTaskRecord | undefined> => {
        try {
          const parsed = JSON.parse(await readFile(path.join(taskHistoryDir(root), entry.name), "utf8")) as unknown;
          if (!isTaskRecord(parsed)) return undefined;
          if (entry.name !== `${parsed.id}${taskMetadataSuffix}`) return undefined;
          if (!pathsEqual(parsed.workspaceRoot, root)) return undefined;
          return { ...parsed, workspaceRoot: root };
        } catch {
          return undefined;
        }
      }),
  );
  return records.filter((record): record is BackgroundShellTaskRecord => record !== undefined);
}

function isTaskRecord(value: unknown): value is BackgroundShellTaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BackgroundShellTaskRecord>;
  return (
    typeof record.id === "string" &&
    validTaskId.test(record.id) &&
    typeof record.command === "string" &&
    typeof record.workdir === "string" &&
    typeof record.workspaceRoot === "string" &&
    (record.sessionId === undefined || typeof record.sessionId === "string") &&
    (record.toolCallId === undefined || typeof record.toolCallId === "string") &&
    (record.injectedAt === undefined || typeof record.injectedAt === "string") &&
    typeof record.startedAt === "string" &&
    (record.endedAt === undefined || typeof record.endedAt === "string") &&
    (record.background === "requested" || record.background === "auto" || record.background === "timed") &&
    (record.status === "running" ||
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "killed" ||
      record.status === "lost") &&
    typeof record.pty === "boolean" &&
    (record.exitCode === undefined || typeof record.exitCode === "number") &&
    (record.error === undefined || typeof record.error === "string") &&
    typeof record.outputBytes === "number" &&
    Number.isFinite(record.outputBytes) &&
    typeof record.outputTruncated === "boolean"
  );
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function terminateBackgroundShellTask(task: BackgroundTask): Promise<void> {
  if (task.status !== "running") {
    throw new Error(`background task is not running: ${task.id} (${task.status})`);
  }
  task.status = "killed";
  task.endedAt = new Date().toISOString();
  persistTaskMetadata(task);
  // Kill the whole tree on Windows (taskkill /T) so children of the shell —
  // scanners, fuzzers, spawned tools — don't survive as orphans. Wait for
  // taskkill before reporting "killed": launching it detached and immediately
  // signalling the parent races taskkill's tree discovery and can strand both
  // the shell and its child process.
  const pid = task.process.pid;
  if (process.platform === "win32" && pid) {
    await execa("taskkill", ["/F", "/T", "/PID", String(pid)], {
      reject: false,
      timeout: 5000,
      windowsHide: true,
    }).catch(() => undefined);
  } else if (pid) {
    killProcessTree(pid);
  }
  task.process.kill("SIGTERM");
  await Promise.race([task.process.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))]);
  // The process exit handlers early-return on the `killed` guard and never
  // flush, so drain any monitor() waiters here. Otherwise a concurrent
  // monitor({ timeoutMs }) on this task parks until its own timeout.
  flushMonitorOnExit(task);
  persistTaskMetadata(task);
  publishCompletion(task);
  await task.persistQueue;
}

function append(target: string[], value: string, currentBytes: number): number {
  if (!value) return currentBytes;
  target.push(value);
  let bytes = currentBytes + Buffer.byteLength(value, "utf8");
  while (bytes > maxBufferedBytes) {
    const removed = target.shift();
    if (!removed) break;
    bytes -= Buffer.byteLength(removed, "utf8");
  }
  return bytes;
}

type TaskWakeReason = "matched" | "exited" | "timeout" | "task_event";
type TaskWakeResult = { reason: TaskWakeReason; match: MonitorMatch | null };

function waitForTask(
  task: BackgroundTask,
  timeoutMs: number,
  options: ToolRuntimeOptions,
  monitor?: Pick<MonitorWaiter, "pattern" | "streams">,
): Promise<TaskWakeResult> {
  options.signal?.throwIfAborted();
  if (task.status !== "running") return Promise.resolve({ reason: "exited", match: null });
  if (options.taskEvents?.hasPending()) return Promise.resolve({ reason: "task_event", match: null });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = (): void => {
      const index = task.waiters.indexOf(waiter);
      if (index >= 0) task.waiters.splice(index, 1);
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (reason: TaskWakeReason, match: MonitorMatch | null = null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ reason, match });
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(options.signal?.reason ?? new DOMException("The wait was aborted", "AbortError"));
    };
    const waiter: MonitorWaiter = {
      pattern: monitor?.pattern,
      streams: monitor?.streams ?? { stdout: false, stderr: false },
      startedAt: Date.now(),
      resolve: (match) => settle(match ? "matched" : "exited", match),
    };
    task.waiters.push(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = options.taskEvents?.subscribe(() => settle("task_event"));
    // Recheck after subscribing: an event between the initial pending check
    // and registration must not strand this wait until its timeout.
    if (options.signal?.aborted) onAbort();
    else if (options.taskEvents?.hasPending()) settle("task_event");
    if (settled) {
      unsubscribe?.();
      return;
    }
    timer = setTimeout(() => settle("timeout"), timeoutMs);
  });
}

function formatTask(
  task: Pick<BackgroundShellTaskRecord, "id" | "command" | "status" | "exitCode" | "error"> & { stdout: string[]; stderr: string[] },
  wakeReason?: TaskWakeReason,
): string {
  const stdout = sanitizeShellOutput(task.stdout.join("")).trimEnd();
  const stderr = sanitizeShellOutput(task.stderr.join("")).trimEnd();
  const lines: Array<string | undefined> = [
    `<task_id>${task.id}</task_id>`,
    `<command>${task.command}</command>`,
    `<status>${task.status}</status>`,
    wakeReason ? `<wake_reason>${wakeReason}</wake_reason>` : undefined,
    wakeReason === "task_event"
      ? "<hint>A related task event arrived. This command has not finished unless its status says so; process the notification before waiting again.</hint>"
      : undefined,
    task.exitCode === undefined ? undefined : `<exit_code>${task.exitCode}</exit_code>`,
    task.error ? `<error>${task.error}</error>` : undefined,
  ];
  // Only emit the streams that actually have content — an empty
  // `<stdout>(empty)</stdout>` block is pure noise.
  if (stdout) lines.push("<stdout>", truncateTextTail(stdout), "</stdout>");
  if (stderr) lines.push("<stderr>", truncateTextTail(stderr), "</stderr>");
  if (!stdout && !stderr) lines.push("<output>(no output yet)</output>");
  return lines.filter((line) => line !== undefined).join("\n");
}
