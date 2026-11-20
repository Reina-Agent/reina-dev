import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { autocompactionRows, buildContextEntries, UsagePopover } from "./UsagePopover";
import { cacheReadPercent, contextTokensForDisplay } from "./usageRing";

describe("cacheReadPercent", () => {
  it("reports the share of input actually served from cache", () => {
    expect(cacheReadPercent(63_000, 23_040)).toBeCloseTo(36.571, 3);
  });

  it("does not treat unreported cache writes as a 100% hit", () => {
    expect(cacheReadPercent(20_000, 8_000)).toBe(40);
  });

  it("handles unavailable input and clamps malformed provider totals", () => {
    expect(cacheReadPercent(0, 10)).toBeUndefined();
    expect(cacheReadPercent(100, 120)).toBe(100);
    expect(cacheReadPercent(100, -1)).toBe(0);
  });
});

describe("current context accounting", () => {
  it("keeps the compressed current context separate from the preceding request", () => {
    expect(contextTokensForDisplay({
      contextTokens: 20_000, contextTokensSource: "estimate",
      lastRequest: { estimatedInputTokens: 60_464 },
      lastTurn: { inputTokens: 65_984, outputTokens: 602, totalTokens: 66_586 },
    })).toBe(20_000);
  });

  it("uses the shared full estimate including unclassified input in the fallback", () => {
    expect(contextTokensForDisplay({
      lastRequest: { estimatedInputTokens: 45, systemPromptTokens: 10, toolsTokens: 10, messagesTokens: 20 },
      lastTurn: { outputTokens: 8 },
    })).toBe(45);
  });

  it("matches the request inspector input even when the engine retains an input-plus-output anchor", () => {
    expect(contextTokensForDisplay({
      contextTokens: 66_586, contextTokensSource: "provider",
      lastRequest: { estimatedInputTokens: 60_464 },
      lastTurn: { inputTokens: 65_984, outputTokens: 602, totalTokens: 66_586, cachedInputTokens: 65_280 },
    })).toBe(65_984);
  });

  it("does not reuse an older provider total when the latest request has no usage", () => {
    expect(contextTokensForDisplay({
      lastRequest: { createdAt: "2026-09-09T05:00:00Z", estimatedInputTokens: 70_000 },
      lastTurn: { createdAt: "2026-09-09T04:54:10Z", inputTokens: 65_984, outputTokens: 602, totalTokens: 66_586 },
    })).toBe(70_000);
  });
});

describe("usage popover input accounting", () => {
  it("keeps all 100k input in the categories while reporting 20k output separately", () => {
    const usage = {
      lastRequest: { categories: { systemPromptBase: 20_000, messages: 80_000, contextWindow: 200_000 } },
      lastTurn: { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 },
    };
    const entries = buildContextEntries(usage, 200_000);
    expect(entries.find((entry) => entry.id === "sys-base")?.tokens).toBe(20_000);
    expect(entries.find((entry) => entry.id === "msg")?.tokens).toBe(80_000);
    expect(entries.find((entry) => entry.id === "free")?.tokens).toBe(100_000);
    expect(entries.some((entry) => entry.id === "out")).toBe(false);
    const html = renderToStaticMarkup(createElement(UsagePopover, {
      usage, model: { contextWindowTokens: 200_000 }, anchorRef: { current: null }, open: true, onClose: () => {},
    }));
    expect(html).toContain("<dt>Last request output</dt><dd>20.0k</dd>");
  });

  it("keeps the coarse input stack and free space correct when output exceeds input", () => {
    const usage = {
      lastRequest: { estimatedInputTokens: 10_000, systemPromptTokens: 2_000, messagesTokens: 8_000 },
      lastTurn: { inputTokens: 10_000, outputTokens: 20_000, totalTokens: 30_000 },
    };
    const entries = buildContextEntries(usage, 40_000);
    expect(entries.filter((entry) => !entry.reserved).reduce((sum, entry) => sum + entry.tokens, 0)).toBe(10_000);
    expect(entries.find((entry) => entry.id === "free")?.tokens).toBe(30_000);
    expect(entries.some((entry) => entry.id === "out")).toBe(false);
  });

  it("lists deferred tools and compaction reserve separately without consuming current free space", () => {
    const usage = {
      lastRequest: { categories: { systemPromptBase: 20_000, messages: 80_000, toolsCoreDeferred: 250_000, toolsMcpDeferred: 250_000, autocompactBuffer: 50_000, contextWindow: 200_000 } },
      lastTurn: { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 },
    };
    const entries = buildContextEntries(usage, 200_000);
    expect(entries.find((entry) => entry.id === "free")?.tokens).toBe(100_000);
    expect(entries.filter((entry) => entry.reserved && entry.id !== "free").map((entry) => entry.id)).toEqual(["tmd", "tcd", "ac"]);
    const html = renderToStaticMarkup(createElement(UsagePopover, {
      usage, model: { contextWindowTokens: 200_000 }, anchorRef: { current: null }, open: true, onClose: () => {},
    }));
    const bar = html.match(/<div class="usage-context-bar">([\s\S]*?)<\/div>/)?.[1];
    expect(bar).toContain("Free space: 100.0k (50.0%)");
    expect(bar).not.toContain("deferred");
    expect(bar).not.toContain("Autocompact buffer");
    expect(html).toContain("Reserved budget (not sent)");
    expect(html).toContain("MCP tools (deferred)");
  });
});

describe("usage popover compaction footprint", () => {
  it("uses the engine's input-plus-output anchor without changing input occupancy", () => {
    const usage = {
      contextTokens: 120_000, contextTokensSource: "provider",
      lastRequest: { categories: { autocompactThreshold: 110_000, autocompactEstimate: 95_000, contextWindow: 200_000 } },
      lastTurn: { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 },
    };
    expect(contextTokensForDisplay(usage)).toBe(100_000);
    expect(autocompactionRows(usage, undefined)).toEqual([
      ["Threshold", "110.0k (55%)"],
      ["Provider footprint (input + output)", "120.0k / 110.0k (100.0%)"],
      ["Headroom to threshold", "0"],
    ]);
  });

  it("keeps a post-compaction anchor ahead of stale pre-compaction usage and estimates", () => {
    expect(autocompactionRows({
      contextTokens: 20_000, contextTokensSource: "estimate",
      lastRequest: { categories: { autocompactThreshold: 110_000, autocompactEstimate: 95_000, contextWindow: 200_000 } },
      lastTurn: { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 },
    }, undefined)).toEqual([
      ["Threshold", "110.0k (55%)"],
      ["Post-compaction footprint", "20.0k / 110.0k (18.2%)"],
      ["Headroom to threshold", "90.0k"],
    ]);
  });

  it("uses the measured request floor after the engine clears the provider anchor", () => {
    expect(autocompactionRows({
      lastRequest: { estimatedInputTokens: 90_000, categories: { autocompactThreshold: 110_000, autocompactEstimate: 95_000, contextWindow: 200_000 } },
      lastTurn: { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 },
    }, undefined)[1]).toEqual(["Measured request footprint", "95.0k / 110.0k (86.4%)"]);
    expect(autocompactionRows({
      lastRequest: { estimatedInputTokens: 90_000, categories: { autocompactThreshold: 110_000 } },
    }, undefined)).toEqual([]);
  });
});
