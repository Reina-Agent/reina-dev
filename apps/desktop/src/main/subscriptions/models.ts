// Model lists for subscription accounts, fetched live from the provider — no
// hardcoded catalog.
//
//   Anthropic: GET api.anthropic.com/v1/models         -> data[].id
//   Codex:     GET chatgpt.com/backend-api/codex/models -> models[].slug
//              (requires ?client_version= and the codex_cli headers)

import { fetchKimiModels } from "./kimi.js";
import type { SubscriptionKind } from "./types.js";

// We impersonate the *real* latest CLI of each subscription — its version
// fetched live from npm and cached — so our `client_version` and `User-Agent`
// track real releases with no hardcoded version to maintain. The only literals
// below are offline fallbacks, used solely when npm has never been reachable
// this run.
const NPM_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
// Models `>=` gate fallback: inflate when offline so `>=minimal_client_version`
// still passes and every current model surfaces. NEVER use this for a UA — an
// implausible version is itself a fingerprint tell.
const CODEX_GATE_VERSION_FALLBACK = "9.0.0";
// Realistic offline fallbacks for User-Agents (genuine releases, not inflated).
const CODEX_UA_VERSION_FALLBACK = "0.138.0";
const CLAUDE_UA_VERSION_FALLBACK = "2.1.161";

const npmVersionCache = new Map<string, { value: string; at: number }>();

/** Latest published version of an npm package, cached a few hours. Returns
 * undefined (never a fabricated value) when npm is unreachable and nothing is
 * cached, so each caller can pick a context-appropriate fallback. */
async function npmLatestVersion(pkg: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = npmVersionCache.get(pkg);
  if (cached && now - cached.at < NPM_VERSION_TTL_MS) return cached.value;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = (await res.json()) as { version?: unknown };
      if (typeof json.version === "string" && json.version.trim()) {
        const value = json.version.trim();
        npmVersionCache.set(pkg, { value, at: now });
        return value;
      }
    }
  } catch {
    // npm unreachable — fall through to last-known-good (or undefined).
  }
  return cached?.value;
}

/** Codex `client_version` for the models `>=` gate (inflated offline so all
 * models surface). Not for User-Agents — see {@link subscriptionUserAgent}. */
async function codexClientVersion(): Promise<string> {
  return (await npmLatestVersion("@openai/codex")) ?? CODEX_GATE_VERSION_FALLBACK;
}

/** Full `User-Agent` impersonating the official CLI of a subscription kind,
 * built from the live npm package version so we track real releases without a
 * hardcoded version. The OS/arch/terminal suffix mirrors the real client. */
export async function subscriptionUserAgent(kind: SubscriptionKind): Promise<string> {
  if (kind === "anthropic-oauth") {
    const v = (await npmLatestVersion("@anthropic-ai/claude-code")) ?? CLAUDE_UA_VERSION_FALLBACK;
    return `claude-cli/${v} (external, cli)`;
  }
  // Kimi identifies clients via the X-Msh-* headers (see kimi.ts), not the UA;
  // a plain UA is fine and honest here.
  if (kind === "kimi-oauth") return "reina";
  const v = (await npmLatestVersion("@openai/codex")) ?? CODEX_UA_VERSION_FALLBACK;
  return `codex_cli_rs/${v} (Ubuntu 22.4.0; x86_64) xterm-256color`;
}

function dedupe(items: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** The live fetched list, deduped — and nothing else. It intentionally does NOT
 * pin the account's saved model: an id the provider no longer lists must drop
 * out of the dropdown. The store heals a stale selection onto a live model (see
 * listModelsForAccount), so what's shown is exactly what the provider returns. */
export function buildModelList(remote: string[]): string[] {
  return dedupe(remote);
}

/** Default when first connecting: for Codex prefer a coding ("-codex") slug,
 * otherwise the first model the provider lists. */
export function pickDefaultModel(kind: SubscriptionKind, models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  if (kind === "openai-codex") return models.find((m) => /codex/i.test(m)) ?? models[0];
  return models[0];
}

/** Live model list from the provider. Throws on failure so the caller can
 * surface a real error (the user asked for the remote list specifically). */
export async function fetchRemoteModels(
  kind: SubscriptionKind,
  access: string,
  accountId?: string,
): Promise<string[]> {
  if (kind === "kimi-oauth") return fetchKimiModels(access);
  return kind === "anthropic-oauth" ? fetchAnthropicModels(access) : fetchCodexModels(access, accountId);
}

async function fetchAnthropicModels(access: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      Authorization: `Bearer ${access}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
      "user-agent": await subscriptionUserAgent("anthropic-oauth"),
      accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Anthropic 模型列表请求失败 (${res.status})`);
  const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

async function fetchCodexModels(access: string, accountId?: string): Promise<string[]> {
  const version = await codexClientVersion();
  const res = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`, {
    headers: {
      Authorization: `Bearer ${access}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      originator: "codex_cli_rs",
      "User-Agent": await subscriptionUserAgent("openai-codex"),
      accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Codex 模型列表请求失败 (${res.status})`);
  const json = (await res.json()) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
  const all = json.models ?? [];
  // The CLI surfaces only `visibility: "list"` models; if that field is absent,
  // fall through to every returned model rather than filtering to nothing.
  const listed = all.filter((m) => m?.visibility === "list");
  const source = listed.length > 0 ? listed : all;
  return source.map((m) => m.slug).filter((s): s is string => typeof s === "string");
}
