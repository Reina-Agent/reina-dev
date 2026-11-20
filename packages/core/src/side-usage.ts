import type { SessionState, TokenUsage } from "@reina/protocol";

/** Fold a single-shot side request's token usage (compaction summary,
 * auto-title, autopilot verifier) into the session bill. These calls used to
 * drop `turn.usage` on the floor — real spend invisible to session totals and
 * the UsagePopover. Mirrors rollupChildUsage's shape: the grand totals move,
 * and a side* breakdown keeps the line item separable. (pi #6671 made the
 * same fix for its compaction/branch-summary entries.) */
export function rollupSideUsage(session: SessionState, usage: TokenUsage | undefined): void {
  if (!usage) return;
  if (!session.usage) {
    session.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, turns: 0 };
  }
  const u = session.usage;
  u.inputTokens += usage.inputTokens ?? 0;
  u.outputTokens += usage.outputTokens ?? 0;
  u.cachedInputTokens += usage.cachedInputTokens ?? 0;
  u.cacheCreationInputTokens = (u.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  u.reasoningTokens += usage.reasoningTokens ?? 0;
  u.sideInputTokens = (u.sideInputTokens ?? 0) + (usage.inputTokens ?? 0);
  u.sideOutputTokens = (u.sideOutputTokens ?? 0) + (usage.outputTokens ?? 0);
  u.sideCachedInputTokens = (u.sideCachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
}
