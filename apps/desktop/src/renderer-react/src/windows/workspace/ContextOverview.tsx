import { useMemo, useState } from "react";
import type { AsyncTaskRecord, ContextCompactionRecord, ContextRequestRecord } from "@reina/protocol";
import { useT } from "~/lib/i18n";
import { contextStatistics, contextTimeline } from "./contextDashboard";
import { formatContextTokens } from "./contextHistory";

const BUTTON = "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ContextStatistics({ requests }: { requests: ContextRequestRecord[] }) {
  const t = useT();
  const stats = useMemo(() => contextStatistics(requests), [requests]);
  if (!requests.length) return null;
  const tokenRows = [
    [t("context.stats.input"), formatContextTokens(stats.input)], [t("usage.output"), formatContextTokens(stats.output)],
    [t("context.stats.cacheRead"), formatContextTokens(stats.cached)], [t("context.stats.cacheWrite"), formatContextTokens(stats.cacheWrite)],
    [t("context.stats.uncached"), formatContextTokens(stats.uncached)],
  ];
  return <div className="context-stats-grid">
    <section className="context-card" aria-label={t("context.stats.title")}>
      <h3 className="mb-3 text-xs font-medium">{t("context.stats.title")}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div><dt className="text-[10px] text-muted-foreground">{t("context.stats.requests")}</dt><dd className="mt-0.5 text-xl font-medium tabular-nums">{stats.requests}</dd></div>
        <div><dt className="text-[10px] text-muted-foreground">{t("context.stats.turns")}</dt><dd className="mt-0.5 text-xl font-medium tabular-nums">{stats.turns}</dd></div>
        <div className="col-span-2 flex items-baseline justify-between gap-2"><dt className="text-[10px] text-muted-foreground">{t("context.stats.modelTime")}</dt><dd className="text-xs tabular-nums">{(stats.modelMs / 1000).toFixed(1)} s</dd></div>
      </dl>
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{t("context.stats.coverage", { count: stats.reported, total: stats.requests })}</p>
    </section>
    <section className="context-card" aria-label={t("context.stats.tokensTitle")}>
      <h3 className="mb-3 text-xs font-medium">{t("context.stats.tokensTitle")}</h3>
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative flex size-16 shrink-0 items-center justify-center">
          <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="var(--secondary)" strokeWidth="3" /><circle cx="20" cy="20" r="17" fill="none" stroke="var(--usage-c5, #00a597)" strokeWidth="3" pathLength="100" strokeDasharray={`${stats.cachePercent ?? 0} 100`} strokeLinecap="round" /></svg>
          <div className="text-center"><div className="text-xs font-medium tabular-nums">{stats.cachePercent === undefined ? "—" : `${stats.cachePercent.toFixed(1)}%`}</div><div className="text-[8px] text-muted-foreground">{t("context.stats.cacheHit")}</div></div>
        </div>
        <dl className="min-w-0 flex-1 space-y-1.5">
          {tokenRows.map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-2"><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="ml-auto text-xs tabular-nums">{value}</dd></div>)}
        </dl>
      </div>
    </section>
  </div>;
}

export function ContextEvents({ requests, events, onSelect }: { requests: ContextRequestRecord[]; events: ContextCompactionRecord[]; onSelect: (id: string) => void }) {
  const t = useT();
  const [filter, setFilter] = useState("all");
  const timeline = useMemo(() => contextTimeline(requests, events), [requests, events]);
  const visible = timeline.filter((event) => filter === "all" || event.kind === filter);
  return <section className="context-card" aria-label={t("context.events.title")}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium">{t("context.events.title")} <span className="font-normal text-muted-foreground">{timeline.length}</span></h3>
      <div className="flex gap-1" role="group" aria-label={t("context.events.filter")}>{["all", "compact", "switch"].map((kind) => <button key={kind} type="button" className={`${BUTTON} ${filter === kind ? "bg-secondary text-foreground" : ""}`} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{t(`context.events.${kind}`)}</button>)}</div>
    </div>
    <div className="context-events-list overflow-y-auto border-l pl-3">
      {!visible.length && <p className="flex h-full min-h-24 items-center justify-center px-3 text-center text-[11px] text-muted-foreground">{t(timeline.length ? "context.events.noMatch" : "context.events.empty")}</p>}
      {visible.map((entry) => <div key={entry.id} className="py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><time className="text-muted-foreground">{new Date(entry.createdAt).toLocaleTimeString()}</time><span>{entry.compaction ? t(`context.compaction.${entry.compaction.status}`) : t("context.events.modelObserved")}</span>
          {entry.compaction?.boundary && <span className="tabular-nums">{t("context.compactionTokens", { before: formatContextTokens(entry.compaction.boundary.estimatedTokensBefore), after: formatContextTokens(entry.compaction.boundary.estimatedTokensAfter) })}</span>}
        </div>
        {entry.compaction && (entry.compaction.reason || entry.compaction.error) && <p className="mt-1 break-words text-muted-foreground">{entry.compaction.error || entry.compaction.reason}</p>}
        {entry.requestId && <button className={`${BUTTON} mt-1 -ml-2 break-all text-left`} type="button" onClick={() => onSelect(entry.requestId!)}>{entry.from} → {entry.to}</button>}
      </div>)}
    </div>
  </section>;
}

export function ContextAgents({ tasks, selectedId, onSelect }: { tasks: AsyncTaskRecord[]; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const t = useT();
  return <section className="context-card" aria-label={t("context.agents.title")}>
    <h3 className="mb-3 text-xs font-medium">{t("context.agents.title")}</h3>
    <div className="flex min-w-0 items-center gap-2 py-2">
      <button type="button" className={`${BUTTON} shrink-0 border ${!selectedId ? "bg-secondary text-foreground" : ""}`} aria-pressed={!selectedId} onClick={() => onSelect(null)}>{t("context.mainAgent")}</button>
      {tasks.length > 0 ? <>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">→</span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-2 border-l pl-3">{tasks.map((task) => <button key={task.id} type="button" className={`${BUTTON} flex min-w-0 max-w-full flex-[1_1_150px] flex-wrap items-center gap-x-2 gap-y-1 border text-left ${selectedId === task.id ? "bg-secondary text-foreground" : ""}`} aria-pressed={selectedId === task.id} onClick={() => onSelect(task.id)} title={task.description}>
          <span className={`size-1.5 shrink-0 rounded-full ${task.status === "running" ? "animate-pulse bg-green-500" : "bg-muted-foreground/50"}`} /><span className="min-w-0 flex-1 truncate">{task.name || task.id}</span><span className="text-[10px]">{t(`context.status.${task.status}`)}</span>{task.usage && <span className="w-full pl-3.5 text-[10px] tabular-nums">{formatContextTokens(task.usage.inputTokens)} / {formatContextTokens(task.usage.outputTokens)}</span>}
        </button>)}</div>
      </> : <p className="text-[11px] text-muted-foreground">{t("context.agents.empty")}</p>}
    </div>
    <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{t("context.agents.hint")}</p>
  </section>;
}
