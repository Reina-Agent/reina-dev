// Subscription accounts turn a Claude Pro/Max or ChatGPT Codex *subscription*
// (OAuth login, not an API key) into a usable model backend. The refresh token
// is a secret and lives only in the main process (~/.reina/subscriptions.json);
// the renderer only ever sees the `*Public` shape.

export type SubscriptionKind = "anthropic-oauth" | "openai-codex" | "kimi-oauth";

export type SubscriptionAccount = {
  id: string;
  label: string;
  kind: SubscriptionKind;
  /** Long-lived OAuth refresh token. SECRET — never sent to the renderer. */
  refresh: string;
  /** Current short-lived access token (Bearer). Refreshed on demand. */
  access: string;
  /** Epoch ms when `access` expires. */
  expires: number;
  /** Codex workspace id, sent as `chatgpt-account-id`; NOT a user identity. */
  accountId?: string;
  /** Codex user identity from the namespaced OAuth claims. Main-process only. */
  userId?: string;
  /** Issuer-qualified OAuth subject, used when a user id is unavailable. */
  subject?: string;
  email?: string;
  /** Default model id to drive this account with (editable in the picker). */
  model?: string;
  /** Context-window size (tokens) for this account's model. Provider model
   * endpoints don't report it, so it's user-configurable with a sane default. */
  contextTokens?: number;
  createdAt: number;
};

/** Renderer-safe projection: identity + status, no tokens. */
export type SubscriptionAccountPublic = {
  id: string;
  label: string;
  kind: SubscriptionKind;
  email?: string;
  model?: string;
  contextTokens?: number;
  expires: number;
  createdAt: number;
};

/** Default context window (tokens) when an account hasn't set one. Provider
 * model endpoints don't report it; the user can override in Settings. Claude Max
 * tiers reach 1M (claude-(sonnet|opus)-4 send the 1M beta); Codex (GPT-5.x) and
 * Kimi (K2 family) ~256K. */
export function defaultContextTokens(kind: SubscriptionKind): number {
  return kind === "anthropic-oauth" ? 1_000_000 : 256_000;
}

export function toPublicAccount(a: SubscriptionAccount): SubscriptionAccountPublic {
  return {
    id: a.id,
    label: a.label,
    kind: a.kind,
    email: a.email,
    model: a.model,
    contextTokens: a.contextTokens ?? defaultContextTokens(a.kind),
    expires: a.expires,
    createdAt: a.createdAt,
  };
}

export type OAuthTokens = {
  access: string;
  refresh: string;
  /** Epoch ms when `access` expires. */
  expires: number;
  accountId?: string;
  userId?: string;
  subject?: string;
  email?: string;
};
