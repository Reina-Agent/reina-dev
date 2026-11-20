import { beforeEach, expect, test, vi } from "vitest";
import { readStoreValue, writeStoreValue } from "./store.js";
import { saveAgentSettingsPatch } from "./agent-settings-sync.js";

vi.mock("./store.js", () => ({ readStoreValue: vi.fn(), writeStoreValue: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readStoreValue).mockReturnValue(JSON.stringify({ modelId: "other-default", permissionMode: "default", effort: "high" }));
});

test("settings edits atomically preserve defaults and target only the captured foreground session", async () => {
  const send = vi.fn().mockResolvedValue({ applied: true });
  const saved = await saveAgentSettingsPatch({ effort: "low" }, "foreground", send);
  expect(saved).toEqual({ modelId: "other-default", permissionMode: "default", effort: "low" });
  expect(writeStoreValue).toHaveBeenCalledWith("agent-settings", "current", JSON.stringify(saved));
  expect(send).toHaveBeenCalledWith({ type: "patch_agent_settings", sessionId: "foreground", patch: { effort: "low" } });
});

test("does not accept an unrelated full composer model or report failed host updates as success", async () => {
  const send = vi.fn().mockRejectedValue(new Error("Host disconnected"));
  await expect(saveAgentSettingsPatch({ model: {} }, "foreground", send)).rejects.toThrow();
  expect(writeStoreValue).not.toHaveBeenCalled();
  await expect(saveAgentSettingsPatch({ outputStyle: "learning" }, "foreground", send)).rejects.toThrow("Host disconnected");
});
