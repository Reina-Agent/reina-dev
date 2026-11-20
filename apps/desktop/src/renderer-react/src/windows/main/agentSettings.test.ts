import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  main: { sessionId: undefined as string | undefined, workspaceCwd: "/fixture", activeSession: null as Record<string, unknown> | null },
  api: {
    storeSet: vi.fn().mockResolvedValue(undefined),
    storeGet: vi.fn().mockResolvedValue(null as string | null),
    listAgentProfiles: vi.fn().mockResolvedValue([{ name: "default" }]),
    listKnownModels: vi.fn().mockResolvedValue([] as unknown[]),
    readCustomModels: vi.fn().mockResolvedValue({ effective: [] }),
    listSubscriptions: vi.fn().mockResolvedValue([]),
    invoke: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("~/lib/bridge", () => ({ bridge: () => mocks.api }));
vi.mock("./sessionStore", () => ({ getMainState: () => mocks.main }));
vi.mock("~/lib/modelCapabilities", () => ({ MODEL_TAGS: [], getModelTagKeys: vi.fn(), modelMatchesQuery: vi.fn(), modelMatchesTags: vi.fn() }));

import { availableEffortLevels, getAgentSettingsState, loadAgentSettings, pickModelConfig, reflectSessionModel, setModel } from "./agentSettings";

beforeEach(() => {
  mocks.main.sessionId = undefined;
  mocks.main.activeSession = null;
  vi.clearAllMocks();
});

describe("model selection capability propagation", () => {
  const model = {
    id: "proxy", provider: "openai-chat", model: "fixture", baseUrl: "https://proxy.example/v1", apiKey: "fixture-key",
    maxOutputTokens: 8192, thinkingMode: "budget", supportedEfforts: ["xhigh", "max"], reasoningLevels: ["off", "low", "high"],
    reasoningDialect: "kimi", offEffort: "none", authMode: "bearer", headers: { "X-Route": "fixture" },
  };

  it("carries connection and capability fields into selection and resumed sessions", () => {
    const { id: _id, ...expected } = model;
    expect(pickModelConfig(model)).toMatchObject(expected);
    setModel(model);
    expect(getAgentSettingsState().agentSettings.model).toMatchObject(expected);
    reflectSessionModel({ ...expected, reasoningEffort: "low" });
    expect(getAgentSettingsState().agentSettings.model).toMatchObject(expected);
    expect(getAgentSettingsState().agentSettings.effort).toBe("low");
  });

  it("filters the picker using full levels but never widens an empty set", () => {
    expect(availableEffortLevels(model).map((level) => level.id)).toEqual(["off", "low", "high"]);
    expect(availableEffortLevels({ reasoningLevels: [] })).toEqual([]);
    expect(availableEffortLevels({}).map((level) => level.id)).toContain("medium");
  });

  it("refreshes model choices without replacing the active session with another session's defaults", async () => {
    const activeModel = { ...model, id: "active", model: "active-model", reasoningEffort: "low" };
    mocks.api.listKnownModels.mockResolvedValueOnce([model, activeModel]);
    mocks.api.storeGet.mockImplementationOnce(async () => JSON.stringify({ modelId: model.id, model, effort: "max" }));
    mocks.main.sessionId = "active-session";
    mocks.main.activeSession = { model: activeModel, agent: "default", permissionMode: "default", outputStyle: "learning" };
    await loadAgentSettings();
    expect(getAgentSettingsState().agentSettings).toMatchObject({
      modelId: "active", model: { model: "active-model" }, effort: "low", outputStyle: "learning",
    });
    expect(mocks.api.invoke).not.toHaveBeenCalled();
    expect(mocks.api.storeSet).not.toHaveBeenCalled();
  });
});
