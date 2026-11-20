import type { TokenRequestBreakdown, TokenUsage } from "@reina/protocol";
import type { TFunc } from "./i18n";

export type ContextInputBreakdown = Partial<Pick<TokenRequestBreakdown,
  "createdAt" | "estimatedInputTokens" | "systemPromptTokens" | "toolsTokens" | "messagesTokens" | "observationsTokens" | "composition" | "projectedInputTokens"
>> & { categories?: Partial<NonNullable<TokenRequestBreakdown["categories"]>> };

export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

function tokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Only categories shipped with this request. Deferred tools, reserve and
 * nested sub-buckets must not count as additional input. */
export function contextCategories(breakdown: ContextInputBreakdown, t: TFunc): ContextCategory[] {
  const palette = ["#5b8def", "#7c5cff", "#9b6bff", "#4ab8d6", "#00a597", "#5fb878", "#c19a3a", "#c46d6d"];
  const category = (id: string, labelKey: string, value: number | undefined, color: number): ContextCategory => ({
    id, label: t(`context.category.${labelKey}`), tokens: tokens(value), color: `var(--usage-c${color}, ${palette[color - 1]})`,
  });
  const cats = breakdown.categories;
  const composition = breakdown.composition;
  const entries = composition ? [
    category("system", "system", composition.system, 1),
    category("tools", "tools", composition.tools, 4),
    category("user", "user", composition.user, 2),
    category("injected", "injected", composition.injected, 8),
    category("assistant", "assistant", composition.assistant, 6),
    category("toolResults", "toolResults", composition.toolResults, 5),
  ] : cats ? [
    category("system", "system", cats.systemPromptBase, 1),
    category("skills", "skills", cats.systemPromptSkills, 2),
    category("rules", "rules", cats.systemPromptUserRules, 3),
    category("tools", "systemTools", cats.toolsCore, 4),
    category("mcp", "mcp", cats.toolsMcp, 5),
    category("messages", "messages", cats.messages, 6),
    category("observations", "observations", cats.observations, 7),
    category("reminders", "reminders", cats.reminders, 8),
  ] : [
    category("system", "system", breakdown.systemPromptTokens, 1),
    category("tools", "tools", breakdown.toolsTokens, 4),
    category("messages", "messages", breakdown.messagesTokens, 6),
    category("observations", "observations", breakdown.observationsTokens, 7),
  ];
  const remainder = tokens(breakdown.estimatedInputTokens) - entries.reduce((sum, entry) => sum + entry.tokens, 0);
  if (remainder > 0) entries.push({ id: "other", label: t("context.category.other"), tokens: remainder, color: "var(--usage-ca, #b08a52)" });
  return entries.filter((entry) => entry.tokens > 0);
}

function reportedTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Cache reads/writes are already included in provider input. Keep the local
 * estimate separate: it describes the categories, not the provider's tokenizer. */
export function contextInputMetrics(breakdown: ContextInputBreakdown, usage?: Partial<TokenUsage>) {
  const cats = breakdown.categories;
  const categoryTotal = breakdown.composition ? Object.values(breakdown.composition).reduce((sum, value) => sum + tokens(value), 0) : cats
    ? tokens(cats.systemPromptBase) + tokens(cats.systemPromptSkills) + tokens(cats.systemPromptUserRules)
      + tokens(cats.toolsCore) + tokens(cats.toolsMcp) + tokens(cats.messages) + tokens(cats.observations) + tokens(cats.reminders)
    : tokens(breakdown.systemPromptTokens) + tokens(breakdown.toolsTokens) + tokens(breakdown.messagesTokens) + tokens(breakdown.observationsTokens);
  const estimatedInput = reportedTokens(breakdown.estimatedInputTokens) ?? categoryTotal;
  const reportedInput = reportedTokens(usage?.inputTokens);
  // Normalizers can use zero when a provider omits input usage on a nonempty request.
  const source = reportedInput !== undefined && reportedInput > 0 ? "provider" : "estimate";
  const input = source === "provider" ? reportedInput! : reportedTokens(breakdown.projectedInputTokens) ?? estimatedInput;
  const output = reportedTokens(usage?.outputTokens);
  // Occupancy always means the input carried into this request. Output is a
  // separate statistic; it only enters a later request when actually retained.
  return { input, source, estimatedInput, output, context: input, contextSource: source } as const;
}

/** While a new request is running, lastTurn can still belong to its predecessor. */
export function latestRequestUsage(usage: {
  lastRequest?: { createdAt?: string };
  lastTurn?: Partial<TokenUsage> & { createdAt?: string };
}): (Partial<TokenUsage> & { createdAt?: string }) | undefined {
  const requestedAt = Date.parse(usage.lastRequest?.createdAt ?? "");
  const reportedAt = Date.parse(usage.lastTurn?.createdAt ?? "");
  if (Number.isFinite(requestedAt) && Number.isFinite(reportedAt) && reportedAt < requestedAt) return undefined;
  return usage.lastTurn;
}
