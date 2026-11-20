import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthTokens, SubscriptionAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  accounts: [] as SubscriptionAccount[],
  readFile: vi.fn(),
  writeFile: vi.fn(),
  connect: vi.fn(),
  importCli: vi.fn(),
  refresh: vi.fn(),
}));

// All persistence and provider boundaries are in-memory fixtures. These tests
// never open a real subscription/CLI credential file or call an OAuth server.
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: vi.fn() }));
vi.mock("./oauth.js", () => ({ connectSubscription: mocks.connect, refreshSubscription: mocks.refresh }));
vi.mock("./cli-import.js", () => ({ importFromCli: mocks.importCli }));
vi.mock("./models.js", () => ({
  fetchRemoteModels: vi.fn(async () => ["gpt-test"]),
  pickDefaultModel: vi.fn(() => "gpt-test"),
  buildModelList: vi.fn((models) => models),
}));
vi.mock("./usage.js", () => ({ fetchUsage: vi.fn() }));

import {
  connectSubscriptionAccount,
  ensureFreshToken,
  importSubscriptionFromCli,
  updateSubscriptionAccount,
} from "./store.js";

function codexTokens(userId: string, workspace = "team", version = "1"): OAuthTokens {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: workspace, chatgpt_user_id: userId }, version };
  return {
    access: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    refresh: `${userId}-${workspace}-${version}-refresh`,
    expires: Date.now() + 3_600_000,
    accountId: workspace,
    email: `${userId}@example.test`,
  };
}

function seed(tokens: OAuthTokens, overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  const account: SubscriptionAccount = {
    ...tokens,
    id: "existing-id",
    label: "My account",
    kind: "openai-codex",
    model: "saved-model",
    contextTokens: 123_000,
    createdAt: 1,
    ...overrides,
  };
  mocks.accounts.push(account);
  return account;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts = [];
  mocks.readFile.mockImplementation(async () => JSON.stringify(mocks.accounts));
  mocks.writeFile.mockImplementation(async (_path, raw: string) => {
    mocks.accounts = JSON.parse(raw) as SubscriptionAccount[];
  });
});

describe("subscription account identity", () => {
  it("keeps different users in the same Codex workspace separate, even with the same email", async () => {
    const first = codexTokens("alice");
    const second = { ...codexTokens("bob"), email: first.email };
    mocks.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const a = await connectSubscriptionAccount("openai-codex", vi.fn());
    const b = await connectSubscriptionAccount("openai-codex", vi.fn());
    expect(b.id).not.toBe(a.id);
    expect(mocks.accounts).toHaveLength(2);
    expect(mocks.accounts.map((account) => account.userId)).toEqual(["alice", "bob"]);
  });

  it("preserves local settings when the same user reconnects to the same workspace", async () => {
    mocks.connect.mockResolvedValueOnce(codexTokens("alice"));
    const first = await connectSubscriptionAccount("openai-codex", vi.fn());
    await updateSubscriptionAccount(first.id, {
      label: "Personal label",
      model: "custom-model",
      contextTokens: 222_000,
    });
    mocks.connect.mockResolvedValueOnce({ ...codexTokens("alice", "team", "2"), email: "new@example.test" });
    const second = await connectSubscriptionAccount("openai-codex", vi.fn());
    expect(second).toMatchObject({
      id: first.id,
      label: "Personal label",
      model: "custom-model",
      contextTokens: 222_000,
    });
    expect(second).not.toHaveProperty("userId");
    expect(second).not.toHaveProperty("subject");
    expect(mocks.accounts).toHaveLength(1);
    expect(mocks.accounts[0]?.refresh).toBe("alice-team-2-refresh");
  });

  it("keeps the same user in different workspaces separate", async () => {
    seed(codexTokens("alice", "team-one"));
    mocks.connect.mockResolvedValueOnce(codexTokens("alice", "team-two"));
    const connected = await connectSubscriptionAccount("openai-codex", vi.fn());
    expect(connected.id).not.toBe("existing-id");
    expect(mocks.accounts).toHaveLength(2);
  });

  it("recovers an old record's user identity from its access token before matching", async () => {
    seed(codexTokens("alice"));
    mocks.connect.mockResolvedValueOnce(codexTokens("alice", "team", "2"));
    const connected = await connectSubscriptionAccount("openai-codex", vi.fn());
    expect(connected.id).toBe("existing-id");
    expect(mocks.accounts[0]?.userId).toBe("alice");
  });

  it("does not guess identity from a legacy workspace and matching email", async () => {
    seed({ ...codexTokens("alice"), access: "opaque-old-access" });
    mocks.connect.mockResolvedValueOnce(codexTokens("alice", "team", "2"));
    const connected = await connectSubscriptionAccount("openai-codex", vi.fn());
    expect(connected.id).not.toBe("existing-id");
    expect(mocks.accounts).toHaveLength(2);
  });

  it("uses an issuer-qualified subject only when a comparable user id is unavailable", async () => {
    const subject = '["https://auth.openai.com","subject-alice"]';
    seed({ ...codexTokens("alice"), access: "old-opaque-access", subject });
    mocks.connect.mockResolvedValueOnce({ ...codexTokens("alice", "team", "2"), subject });
    expect((await connectSubscriptionAccount("openai-codex", vi.fn())).id).toBe("existing-id");
    expect(mocks.accounts[0]?.userId).toBe("alice");
  });

  it("does not merge matching subjects from different issuers", async () => {
    seed({ ...codexTokens("alice"), access: "old-opaque", subject: '["issuer-one","alice"]' });
    mocks.connect.mockResolvedValueOnce({
      ...codexTokens("alice", "team", "2"),
      access: "new-opaque",
      subject: '["issuer-two","alice"]',
    });
    expect((await connectSubscriptionAccount("openai-codex", vi.fn())).id).not.toBe("existing-id");
  });

  it("never lets a shared token override a conflicting workspace selection", async () => {
    const tokens = codexTokens("alice");
    seed(tokens);
    mocks.importCli.mockResolvedValueOnce({ ...tokens, accountId: "another-team" });
    expect((await importSubscriptionFromCli("openai-codex")).id).not.toBe("existing-id");
  });

  it("allows an exact non-empty token re-import without guessing an anonymous identity", async () => {
    const tokens = { access: "opaque-access", refresh: "opaque-refresh", expires: Date.now() + 3_600_000 };
    seed(tokens, { kind: "anthropic-oauth" });
    mocks.importCli.mockResolvedValueOnce(tokens);
    expect((await importSubscriptionFromCli("anthropic-oauth")).id).toBe("existing-id");
  });

  it("does not merge anonymous CLI credentials after a different user logs in", async () => {
    seed({ access: "old-access", refresh: "old-refresh", expires: Date.now() }, { kind: "anthropic-oauth" });
    mocks.importCli.mockResolvedValueOnce({ access: "other-access", refresh: "other-refresh", expires: Date.now() });
    expect((await importSubscriptionFromCli("anthropic-oauth")).id).not.toBe("existing-id");
    expect(mocks.accounts).toHaveLength(2);
  });

  it.each([
    { access: "", refresh: "new-refresh" },
    { access: "new-access", refresh: "" },
    { access: " ", refresh: " " },
  ])("rejects empty credentials instead of merging on empty token equality: %j", async (tokens) => {
    seed({ access: "", refresh: "", expires: Date.now() });
    mocks.connect.mockResolvedValueOnce({ ...tokens, expires: Date.now() });
    await expect(connectSubscriptionAccount("openai-codex", vi.fn())).rejects.toThrow(/token/);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});

describe("subscription refresh serialization", () => {
  it.each([false, true])("shares a concurrent refresh when force=%s", async (force) => {
    seed(codexTokens("alice"), { expires: force ? Date.now() + 3_600_000 : 0 });
    let resolveRefresh!: (tokens: OAuthTokens) => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise<OAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const first = ensureFreshToken("existing-id", force);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const readsBefore = mocks.readFile.mock.calls.length;
    const second = ensureFreshToken("existing-id", force);
    if (force) await vi.waitFor(() => expect(mocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
    const next = codexTokens("alice", "team", "2");
    resolveRefresh(next);
    const resolved = await Promise.all([first, second]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(resolved.map((value) => value?.access)).toEqual([next.access, next.access]);
    expect(mocks.accounts[0]?.refresh).toBe(next.refresh);
  });

  it("allows a later forced refresh and uses the rotated refresh token", async () => {
    seed(codexTokens("alice"));
    mocks.refresh.mockResolvedValueOnce(codexTokens("alice", "team", "2"));
    await ensureFreshToken("existing-id", true);
    mocks.refresh.mockResolvedValueOnce(codexTokens("alice", "team", "3"));
    await ensureFreshToken("existing-id", true);
    expect(mocks.refresh).toHaveBeenNthCalledWith(2, "openai-codex", "alice-team-2-refresh");
  });

  it("does not block a different account while a refresh is pending", async () => {
    seed(codexTokens("alice"), { expires: 0 });
    seed(codexTokens("bob"), { id: "other-id" });
    let resolveRefresh!: (tokens: OAuthTokens) => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise<OAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const first = ensureFreshToken("existing-id");
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect((await ensureFreshToken("other-id"))?.access).toBe(codexTokens("bob").access);
    resolveRefresh(codexTokens("alice", "team", "2"));
    await first;
  });

  it("does not overwrite a newer reconnect that completed during refresh", async () => {
    seed(codexTokens("alice"), { expires: 0 });
    let resolveRefresh!: (tokens: OAuthTokens) => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise<OAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const pending = ensureFreshToken("existing-id");
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const reconnected = codexTokens("alice", "team", "reconnected");
    mocks.connect.mockResolvedValueOnce(reconnected);
    expect((await connectSubscriptionAccount("openai-codex", vi.fn())).id).toBe("existing-id");
    resolveRefresh(codexTokens("alice", "team", "stale-refresh"));
    expect((await pending)?.access).toBe(reconnected.access);
    expect(mocks.accounts[0]?.refresh).toBe(reconnected.refresh);
  });

  it("surfaces token persistence failures instead of returning unpersisted rotated credentials", async () => {
    seed(codexTokens("alice"), { expires: 0 });
    mocks.refresh.mockResolvedValueOnce(codexTokens("alice", "team", "2"));
    mocks.writeFile.mockRejectedValueOnce(new Error("fixture write failure"));
    await expect(ensureFreshToken("existing-id")).rejects.toThrow("fixture write failure");
    expect(mocks.accounts[0]?.refresh).toBe("alice-team-1-refresh");
  });

  it("preserves an explicitly selected workspace when the refreshed JWT names a default workspace", async () => {
    seed(codexTokens("alice", "default-team"), { expires: 0, accountId: "selected-team" });
    mocks.refresh.mockResolvedValueOnce(codexTokens("alice", "default-team", "2"));
    expect((await ensureFreshToken("existing-id"))?.accountId).toBe("selected-team");
    expect(mocks.accounts[0]?.accountId).toBe("selected-team");
  });

  it("rejects a refresh response for a different known user without changing the account", async () => {
    seed(codexTokens("alice"), { expires: 0 });
    mocks.refresh.mockResolvedValueOnce(codexTokens("bob"));
    await expect(ensureFreshToken("existing-id")).rejects.toMatchObject({ needsReauth: true, authError: true });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.accounts[0]?.refresh).toBe("alice-team-1-refresh");
  });
});
