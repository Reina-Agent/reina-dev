// Kimi (Moonshot) subscription backend — RFC 8628 device-code OAuth plus the
// managed Kimi Code API surface. Endpoints/client-id are the public kimi-cli
// values, cross-checked against `参考/kimi-code/packages/oauth` (device flow in
// oauth.ts, provisioning in managed-kimi-code.ts, services in
// moonshot-web-search.ts / moonshot-fetch-url.ts).
//
// Surface, all Bearer-authorized by the same OAuth token:
//   POST auth.kimi.com/api/oauth/device_authorization  → device flow start
//   POST auth.kimi.com/api/oauth/token                 → poll / refresh
//   GET  api.kimi.com/coding/v1/models                 → model catalog
//   GET  api.kimi.com/coding/v1/usages                 → rate-limit windows
//   POST api.kimi.com/coding/v1/search                 → server-side web search
//   POST api.kimi.com/coding/v1/fetch                  → server-side URL fetch
//
// Model calls ride the Anthropic-compatible Messages endpoint the /models
// catalog declares (`protocol: "anthropic"`): the anthropic-messages provider
// with `baseUrl: https://api.kimi.com/coding` (the SDK appends /v1/messages)
// and `authMode: "bearer"` (plain Bearer, none of the Claude Code betas).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthTokens } from "./types.js";

export const KIMI = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  oauthHost: "https://auth.kimi.com",
  /** Full API base (models / usages / search / fetch live directly under it). */
  apiBase: "https://api.kimi.com/coding/v1",
  /** Base for the Anthropic SDK, which appends `/v1/...` itself. */
  anthropicBase: "https://api.kimi.com/coding",
} as const;

const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

/** Conservative fallback token lifetime when the server omits `expires_in`. */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

function expiryFromExpiresIn(expiresIn: unknown): number {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : DEFAULT_TOKEN_TTL_MS / 1000;
  return Date.now() + seconds * 1000;
}

// ── Device identity ─────────────────────────────────────────────────────────
// kimi-cli sends X-Msh-* identity headers on every OAuth/API request. The
// device id is a stable random UUID persisted under ~/.reina (kimi-cli keeps
// its own under ~/.kimi-code); the rest describe the host.

const KIMI_UA_VERSION = "1.0.0";

function reinaConfigHome(): string {
  return process.env.REINA_CONFIG_HOME
    ? path.resolve(process.env.REINA_CONFIG_HOME)
    : path.join(os.homedir(), ".reina");
}

let cachedDeviceId: string | null = null;

async function kimiDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const file = path.join(reinaConfigHome(), "kimi_device_id");
  const existing = (await readFile(file, "utf8").catch(() => "")).trim();
  if (existing) {
    cachedDeviceId = existing;
    return existing;
  }
  const id = randomUUID();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, id, "utf8");
  } catch {
    // Best-effort persistence; the in-memory id still serves this run.
  }
  cachedDeviceId = id;
  return id;
}

/** ASCII-safe header value (hostnames can carry non-ASCII on some systems). */
function asciiHeader(value: string): string {
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").trim();
  return cleaned || "unknown";
}

async function kimiHeaders(): Promise<Record<string, string>> {
  return {
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": KIMI_UA_VERSION,
    "X-Msh-Device-Name": asciiHeader(os.hostname()),
    "X-Msh-Os-Version": asciiHeader(os.release()),
    "X-Msh-Device-Id": await kimiDeviceId(),
  };
}

// ── Device-code flow ────────────────────────────────────────────────────────

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(await kimiHeaders()),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON response — interpret by status alone.
  }
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokensFromResponse(data: Record<string, unknown>): OAuthTokens {
  const access = data.access_token;
  const refresh = data.refresh_token;
  if (typeof access !== "string" || !access) throw new Error("Kimi OAuth response missing access_token");
  if (typeof refresh !== "string" || !refresh) throw new Error("Kimi OAuth response missing refresh_token");
  return { access, refresh, expires: expiryFromExpiresIn(data.expires_in) };
}

/** Interactive login: request a device code, open the verification URL in the
 * user's browser (the `_complete` variant carries the code, so there is
 * nothing to type), and poll the token endpoint until approved. */
export async function connectKimi(openBrowser: (url: string) => void | Promise<void>): Promise<OAuthTokens> {
  const tokenUrl = `${KIMI.oauthHost}/api/oauth/token`;
  const { status, data } = await postForm(`${KIMI.oauthHost}/api/oauth/device_authorization`, {
    client_id: KIMI.clientId,
  });
  if (status !== 200) throw new Error(`Kimi 设备授权请求失败 (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  const deviceCode = data.device_code;
  const verifyUrl =
    (typeof data.verification_uri_complete === "string" && data.verification_uri_complete) ||
    (typeof data.verification_uri === "string" && data.verification_uri) ||
    "";
  if (typeof deviceCode !== "string" || !deviceCode || !verifyUrl) {
    throw new Error("Kimi 设备授权响应缺少 device_code / verification_uri");
  }
  let intervalMs = (typeof data.interval === "number" && data.interval > 0 ? data.interval : 5) * 1000;
  const deadline =
    Date.now() +
    Math.min(
      DEVICE_FLOW_TIMEOUT_MS,
      typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in * 1000 : DEVICE_FLOW_TIMEOUT_MS,
    );

  await openBrowser(verifyUrl);

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postForm(tokenUrl, {
      client_id: KIMI.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (poll.status === 200 && typeof poll.data.access_token === "string") {
      return tokensFromResponse(poll.data);
    }
    const code = typeof poll.data.error === "string" ? poll.data.error : "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (code === "expired_token") throw new Error("Kimi 登录超时 — 请重试。");
    if (code === "access_denied") throw new Error("Kimi 登录被拒绝。");
    if (poll.status >= 500) continue; // transient server error — keep polling
    throw new Error(
      `Kimi 登录失败 (${poll.status}): ${
        typeof poll.data.error_description === "string" ? poll.data.error_description : code || "unknown"
      }`,
    );
  }
  throw new Error("Kimi 登录超时 — 请重试。");
}

export async function refreshKimi(refresh: string): Promise<OAuthTokens> {
  const { status, data } = await postForm(`${KIMI.oauthHost}/api/oauth/token`, {
    client_id: KIMI.clientId,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  if (status !== 200) {
    const body = JSON.stringify(data).slice(0, 300);
    const needsReauth = status === 400 || status === 401 || /invalid_grant/i.test(body);
    const message = needsReauth
      ? "Kimi 登录已失效，请在 设置 → 订阅账号 重新登录。"
      : `Kimi token refresh failed (${status}): ${body}`;
    throw Object.assign(new Error(message), { needsReauth, authError: needsReauth });
  }
  const tokens = tokensFromResponse(data);
  // Some servers omit refresh-token rotation; keep the old one then.
  return { ...tokens, refresh: tokens.refresh || refresh };
}

// ── Managed API surface ─────────────────────────────────────────────────────

async function kimiGet(pathname: string, access: string): Promise<Response> {
  return fetch(`${KIMI.apiBase}${pathname}`, {
    headers: {
      ...(await kimiHeaders()),
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Model catalog: GET /models → data[].id (context/thinking metadata ignored —
 * Reina sizes context from the account's configurable contextTokens). */
export async function fetchKimiModels(access: string): Promise<string[]> {
  const res = await kimiGet("/models", access);
  if (!res.ok) throw new Error(`Kimi 模型列表请求失败 (${res.status})`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Usage windows: GET /usages. Payload shape (loose — mirrors kimi-code's
 * intentionally tolerant parser):
 *   { usage: { name, used, limit, resetAt }, limits: [{ detail: {...}, window: {...} }] } */
export async function fetchKimiUsageTiers(
  access: string,
): Promise<Array<{ name: string; label: string; utilization: number; resetsAt?: string }>> {
  const res = await kimiGet("/usages", access);
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Kimi 用量鉴权失败 (${res.status})`), { authError: true });
  }
  if (!res.ok) throw new Error(`Kimi 用量请求失败 (${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  const tiers: Array<{ name: string; label: string; utilization: number; resetsAt?: string }> = [];
  const push = (detail: unknown) => {
    if (!detail || typeof detail !== "object") return;
    const d = detail as Record<string, unknown>;
    const used = Number(d.used);
    const limit = Number(d.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return;
    const name = typeof d.name === "string" && d.name ? d.name : `window_${tiers.length}`;
    const resetRaw = d.resetAt ?? d.reset_at;
    tiers.push({
      name,
      label: name,
      utilization: Math.min(100, Math.max(0, (used / limit) * 100)),
      resetsAt: typeof resetRaw === "string" ? resetRaw : undefined,
    });
  };
  push(body.usage);
  if (Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      push((entry as Record<string, unknown> | null)?.detail);
    }
  }
  return tiers;
}

// ── Server-side tools (search / fetch) ──────────────────────────────────────

export type KimiSearchResult = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  date?: string;
};

/** POST /search { text_query } → search_results[]. */
export async function kimiWebSearch(access: string, query: string): Promise<KimiSearchResult[]> {
  const res = await fetch(`${KIMI.apiBase}/search`, {
    method: "POST",
    headers: {
      ...(await kimiHeaders()),
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text_query: query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Kimi 搜索请求失败 (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as {
    search_results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown; site_name?: unknown; date?: unknown }>;
  };
  return (body.search_results ?? []).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    siteName: typeof r.site_name === "string" && r.site_name ? r.site_name : undefined,
    date: typeof r.date === "string" && r.date ? r.date : undefined,
  }));
}

/** POST /fetch { url } → extracted page text (plain-text body). */
export async function kimiWebFetch(access: string, url: string): Promise<string> {
  const res = await fetch(`${KIMI.apiBase}/fetch`, {
    method: "POST",
    headers: {
      ...(await kimiHeaders()),
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Kimi 网页抓取失败 (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.text();
}
