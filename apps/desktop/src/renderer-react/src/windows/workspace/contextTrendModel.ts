import type { ContextRequestRecord } from "@reina/protocol";
import type { TFunc } from "../../lib/i18n";
import { contextCategories, contextEventPosition, contextInputTokens } from "./contextHistory";

export type ContextTrendGranularity = "step" | "turn";
export type ContextTrendMode = "total" | "delta";

export interface ContextTrendCategory {
  id: string;
  label: string;
  color: string;
  /** Original local estimate; the provider does not report category usage. */
  tokens: number;
  /** Plotting value, calibrated to input usage; signed in delta mode. */
  value: number;
}

export interface ContextTrendBar {
  request: ContextRequestRecord;
  requestIds: string[];
  firstIndex: number;
  lastIndex: number;
  turnNumber: number;
  categories: ContextTrendCategory[];
  input: number;
  net: number;
  positive: number;
  negative: number;
}

/** Turn occupancy is its last request, never the sum of repeated context reads. */
export function buildContextTrend(
  requests: ContextRequestRecord[],
  granularity: ContextTrendGranularity,
  mode: ContextTrendMode,
  t: TFunc,
): ContextTrendBar[] {
  const bars: ContextTrendBar[] = [];
  let turnNumber = 0;
  for (const [index, request] of requests.entries()) {
    const previous = requests[index - 1];
    if (!previous || previous.turnId !== request.turnId || previous.sessionId !== request.sessionId) turnNumber++;
    const input = contextInputTokens(request);
    const entries = contextCategories(request.breakdown, t);
    const estimate = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const categories: ContextTrendCategory[] = estimate > 0
      ? entries.map((entry) => ({ ...entry, value: entry.tokens / estimate * input }))
      : input > 0 ? [{ id: "other", label: t("context.category.other"), color: "var(--muted-foreground)", tokens: 0, value: input }] : [];
    const last = bars.at(-1);
    const sameTurn = granularity === "turn" && last?.turnNumber === turnNumber;
    const bar: ContextTrendBar = {
      request,
      requestIds: sameTurn ? [...last.requestIds, request.id] : [request.id],
      firstIndex: sameTurn ? last.firstIndex : index,
      lastIndex: index,
      turnNumber,
      categories,
      input,
      net: input,
      positive: input,
      negative: 0,
    };
    if (sameTurn) bars[bars.length - 1] = bar;
    else bars.push(bar);
  }
  if (mode === "total") return bars;
  return bars.map((bar, index) => {
    const previous = bars[index - 1];
    const current = new Map(bar.categories.map((category) => [category.id, category]));
    const before = new Map(previous?.categories.map((category) => [category.id, category]) ?? []);
    const ids = new Set([...current.keys(), ...before.keys()]);
    const categories = [...ids].map((id) => {
      const category = current.get(id) ?? { ...before.get(id)!, tokens: 0 };
      // The retained history may begin mid-session. No predecessor means no
      // known delta; drawing its entire input would dwarf later changes.
      return { ...category, value: previous ? (current.get(id)?.value ?? 0) - (before.get(id)?.value ?? 0) : 0 };
    });
    return {
      ...bar,
      categories,
      net: previous ? bar.input - previous.input : 0,
      positive: categories.reduce((sum, category) => sum + Math.max(0, category.value), 0),
      negative: categories.reduce((sum, category) => sum + Math.max(0, -category.value), 0),
    };
  });
}

/** The same token must have the same height above and below the zero line. */
export function contextTrendExtent(bars: ContextTrendBar[], mode: ContextTrendMode): { positive: number; negative: number } {
  if (mode === "delta") {
    const positive = Math.max(0, ...bars.map((bar) => bar.positive));
    const negative = Math.max(0, ...bars.map((bar) => bar.negative));
    return { positive: positive || (negative ? 0 : 1), negative };
  }
  return {
    positive: Math.max(1, ...bars.map((bar) => Math.max(bar.input, bar.request.breakdown.categories?.autocompactThreshold ?? 0))),
    negative: 0,
  };
}

/** Preserve an event's position inside a turn when several steps collapse. */
export function contextTrendEventPosition(requests: ContextRequestRecord[], bars: ContextTrendBar[], createdAt: string): number {
  const position = contextEventPosition(requests, createdAt);
  for (const [index, bar] of bars.entries()) {
    if (position < bar.lastIndex + 1) return index + Math.max(0, position - bar.firstIndex) / (bar.lastIndex - bar.firstIndex + 1);
  }
  return bars.length;
}

export function contextTrendKeyIndex(key: string, index: number, length: number): number | null {
  if (!length) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(length - 1, index + 1);
  return null;
}

/** Live is not a historical bar. Anchor its viewport and keyboard entry to
 * the newest point without marking that request as the fixed selection. */
export function contextTrendAnchorIndex(bars: ContextTrendBar[], selectedId: string): number {
  const index = bars.findIndex((bar) => bar.requestIds.includes(selectedId));
  return index < 0 ? bars.length - 1 : index;
}
