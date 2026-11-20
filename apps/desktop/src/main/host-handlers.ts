import { Notification } from "electron";
import type { DesktopRequestWithout } from "@reina/desktop-protocol";
import { handleScheduleWakeup } from "./wakeup-scheduler.js";
import { readStoreValue } from "./store.js";
import { kimiWebFetch, kimiWebSearch } from "./subscriptions/kimi.js";
import { ensureFreshToken, ensureFreshTokenForKind } from "./subscriptions/store.js";

type SendHostRequest = (request: DesktopRequestWithout<"id">) => Promise<unknown> | unknown;
type Log = (line: string) => void;

export type HostHandlerEnv = {
  log: Log;
  sendHostRequest: SendHostRequest;
};

export type HostRequestResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

export async function handleHostRequest(
  kind: string,
  params: unknown,
  sessionId: string | undefined,
  env: HostHandlerEnv,
): Promise<HostRequestResult> {
  try {
    switch (kind) {
      case "notify":
        return await handleNotify(params, env);
      case "schedule_wakeup":
        return await handleScheduleWakeup(params, sessionId, env);
      case "refresh_subscription_token":
        return await handleRefreshSubscriptionToken(params);
      case "kimi_web_search":
        return await handleKimiWebSearch(params);
      case "kimi_web_fetch":
        return await handleKimiWebFetch(params);
      default:
        return { success: false, error: `Unknown host_request kind: ${kind}` };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleNotify(params: unknown, env: HostHandlerEnv): Promise<HostRequestResult> {
  const p = params as { title?: string; body?: string; silent?: boolean };
  if (!p?.title || !p?.body) return { success: false, error: "notify requires title and body" };
  if (readStoreValue("view-settings", "notifySystem") === "false") {
    return { success: true, data: { delivered: false, reason: "System notifications are disabled." } };
  }
  if (!Notification.isSupported()) {
    env.log(`notify: Notifications are not supported on this platform.`);
    return { success: true, data: { delivered: false, reason: "Notifications not supported on this platform." } };
  }
  // We don't await user click — fire and forget. The agent doesn't need to
  // know whether the user clicked.
  try {
    const note = new Notification({
      title: p.title.slice(0, 200),
      body: p.body.slice(0, 2000),
      silent: Boolean(p.silent) || readStoreValue("view-settings", "notifySound") !== "true",
    });
    note.show();
    return { success: true, data: { delivered: true } };
  } catch (error) {
    return { success: true, data: { delivered: false, reason: error instanceof Error ? error.message : String(error) } };
  }
}

/** Mid-turn token refresh for subscription (OAuth) models. The engine calls this
 * over the host bridge when a turn hits a 401: we mint a fresh access token from
 * the stored refresh token and hand back only the short-lived access token (+
 * account id). The refresh token never leaves the main process. */
const KIMI_NOT_CONNECTED =
  "No Kimi subscription is connected. Ask the user to connect one in 设置 → 订阅账号 → Kimi (Moonshot).";

/** Server-side web search through the Kimi subscription. The engine's
 * kimi_web_search tool calls this over the host bridge; the token never
 * leaves the main process. Account-agnostic: the first connected Kimi
 * account serves every session. */
async function handleKimiWebSearch(params: unknown): Promise<HostRequestResult> {
  const query = typeof (params as { query?: unknown })?.query === "string" ? (params as { query: string }).query.trim() : "";
  if (!query) return { success: false, error: "kimi_web_search requires query" };
  const resolved = await ensureFreshTokenForKind("kimi-oauth");
  if (!resolved) return { success: false, error: KIMI_NOT_CONNECTED };
  const results = await kimiWebSearch(resolved.access, query);
  return { success: true, data: { results } };
}

/** Server-side page fetch/extract through the Kimi subscription. */
async function handleKimiWebFetch(params: unknown): Promise<HostRequestResult> {
  const url = typeof (params as { url?: unknown })?.url === "string" ? (params as { url: string }).url.trim() : "";
  if (!url) return { success: false, error: "kimi_web_fetch requires url" };
  const resolved = await ensureFreshTokenForKind("kimi-oauth");
  if (!resolved) return { success: false, error: KIMI_NOT_CONNECTED };
  const content = await kimiWebFetch(resolved.access, url);
  return { success: true, data: { content } };
}

async function handleRefreshSubscriptionToken(params: unknown): Promise<HostRequestResult> {
  const raw = (params as { subscriptionId?: unknown })?.subscriptionId;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return { success: false, error: "refresh_subscription_token requires subscriptionId" };
  const resolved = await ensureFreshToken(id, true);
  if (!resolved) return { success: false, error: `Subscription account not found: ${id}` };
  return { success: true, data: { access: resolved.access, accountId: resolved.accountId } };
}

