import { describe, expect, it } from "vitest";
import { contextCategories, contextInputMetrics, latestRequestUsage } from "./contextUsage";
import { translate } from "./i18n";

const breakdown = {
  createdAt: "2026-09-09T04:53:45.917Z",
  estimatedInputTokens: 60_464,
  categories: {
    systemPromptBase: 1_880, systemPromptSkills: 2_980, systemPromptUserRules: 0,
    toolsCore: 4_537, toolsMcp: 4_958, messages: 45_624, observations: 420, reminders: 65,
    toolsCoreDeferred: 10_676, autocompactBuffer: 76_800, contextWindow: 256_000,
  },
};
const reported = { inputTokens: 65_984, outputTokens: 602, totalTokens: 66_586, cachedInputTokens: 65_280, cacheCreationInputTokens: 0 };

describe("shared context accounting", () => {
  it("reconciles the inspected request without scaling categories or adding cache twice", () => {
    expect(contextInputMetrics(breakdown, reported)).toEqual({
      input: 65_984, source: "provider", estimatedInput: 60_464, output: 602,
      context: 65_984, contextSource: "provider",
    });
    const entries = contextCategories(breakdown, (key) => translate("en", key));
    expect(entries.reduce((sum, item) => sum + item.tokens, 0)).toBe(60_464);
    expect(entries.find((item) => item.id === "system")?.tokens).toBe(1_880);
    expect(entries.find((item) => item.id === "tools")?.tokens).toBe(4_537);
  });

  it("uses local estimates until input usage is reported, preserving output-only reports", () => {
    expect(contextInputMetrics(breakdown)).toMatchObject({ input: 60_464, output: undefined, source: "estimate", contextSource: "estimate" });
    expect(contextInputMetrics(breakdown, { inputTokens: 0, outputTokens: 8 })).toMatchObject({ input: 60_464, context: 60_464, output: 8, source: "estimate", contextSource: "estimate" });
  });

  it("uses provider input even when total usage includes a large output", () => {
    expect(contextInputMetrics(breakdown, { inputTokens: 99, outputTokens: 900, totalTokens: 999 })).toMatchObject({ input: 99, source: "provider", context: 99, contextSource: "provider" });
  });

  it("keeps six-category estimates separate from a calibrated live projection", () => {
    const live = { estimatedInputTokens: 100, projectedInputTokens: 125, composition: { system: 10, tools: 20, user: 15, injected: 5, assistant: 20, toolResults: 30 } };
    expect(contextInputMetrics(live)).toMatchObject({ input: 125, context: 125, estimatedInput: 100, source: "estimate" });
    const categories = contextCategories(live, (key) => translate("en", key));
    expect(categories.map((item) => item.id)).toEqual(["system", "tools", "user", "injected", "assistant", "toolResults"]);
    expect(categories.reduce((sum, item) => sum + item.tokens, 0)).toBe(100);
    expect(contextInputMetrics(live, { inputTokens: 120 })).toMatchObject({ input: 120, source: "provider" });
  });

  it("handles older breakdowns and missing or malformed usage without inventing a report", () => {
    expect(contextInputMetrics({ systemPromptTokens: 10, toolsTokens: 5, messagesTokens: 20 })).toMatchObject({ input: 35, estimatedInput: 35, source: "estimate" });
    expect(contextInputMetrics(breakdown, { inputTokens: NaN, outputTokens: -5, totalTokens: Infinity })).toMatchObject({ input: 60_464, output: undefined, context: 60_464, contextSource: "estimate" });
    expect(contextInputMetrics({ estimatedInputTokens: 0 }, { inputTokens: 0, outputTokens: 0 })).toMatchObject({ input: 0, context: 0, source: "estimate" });
  });

  it("does not attach a previous request's input, output or cache to a pending request", () => {
    const previous = { ...reported, createdAt: "2026-09-09T04:52:00Z" };
    expect(latestRequestUsage({ lastRequest: breakdown, lastTurn: previous })).toBeUndefined();
    expect(contextInputMetrics(breakdown, latestRequestUsage({ lastRequest: breakdown, lastTurn: previous }))).toMatchObject({ input: 60_464, source: "estimate", output: undefined });
    const completed = { ...reported, createdAt: "2026-09-09T04:54:10.583Z" };
    expect(latestRequestUsage({ lastRequest: breakdown, lastTurn: completed })).toBe(completed);
    expect(latestRequestUsage({ lastTurn: reported })).toBe(reported);
  });
});
