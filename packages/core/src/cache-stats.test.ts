import { describe, expect, it } from "vitest";
import { CACHE_TTL_MS, trackCacheUsage, type CacheTrackerState } from "./cache-stats.js";

/** Per-round prompt-cache miss detection, ported from pi's cache-stats.
 * Reina's TokenUsage is canonical-inclusive: `inputTokens` already contains
 * cache reads and writes, so the previous round's prompt size is just
 * `inputTokens`. A miss = tokens that were in the previous request's prompt
 * (and should therefore be cache reads) but were re-billed instead. */

const T0 = 1_000_000;

function seeded(overrides?: Partial<CacheTrackerState>): CacheTrackerState {
  return { promptTokens: 20_000, reusableTokens: 20_000, at: T0, reportedCache: true, ...overrides };
}

describe("trackCacheUsage", () => {
  it("seeds the tracker on the first round without counting a miss", () => {
    const { next, miss } = trackCacheUsage(
      undefined,
      { inputTokens: 20_000, cachedInputTokens: 0, cacheCreationInputTokens: 20_000 },
      T0,
    );
    expect(miss).toBeUndefined();
    expect(next).toEqual({ promptTokens: 20_000, reusableTokens: 20_000, at: T0, reportedCache: true });
  });

  it("does not count a full cache hit", () => {
    const { miss } = trackCacheUsage(
      seeded(),
      { inputTokens: 21_000, cachedInputTokens: 20_000, cacheCreationInputTokens: 1_000 },
      T0 + 1_000,
    );
    expect(miss).toBeUndefined();
  });

  it("counts a total miss (previous prompt re-billed in full)", () => {
    const { miss } = trackCacheUsage(
      seeded(),
      { inputTokens: 21_000, cachedInputTokens: 0, cacheCreationInputTokens: 21_000 },
      T0 + 60_000,
    );
    expect(miss).toEqual({ missedTokens: 20_000, idleMs: 60_000, ttlExpired: false });
  });

  it("counts a partial miss and flags idle gaps past the cache TTL", () => {
    const { miss } = trackCacheUsage(
      seeded(),
      { inputTokens: 22_000, cachedInputTokens: 10_000, cacheCreationInputTokens: 12_000 },
      T0 + CACHE_TTL_MS + 1,
    );
    expect(miss).toEqual({ missedTokens: 10_000, idleMs: CACHE_TTL_MS + 1, ttlExpired: true });
  });

  it("ignores misses at or below the noise floor (cache breakpoint granularity)", () => {
    const { miss } = trackCacheUsage(
      seeded(),
      { inputTokens: 21_000, cachedInputTokens: 19_000, cacheCreationInputTokens: 2_000 },
      T0 + 1_000,
    );
    expect(miss).toBeUndefined();
  });

  it("counts nothing for providers that never report cache activity", () => {
    // Two rounds of pure input with no cache fields ever seen: the provider
    // does not support/report caching, so a zero-cache round means nothing.
    const first = trackCacheUsage(undefined, { inputTokens: 20_000 }, T0);
    expect(first.next).toEqual({ promptTokens: 20_000, reusableTokens: 0, at: T0, reportedCache: false });
    const second = trackCacheUsage(first.next, { inputTokens: 21_000 }, T0 + 1_000);
    expect(second.miss).toBeUndefined();
  });

  it("counts a zero-cache round as a total miss once cache activity was reported before", () => {
    // OpenAI-style read-only reporting: writes are invisible, so a round with
    // cachedInputTokens=0 after a segment that DID report cache is a total miss.
    const { miss } = trackCacheUsage(
      seeded({ reportedCache: true }),
      { inputTokens: 21_000, cachedInputTokens: 0 },
      T0 + 1_000,
    );
    expect(miss?.missedTokens).toBe(20_000);
  });

  it("keeps the sticky reportedCache flag across zero-cache rounds", () => {
    const { next } = trackCacheUsage(
      seeded({ reportedCache: true }),
      { inputTokens: 21_000, cachedInputTokens: 0 },
      T0 + 1_000,
    );
    expect(next?.reportedCache).toBe(true);
  });

  it("keeps the previous state when a round reports no usage", () => {
    const prev = seeded();
    const { next, miss } = trackCacheUsage(prev, undefined, T0 + 1_000);
    expect(miss).toBeUndefined();
    expect(next).toBe(prev);
  });

  it("keeps the previous state when a round reports zero prompt tokens", () => {
    const prev = seeded();
    const { next, miss } = trackCacheUsage(prev, { inputTokens: 0 }, T0 + 1_000);
    expect(miss).toBeUndefined();
    expect(next).toBe(prev);
  });

  it("uses the smaller of the two prompts when the prompt shrank (post-trim)", () => {
    // The prompt legitimately shrank (observation trim): only the part that
    // was in BOTH prompts can be a re-billed miss.
    const { miss } = trackCacheUsage(
      seeded({ promptTokens: 30_000, reusableTokens: 30_000 }),
      { inputTokens: 10_000, cachedInputTokens: 0, cacheCreationInputTokens: 10_000 },
      T0 + 1_000,
    );
    expect(miss?.missedTokens).toBe(10_000);
  });

  it("does not label a stable provider cache ceiling as new waste", () => {
    const first = trackCacheUsage(
      seeded({ promptTokens: 60_000, reusableTokens: 23_040 }),
      { inputTokens: 63_000, cachedInputTokens: 23_040 },
      T0 + 1_000,
    );
    expect(first.miss).toBeUndefined();
    expect(first.next?.reusableTokens).toBe(23_040);
  });
});
