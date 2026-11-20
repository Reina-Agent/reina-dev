// Persistence + token lifecycle for subscription accounts. The store owns the
// secrets (refresh tokens) and is the only place that refreshes them. The host
// never sees a refresh token — it receives a freshly-minted access token via
// `ensureFreshToken`, injected into the ModelConfig at session start.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFromCli } from "./cli-import.js";
import { buildModelList, fetchRemoteModels, pickDefaultModel } from "./models.js";
import { connectSubscription, refreshSubscription } from "./oauth.js";
import { extractCodexIdentity } from "./pkce.js";
import { fetchUsage, type UsageSnapshot } from "./usage.js";
import {
  defaultContextTokens,
  type OAuthTokens,
  type SubscriptionAccount,
  type SubscriptionAccountPublic,
  type SubscriptionKind,
  toPublicAccount,
} from "./types.js";

/** Refresh when the access token has this much (or less) life left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function reinaConfigHome(): string {
  return process.env.REINA_CONFIG_HOME
    ? path.resolve(process.env.REINA_CONFIG_HOME)
    : path.join(os.homedir(), ".reina");
}

function subscriptionsPath(): string {
  return path.join(reinaConfigHome(), "subscriptions.json");
}

function isAccount(value: unknown): value is SubscriptionAccount {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.kind === "string" &&
    (a.kind === "anthropic-oauth" || a.kind === "openai-codex" || a.kind === "kimi-oauth") &&
    typeof a.refresh === "string" &&
    typeof a.access === "string" &&
    typeof a.expires === "number"
  );
}

async function readAll(): Promise<SubscriptionAccount[]> {
  const raw = await readFile(subscriptionsPath(), "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccount).map(withCodexIdentity);
  } catch {
    return [];
  }
}

/** Old records can recover identity from their own token, never from a new
 * login's email/workspace. Keep this read-only until the next normal save. */
function withCodexIdentity(account: SubscriptionAccount): SubscriptionAccount {
  if (account.kind !== "openai-codex") return account;
  const identity = extractCodexIdentity(account.access);
  return {
    ...account,
    accountId: account.accountId ?? identity.accountId,
    userId: account.userId ?? identity.userId,
    subject: account.subject ?? identity.subject,
    email: account.email ?? identity.email,
  };
}

async function writeAll(list: SubscriptionAccount[]): Promise<void> {
  const target = subscriptionsPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/** Serialize every read-modify-write cycle on subscriptions.json. All mutators
 * do `readAll → mutate → writeAll`; without a lock two interleaved calls lose
 * the loser's write (last-writer-wins), and two concurrent refreshes for one
 * account both POST the same rotating refresh token — the provider invalidates
 * it on the first, so the second gets `invalid_grant` and the account is wrongly
 * marked needs-reauth. One in-process queue closes both. (Mirrors the
 * wakeup-store write chain.) */
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeLock.then(fn, fn);
  // Keep the chain alive whatever `fn` does, but hand the real result/error back
  // to this caller.
  storeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Per-account serialization, keyed by account id. Used ONLY for the token
 * refresh: it preserves the rotating-refresh-token double-spend guard (two
 * concurrent refreshes for the SAME account would otherwise both POST the same
 * refresh token and the loser gets `invalid_grant`) WITHOUT serializing the
 * unbounded refresh network call across unrelated accounts the way the global
 * `storeLock` would — a hung refresh for one account must not block token
 * resolution (and thus turn start) for every other account. The whole-file
 * read/write still runs under `storeLock`, so this never clobbers a concurrent
 * mutator. `accountLocks` is pruned once a chain drains so it can't grow. */
const accountLocks = new Map<string, Promise<unknown>>();
function withAccountLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  accountLocks.set(id, settled);
  void settled.then(() => {
    if (accountLocks.get(id) === settled) accountLocks.delete(id);
  });
  return run;
}

function shortId(): string {
  return randomBytes(5).toString("hex");
}

function defaultLabel(kind: SubscriptionKind, email?: string): string {
  const base =
    kind === "anthropic-oauth" ? "Claude (Pro/Max)" : kind === "kimi-oauth" ? "Kimi (Moonshot)" : "ChatGPT Codex";
  return email ? `${base} · ${email}` : base;
}

export async function listSubscriptions(): Promise<SubscriptionAccountPublic[]> {
  return (await readAll()).map(toPublicAccount);
}

/** Build a new account and seed its default model from the provider's live list
 * (so the first turn uses a real, account-available model). */
async function buildAccount(kind: SubscriptionKind, tokens: OAuthTokens): Promise<SubscriptionAccount> {
  if (!tokens.access?.trim() || !tokens.refresh?.trim()) {
    throw new Error("登录凭证缺少 access token 或 refresh token，请重新登录。");
  }
  let model: string | undefined;
  try {
    model = pickDefaultModel(kind, await fetchRemoteModels(kind, tokens.access, tokens.accountId));
  } catch {
    // Fetch failed at connect time; leave model unset — the user picks one from
    // the (live-fetched) dropdown in Settings → 订阅账号.
    model = undefined;
  }
  return withCodexIdentity({
    id: `${kind}-${shortId()}`,
    label: defaultLabel(kind, tokens.email),
    kind,
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
    accountId: tokens.accountId,
    userId: tokens.userId,
    subject: tokens.subject,
    email: tokens.email,
    model,
    contextTokens: defaultContextTokens(kind),
    createdAt: Date.now(),
  });
}

/** Codex workspaces can contain many users. Match a user AND a workspace;
 * unknown identities only match an identical non-empty credential. A CLI file
 * path or an email alone cannot prove that a new login belongs to an old card. */
function sameProviderAccount(a: SubscriptionAccount, b: SubscriptionAccount): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "openai-codex") {
    if (a.accountId !== b.accountId) return false;
    if (a.userId && b.userId) {
      if (a.userId !== b.userId) return false;
      if (a.accountId) return true;
    } else if (a.subject && b.subject) {
      if (a.subject !== b.subject) return false;
      if (a.accountId) return true;
    }
    return Boolean((a.refresh.trim() && a.refresh === b.refresh) || (a.access.trim() && a.access === b.access));
  }
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.email && b.email) return a.email === b.email;
  return Boolean((a.refresh.trim() && a.refresh === b.refresh) || (a.access.trim() && a.access === b.access));
}

/** Persist a freshly-connected/imported account. Re-connecting an account that
 * is already in the store must NOT create a duplicate card — refresh the
 * existing entry's tokens in place, keeping its id, label, model and context
 * settings. */
async function persistNewAccount(account: SubscriptionAccount): Promise<SubscriptionAccountPublic> {
  return withStoreLock(async () => {
    const list = await readAll();
    const idx = list.findIndex((existing) => sameProviderAccount(existing, account));
    if (idx !== -1) {
      const existing = list[idx]!;
      const merged: SubscriptionAccount = {
        ...existing,
        refresh: account.refresh,
        access: account.access,
        expires: account.expires,
        accountId: account.accountId ?? existing.accountId,
        userId: account.userId ?? existing.userId,
        subject: account.subject ?? existing.subject,
        email: account.email ?? existing.email,
        model: existing.model ?? account.model,
      };
      list[idx] = merged;
      await writeAll(list);
      return toPublicAccount(merged);
    }
    list.push(account);
    await writeAll(list);
    return toPublicAccount(account);
  });
}

/** Connect via the interactive browser OAuth flow. */
export async function connectSubscriptionAccount(
  kind: SubscriptionKind,
  openBrowser: (url: string) => void | Promise<void>,
): Promise<SubscriptionAccountPublic> {
  const tokens = await connectSubscription(kind, openBrowser);
  // Browser flow: never merge two anonymous logins — distinct accounts.
  return persistNewAccount(await buildAccount(kind, tokens));
}

/** Import tokens from an already-logged-in official CLI — no browser needed. */
export async function importSubscriptionFromCli(kind: SubscriptionKind): Promise<SubscriptionAccountPublic> {
  const tokens = await importFromCli(kind);
  return persistNewAccount(await buildAccount(kind, tokens));
}

export async function removeSubscriptionAccount(id: string): Promise<void> {
  await withStoreLock(async () => {
    const list = await readAll();
    await writeAll(list.filter((a) => a.id !== id));
  });
}

export async function updateSubscriptionAccount(
  id: string,
  patch: { label?: string; model?: string; contextTokens?: number },
): Promise<SubscriptionAccountPublic | null> {
  return withStoreLock(async () => {
    const list = await readAll();
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const current = list[idx]!;
    const next: SubscriptionAccount = {
      ...current,
      ...(typeof patch.label === "string" && patch.label.trim() ? { label: patch.label.trim() } : {}),
      ...(typeof patch.model === "string" && patch.model.trim() ? { model: patch.model.trim() } : {}),
      ...(typeof patch.contextTokens === "number" && Number.isFinite(patch.contextTokens) && patch.contextTokens > 0
        ? { contextTokens: Math.floor(patch.contextTokens) }
        : {}),
    };
    list[idx] = next;
    await writeAll(list);
    return toPublicAccount(next);
  });
}

export type ResolvedSubscription = {
  kind: SubscriptionKind;
  access: string;
  accountId?: string;
  model?: string;
  contextTokens?: number;
};

/** Selectable model ids for an account: strictly the provider's live list. A
 * saved model the provider no longer offers is dropped from the list AND healed
 * — the account is switched onto a live default and persisted — so the dropdown
 * never shows a stale/dead id and the account always points at a real model. */
export async function listModelsForAccount(
  id: string,
): Promise<{ models: string[]; current?: string; error?: string }> {
  const account = (await readAll()).find((a) => a.id === id);
  if (!account) return { models: [] };
  try {
    // ensureFreshToken throws if the refresh fails (dead token / no network);
    // keep it inside the try so the dropdown degrades to the saved model + an
    // error string instead of crashing the IPC handler.
    const resolved = await ensureFreshToken(id);
    // No token → can't fetch the live list; surface only the saved model so the
    // dropdown isn't empty, but fetch nothing hardcoded.
    if (!resolved) return { models: [], current: account.model };
    const models = buildModelList(await fetchRemoteModels(resolved.kind, resolved.access, resolved.accountId));
    let current = account.model;
    if (models.length > 0 && (!current || !models.includes(current))) {
      current = pickDefaultModel(resolved.kind, models);
      if (current) await updateSubscriptionAccount(id, { model: current });
    }
    return { models, current };
  } catch (error) {
    return {
      models: [],
      current: account.model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Live usage snapshot (rate-limit windows) for an account: fresh-token, fetch,
 * and on a 401 force-refresh the token and retry once. Display-only — never
 * throws; failures come back as `{ ok: false, error }`. */
export async function getAccountUsage(id: string): Promise<UsageSnapshot> {
  try {
    let resolved = await ensureFreshToken(id);
    if (!resolved) return { ok: false, tiers: [], error: "账号不存在", queriedAt: Date.now() };
    let snapshot = await fetchUsage(resolved.kind, resolved.access, resolved.accountId);
    if (!snapshot.ok && snapshot.authError) {
      resolved = await ensureFreshToken(id, true);
      if (resolved) snapshot = await fetchUsage(resolved.kind, resolved.access, resolved.accountId);
    }
    return snapshot;
  } catch (error) {
    // A token refresh that fails (dead refresh token, or no network) throws from
    // ensureFreshToken; this is display-only, so degrade to an error snapshot
    // instead of crashing the IPC handler.
    return {
      ok: false,
      tiers: [],
      error: error instanceof Error ? error.message : String(error),
      authError: Boolean((error as { authError?: boolean })?.authError),
      queriedAt: Date.now(),
    };
  }
}

/** First account of `kind`, token-refreshed. Used by the kimi_web_search /
 * kimi_web_fetch host handlers, which are account-agnostic (the engine's tool
 * call carries no account id — any connected account of the kind serves). */
export async function ensureFreshTokenForKind(kind: SubscriptionKind): Promise<ResolvedSubscription | null> {
  const account = (await readAll()).find((a) => a.kind === kind);
  return account ? ensureFreshToken(account.id) : null;
}

/** Return a fresh access token for `id`, refreshing + persisting if it is at or
 * past the refresh margin. Pass `force` to refresh unconditionally — used when a
 * turn hit a 401, where the stored `expires` may still read as valid even though
 * the provider rejected the token. Returns null if the account no longer exists. */
export async function ensureFreshToken(id: string, force = false): Promise<ResolvedSubscription | null> {
  // A forced waiter must not refresh again if another caller has already
  // replaced the credentials it saw before waiting for the account lock.
  const rejected = force
    ? await withStoreLock(async () => (await readAll()).find((account) => account.id === id) ?? null)
    : null;
  // Serialize per-account (NOT globally) so two concurrent refreshes for the same
  // account can't both POST the same rotating refresh token, while unrelated
  // accounts refresh in parallel. A same-id second waiter enters this critical
  // section only after the first fully persists, then re-reads the now-fresh
  // token under the store lock and skips the redundant refresh.
  return withAccountLock(id, async () => {
    // Read the current account under the (brief) global store lock.
    let account = await withStoreLock(async () => {
      const list = await readAll();
      return list.find((a) => a.id === id) ?? null;
    });
    if (!account) return null;
    const forceCurrent = force && rejected?.access === account.access && rejected?.refresh === account.refresh;
    if (forceCurrent || account.expires - Date.now() <= REFRESH_MARGIN_MS) {
      // Network refresh runs OUTSIDE the global store lock (held only by this
      // account's lock) so a slow/hung refresh can't block other accounts.
      const tokens = await refreshSubscription(account.kind, account.refresh);
      if (!tokens.access?.trim()) throw new Error("刷新登录凭证时未返回 access token，请重新登录。");
      const identity = account.kind === "openai-codex" ? extractCodexIdentity(tokens.access) : {};
      const userId = tokens.userId ?? identity.userId;
      const subject = tokens.subject ?? identity.subject;
      if (
        account.kind === "openai-codex" &&
        (account.userId && userId
          ? account.userId !== userId
          : account.subject && subject && account.subject !== subject)
      ) {
        throw Object.assign(new Error("刷新后的 ChatGPT 用户身份不一致，请重新登录。"), {
          needsReauth: true,
          authError: true,
        });
      }
      // Persist the rotated tokens under the global lock; re-find by id in case
      // the list mutated meanwhile.
      account = await withStoreLock(async () => {
        const list = await readAll();
        const idx = list.findIndex((a) => a.id === id);
        if (idx === -1) return null;
        // A reconnect may have installed a newer OAuth session while the
        // network request was in flight; do not overwrite that session.
        if (list[idx]!.access !== account!.access || list[idx]!.refresh !== account!.refresh) return list[idx]!;
        const updated = withCodexIdentity({
          ...list[idx]!,
          access: tokens.access,
          refresh: tokens.refresh || list[idx]!.refresh,
          expires: tokens.expires,
          // CLI imports may explicitly select a workspace other than the JWT's
          // default. Refreshing a user's token must not change that selection.
          accountId:
            list[idx]!.kind === "openai-codex"
              ? (list[idx]!.accountId ?? tokens.accountId)
              : (tokens.accountId ?? list[idx]!.accountId),
          userId: userId ?? list[idx]!.userId,
          subject: subject ?? list[idx]!.subject,
          email: tokens.email ?? list[idx]!.email,
        });
        list[idx] = updated;
        await writeAll(list);
        return updated;
      });
      if (!account) return null;
    }
    return {
      kind: account.kind,
      access: account.access,
      accountId: account.accountId,
      model: account.model,
      contextTokens: account.contextTokens ?? defaultContextTokens(account.kind),
    };
  });
}
