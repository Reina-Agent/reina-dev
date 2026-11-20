import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelStreamEvent } from "@reina/protocol";
import type { AsyncTaskActivitySnapshot } from "./types.js";

/** In-memory activity tracker maintained by the subagent manager's
 * stream bridge. Each tick observes one child event, updates the
 * running snapshot, and the manager's `getCachedActivity(taskId)`
 * returns it without touching disk.
 *
 * Why this exists: check_async_task previously fired a stat + 64KB
 * read for every running task on every supervisor turn — on autopilot
 * with 3 concurrent children, that's 150+ pageins/min just to render
 * "what's the worker doing". With this cache, supervisor reads are
 * O(1) memory access; the on-disk JSONL stays for post-mortem /
 * cross-process inspection only. */
export class ActivityTracker {
  private byTaskId = new Map<string, MutableActivitySnapshot>();

  /** Apply one stream event to the running snapshot. Safe to call
   * with any ModelStreamEvent — non-relevant types are ignored. */
  observe(taskId: string, event: ModelStreamEvent): void {
    if (event.type === "context-request" || event.type === "context-history-event"
      || (event.type === "background-error" && event.category === "context.history")) return;
    let snap = this.byTaskId.get(taskId);
    if (!snap) {
      snap = createSnapshot();
      this.byTaskId.set(taskId, snap);
    }
    snap.totalEvents += 1;
    // Every event is a liveness tick, including types we otherwise ignore —
    // the supervisor's "is it stuck" question is about silence, not about
    // which event types arrived.
    snap.lastEventAt = Date.now();
    if (event.type === "text-delta" && typeof (event as { text?: unknown }).text === "string") {
      snap.recentText += (event as { text: string }).text;
      if (snap.recentText.length > 800) snap.recentText = snap.recentText.slice(-400);
      snap.lastEventType = "text-delta";
    } else if (event.type === "tool-progress") {
      const id = typeof (event as { id?: unknown }).id === "string" ? (event as { id: string }).id : "";
      const name = typeof (event as { name?: unknown }).name === "string" ? (event as { name: string }).name : "?";
      const status = typeof (event as { status?: unknown }).status === "string" ? (event as { status: string }).status : "?";
      if (id) snap.toolByCallId.set(id, { name, status });
      if (status === "running") {
        // Repeated "running" progress ticks for the same tool must not
        // reset the start time — runtime is measured from the first one.
        if (snap.activeTool !== name) snap.activeToolStartedAt = Date.now();
        snap.activeTool = name;
      } else if (snap.activeTool === name && status !== "running") {
        snap.activeTool = undefined;
        snap.activeToolStartedAt = undefined;
      }
      if (status === "failed") {
        const msg = typeof (event as { message?: unknown }).message === "string" ? (event as { message: string }).message : "";
        snap.errors.push(`${name}: ${msg}`);
        if (snap.errors.length > 3) snap.errors = snap.errors.slice(-3);
      }
      snap.lastEventType = "tool-progress";
    } else if (event.type === "background-error") {
      const category = typeof (event as { category?: unknown }).category === "string" ? (event as { category: string }).category : "?";
      const msg = typeof (event as { message?: unknown }).message === "string" ? (event as { message: string }).message : "";
      snap.errors.push(`${category}: ${msg}`);
      if (snap.errors.length > 3) snap.errors = snap.errors.slice(-3);
    }
  }

  /** Materialize a snapshot view for the supervisor. */
  get(taskId: string): AsyncTaskActivitySnapshot | undefined {
    const snap = this.byTaskId.get(taskId);
    if (!snap) return undefined;
    let activity: string;
    if (snap.activeTool) activity = `tool:${snap.activeTool}`;
    else if (snap.lastEventType === "text-delta") activity = "streaming";
    else if (snap.lastEventType === "") activity = "starting";
    else activity = "idle";
    const recentToolCalls = [...snap.toolByCallId.values()].slice(-3).map((entry) => ({
      name: entry.name,
      status: entry.status,
    }));
    const now = Date.now();
    return {
      activity,
      lastAssistantText: snap.recentText ? snap.recentText.slice(-400) : undefined,
      recentToolCalls,
      errors: snap.errors.slice(-3),
      lastEventAgoMs: snap.lastEventAt > 0 ? Math.max(0, now - snap.lastEventAt) : undefined,
      activeToolRunningMs:
        snap.activeTool && snap.activeToolStartedAt !== undefined ? Math.max(0, now - snap.activeToolStartedAt) : undefined,
    };
  }

  /** Drop the cache entry for a settled task. Called by the manager
   * after settlement so memory doesn't accumulate across long
   * sessions. */
  drop(taskId: string): void {
    this.byTaskId.delete(taskId);
  }

  /** Number of tracked tasks (for tests + diagnostics). */
  size(): number {
    return this.byTaskId.size;
  }
}

type MutableActivitySnapshot = {
  lastEventType: string;
  activeTool: string | undefined;
  /** Epoch ms of when the active tool's first "running" tick arrived. */
  activeToolStartedAt: number | undefined;
  recentText: string;
  toolByCallId: Map<string, { name: string; status: string }>;
  errors: string[];
  totalEvents: number;
  /** Epoch ms of the last observed event (0 = none yet). */
  lastEventAt: number;
};

function createSnapshot(): MutableActivitySnapshot {
  return {
    lastEventType: "",
    activeTool: undefined,
    activeToolStartedAt: undefined,
    recentText: "",
    toolByCallId: new Map(),
    errors: [],
    totalEvents: 0,
    lastEventAt: 0,
  };
}

/** Read the tail of a task's persisted stream and summarize it into something
 * the supervisor can act on. Returns undefined silently if the file is
 * missing — the writer is best-effort, so a missing file just means "no
 * snapshot available" rather than an error condition.
 *
 * Prefer ActivityTracker.get() when the child is still in-process; this
 * disk reader is the fallback for cross-process inspection (e.g., a
 * separate CLI invocation peeking at .reina/tasks/<id>/stream.jsonl). */
export async function readAsyncTaskActivity(cwd: string, taskId: string): Promise<AsyncTaskActivitySnapshot | undefined> {
  const file = path.join(cwd, ".reina", "tasks", taskId, "stream.jsonl");
  const TAIL_BYTES = 64 * 1024;
  let content: string;
  try {
    const stats = await stat(file);
    if (stats.size === 0) return undefined;
    if (stats.size <= TAIL_BYTES) {
      content = await readFile(file, "utf8");
    } else {
      const handle = await open(file, "r");
      try {
        const start = stats.size - TAIL_BYTES;
        const buffer = Buffer.alloc(TAIL_BYTES);
        await handle.read(buffer, 0, TAIL_BYTES, start);
        content = buffer.toString("utf8");
        // Drop the partial first line; we sliced into the middle of it.
        const firstNewline = content.indexOf("\n");
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
      } finally {
        await handle.close();
      }
    }
  } catch {
    return undefined;
  }
  return summarizeAsyncTaskStream(content);
}

function summarizeAsyncTaskStream(content: string): AsyncTaskActivitySnapshot {
  const lines = content.split("\n").filter((line) => line.length > 0);
  let lastTextDelta = "";
  let lastEventType = "";
  let activeTool: string | undefined;
  let activeToolStartedAtMs: number | undefined;
  let lastEventAtMs: number | undefined;
  const toolByCallId = new Map<string, { name: string; status: string; index: number }>();
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let parsed: { timestamp?: string; event?: { type?: string; [k: string]: unknown } };
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const event = parsed.event;
    if (!event || typeof event.type !== "string") continue;
    if (event.type === "context-request" || event.type === "context-history-event"
      || (event.type === "background-error" && event.category === "context.history")) continue;
    const stampMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
    if (Number.isFinite(stampMs)) lastEventAtMs = stampMs;
    lastEventType = event.type;
    if (event.type === "text-delta" && typeof event.text === "string") {
      lastTextDelta += event.text;
    } else if (event.type === "tool-progress") {
      const id = typeof event.id === "string" ? event.id : "";
      const name = typeof event.name === "string" ? event.name : "?";
      const status = typeof event.status === "string" ? event.status : "?";
      if (id) toolByCallId.set(id, { name, status, index: i });
      if (status === "running") {
        if (activeTool !== name) activeToolStartedAtMs = Number.isFinite(stampMs) ? stampMs : undefined;
        activeTool = name;
      } else if (activeTool === name && status !== "running") {
        activeTool = undefined;
        activeToolStartedAtMs = undefined;
      }
      if (status === "failed" && typeof event.message === "string") {
        errors.push(`${name}: ${event.message}`);
      }
    } else if (event.type === "background-error") {
      const category = typeof event.category === "string" ? event.category : "?";
      const message = typeof event.message === "string" ? event.message : "?";
      errors.push(`${category}: ${message}`);
    }
  }

  let activity: string;
  if (activeTool) activity = `tool:${activeTool}`;
  else if (lastEventType === "text-delta") activity = "streaming";
  else if (lastEventType === "") activity = "starting";
  else activity = "idle";

  const recentToolCalls = [...toolByCallId.values()]
    .sort((a, b) => a.index - b.index)
    .slice(-3)
    .map((entry) => ({ name: entry.name, status: entry.status }));

  const now = Date.now();
  return {
    activity,
    lastAssistantText: lastTextDelta ? lastTextDelta.slice(-400) : undefined,
    recentToolCalls,
    errors: errors.slice(-3),
    lastEventAgoMs: lastEventAtMs !== undefined ? Math.max(0, now - lastEventAtMs) : undefined,
    activeToolRunningMs:
      activeTool && activeToolStartedAtMs !== undefined ? Math.max(0, now - activeToolStartedAtMs) : undefined,
  };
}
