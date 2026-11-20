import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeJwtClaims, extractCodexAccountId, extractCodexIdentity, generatePkce, randomState } from "./pkce.js";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("generatePkce", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = generatePkce();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("produces unpadded base64url with sufficient entropy", () => {
    const { verifier } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(randomState()).not.toBe(randomState());
  });
});

describe("JWT helpers", () => {
  const makeJwt = (claims: Record<string, unknown>) =>
    `${base64url(JSON.stringify({ alg: "none" }))}.${base64url(JSON.stringify(claims))}.sig`;

  it("decodes payload claims without verifying the signature", () => {
    const jwt = makeJwt({ email: "me@example.com", foo: 1 });
    expect(decodeJwtClaims(jwt)).toMatchObject({ email: "me@example.com", foo: 1 });
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
    expect(decodeJwtClaims("a.b")).toBeNull();
  });

  it("extracts the Codex account id from the namespaced auth claim", () => {
    const jwt = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
    expect(extractCodexAccountId(jwt)).toBe("acct_123");
  });

  it("returns undefined when the account-id claim is absent", () => {
    expect(extractCodexAccountId(makeJwt({ sub: "x" }))).toBeUndefined();
  });

  it("keeps a Codex workspace separate from its user and issuer-qualified subject", () => {
    const access = makeJwt({
      iss: "https://auth.openai.com",
      sub: "subject-123",
      "https://api.openai.com/auth": { chatgpt_account_id: "team", chatgpt_user_id: "user-123" },
      "https://api.openai.com/profile": { email: "profile@example.test" },
    });
    expect(extractCodexIdentity(access)).toEqual({
      accountId: "team",
      userId: "user-123",
      subject: '["https://auth.openai.com","subject-123"]',
      email: "profile@example.test",
    });
  });

  it("falls back to ID-token identity and uses its email as display metadata", () => {
    const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "selected-team" } });
    const id = makeJwt({
      email: "id@example.test",
      "https://api.openai.com/auth": { chatgpt_account_id: "id-team", chatgpt_user_id: "user-123" },
    });
    expect(extractCodexIdentity(access, id)).toMatchObject({
      accountId: "selected-team",
      userId: "user-123",
      email: "id@example.test",
    });
  });

  it("accepts user_id only as a user claim, never chatgpt_account_id", () => {
    const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "team", user_id: "user-123" } });
    expect(extractCodexIdentity(access).userId).toBe("user-123");
    expect(
      extractCodexIdentity(makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "team" } })).userId,
    ).toBeUndefined();
  });

  it("requires an issuer for subject matching and rejects malformed identity values", () => {
    expect(extractCodexIdentity(makeJwt({ sub: "subject-only", email: 123 }))).toMatchObject({
      subject: undefined,
      email: undefined,
    });
    expect(
      extractCodexIdentity(
        makeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: " ", chatgpt_user_id: 42 },
        }),
      ),
    ).toMatchObject({ accountId: undefined, userId: undefined });
  });

  it.each([null, [], "text", 123])("does not treat a non-object JWT payload as claims: %j", (payload) => {
    expect(decodeJwtClaims(`header.${base64url(JSON.stringify(payload))}.signature`)).toBeNull();
  });
});
