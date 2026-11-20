import type { ToolCallRecord } from "@reina/protocol";
import { toolResultFingerprint } from "./tool-progress.js";

/** Pre-dispatch guard against repeated inputs without new results. Successful
 * mutations invalidate prior reads; file writes also allow shell verification
 * again. Failed or merely proposed mutations do not clear that history. */

/** Successful blocking waits may legitimately return without a state change.
 * Shared with the post-execution loop budget; failed waits still count there
 * toward repeated-action and consecutive-error limits. */
export function isBlockingTaskWait(name: string, input: unknown): boolean {
  // wait_async_tasks clamps even an explicit zero timeout to at least 1s.
  if (name === "wait_async_tasks") return true;
  if (name !== "task_output" && name !== "monitor") return false;
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (name === "task_output" && args.block !== true) return false;
  return args.timeoutMs === undefined || (typeof args.timeoutMs === "number" && args.timeoutMs > 0);
}

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

export interface StormVerdict {
  suppress: boolean;
  reason?: string;
}

export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly recent: RecentEntry[] = [];
  private readonly seenResults = new Map<string, Set<string>>();

  constructor(windowSize = 6, threshold = 3) {
    this.windowSize = Math.max(1, windowSize);
    this.threshold = Math.max(2, threshold);
  }

  /** `mutating` is decided by the caller from the tool's permission level
   * (`write` / `execute` / `state` → true; `read` / `network` → false).
   * The caller reports completed executions through recordResult. */
  inspect(name: string, input: unknown, mutating: boolean): StormVerdict {
    if (!name) return { suppress: false };
    // Preserve task_output's existing non-blocking polling exemption too.
    if (name === "task_output" || isBlockingTaskWait(name, input)) return { suppress: false };
    const args = stableStringify(input);
    const readOnly = !mutating;

    let count = 0;
    for (const entry of this.recent) {
      if (entry.name === name && entry.args === args) count++;
    }
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason: `${name} called with identical args ${count + 1} times within the recent call window without new results — repeat-loop guard tripped. Try a different approach or different arguments.`,
      };
    }
    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  recordResult(record: ToolCallRecord): void {
    if (record.status !== "completed") return;
    const args = stableStringify(record.input);
    const key = `${record.name}:${args}`;
    const digest = toolResultFingerprint(record);
    // Process failure text is still a completed run_shell tool observation.
    if (record.name === "run_shell" && !digest) return;
    if (digest) {
      // Keep only digests: shell/read outputs may be large. Remember all seen
      // results so alternating old outputs cannot continually reset the guard.
      const seen = this.seenResults.get(key) ?? new Set<string>();
      if (!seen.has(digest)) {
        let keptLatest = false;
        for (let i = this.recent.length - 1; i >= 0; i--) {
          const entry = this.recent[i]!;
          if (entry.name !== record.name || entry.args !== args) continue;
          if (keptLatest) this.recent.splice(i, 1);
          keptLatest = true;
        }
      }
      seen.add(digest);
      this.seenResults.set(key, seen);
    }

    if (["write", "execute", "state"].includes(record.permission)) {
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const entry = this.recent[i]!;
        if (entry.readOnly || (record.permission === "write" && entry.name === "run_shell")) {
          this.recent.splice(i, 1);
        }
      }
    }
  }

  reset(): void {
    this.recent.length = 0;
    this.seenResults.clear();
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}
