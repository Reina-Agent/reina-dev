import { execa } from "execa";
import path from "node:path";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { sanitizeShellOutput, saveToolOutput, truncateTextTail, truncateToolOutputTail } from "../../utils.js";
import { compressLogOutput } from "../../log-compress.js";
import { adoptBackgroundShell, startBackgroundShell, startBackgroundPtyShell } from "./background-shell.js";
import { defaultShellChoice, nonInteractiveShellEnv, shellCommandSpec, type ResolvedShell } from "./shell-resolve.js";
import { createStreamDecoder, type StreamDecoder } from "./stream-decode.js";
import { semanticBoolean } from "./coerce.js";
import { description } from "../../prompts/run-shell.js";

const progressIntervalMs = 500;
const progressTailBytes = 8192;
const defaultAutoBackgroundAfterMs = 8000;

const publicSchema = z.object({
  command: z
    .string()
    .describe("Shell command to execute. Single command string run under the interpreter chosen by `shell` (default: bash on Windows via Git Bash/WSL, /bin/sh on Unix — so write POSIX by default). Pipe / && / || work natively. Quote paths with spaces. For multi-step logic prefer one command with ';' or '&&' over multiple run_shell calls."),
  shell: z
    .enum(["auto", "powershell", "pwsh", "cmd", "bash", "sh"])
    .optional()
    .describe("Interpreter to run the command under. 'auto' (default) = bash on Windows (Git Bash/WSL), falling back to cmd.exe when bash is absent; /bin/sh on Unix. Pick explicitly for cross-dialect work: 'powershell'/'pwsh' for PowerShell one-liners (Windows offensive work), 'cmd' for Windows LOLBins / .bat, 'bash'/'sh' for POSIX tooling. PowerShell is opt-in, not the default."),
  workdir: z
    .string()
    .optional()
    .describe("Relative or absolute working directory. Relative paths resolve from the workspace; defaults to the workspace root."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600000)
    .optional()
    .describe("Optional hard timeout for the command (1000-600000 ms). No timeout is applied by default. An explicit timeout still kills the command after it moves to the background."),
  runInBackground: z
    .boolean()
    .optional()
    .describe("When true, returns a shell_<id> immediately without blocking. Use task_output / monitor to read its output, write_stdin to feed it input, kill_shell to stop it. Defaults to false. Commands that look like long-lived processes (dev server, watcher) auto-background after 8s even if this is false."),
  pty: z
    .boolean()
    .optional()
    .describe("Run under a real pseudo-terminal (TTY) instead of pipes. Off by default. Turn ON only for interactive tools that need a TTY: ssh/sudo/su/`mysql -p` (password prompts read from /dev/tty, NOT stdin), msfconsole, reverse-shell upgrades, ncurses TUIs. PTY merges stdout+stderr and emits terminal escape codes, so it's noisier to parse — leave OFF for build/test/grep. Implies background: returns a shell_<id> you drive with write_stdin / task_output / kill_shell. No timeout is applied unless you set timeoutMs explicitly."),
});

const schema = publicSchema.extend({
  runInBackground: semanticBoolean.optional(),
  run_in_background: semanticBoolean.optional(),
  pty: semanticBoolean.optional(),
});

export const shellTool: ToolImplementation = {
  descriptor: {
    name: "run_shell",
    description,
    permission: "execute",
    requiresApproval: true,
    inputSchema: publicSchema,
    examples: [
      {
        description: "Run git status (fast read-only command)",
        input: { command: "git status --short --branch" },
      },
      {
        description: "Run tests with a tighter timeout",
        input: { command: "npm test -- --bail", timeoutMs: 180000 },
      },
      {
        description: "Pipeline / chained commands in a single call (preferred over multiple run_shell calls)",
        input: { command: "git fetch && git status --short" },
      },
      {
        description: "Start a long-lived dev server as a backgrounded shell, then read its output later with task_output",
        input: { command: "npm run dev", runInBackground: true },
      },
      {
        description: "Run from a subdirectory",
        input: { command: "ls -la", workdir: "packages/core" },
      },
    ],
  },
  async preview(input, options) {
    const parsed = schema.parse(input);
    const cwd = resolveShellWorkdir(options.cwd, parsed.workdir);
    const usePty = parsed.pty ?? false;
    const background = parsed.runInBackground ?? parsed.run_in_background ?? false;
    const autoBackground = !background && !usePty && shouldAutoBackgroundCommand(parsed.command);
    const choice = parsed.shell ?? defaultShellChoice();
    // Surface the actual interpreter before approval — it matters for a
    // security tool (a PowerShell payload vs a POSIX command). Resolution may
    // throw for an explicitly requested but missing shell; show the request.
    let shellLabel: string = choice;
    try {
      shellLabel = shellCommandSpec(parsed.command, choice).resolved;
    } catch {
      // keep the requested choice as the label
    }
    return [
      `Command to run in ${cwd}:`,
      parsed.command,
      `Shell: ${shellLabel}`,
      usePty ? "PTY: true (interactive terminal)" : undefined,
      `Timeout: ${parsed.timeoutMs ? `${parsed.timeoutMs}ms` : "none"}`,
      background || usePty ? "Run in background: true" : undefined,
      autoBackground ? "Run in background: auto" : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    const cwd = resolveShellWorkdir(options.cwd, parsed.workdir);
    const timeout = parsed.timeoutMs;
    const choice = parsed.shell ?? defaultShellChoice();
    const usePty = parsed.pty ?? false;
    // PTY is inherently an interactive session — it only makes sense backgrounded
    // (you drive it via write_stdin / task_output), so it implies background.
    const background = (parsed.runInBackground ?? parsed.run_in_background ?? false) || usePty;
    const autoBackground = !background && shouldAutoBackgroundCommand(parsed.command);
    const autoBackgroundAfterMs = dynamicAutoBackgroundAfterMs();
    if (background || autoBackground) {
      const taskId = usePty
        ? await startBackgroundPtyShell({
            command: parsed.command,
            cwd,
            workdir: cwd,
            workspaceRoot: options.cwd,
            sessionId: options.sessionId,
            toolCallId: options.toolCallId,
            background: "requested",
            // Honor a timeout only when the caller set one explicitly.
            timeoutMs: parsed.timeoutMs,
            shell: choice,
            // A user Stop terminates the session, mirroring the pipe path's
            // execa cancelSignal.
            signal: options.signal,
          })
        : startBackgroundShell({
            command: parsed.command,
            cwd,
            workdir: cwd,
            workspaceRoot: options.cwd,
            sessionId: options.sessionId,
            toolCallId: options.toolCallId,
            background: background ? "requested" : "auto",
            timeoutMs: timeout,
            signal: options.signal,
            shell: choice,
          });
      options.onProgress?.({
        status: "running",
        command: parsed.command,
        taskId,
        message: usePty ? "running in PTY (background)" : background ? "running in background" : "moved to background",
      });
      return JSON.stringify(
        {
          taskId,
          status: "running",
          background: background ? "requested" : "auto",
          pty: usePty || undefined,
          command: parsed.command,
          workdir: path.relative(options.cwd, cwd) || ".",
          next: usePty
            ? "Interactive PTY session. Use write_stdin to send input (passwords, commands), task_output to read what it printed, monitor to wait for a prompt/line, kill_shell to stop it."
            : autoBackground
              ? "This command is still running. Use task_output to read current status, write_stdin to send input, or kill_shell to stop it."
              : "Use task_output with this taskId to read current output (block=true + numeric timeoutMs to wait), write_stdin to send interactive input, or kill_shell to stop it.",
        },
        null,
        2,
      );
    }
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const chunks: string[] = [];
    let tail = "";
    let totalBytes = 0;
    let totalLines = 0;
    const commandSpec = shellCommandSpec(parsed.command, choice);
    const subprocess = execa(commandSpec.file, commandSpec.args, {
      cwd,
      shell: commandSpec.shell,
      reject: false,
      timeout,
      cancelSignal: options.signal,
      all: true,
      env: nonInteractiveShellEnv(),
      extendEnv: false,
    });
    const emitProgress = (status: "running" | "completed" | "failed", message?: string): void => {
      options.onProgress?.({
        status,
        command: parsed.command,
        message,
        output: recentLines(tail, 6),
        elapsedMs: Date.now() - started,
        totalLines,
        totalBytes,
      });
    };
    let lastProgressAt = 0;
    // One decoder per stream so a multibyte char split across chunks isn't torn
    // into `�` (the final result uses execa's `result.all`, but these feed the
    // live progress tail and the foreground→background handoff snapshot).
    const stdoutDecoder = createStreamDecoder();
    const stderrDecoder = createStreamDecoder();
    const onChunk = (decoder: StreamDecoder, chunk: Buffer | string): void => {
      const text = decoder.push(chunk);
      if (!text) return; // incomplete multibyte sequence held until the next chunk
      chunks.push(text);
      totalBytes += Buffer.byteLength(text, "utf8");
      totalLines += lineBreakCount(text);
      tail = trimToRecentBytes(tail + text, progressTailBytes);
      const now = Date.now();
      if (now - lastProgressAt < progressIntervalMs) return;
      lastProgressAt = now;
      emitProgress("running");
    };
    const onStdoutData = (chunk: Buffer | string): void => onChunk(stdoutDecoder, chunk);
    const onStderrData = (chunk: Buffer | string): void => onChunk(stderrDecoder, chunk);
    subprocess.stdout?.on("data", onStdoutData);
    subprocess.stderr?.on("data", onStderrData);
    emitProgress("running", "starting");
    let backgroundTimer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      subprocess.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "background" }>((resolve) => {
        backgroundTimer = setTimeout(() => resolve({ type: "background" }), autoBackgroundAfterMs);
      }),
    ]).finally(() => {
      if (backgroundTimer) clearTimeout(backgroundTimer);
    });
    if (completed.type === "background") {
      // Detach OUR foreground stream listeners before handing the live
      // subprocess to the background task: this tool call resolves now, and
      // leaving them attached keeps firing onProgress for it — a resurrected
      // duplicate live card — alongside the background task's own listeners.
      subprocess.stdout?.removeListener("data", onStdoutData);
      subprocess.stderr?.removeListener("data", onStderrData);
      const taskId = adoptBackgroundShell({
        command: parsed.command,
        workdir: cwd,
        workspaceRoot: options.cwd,
        sessionId: options.sessionId,
        toolCallId: options.toolCallId,
        background: "timed",
        process: subprocess,
        initialOutput: chunks.join(""),
        startedAt,
        // Hand our decoders over so a multibyte char split across the handoff
        // boundary completes on the same decoder instead of decoding to U+FFFD
        // on a fresh one in the background task.
        stdoutDecoder,
        stderrDecoder,
      });
      options.onProgress?.({
        status: "running",
        command: parsed.command,
        taskId,
        message: `moved to background after ${autoBackgroundAfterMs}ms`,
        output: recentLines(tail, 6),
        elapsedMs: Date.now() - started,
        totalLines,
        totalBytes,
      });
      return JSON.stringify(
        {
          taskId,
          status: "running",
          background: "timed",
          reason: "foreground-timeout",
          elapsedMs: Date.now() - started,
          command: parsed.command,
          workdir: path.relative(options.cwd, cwd) || ".",
          next: "This command is still running because it exceeded the foreground wait threshold. Use task_output with block=true to wait for completion, or kill_shell to stop it.",
        },
        null,
        2,
      );
    }
    const result = completed.result;
    if (result.all && chunks.length === 0) chunks.push(result.all);
    emitProgress(result.exitCode === 0 ? "completed" : "failed");
    const hint = shellFailureHint({
      command: parsed.command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: result.timedOut,
      shell: commandSpec.resolved,
    });
    // Lean output: on success emit ONLY the combined stdout+stderr stream
    // (execa's `all`, in chronological order). The command and workdir are
    // already in the tool_use block, and printing stdout + stderr + combined
    // separately tripled every byte. The convention the model relies on:
    // no status marker == clean exit, so an empty body reads as silent
    // success rather than ambiguous failure. On failure we prepend the
    // exit code / timeout / recovery hint so the model can react.
    const rawBody = sanitizeShellOutput(result.all ?? "").trimEnd() || "(no output)";
    // Compress noisy build/test output by importance (error/warn/summary lines
    // kept, progress noise folded). Only the command's OWN output is compressed;
    // the <exit_code>/<hint> failure header assembled below is added afterwards
    // so it is never folded.
    //
    // Lossless guarantee: when compression actually drops lines, we save the
    // FULL uncompressed output to disk ourselves and point the model at it, so
    // any folded line is recoverable via read_file. We must NOT rely on the
    // later truncateToolOutputTail for this — that saves the already-compressed
    // body and only when it overflows the byte cap, so a compressed-but-small
    // output would otherwise lose the dropped lines with no way back.
    let body = rawBody;
    if (logCompressEnabled()) {
      const compacted = compressLogOutput(rawBody);
      if (compacted.compressed) {
        const fullPath = await saveToolOutput(options.cwd, rawBody);
        const folded = compacted.inputLines - compacted.outputLines;
        body =
          `${compacted.content}\n` +
          `...[${folded} low-signal lines folded to save context. The complete verbatim output ` +
          `was saved to disk — if the part you need was dropped, call read_file on the path below ` +
          `to recover it; do not re-run the command.\n...[full output saved to ${fullPath}]]`;
      }
    }
    const failed = result.exitCode !== 0 || result.timedOut;
    if (!failed) return (await truncateToolOutputTail(options.cwd, body)).content;
    const header = [
      `<exit_code>${result.exitCode}</exit_code>`,
      result.timedOut ? `<timed_out>${timeout}</timed_out>` : undefined,
      hint ? `<hint>${hint}</hint>` : undefined,
    ].filter((line) => line !== undefined).join("\n");
    const full = `${header}\n${body}`;
    // The failure status must survive tail truncation so the model and loop
    // guards can distinguish failed commands from successful output.
    const truncatedBody = truncateTextTail(body);
    if (truncatedBody === body) return full;
    const outputPath = await saveToolOutput(options.cwd, full);
    return `${header}\n${truncatedBody}\n\nThe output above was truncated to fit context, but the complete verbatim copy was saved to disk. ` +
      `If the part you need is in the dropped section, call read_file on the path below to recover it — do not re-run the tool or seek another route.\n` +
      `...[full output saved to ${outputPath}]`;
  },
};

function resolveShellWorkdir(workspace: string, requested?: string): string {
  // Shell commands already run with user approval and can address absolute
  // paths themselves. Keep cwd resolution aligned with read_file so global
  // skill scripts can run from ~/.agents/skills (including Junction targets).
  return requested ? path.resolve(workspace, requested) : path.resolve(workspace);
}

/** Log-output compression toggle. On by default; set REINA_LOG_COMPRESS to
 * "0" / "false" / "off" to fall back to plain tail-truncation. */
function logCompressEnabled(): boolean {
  const raw = process.env.REINA_LOG_COMPRESS?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function dynamicAutoBackgroundAfterMs(): number {
  const configured = process.env.REINA_SHELL_AUTO_BACKGROUND_AFTER_MS;
  if (!configured) return defaultAutoBackgroundAfterMs;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultAutoBackgroundAfterMs;
}

export function shouldAutoBackgroundCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  if (startsGuiCommand(tokenizeCommand(normalized))) return true;
  if (/^(npm|pnpm|yarn|bun)(\s+run)?\s+(dev|serve|start|watch)\b/.test(normalized)) return true;
  if (/^(vite|next|webpack|tsc)\b.*\s(--watch|-w)\b/.test(normalized)) return true;
  if (/^(vite|next)\s+dev\b/.test(normalized)) return true;
  if (/^(python|py)\s+-m\s+http\.server\b/.test(normalized)) return true;
  // Server-launch forms only — a bare name like `jupyter --version`,
  // `flask --version`, or `streamlit --help` prints and exits fast, so
  // backgrounding it wastes a round-trip and misreports it as "still running".
  if (/^(uvicorn|gunicorn)\b/.test(normalized) && !/\s--(version|help)\b/.test(normalized)) return true;
  if (/^fastapi\s+(dev|run)\b/.test(normalized)) return true;
  if (/^flask\b.*\srun\b/.test(normalized)) return true;
  if (/^streamlit\s+(run|hello)\b/.test(normalized)) return true;
  if (/^jupyter(?:-|\s+)(lab|notebook|server)\b/.test(normalized)) return true;
  if (/^docker\s+compose\s+up\b/.test(normalized)) return true;
  if (/^(tail|less)\b.*\s(-f|--follow)\b/.test(normalized)) return true;
  if (/^ping\b.*\s-t\b/.test(normalized)) return true;
  return false;
}

function startsGuiCommand(tokens: string[]): boolean {
  const first = commandName(tokens[0]);
  if (!first) return false;
  if (isGuiCommand(first)) return true;
  if (first === "start" || first === "start-process") return tokens.slice(1).some((token) => isGuiCommand(commandName(token)));
  if (first === "cmd") {
    const index = tokens.findIndex((token) => token === "/c" || token === "/k");
    return index >= 0 && startsGuiCommand(tokens.slice(index + 1));
  }
  if (first === "powershell" || first === "pwsh") {
    const index = tokens.findIndex((token) => ["-command", "-c", "/c"].includes(token));
    if (index >= 0) return startsGuiCommand(tokenizeCommand(tokens.slice(index + 1).join(" ")));
    return tokens.some((token) => isGuiCommand(commandName(token)));
  }
  return false;
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
}

function commandName(token: string | undefined): string {
  return path.basename(token ?? "").replace(/\.exe$/, "").toLowerCase();
}

function isGuiCommand(command: string): boolean {
  return ["calc", "notepad", "mspaint", "explorer"].includes(command);
}

function shellFailureHint(input: {
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  shell: ResolvedShell;
}): string | undefined {
  if (input.exitCode === 0 && !input.timedOut) return undefined;
  if (input.timedOut) return "Command timed out. Use a shorter command, increase timeoutMs, or run long-lived processes with runInBackground=true.";
  if (looksLikeUnixShellCommand(input.command)) {
    if (input.shell === "powershell" || input.shell === "pwsh") {
      return "This looks like a Unix shell command. In Windows PowerShell use Get-ChildItem, Get-Content, Select-String, and Select-Object -First — or re-run with shell:'bash' (Git Bash / WSL).";
    }
    if (input.shell === "cmd") {
      return "This looks like a Unix shell command but ran under cmd.exe. Re-run with shell:'bash' for POSIX tooling (Git Bash / WSL).";
    }
  }
  if (commandNotFound(input.stderr)) {
    return "Command was not found. Check that the program is installed and available on PATH, or pick a different `shell` for this command.";
  }
  return "Command exited with a non-zero status. Check stderr, working directory, and command syntax before retrying.";
}

function looksLikeUnixShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /\b(head|tail|sed|awk|grep)\b/.test(normalized) || /\bfind\s+\S+\s+-maxdepth\b/.test(normalized);
}

function commandNotFound(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes("is not recognized") || normalized.includes("not recognized as the name") || normalized.includes("command not found");
}

function recentLines(text: string, maxLines: number): string {
  const clean = text.trimEnd();
  if (!clean) return "";
  return clean.split(/\r?\n/).slice(-maxLines).join("\n");
}

function lineBreakCount(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

function trimToRecentBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let trimmed = text.slice(Math.max(0, text.length - maxBytes));
  while (Buffer.byteLength(trimmed, "utf8") > maxBytes) trimmed = trimmed.slice(1);
  return trimmed;
}
