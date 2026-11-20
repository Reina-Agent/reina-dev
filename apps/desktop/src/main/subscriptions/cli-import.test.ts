import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.hoisted(() => vi.fn());
// The filename is resolved normally, but no real CLI credential file is opened.
vi.mock("node:fs/promises", () => ({ readFile, readdir: vi.fn(async () => []) }));
import { importFromCli } from "./cli-import.js";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

beforeEach(() => readFile.mockReset());

describe("Codex CLI identity import", () => {
  it("imports user identity from the ID token while preserving the explicitly selected workspace", async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        tokens: {
          account_id: "selected-team",
          access_token: jwt({
            exp: 2_000_000_000,
            "https://api.openai.com/auth": { chatgpt_account_id: "token-team" },
          }),
          refresh_token: "fixture-refresh",
          id_token: jwt({
            email: "alice@example.test",
            iss: "https://auth.openai.com",
            sub: "subject-alice",
            "https://api.openai.com/auth": { chatgpt_user_id: "alice" },
          }),
        },
      }),
    );
    expect(await importFromCli("openai-codex")).toMatchObject({
      accountId: "selected-team",
      userId: "alice",
      subject: '["https://auth.openai.com","subject-alice"]',
      email: "alice@example.test",
      expires: 2_000_000_000_000,
    });
  });

  it("recovers workspace and user from the access token when no ID token is present", async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: jwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "team", chatgpt_user_id: "alice" },
          }),
          refresh_token: "fixture-refresh",
        },
      }),
    );
    expect(await importFromCli("openai-codex")).toMatchObject({ accountId: "team", userId: "alice" });
  });

  it.each(["openai-codex", "anthropic-oauth"] as const)("rejects blank %s CLI tokens", async (kind) => {
    readFile.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: " ", refresh_token: " " },
        claudeAiOauth: { accessToken: " ", refreshToken: " " },
      }),
    );
    await expect(importFromCli(kind)).rejects.toThrow(/OAuth token/);
  });
});
