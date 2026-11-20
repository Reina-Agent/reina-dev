// Task-pane external store (right-hand #task-pane). Self-contained — does NOT
// touch sessionStore. Drives the two .task-card sections:
//   - "Progress" — the model's write_todos checklist, live.
//   - "Goal"     — the session's authoritative Goal v2 state.
//
// Faithful port of legacy actions/task-panel.js + the agent-events.js wiring.
// Data sources, in order of authority (same as legacy):
//   - active session snapshot (session.todos / session.goal) — hydrated on
//     init AND on every session_snapshot /
//     turn_completed.
//   - live stream events while a turn runs (model_stream sub-events):
//       write_todos tool-progress   -> setTodos
//       autopilot-updated           -> setAutopilot
//       goal-state-changed          -> setGoal
//
// This store owns only state projection. Goal mutations go through the
// host-owned `goal_command` path from TaskPane.

import { useSyncExternalStore } from "react";
import { bridge } from "~/lib/bridge";
import type { GoalRecord, GoalState } from "@reina/protocol";

// ── Domain types (mirror legacy task-panel.js shapes) ───────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TaskTodo {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

export type SessionGoal = GoalRecord;

export interface AutopilotRuntime {
  paused?: boolean;
  running?: boolean;
  rounds?: number;
  doneStatus?: string;
  doneSummary?: string;
}

export interface TaskState {
  todos: TaskTodo[];
  goal: GoalState | null;
  /** Legacy autopilot UI only; Goal v2 never reads or writes this slot. */
  autopilot: AutopilotRuntime | null;
}

let state: TaskState = { todos: [], goal: null, autopilot: null };

// Which session the pane is currently bound to. Goal/todos/legacy autopilot are
// SESSION-SCOPED on the engine, but the events stream in over ONE global `agent`
// channel tagged with `sessionId`. Without gating on this, a background session
// still running autonomous work (emitting goal-state-changed / session_snapshot)
// repaints the visible session's Goal card — the "goal 穿越到其他 session" bug.
// Set via setTaskSession whenever the foreground session changes; null until the
// initial seed resolves (events are dropped until then, then re-hydrated).
let activeSessionId: string | null = null;

const listeners = new Set<() => void>();

function set(patch: Partial<TaskState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getTaskState(): TaskState {
  return state;
}

export function useTaskStore<T>(selector: (s: TaskState) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => selector(state),
  );
}

// ── Pure data shaping (mirror conversation.js extractTodos + task-panel.js) ──

/** extractTodos — verbatim from legacy conversation.js. Returns null when the
 * input carries no todos array (so a non-write_todos call leaves state alone). */
function extractTodos(input: unknown): TaskTodo[] | null {
  const raw = input && typeof input === "object" ? (input as { todos?: unknown }).todos : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((todo) => {
    const t = (todo ?? {}) as { content?: unknown; activeForm?: unknown; status?: unknown };
    return {
      content: typeof t.content === "string" ? t.content : "",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : "",
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
    };
  });
}

// ── Mutations (mirror task-panel.js updateTaskTodos / onSessionGoal / etc.) ──

function setTodos(todos: TaskTodo[]): void {
  set({ todos: Array.isArray(todos) ? todos : [] });
}

function setAutopilot(runtime: AutopilotRuntime | null): void {
  set({ autopilot: runtime ?? null });
}

function setGoal(goal: GoalState | null): void {
  set({ goal: goal ?? null });
}

/** hydrateTaskPanelFromSession — snapshot is the source of authority. */
function hydrateFromSession(session: Record<string, unknown> | null | undefined): void {
  const todos = Array.isArray(session?.todos) ? (session?.todos as TaskTodo[]) : [];
  const goal = (session?.goal as GoalState | null | undefined) ?? null;
  const autopilot = (session?.autopilot as AutopilotRuntime | null | undefined) ?? null;
  set({ todos, goal, autopilot });
}

/** Bind the pane to a (newly) foreground session: drop the previous session's
 * todos/Goal/legacy-autopilot state and re-seed from the new session's snapshot. Called by
 * sessionStore on every foreground session change so a background session's Goal
 * loop can never bleed into the visible Goal card. A null / mismatched snapshot
 * resets to empty; the matching `session_snapshot` then re-hydrates. */
export function setTaskSession(sessionId: string | null, session: Record<string, unknown> | null): void {
  activeSessionId = sessionId;
  if (sessionId && session && session.id === sessionId) hydrateFromSession(session);
  else set({ todos: [], goal: null, autopilot: null });
}

// ── Agent-event wiring (mirror agent-events.js model_stream routing) ─────────

type AgentEventLike = { type?: string; sessionId?: string; session?: Record<string, unknown>; [k: string]: unknown };

function handleAgentEvent(event: AgentEventLike): void {
  // Foreground gate: every agent event is tagged with the session it came from.
  // Drop anything not for the session the pane is bound to — otherwise a
  // background session's goal loop / snapshots overwrite the visible Goal card.
  // Adoption of a new foreground session (incl. draft→real) flows through
  // setTaskSession from sessionStore, not through this listener.
  if (event.sessionId && event.sessionId !== activeSessionId) return;
  switch (event.type) {
    case "session_snapshot": {
      hydrateFromSession(event.session);
      return;
    }
    case "turn_completed": {
      const session = (event as { result?: { session?: Record<string, unknown> } }).result?.session;
      if (session) hydrateFromSession(session);
      return;
    }
    case "model_stream": {
      const sub = (event as { event?: { type?: string; [k: string]: unknown } }).event;
      if (!sub) return;
      switch (sub.type) {
        case "tool-progress": {
          // write_todos renders in the Progress card, not as a chat tool row.
          if (sub.name === "write_todos") {
            const todos = extractTodos(sub.input);
            if (todos) setTodos(todos);
          }
          return;
        }
        case "autopilot-updated": {
          setAutopilot((sub.state as AutopilotRuntime | null) ?? null);
          return;
        }
        case "goal-state-changed": {
          setGoal((sub.state as GoalState | null) ?? null);
          return;
        }
        default:
          return;
      }
    }
    default:
      return;
  }
}

let started = false;

/** Wire the agent-event listener + seed from the active session snapshot.
 * Idempotent — safe to call from a component mount effect. */
export function initTaskStore(): void {
  if (started) return;
  started = true;
  const api = bridge();
  api.events.on("agent", (payload) => handleAgentEvent(payload as AgentEventLike));
  // Seed from the active session's FULL snapshot so a freshly-mounted pane
  // reflects the current todos/goals without waiting for the next stream
  // event. The desktop-state session list is lightweight (no todos/goals);
  // the full snapshot rides on load_session (mirrors sessionStore.loadSession).
  void Promise.resolve(api.getDesktopState())
    .then(async (raw) => {
      const desktop = raw as
        | { activeSessionId?: string; sessions?: Array<{ id?: string; cwd?: string }> }
        | null;
      const activeId = desktop?.activeSessionId;
      const active = desktop?.sessions?.find((s) => s.id === activeId);
      if (!active?.id) return;
      const data = (await api.invoke("load_session", {
        cwd: active.cwd,
        savedSessionId: active.id,
      })) as { session?: Record<string, unknown> } | null;
      // Bind the pane to this session AND hydrate, so the foreground gate in
      // handleAgentEvent passes for its events (and drops other sessions').
      setTaskSession(active.id, data?.session ?? null);
    })
    .catch(() => undefined);
}
