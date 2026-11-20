import { spawn } from "node:child_process";
import type { AsyncTaskRecord, HookEvent as HookEventName, ReinaHook, ReinaHooks } from "@reina/protocol";

export type HookEventPayload = {
  event: HookEventName;
  sessionId: string;
  cwd: string;
  tool?: { name: string; input: unknown };
  output?: string;
  error?: string;
  prompt?: string;
  /** Populated for `preCompact`: whether the compaction is user-driven
   * (`manual`) or threshold-driven (`auto`). */
  compactType?: "manual" | "auto";
  /** Free-form context for lifecycle events: the compaction trigger reason
   * for `preCompact`, or the start/end source (`startup` / `fork` / `resume`
   * / `close`) for `sessionStart` / `sessionEnd`. */
  reason?: string;
  /** Populated only for `onAsyncTaskComplete`. The full settled record
   * (status, result, error, usage, duration) so hooks can route on any
   * field without us guessing which the user cares about. Serialized to
   * JSON when forwarded to the hook command via env / stdin. */
  task?: AsyncTaskRecord;
};

export type HookOutcome = {
  block?: boolean;
  message?: string;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  if (!value) return false;
  if (matcher === value) return true;
  // simple glob: only "*" wildcard supported
  if (matcher.includes("*")) {
    const regex = new RegExp(`^${matcher.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
    return regex.test(value);
  }
  return false;
}

function shellForPlatform(): { shell: string; flag: string } {
  if (process.platform === "win32") {
    const ps = process.env.COMSPEC && process.env.COMSPEC.toLowerCase().includes("powershell") ? process.env.COMSPEC : "powershell.exe";
    return { shell: ps, flag: "-Command" };
  }
  return { shell: process.env.SHELL || "/bin/bash", flag: "-c" };
}

export async function runHook(hook: ReinaHook, payload: HookEventPayload): Promise<HookOutcome> {
  return new Promise<HookOutcome>((resolve) => {
    const { shell, flag } = shellForPlatform();
    const child = spawn(shell, [flag, hook.command], {
      cwd: payload.cwd,
      env: { ...process.env, REINA_HOOK_EVENT: payload.event },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    // A hook that exits without draining stdin turns our `stdin.end(payload)`
    // into a write to a closed pipe; Node emits EPIPE / ERR_STREAM_DESTROYED
    // asynchronously on a later tick, which the sync try/catch around the write
    // cannot catch. Without this listener that becomes a fatal uncaughtException
    // that kills the agent-host (reproduced with payloads >=64KB). The close/
    // error handlers above already resolve the outcome, so just swallow it.
    child.stdin.on("error", () => {});
    const timeoutMs = hook.timeoutMs && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ block: false, message: `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ block: false, message: `hook spawn failed: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      // Convention: exit code 2 means "block", non-zero means "warn".
      if (code === 2) {
        resolve({ block: true, message: stdout || stderr || "blocked by hook" });
        return;
      }
      // Try to parse JSON for richer responses.
      if (stdout && (stdout.startsWith("{") || stdout.startsWith("["))) {
        try {
          const parsed = JSON.parse(stdout) as HookOutcome;
          if (typeof parsed === "object" && parsed) {
            resolve({ block: Boolean(parsed.block), message: parsed.message });
            return;
          }
        } catch {
          // fall through
        }
      }
      resolve({ block: false, message: code === 0 ? undefined : stderr || `hook exited ${code}` });
    });

    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch {
      /* stdin closed */
    }
  });
}

export async function runHooks(
  hooks: ReinaHooks | undefined,
  event: HookEventName,
  payload: Omit<HookEventPayload, "event">,
): Promise<HookOutcome> {
  const entries = hooks?.[event] ?? [];
  if (entries.length === 0) return {};
  for (const hook of entries) {
    if (!matcherMatches(hook.matcher, payload.tool?.name)) continue;
    const outcome = await runHook(hook, { ...payload, event });
    if (outcome.block) return outcome;
  }
  return {};
}
