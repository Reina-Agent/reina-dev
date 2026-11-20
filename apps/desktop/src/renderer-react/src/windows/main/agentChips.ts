// agentChips.ts — pure derivation helpers for the subagent chip row
// (AgentChipRow.tsx): tool part → chip model, chip ↔ AsyncTaskLite matching,
// merged status, duration and the live-activity tail. Kept free of store /
// React imports (type-only) so the logic is unit-testable like toolRunGroups.

import type { TimelineToolPart } from "./protocol";
import type { AsyncTaskLite, SubagentActivity } from "./sessionStore";

export type ChipStatus = "running" | "completed" | "failed";

export interface AgentChip {
  /** Tool part id — stable React key + expanded-state key. */
  callId: string;
  toolName: string;
  /** Task brief, verbatim from the dispatch input (matching key vs the roster). */
  description: string;
  /** First line of the brief, for the chip face. */
  label: string;
  agent?: string;
  partStatus: TimelineToolPart["status"];
  output?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

const LABEL_MAX = 60;

export function chipFromPart(part: TimelineToolPart): AgentChip {
  const detail = part.detail[0];
  const input = (detail?.input && typeof detail.input === "object" ? detail.input : {}) as Record<string, unknown>;
  const description = String(input.description ?? input.prompt ?? "").trim();
  const firstLine = (description.split("\n")[0] ?? "").trim();
  const label = firstLine.length > LABEL_MAX ? `${firstLine.slice(0, LABEL_MAX - 1)}…` : firstLine || part.title || part.name;
  const agentRaw = input.subagentType ?? input.subagent_type ?? input.agent;
  return {
    callId: part.id,
    toolName: part.name,
    description,
    label,
    agent: typeof agentRaw === "string" && agentRaw ? agentRaw : undefined,
    partStatus: part.status,
    output: detail?.output,
    error: detail?.error,
    createdAt: detail?.createdAt ?? part.createdAt,
    completedAt: detail?.completedAt ?? part.completedAt,
  };
}

const LIVE_TASK_STATUSES = new Set(["running", "resuming"]);
const FAILED_TASK_STATUSES = new Set(["failed", "cancelled", "failed_unrecoverable", "needs_attention"]);

/** Find the roster record for a chip. Tool events only carry the tool-call id,
 * so matching goes through the brief: dispatch dedup keeps (agent, brief)
 * unique among LIVE tasks, and for settled ones the startedAt closest to the
 * dispatch's own timestamp wins (same brief re-dispatched later in the
 * session must not steal an older chip's record). */
export function resolveChipTask(
  chip: AgentChip,
  index: Record<string, AsyncTaskLite>,
): AsyncTaskLite | undefined {
  if (!chip.description) return undefined;
  const candidates = Object.values(index).filter(
    (t) => t.description === chip.description && (!chip.agent || !t.agent || t.agent === chip.agent),
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const live = candidates.filter((t) => LIVE_TASK_STATUSES.has(t.status));
  if (live.length === 1) return live[0];
  const anchor = Date.parse(chip.createdAt);
  const pool = live.length > 1 ? live : candidates;
  if (!Number.isFinite(anchor)) return pool[pool.length - 1];
  return pool.reduce((best, t) => {
    const d = (x: AsyncTaskLite) => {
      const ts = Date.parse(x.startedAt ?? "");
      return Number.isFinite(ts) ? Math.abs(ts - anchor) : Number.POSITIVE_INFINITY;
    };
    return d(t) < d(best) ? t : best;
  });
}

/** Merge the dispatch tool part's status with the roster record's. The record
 * wins where it knows more: a settled start_async_task part ("dispatched OK")
 * whose child is still working shows running; a child that later failed shows
 * failed even though the dispatch call itself completed. */
export function chipStatus(chip: AgentChip, task?: AsyncTaskLite): ChipStatus {
  if (chip.partStatus === "failed" || chip.partStatus === "rejected") return "failed";
  if (chip.partStatus === "running" || chip.partStatus === "pending_approval") return "running";
  if (task) {
    if (LIVE_TASK_STATUSES.has(task.status)) return "running";
    if (FAILED_TASK_STATUSES.has(task.status)) return "failed";
  }
  return "completed";
}

/** Wall-clock duration for a settled chip. Prefers the roster record's
 * lifetime (the child's real span — an async child outlives its dispatch
 * call); falls back to the tool part's own timestamps. */
export function chipDurationMs(chip: AgentChip, task?: AsyncTaskLite): number | undefined {
  const span = (from?: string, to?: string): number | undefined => {
    const a = Date.parse(from ?? "");
    const b = Date.parse(to ?? "");
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
  };
  return span(task?.startedAt, task?.completedAt) ?? span(chip.createdAt, chip.completedAt);
}

export function formatChipDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Stable identity hue: hash the taskId (fallback: call id) into one of the
 * theme-token color classes (subagent-chips.css .color-0 … .color-5). */
export const CHIP_COLOR_COUNT = 6;

export function chipColorIndex(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % CHIP_COLOR_COUNT;
}

/** One-line "what is it doing right now" tail for a running chip: the latest
 * child tool step, else the streamed text / reasoning tail (same priority as
 * the old SubagentPanel's describeActivity). */
export function chipActivityTail(activity?: SubagentActivity): string {
  if (!activity) return "";
  const lastTool = activity.tools[activity.tools.length - 1];
  if (lastTool) return lastTool.target ? `${lastTool.name} · ${lastTool.target}` : lastTool.name;
  return activity.text || activity.reasoning || "";
}
