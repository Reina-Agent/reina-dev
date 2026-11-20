import { memo, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import type { ContextRequestDetail } from "@reina/protocol";
import { useT } from "~/lib/i18n";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
import { contextItemLabel, formatContextTokens } from "./contextHistory";
import {
  contextBrowserContent, contextBrowserGroups, filterContextBrowserItems,
  type ContextBrowserItem, type ContextBrowserSort,
} from "./contextBrowserModel";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";
const BUTTON = `rounded px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground ${FOCUS}`;
const CATEGORY_COLORS = {
  system: "var(--usage-c1)", tools: "var(--usage-c4)", user: "var(--usage-c2)", injected: "var(--usage-c8)",
  assistant: "var(--usage-c6)", toolResults: "var(--usage-c5)",
};

function LazyDisclosure({ summary, children, className = "" }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={`context-disclosure ${className}`} onToggle={(event) => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
    }}>
      <summary className={`rounded px-2 py-1.5 hover:bg-secondary/30 ${FOCUS}`}>{summary}</summary>
      {open && children}
    </details>
  );
}

function Delta({ value, tokens = false, approximate = false }: { value: number | null; tokens?: boolean; approximate?: boolean }) {
  const t = useT();
  if (value === null || value === 0) return null;
  return <span className={value > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}
    title={t(approximate ? "context.browser.partialDiff" : "context.browser.diff")}>
    {approximate ? "≈" : ""}{value > 0 ? "+" : "−"}{tokens ? formatContextTokens(Math.abs(value)) : Math.abs(value)}{tokens ? " tokens" : ""}
  </span>;
}

function TextBody({ text, markdown }: { text: string; markdown: boolean }) {
  const t = useT();
  const [full, setFull] = useState(false);
  const clipped = !full && text.length > 16_000;
  const shown = clipped ? text.slice(0, 16_000) : text;
  return <>
    {markdown
      ? <WorkspaceMarkdown source={shown} className="min-w-0 text-xs [&_pre]:max-w-full [&_pre]:overflow-x-auto" />
      : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{shown}</pre>}
    {clipped && <button type="button" className={BUTTON} onClick={() => setFull(true)}>{t("context.browser.showAll", { count: text.length.toLocaleString() })}</button>}
  </>;
}

const ItemContent = memo(function ItemContent({ item }: { item: ContextBrowserItem }) {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const content = useMemo(() => contextBrowserContent(item), [item]);
  return <div className="mb-2 min-w-0 space-y-3 rounded-md border border-border/60 bg-secondary/15 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{t("context.browser.lines", { count: item.content.split("\n").length })}</span>
      <div className="flex gap-1" role="group" aria-label={t("context.browser.display")}>
        <button type="button" aria-pressed={raw} className={`${BUTTON} ${raw ? "bg-secondary text-foreground" : ""}`} onClick={() => setRaw(true)}>{t("context.browser.raw")}</button>
        <button type="button" aria-pressed={!raw} className={`${BUTTON} ${!raw ? "bg-secondary text-foreground" : ""}`} onClick={() => setRaw(false)}>{t("context.browser.markdown")}</button>
      </div>
    </div>
    {item.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t("context.browser.truncated")}</p>}
    {raw ? <TextBody key="raw" text={item.content} markdown={false} /> : <>
      {content.blocks.map((block, index) => <div key={`${block.kind}:${index}`} className="min-w-0 space-y-1">
        <div className={`text-xs ${block.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>{t(`context.browser.block.${block.kind}`)}</div>
        <TextBody text={block.text} markdown={block.markdown} />
      </div>)}
      {content.attachments.length > 0 && <div className="space-y-2">
        <div className="text-xs text-muted-foreground">{t("context.browser.attachments")}</div>
        <div className="flex flex-wrap gap-2">{content.attachments.map((attachment, index) => <div key={index} className="max-w-full rounded border border-border/60 px-3 py-2 text-xs">
          <div className="break-words">{attachment.name || attachment.kind}</div>
          {attachment.mime && <div className="text-muted-foreground">{attachment.mime}</div>}
        </div>)}</div>
        <p className="text-xs text-muted-foreground">{t("context.browser.mediaOmitted")}</p>
      </div>}
    </>}
  </div>;
});

function ItemRow({ item }: { item: ContextBrowserItem }) {
  const t = useT();
  return <LazyDisclosure summary={<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
    <span className="min-w-0 flex-1 break-words">{item.name !== item.label ? item.name : contextItemLabel(item.sectionId, { id: item.originalId, label: item.label }, t)}</span>
    {item.source && <span className="max-w-full break-words rounded bg-secondary px-1.5 text-muted-foreground">{item.source}</span>}
    <span className="whitespace-nowrap tabular-nums text-muted-foreground" title={item.tokens === null ? t("context.browser.missingTokens") : t("context.browser.estimatedTokens")}>
      {item.tokens === null ? "—" : `≈${formatContextTokens(item.tokens)}`} tokens
    </span>
  </div>}><ItemContent item={item} /></LazyDisclosure>;
}

export function ContextBrowser({ detail, previousDetail }: { detail: ContextRequestDetail; previousDetail: ContextRequestDetail | null }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ContextBrowserSort>("order");
  const deferredQuery = useDeferredValue(query);
  const groups = useMemo(() => contextBrowserGroups(detail, previousDetail), [detail, previousDetail]);
  const visibleGroups = useMemo(() => groups.map((group) => ({
    ...group, visible: filterContextBrowserItems(group.items, deferredQuery, sort),
  })), [groups, deferredQuery, sort]);
  return <section className="min-w-0 space-y-2" aria-label={t("context.browser.title")}>
    <div className="flex justify-end text-[10px] leading-4 text-muted-foreground">
      <span>{t(previousDetail ? "context.browser.diff" : "context.browser.noPrevious")}</span>
    </div>
    <div className="flex flex-wrap gap-2">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("context.browser.search")}
        aria-label={t("context.browser.search")} className={`min-w-0 flex-[1_1_140px] rounded-md border border-border bg-background px-2 py-1.5 text-xs ${FOCUS}`} />
      <select value={sort} onChange={(event) => setSort(event.target.value as ContextBrowserSort)} aria-label={t("context.browser.sort")}
        className={`max-w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs ${FOCUS}`}>
        {(["order", "tokens", "name"] as const).map((value) => <option key={value} value={value}>{t(`context.browser.sort.${value}`)}</option>)}
      </select>
    </div>
    <p className="text-[10px] leading-4 text-muted-foreground">{t("context.browser.scope")}</p>
    <div key={detail.request.id} className="space-y-1">
      {visibleGroups.map((group) => <LazyDisclosure key={group.category} className="rounded-md border border-border/50 bg-secondary/15" summary={<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: CATEGORY_COLORS[group.category] }} />
        <span className="font-medium">{t(`context.browser.category.${group.category}`)}</span>
        <span className="text-muted-foreground">{deferredQuery.trim() ? `${group.visible.filter((item) => !item.omitted).length}/` : ""}{group.count}</span>
        <Delta value={group.countDelta} approximate={group.incomplete} />
        <span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground" title={t(group.tokens === null ? "context.browser.missingTokens" : "context.browser.estimatedTokens")}>
          {group.tokens === null ? "—" : `≈${formatContextTokens(group.tokens)}`} tokens
        </span>
        <Delta value={group.tokenDelta} tokens />
      </div>}>
        <div className="min-w-0 border-t border-border/40 px-1 py-1">
          {group.visible.length ? group.visible.map((item) => <ItemRow key={item.id} item={item} />)
            : <p className="py-2 text-xs text-muted-foreground">{t(deferredQuery.trim() ? "context.browser.noMatch" : "context.browser.empty")}</p>}
        </div>
      </LazyDisclosure>)}
    </div>
  </section>;
}
