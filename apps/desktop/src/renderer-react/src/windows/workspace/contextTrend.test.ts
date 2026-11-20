import { describe, expect, it } from "vitest";
import type { ContextRequestRecord, TokenRequestBreakdown } from "@reina/protocol";
import type { TFunc } from "../../lib/i18n";
import { buildContextTrend, contextTrendAnchorIndex, contextTrendEventPosition, contextTrendExtent, contextTrendKeyIndex } from "./contextTrendModel";

const t: TFunc = (key) => key;

function request(id: string, turnId: string, input: number, values = { system: 20, messages: 80, tools: 0 }): ContextRequestRecord {
  const estimatedInputTokens = values.system + values.messages + values.tools;
  const breakdown: TokenRequestBreakdown = {
    createdAt: `2026-09-09T00:00:${id.padStart(2, "0")}Z`, provider: "test", model: "test", messagesCount: 1,
    observationsCount: 0, toolsCount: 0, systemPromptChars: values.system * 4, systemPromptTokens: values.system,
    messagesChars: values.messages * 4, messagesTokens: values.messages, observationsChars: 0, observationsTokens: 0,
    toolsDescriptionChars: 0, toolsSchemaChars: 0, toolsTokens: values.tools, totalChars: estimatedInputTokens * 4,
    estimatedInputTokens, toolNames: [],
  };
  return { id, startedAt: breakdown.createdAt, breakdown, sessionId: "session", turnId, attempt: 1, status: "completed", provider: "test", model: "test", usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10, cachedInputTokens: input * 0.8 } };
}

describe("context trend occupancy", () => {
  it("calibrates the category stack to full input without adding output or cache", () => {
    const [bar] = buildContextTrend([request("1", "a", 200)], "step", "total", t);
    expect(bar?.input).toBe(200);
    expect(bar?.categories.reduce((sum, category) => sum + category.value, 0)).toBe(200);
    expect(bar?.categories.find((category) => category.id === "system")).toMatchObject({ tokens: 20, value: 40 });
    expect(bar?.positive).toBe(200);
  });

  it("uses the estimate until usage is available", () => {
    const pending = { ...request("1", "a", 200), usage: undefined };
    expect(buildContextTrend([pending], "step", "total", t)[0]?.input).toBe(100);
  });

  it("plots reported input as unclassified if an older record lacks all estimates", () => {
    const [bar] = buildContextTrend([request("1", "a", 50, { system: 0, messages: 0, tools: 0 })], "step", "total", t);
    expect(bar?.categories).toEqual([{ id: "other", label: "context.category.other", color: "var(--muted-foreground)", tokens: 0, value: 50 }]);
  });

  it("represents a turn with its final attempt and retains all member ids for selection", () => {
    const requests = [request("1", "a", 100), request("2", "a", 140), request("3", "b", 160)];
    requests[1]!.attempt = 2;
    const bars = buildContextTrend(requests, "turn", "total", t);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ request: { id: "2", attempt: 2 }, input: 140, requestIds: ["1", "2"], firstIndex: 0, lastIndex: 1, turnNumber: 1 });
    expect(bars[1]).toMatchObject({ input: 160, requestIds: ["3"], turnNumber: 2 });
  });

  it("does not combine nonconsecutive turn ids or requests from another session", () => {
    const requests = [request("1", "a", 100), request("2", "b", 110), request("3", "a", 120), { ...request("4", "a", 130), sessionId: "other" }];
    expect(buildContextTrend(requests, "turn", "total", t).map((bar) => bar.turnNumber)).toEqual([1, 2, 3, 4]);
  });
});

describe("context trend signed deltas", () => {
  it("leaves the first retained point at zero when its predecessor is unknown", () => {
    const [bar] = buildContextTrend([request("1", "a", 200)], "step", "delta", t);
    expect(bar).toMatchObject({ net: 0, positive: 0, negative: 0 });
    expect(bar?.categories.every((category) => category.value === 0)).toBe(true);
  });

  it("keeps simultaneous category growth and shrinkage on opposite sides of zero", () => {
    const bars = buildContextTrend([request("1", "a", 100), request("2", "a", 60, { system: 20, messages: 30, tools: 0 })], "step", "delta", t);
    expect(bars[1]).toMatchObject({ net: -40, positive: 4, negative: 44 });
    expect(bars[1]?.categories.find((category) => category.id === "system")?.value).toBe(4);
    expect(bars[1]?.categories.find((category) => category.id === "messages")?.value).toBe(-44);
    expect(contextTrendExtent(bars, "delta")).toEqual({ positive: 4, negative: 44 });
  });

  it("preserves removed categories as negative segments", () => {
    const bars = buildContextTrend([request("1", "a", 100, { system: 20, messages: 60, tools: 20 }), request("2", "a", 80, { system: 20, messages: 60, tools: 0 })], "step", "delta", t);
    expect(bars[1]?.categories.find((category) => category.id === "tools")).toMatchObject({ tokens: 0, value: -20 });
    expect(bars[1]).toMatchObject({ net: -20, positive: 0, negative: 20 });
  });

  it("compares consecutive turn endpoints instead of summing their step deltas", () => {
    const requests = [request("1", "a", 100), request("2", "a", 120), request("3", "b", 80), request("4", "b", 90)];
    expect(buildContextTrend(requests, "turn", "delta", t).map((bar) => bar.net)).toEqual([0, -30]);
  });

  it("keeps empty and flat scales finite, and includes the threshold only in total mode", () => {
    expect(contextTrendExtent([], "total")).toEqual({ positive: 1, negative: 0 });
    expect(contextTrendExtent([], "delta")).toEqual({ positive: 1, negative: 0 });
    const item = request("1", "a", 100);
    item.breakdown.categories = { systemPromptBase: 20, systemPromptSkills: 0, systemPromptUserRules: 0, toolsCore: 0, toolsMcp: 0, messages: 80, observations: 0, reminders: 0, toolsCoreDeferred: 0, toolsMcpDeferred: 0, toolsCoreActiveDeferred: 0, toolsMcpActiveDeferred: 0, hiddenToolsReminder: 0, autocompactBuffer: 0, autocompactThreshold: 400, autocompactEstimate: 100, freeSpace: 400, contextWindow: 500 };
    expect(contextTrendExtent(buildContextTrend([item], "step", "total", t), "total").positive).toBe(400);
    expect(contextTrendExtent(buildContextTrend([item], "step", "delta", t), "delta").positive).toBe(1);
  });
});

describe("context trend navigation and event positions", () => {
  it("anchors Live to the newest bar without making it a selected historical request", () => {
    const bars = buildContextTrend([request("1", "a", 100), request("2", "a", 120), request("3", "b", 90)], "turn", "total", t);
    expect(contextTrendAnchorIndex(bars, "live")).toBe(1);
    expect(bars.some((bar) => bar.requestIds.includes("live"))).toBe(false);
    expect(contextTrendAnchorIndex(bars, "1")).toBe(0);
    expect(contextTrendAnchorIndex(bars, "2")).toBe(0);
    expect(contextTrendAnchorIndex(bars, "3")).toBe(1);
    expect(contextTrendAnchorIndex([], "live")).toBe(-1);
  });

  it("maps compactions within aggregated turns and keeps end events visible", () => {
    const requests = [request("10", "a", 100), request("20", "a", 120), request("30", "b", 90)];
    const bars = buildContextTrend(requests, "turn", "total", t);
    expect(contextTrendEventPosition(requests, bars, "2026-09-09T00:00:15Z")).toBe(0.5);
    expect(contextTrendEventPosition(requests, bars, "2026-09-09T00:00:25Z")).toBe(1);
    expect(contextTrendEventPosition(requests, bars, "2026-09-09T00:00:05Z")).toBe(0);
    expect(contextTrendEventPosition(requests, bars, "2026-09-09T00:00:40Z")).toBe(2);
  });

  it("clamps keyboard navigation and ignores keys belonging to native buttons", () => {
    expect(contextTrendKeyIndex("ArrowLeft", 0, 3)).toBe(0);
    expect(contextTrendKeyIndex("ArrowRight", 2, 3)).toBe(2);
    expect(contextTrendKeyIndex("ArrowRight", 0, 3)).toBe(1);
    expect(contextTrendKeyIndex("Home", 2, 3)).toBe(0);
    expect(contextTrendKeyIndex("End", 0, 3)).toBe(2);
    expect(contextTrendKeyIndex("Enter", 0, 3)).toBeNull();
    expect(contextTrendKeyIndex("Home", 0, 0)).toBeNull();
  });
});
