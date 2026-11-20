import { describe, expect, it } from "vitest";
import type { ContextRequestRecord } from "@reina/protocol";
import { contextStatistics, contextTimeline } from "./contextDashboard";

const request = (patch: Partial<ContextRequestRecord>): ContextRequestRecord => ({
  id: "a", sessionId: "session", turnId: "turn", attempt: 1, status: "completed", provider: "test", model: "one",
  startedAt: "2026-09-10T00:00:00Z", breakdown: {} as ContextRequestRecord["breakdown"], ...patch,
});

describe("retained context statistics", () => {
  it("uses reported input for cache hit rate and keeps missing usage out of billing totals", () => {
    const stats = contextStatistics([
      request({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 60, cacheCreationInputTokens: 10 }, completedAt: "2026-09-10T00:00:02Z" }),
      request({ id: "b", breakdown: { estimatedInputTokens: 500 } as ContextRequestRecord["breakdown"], status: "failed" }),
      request({ id: "c", turnId: "next", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 40 } }),
    ]);
    expect(stats).toMatchObject({ requests: 3, turns: 2, reported: 2, input: 200, output: 30, cached: 100, cacheWrite: 10, uncached: 90, cachePercent: 50, modelMs: 2000 });
  });

  it("does not allow overlapping cache counters to produce negative uncached input", () => {
    expect(contextStatistics([request({ usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cachedInputTokens: 90, cacheCreationInputTokens: 50 } })])).toMatchObject({ cached: 90, cacheWrite: 10, uncached: 0 });
    expect(contextStatistics([request({})]).cachePercent).toBeUndefined();
  });

  it("marks a provider or model change only where the history proves a transition", () => {
    const timeline = contextTimeline([request({}), request({ id: "b", model: "two", startedAt: "2026-09-10T00:00:02Z" })], [{ id: "compact", createdAt: "2026-09-10T00:00:01Z", status: "completed" }]);
    expect(timeline.map((event) => event.kind)).toEqual(["compact", "switch"]);
    expect(timeline[1]).toMatchObject({ from: "test / one", to: "test / two", requestId: "b" });
  });
});
