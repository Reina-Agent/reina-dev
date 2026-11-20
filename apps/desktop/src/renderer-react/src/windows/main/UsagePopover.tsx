// UsagePopover.tsx — React port of the legacy renderer's usage detail popover
// (session.js renderUsagePopover + renderContextWindowSection + buildCategoryRow
// + renderAutocompactionSection + appendUsageSection). Opens when the composer
// usage ring is clicked; shows the per-category context-window breakdown
// (stacked bar + rows, expandable per-tool sub-lists), the autocompaction
// trigger accounting, and a session token grid.
//
// The token math reuses the exact helpers the ring uses (usageRing.ts) so the
// headline here always reconciles with the ring label. The `.usage-popover*`
// CSS is already ported in chat-styles/composer.css.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  activeCategoryTokens,
  cacheReadPercent,
  contextTokensForDisplay,
  formatTokens,
  lastOutputTokens,
  resolveContextWindow,
  type SessionUsage,
  type UsageModelRef,
  type UsageToolDetail,
} from "./usageRing";

// ── Context-window entry model (mirror legacy `entries`) ──────────────────────

interface ContextEntry {
  id: string;
  label: string;
  tokens: number;
  color: string;
  reserved?: boolean;
  /** Bucket key for the expandable per-tool sub-list. */
  expandable?: "tools-core" | "tools-mcp" | "tools-core-deferred" | "tools-mcp-deferred";
  /** Normalization factor carried onto active buckets so sub-rows stay in step. */
  scale?: number;
}

function toolEntryMatches(tool: UsageToolDetail, bucket: NonNullable<ContextEntry["expandable"]>): boolean {
  if (bucket === "tools-core") return !tool.mcp && !tool.deferred;
  if (bucket === "tools-mcp") return !!tool.mcp && !tool.deferred;
  if (bucket === "tools-core-deferred") return !tool.mcp && !!tool.deferred;
  if (bucket === "tools-mcp-deferred") return !!tool.mcp && !!tool.deferred;
  return false;
}

// Build categorized context-window rows (port of renderContextWindowSection's
// entry construction, including the proportional normalization to the provider's
// authoritative input total).
export function buildContextEntries(usage: SessionUsage, contextWindow: number): ContextEntry[] {
  const cats = usage.lastRequest?.categories;
  const reconcileTotal = contextTokensForDisplay(usage);
  const localActiveInput = activeCategoryTokens(usage) || 0;
  const providerInput = reconcileTotal;
  const scale =
    providerInput !== undefined && providerInput > 0 && localActiveInput > 0 ? providerInput / localActiveInput : 1;
  const norm = (tokens: number | undefined) => Math.round(Math.max(0, tokens || 0) * scale);

  const entries: ContextEntry[] = [];
  if (cats) {
    entries.push({ id: "sys-base", label: "System prompt", tokens: norm(cats.systemPromptBase), color: "var(--usage-c1)", scale });
    if ((cats.systemPromptSkills || 0) > 0)
      entries.push({ id: "sys-skl", label: "Skills", tokens: norm(cats.systemPromptSkills), color: "var(--usage-c2)", scale });
    if ((cats.systemPromptUserRules || 0) > 0)
      entries.push({ id: "sys-rules", label: "User rules", tokens: norm(cats.systemPromptUserRules), color: "var(--usage-c3)", scale });
    if ((cats.toolsCore || 0) > 0)
      entries.push({ id: "tc", label: "System tools", tokens: norm(cats.toolsCore), color: "var(--usage-c4)", expandable: "tools-core", scale });
    if ((cats.toolsMcp || 0) > 0)
      entries.push({ id: "tm", label: "MCP tools", tokens: norm(cats.toolsMcp), color: "var(--usage-c5)", expandable: "tools-mcp", scale });
    if ((cats.messages || 0) > 0)
      entries.push({ id: "msg", label: "Messages", tokens: norm(cats.messages), color: "var(--usage-c6)", scale });
    if ((cats.observations || 0) > 0)
      entries.push({ id: "obs", label: "Tool observations", tokens: norm(cats.observations), color: "var(--usage-c7)", scale });
    if ((cats.reminders || 0) > 0)
      entries.push({ id: "rem", label: "Reminders", tokens: norm(cats.reminders), color: "var(--usage-c8)", scale });
    if ((cats.toolsMcpDeferred || 0) > 0)
      entries.push({ id: "tmd", label: "MCP tools (deferred)", tokens: cats.toolsMcpDeferred!, color: "var(--usage-c5)", reserved: true, expandable: "tools-mcp-deferred" });
    if ((cats.toolsCoreDeferred || 0) > 0)
      entries.push({ id: "tcd", label: "System tools (deferred)", tokens: cats.toolsCoreDeferred!, color: "var(--usage-c4)", reserved: true, expandable: "tools-core-deferred" });
    if ((cats.autocompactBuffer || 0) > 0)
      entries.push({ id: "ac", label: "Autocompact buffer", tokens: cats.autocompactBuffer!, color: "var(--usage-cb)", reserved: true });
    appendFreeSpace(entries, contextWindow, reconcileTotal);
  } else if (usage.lastRequest) {
    const req = usage.lastRequest;
    const coarseInput =
      (req.systemPromptTokens || 0) + (req.toolsTokens || 0) + (req.messagesTokens || 0) + (req.observationsTokens || 0);
    const coarseScale = providerInput !== undefined && providerInput > 0 && coarseInput > 0 ? providerInput / coarseInput : 1;
    const cnorm = (tokens: number | undefined) => Math.round(Math.max(0, tokens || 0) * coarseScale);
    entries.push({ id: "sp", label: "System prompt", tokens: cnorm(req.systemPromptTokens), color: "var(--usage-c1)" });
    entries.push({ id: "t", label: "Tools", tokens: cnorm(req.toolsTokens), color: "var(--usage-c4)" });
    entries.push({ id: "m", label: "Messages", tokens: cnorm(req.messagesTokens), color: "var(--usage-c6)" });
    entries.push({ id: "o", label: "Observations", tokens: cnorm(req.observationsTokens), color: "var(--usage-c7)" });
    appendFreeSpace(entries, contextWindow, reconcileTotal);
  }
  return entries;
}

function appendFreeSpace(entries: ContextEntry[], contextWindow: number, providerTotal: number | undefined): void {
  const occupied = entries.filter((entry) => !entry.reserved).reduce((sum, entry) => sum + Math.max(0, entry.tokens || 0), 0);
  const hasProvider = typeof providerTotal === "number" && Number.isFinite(providerTotal) && providerTotal > 0;
  if (hasProvider && (providerTotal as number) > occupied) {
    entries.push({ id: "overhead", label: "Overhead (uncounted)", tokens: (providerTotal as number) - occupied, color: "var(--usage-ca)" });
  }
  const used = Math.max(occupied, hasProvider ? (providerTotal as number) : 0);
  const free = Math.max(0, contextWindow - used);
  if (free > 0) entries.push({ id: "free", label: "Free space", tokens: free, color: "var(--usage-cf)", reserved: true });
}

// ── Per-category row (port of buildCategoryRow), with expandable tool sub-list ─

function CategoryRow({
  entry,
  contextWindow,
  toolDetails,
}: {
  entry: ContextEntry;
  contextWindow: number;
  toolDetails: UsageToolDetail[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pct = (entry.tokens / contextWindow) * 100;

  const matches =
    entry.expandable && Array.isArray(toolDetails)
      ? toolDetails.filter((t) => toolEntryMatches(t, entry.expandable!))
      : [];
  const expandable = matches.length > 0;
  const s = Number.isFinite(entry.scale) && (entry.scale as number) > 0 ? (entry.scale as number) : 1;
  const subTokens = (tool: UsageToolDetail) => Math.round(Math.max(0, tool.tokens || 0) * s);

  const row = (
    <div
      className={`usage-context-row${entry.reserved ? " is-reserved" : ""}${expandable ? " is-expandable" : ""}`}
      data-entry-id={entry.id}
      onClick={expandable ? () => setOpen((v) => !v) : undefined}
    >
      <span
        className="usage-context-bullet"
        style={{ background: entry.reserved ? "transparent" : entry.color, borderColor: entry.color }}
      />
      <span className="usage-context-label">
        <span className="usage-context-label-text">{entry.label}</span>
        {expandable && <span className="usage-context-chevron">{open ? "▾" : "▸"}</span>}
      </span>
      <span className="usage-context-tokens">{formatTokens(entry.tokens)}</span>
      <span className="usage-context-percent">{pct.toFixed(1)}%</span>
    </div>
  );

  if (!expandable) return row;

  const visible = matches.slice(0, 6);
  const hidden = matches.slice(6);
  const hiddenTokens = hidden.reduce((sum, tool) => sum + subTokens(tool), 0);

  return (
    <div className="usage-context-rowwrap">
      {row}
      <div className="usage-context-sublist" hidden={!open}>
        {visible.map((tool, i) => (
          <div className="usage-context-subrow" key={`${tool.name}:${i}`}>
            <span className="usage-context-subname">{tool.name}</span>
            <span className="usage-context-subtokens">{formatTokens(subTokens(tool))}</span>
          </div>
        ))}
        {hidden.length > 0 && (
          <div className="usage-context-subrow usage-context-subrow-more">
            <span>+{hidden.length} more</span>
            <span className="usage-context-subtokens">{formatTokens(hiddenTokens)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Context-window section (collapsible: bar always shown, rows on expand) ─────

function ContextWindowSection({ usage, model }: { usage: SessionUsage; model: UsageModelRef | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const cats = usage.lastRequest?.categories;
  const contextWindow = cats?.contextWindow || resolveContextWindow(model);
  const entries = buildContextEntries(usage, contextWindow);
  if (entries.length === 0) return null;
  const inputEntries = entries.filter((entry) => !entry.reserved || entry.id === "free");
  const reservedEntries = entries.filter((entry) => entry.reserved && entry.id !== "free");

  const headline = contextTokensForDisplay(usage);
  const usedPercent = headline === undefined ? undefined : Math.min(100, Math.max(0, (headline / contextWindow) * 100));

  return (
    <section className={`usage-popover-section usage-context ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div
        className="usage-context-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className="usage-context-head-label">Context window</span>
        <span className="usage-context-head-value">
          {headline === undefined
            ? `- / ${formatTokens(contextWindow)}`
            : `${formatTokens(headline)} / ${formatTokens(contextWindow)} (${usedPercent!.toFixed(0)}%)`}
        </span>
        <span className="usage-context-head-chevron">{expanded ? "▾" : "▸"}</span>
      </div>

      <div className="usage-context-bar">
        {inputEntries.map((entry) =>
          entry.tokens <= 0 ? null : (
            <span
              key={entry.id}
              className={`usage-context-bar-seg${entry.reserved ? " is-reserved" : ""}`}
              style={{ width: `${(entry.tokens / contextWindow) * 100}%`, background: entry.color }}
              title={`${entry.label}: ${formatTokens(entry.tokens)} (${((entry.tokens / contextWindow) * 100).toFixed(1)}%)`}
            />
          ),
        )}
      </div>

      <div className="usage-context-list" hidden={!expanded}>
        {inputEntries.map((entry) => (
          <CategoryRow key={entry.id} entry={entry} contextWindow={contextWindow} toolDetails={usage.lastRequest?.toolDetails} />
        ))}
        {reservedEntries.length > 0 && <div className="usage-popover-section">
          <h3>Reserved budget (not sent)</h3>
          {reservedEntries.map((entry) => <CategoryRow key={entry.id} entry={entry} contextWindow={contextWindow} toolDetails={usage.lastRequest?.toolDetails} />)}
        </div>}
      </div>
    </section>
  );
}

// ── Plain section grid (port of appendUsageSection) ───────────────────────────

function GridSection({ title, rows }: { title: string; rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <section className="usage-popover-section">
      <h3>{title}</h3>
      <dl className="usage-grid">
        {rows.map(([label, value], i) => (
          <div key={i} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const tokenDetail = (value: number | undefined) => formatTokens(Number.isFinite(value as number) ? (value as number) : 0);

export function autocompactionRows(usage: SessionUsage, model: UsageModelRef | undefined): [string, string][] {
  const cats = usage.lastRequest?.categories;
  const threshold = cats?.autocompactThreshold;
  if (!Number.isFinite(threshold) || (threshold as number) <= 0) return [];
  // The compactor uses its retained provider footprint (input + output), not
  // the request-input occupancy shown by the ring. A post-compaction anchor
  // supersedes the old request's measure; otherwise use the same measured
  // request floor as the engine's estimate path. Pending observations and
  // body-growth gates are checked at preflight, so this is threshold headroom,
  // not a promise that compaction will trigger after this many new tokens.
  const anchor = typeof usage.contextTokens === "number" && Number.isFinite(usage.contextTokens) && usage.contextTokens > 0
    && (usage.contextTokensSource === "provider" || usage.contextTokensSource === "estimate") ? usage.contextTokens : undefined;
  const measured = typeof cats?.autocompactEstimate === "number" && Number.isFinite(cats.autocompactEstimate) && cats.autocompactEstimate >= 0
    ? cats.autocompactEstimate : undefined;
  const estimate = anchor ?? measured;
  if (estimate === undefined) return [];
  const basis = anchor !== undefined
    ? usage.contextTokensSource === "provider" ? "Provider footprint (input + output)" : "Post-compaction footprint"
    : "Measured request footprint";
  const contextWindow = cats?.contextWindow || resolveContextWindow(model);
  const remaining = Math.max(0, (threshold as number) - (estimate as number));
  const thresholdPct = contextWindow > 0 ? ((threshold as number) / contextWindow) * 100 : 0;
  const estimatePct = (threshold as number) > 0 ? Math.min(100, Math.max(0, ((estimate as number) / (threshold as number)) * 100)) : 0;
  return [
    ["Threshold", `${formatTokens(threshold as number)} (${thresholdPct.toFixed(0)}%)`],
    [basis, `${formatTokens(estimate)} / ${formatTokens(threshold as number)} (${estimatePct.toFixed(1)}%)`],
    ["Headroom to threshold", formatTokens(remaining)],
  ];
}

function sessionRows(usage: SessionUsage): [string, string][] {
  const totalInput = usage.inputTokens || 0;
  const totalOutput = usage.outputTokens || 0;
  const childInput = usage.childInputTokens || 0;
  const childOutput = usage.childOutputTokens || 0;
  const sideIn = usage.sideInputTokens || 0;
  const sideOut = usage.sideOutputTokens || 0;
  // "Self" = the main turn loop only: children and side calls have their own rows.
  const selfInput = Math.max(0, totalInput - childInput - sideIn);
  const selfOutput = Math.max(0, totalOutput - childOutput - sideOut);

  const cacheReads = usage.cachedInputTokens || 0;
  const cacheWrites = usage.cacheCreationInputTokens || 0;
  const cacheHitPercent = cacheReadPercent(totalInput, cacheReads);
  const cacheHit = cacheHitPercent !== undefined ? ` (${cacheHitPercent.toFixed(0)}%)` : "";

  const estTotalInput = usage.requestTotals?.estimatedInputTokens || 0;
  const selfInputDisplay =
    totalInput > 0
      ? tokenDetail(selfInput)
      : estTotalInput > 0
        ? `~${tokenDetail(Math.max(0, estTotalInput - childInput))}`
        : tokenDetail(0);

  const rows: [string, string][] = [
    ["Cache r/w", `${tokenDetail(cacheReads)} / ${tokenDetail(cacheWrites)}${cacheHit}`],
    ["Self in/out", `${selfInputDisplay} / ${tokenDetail(selfOutput)}`],
    ["Reasoning / turns", `${tokenDetail(usage.reasoningTokens || 0)} / ${usage.turns || 0}`],
  ];
  const lastOutput = lastOutputTokens(usage);
  if (lastOutput > 0) rows.push(["Last request output", tokenDetail(lastOutput)]);
  if (childInput > 0 || childOutput > 0) {
    rows.push(["Subagent in/out", `${tokenDetail(childInput)} / ${tokenDetail(childOutput)}`]);
  }
  // Single-shot side calls (compaction summary / auto-title / verifier) —
  // previously spent invisibly, now rolled into the totals with a line item.
  if (sideIn > 0 || sideOut > 0) {
    rows.push(["Side calls in/out", `${tokenDetail(sideIn)} / ${tokenDetail(sideOut)}`]);
  }
  // Conservative cache regressions: a prefix previously proven reusable was
  // re-billed instead of served from cache (engine cache-stats v2).
  const waste = usage.cacheWaste;
  if (waste && (waste.missCount || 0) > 0) {
    rows.push(["Cache loss", `${tokenDetail(waste.missedTokens || 0)} (${waste.missCount}×)`]);
  }
  if (usage.lastTurn) {
    const lastInputProvider = usage.lastTurn.inputTokens || 0;
    const lastEstInput = usage.lastRequest?.estimatedInputTokens || 0;
    const lastInputDisplay =
      lastInputProvider > 0 ? tokenDetail(lastInputProvider) : lastEstInput > 0 ? `~${tokenDetail(lastEstInput)}` : tokenDetail(0);
    rows.push(["Last in/out", `${lastInputDisplay} / ${tokenDetail(usage.lastTurn.outputTokens)}`]);
    const lastReads = usage.lastTurn.cachedInputTokens || 0;
    const lastWrites = usage.lastTurn.cacheCreationInputTokens || 0;
    if (lastReads > 0 || lastWrites > 0) {
      const lastCacheHitPercent = cacheReadPercent(lastInputProvider, lastReads);
      const lastCacheHit = lastCacheHitPercent !== undefined ? ` (${lastCacheHitPercent.toFixed(0)}%)` : "";
      rows.push(["Last cache r/w", `${tokenDetail(lastReads)} / ${tokenDetail(lastWrites)}${lastCacheHit}`]);
    }
  }
  return rows;
}

// ── Popover shell — fixed positioning anchored to the usage ring ──────────────

export interface UsagePopoverProps {
  usage: SessionUsage | undefined;
  model: UsageModelRef | undefined;
  /** The composer usage-ring button to anchor against. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

export function UsagePopover({ usage, model, anchorRef, open, onClose }: UsagePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position above the ring (flip below only if there isn't room above). Mirrors
  // legacy positionUsagePopover. Capped to the viewport so a tall (expanded)
  // popover scrolls internally instead of overflowing off-screen.
  const reposition = useCallback(() => {
    const anchorEl = anchorRef.current;
    const popEl = ref.current;
    if (!anchorEl || !popEl) return;
    const anchor = anchorEl.getBoundingClientRect();
    const pop = popEl.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - pop.width - margin, anchor.right - pop.width));
    const preferTop = anchor.top - pop.height - 8;
    const top = preferTop >= margin ? preferTop : Math.min(window.innerHeight - pop.height - margin, anchor.bottom + 8);
    setPos({ left: Math.round(left), top: Math.max(margin, Math.round(top)) });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition, usage]);

  // Re-anchor whenever the popover's own size changes — expanding the context
  // section / a per-tool sub-list grows the box, and without this it would just
  // overflow downward (the "点这个咋往下面啊" cut-off). Mirrors legacy's
  // requestAnimationFrame(positionUsagePopover) on every toggle.
  useEffect(() => {
    if (!open) return;
    const popEl = ref.current;
    if (!popEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => reposition());
    ro.observe(popEl);
    return () => ro.disconnect();
  }, [open, reposition]);

  // Dismiss on outside click, Esc, scroll, resize (mirror legacy bindUsagePopover).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Dismiss when the page scrolls under the popover — but NOT when the popover
    // scrolls its own (now overflow-y:auto) content. Capture-phase listeners
    // receive non-bubbling scroll events from descendants, so we must filter.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !usage) return null;

  const autoRows = autocompactionRows(usage, model);
  const sessRows = sessionRows(usage);

  return (
    <div
      ref={ref}
      className="usage-popover"
      id="usage-popover"
      role="dialog"
      aria-label="Token usage details"
      // Block wheel from bubbling to the dismiss-on-scroll listener while the
      // pointer is over the popover (mirror legacy's wheel stopPropagation).
      onWheel={(e) => e.stopPropagation()}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
    >
      <ContextWindowSection usage={usage} model={model} />
      <GridSection title="Autocompaction" rows={autoRows} />
      <GridSection title="Session" rows={sessRows} />
    </div>
  );
}
