import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("live runtime settings", () => {
  it("does not show a new threshold before the host acknowledges the save", async () => {
    let accept!: () => void;
    const invoke = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    vi.stubGlobal("window", { reinaDesktop: { invoke } });
    const { DEFAULTS, getViewSettings, saveCompactionSettings } = await import("./viewSettings");
    const next = {
      compactionAuto: false, compactionOffload: true, compactionTriggerPercent: 0,
      compactionBufferTokens: 25000, compactionKeepRecent: 12,
    };
    const save = saveCompactionSettings(next);
    expect(getViewSettings().compactionTriggerPercent).toBe(DEFAULTS.compactionTriggerPercent);
    accept();
    await save;
    expect(getViewSettings()).toMatchObject(next);
    expect(invoke).toHaveBeenCalledWith("save_compaction_settings", { settings: next });
  });

  it("surfaces failures without changing the confirmed concurrency", async () => {
    vi.stubGlobal("window", { reinaDesktop: { invoke: vi.fn().mockRejectedValue(new Error("Host unavailable")) } });
    const { DEFAULTS, getViewSettings, saveSubagentConcurrency } = await import("./viewSettings");
    await expect(saveSubagentConcurrency(12)).rejects.toThrow("Host unavailable");
    expect(getViewSettings().subagentConcurrency).toBe(DEFAULTS.subagentConcurrency);
  });

  it("preserves zero from another window so blank percentage stays in buffer mode", async () => {
    let receive!: (payload: unknown) => void;
    vi.stubGlobal("window", { reinaDesktop: { events: { on: (_event: string, callback: typeof receive) => {
      receive = callback;
      return () => {};
    } } } });
    const { getViewSettings, subscribeViewSettingsBroadcast } = await import("./viewSettings");
    subscribeViewSettingsBroadcast();
    receive({ key: "compactionTriggerPercent", value: "0" });
    expect(getViewSettings().compactionTriggerPercent).toBe(0);
  });
});
