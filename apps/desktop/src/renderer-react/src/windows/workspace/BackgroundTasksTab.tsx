import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";

type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed" | "lost";

type BackgroundTask = {
  id: string;
  command: string;
  workdir: string;
  workspaceRoot: string;
  startedAt: string;
  endedAt?: string;
  background: "requested" | "auto" | "timed";
  status: BackgroundTaskStatus;
  pty: boolean;
  exitCode?: number;
  error?: string;
  outputBytes: number;
  outputTruncated: boolean;
};

type TaskSnapshot = {
  task: BackgroundTask;
  output: string;
  truncated: boolean;
};

const STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  killed: "Stopped",
  lost: "Lost",
};

const STATUS_CLASSES: Record<BackgroundTaskStatus, string> = {
  running: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  completed: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
  failed: "bg-destructive/10 text-destructive",
  killed: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  lost: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
};

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
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
      className={spinning ? "animate-spin" : undefined}
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function TasksEmptyIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 2 2 3-3M14 10h3M7 15h10" />
    </svg>
  );
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeWorkdir(task: BackgroundTask): string {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "");
  const root = normalize(task.workspaceRoot);
  const workdir = normalize(task.workdir);
  if (workdir.toLowerCase() === root.toLowerCase()) return ".";
  if (workdir.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return workdir.slice(root.length + 1);
  }
  return task.workdir;
}

function preferredTaskId(tasks: BackgroundTask[]): string | null {
  return tasks.find((task) => task.status === "running")?.id ?? tasks[0]?.id ?? null;
}

export function BackgroundTasksTab({ cwd, active }: { cwd: string | null; active: boolean }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [filter, setFilter] = useState<"all" | "running">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef(0);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutputRef = useRef(true);

  const loadTasks = useCallback(
    async (quiet: boolean) => {
      if (!cwd || !active) return;
      const scope = scopeRef.current;
      const request = ++listRequestRef.current;
      if (!quiet) setRefreshing(true);
      try {
        const result = (await bridge().invoke("list_background_shell_tasks", { cwd })) as {
          tasks?: BackgroundTask[];
        };
        if (scope !== scopeRef.current || request !== listRequestRef.current) return;
        const nextTasks = Array.isArray(result.tasks) ? result.tasks : [];
        setTasks(nextTasks);
        const current = selectedIdRef.current;
        const next = current && nextTasks.some((task) => task.id === current) ? current : preferredTaskId(nextTasks);
        selectedIdRef.current = next;
        setSelectedId(next);
        if (!next) setSnapshot(null);
        setError(null);
      } catch (cause) {
        if (scope !== scopeRef.current || request !== listRequestRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!quiet && scope === scopeRef.current && request === listRequestRef.current) setRefreshing(false);
        if (scope === scopeRef.current && request === listRequestRef.current) setLoading(false);
      }
    },
    [active, cwd],
  );

  const loadSnapshot = useCallback(
    async (taskId: string, quiet: boolean) => {
      if (!cwd || !active) return;
      const scope = scopeRef.current;
      const request = ++detailRequestRef.current;
      try {
        const result = (await bridge().invoke("get_background_shell_task_output", { cwd, taskId })) as TaskSnapshot;
        if (scope !== scopeRef.current || request !== detailRequestRef.current || selectedIdRef.current !== taskId)
          return;
        setSnapshot(result);
        if (!quiet) setError(null);
      } catch (cause) {
        if (scope !== scopeRef.current || request !== detailRequestRef.current || selectedIdRef.current !== taskId)
          return;
        if (!quiet) setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [active, cwd],
  );

  const refreshAll = useCallback(
    async (quiet: boolean) => {
      const taskId = selectedIdRef.current;
      await Promise.all([loadTasks(quiet), taskId ? loadSnapshot(taskId, quiet) : Promise.resolve()]);
    },
    [loadSnapshot, loadTasks],
  );

  useEffect(() => {
    scopeRef.current += 1;
    selectedIdRef.current = null;
    setTasks([]);
    setSelectedId(null);
    setSnapshot(null);
    setError(null);
    setLoading(Boolean(cwd && active));
    if (!cwd || !active) return;

    void refreshAll(false);
    const interval = window.setInterval(() => void refreshAll(true), 1500);
    return () => {
      window.clearInterval(interval);
      scopeRef.current += 1;
    };
  }, [active, cwd, refreshAll]);

  useEffect(() => {
    if (!selectedId) return;
    selectedIdRef.current = selectedId;
    followOutputRef.current = true;
    void loadSnapshot(selectedId, false);
  }, [loadSnapshot, selectedId]);

  useEffect(() => {
    const candidates = filter === "running" ? tasks.filter((task) => task.status === "running") : tasks;
    if (candidates.some((task) => task.id === selectedIdRef.current)) return;
    const next = preferredTaskId(candidates);
    selectedIdRef.current = next;
    setSelectedId(next);
    if (!next) setSnapshot(null);
  }, [filter, tasks]);

  useEffect(() => {
    if (!followOutputRef.current || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [snapshot?.output]);

  const visibleTasks = useMemo(
    () => (filter === "running" ? tasks.filter((task) => task.status === "running") : tasks),
    [filter, tasks],
  );
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const selectedSnapshot = snapshot?.task.id === selectedId ? snapshot : null;
  const selectedTask = selectedSnapshot?.task ?? tasks.find((task) => task.id === selectedId) ?? null;

  const selectTask = (taskId: string): void => {
    selectedIdRef.current = taskId;
    setSelectedId(taskId);
  };

  const stopTask = async (): Promise<void> => {
    if (!cwd || !selectedTask || selectedTask.status !== "running" || stopping) return;
    if (!window.confirm(`Stop background task ${selectedTask.id}?\n\n${selectedTask.command}`)) return;
    setStopping(true);
    setError(null);
    try {
      await bridge().invoke("stop_background_shell_task", { cwd, taskId: selectedTask.id });
      await refreshAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">
        Open a workspace to view background tasks.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
        <span className="mr-1 text-[12px] font-medium text-foreground/85">Background tasks</span>
        {(["all", "running"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={
              "h-[22px] rounded-md px-2 text-[11px] transition-colors " +
              (filter === value
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
            }
          >
            {value === "all" ? `All ${tasks.length}` : `Running ${runningCount}`}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          title="Refresh background tasks"
          aria-label="Refresh background tasks"
          onClick={() => void refreshAll(false)}
          disabled={refreshing}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
        >
          <RefreshIcon spinning={refreshing} />
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/20 bg-destructive/8 px-3 py-1.5 text-[11px] text-destructive"
        >
          {error}
        </div>
      )}

      {!loading && visibleTasks.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <TasksEmptyIcon />
          <div className="text-[12px] font-medium text-foreground/70">
            {filter === "running" ? "No running tasks" : "No background tasks yet"}
          </div>
          <div className="max-w-64 text-[11px] leading-relaxed">
            {filter === "running"
              ? "Completed and stopped tasks remain available under All."
              : "Agent shell commands started in the background will appear here."}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          <aside className="flex max-h-52 min-h-0 shrink-0 flex-col overflow-hidden border-b border-(--surface-divider) md:max-h-none md:w-72 md:border-b-0 md:border-r">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {loading ? (
                <div className="space-y-1.5 p-1" aria-label="Loading background tasks">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="h-16 animate-pulse rounded-lg bg-secondary/50" />
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {visibleTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => selectTask(task.id)}
                      className={
                        "w-full rounded-lg border px-2.5 py-2 text-left transition-colors " +
                        (selectedId === task.id
                          ? "border-foreground/12 bg-secondary/80"
                          : "border-transparent hover:bg-secondary/45")
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${task.status === "running" ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40"}`}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground/85">
                          {task.id}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${STATUS_CLASSES[task.status]}`}
                        >
                          {STATUS_LABELS[task.status]}
                        </span>
                      </div>
                      <div className="mt-1.5 line-clamp-2 break-all font-mono text-[11px] leading-[1.45] text-foreground/75">
                        {task.command}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="min-w-0 flex-1 truncate">{relativeWorkdir(task)}</span>
                        <span className="shrink-0">{formatDuration(task.startedAt, task.endedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!selectedTask ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                <TasksEmptyIcon />
                <span className="text-[12px]">Select a task to inspect its output.</span>
              </div>
            ) : (
              <>
                <div className="shrink-0 border-b border-(--surface-divider) bg-card/25 px-3 py-2.5">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold text-foreground">{selectedTask.id}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[selectedTask.status]}`}
                        >
                          {STATUS_LABELS[selectedTask.status]}
                        </span>
                        {selectedTask.pty && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            PTY
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 break-all font-mono text-[12px] leading-relaxed text-foreground/85">
                        {selectedTask.command}
                      </div>
                    </div>
                    {selectedTask.status === "running" && (
                      <button
                        type="button"
                        onClick={() => void stopTask()}
                        disabled={stopping}
                        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-destructive/25 px-2.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/8 disabled:opacity-50"
                      >
                        <StopIcon />
                        {stopping ? "Stopping…" : "Stop"}
                      </button>
                    )}
                  </div>

                  <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-4">
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Working directory</dt>
                      <dd className="truncate text-foreground/75" title={selectedTask.workdir}>
                        {relativeWorkdir(selectedTask)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Started</dt>
                      <dd className="text-foreground/75">{formatStartedAt(selectedTask.startedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Duration</dt>
                      <dd className="text-foreground/75">
                        {formatDuration(selectedTask.startedAt, selectedTask.endedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Result</dt>
                      <dd className="text-foreground/75">
                        {selectedTask.exitCode === undefined
                          ? formatBytes(selectedTask.outputBytes)
                          : `Exit ${selectedTask.exitCode} · ${formatBytes(selectedTask.outputBytes)}`}
                      </dd>
                    </div>
                  </dl>
                  {selectedTask.error && (
                    <div className="mt-2 rounded-md bg-destructive/8 px-2 py-1.5 text-[10px] text-destructive">
                      {selectedTask.error}
                    </div>
                  )}
                </div>

                <div className="flex h-7 shrink-0 items-center border-b border-(--surface-divider) bg-card/40 px-3">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Output</span>
                  <div className="flex-1" />
                  {selectedSnapshot?.truncated && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">Output truncated</span>
                  )}
                </div>
                <pre
                  ref={outputRef}
                  onScroll={(event) => {
                    const target = event.currentTarget;
                    followOutputRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 36;
                  }}
                  className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#0c0e12] p-3 font-mono text-[11px] leading-[1.55] text-[#d7dbe3] selection:bg-sky-500/30"
                >
                  {selectedSnapshot?.output || "No output yet."}
                </pre>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
