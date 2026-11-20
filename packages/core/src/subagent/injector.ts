import type { AsyncTaskRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { escapeXml } from "./format.js";

/** Event-driven completion injection for background subagent tasks.
 *
 * The "killer feature" that closes the polling-vs-forgetting gap on
 * `task({ background: true })`: instead of relying on the supervisor model
 * to remember to call `get_async_tasks`, the
 * subagent manager pushes settled background tasks onto this queue,
 * and the engine drains them as a user-role observation at each safe
 * boundary (start of a new runTurn + between continueLoop iterations).
 *
 * Mirrors Claude Code's `<task-notification>` channel — the supervisor
 * sees:
 *
 *   <task-notifications count="2">
 *     <task-notification>
 *       <task_id>sub_abc</task_id>
 *       <name>auth-reviewer</name>
 *       <agent>default</agent>
 *       <status>completed</status>
 *       <result>...</result>
 *       ...
 *     </task-notification>
 *     ...
 *   </task-notifications>
 *
 * Idempotency: queued task ids are deduplicated. drainAtSafeBoundary
 * stamps the timestamp when actually emitting so a crash between
 * enqueue and drain still gets a re-attempt next session. */
/** Maximum number of in-flight completion notifications held in memory
 * before we start collapsing the oldest into a summary line. Protects a
 * stuck / slow supervisor from accumulating an unbounded payload that
 * would later get force-fed in one giant `<task-notifications>` blob.
 * Override via REINA_COMPLETION_INJECTOR_CAP. */
export const DEFAULT_INJECTOR_CAP = 8;

function injectorCap(): number {
  const raw = process.env.REINA_COMPLETION_INJECTOR_CAP;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTOR_CAP;
}

/** Cap on the inline `<result>` body when rendering a notification.
 * Long results stay in the `AsyncTaskRecord.result` field and can be
 * pulled in full via `get_async_tasks`; the inline notification is
 * just a heads-up. Override via REINA_COMPLETION_RESULT_CAP. */
export const DEFAULT_RESULT_INLINE_CAP = 1024;

function resultInlineCap(): number {
  const raw = process.env.REINA_COMPLETION_RESULT_CAP;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESULT_INLINE_CAP;
}

export class CompletionInjector {
  private pending: AsyncTaskRecord[] = [];
  /** Number of notifications collapsed into a dropped summary because
   * `pending` overflowed the cap. Reset on each drain. */
  private droppedCount = 0;
  /** Stable ids of the dropped tasks so the summary can name them. */
  private droppedIds: string[] = [];
  private droppedTasks: AsyncTaskRecord[] = [];

  /** Push a settled background task onto the queue. Idempotent: a task
   * already enqueued (or already injected in a prior turn) is dropped.
   * The CALLER mutates the record; we hold a reference so any field
   * updates between enqueue and drain (e.g. usage rollup) are visible
   * in the emitted notification.
   *
   * Cap behavior: when `pending.length` is at the cap, the OLDEST entry
   * is evicted into the dropped summary (FIFO). Newest results matter
   * most — the supervisor can always `get_async_tasks` for full
   * detail on tasks that fell off. */
  enqueue(task: AsyncTaskRecord): void {
    if (task.injectedAt) return;
    if (this.pending.some((p) => p.id === task.id) || this.droppedIds.includes(task.id)) return;
    const cap = injectorCap();
    if (this.pending.length >= cap) {
      const evicted = this.pending.shift();
      if (evicted) {
        this.droppedCount += 1;
        this.droppedIds.push(evicted.id);
        // Keep the task unacknowledged until the dropped-summary is delivered.
        this.droppedTasks.push(evicted);
      }
    }
    this.pending.push(task);
  }

  /** Drop any pending injection for the given task id. Used when a
   * task is cancelled by the supervisor between completion and drain
   * — the supervisor already knows the outcome, no need to inject. */
  remove(taskId: string): boolean {
    const before = this.pending.length;
    const droppedBefore = this.droppedCount;
    this.pending = this.pending.filter((p) => p.id !== taskId);
    this.droppedTasks = this.droppedTasks.filter((task) => task.id !== taskId);
    this.droppedIds = this.droppedIds.filter((id) => id !== taskId);
    this.droppedCount = this.droppedIds.length;
    return this.pending.length !== before || this.droppedCount !== droppedBefore;
  }

  /** Number of queued notifications waiting to be drained. */
  size(): number {
    return this.pending.length;
  }

  hasPending(): boolean {
    return this.pending.length > 0 || this.droppedCount > 0;
  }

  clear(): void {
    this.pending = [];
    this.droppedCount = 0;
    this.droppedIds = [];
    this.droppedTasks = [];
  }

  retain(taskIds: ReadonlySet<string>): void {
    this.pending = this.pending.filter((task) => taskIds.has(task.id));
    this.droppedIds = this.droppedIds.filter((id) => taskIds.has(id));
    this.droppedTasks = this.droppedTasks.filter((task) => taskIds.has(task.id));
    this.droppedCount = this.droppedIds.length;
  }

  /** Pop everything currently queued. Stamps `injectedAt` on each
   * record so a follow-up enqueue (e.g. status flip from rollback)
   * doesn't re-inject the same completion. */
  drainAtSafeBoundary(): AsyncTaskRecord[] {
    if (this.pending.length === 0 && this.droppedCount === 0) return [];
    const drained = this.pending;
    this.pending = [];
    const stamp = nowIso();
    for (const task of drained) {
      task.injectedAt = stamp;
    }
    return drained;
  }

  /** Pop and reset the dropped-summary counters. Format-side helper
   * consumes this to render a single `<dropped count="N" ids="..."/>`
   * line alongside the live entries. */
  drainDropped(): { count: number; ids: string[] } {
    const out = { count: this.droppedCount, ids: this.droppedIds };
    const stamp = nowIso();
    for (const task of this.droppedTasks) task.injectedAt = stamp;
    this.droppedCount = 0;
    this.droppedIds = [];
    this.droppedTasks = [];
    return out;
  }
}

/** Format a batch of drained completions as the user-role observation
 * text the supervisor will see. Returns "" when the batch is empty AND
 * there are no dropped entries.
 *
 * `dropped` is the second return value from `drainDropped()` — when
 * non-zero, a `<dropped count="N" ids="...">` summary line is appended
 * so the supervisor knows tasks fell off the cap. */
export function formatCompletionInjection(
  batch: ReadonlyArray<AsyncTaskRecord>,
  dropped?: { count: number; ids: string[] },
): string {
  if (batch.length === 0 && (!dropped || dropped.count === 0)) return "";
  const cap = resultInlineCap();
  const lines: string[] = [`<task-notifications count="${batch.length}">`];
  for (const task of batch) {
    lines.push(`  <task-notification>`);
    lines.push(`    <task_id>${task.id}</task_id>`);
    if (task.name) lines.push(`    <name>${escapeXml(task.name)}</name>`);
    lines.push(`    <agent>${task.agent}</agent>`);
    lines.push(`    <status>${task.status}</status>`);
    if (task.usage?.durationMs) {
      lines.push(`    <duration_ms>${Math.round(task.usage.durationMs)}</duration_ms>`);
    }
    if (typeof task.turns === "number") lines.push(`    <turns>${task.turns}</turns>`);
    if (typeof task.toolCalls === "number") lines.push(`    <tool_calls>${task.toolCalls}</tool_calls>`);
    if (task.result) {
      const raw = task.result;
      const truncated = raw.length > cap;
      const body = truncated ? raw.slice(0, cap) : raw;
      const attrs = truncated ? ` truncated="true" full_length="${raw.length}"` : "";
      lines.push(`    <result${attrs}>${escapeXml(body)}${truncated ? "…" : ""}</result>`);
      if (truncated) {
        lines.push(`    <hint>Result was truncated; call get_async_tasks with detail "full" for the full body.</hint>`);
      }
    }
    if (task.error) {
      lines.push(`    <error>${escapeXml(task.error)}</error>`);
    }
    lines.push(`  </task-notification>`);
  }
  if (dropped && dropped.count > 0) {
    const idsAttr = dropped.ids.length > 0 ? ` ids="${dropped.ids.map(escapeXml).join(",")}"` : "";
    lines.push(`  <dropped count="${dropped.count}"${idsAttr} reason="injector-cap" />`);
    lines.push(`  <hint>${dropped.count} older completion${dropped.count === 1 ? "" : "s"} were dropped from the live queue due to backpressure; use get_async_tasks with the listed ids and detail "full" to retrieve them.</hint>`);
  }
  lines.push(`</task-notifications>`);
  return lines.join("\n");
}
