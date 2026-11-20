// Import subscription tokens from an already-logged-in official CLI, so the
// user doesn't have to run a browser OAuth flow at all.
//
//   Claude Code: ~/.claude/.credentials.json      -> { claudeAiOauth: {...} }
//   Codex CLI:   ~/.codex/auth.json               -> { tokens: {...} }
//   Kimi CLI:    ~/.kimi-code/credentials/*.json  -> { access_token, refresh_token, expires_at }
//
// Caveat: the refresh token is SHARED with that CLI. When Reina later refreshes
// it the provider usually rotates the token, which can invalidate the CLI's
// copy (the CLI may need to log in again). The browser flow avoids this by
// creating an independent session.

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeJwtClaims, extractCodexIdentity } from "./pkce.js";
import type { OAuthTokens, SubscriptionKind } from "./types.js";

function claudeCredentialsPath(): string {
  const home = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return path.join(home, ".credentials.json");
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

function kimiCredentialsDir(): string {
  return path.join(os.homedir(), ".kimi-code", "credentials");
}

/** Newest token file under the Kimi CLI credentials dir, or null. The dir holds
 * one `<oauth-key>.json` per environment (wire: snake_case TokenInfo). */
async function findKimiCredentialFile(): Promise<string | null> {
  const dir = kimiCredentialsDir();
  const entries = await readdir(dir).catch(() => []);
  const jsons = entries.filter((name) => name.endsWith(".json"));
  if (jsons.length === 0) return null;
  return path.join(dir, jsons[0]!);
}

export async function importFromCli(kind: SubscriptionKind): Promise<OAuthTokens> {
  if (kind === "kimi-oauth") return importKimi();
  return kind === "anthropic-oauth" ? importClaude() : importCodex();
}

/** True if a CLI credential file exists for this kind (drives the UI hint). */
export async function cliCredentialsAvailable(kind: SubscriptionKind): Promise<boolean> {
  if (kind === "kimi-oauth") return (await findKimiCredentialFile()) !== null;
  const file = kind === "anthropic-oauth" ? claudeCredentialsPath() : codexAuthPath();
  return readFile(file, "utf8").then(
    () => true,
    () => false,
  );
}

async function readJson(file: string, label: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) throw new Error(`未找到 ${label} 凭证(${file})。请先用对应 CLI 登录,或改用浏览器连接。`);
  try {
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} 凭证文件解析失败:${file}`);
  }
}

async function importClaude(): Promise<OAuthTokens> {
  const parsed = await readJson(claudeCredentialsPath(), "Claude Code");
  const oauth = parsed.claudeAiOauth as { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined;
  const access = oauth?.accessToken;
  const refresh = oauth?.refreshToken;
  if (typeof access !== "string" || !access.trim() || typeof refresh !== "string" || !refresh.trim()) {
    throw new Error("Claude 凭证里没有 OAuth token(可能是用 API key 登录的,无法导入)。");
  }
  return {
    access,
    refresh,
    expires: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : Date.now(),
  };
}

async function importKimi(): Promise<OAuthTokens> {
  const file = await findKimiCredentialFile();
  if (!file) {
    throw new Error(`未找到 Kimi CLI 凭证(${kimiCredentialsDir()})。请先用 kimi CLI 登录,或改用浏览器连接。`);
  }
  const parsed = await readJson(file, "Kimi");
  const access = parsed.access_token;
  const refresh = parsed.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    throw new Error("Kimi 凭证文件缺少 access_token / refresh_token。");
  }
  // Wire `expires_at` is unix SECONDS (kimi-code token-state contract).
  const expiresAt = parsed.expires_at;
  return {
    access,
    refresh,
    expires: typeof expiresAt === "number" && expiresAt > 0 ? expiresAt * 1000 : Date.now(),
  };
}

async function importCodex(): Promise<OAuthTokens> {
  const parsed = await readJson(codexAuthPath(), "Codex");
  const tokens = (parsed.tokens ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
  };
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== "string" || !access.trim() || typeof refresh !== "string" || !refresh.trim()) {
    throw new Error("Codex 凭证里没有 OAuth token(可能是用 API key 登录的,无法导入)。");
  }
  const identity = extractCodexIdentity(access, typeof tokens.id_token === "string" ? tokens.id_token : undefined);
  const accountId =
    typeof tokens.account_id === "string" && tokens.account_id.trim() ? tokens.account_id.trim() : identity.accountId;
  const exp = decodeJwtClaims(access)?.exp;
  return {
    access,
    refresh,
    expires: typeof exp === "number" ? exp * 1000 : Date.now(),
    ...identity,
    accountId,
  };
}
