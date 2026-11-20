import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ContextCompactionRecord, ContextRequestRecord } from "@reina/protocol";
import { contextInputMetrics } from "../../lib/contextUsage";
import { useT } from "../../lib/i18n";
import { formatContextTokens } from "./contextHistory";
import { buildContextTrend, contextTrendAnchorIndex, contextTrendEventPosition, contextTrendExtent, contextTrendKeyIndex, type ContextTrendGranularity, type ContextTrendMode } from "./contextTrendModel";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";
const CONTROL = `rounded px-2 py-1 text-[10px] hover:text-foreground ${FOCUS_RING}`;

function signedTokens(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatContextTokens(Math.abs(value))}`;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : value;
}

export function ContextTrend({ requests, events, selectedId, onSelect }: {
  requests: ContextRequestRecord[];
  events: ContextCompactionRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const tooltipId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [granularity, setGranularity] = useState<ContextTrendGranularity>("step");
  const [mode, setMode] = useState<ContextTrendMode>("total");
  const [hover, setHover] = useState<{ id: string; left: number } | null>(null);
  const bars = useMemo(() => buildContextTrend(requests, granularity, mode, t), [requests, granularity, mode, t]);
  const extent = useMemo(() => contextTrendExtent(bars, mode), [bars, mode]);
  const anchorIndex = contextTrendAnchorIndex(bars, selectedId);
  const activeBar = bars.find((bar) => bar.request.id === hover?.id);
  const activeMetrics = activeBar ? contextInputMetrics(activeBar.request.breakdown, activeBar.request.usage) : null;
  const width = Math.max(280, bars.length * 28);
  const step = width / Math.max(1, bars.length);
  const height = 164;
  const chartTop = 14;
  const chartBottom = 132;
  const scale = (chartBottom - chartTop) / (extent.positive + extent.negative);
  const baseline = chartTop + extent.positive * scale;
  const y = (value: number) => baseline - value * scale;

  useEffect(() => {
    setHover(null);
  }, [granularity, mode]);
  useEffect(() => {
    const viewport = scroller.current;
    const button = viewport?.querySelectorAll<HTMLButtonElement>("button")[anchorIndex];
    if (!button || !viewport) return;
    const left = button.offsetLeft;
    const right = left + button.offsetWidth;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
    // Hover previews never change selectedId and must not move the viewport.
  }, [selectedId, requests.at(-1)?.id, bars.length, granularity, anchorIndex]);

  const preview = (id: string, button: HTMLButtonElement) => {
    const bounds = chart.current?.getBoundingClientRect();
    const target = button.getBoundingClientRect();
    setHover({ id, left: bounds ? Math.max(0, Math.min(bounds.width - 280, target.left - bounds.left)) : 0 });
  };
  const clearPreview = () => setHover(null);

  return <div>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md bg-secondary/60 p-0.5" role="group" aria-label={t("context.trend.granularity")}>
          {(["step", "turn"] as const).map((value) => <button key={value} type="button" aria-pressed={granularity === value} onClick={() => setGranularity(value)} className={`${CONTROL} ${granularity === value ? "bg-background text-foreground shadow-sm" : ""}`}>{t(`context.trend.${value}`)}</button>)}
        </div>
        <div className="flex rounded-md bg-secondary/60 p-0.5" role="group" aria-label={t("context.trend.mode")}>
          {(["total", "delta"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`${CONTROL} ${mode === value ? "bg-background text-foreground shadow-sm" : ""}`}>{t(`context.trend.${value}`)}</button>)}
        </div>
      </div>
      <span className="text-[10px]">{t(mode === "delta" ? "context.trend.deltaLegend" : "context.trend.totalLegend")}</span>
    </div>
    <div className="mb-1 flex justify-between gap-3 text-[10px] text-muted-foreground tabular-nums">
      <span>{mode === "delta" ? `${signedTokens(-extent.negative)} … ${signedTokens(extent.positive)}` : formatContextTokens(extent.positive)} {t("context.tokens")}</span>
      <span>{t(granularity === "turn" ? "context.trend.turnHint" : "context.trend.stepHint")}</span>
    </div>
    <div ref={chart} className="relative" onMouseLeave={clearPreview}>
      <div ref={scroller} className="overflow-x-auto overscroll-x-contain pb-1" aria-label={t("context.trendAria")}>
        <div className="relative" style={{ minWidth: width, height }}>
          <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0">
            <line x1={0} x2={width} y1={baseline} y2={baseline} stroke="currentColor" className="text-border" />
            {bars.map((bar, index) => {
              const x = (index + 0.5) * step;
              const selected = bar.requestIds.includes(selectedId);
              let positive = 0;
              let negative = 0;
              const threshold = bar.request.breakdown.categories?.autocompactThreshold;
              return <g key={bar.request.id} opacity={selected || bar.request.id === hover?.id ? 1 : 0.7}>
                {bar.categories.map((category) => {
                  if (!category.value) return null;
                  const top = category.value > 0 ? y(positive + category.value) : y(-negative);
                  if (category.value > 0) positive += category.value;
                  else negative -= category.value;
                  return <rect key={category.id} x={x - Math.min(9, step * 0.33)} y={top} width={Math.min(18, step * 0.66)} height={Math.abs(category.value) * scale} fill={category.color} />;
                })}
                {mode === "total" && threshold !== undefined && threshold > 0 && <line x1={index * step} x2={(index + 1) * step} y1={y(threshold)} y2={y(threshold)} stroke="currentColor" className="text-muted-foreground" strokeDasharray="3 3" />}
                {bar.request.attempt > 1 && <text x={x} y={Math.max(10, y(bar.positive) - 3)} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">↻{bar.request.attempt}</text>}
                {bar.request.status === "failed" && <circle cx={x} cy={chartBottom + 5} r={2} className="text-destructive" fill="currentColor" />}
              </g>;
            })}
            {events.map((event) => {
              const x = Math.max(2, Math.min(width - 2, contextTrendEventPosition(requests, bars, event.createdAt) * step));
              return <g key={event.id} className={event.status === "failed" ? "text-destructive" : "text-amber-500"}>
                <line x1={x} x2={x} y1={chartTop} y2={chartBottom} stroke="currentColor" strokeDasharray="2 4" opacity={0.65} />
                <text x={x} y={10} textAnchor={x < 10 ? "start" : x > width - 10 ? "end" : "middle"} fontSize={10} fill="currentColor">↧</text>
              </g>;
            })}
          </svg>
          <div className="absolute inset-0 flex" role="group" aria-label={t("context.selectRequest")}>
            {bars.map((bar, index) => {
              const request = bar.request;
              const selected = bar.requestIds.includes(selectedId);
              return <button
                key={request.id}
                type="button"
                aria-pressed={selected}
                aria-describedby={hover?.id === request.id ? tooltipId : undefined}
                aria-label={t("context.trend.barAria", { unit: t(`context.trend.${granularity}`), index: granularity === "turn" ? bar.turnNumber : bar.lastIndex + 1, count: bar.input.toLocaleString(), change: signedTokens(bar.net) })}
                tabIndex={index === anchorIndex ? 0 : -1}
                onClick={() => onSelect(request.id)}
                onMouseEnter={(event) => preview(request.id, event.currentTarget)}
                onFocus={(event) => preview(request.id, event.currentTarget)}
                onBlur={clearPreview}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); clearPreview(); return; }
                  const target = contextTrendKeyIndex(event.key, index, bars.length);
                  if (target === null) return;
                  event.preventDefault();
                  onSelect(bars[target]!.request.id);
                  event.currentTarget.parentElement?.querySelectorAll("button")[target]?.focus({ preventScroll: true });
                }}
                className={`relative min-w-0 flex-1 rounded-sm border border-transparent hover:bg-secondary/20 ${selected ? "border-primary/30 bg-primary/5" : ""} ${FOCUS_RING}`}
              >
                <span className="absolute inset-x-0 bottom-0.5 text-[9px] text-muted-foreground tabular-nums">{granularity === "turn" ? bar.turnNumber : bar.lastIndex + 1}</span>
                {granularity === "step" && <span className="absolute inset-x-px bottom-4 h-1 rounded-sm" style={{ background: bar.turnNumber % 2 ? "rgba(128,128,128,0.13)" : "rgba(128,128,128,0.28)" }} />}
              </button>;
            })}
          </div>
        </div>
      </div>
      {activeBar && activeMetrics && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute top-5 z-20 w-[280px] max-w-full rounded-md border bg-popover px-3 py-2 text-[10px] leading-5 text-popover-foreground shadow-md" style={{ left: hover?.left ?? 0 }}>
        <div className="flex justify-between gap-2 font-medium"><span>{t(granularity === "turn" ? "context.trend.turnNumber" : "context.requestNumber", { index: granularity === "turn" ? activeBar.turnNumber : activeBar.lastIndex + 1 })}</span><time className="font-normal text-muted-foreground">{timeLabel(activeBar.request.startedAt)}</time></div>
        {granularity === "turn" && <div className="text-muted-foreground">{t("context.trend.turnSteps", { count: activeBar.requestIds.length })}</div>}
        <div className="truncate text-muted-foreground">{activeBar.request.provider} / {activeBar.request.model}</div>
        <div className="flex flex-wrap gap-x-3 tabular-nums"><span>{t(activeMetrics.source === "provider" ? "usage.inputProvider" : "usage.inputEstimate")} {formatContextTokens(activeMetrics.input)}</span>{activeMetrics.output !== undefined && <span>{t("usage.output")} {formatContextTokens(activeMetrics.output)}</span>}</div>
        {activeBar.request.usage?.cachedInputTokens !== undefined && <div className="text-muted-foreground">{t("context.cachedInput", { count: formatContextTokens(activeBar.request.usage.cachedInputTokens) })}</div>}
        {mode === "delta" && <div className="font-medium tabular-nums">{t("context.trend.netChange", { count: signedTokens(activeBar.net) })}</div>}
        <div className="mt-1 border-t pt-1 text-muted-foreground">{t(mode === "delta" ? "context.trend.categoryDelta" : "context.trend.categoryEstimate")}</div>
        {activeBar.categories.map((category) => <div key={category.id} className="flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: category.color }} /><span>{category.label}</span><span className="ml-auto tabular-nums">{mode === "delta" ? signedTokens(category.value) : formatContextTokens(category.tokens)}</span></div>)}
      </div>}
    </div>
    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t("context.trend.estimateHint")}</p>
  </div>;
}
