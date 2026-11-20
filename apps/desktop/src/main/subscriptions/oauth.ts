// OAuth flows that turn a Claude Pro/Max or ChatGPT Codex subscription into
// usable Bearer tokens. Both use authorization-code + PKCE with a localhost
// callback server (mirroring the official CLIs). Runs in the Electron main
// process only (needs node:http + a browser opener).
//
// Endpoints/client-ids are the public CLI values, cross-checked against the
// `参考/pi` (MIT) and `参考/sub2api` references.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connectKimi, refreshKimi } from "./kimi.js";
import { extractCodexIdentity, generatePkce, randomState } from "./pkce.js";
import type { OAuthTokens, SubscriptionKind } from "./types.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Conservative fallback token lifetime when a provider omits `expires_in`. */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Absolute expiry timestamp from an OAuth `expires_in` (seconds). Guards a
 * missing / non-finite value with a default TTL: `undefined * 1000` is NaN, and
 * a NaN `expires` survives the `typeof === "number"` checks yet makes
 * `expires - now <= margin` always false — so the token would NEVER be
 * proactively refreshed and would only recover via a 401 force-refresh. */
function expiryFromExpiresIn(expiresIn: unknown): number {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : DEFAULT_TOKEN_TTL_MS / 1000;
  return Date.now() + seconds * 1000;
}

const ANTHROPIC = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  port: 53692,
  callbackPath: "/callback",
  scopes:
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
} as const;

const CODEX = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  port: 1455,
  callbackPath: "/auth/callback",
  scope: "openid profile email offline_access",
} as const;

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>登录完成 ✓</h2><p>You can close this window and return to Reina.</p></body>';
const errorHtml = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>登录失败</h2><p>${msg}</p></body>`;

/** Build the error thrown when a token refresh response is not OK. A 400/401 or
 * an `invalid_grant` body means the refresh token itself is dead → surface a
 * friendly "re-login" message and flag it (`needsReauth`/`authError`) so callers
 * can react. Anything else is treated as a transient/server error. */
function refreshFailure(provider: string, status: number, body: string): Error {
  const needsReauth = status === 400 || status === 401 || /invalid_grant/i.test(body);
  const message = needsReauth
    ? `${provider} 登录已失效，请在 设置 → 订阅账号 重新登录。`
    : `${provider} token refresh failed (${status}): ${body}`;
  return Object.assign(new Error(message), { needsReauth, authError: needsReauth });
}

type CallbackResult = { code: string; state: string };

/** Listen on 127.0.0.1:port for the OAuth redirect, validate `state`, and
 * resolve with the authorization code. Always pair with `close()`. */
function waitForCallback(
  port: number,
  callbackPath: string,
  expectedState: string,
): { promise: Promise<CallbackResult>; close: () => void } {
  let resolveFn!: (v: CallbackResult) => void;
  let rejectFn!: (e: Error) => void;
  const promise = new Promise<CallbackResult>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const handle = (req: IncomingMessage, resp: ServerResponse) => {
    const sendHtml = (status: number, html: string) => {
      resp.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      resp.end(html);
    };
    try {
      const url = new URL(req.url ?? "", `http://127.0.0.1:${port}`);
      if (url.pathname !== callbackPath) {
        sendHtml(404, errorHtml("Not found."));
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (err) {
        sendHtml(400, errorHtml(err));
        rejectFn(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!code || !state) {
        sendHtml(400, errorHtml("Missing code or state."));
        rejectFn(new Error("OAuth callback missing code/state"));
        return;
      }
      if (state !== expectedState) {
        sendHtml(400, errorHtml("State mismatch."));
        rejectFn(new Error("OAuth state mismatch"));
        return;
      }
      sendHtml(200, SUCCESS_HTML);
      resolveFn({ code, state });
    } catch (e) {
      sendHtml(500, errorHtml("Internal error."));
      rejectFn(e instanceof Error ? e : new Error(String(e)));
    }
  };

  const server = createServer(handle);
  server.on("error", (e) => rejectFn(e instanceof Error ? e : new Error(String(e))));
  server.listen(port, "127.0.0.1");
  const timer = setTimeout(() => rejectFn(new Error("Login timed out — please try again.")), LOGIN_TIMEOUT_MS);

  return {
    promise,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export async function connectSubscription(
  kind: SubscriptionKind,
  openBrowser: (url: string) => void | Promise<void>,
): Promise<OAuthTokens> {
  // Kimi uses an RFC 8628 device-code flow (no localhost callback server);
  // Anthropic/Codex use authorization-code + PKCE with a local redirect.
  if (kind === "kimi-oauth") return connectKimi(openBrowser);
  return kind === "anthropic-oauth" ? connectAnthropic(openBrowser) : connectCodex(openBrowser);
}

export async function refreshSubscription(kind: SubscriptionKind, refresh: string): Promise<OAuthTokens> {
  if (kind === "kimi-oauth") return refreshKimi(refresh);
  return kind === "anthropic-oauth" ? refreshAnthropic(refresh) : refreshCodex(refresh);
}

// === Anthropic (Claude Pro/Max) ===

async function connectAnthropic(openBrowser: (url: string) => void | Promise<void>): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const redirectUri = `http://localhost:${ANTHROPIC.port}${ANTHROPIC.callbackPath}`;
  const authUrl =
    `${ANTHROPIC.authorizeUrl}?` +
    new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: ANTHROPIC.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();

  const cb = waitForCallback(ANTHROPIC.port, ANTHROPIC.callbackPath, state);
  try {
    await openBrowser(authUrl);
    const { code } = await cb.promise;
    const res = await fetch(ANTHROPIC.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: ANTHROPIC.clientId,
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic token exchange failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      account?: { email_address?: string };
    };
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: expiryFromExpiresIn(data.expires_in),
      email: data.account?.email_address,
    };
  } finally {
    cb.close();
  }
}

async function refreshAnthropic(refresh: string): Promise<OAuthTokens> {
  const res = await fetch(ANTHROPIC.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: ANTHROPIC.clientId, refresh_token: refresh }),
  });
  if (!res.ok) throw refreshFailure("Claude", res.status, await res.text());
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    access: data.access_token,
    refresh: data.refresh_token || refresh,
    expires: expiryFromExpiresIn(data.expires_in),
  };
}

// === Codex (ChatGPT Plus/Pro) ===

async function connectCodex(openBrowser: (url: string) => void | Promise<void>): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const redirectUri = `http://localhost:${CODEX.port}${CODEX.callbackPath}`;
  const authUrl =
    `${CODEX.authorizeUrl}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CODEX.clientId,
      redirect_uri: redirectUri,
      scope: CODEX.scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "reina",
    }).toString();

  const cb = waitForCallback(CODEX.port, CODEX.callbackPath, state);
  try {
    await openBrowser(authUrl);
    const { code } = await cb.promise;
    const res = await fetch(CODEX.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Codex token exchange failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      id_token?: string;
      expires_in: number;
    };
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: expiryFromExpiresIn(data.expires_in),
      ...extractCodexIdentity(data.access_token, data.id_token),
    };
  } finally {
    cb.close();
  }
}

async function refreshCodex(refresh: string): Promise<OAuthTokens> {
  const res = await fetch(CODEX.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX.clientId,
      refresh_token: refresh,
    }).toString(),
  });
  if (!res.ok) throw refreshFailure("Codex", res.status, await res.text());
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token || refresh,
    expires: expiryFromExpiresIn(data.expires_in),
    ...extractCodexIdentity(data.access_token, data.id_token),
  };
}
