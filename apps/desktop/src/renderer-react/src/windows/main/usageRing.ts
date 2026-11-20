// Composer usage-ring math — a faithful port of the legacy renderer's
// renderUsageChip + its token-accounting chain (actions/session.js:
// contextTokensForDisplay / providerContextTokens / postCompactContextTokens /
// localContextTokens / resolveContextWindow, and session-helpers.js formatTokens).
//
// Pure functions over the engine's per-session `usage` object (which rides on the
// session snapshot, untyped). Cost/pricing lines from the legacy tooltip are
// intentionally omitted (they need the model pricing table, not wired in React).

// ── Loose shape of the engine session-level usage object ─────────────────────

import { contextInputMetrics, latestRequestUsage } from "../../lib/contextUsage";

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  childInputTokens?: number;
  childOutputTokens?: number;
  /** Single-shot side requests (compaction summary, auto-title, autopilot
   * verifier) rolled into the totals — see core/side-usage.ts. */
  sideInputTokens?: number;
  sideOutputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  turns?: number;
  contextTokens?: number;
  contextTokensSource?: string;
  /** Cumulative prompt-cache waste (engine cache-stats): tokens re-billed
   * that should have been cache reads, plus how many rounds missed. */
  cacheWaste?: {
    missedTokens?: number;
    missCount?: number;
    method?: "reusable-prefix-v2";
  };
  requestTotals?: { estimatedInputTokens?: number };
  lastRequest?: {
    createdAt?: string;
    categories?: UsageCategories;
    systemPromptTokens?: number;
    toolsTokens?: number;
    messagesTokens?: number;
    observationsTokens?: number;
    estimatedInputTokens?: number;
    toolDetails?: UsageToolDetail[];
  };
  lastTurn?: {
    createdAt?: string;
    totalTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    outputTokens?: number;
  };
}

export interface UsageCategories {
  contextWindow?: number;
  systemPromptBase?: number;
  systemPromptSkills?: number;
  systemPromptUserRules?: number;
  toolsCore?: number;
  toolsMcp?: number;
  messages?: number;
  observations?: number;
  reminders?: number;
  // Reserved tiers — committed to the model's budget but not in this request.
  toolsCoreDeferred?: number;
  toolsMcpDeferred?: number;
  autocompactBuffer?: number;
  // Autocompaction trigger accounting.
  autocompactThreshold?: number;
  autocompactEstimate?: number;
}

export interface UsageToolDetail {
  name: string;
  tokens?: number;
  mcp?: boolean;
  deferred?: boolean;
}

export interface UsageModelRef {
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
}

export interface UsageRingView {
  level: "ok" | "warning" | "danger";
  /** Centre label — formatTokens(contextTokens), or "0"/"-". */
  label: string;
  /** SVG stroke-dasharray for the ring fill: `${percent} ${100 - percent}`. */
  dasharray: string;
  ariaLabel: string;
  /** Multi-line tooltip (mirror of the legacy chip title). */
  title: string;
}

// ── formatTokens (session-helpers.js) ────────────────────────────────────────

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Percentage of request input actually served from cache. Cache writes are a
 * different billing category, not the denominator of a cache-hit rate. */
export function cacheReadPercent(inputTokens: number | undefined, cachedInputTokens: number | undefined): number | undefined {
  const input = Number(inputTokens) || 0;
  if (input <= 0) return undefined;
  const cached = Math.min(input, Math.max(0, Number(cachedInputTokens) || 0));
  return (cached / input) * 100;
}

// ── Context-window resolution (resolveContextWindow) ─────────────────────────

export function resolveContextWindow(model: UsageModelRef | undefined, knownModels: UsageModelRef[] = []): number {
  if (!model) return 200_000;
  if (typeof model.contextWindowTokens === "number" && model.contextWindowTokens > 0) {
    return model.contextWindowTokens;
  }
  const known = knownModels.find((m) => m.provider === model.provider && m.model === model.model);
  if (known?.contextWindowTokens) return known.contextWindowTokens;
  return 200_000;
}

// ── Context-token accounting chain ───────────────────────────────────────────

export function lastOutputTokens(usage: SessionUsage): number {
  const n = latestRequestUsage(usage)?.outputTokens || 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function activeCategoryTokens(usage: SessionUsage): number | undefined {
  const cats = usage.lastRequest?.categories;
  if (!cats) return undefined;
  const sum =
    (cats.systemPromptBase || 0) +
    (cats.systemPromptSkills || 0) +
    (cats.systemPromptUserRules || 0) +
    (cats.toolsCore || 0) +
    (cats.toolsMcp || 0) +
    (cats.messages || 0) +
    (cats.observations || 0) +
    (cats.reminders || 0);
  return sum > 0 ? sum : undefined;
}

function localContextTokens(usage: SessionUsage): number | undefined {
  if (!usage.lastRequest) return undefined;
  const value = contextInputMetrics(usage.lastRequest, latestRequestUsage(usage)).context;
  return value > 0 ? value : undefined;
}

function providerContextTokens(usage: SessionUsage): number | undefined {
  // A post-compaction re-anchor (source "estimate") defers to the estimate path.
  if (usage.contextTokensSource === "estimate") return undefined;
  const last = latestRequestUsage(usage);
  if (typeof last?.inputTokens === "number" && Number.isFinite(last.inputTokens) && last.inputTokens > 0) {
    return Math.floor(last.inputTokens);
  }
  return undefined;
}

function postCompactContextTokens(usage: SessionUsage): number | undefined {
  if (
    usage.contextTokensSource === "estimate" &&
    typeof usage.contextTokens === "number" &&
    Number.isFinite(usage.contextTokens) &&
    usage.contextTokens > 0
  ) {
    return Math.floor(usage.contextTokens);
  }
  return undefined;
}

export function contextTokensForDisplay(usage: SessionUsage): number | undefined {
  return providerContextTokens(usage) ?? postCompactContextTokens(usage) ?? localContextTokens(usage);
}

function contextTokensSource(usage: SessionUsage): string {
  if (providerContextTokens(usage) !== undefined) return "provider usage";
  if (postCompactContextTokens(usage) !== undefined) return "post-compaction estimate (o200k)";
  if (localContextTokens(usage) !== undefined) {
    return "local input estimate (o200k)";
  }
  return "unavailable";
}

// ── Ring view (renderUsageChip, minus cost/pricing) ──────────────────────────

export function computeUsageRing(
  usage: SessionUsage | undefined,
  model: UsageModelRef | undefined,
  knownModels: UsageModelRef[] = [],
): UsageRingView {
  const contextWindow = usage?.lastRequest?.categories?.contextWindow || resolveContextWindow(model, knownModels);

  // Empty state — no usage yet (mirror renderEmptyUsageChip).
  if (!usage || ((usage.turns ?? 0) === 0 && !usage.lastRequest)) {
    return {
      level: "ok",
      label: "0",
      dasharray: "0 100",
      ariaLabel: "Context window usage 0",
      title: `Context: 0 / ${formatTokens(contextWindow)} (0.0%)\nSource: no usage yet`,
    };
  }

  const totalInput = usage.inputTokens || 0;
  const totalOutput = usage.outputTokens || 0;
  const childInput = usage.childInputTokens || 0;
  const childOutput = usage.childOutputTokens || 0;
  const selfInput = Math.max(0, totalInput - childInput);
  const selfOutput = Math.max(0, totalOutput - childOutput);
  const selfTotal = selfInput + selfOutput;
  const childTotal = childInput + childOutput;
  const grandTotal = totalInput + totalOutput;

  // Estimate-aware display for providers that don't report prompt_tokens (the
  // "~" signals the local o200k estimate, not a provider-authoritative count).
  const estTotalInput = usage.requestTotals?.estimatedInputTokens || 0;
  const useEstInput = totalInput === 0 && estTotalInput > 0;
  const displaySelfInput = useEstInput
    ? `~${Math.max(0, estTotalInput - childInput).toLocaleString()}`
    : selfInput.toLocaleString();
  const displaySelfTotal = useEstInput
    ? `~${(Math.max(0, estTotalInput - childInput) + selfOutput).toLocaleString()}`
    : selfTotal.toLocaleString();
  const displayGrandTotal = useEstInput
    ? `~${(estTotalInput + totalOutput).toLocaleString()}`
    : grandTotal.toLocaleString();

  const contextTokens = contextTokensForDisplay(usage);
  const hasContextTokens = contextTokens !== undefined;
  const percent = hasContextTokens
    ? Math.min(100, Math.max(0, ((contextTokens as number) / contextWindow) * 100))
    : 0;
  const level: UsageRingView["level"] = percent >= 80 ? "danger" : percent >= 50 ? "warning" : "ok";

  const title = [
    hasContextTokens
      ? `Context: ${formatTokens(contextTokens as number)} / ${formatTokens(contextWindow)} (${percent.toFixed(1)}%)`
      : `Context: unavailable / ${formatTokens(contextWindow)}`,
    `Source: ${contextTokensSource(usage)}`,
    "",
    `Self: ${displaySelfTotal} tok (in ${displaySelfInput} / out ${selfOutput.toLocaleString()})`,
    childTotal > 0
      ? `Subagents: ${childTotal.toLocaleString()} tok (in ${childInput.toLocaleString()} / out ${childOutput.toLocaleString()})`
      : "",
    `Total: ${displayGrandTotal} tok`,
    `Cached input: ${(usage.cachedInputTokens || 0).toLocaleString()}`,
    `Reasoning: ${(usage.reasoningTokens || 0).toLocaleString()}`,
    `Turns: ${usage.turns ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    level,
    label: hasContextTokens ? formatTokens(contextTokens as number) : "-",
    dasharray: `${percent} ${100 - percent}`,
    ariaLabel: hasContextTokens
      ? `Context window usage ${formatTokens(contextTokens as number)}`
      : "Context window usage unavailable",
    title,
  };
}
