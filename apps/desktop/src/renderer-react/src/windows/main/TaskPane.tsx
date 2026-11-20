// Task status for the main conversation. The data and controls stay faithful to
// the original Progress + Goal panel: a quiet floating capsule expands into a
// docked card that gives the transcript its own unobstructed column.

import { useEffect, useRef, useState } from "react";
import type { UserGoalCommand } from "@reina/protocol";
import { bridge } from "~/lib/bridge";
import { useMainStore, type TurnStatus } from "./sessionStore";
import {
  getTaskState,
  initTaskStore,
  useTaskStore,
  type AutopilotRuntime,
  type SessionGoal,
  type TaskTodo,
} from "./taskStore";

const EXPANDED_KEY = "reina.taskPanel.expanded";

const STR = {
  empty: "No tasks yet",
  goalEmpty: "No goal yet",
  paused: "Paused",
  running: (n: number) => `Auto-continuing · round ${n}`,
  pauseGoal: "Pause this goal",
  resumeGoal: "Resume this goal",
  editGoal: "Edit this goal",
  deleteGoal: "Delete this goal",
  state: {
    active: "In progress",
    paused: "Paused",
    blocked: "Blocked",
    complete: "Complete",
  } as Record<string, string>,
  done: {
    complete: "Goal completed",
    exhausted: "Stopped — no further progress",
    blocked: "Blocked",
    limit: "Budget limit reached",
    paused: "Stopped",
  } as Record<string, string>,
};

const GOAL_GLYPH: Record<string, string> = {
  paused: "⏸",
  blocked: "⚠",
  complete: "✓",
};

type PanelStatus = "working" | "waiting" | "paused" | "completed" | "blocked" | "failed" | "idle";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "true";
  } catch {
    return false;
  }
}

function formatGoalElapsed(createdAt: string): string {
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function runtimeStatusText(runtime: AutopilotRuntime): string {
  if (runtime.paused) return STR.paused;
  if (runtime.running) return STR.running(runtime.rounds ?? 0);
  if (runtime.doneStatus) return STR.done[runtime.doneStatus] ?? runtime.doneStatus;
  return "";
}

function panelStatus(
  turnStatus: TurnStatus,
  working: boolean,
  runtime: AutopilotRuntime | null,
  goal: ReturnType<typeof getTaskState>["goal"],
  todos: TaskTodo[],
): PanelStatus {
  if (turnStatus === "error") return "failed";
  if (turnStatus === "waiting approval" || turnStatus === "waiting answer") return "waiting";
  if (goal?.current) {
    if (goal.current.status === "blocked") return "blocked";
    if (goal.current.status === "complete") return "completed";
    if (goal.current.status === "paused") return "paused";
    if (working || goal.run || turnStatus === "stopping" || turnStatus === "compacting") return "working";
  } else {
    if (runtime?.doneStatus === "blocked" || runtime?.doneStatus === "limit") return "blocked";
    if (runtime?.doneStatus === "complete") return "completed";
    if (runtime?.paused) return "paused";
    if (working || runtime?.running || turnStatus === "stopping" || turnStatus === "compacting") return "working";
  }
  if (todos.length > 0 && todos.every((todo) => todo.status === "completed")) return "completed";
  return "idle";
}

function controlGoal(
  sessionId: string | null,
  stateRevision: number,
  goalId: string,
  action: "pause" | "resume" | "edit" | "clear",
  objective?: string,
): void {
  if (!sessionId) return;
  let command: Extract<UserGoalCommand, { type: "pause" | "resume" | "edit" | "clear" }>;
  if (action === "edit") {
    if (!objective) return;
    command = { type: "edit", goalId, objective, expectedRevision: stateRevision };
  } else {
    command = { type: action, goalId, expectedRevision: stateRevision };
  }
  void bridge().invoke("goal_command", { sessionId, command }).catch(() => undefined);
}

function ProgressMark({ status }: { status: TaskTodo["status"] }) {
  if (status === "completed") {
    return (
      <span className="task-progress-mark is-done">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") return <span className="task-progress-mark is-spinning" />;
  return <span className="task-progress-mark" />;
}

function ProgressBody() {
  const todos = useTaskStore((state) => state.todos);
  return (
    <>
      {todos.length === 0 ? <div className="task-progress-empty">{STR.empty}</div> : null}
      <ul className="task-progress-list">
        {todos.map((todo, index) => (
          <li className={`task-progress-item status-${todo.status}`} key={`${todo.content}-${index}`}>
            <ProgressMark status={todo.status} />
            <span className="task-progress-text">
              {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function GoalControl({ name, title, onClick }: { name: string; title: string; onClick: () => void }) {
  const variant = name === "trash-2" ? "delete" : name;
  return (
    <button
      type="button"
      className={`task-goal-control task-goal-control-${variant}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <svg className="icon"><use href={`#i-${name}`} /></svg>
    </button>
  );
}

function GoalEditInput({ goal, onCommit, onCancel }: { goal: SessionGoal; onCommit: (next: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(goal.objective.length, goal.objective.length);
  }, [goal.objective]);
  return (
    <input
      ref={inputRef}
      className="task-goal-edit-input"
      defaultValue={goal.objective}
      maxLength={4000}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const next = event.currentTarget.value.trim();
          if (next && next !== goal.objective) onCommit(next);
          else onCancel();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

function GoalItem({
  goal,
  stateRevision,
  sessionId,
  editing,
  startEdit,
  stopEdit,
  nowTick,
}: {
  goal: SessionGoal;
  stateRevision: number;
  sessionId: string | null;
  editing: boolean;
  startEdit: () => void;
  stopEdit: () => void;
  nowTick: number;
}) {
  void nowTick;
  const unresolved = goal.status !== "complete";
  const resumable = goal.status === "paused" || goal.status === "blocked";
  const title = goal.evidence ?? goal.terminalReason;
  return (
    <li className={`task-goal-item status-${goal.status}`} title={title}>
      {goal.status === "active" ? (
        <span className="task-goal-mark is-live" />
      ) : (
        <span className="task-goal-mark">{GOAL_GLYPH[goal.status] ?? "○"}</span>
      )}
      <div className="task-goal-main">
        {editing ? (
          <GoalEditInput
            goal={goal}
            onCommit={(next) => {
              stopEdit();
              controlGoal(sessionId, stateRevision, goal.id, "edit", next);
            }}
            onCancel={stopEdit}
          />
        ) : (
          <>
            <span className="task-goal-text">{goal.objective}</span>
            <span className="task-goal-meta">
              <span className="task-goal-state">{STR.state[goal.status] ?? goal.status}</span>
              {unresolved ? <> · <span>{formatGoalElapsed(goal.createdAt)}</span></> : null}
            </span>
          </>
        )}
      </div>
      <span className="task-goal-controls">
        {unresolved && !editing ? (
          <>
            <GoalControl name="edit" title={STR.editGoal} onClick={startEdit} />
            <GoalControl
              name={resumable ? "play" : "pause"}
              title={resumable ? STR.resumeGoal : STR.pauseGoal}
              onClick={() => controlGoal(sessionId, stateRevision, goal.id, resumable ? "resume" : "pause")}
            />
          </>
        ) : null}
        <GoalControl name="trash-2" title={STR.deleteGoal} onClick={() => controlGoal(sessionId, stateRevision, goal.id, "clear")} />
      </span>
    </li>
  );
}

function GoalBody({ sessionId, nowTick }: { sessionId: string | null; nowTick: number }) {
  const goalState = useTaskStore((state) => state.goal);
  const legacyRuntime = useTaskStore((state) => state.autopilot);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const current = goalState?.current ?? null;
  const goalRun = goalState?.run ?? null;
  const livePaused = current?.status === "paused";
  const statusText = goalState?.completionClaim
    ? "Verifying completion"
    : current?.status === "active" && goalRun
      ? STR.running(goalRun.rounds)
      : current?.status === "paused"
        ? STR.paused
        : current?.status === "blocked"
          ? STR.done.blocked
          : current?.status === "complete"
            ? STR.done.complete
            : legacyRuntime
              ? runtimeStatusText(legacyRuntime)
              : "";
  const live = current?.status === "active" && Boolean(goalRun);

  return (
    <>
      {statusText ? (
        <div
          className={`task-goal-status${live ? " is-live" : ""}${livePaused ? " is-paused" : ""}`}
          title={current?.terminalReason ?? legacyRuntime?.doneSummary ?? ""}
        >
          {statusText}
        </div>
      ) : null}
      <ul className="task-goal-list">
        {current ? (
          <GoalItem
            key={current.id}
            goal={current}
            stateRevision={goalState!.revision}
            sessionId={sessionId}
            editing={current.id === editingGoalId}
            startEdit={() => setEditingGoalId(current.id)}
            stopEdit={() => setEditingGoalId(null)}
            nowTick={nowTick}
          />
        ) : null}
      </ul>
      {!current && !statusText ? <div className="task-goal-empty">{STR.goalEmpty}</div> : null}
    </>
  );
}

export function TaskPane() {
  const sessionId = useMainStore((state) => state.sessionId);
  const working = useMainStore((state) => state.working);
  const turnStatus = useMainStore((state) => state.status);
  const goalState = useTaskStore((state) => state.goal);
  const todos = useTaskStore((state) => state.todos);
  const runtime = useTaskStore((state) => state.autopilot);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    initTaskStore();
    const timer = window.setInterval(() => {
      const state = getTaskState();
      if (state.goal?.current && state.goal.current.status !== "complete") {
        setNowTick((tick) => tick + 1);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const setPanelExpanded = (next: boolean) => {
    setExpanded(next);
    try { localStorage.setItem(EXPANDED_KEY, String(next)); } catch { /* ignore */ }
  };

  const primaryGoal = goalState?.current ?? null;
  const currentTodo = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending") ?? null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const status = panelStatus(turnStatus, working, runtime, goalState, todos);
  const title = primaryGoal?.objective ?? currentTodo?.content ?? (sessionId ? "No active task" : "Select a task");

  if (!primaryGoal && todos.length === 0 && !runtime) return null;

  if (!expanded) {
    return (
      <button
        type="button"
        className={`task-status-capsule is-${status}`}
        title="Expand task status"
        aria-label={`Expand task status: ${title}`}
        onClick={() => setPanelExpanded(true)}
      >
        <span className="task-status-capsule-icon" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l3 2" />
          </svg>
        </span>
        <span className="task-status-capsule-kind">Goal</span>
        <span className="task-status-capsule-title">{title}</span>
        {todos.length > 0 ? <span className="task-status-capsule-count">{completed}/{todos.length}</span> : null}
      </button>
    );
  }

  return (
    <section className={`task-status-panel is-${status}`} aria-label="Task progress">
      <header className="task-status-panel-header">
        <div className="task-status-panel-heading">
          <span>Task</span>
          {primaryGoal ? <span>{formatGoalElapsed(primaryGoal.createdAt)}</span> : null}
          <span className="task-status-panel-state" aria-label={status} />
        </div>
        <button
          type="button"
          className="task-status-panel-collapse"
          title="Collapse to status capsule"
          aria-label="Collapse to status capsule"
          onClick={() => setPanelExpanded(false)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
          </svg>
        </button>
      </header>

      <section className="task-status-section" aria-labelledby="task-status-goal-title">
        <div className="task-status-section-heading" id="task-status-goal-title">
          <span>Goal</span>
          {primaryGoal ? <span>1</span> : null}
        </div>
        <GoalBody sessionId={sessionId} nowTick={nowTick} />
      </section>

      <section className="task-status-section" aria-labelledby="task-status-progress-title">
        <div className="task-status-section-heading" id="task-status-progress-title">
          <span>Progress</span>
          {todos.length > 0 ? <span>{completed}/{todos.length}</span> : null}
        </div>
        <ProgressBody />
      </section>
    </section>
  );
}
