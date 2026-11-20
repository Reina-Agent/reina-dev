import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  on: vi.fn(),
}));

vi.mock("~/lib/bridge", () => ({
  bridge: () => ({ storeGet: mocks.storeGet, events: { on: mocks.on } }),
}));

import { getPromptPrefs, initPromptPrefs, loadPromptPrefs, subscribePromptPrefs } from "./promptPrefs";

describe("promptPrefs", () => {
  beforeEach(async () => {
    mocks.storeGet.mockReset();
    mocks.storeGet.mockResolvedValue(JSON.stringify({}));
    await loadPromptPrefs();
  });

  it("keeps text selection actions enabled when the setting is absent", () => {
    expect(getPromptPrefs().enableSelectionActions).toBe(true);
  });

  it("loads and publishes the persisted text selection action setting", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePromptPrefs(listener);
    mocks.storeGet.mockResolvedValue(JSON.stringify({ promptInput: { enableSelectionActions: false } }));

    await loadPromptPrefs();

    expect(getPromptPrefs().enableSelectionActions).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("applies settings-window changes without waiting for focus or a reload", async () => {
    initPromptPrefs();
    const receive = mocks.on.mock.calls.find(([event]) => event === "desktop-settings-changed")?.[1];
    expect(receive).toBeTypeOf("function");
    mocks.storeGet.mockResolvedValue(JSON.stringify({ promptInput: { enterToSend: false, enableSlashCommands: false } }));
    receive();
    await vi.waitFor(() => expect(getPromptPrefs()).toMatchObject({ enterToSend: false, enableSlashCommands: false }));
  });
});
