import { beforeEach, describe, expect, it, vi } from "vitest";

// runSlashCommand is pure dispatch over three store modules; mock all of them
// so the test never touches the bridge / zustand / DOM those modules pull in.
const mocks = vi.hoisted(() => ({
  getAgentSettingsState: vi.fn(),
  setAgent: vi.fn(),
  setMode: vi.fn(),
  setModel: vi.fn(),
  setSessionMode: vi.fn(),
  runSlashByToken: vi.fn(),
  appendSystemNotice: vi.fn(),
  compactSession: vi.fn(),
  sendMessage: vi.fn(),
  startGoal: vi.fn(),
}));

vi.mock("./agentSettings", () => ({
  getAgentSettingsState: mocks.getAgentSettingsState,
  setAgent: mocks.setAgent,
  setMode: mocks.setMode,
  setModel: mocks.setModel,
  setSessionMode: mocks.setSessionMode,
}));
vi.mock("./CommandPalette", () => ({
  runSlashByToken: mocks.runSlashByToken,
}));
vi.mock("./sessionStore", () => ({
  appendSystemNotice: mocks.appendSystemNotice,
  compactSession: mocks.compactSession,
  sendMessage: mocks.sendMessage,
  startGoal: mocks.startGoal,
}));

import { runSlashCommand } from "./runSlashCommand";

const settings = {
  agentProfiles: [
    { name: "default", description: "", mode: "primary" },
    { name: "Auditor", description: "", mode: "primary" },
  ],
  knownModels: [
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "gpt-5.2-codex", label: "Codex" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentSettingsState.mockReturnValue(settings);
  mocks.setSessionMode.mockResolvedValue(undefined);
  mocks.sendMessage.mockResolvedValue(undefined);
  mocks.startGoal.mockResolvedValue(undefined);
  mocks.compactSession.mockResolvedValue(undefined);
  mocks.runSlashByToken.mockResolvedValue(undefined);
});

describe("runSlashCommand — live switches", () => {
  it("/agent <name> switches the profile case-insensitively and posts a notice", async () => {
    await runSlashCommand("/agent auditor");
    expect(mocks.setAgent).toHaveBeenCalledWith("Auditor");
    expect(mocks.appendSystemNotice).toHaveBeenCalledWith("Agent → Auditor");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runSlashByToken).not.toHaveBeenCalled();
  });

  it("/agent <unknown> posts an error notice without switching", async () => {
    await runSlashCommand("/agent nobody");
    expect(mocks.setAgent).not.toHaveBeenCalled();
    expect(mocks.appendSystemNotice).toHaveBeenCalledWith("Unknown agent: nobody");
  });

  it("/agent without arg falls through to the command registry (opens the picker)", async () => {
    await runSlashCommand("/agent");
    expect(mocks.setAgent).not.toHaveBeenCalled();
    expect(mocks.runSlashByToken).toHaveBeenCalledWith("/agent", "/agent");
  });

  it("/use <model> matches id or label case-insensitively", async () => {
    await runSlashCommand("/use sonnet 5");
    expect(mocks.setModel).toHaveBeenCalledWith(settings.knownModels[0]);
    expect(mocks.appendSystemNotice).toHaveBeenCalledWith("Model → Sonnet 5");
  });

  it("/use <unknown> posts an error notice", async () => {
    await runSlashCommand("/use llama-9");
    expect(mocks.setModel).not.toHaveBeenCalled();
    expect(mocks.appendSystemNotice).toHaveBeenCalledWith("Unknown model: llama-9");
  });
});

describe("runSlashCommand — Goal and mode dispatch", () => {
  it("/goal <text> creates host Goal state without a mode flip or model message", async () => {
    await runSlashCommand("/goal all tests pass");
    expect(mocks.startGoal).toHaveBeenCalledWith("all tests pass", false);
    expect(mocks.setSessionMode).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("/goal --replace uses the explicit user-only replacement path", async () => {
    await runSlashCommand("/goal --replace ship the new target");
    expect(mocks.startGoal).toHaveBeenCalledWith("ship the new target", true);
  });

  it("/goal without arg falls through to the command registry", async () => {
    await runSlashCommand("/goal");
    expect(mocks.setSessionMode).not.toHaveBeenCalled();
    expect(mocks.startGoal).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runSlashByToken).toHaveBeenCalledWith("/goal", "/goal");
  });

  it("/plan switches the native permission mode without sending a model message", async () => {
    await runSlashCommand("/plan");
    expect(mocks.setMode).toHaveBeenCalledWith("plan");
    expect(mocks.appendSystemNotice).toHaveBeenCalledWith("Plan mode enabled");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runSlashByToken).not.toHaveBeenCalled();
  });

  it("/team <text> turns Team mode ON before sending the DAG steer", async () => {
    await runSlashCommand("/team audit the parsers");
    expect(mocks.setSessionMode).toHaveBeenCalledWith("team", true);
    const [text, , reminders, intent] = mocks.sendMessage.mock.calls[0];
    expect(text).toBe("/team audit the parsers");
    expect(reminders[0]).toContain("set_phase");
    expect(intent).toBe("steer");
  });
});

describe("runSlashCommand — bare steers", () => {
  it("/verify without arg targets the last claim", async () => {
    await runSlashCommand("/verify");
    const [text, , reminders, intent] = mocks.sendMessage.mock.calls[0];
    expect(text).toBe("/verify");
    expect(reminders[0]).toContain("the work you just claimed to complete");
    expect(intent).toBe("steer");
  });

  it("/verify <arg> narrows the target and keeps the arg in the bubble", async () => {
    await runSlashCommand("/verify the migration");
    const [text, , reminders] = mocks.sendMessage.mock.calls[0];
    expect(text).toBe("/verify the migration");
    expect(reminders[0]).toContain("verify the migration");
  });

  it("/cancel sends the wind-down steer with the reason", async () => {
    await runSlashCommand("/cancel deadline moved");
    const [text, , reminders, intent] = mocks.sendMessage.mock.calls[0];
    expect(text).toBe("/cancel deadline moved");
    expect(reminders[0]).toContain("deadline moved");
    expect(reminders[0]).toContain("cancel_async_task");
    expect(intent).toBe("steer");
  });
});

describe("runSlashCommand — direct actions and fallback", () => {
  it("/compact calls the host compaction op instead of messaging the model", async () => {
    await runSlashCommand("/compact");
    expect(mocks.compactSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runSlashByToken).not.toHaveBeenCalled();
  });

  it("/skill <name> sends the tagged skill directive as the message", async () => {
    await runSlashCommand("/skill deep-research");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "<skill-directive>Use the `deep-research` skill.</skill-directive>",
    );
  });

  it("uppercase tokens are normalized before dispatch", async () => {
    await runSlashCommand("/COMPACT");
    expect(mocks.compactSession).toHaveBeenCalledTimes(1);
  });

  it("generic and unknown tokens fall through to the command registry", async () => {
    await runSlashCommand("/logs");
    expect(mocks.runSlashByToken).toHaveBeenCalledWith("/logs", "/logs");

    await runSlashCommand("/definitely-not-a-command with args");
    expect(mocks.runSlashByToken).toHaveBeenCalledWith(
      "/definitely-not-a-command",
      "/definitely-not-a-command with args",
    );
  });
});
