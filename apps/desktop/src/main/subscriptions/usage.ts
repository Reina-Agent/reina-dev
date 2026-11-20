// Live subscription usage (rate-limit windows) for connected OAuth accounts,
// fetched from the same endpoints the official CLIs use:
//
//   Claude: GET api.anthropic.com/api/oauth/usage
//           -> { five_hour|seven_day|seven_day_opus|seven_day_sonnet:
//                { utilization: 0-100, resets_at: ISO } , extra_usage: {...} }
//   Codex:  GET chatgpt.com/backend-api/wham/usage
//           -> { rate_limit: { primary_window|secondary_window:
//                { used_percent, limit_window_seconds, reset_at: unix } } }
//
// Both are normalized to a flat list of {name,label,utilization,resetsAt} tiers
// so the renderer shows them the same way regardless of provider.

import { fetchKimiUsageTiers } from "./kimi.js";
import type { SubscriptionKind } from "./types.js";

export type UsageTier = {
  /** Stable window id (five_hour, seven_day, seven_day_opus, …). */
  name: string;
  /** Short display label (5h, 7d, …). */
  label: string;
  /** Percent used, 0–100. */
  utilization: number;
  /** ISO 8601 reset time, if the provider reported one. */
  resetsAt?: string;
};

export type UsageSnapshot = {
  ok: boolean;
  tiers: UsageTier[];
  error?: string;
  /** True when the fetch failed with 401/403 — caller can force a token
   * refresh and retry. */
  authError?: boolean;
  /** Epoch ms the snapshot was taken (drives the "x minutes ago" label). */
  queriedAt: number;
};

/** seven_day_sonnet duplicates the seven_day window for most plans; hide it to
 * keep the inline row compact (matches the official CLIs' compact view). */
const HIDDEN_TIERS = new Set(["seven_day_sonnet"]);

function authError(message: string): Error {
  return Object.assign(new Error(message), { authError: true });
}

/** Compact label for a window id. Known windows get a friendly short form; an
 * unknown `{n}_day` / `{n}_hour` (Codex can return arbitrary windows) is
 * shortened generically; anything else falls back to the raw id. */
function labelFor(name: string): string {
  switch (name) {
    case "five_hour":
      return "5h";
    case "seven_day":
      return "7d";
    case "seven_day_opus":
      return "7d·Opus";
    case "seven_day_sonnet":
      return "7d·Sonnet";
  }
  const day = /^(\d+)_day$/.exec(name);
  if (day) return `${day[1]}d`;
  const hour = /^(\d+)_hour$/.exec(name);
  if (hour) return `${hour[1]}h`;
  return name;
}

/** Codex reports a window by its length in seconds; map the two well-known ones
 * to Claude's names so both providers share one label/i18n path. */
function windowSecondsToTier(secs: number): string {
  if (secs === 18000) return "five_hour";
  if (secs === 604800) return "seven_day";
  const hours = Math.floor(secs / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}_day` : `${hours}_hour`;
}

export async function fetchUsage(
  kind: SubscriptionKind,
  access: string,
  accountId?: string,
): Promise<UsageSnapshot> {
  try {
    const tiers =
      kind === "kimi-oauth"
        ? await fetchKimiUsageTiers(access)
        : kind === "anthropic-oauth"
          ? await fetchAnthropicUsage(access)
          : await fetchCodexUsage(access, accountId);
    return { ok: true, tiers, queriedAt: Date.now() };
  } catch (error) {
    return {
      ok: false,
      tiers: [],
      error: error instanceof Error ? error.message : String(error),
      authError: Boolean((error as { authError?: boolean })?.authError),
      queriedAt: Date.now(),
    };
  }
}

async function fetchAnthropicUsage(access: string): Promise<UsageTier[]> {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${access}`,
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401 || res.status === 403) throw authError(`Claude 用量鉴权失败 (${res.status})`);
  if (!res.ok) throw new Error(`Claude 用量请求失败 (${res.status})`);
  const body = (await res.json()) as Record<string, { utilization?: unknown; resets_at?: unknown }>;
  const order = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
  const tiers: UsageTier[] = [];
  for (const name of order) {
    if (HIDDEN_TIERS.has(name)) continue;
    const window = body?.[name];
    if (window && typeof window.utilization === "number") {
      tiers.push({
        name,
        label: labelFor(name),
        utilization: window.utilization,
        resetsAt: typeof window.resets_at === "string" ? window.resets_at : undefined,
      });
    }
  }
  return tiers;
}

async function fetchCodexUsage(access: string, accountId?: string): Promise<UsageTier[]> {
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${access}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      "User-Agent": "codex-cli",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401 || res.status === 403) throw authError(`Codex 用量鉴权失败 (${res.status})`);
  if (!res.ok) throw new Error(`Codex 用量请求失败 (${res.status})`);
  const body = (await res.json()) as {
    rate_limit?: {
      primary_window?: { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
      secondary_window?: { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
    };
  };
  const rateLimit = body?.rate_limit;
  const tiers: UsageTier[] = [];
  for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (window && typeof window.used_percent === "number") {
      const name = typeof window.limit_window_seconds === "number" ? windowSecondsToTier(window.limit_window_seconds) : "unknown";
      tiers.push({
        name,
        label: labelFor(name),
        utilization: window.used_percent,
        resetsAt: typeof window.reset_at === "number" ? new Date(window.reset_at * 1000).toISOString() : undefined,
      });
    }
  }
  return tiers;
}
