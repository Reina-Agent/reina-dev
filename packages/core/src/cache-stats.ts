import type { TokenUsage } from "@reina/protocol";

/** Prompt-cache TTL: idle gaps longer than this are the likely cause of a
 * miss (Anthropic's default cache TTL is 5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-round misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** The last model round seen by the tracker: everything in its prompt should
 * be served from cache on the next round. Engine-held, in-memory only — after
 * a reload the first round simply isn't counted. Reset to undefined at
 * compaction boundaries (the context legitimately changed). */
export interface CacheTrackerState {
  /** Prompt size of that round. Reina's `inputTokens` is canonical-inclusive
   * (cache reads and writes are subsets), so this is `inputTokens` directly. */
  promptTokens: number;
  /** Tokens proven reusable by the provider on the next compatible request:
   * cache reads already existed, and cache writes should become reads. This is
   * deliberately conservative for read-only reporters such as OpenAI. */
  reusableTokens: number;
  /** Epoch ms when that round completed (for TTL attribution). */
  at: number;
  /** Sticky within the segment: some earlier round reported cache activity.
   * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
   * writes unreported) from a provider that never reports caching at all. */
  reportedCache: boolean;
}

/** A counted cache miss on a single model round, ported from pi's
 * cache-stats: prompt tokens that were in the previous round's prompt (and
 * should therefore be cache reads) but were re-billed instead. */
export interface CacheMiss {
  missedTokens: number;
  /** Milliseconds since the previous round (which last refreshed the cache). */
  idleMs: number;
  /** True when the idle gap exceeds CACHE_TTL_MS — the likely root cause. */
  ttlExpired: boolean;
}

/** Fold one round's provider usage into the tracker. Returns the next tracker
 * state and, when this round re-billed tokens that were cached (or cacheable)
 * on the previous round, the counted miss. Nothing is counted on the first
 * round, below the noise floor, or on providers that never report caching. */
export function trackCacheUsage(
  prev: CacheTrackerState | undefined,
  usage: Pick<TokenUsage, "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens"> | undefined,
  now: number,
): { next: CacheTrackerState | undefined; miss?: CacheMiss } {
  if (!usage) return { next: prev };
  const promptTokens = usage.inputTokens ?? 0;
  if (promptTokens <= 0) return { next: prev };
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const next: CacheTrackerState = {
    promptTokens,
    reusableTokens: Math.min(promptTokens, cacheRead + cacheWrite),
    at: now,
    reportedCache: (prev?.reportedCache ?? false) || cacheRead + cacheWrite > 0,
  };
  // A zero-cache round only counts when cache activity was reported before:
  // on cache-read-only providers that is a total miss, while on providers
  // that never report caching it means nothing.
  if (!prev || (cacheRead + cacheWrite === 0 && !prev.reportedCache)) {
    return { next };
  }
  // Only call a regression a miss. v1 used prev.promptTokens here, which
  // labelled provider cache limits and non-prefix request rewrites as waste.
  const missedTokens = Math.min(prev.reusableTokens, promptTokens) - cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return { next };
  const idleMs = Math.max(0, now - prev.at);
  return { next, miss: { missedTokens, idleMs, ttlExpired: idleMs > CACHE_TTL_MS } };
}
