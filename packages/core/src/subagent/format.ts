import type { AsyncTaskRecord } from "@reina/protocol";
import type { AsyncTaskActivitySnapshot } from "./types.js";

export function escapeXml(value: string): string {
  return value.replace(/[<>&]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;"));
}

/** Compact human-ish duration for activity fields: "15s", "8m12s", "1h3m". */
export function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** How long a running child may be silent (no stream events at all) before
 * check_async_task flags it. Long tools are fine — long SILENCE is the
 * stuck signal. */
const SILENCE_HINT_MS = 120_000;

/** Render a single async task as the XML envelope the supervisor sees from
 * check_async_task and the sync start_async_task return shape. */
export function formatAsyncTaskStatus(task: AsyncTaskRecord, snapshot?: AsyncTaskActivitySnapshot): string {
  const lines: string[] = [
    `<async_task>`,
    `<task_id>${task.id}</task_id>`,
  ];
  if (task.name) lines.push(`<name>${escapeXml(task.name)}</name>`);
  lines.push(
    `<agent>${task.agent}</agent>`,
    `<status>${task.status}</status>`,
    `<isolation>${task.isolation}</isolation>`,
    `<started_at>${task.startedAt}</started_at>`,
  );
  if (task.completedAt) lines.push(`<completed_at>${task.completedAt}</completed_at>`);
  if (typeof task.turns === "number") lines.push(`<turns>${task.turns}</turns>`);
  if (typeof task.toolCalls === "number") lines.push(`<tool_calls>${task.toolCalls}</tool_calls>`);
  if (task.usage) {
    const u = task.usage;
    const totalTokens = u.inputTokens + u.outputTokens;
    lines.push(
      `<usage input_tokens="${u.inputTokens}" output_tokens="${u.outputTokens}" cached_input_tokens="${u.cachedInputTokens}" reasoning_tokens="${u.reasoningTokens}" total_tokens="${totalTokens}" duration_ms="${u.durationMs}" />`,
    );
  } else if (task.runningUsage) {
    // While the child is still running, surface the live snapshot so
    // the supervisor can see "this worker has burned 80k tokens so
    // far" and decide whether to cancel mid-flight. Marked live="true"
    // so a future tooling reader can distinguish from settlement.
    const u = task.runningUsage;
    const totalTokens = u.inputTokens + u.outputTokens;
    lines.push(
      `<usage live="true" input_tokens="${u.inputTokens}" output_tokens="${u.outputTokens}" cached_input_tokens="${u.cachedInputTokens}" reasoning_tokens="${u.reasoningTokens}" total_tokens="${totalTokens}" duration_ms="${u.durationMs}" turns="${u.turns}" />`,
    );
  }
  if (task.worktreePath) lines.push(`<worktree>${task.worktreePath}</worktree>`);
  if (task.worktreeBranch) lines.push(`<branch>${task.worktreeBranch}</branch>`);
  if (task.recovery) {
    lines.push(
      `<recovery status="${task.recovery.status}" checked_at="${task.recovery.checkedAt}"${task.recovery.worktreeStatus ? ` worktree="${task.recovery.worktreeStatus}"` : ""}>${escapeXml(task.recovery.reason)}</recovery>`,
    );
  }
  if (task.result) lines.push(`<result>${task.result}</result>`);
  if (task.error) lines.push(`<error>${task.error}</error>`);
  if (snapshot) {
    const attrs: string[] = [];
    if (snapshot.lastEventAgoMs !== undefined) attrs.push(`last_event_ago="${formatDurationMs(snapshot.lastEventAgoMs)}"`);
    if (snapshot.activeToolRunningMs !== undefined) attrs.push(`tool_running_for="${formatDurationMs(snapshot.activeToolRunningMs)}"`);
    lines.push(`<activity${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>${snapshot.activity}</activity>`);
    if (snapshot.lastAssistantText) {
      lines.push(`<recent_text>${escapeXml(snapshot.lastAssistantText)}</recent_text>`);
    }
    for (const call of snapshot.recentToolCalls) {
      lines.push(`<recent_tool name="${call.name}" status="${call.status}" />`);
    }
    for (const err of snapshot.errors) {
      lines.push(`<recent_error>${escapeXml(err)}</recent_error>`);
    }
  }
  if (task.status === "running") {
    if (snapshot?.lastEventAgoMs !== undefined && snapshot.lastEventAgoMs >= SILENCE_HINT_MS) {
      lines.push(
        `<hint>No stream events for ${formatDurationMs(snapshot.lastEventAgoMs)}. A long-running tool that still emits output is healthy; sustained silence may mean a command is blocked. Consider update_async_task to nudge the child before cancelling.</hint>`,
      );
    } else {
      lines.push(`<hint>Task is still running. Do other work between checks rather than polling tight.</hint>`);
    }
  } else if (task.status === "recoverable") {
    lines.push(`<hint>Task is recoverable after a process restart. Use update_async_task with a continuation message to start a fresh child attempt.</hint>`);
  } else if (task.status === "needs_attention") {
    lines.push(`<hint>Task needs attention before resume. Inspect the recovery reason and worktree state before continuing.</hint>`);
  }
  lines.push(`</async_task>`);
  return lines.join("\n");
}

/** Compact one-line summary used in the per-turn injection of changed
 * task statuses (engine.injectAsyncTaskSnapshot). */
export function formatAsyncTaskSnapshotLine(task: AsyncTaskRecord, snapshot?: AsyncTaskActivitySnapshot): string {
  const parts: string[] = [`- ${task.id}`, `agent=${task.agent}`, `status=${task.status}`];
  if (typeof task.turns === "number") parts.push(`turns=${task.turns}`);
  if (typeof task.toolCalls === "number") parts.push(`tools=${task.toolCalls}`);
  const startMs = Date.parse(task.startedAt);
  const endMs = task.completedAt ? Date.parse(task.completedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  parts.push(`elapsed=${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`}`);
  if (snapshot?.activity) parts.push(`activity=${snapshot.activity}`);
  if (snapshot?.lastEventAgoMs !== undefined) parts.push(`last_event=${formatDurationMs(snapshot.lastEventAgoMs)}_ago`);
  if (snapshot?.activeToolRunningMs !== undefined) parts.push(`tool_running=${formatDurationMs(snapshot.activeToolRunningMs)}`);
  if (task.runningUsage && !task.usage) {
    // Surface live token spend in the per-turn diff line so the
    // supervisor can budget-watch long-running children without
    // calling check_async_task on each one.
    const u = task.runningUsage;
    parts.push(`live_tokens=${u.inputTokens + u.outputTokens}`);
  }
  if (task.status === "failed" && task.error) {
    parts.push(`error=${JSON.stringify(task.error.slice(0, 120))}`);
  }
  return parts.join(" ");
}
