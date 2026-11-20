// Workspace engine store (external store via useSyncExternalStore). Holds the
// inter-agent state that the workspace window's Conversation / Agent Team / DAG
// tabs render — the merged conversation timeline source (notes + subtasks), the
// subtask DAG (+ phase), async-task roster, and per-task subagent activity
// buffers.
//
// ── Why this exists (the bug it fixes) ───────────────────────────────────────
// The workspace tabs were built subscribing to bespoke top-level channels that
// the main process never forwards, so they got no data. The engine state
// actually arrives on the broadcast "agent" channel (main forwards
// `reina:event:agent` to ALL windows) in TWO shapes, exactly as the legacy
// main-chat renderer consumes them (renderer/actions/agent-events.js):
//
//   • { type: "session_snapshot", sessionId, session }
//        → cold-load / replace from session.subtasks /
//          session.phase / session.asyncTasks (hydrateFromSession reducers).
//   • { type: "model_stream", sessionId, event: { type: <sub>, ... } }
//        → live deltas: subtask-updated, phase-changed,
//          async-task-updated, subagent-event, notes-updated.
//
// This store subscribes ONCE to "agent" and faithfully ports the legacy
// reducers (applySubtask/applyPhase + hydrate, mergeAsyncTaskUpdate,
// foldSubagentActivityEvent, note upsert/remove). Tabs read slices via
// useWorkspaceEngine(selector). The notes list here powers the Conversation
// tab's directed-message channel live (legacy ported listNotes cold-load still
// lives in the tab for disk parity, but live notes-updated also flow here).

import { useSyncExternalStore } from "react";
import type { AsyncTaskRecord } from "@reina/protocol";
import { bridge } from "~/lib/bridge";
import { bindSideChatSession, handleSideChatEvent, handleSideChatState } from "../main/sideChatStore";
import {
  foldSubagentActivityEvent,
  foldSubagentActivityRecords,
  mergeSubagentActivityRecords,
  settlePendingActivityWaits,
  type ActivityEntry,
  type ActivitySourceRecord,
} from "./subagentActivity";

export type { ActivityEntry, ActivityKind } from "./subagentActivity";

// ── Types (mirror @reina/protocol records the tabs already declare) ──────────

export type SubtaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "blocked";

export interface SubtaskRecord {
  id: string;
  title: string;
  description: string;
  owner: string;
  status: SubtaskStatus;
  blockedBy: string[];
  blocks: string[];
  asyncTaskIds: string[];
  phase?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  resultSummary?: string;
}

export type AsyncTask = AsyncTaskRecord;
export type TaskStatus = AsyncTaskRecord["status"];

export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  refs: string[];
  status: string;
  author: string;
  recipient?: string;
  createdAt: string;
}

export interface WorkspaceEngineState {
  // sessionId of the most recent engine event — needed to cancel async tasks.
  sessionId: string | null;
  subtasks: Map<string, SubtaskRecord>;
  phase: string | null;
  asyncTasks: AsyncTask[];
  // Per-task live activity buffers (subagent-event stream).
  activity: Map<string, ActivityEntry[]>;
  // Directed-message notes (live, from notes-updated) — powers the Conversation
  // tab's "message"/"broadcast" channel without a disk re-read on each delta.
  notes: NoteMeta[];
  // Monotonic counter bumped on every notes-updated event. The Notes tab reads
  // the full notebook from disk (not just directed messages), so it watches this
  // to know when to re-listNotes for a live refresh (mirror legacy renderNotes).
  notesVersion: number;
  // Same signal for the GLOBAL cross-project notebook (global-notes-updated).
  // Separate counter so workspace note churn never triggers a re-list of the
  // global dir and vice versa.
  globalNotesVersion: number;
}

// ── Store internals ──────────────────────────────────────────────────────────

const EMPTY_STATE: WorkspaceEngineState = {
  sessionId: null,
  subtasks: new Map(),
  phase: null,
  asyncTasks: [],
  activity: new Map(),
  notes: [],
  notesVersion: 0,
  globalNotesVersion: 0,
};

let state: WorkspaceEngineState = EMPTY_STATE;
const LIVE_ACTIVITY_RECORD_LIMIT = 2_000;
const liveActivityRecords = new Map<string, ActivitySourceRecord[]>();

// The session this window is bound to follow — the user's FOREGROUND session,
// learned from the main process's `active-session` broadcast (+ the initial
// desktop-state seed), NOT "whoever emitted the last event". Without this gate
// a background session (e.g. one auto-continuing a goal) repaints the DAG /
// Agent Team / Conversation / Notes tabs with its own subtasks/phase/tasks —
// the same cross-session bleed the main-window Goal card had. null until the
// seed resolves; events are let through until then, then filtered.
let boundSessionId: string | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function set(patch: Partial<WorkspaceEngineState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getWorkspaceEngineState(): WorkspaceEngineState {
  return state;
}

export function useWorkspaceEngine<T>(selector: (s: WorkspaceEngineState) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => selector(state),
    () => selector(state),
  );
}

// ── Reducers (faithful ports of the legacy renderer modules) ────────────────

/** Port of dag-view.js applySubtask — idempotent upsert/remove. */
function applySubtask(subtask: SubtaskRecord | undefined, change?: string): void {
  if (!subtask?.id) return;
  if (change === "removed") {
    if (!state.subtasks.has(subtask.id)) return;
    const next = new Map(state.subtasks);
    next.delete(subtask.id);
    set({ subtasks: next });
    return;
  }
  const existing = state.subtasks.get(subtask.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(subtask)) return; // no-op
  const next = new Map(state.subtasks);
  next.set(subtask.id, subtask);
  set({ subtasks: next });
}

/** Port of dag-view.js hydrateFromSession — rebuild subtasks + phase. */
function hydrateDagFromSession(
  session: {
    subtasks?: SubtaskRecord[];
    phase?: string | null;
  } | null,
): void {
  const next = new Map<string, SubtaskRecord>();
  for (const st of session?.subtasks ?? []) {
    if (st?.id) next.set(st.id, st);
  }
  set({ subtasks: next, phase: session?.phase ?? null });
}

/** Port of agent-team.js mergeAsyncTaskUpdate — upsert one async task. */
function upsertTask(task: AsyncTask | undefined): void {
  if (!task?.id) return;
  const idx = state.asyncTasks.findIndex((entry) => entry.id === task.id);
  const next = idx === -1 ? [...state.asyncTasks, task] : state.asyncTasks.slice();
  if (idx !== -1) next[idx] = task;
  const patch: Partial<WorkspaceEngineState> = { asyncTasks: next };
  const waitOutcome = pendingWaitOutcome(task.status);
  if (waitOutcome) {
    const activity = state.activity.get(task.id) ?? [];
    const settled = settlePendingActivityWaits(activity, task.completedAt ?? new Date().toISOString(), waitOutcome);
    if (settled) {
      const nextActivity = new Map(state.activity);
      nextActivity.set(task.id, settled);
      patch.activity = nextActivity;
    }
  }
  set(patch);
}

function pendingWaitOutcome(status: TaskStatus): "resolved" | "interrupted" | undefined {
  if (status === "running" || status === "resuming") return undefined;
  return status === "completed" ? "resolved" : "interrupted";
}

function replaceTasks(tasks: AsyncTask[]): void {
  let nextActivity: Map<string, ActivityEntry[]> | undefined;
  for (const task of tasks) {
    const waitOutcome = pendingWaitOutcome(task.status);
    if (!waitOutcome) continue;
    const activity = (nextActivity ?? state.activity).get(task.id) ?? [];
    const settled = settlePendingActivityWaits(activity, task.completedAt ?? new Date().toISOString(), waitOutcome);
    if (!settled) continue;
    if (!nextActivity) nextActivity = new Map(state.activity);
    nextActivity.set(task.id, settled);
  }
  set({ asyncTasks: tasks, ...(nextActivity ? { activity: nextActivity } : {}) });
}

/** Buffer a live subagent-event into a task's activity log (legacy
 * bufferSubagentEvent). */
function bufferSubagentEvent(taskId: string, innerEvent: unknown, persisted = false): void {
  if (!taskId) return;
  const ts = new Date().toISOString();
  const source = innerEvent as { type?: string; [key: string]: unknown };
  if (source && typeof source === "object" && source.type) {
    const records = [...(liveActivityRecords.get(taskId) ?? []), { event: source, timestamp: ts, persisted }];
    if (records.length > LIVE_ACTIVITY_RECORD_LIMIT) records.splice(0, records.length - LIVE_ACTIVITY_RECORD_LIMIT);
    liveActivityRecords.set(taskId, records);
  }
  const buf = state.activity.get(taskId) ?? [];
  const updated = foldSubagentActivityEvent(buf, source, ts);
  if (!updated) return;
  const next = new Map(state.activity);
  next.set(taskId, updated);
  set({ activity: next });
}

/** Port of notes.js mergeNoteUpdate — upsert/remove a note from the live
 * directed-message channel (the Conversation tab projects `recipient` notes). */
function mergeNoteUpdate(payload: { note?: NoteMeta; change?: string } | NoteMeta | undefined): void {
  const note = (payload as { note?: NoteMeta })?.note ?? (payload as NoteMeta | undefined);
  if (!note?.id) return;
  const change = (payload as { change?: string })?.change;
  const idx = state.notes.findIndex((n) => n.id === note.id);
  if (change === "deleted") {
    if (idx === -1) return;
    const next = state.notes.slice();
    next.splice(idx, 1);
    set({ notes: next });
    return;
  }
  const next = state.notes.slice();
  if (idx === -1) next.push(note);
  else next[idx] = note;
  set({ notes: next });
}

// ── Public mutator: replace the live notes list from a disk cold-load. ────────
// The Conversation tab cold-loads listNotes(cwd) on activation; it seeds the
// store so the live notes-updated deltas accumulate on top of disk history.

export function seedWorkspaceNotes(notes: NoteMeta[]): void {
  set({ notes: Array.isArray(notes) ? notes.slice() : [] });
}

// ── Cold-load a task's persisted activity from disk into the store buffer. ────
// Port of agent-team.js hydrateActivityIfNeeded. Reads stream.jsonl via the
// bridge and folds each `{ timestamp, event }` record into the task's buffer
// (reusing the live reducer + the original timestamps). Disk records form the
// durable prefix; its overlap with live child events is removed by ordered
// suffix/prefix matching, and not-yet-flushed live events form the tail.

export async function hydrateTaskActivityFromDisk(cwd: string | undefined, taskId: string): Promise<boolean> {
  if (!cwd || !taskId) return false;
  const sessionId = state.sessionId;
  try {
    const result = (await bridge().readSubagentActivity(cwd, taskId)) as { events?: unknown[] } | null;
    if (state.sessionId !== sessionId) return false;
    const lines = result?.events ?? [];
    const diskRecords: ActivitySourceRecord[] = [];
    for (const line of lines) {
      const rec = line as { event?: unknown; timestamp?: string } | undefined;
      const event = (rec?.event ?? line) as { type?: string; [key: string]: unknown };
      if (!event || typeof event !== "object" || !event.type) continue;
      diskRecords.push({ event, timestamp: rec?.timestamp ?? new Date().toISOString(), persisted: true });
    }

    const mergedRecords = mergeSubagentActivityRecords(diskRecords, liveActivityRecords.get(taskId) ?? []);
    let buf = foldSubagentActivityRecords(mergedRecords);
    const task = state.asyncTasks.find((entry) => entry.id === taskId);
    const waitOutcome = task ? pendingWaitOutcome(task.status) : undefined;
    if (task && waitOutcome) {
      buf = settlePendingActivityWaits(buf, task.completedAt ?? new Date().toISOString(), waitOutcome) ?? buf;
    }
    const next = new Map(state.activity);
    next.set(taskId, buf);
    set({ activity: next });
    return true;
  } catch {
    // Hydration is best-effort; live events still flow.
    return false;
  }
}

/** Reset all engine-derived state (e.g. on workspace switch). */
export function resetWorkspaceEngineState(): void {
  liveActivityRecords.clear();
  state = {
    sessionId: null,
    subtasks: new Map(),
    phase: null,
    asyncTasks: [],
    activity: new Map(),
    notes: [],
    notesVersion: 0,
    globalNotesVersion: 0,
  };
  emit();
}

// ── The single "agent" subscription ──────────────────────────────────────────

interface AgentEventLike {
  type?: string;
  sessionId?: string;
  question?: unknown;
  toolCall?: unknown;
  session?: {
    subtasks?: SubtaskRecord[];
    phase?: string | null;
    asyncTasks?: AsyncTask[];
  };
  event?: {
    type?: string;
    subtask?: SubtaskRecord;
    change?: string;
    phase?: string | null;
    task?: AsyncTask;
    tasks?: AsyncTask[];
    taskId?: string;
    event?: unknown;
    note?: NoteMeta;
    question?: unknown;
    toolCall?: unknown;
  };
}

function bubbledTaskId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bubbled = (value as { bubbledFromTask?: unknown }).bubbledFromTask;
  if (!bubbled || typeof bubbled !== "object") return undefined;
  const id = (bubbled as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

function handleAgentEvent(raw: unknown): void {
  const ev = raw as AgentEventLike | null;
  if (!ev || typeof ev !== "object") return;
  // Foreground gate: drop events for any session other than the one this window
  // follows, so a background session's snapshots/deltas can't bleed into these
  // tabs. `boundSessionId` tracks the bound session (set by setWorkspaceSession),
  // not the last emitter. Binding is established out-of-band by
  // setWorkspaceSession, so while still unbound (null) we drop ANY session-tagged
  // event rather than letting a background session paint these tabs during the
  // bind gap (matches taskStore's stricter gate).
  // The GLOBAL notebook is shared across sessions — a self-evolve review in
  // ANY session (foreground or not) changes it — so its refresh signal is
  // handled BEFORE the foreground gate below. Payload-free: consumers re-list
  // from disk, so there is no per-session data to bleed.
  if (ev.type === "model_stream" && ev.event?.type === "global-notes-updated") {
    set({ globalNotesVersion: state.globalNotesVersion + 1 });
    return;
  }

  // Side Chat belongs to its parent session but is not Workspace engine state.
  // Route it before the foreground gate so each session's ephemeral transcript
  // can keep streaming while the user briefly views another task.
  if (ev.type === "model_stream" && ev.event) {
    const sideChatSessionId = ev.sessionId ?? boundSessionId;
    if (sideChatSessionId && ev.event.type === "side-chat-event") {
      handleSideChatEvent(sideChatSessionId, ev.event as { type?: string } & Record<string, unknown>);
      return;
    }
    if (sideChatSessionId && ev.event.type === "side-chat-state") {
      handleSideChatState(sideChatSessionId, ev.event as { type?: string; status?: string; error?: string });
      return;
    }
  }

  if (ev.sessionId && ev.sessionId !== boundSessionId) return;

  // Bubbled HITL events also arrive on the parent's top-level desktop channel:
  // approvals are translated out of model_stream by agent-host, and questions
  // are replayed at turn settlement. Route those copies back to the worker's
  // timeline; the activity reducer dedupes them by question/tool-call id.
  if (ev.type === "permission_request") {
    const taskId = bubbledTaskId(ev.toolCall);
    if (taskId) bufferSubagentEvent(taskId, { type: "permission-request", toolCall: ev.toolCall });
    return;
  }
  if (ev.type === "question_request") {
    const taskId = bubbledTaskId(ev.question);
    if (taskId) bufferSubagentEvent(taskId, { type: "question-request", question: ev.question });
    return;
  }

  if (ev.type === "session_snapshot") {
    const session = ev.session ?? null;
    // Cold-load every channel from the snapshot (legacy hydrate* reducers).
    hydrateDagFromSession(session);
    if (Array.isArray(session?.asyncTasks)) replaceTasks(session.asyncTasks);
    return;
  }

  if (ev.type === "model_stream" && ev.event) {
    const inner = ev.event;
    switch (inner.type) {
      case "subtask-updated":
        applySubtask(inner.subtask, inner.change ?? "updated");
        return;
      case "phase-changed":
        set({ phase: inner.phase ?? null });
        return;
      case "async-task-updated":
        upsertTask(inner.task);
        return;
      case "async-task-injected":
        upsertTask(inner.task);
        return;
      case "async-task-evicted-batch":
        for (const task of inner.tasks ?? []) upsertTask(task);
        return;
      case "async-task-warning":
        if (inner.taskId) bufferSubagentEvent(inner.taskId, inner);
        return;
      case "subagent-event":
        if (inner.taskId) bufferSubagentEvent(inner.taskId, inner.event, true);
        return;
      case "question-request": {
        const taskId = bubbledTaskId(inner.question);
        if (taskId) bufferSubagentEvent(taskId, inner);
        return;
      }
      case "notes-updated":
        mergeNoteUpdate(inner as { note?: NoteMeta; change?: string });
        // Signal the Notes tab to re-read the full notebook from disk.
        set({ notesVersion: state.notesVersion + 1 });
        return;
      default:
        return;
    }
  }
}

/** Bind these tabs to a (newly) foreground session. Drops the previous
 * session's derived state and asks the main process to replay the now-active
 * session's cached snapshot so an idle session's DAG/tasks still show after a
 * switch. Called from the desktop-state seed on mount AND on every
 * `active-session` broadcast. No-op when the session is unchanged so a redundant
 * broadcast can't wipe live state mid-turn. */
export function setWorkspaceSession(sessionId: string | null): void {
  if (sessionId === boundSessionId) return;
  const hadPrevious = boundSessionId !== null;
  boundSessionId = sessionId;
  bindSideChatSession(sessionId);
  if (hadPrevious) {
    // Switching AWAY from a bound session → clear its tabs and re-seed. The
    // replay is active-session-aware in the main process, so it returns THIS
    // session's snapshot (the filter above drops any other session's).
    liveActivityRecords.clear();
    state = {
      ...state,
      sessionId,
      subtasks: new Map(),
      phase: null,
      asyncTasks: [],
      activity: new Map(),
      notes: [],
      notesVersion: state.notesVersion + 1,
    };
    emit();
    void bridge()
      .invoke("replay_engine_snapshot")
      .catch(() => undefined);
  } else {
    // Initial bind: record the id so the gate starts filtering background
    // sessions, THEN re-issue the snapshot replay. The mount-time replay fired by
    // WorkspaceApp arrives during the bind gap (before boundSessionId is set) and
    // is dropped by the foreground gate above, so relying on it leaves an idle /
    // reloaded session's DAG/tasks/notes tabs blank. Re-issuing here — after
    // boundSessionId === sessionId — guarantees the active session's cached
    // snapshot lands post-bind and hydrates the tabs.
    set({ sessionId });
    if (sessionId)
      void bridge()
        .invoke("replay_engine_snapshot")
        .catch(() => undefined);
  }
}

// ── Idempotent init: subscribe ONCE to the broadcast "agent" feed. ───────────

let started = false;
let unsubscribe: (() => void) | null = null;
let unsubActiveSession: (() => void) | null = null;

export function initWorkspaceEngineStore(): void {
  if (started) return;
  started = true;
  try {
    unsubscribe = bridge().events.on("agent", handleAgentEvent);
    // Follow the user's foreground session selection so background sessions
    // can't repaint these tabs (see boundSessionId / setWorkspaceSession).
    unsubActiveSession = bridge().events.on("active-session", (payload) => {
      const id = (payload as { sessionId?: string | null } | null)?.sessionId ?? null;
      setWorkspaceSession(id);
    });
  } catch {
    // bridge unavailable — tabs render empty state until it comes up.
    started = false;
  }
}

/** Tear down the subscription. Rarely needed (the workspace window lives for
 * its whole session), but provided for symmetry / hot-reload safety. */
export function disposeWorkspaceEngineStore(): void {
  unsubscribe?.();
  unsubscribe = null;
  unsubActiveSession?.();
  unsubActiveSession = null;
  started = false;
}
