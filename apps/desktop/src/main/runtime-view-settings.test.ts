import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveRuntimeViewSettings } from "./runtime-view-settings.js";
import { readStore, writeStore } from "./store.js";

vi.mock("./store.js", () => ({ readStore: vi.fn(), writeStore: vi.fn() }));

const settings = {
  compactionAuto: true,
  compactionOffload: false,
  compactionTriggerPercent: 0,
  compactionBufferTokens: 13000,
  compactionKeepRecent: 8,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readStore).mockReturnValue({ theme: "existing-theme" });
});

describe("saving live runtime preferences", () => {
  it("writes the complete block atomically, preserves other preferences and waits for the host", async () => {
    let accept!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    let settled = false;
    const result = saveRuntimeViewSettings("save_compaction_settings", { settings }, send).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(writeStore).toHaveBeenCalledTimes(1);
    expect(writeStore).toHaveBeenCalledWith("view-settings", {
      theme: "existing-theme", compactionAuto: "true", compactionOffload: "false",
      compactionTriggerPercent: "0", compactionBufferTokens: "13000", compactionKeepRecent: "8",
    });
    expect(send).toHaveBeenCalledWith({ type: "update_compaction_settings", settings });
    expect(settled).toBe(false);
    accept();
    expect(await result).toHaveProperty("compactionTriggerPercent", "0");
  });

  it("rejects invalid settings before writing or contacting the host", async () => {
    const send = vi.fn();
    await expect(saveRuntimeViewSettings("save_compaction_settings", {
      settings: { ...settings, compactionTriggerPercent: 100 },
    }, send)).rejects.toThrow();
    expect(writeStore).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces host failures and permits retrying the already persisted settings", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Host unavailable")).mockResolvedValueOnce({ applied: true });
    await expect(saveRuntimeViewSettings("save_subagent_concurrency", { concurrency: 3 }, send)).rejects.toThrow("Host unavailable");
    await expect(saveRuntimeViewSettings("save_subagent_concurrency", { concurrency: 3 }, send)).resolves.toEqual({ subagentConcurrency: "3" });
    expect(send).toHaveBeenLastCalledWith({ type: "update_subagent_concurrency", concurrency: 3 });
  });

  it("does not apply a preference whose persistence failed", async () => {
    vi.mocked(writeStore).mockImplementationOnce(() => { throw new Error("Disk full"); });
    const send = vi.fn();
    await expect(saveRuntimeViewSettings("save_subagent_concurrency", { concurrency: 3 }, send)).rejects.toThrow("Disk full");
    expect(send).not.toHaveBeenCalled();
  });
});
