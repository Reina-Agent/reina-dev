// Agent Team workspace — keeps the legacy roster, timing and stop controls,
// while the selected task opens a Reina-native Chat / Activity / Result / Runtime
// detail view. The visual language intentionally matches Notes, Conversation
// and Files: compact toolbars, neutral surfaces and hairline dividers.
//
// ── Data flow (fixed) ─────────────────────────────────────────────────────────
// Unlike the legacy panel — which lives in the MAIN chat window and reads
// `state.lastSessionSnapshot.asyncTasks` directly — this tab runs in the
// SEPARATE workspace window. The roster + per-task activity are rebuilt from the
// engine stream, which the main process broadcasts to ALL windows on the "agent"
// channel. The team data arrives as a cold-load via `session_snapshot`
// (session.asyncTasks) plus NESTED model_stream sub-events
// `{ type: "model_stream", event: { type: "async-task-updated" | "subagent-event", … } }`.
// workspaceEngineStore owns the single "agent" subscription and the ported
// mergeAsyncTaskUpdate / applyEventToActivityBuffer reducers; this tab reads the
// asyncTasks roster + activity buffers as slices.
//
// Cold history for a task's activity still comes from disk via the bridge:
//   readSubagentActivity(cwd, taskId) -> { events: [{ timestamp, event }] }
// which this tab folds into the store's activity buffer on first view.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";
import { ResizeHandle } from "~/components/ResizeHandle";
import { useResizableSidebar } from "~/lib/useResizableSidebar";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
import {
  useWorkspaceEngine,
  getWorkspaceEngineState,
  hydrateTaskActivityFromDisk,
  type AsyncTask,
  type ActivityEntry,
  type ActivityKind,
} from "./workspaceEngineStore";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

// truncate (legacy format.truncate) — used for sidebar/detail text clamps.
function truncate(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ── Status glyph / label / order tables (legacy single source of truth) ──────

const STATUS_GLYPH: Record<string, string> = {
  running: "●",
  resuming: "↻",
  completed: "✓",
  failed: "✗",
  failed_unrecoverable: "✗",
  cancelled: "⊘",
  evicted: "⊘",
  orphaned: "!",
  recoverable: "↺",
  needs_attention: "!",
};

const STATUS_LABEL: Record<string, string> = {
  running: "running",
  resuming: "resuming",
  completed: "completed",
  failed: "failed",
  failed_unrecoverable: "unrecoverable",
  cancelled: "cancelled",
  evicted: "evicted",
  orphaned: "orphaned",
  recoverable: "recoverable",
  needs_attention: "needs attention",
};

// Sidebar sort order (legacy STATUS_ORDER): running first, terminal last.
const STATUS_ORDER: Record<string, number> = {
  running: 0,
  resuming: 1,
  recoverable: 2,
  needs_attention: 3,
  orphaned: 4,
  failed: 5,
  failed_unrecoverable: 6,
  cancelled: 7,
  completed: 8,
};

// Tailwind tint per status — used by chips, sidebar glyphs, detail header.
function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "failed":
    case "failed_unrecoverable":
      return "text-red-400";
    case "cancelled":
      return "text-muted-foreground";
    case "running":
    case "resuming":
      return "text-yellow-400";
    case "recoverable":
    case "needs_attention":
    case "orphaned":
      return "text-yellow-400";
    default:
      return "text-muted-foreground";
  }
}

function glyphFor(status: string): string {
  return STATUS_GLYPH[status] ?? "·";
}

function labelFor(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function isTaskRunning(status: string): boolean {
  return status === "running" || status === "resuming";
}

type SummaryStatus = "running" | "attention" | "completed" | "failed" | "cancelled";

function summaryStatus(status: string): SummaryStatus {
  if (status === "running" || status === "resuming") return "running";
  if (status === "needs_attention" || status === "recoverable" || status === "orphaned") return "attention";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "failed_unrecoverable") return "failed";
  if (status === "cancelled" || status === "evicted") return "cancelled";
  return "attention";
}

const SUMMARY_GLYPH: Record<SummaryStatus, string> = {
  running: "●",
  attention: "!",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
};

const SUMMARY_LABEL: Record<SummaryStatus, string> = {
  running: "running",
  attention: "attention",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function summaryColor(status: SummaryStatus): string {
  if (status === "completed") return "text-green-400";
  if (status === "failed") return "text-red-400";
  if (status === "running" || status === "attention") return "text-yellow-400";
  return "text-muted-foreground";
}

// ── Time formatting (legacy formatElapsed / formatStartedAt / formatClockTime) ─

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function elapsedOf(task: AsyncTask, now: number): string {
  const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const end = task.completedAt ? Date.parse(task.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  return formatMs(end - start);
}

function formatStartedAt(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatTokens(value: number | undefined): string {
  if (!Number.isFinite(value) || !value || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || !value || value <= 0) return "";
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${value} B`;
}

// Tool input summary (legacy toolInputSummary).
function toolInputSummary(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "multi_edit") {
    return truncate(String(i.path ?? ""), 60);
  }
  if (name === "run_shell") return truncate(String(i.command ?? ""), 80);
  if (name === "grep" || name === "code_search") return truncate(String(i.pattern ?? i.query ?? ""), 60);
  if (name === "glob") return truncate(String(i.pattern ?? ""), 60);
  return "";
}

// ── Component ────────────────────────────────────────────────────────────────

export function AgentTeamTab({ cwd, active, onOpenContext }: { cwd: string | null; active: boolean; onOpenContext?: (taskId: string) => void }) {
  // Roster + per-task activity buffers from the shared engine store (fed by the
  // broadcast "agent" stream + session snapshots — see workspaceEngineStore).
  const tasks = useWorkspaceEngine((s) => s.asyncTasks);
  const activity = useWorkspaceEngine((s) => s.activity);
  // sessionId (captured from the stream by the store) is needed to cancel a task.
  const sessionId = useWorkspaceEngine((s) => s.sessionId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drag-to-resize + collapse for the roster sidebar (persisted to localStorage).
  const sidebar = useResizableSidebar({
    storageKey: "reina.workspace.agentTeamSidebar",
    defaultWidth: 256,
    minWidth: 200,
    maxWidth: 460,
  });
  // 1 Hz tick drives elapsed timers on running rows + the open detail.
  const [now, setNow] = useState(() => Date.now());

  // Tasks we've already cold-loaded disk activity for (legacy hydrated Set).
  const hydratedRef = useRef<Set<string>>(new Set());
  const hydratingRef = useRef<Set<string>>(new Set());

  // ── Reset view-local state when the workspace changes. The roster + activity
  // are owned by the store (re-hydrated from the next session_snapshot). ──────
  useEffect(() => {
    setSelectedId(null);
    hydratedRef.current = new Set();
    hydratingRef.current = new Set();
  }, [cwd, sessionId]);

  // ── Cold replay: fold a task's persisted stream.jsonl into the store buffer
  // once per task (legacy hydrateActivityIfNeeded). Delegates the disk read +
  // reducer fold to the store so live + cold events share one buffer. ─────────
  const hydrateActivityIfNeeded = useCallback(
    async (taskId: string) => {
      if (!taskId || hydratedRef.current.has(taskId) || hydratingRef.current.has(taskId) || !cwd) return;
      hydratingRef.current.add(taskId);
      const hydrated = await hydrateTaskActivityFromDisk(cwd, taskId);
      hydratingRef.current.delete(taskId);
      if (hydrated) hydratedRef.current.add(taskId);
    },
    [cwd],
  );

  // ── 1 Hz elapsed ticker — sleeps when inactive or nothing is running. ─────
  const anyRunning = useMemo(() => tasks.some((task) => isTaskRunning(task.status)), [tasks]);
  useEffect(() => {
    if (!active || !anyRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, anyRunning]);

  // ── Selection: sticky, defaulting to first running then most recent. ──────
  const selected = useMemo<AsyncTask | null>(() => {
    if (selectedId) {
      const found = tasks.find((task) => task.id === selectedId);
      if (found) return found;
    }
    const running = tasks.find((task) => isTaskRunning(task.status));
    if (running) return running;
    const recent = [...tasks].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
    return recent ?? null;
  }, [tasks, selectedId]);

  // Cold-load the selected task's disk activity on first view (active only).
  useEffect(() => {
    if (active && selected) void hydrateActivityIfNeeded(selected.id);
  }, [active, selected, hydrateActivityIfNeeded]);

  // ── Cancel one / all running tasks (legacy cancelTask / cancelAllRunning). ─
  const cancelTask = useCallback(
    async (taskId: string) => {
      // Read the freshest bound session at click time, not just the captured
      // closure value: the closure can lag the store by a render during the
      // unbound→bound transition, which would make Stop silently no-op on a task
      // that has in fact just become cancellable.
      const sid = sessionId ?? getWorkspaceEngineState().sessionId;
      if (!sid) return;
      try {
        await bridge().invoke("cancel_async_task_external", { sessionId: sid, taskId });
      } catch {
        // Surface nothing in the workspace window; the roster will reflect state.
      }
    },
    [sessionId],
  );

  const cancelAllRunning = useCallback(async () => {
    for (const task of tasks.filter((t) => isTaskRunning(t.status))) {
      await cancelTask(task.id);
    }
  }, [tasks, cancelTask]);

  // ── Summary chip counts (legacy renderSummaryChips). ──────────────────────
  const counts = useMemo(() => {
    const c: Record<SummaryStatus, number> = { running: 0, attention: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of tasks) c[summaryStatus(task.status)] += 1;
    return c;
  }, [tasks]);

  // ── Sidebar order (legacy renderSidebar sort). ────────────────────────────
  const sortedTasks = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        if (order !== 0) return order;
        return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
      }),
    [tasks],
  );

  const selectedActivity = selected ? (activity.get(selected.id) ?? []) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ── sub-toolbar (mirrors WorkspaceApp git/notes sub-toolbars) ── */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
        <button
          type="button"
          title={sidebar.collapsed ? "Show task list" : "Hide task list"}
          aria-label={sidebar.collapsed ? "Show task list" : "Hide task list"}
          onClick={sidebar.toggleCollapsed}
          className={
            "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-fast) " +
            (sidebar.collapsed
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <SidebarIcon />
        </button>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
          Agent Team <span className="text-muted-foreground">{tasks.length}</span>
        </span>

        {/* summary chips */}
        {tasks.length > 0 && (
          <div className="hidden shrink-0 items-center gap-1 md:flex">
            {(["running", "attention", "completed", "failed", "cancelled"] as const).map((status) => {
              if (!counts[status]) return null;
              return (
                <span
                  key={status}
                  title={`${counts[status]} ${SUMMARY_LABEL[status]}`}
                  className={
                    "rounded-full bg-secondary/70 px-1.5 py-px text-[10px] font-medium " + summaryColor(status)
                  }
                >
                  {SUMMARY_GLYPH[status]} {counts[status]}
                </span>
              );
            })}
          </div>
        )}

        {/* stop-all (only while something is running) */}
        {counts.running > 0 && (
          <button
            type="button"
            onClick={() => void cancelAllRunning()}
            className="h-6 shrink-0 rounded-md border border-(--surface-divider) px-2 text-[11px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
          >
            Stop all
          </button>
        )}
      </div>

      {/* ── body: sidebar + detail ── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* roster sidebar */}
        {!sidebar.collapsed && (
          <>
            <div
              style={{ "--agent-roster-width": `${sidebar.width}px` } as CSSProperties}
              className="flex max-h-52 w-full shrink-0 flex-col overflow-hidden border-b border-(--surface-divider) bg-card md:max-h-none md:w-[var(--agent-roster-width)] md:border-r md:border-b-0"
            >
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {sortedTasks.length === 0 ? (
                  <div className="px-2 py-2 text-xs italic text-muted-foreground">No tasks</div>
                ) : (
                  sortedTasks.map((task) => (
                    <SidebarItem
                      key={task.id}
                      task={task}
                      elapsed={elapsedOf(task, now)}
                      activity={activity.get(task.id) ?? []}
                      active={task.id === selected?.id}
                      onSelect={() => setSelectedId(task.id)}
                    />
                  ))
                )}
              </div>
            </div>
            <div className="hidden shrink-0 md:flex">
              <ResizeHandle
                onPointerDown={sidebar.startResize}
                active={sidebar.resizing}
                ariaLabel="Resize task list"
              />
            </div>
          </>
        )}

        {/* detail pane */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {selected ? (
            <TaskDetail
              key={`${sessionId ?? "unbound"}:${selected.id}`}
              task={selected}
              cwd={cwd}
              sessionId={sessionId}
              elapsed={elapsedOf(selected, now)}
              activity={selectedActivity}
              onStop={() => void cancelTask(selected.id)}
              onOpenContext={onOpenContext ? () => onOpenContext(selected.id) : undefined}
            />
          ) : (
            <AgentTeamEmpty />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sidebar row (legacy renderSidebarItem) ───────────────────────────────────

function latestActivitySummary(activity: ActivityEntry[]): { kind: ActivityKind; text: string } | null {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index]!;
    if (entry.kind !== "tool" || entry.status !== "running") continue;
    const target = entry.command || toolInputSummary(entry.name, entry.input);
    return { kind: "tool", text: `${entry.name ?? "tool"}${target ? ` · ${target}` : ""}` };
  }
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index]!;
    if (entry.kind === "text" || entry.eventType === "usage-updated" || entry.eventType === "task-turn-started") continue;
    if (entry.kind === "tool") {
      const target = entry.command || toolInputSummary(entry.name, entry.input);
      return { kind: entry.kind, text: `${entry.name ?? "tool"}${target ? ` · ${target}` : ""}` };
    }
    const text = entry.text || entry.message || entry.name;
    if (text) return { kind: entry.kind, text };
  }
  return null;
}

function SidebarItem({
  task,
  elapsed,
  activity,
  active,
  onSelect,
}: {
  task: AsyncTask;
  elapsed: string;
  activity: ActivityEntry[];
  active: boolean;
  onSelect: () => void;
}) {
  const current = latestActivitySummary(activity);
  const title = task.name || task.agent;
  const summary = task.name ? `${task.agent} · ${task.description}` : task.description;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={task.description}
      className={
        "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-(--motion-fast) " +
        (active ? "bg-secondary text-foreground" : "hover:bg-secondary/60")
      }
    >
      <span className={"mt-px shrink-0 text-[12px] leading-4 " + statusColor(task.status)}>
        {glyphFor(task.status)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium text-foreground">
            {title}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{elapsed}</span>
        </span>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground">
          {truncate(summary, 80)}
        </span>
        {current && isTaskRunning(task.status) && (
          <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground/70">
            <KindIcon kind={current.kind} />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono">
              {truncate(current.text, 72)}
            </span>
          </span>
        )}
      </span>
    </button>
  );
}

// ── Detail workspace: compact Reina-native tabs + inspectable activity ───────

type DetailTab = "chat" | "activity" | "result" | "runtime";
type ActivityFilter = "all" | "important";

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "activity", label: "Activity" },
  { id: "result", label: "Result" },
  { id: "runtime", label: "Runtime" },
];

function TaskDetail({
  task,
  cwd,
  sessionId,
  elapsed,
  activity,
  onStop,
  onOpenContext,
}: {
  task: AsyncTask;
  cwd: string | null;
  sessionId: string | null;
  elapsed: string;
  activity: ActivityEntry[];
  onStop: () => void;
  onOpenContext?: () => void;
}) {
  const t = useT();
  const running = isTaskRunning(task.status);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<DetailTab>("chat");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [followTail, setFollowTail] = useState(true);
  const [briefOpen, setBriefOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setTab("chat");
    setActivityFilter("all");
    setFollowTail(true);
    setBriefOpen(false);
    setExpanded(new Set());
  }, [task.id]);

  const steps = useMemo(() => activity.filter((entry) => entry.kind !== "text"), [activity]);
  const liveText = useMemo(
    () => activity.filter((entry) => entry.kind === "text" && entry.text).at(-1)?.text ?? "",
    [activity],
  );
  const importantSteps = useMemo(() => steps.filter(isImportantActivity), [steps]);
  const visibleSteps = activityFilter === "important" ? importantSteps : steps;

  useEffect(() => {
    if (tab !== "activity" || !followTail) return;
    const el = activityRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, followTail, visibleSteps]);

  const onActivityScroll = useCallback(() => {
    const el = activityRef.current;
    if (!el || !followTail) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) setFollowTail(false);
  }, [followTail]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const usage = task.usage ?? task.runningUsage;
  const resultText = task.error ?? task.result ?? (running ? liveText : "");
  const isError = Boolean(task.error);
  const title = task.name || task.agent;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-(--surface-divider) bg-card/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-semibold text-foreground">
            {title}
            <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground/70">{task.id}</span>
          </h2>
          {onOpenContext && (
            <button
              type="button"
              onClick={onOpenContext}
                title={t("context.openSubagent")}
              className={`h-6 shrink-0 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground ${FOCUS_RING}`}
            >
                {t("context.title")}
            </button>
          )}
          {running && (
            <button
              type="button"
              onClick={onStop}
              className={`h-6 shrink-0 rounded-md border border-destructive/25 px-2 text-[11px] text-destructive transition-colors duration-(--motion-fast) hover:bg-destructive/8 ${FOCUS_RING}`}
            >
              Stop
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className={"font-medium " + statusColor(task.status)}>
            {glyphFor(task.status)} {labelFor(task.status)}
          </span>
          {task.name && <span>{task.agent}</span>}
          {task.subtaskId && <span className="font-mono">{task.subtaskId}</span>}
          {task.startedAt && <span>started {formatStartedAt(task.startedAt)}</span>}
          {elapsed && <span className="font-mono">{elapsed}</span>}
          {(task.attemptCount ?? 0) > 1 && <span>attempt {task.attemptCount}</span>}
          {usage && <span>{formatTokens(usage.inputTokens + usage.outputTokens)} tokens</span>}
          {task.isolation === "worktree" && task.worktreeBranch && (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={task.worktreePath ?? "Ran in an isolated git worktree"}
            >
              <BranchIcon /> <span className="max-w-56 truncate">{task.worktreeBranch}</span>
            </span>
          )}
        </div>
      </div>

      <div
        className="flex h-8 shrink-0 items-center gap-1 border-b border-(--surface-divider) bg-card/55 px-2"
        role="tablist"
        aria-label="Task detail"
      >
        {DETAIL_TABS.map((item) => {
          const selected = tab === item.id;
          const count = item.id === "activity" ? steps.length : undefined;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(item.id)}
              className={`flex h-[22px] items-center gap-1 rounded-md px-2 text-[11px] transition-colors duration-(--motion-fast) ${
                selected
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              } ${FOCUS_RING}`}
            >
              {item.label}
              {typeof count === "number" && count > 0 && (
                <span className="text-[10px] text-muted-foreground/70">{count}</span>
              )}
              {item.id === "activity" && running && (
                <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" aria-hidden />
              )}
            </button>
          );
        })}
      </div>

      <TaskChat task={task} cwd={cwd} sessionId={sessionId} activity={activity} active={tab === "chat"} />

      {tab === "activity" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="tabpanel">
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-(--surface-divider) bg-card/25 px-2">
            <FilterButton
              label="All"
              count={steps.length}
              active={activityFilter === "all"}
              onClick={() => setActivityFilter("all")}
            />
            <FilterButton
              label="Important"
              count={importantSteps.length}
              active={activityFilter === "important"}
              onClick={() => setActivityFilter("important")}
            />
            <span className="flex-1" />
            <button
              type="button"
              aria-pressed={followTail}
              onClick={() => setFollowTail((current) => !current)}
              className={`flex h-[22px] items-center gap-1.5 rounded-md px-2 text-[10.5px] transition-colors duration-(--motion-fast) ${
                followTail
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              } ${FOCUS_RING}`}
              title="Follow live activity"
            >
              <span
                className={"h-1.5 w-1.5 rounded-full " + (followTail ? "bg-yellow-400" : "bg-muted-foreground/40")}
                aria-hidden
              />
              Follow
            </button>
          </div>
          <div ref={activityRef} onScroll={onActivityScroll} className="min-h-0 flex-1 overflow-auto">
            {visibleSteps.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-muted-foreground">
                {running && <Spinner />}
                <span>
                  {running ? "Working…" : activityFilter === "important" ? "No important events." : "No activity."}
                </span>
              </div>
            ) : (
              visibleSteps.map((entry, index) => {
                const rowKey = entry.key ?? `${entry.eventType}-${entry.ts}`;
                return (
                  <ActivityRow
                    key={rowKey}
                    entry={entry}
                    expanded={expanded.has(rowKey)}
                    onToggle={() => toggleExpanded(rowKey)}
                  />
                );
              })
            )}
          </div>
        </div>
      )}

      {tab === "result" && (
        <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
          <div className="mx-auto max-w-[860px] px-4 py-5 md:px-6">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {isError ? "Error" : running && !task.result ? "Live draft" : "Result"}
            </div>
            {resultText ? (
              isError ? (
                <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-red-400">{resultText}</div>
              ) : (
                <WorkspaceMarkdown
                  source={resultText}
                  cwd={cwd ?? undefined}
                  className={running && !task.result ? "text-muted-foreground" : ""}
                />
              )
            ) : running ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Spinner />
                <span>The child has not started its final response yet.</span>
              </div>
            ) : (
              <div className="text-xs italic text-muted-foreground">No result.</div>
            )}
          </div>
          <Section label="Brief" open={briefOpen} onToggle={() => setBriefOpen((current) => !current)}>
            <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/85">
              {task.description}
            </div>
          </Section>
        </div>
      )}

      {tab === "runtime" && <RuntimeView task={task} activity={activity} elapsed={elapsed} />}
    </div>
  );
}

function canMessageTask(status: string): boolean {
  return ["running", "completed", "failed", "cancelled", "recoverable", "evicted"].includes(status);
}

function TaskChat({
  task,
  cwd,
  sessionId,
  activity,
  active,
}: {
  task: AsyncTask;
  cwd: string | null;
  sessionId: string | null;
  activity: ActivityEntry[];
  active: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followTailRef = useRef(true);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  const running = isTaskRunning(task.status);
  const title = task.name || task.agent;
  const available = Boolean(sessionId) && canMessageTask(task.status);
  const unavailable = !sessionId
    ? "Select a session to send a message."
    : `Messaging unavailable while ${labelFor(task.status)}.`;
  const entries = useMemo(
    () => activity.filter((entry) => entry.eventType !== "usage-updated" && entry.eventType !== "task-turn-started"),
    [activity],
  );
  const fallbackResult = useMemo(() => {
    if (running || !task.result) return "";
    let turnStart = activity.length - 1;
    while (turnStart >= 0 && activity[turnStart]?.eventType !== "task-turn-started") turnStart -= 1;
    const texts = activity.slice(turnStart + 1).filter((entry) => entry.kind === "text");
    const result = task.result.trim();
    return texts.at(-1)?.text?.trim() === result ||
      texts
        .map((entry) => entry.text ?? "")
        .join("")
        .trim() === result
      ? ""
      : task.result;
  }, [activity, running, task.result]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const element = scrollRef.current;
    if (element && followTailRef.current) element.scrollTop = element.scrollHeight;
  }, [active, activity, task.result, task.error, running]);

  useEffect(() => {
    if (!active) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 144 ? "auto" : "hidden";
  }, [active, draft]);

  const submit = async () => {
    const message = draft.trim();
    if (!message || !sessionId || !available || sendingRef.current) return;
    const current = getWorkspaceEngineState();
    if (
      current.sessionId !== sessionId ||
      !current.asyncTasks.some((item) => item.id === task.id && canMessageTask(item.status))
    ) {
      setError("This task has changed. Select it again before sending.");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await bridge().invoke("update_async_task_external", { sessionId, taskId: task.id, message });
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(String(result.error));
      }
      if (mountedRef.current) {
        setDraft((currentDraft) => (currentDraft === draft ? "" : currentDraft));
        followTailRef.current = true;
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  };

  return (
    <div
      className={active ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" : "hidden"}
      role="tabpanel"
      aria-label="Chat"
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6"
        onScroll={() => {
          const element = scrollRef.current;
          if (element) followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
          <ChatMessage sender="Main agent" text={task.description} timestamp={task.startedAt} />
          {entries.map((entry) => {
            const key = entry.key ?? `${entry.eventType}-${entry.ts}`;
            if (entry.kind === "message") {
              return (
                <ChatMessage
                  key={key}
                  sender={entry.sender === "user" ? "You" : "Main agent"}
                  text={entry.text || entry.message || ""}
                  timestamp={entry.ts}
                />
              );
            }
            if (entry.kind === "text") {
              return (
                <ChatMessage
                  key={key}
                  sender={title}
                  text={entry.text ?? ""}
                  timestamp={entry.ts}
                  assistant
                  cwd={cwd}
                />
              );
            }
            return (
              <div key={key} className="overflow-hidden rounded-lg border border-(--surface-divider) bg-card/40">
                <ActivityRow
                  entry={entry}
                  expanded={expanded.has(key)}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
              </div>
            );
          })}
          {fallbackResult && (
            <ChatMessage sender={title} text={fallbackResult} timestamp={task.completedAt} assistant cwd={cwd} />
          )}
          {task.error && (
            <div className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {task.error}
            </div>
          )}
          {running && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground" role="status">
              <Spinner /> <span>{title} is working…</span>
            </div>
          )}
        </div>
      </div>

      <form
        className="shrink-0 px-4 pb-4 md:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mx-auto w-full max-w-[860px]">
          {error && (
            <div
              className="mb-2 break-words rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
              role="alert"
            >
              {error}
            </div>
          )}
          <div
            className="rounded-2xl border border-(--surface-divider) bg-[var(--composer-bg,var(--card))] px-3.5 pb-2.5 pt-3 transition-colors focus-within:bg-[var(--composer-bg-focus,var(--card))]"
            onMouseDown={(event) => {
              if ((event.target as Element).closest("button, textarea")) return;
              event.preventDefault();
              textareaRef.current?.focus();
            }}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              disabled={!available}
              readOnly={sending}
              aria-label={`Message ${title}`}
              placeholder={available ? `Message ${title}…` : unavailable}
              className="max-h-36 min-h-6 w-full min-w-0 resize-none overflow-x-hidden bg-transparent p-0 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="mt-1.5 flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
                {!available
                  ? unavailable
                  : running
                    ? "New instructions will update this running task."
                    : "Send a follow-up to continue this task."}
              </span>
              <button
                type="submit"
                disabled={!available || !draft.trim() || sending}
                aria-label="Send message"
                title="Send message (Enter)"
                onMouseDown={(event) => event.preventDefault()}
                className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-secondary disabled:text-muted-foreground ${FOCUS_RING}`}
              >
                {sending ? (
                  <Spinner />
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function ChatMessage({
  sender,
  text,
  timestamp,
  assistant = false,
  cwd,
}: {
  sender: string;
  text: string;
  timestamp?: string;
  assistant?: boolean;
  cwd?: string | null;
}) {
  return (
    <div className={assistant ? "min-w-0" : "flex min-w-0 flex-col items-end"}>
      <div className="mb-1.5 flex max-w-full items-center gap-2 text-[10.5px] text-muted-foreground">
        <span className="truncate font-medium">{sender}</span>
        {timestamp && <span className="shrink-0 text-muted-foreground/60">{formatStartedAt(timestamp)}</span>}
      </div>
      {assistant ? (
        <WorkspaceMarkdown source={text} cwd={cwd ?? undefined} className="min-w-0 text-[13px]" />
      ) : (
        <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-secondary px-3.5 py-2.5 text-[13px] leading-5 text-foreground sm:max-w-[90%]">
          {text}
        </div>
      )}
    </div>
  );
}

function FilterButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[20px] items-center gap-1 rounded-md px-2 text-[10.5px] transition-colors duration-(--motion-fast) ${
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      } ${FOCUS_RING}`}
    >
      {label} <span className="text-[10px] text-muted-foreground/60">{count}</span>
    </button>
  );
}

function isImportantActivity(entry: ActivityEntry): boolean {
  if (entry.kind === "warning" || entry.kind === "wait" || entry.kind === "message") return true;
  if (entry.kind === "tool") return entry.status === "running" || entry.status === "failed";
  return entry.eventType === "stream-reset" || entry.eventType === "context-compaction-failed";
}

function ActivityRow({ entry, expanded, onToggle }: { entry: ActivityEntry; expanded: boolean; onToggle: () => void }) {
  const title = activityTitle(entry);
  const summary = activitySummary(entry);
  const expandable = hasActivityDetails(entry);
  const at = formatStartedAt(entry.ts);
  const content = (
    <>
      <span className={"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center " + activityIconColor(entry)}>
        <KindIcon kind={entry.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {expandable && <Chevron open={expanded} />}
          {entry.kind === "tool" && <StatusDot status={entry.status} />}
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{title}</span>
          {entry.kind === "tool" && entry.elapsedMs !== undefined && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {formatActivityDuration(entry.elapsedMs)}
            </span>
          )}
        </span>
        {summary && (
          <span
            className={
              "mt-0.5 block min-w-0 truncate text-[11px] " +
              (entry.kind === "warning" || (entry.kind === "wait" && isPendingWait(entry))
                ? "text-yellow-400"
                : "text-muted-foreground")
            }
          >
            {summary}
          </span>
        )}
      </span>
      {at && <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/50">{at}</span>}
    </>
  );

  return (
    <div className="border-b border-(--surface-divider) px-3 py-2 last:border-b-0">
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={`flex w-full items-start gap-2 text-left ${FOCUS_RING}`}
        >
          {content}
        </button>
      ) : (
        <div className="flex items-start gap-2">{content}</div>
      )}
      {expanded && <ActivityDetails entry={entry} />}
    </div>
  );
}

function activityTitle(entry: ActivityEntry): string {
  if (entry.kind === "tool") return entry.name ?? "tool";
  if (entry.kind === "reasoning") return "Reasoning";
  return entry.name ?? entry.eventType;
}

function activitySummary(entry: ActivityEntry): string {
  if (entry.kind === "tool") {
    const target = entry.command || toolInputSummary(entry.name, entry.input);
    const stats = [
      entry.status,
      entry.totalLines ? `${entry.totalLines} lines` : "",
      formatBytes(entry.totalBytes),
    ].filter(Boolean);
    return [target, stats.join(" · ")].filter(Boolean).join(" · ");
  }
  if (entry.eventType === "usage-updated") return usageSummary(entry.payload);
  return truncate(entry.text || entry.message || "", 180);
}

function activityIconColor(entry: ActivityEntry): string {
  if (entry.kind === "warning" || (entry.kind === "wait" && isPendingWait(entry))) return "text-yellow-400";
  if (entry.kind === "message") return "text-muted-foreground/70";
  if (entry.kind === "tool" && entry.status === "failed") return "text-red-400";
  return "text-muted-foreground/70";
}

function isPendingWait(entry: ActivityEntry): boolean {
  return entry.status === "pending" || entry.status === "pending_approval";
}

function hasActivityDetails(entry: ActivityEntry): boolean {
  if (entry.kind === "tool") return Boolean(entry.input ?? entry.command ?? entry.output ?? entry.message);
  if (entry.kind === "reasoning") return Boolean(entry.text);
  return Boolean(entry.input || entry.payload || (entry.text?.length ?? 0) > 180);
}

function ActivityDetails({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === "tool") {
    const input = entry.command || printable(entry.input);
    const output = entry.output || entry.message;
    return (
      <div className="mt-2 grid overflow-hidden rounded-md border border-(--surface-divider) bg-(--surface-divider) lg:grid-cols-2">
        <DetailBlock label="Input" value={input} />
        <DetailBlock
          label={entry.status === "failed" ? "Error" : "Output"}
          value={output}
          error={entry.status === "failed"}
        />
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-(--surface-divider) bg-card/70 px-2.5 py-2">
      {entry.text && (
        <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted-foreground">{entry.text}</div>
      )}
      {entry.input !== undefined && <DetailBlock label="Input" value={printable(entry.input)} />}
      {entry.payload && <DetailBlock label="Event" value={printable(entry.payload)} />}
    </div>
  );
}

function DetailBlock({ label, value, error = false }: { label: string; value?: string; error?: boolean }) {
  const shown = value ? compactDetailText(value) : "";
  return (
    <div className="min-w-0 bg-card px-2.5 py-2">
      <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">{label}</div>
      {shown ? (
        <pre
          className={
            "max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed " +
            (error ? "text-red-400" : "text-foreground/85")
          }
        >
          {shown}
        </pre>
      ) : (
        <div className="text-[10.5px] italic text-muted-foreground/60">No {label.toLowerCase()}.</div>
      )}
    </div>
  );
}

function compactDetailText(value: string): string {
  const limit = 40_000;
  if (value.length <= limit) return value;
  const edge = Math.floor((limit - 34) / 2);
  return `${value.slice(0, edge)}\n\n… output clipped in this view …\n\n${value.slice(-edge)}`;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function usageSummary(usage: Record<string, unknown> | undefined): string {
  const input = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
  const cached = typeof usage?.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
  return `${formatTokens(input + output)} tokens${cached ? ` · ${formatTokens(cached)} cached` : ""}`;
}

function formatActivityDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return formatMs(ms);
}

function StatusDot({ status }: { status?: string }) {
  const color =
    status === "completed"
      ? "bg-green-400"
      : status === "failed"
        ? "bg-red-400"
        : status === "running"
          ? "bg-yellow-400"
          : "bg-foreground/30";
  return <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + color} aria-hidden />;
}

function RuntimeView({ task, activity, elapsed }: { task: AsyncTask; activity: ActivityEntry[]; elapsed: string }) {
  const usage = task.usage ?? task.runningUsage;
  const turns = task.turns ?? task.runningUsage?.turns;
  const toolCalls = task.toolCalls ?? activity.filter((entry) => entry.kind === "tool").length;
  const dispatch = [
    task.sync ? "sync" : "async",
    task.background ? "background" : "",
    task.fork ? "fork" : "",
    task.isolation,
  ]
    .filter(Boolean)
    .join(" · ");
  const cacheRate = usage?.inputTokens ? `${Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)}%` : "—";

  return (
    <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
      <RuntimeGroup label="Progress">
        <RuntimeRow label="Elapsed" value={elapsed || "—"} mono />
        <RuntimeRow label="Turns" value={turns ?? "—"} />
        <RuntimeRow label="Tool calls" value={toolCalls} />
        <RuntimeRow label="Attempts" value={task.attemptCount ?? 1} />
        {(task.resumeCount ?? 0) > 0 && <RuntimeRow label="Resumes" value={task.resumeCount} />}
        {task.lastHeartbeatAt && (
          <RuntimeRow label="Last heartbeat" value={formatStartedAt(task.lastHeartbeatAt)} mono />
        )}
      </RuntimeGroup>
      <RuntimeGroup label="Usage">
        <RuntimeRow label="Input" value={usage ? formatTokens(usage.inputTokens) : "—"} mono />
        <RuntimeRow label="Output" value={usage ? formatTokens(usage.outputTokens) : "—"} mono />
        <RuntimeRow label="Cached input" value={usage ? formatTokens(usage.cachedInputTokens) : "—"} mono />
        <RuntimeRow label="Cache hit" value={cacheRate} mono />
        <RuntimeRow label="Reasoning" value={usage ? formatTokens(usage.reasoningTokens) : "—"} mono />
      </RuntimeGroup>
      <RuntimeGroup label="Dispatch">
        <RuntimeRow label="Mode" value={dispatch} />
        {task.childSessionId && <RuntimeRow label="Child session" value={task.childSessionId} mono />}
        {task.subtaskId && <RuntimeRow label="Subtask" value={task.subtaskId} mono />}
        {task.batchId && <RuntimeRow label="Batch" value={task.batchId} mono />}
        {task.forkContextLost && <RuntimeRow label="Fork context" value="lost on resume" warning />}
      </RuntimeGroup>
      {(task.worktreePath || task.worktreeBranch) && (
        <RuntimeGroup label="Worktree">
          {task.worktreeBranch && <RuntimeRow label="Branch" value={task.worktreeBranch} mono />}
          {task.worktreePath && <RuntimeRow label="Path" value={task.worktreePath} mono />}
        </RuntimeGroup>
      )}
      {task.recovery && (
        <RuntimeGroup label="Recovery">
          <RuntimeRow label="Status" value={task.recovery.status} warning={task.recovery.status !== "resuming"} />
          <RuntimeRow label="Reason" value={task.recovery.reason} />
          <RuntimeRow label="Checked" value={formatStartedAt(task.recovery.checkedAt)} mono />
        </RuntimeGroup>
      )}
    </div>
  );
}

function RuntimeGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="border-b border-(--surface-divider)">
      <div className="bg-card/30 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <dl className="divide-y divide-(--surface-divider)">{children}</dl>
    </section>
  );
}

function RuntimeRow({
  label,
  value,
  mono = false,
  warning = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  warning?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(110px,0.32fr)_minmax(0,1fr)] gap-3 px-4 py-2 text-[11.5px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          "min-w-0 break-words " +
          (warning ? "text-yellow-400" : "text-foreground/85") +
          (mono ? " font-mono text-[11px]" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Section({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-(--surface-divider)">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center gap-1.5 px-4 py-2 text-left transition-colors duration-(--motion-fast) hover:bg-secondary/40 ${FOCUS_RING}`}
      >
        <Chevron open={open} />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10px] font-medium text-muted-foreground/50">· {count}</span>
        )}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

// ── Activity kind glyphs (replace the legacy emoji set with stroke icons) ─────

function KindIcon({ kind }: { kind: ActivityKind }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "tool") {
    return (
      <svg {...common}>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2.4-.6-.6-2.4 2.3-2.3z" />
      </svg>
    );
  }
  if (kind === "reasoning") {
    return (
      <svg {...common}>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      </svg>
    );
  }
  if (kind === "warning") {
    return (
      <svg {...common}>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }
  if (kind === "wait") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (kind === "system") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={
        "shrink-0 text-muted-foreground/70 transition-transform duration-(--motion-fast) " + (open ? "rotate-90" : "")
      }
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
      className="animate-spin text-yellow-400"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5a6 6 0 0 1-6 6H8.5" />
    </svg>
  );
}

// ── Empty state (legacy renderHost(null) — "Agent Team" placeholder) ─────────

function AgentTeamEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <TeamIcon />
      <div>
        <p className="font-medium text-foreground/70">No agent tasks yet.</p>
        <p className="mx-auto mt-1 max-w-sm text-xs">
          When you dispatch async subagents, they appear here. Pick one to follow its conversation, send new instructions,
          or stop it.
        </p>
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function SidebarIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-muted-foreground/40"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}
