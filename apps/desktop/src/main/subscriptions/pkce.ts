import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE pair. `verifier` is base64url(32 random bytes); `challenge` is
 * base64url(sha256(verifier)) with the S256 method. The encoding of the
 * verifier is irrelevant to the provider as long as challenge = S256(verifier). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(randomBytes(32));
}

/** Decode a JWT payload (no signature verification — we only read public claims
 * like the Codex `chatgpt_account_id` and `email`). */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the Codex account id out of a ChatGPT OAuth access token. The claim
 * lives under the namespaced `https://api.openai.com/auth` object. */
export function extractCodexAccountId(accessToken: string): string | undefined {
  const claims = decodeJwtClaims(accessToken);
  const auth = claims?.["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** Bookkeeping for tokens obtained through OAuth or an explicit CLI import.
 * Decoding claims does not authenticate a token. Workspace and user identities
 * stay separate; email is display metadata, never a Codex identity fallback. */
export function extractCodexIdentity(
  accessToken: string,
  idToken?: string,
): { accountId?: string; userId?: string; subject?: string; email?: string } {
  const access = decodeJwtClaims(accessToken);
  const id = idToken ? decodeJwtClaims(idToken) : null;
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const userIdFrom = (claims: Record<string, unknown> | null): string | undefined => {
    const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return nonEmpty(auth?.chatgpt_user_id) ?? nonEmpty(auth?.user_id);
  };
  const subjectFrom = (claims: Record<string, unknown> | null): string | undefined => {
    const issuer = nonEmpty(claims?.iss);
    const subject = nonEmpty(claims?.sub);
    return issuer && subject ? JSON.stringify([issuer, subject]) : undefined;
  };
  const profile = access?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
  return {
    accountId: extractCodexAccountId(accessToken) ?? (idToken ? extractCodexAccountId(idToken) : undefined),
    userId: userIdFrom(access) ?? userIdFrom(id),
    subject: subjectFrom(access) ?? subjectFrom(id),
    email: nonEmpty(id?.email) ?? nonEmpty(access?.email) ?? nonEmpty(profile?.email),
  };
}
