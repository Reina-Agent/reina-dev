import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshSubscription } from "./oauth.js";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex OAuth refresh identity", () => {
  it("carries user identity, workspace and rotated tokens out of the mocked token response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "team" } }),
            refresh_token: "new-fixture-refresh",
            id_token: jwt({ email: "alice@example.test", "https://api.openai.com/auth": { chatgpt_user_id: "alice" } }),
            expires_in: 3600,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = await refreshSubscription("openai-codex", "old-fixture-refresh");
    expect(refreshed).toMatchObject({
      accountId: "team",
      userId: "alice",
      email: "alice@example.test",
      refresh: "new-fixture-refresh",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the refresh token when the mocked provider does not rotate it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "team", user_id: "alice" } }),
              expires_in: 3600,
            }),
          ),
      ),
    );
    expect(await refreshSubscription("openai-codex", "fixture-refresh")).toMatchObject({
      accountId: "team",
      userId: "alice",
      refresh: "fixture-refresh",
    });
  });
});
