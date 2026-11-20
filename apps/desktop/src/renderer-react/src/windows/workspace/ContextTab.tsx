import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextHistory, ContextRequestDetail, ContextRequestRecord } from "@reina/protocol";
import { bridge } from "~/lib/bridge";
import { useT, type TFunc } from "~/lib/i18n";
import { contextInputMetrics } from "~/lib/contextUsage";
import { useWorkspaceEngine } from "./workspaceEngineStore";
import { contextCategories, formatContextTokens, isContextHistoryEvent } from "./contextHistory";
import { ContextTrend } from "./ContextTrend";
import { ContextBrowser } from "./ContextBrowser";
import { ContextFileActivity } from "./ContextFileActivity";
import { ContextStatistics, ContextEvents, ContextAgents } from "./ContextOverview";
import "./context.css";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";
const BUTTON = `rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:opacity-40 ${FOCUS_RING}`;

interface ContextTabProps {
  cwd: string | null;
  sessionId: string | null;
  active: boolean;
  initialTaskId?: string | null;
  selectionKey?: number;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : value;
}

function statusLabel(status: string, t: TFunc): string {
  const key = `context.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localizedError(message: string, t: TFunc): string {
  if (/not a function|No handler registered|Unknown command|unknown command/.test(message)) return t("context.restartRequired");
  return t("context.loadFailed", { error: message || t("context.unknownError") });
}

function RequestComposition({ request }: { request: ContextRequestRecord }) {
  const t = useT();
  const entries = contextCategories(request.breakdown, t);
  const metrics = contextInputMetrics(request.breakdown, request.usage);
  const windowTokens = request.breakdown.categories?.contextWindow;
  const threshold = request.breakdown.categories?.autocompactThreshold;
  const hasWindow = typeof windowTokens === "number" && windowTokens > 0;
  const categoryTotal = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const occupied = hasWindow ? Math.min(100, metrics.input / windowTokens * 100) : 100;
  const free = hasWindow ? Math.max(0, windowTokens - metrics.input) : undefined;

  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <div className="text-[11px] text-muted-foreground">{t(request.status === "preview" ? "context.liveInput" : metrics.source === "provider" ? "context.requestContext" : "context.requestContextEstimate")}</div>
        <div className="mt-0.5 text-2xl font-medium tabular-nums">
          {metrics.source === "estimate" && <span className="text-muted-foreground">≈</span>}{formatContextTokens(metrics.input)}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("context.tokens")}{hasWindow ? ` / ${formatContextTokens(windowTokens)}` : ""}</span>
        </div>
      </div>
      <div className="text-right text-[11px] leading-5 text-muted-foreground">
        {hasWindow && <div className="font-medium text-foreground">{t("context.windowPercent", { percent: (metrics.input / windowTokens * 100).toFixed(1) })}</div>}
        {metrics.output !== undefined && <div>{t("usage.output")} <span className="tabular-nums">{formatContextTokens(metrics.output)}</span></div>}
        {request.usage?.cachedInputTokens !== undefined && <div>{t("context.cachedInput", { count: formatContextTokens(request.usage.cachedInputTokens) })}</div>}
      </div>
    </div>
    <div className="relative h-4 overflow-hidden rounded-md bg-secondary/50" role="img" aria-label={t("context.occupancyAria", { used: metrics.input.toLocaleString(), free: free?.toLocaleString() ?? "—" })}>
      <div className="flex h-full" style={{ width: `${occupied}%` }}>
        {entries.map((entry) => <span key={entry.id} style={{ background: entry.color, width: `${categoryTotal ? entry.tokens / categoryTotal * 100 : 0}%` }} title={t("context.categoryTokenLabel", { label: entry.label, count: entry.tokens.toLocaleString() })} />)}
      </div>
      {hasWindow && <span className="context-free absolute inset-y-0 right-0" style={{ width: `${100 - occupied}%` }} />}
      {hasWindow && typeof threshold === "number" && threshold > 0 && threshold < windowTokens && <span className="absolute inset-y-0 border-l border-dashed border-foreground/60" style={{ left: `${threshold / windowTokens * 100}%` }} title={t("context.compactionAt", { threshold: formatContextTokens(threshold) })} />}
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-x-3 gap-y-1.5 text-[11px]">
      {entries.map((entry) => <div key={entry.id} className="flex min-w-0 items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: entry.color }} />
        <span className="truncate text-muted-foreground">{entry.label}</span>
        <span className="ml-auto tabular-nums" title={t("context.estimatedTokenCount", { count: entry.tokens.toLocaleString() })}>≈{formatContextTokens(entry.tokens)}</span>
      </div>)}
      {free !== undefined && <div className="flex items-center gap-2 text-muted-foreground"><span className="context-free size-2 rounded-sm border" /><span>{t("context.free")}</span><span className="ml-auto tabular-nums">{formatContextTokens(free)}</span></div>}
    </div>
    <p className="text-[10px] leading-relaxed text-muted-foreground" title={t(request.status === "preview" ? "context.liveHint" : "context.historyHint")}>{t("context.calibrationHint", { count: formatContextTokens(metrics.estimatedInput) })}{!request.breakdown.composition && ` ${t("context.legacyCategories")}`}</p>
  </div>;
}

export function ContextTab({ cwd, sessionId, active, initialTaskId = null, selectionKey = 0 }: ContextTabProps) {
  const t = useT();
  const tasks = useWorkspaceEngine((state) => state.asyncTasks);
  const storeSessionId = useWorkspaceEngine((state) => state.sessionId);
  const selectionScope = JSON.stringify([cwd, sessionId, initialTaskId, selectionKey]);
  const [agentSelection, setAgentSelection] = useState<{ scope: string; taskId: string | null } | null>(null);
  const taskId = agentSelection?.scope === selectionScope ? agentSelection.taskId : initialTaskId;
  const scope = JSON.stringify([cwd, sessionId, taskId]);
  const [historyState, setHistoryState] = useState<{ scope: string; data: ContextHistory | null; loading: boolean; error: string | null } | null>(null);
  const [requestSelection, setRequestSelection] = useState<{ scope: string; id: string | null } | null>(null);
  const [detailState, setDetailState] = useState<{ key: string; data: ContextRequestDetail | null; previous: ContextRequestDetail | null; error: string | null } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const detailCache = useRef(new Map<string, ContextRequestDetail>());
  const browserCache = useRef<{ scope: string; detail: ContextRequestDetail; previous: ContextRequestDetail | null } | null>(null);
  const history = historyState?.scope === scope ? historyState.data : null;
  const loading = historyState?.scope !== scope || historyState.loading;
  const error = historyState?.scope === scope ? historyState.error : null;
  const requests = useMemo(() => [...(history?.requests ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [history]);
  const events = history?.events ?? [];
  const selectedId = requestSelection?.scope === scope ? requestSelection.id : null;
  const selected = requests.find((request) => request.id === selectedId) ?? history?.live?.request ?? requests.at(-1);
  const current = history?.live?.request ?? requests.at(-1);
  const selectedIndex = selected ? requests.findIndex((request) => request.id === selected.id) : -1;
  const isLive = selected?.status === "preview";
  const previous = isLive ? requests.at(-1) : requests[selectedIndex - 1];
  const detailKey = JSON.stringify([scope, selected?.id, isLive ? selected?.startedAt : null]);
  const detail = isLive ? history?.live ?? null : detailState?.key === detailKey ? detailState.data : null;
  const previousDetail = detailState?.key === detailKey ? detailState.previous : null;
  const detailError = detailState?.key === detailKey ? detailState.error : null;
  const detailLoading = !isLive && detailState?.key !== detailKey;
  const displayedDetail = detail ?? (detailLoading && browserCache.current?.scope === scope ? browserCache.current.detail : null);
  const displayedPrevious = detail ? previousDetail : detailLoading && browserCache.current?.scope === scope ? browserCache.current.previous : null;
  const matchingTasks = storeSessionId === sessionId ? tasks : [];
  const selectedTask = matchingTasks.find((task) => task.id === taskId);
  const selectRequest = (id: string | null) => setRequestSelection({ scope, id });
  const selectAgent = (id: string | null) => setAgentSelection({ scope: selectionScope, taskId: id });

  useEffect(() => {
    if (detail) browserCache.current = { scope, detail, previous: previousDetail };
  }, [scope, detail, previousDetail]);

  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false, inFlight = false, pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (cancelled) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      setHistoryState((state) => ({ scope, data: state?.scope === scope ? state.data : null, loading: true, error: null }));
      try {
        const data = await bridge().getContextHistory(sessionId, taskId ?? undefined);
        if (!cancelled) setHistoryState({ scope, data, loading: false, error: null });
      } catch (failure) {
        if (!cancelled) setHistoryState((state) => ({ scope, data: state?.scope === scope ? state.data : null, loading: false, error: errorText(failure) }));
      } finally {
        inFlight = false;
        if (pending && !cancelled) { pending = false; void load(); }
      }
    };
    const unsubscribe = bridge().events.on("agent", (event) => {
      if (!isContextHistoryEvent(event, sessionId, taskId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    });
    void load();
    return () => { cancelled = true; unsubscribe(); if (timer) clearTimeout(timer); };
  }, [active, sessionId, taskId, scope, refreshVersion]);

  useEffect(() => {
    if (!active || !sessionId || !selected) return;
    let cancelled = false;
    const read = async (request: ContextRequestRecord): Promise<ContextRequestDetail | null> => {
      const key = JSON.stringify([scope, request.id]);
      const cached = detailCache.current.get(key);
      if (cached) return { ...cached, request };
      const data = await bridge().getContextRequest(sessionId, request.id, taskId ?? undefined);
      if (data) {
        detailCache.current.set(key, data);
        if (detailCache.current.size > 12) detailCache.current.delete(detailCache.current.keys().next().value!);
      }
      return data;
    };
    void Promise.all([
      isLive ? Promise.resolve(null) : read(selected),
      previous ? read(previous).catch(() => null) : Promise.resolve(null),
    ]).then(([data, prior]) => {
      if (!cancelled) setDetailState({ key: detailKey, data, previous: prior, error: null });
    }, (failure: unknown) => {
      if (!cancelled) setDetailState({ key: detailKey, data: null, previous: null, error: errorText(failure) });
    });
    return () => { cancelled = true; };
  }, [active, sessionId, taskId, scope, selected?.id, selected?.status, detailKey, previous?.id, isLive, refreshVersion]);

  const selectionLabel = isLive ? t("context.live") : selectedIndex === requests.length - 1 ? t("context.latestRequest") : t("context.requestNumber", { index: selectedIndex + 1 });
  const selectedMetrics = selected ? contextInputMetrics(selected.breakdown, selected.usage) : null;
  return <div className="context-inspector flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background" aria-label={t("context.inspector")}>
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <select aria-label={t("context.agent")} value={taskId ?? ""} onChange={(event) => selectAgent(event.target.value || null)} className={`h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs ${FOCUS_RING}`} disabled={!sessionId}>
        <option value="">{t("context.mainAgent")}</option>
        {matchingTasks.map((task) => <option key={task.id} value={task.id}>{task.name || task.id} · {statusLabel(task.status, t)}</option>)}
        {taskId && !selectedTask && <option value={taskId}>{t("context.subagent")} · {taskId}</option>}
      </select>
      <button type="button" onClick={() => setRefreshVersion((value) => value + 1)} disabled={!sessionId || loading} className={BUTTON} aria-label={t("context.refresh")} title={t("context.refresh")}>↻</button>
    </div>
    <div className="context-dashboard-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
      {!sessionId ? <p className="py-16 text-center text-xs text-muted-foreground">{t("context.openConversation")}</p> : <div className="context-dashboard">
        {error && <div role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive"><p className="break-words">{localizedError(error, t)}</p><button type="button" className={`${BUTTON} mt-1 -ml-2`} onClick={() => setRefreshVersion((value) => value + 1)}>{t("context.tryAgain")}</button></div>}
        {!history && loading && <p role="status" className="py-16 text-center text-xs text-muted-foreground">{t("context.loadingHistory")}</p>}
        <ContextStatistics requests={requests} />
        {selected && current && <>
          <div className="context-main-grid">
            <div className="context-main-column">
              <section aria-label={t("context.composition")} className="context-card context-composition-card">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><h3 className="text-xs font-medium">{t(current.status === "preview" ? "context.live" : "context.latestRequest")}</h3><span className="min-w-0 truncate text-[10px] text-muted-foreground" title={`${current.provider} / ${current.model}`}>{current.model}</span></div>
                <RequestComposition request={current} />
              </section>
              <section aria-label={t("context.historyAria")} className="context-card context-trend-card">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-1"><h3 className="text-xs font-medium">{t("context.history")} <span className="ml-1 font-normal text-muted-foreground">{requests.length}</span></h3><button type="button" className={BUTTON} disabled={!requests.length} onClick={() => selectRequest(requests.at(-1)!.id)}>{t("context.latest")}</button></div>
                {requests.length ? <ContextTrend key={scope} requests={requests} events={events} selectedId={selected.id} onSelect={selectRequest} /> : <p className="text-xs text-muted-foreground">{t("context.noRequestsHint")}</p>}
                {selectedMetrics && <div className="mt-2 border-t pt-2 text-[10px] leading-5">
                  <div className="flex flex-wrap items-center justify-between gap-x-2"><span className="font-medium">{selectionLabel}</span><span className="text-muted-foreground">{statusLabel(selected.status, t)} · {timeLabel(selected.startedAt)}</span></div>
                  <div className="flex flex-wrap gap-x-3 text-muted-foreground tabular-nums"><span>{t(selectedMetrics.source === "provider" ? "usage.inputProvider" : "usage.inputEstimate")} {formatContextTokens(selectedMetrics.input)}</span>{selectedMetrics.output !== undefined && <span>{t("usage.output")} {formatContextTokens(selectedMetrics.output)}</span>}</div>
                  {selected.error && <p className="break-words text-destructive">{selected.error}</p>}
                </div>}
                <p className="mt-2 text-[10px] text-muted-foreground">{t("context.retentionHint", { count: history?.retentionLimit ?? 100 })}</p>
              </section>
            </div>
            <section aria-label={t("context.contents")} className="context-card context-browser-card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium">{t("context.browser.title")}</h3>
                <select aria-label={t("context.selectRequest")} value={selected.id} onChange={(event) => selectRequest(event.target.value === "live" ? null : event.target.value)} className={`h-7 max-w-full rounded-md border bg-background px-2 text-[11px] ${FOCUS_RING}`}>
                  {history?.live && <option value="live">{t("context.live")}</option>}{requests.map((request, index) => <option key={request.id} value={request.id}>{t("context.requestNumber", { index: index + 1 })} · {timeLabel(request.startedAt)}</option>)}
                </select>
              </div>
              <div className="context-browser-body relative" aria-busy={detailLoading}>
                {detailLoading && <p role="status" className="absolute inset-x-0 top-0 z-10 rounded-md bg-background/95 p-3 text-xs text-muted-foreground">{t("context.loadingContents")}</p>}
                {detailError && <p role="alert" className="mb-2 text-xs text-destructive">{localizedError(detailError, t)}</p>}
                {displayedDetail ? <div className={detailLoading ? "pointer-events-none opacity-25" : ""} inert={detailLoading}>
                  <ContextBrowser key={scope} detail={displayedDetail} previousDetail={displayedPrevious} />
                </div> : <p className="py-8 text-xs text-muted-foreground">{detailLoading ? "" : t("context.contentsUnavailable")}</p>}
              </div>
            </section>
          </div>
          <div className="context-secondary-grid">
            <ContextEvents requests={requests} events={events} onSelect={selectRequest} />
            {displayedDetail && <div className="min-w-0" aria-busy={detailLoading}><div className={detailLoading ? "pointer-events-none opacity-25" : ""} inert={detailLoading}><ContextFileActivity key={scope} detail={displayedDetail} /></div></div>}
          </div>
        </>}
        {history && !selected && <p className="py-8 text-center text-xs text-muted-foreground">{t("context.noRequests")}</p>}
        {history && <ContextAgents tasks={matchingTasks} selectedId={taskId} onSelect={selectAgent} />}
      </div>}
    </div>
  </div>;
}
