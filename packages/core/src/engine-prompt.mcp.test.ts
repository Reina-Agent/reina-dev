import { describe, expect, it, vi } from "vitest";

// Control the MCP status map so we can assert that live connection status
// stays OUT of the cached system prefix and only appears in the per-turn
// (uncached) volatile reminder. Partial-mock the barrel so the rest of
// engine-prompt's imports (deferredToolDescriptors, reinaConfigHome) keep
// their real implementations.
const getMcpStatusMap = vi.fn();
vi.mock("@reina/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reina/tools")>()),
  getMcpStatusMap: () => getMcpStatusMap(),
}));

const { buildSystemPrompt, buildVolatileContextReminder } = await import("./engine-prompt.js");
const { profiles } = await import("./profiles.js");

function session(agent = "default"): any {
  return {
    id: "t",
    title: "t",
    agent,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    cwd: process.cwd(),
    model: { provider: "deterministic", model: "x" },
    permissionMode: "default",
    messages: [],
    toolCalls: [],
    trace: [],
    approvals: [],
    questions: [],
    skills: [],
    asyncTasks: [],
    subagentDepth: 0,
  };
}

describe("MCP guidance cache stability", () => {
  it("cached system prompt lists server names but never live status", () => {
    getMcpStatusMap.mockReturnValue({
      alpha: { status: "connected" },
      beta: { status: "failed", error: "ECONNREFUSED" },
    });
    const sp = buildSystemPrompt(session());
    expect(sp).toContain("- alpha");
    expect(sp).toContain("- beta");
    // No live status leaks into the cached prefix: neither the error detail,
    // the per-server status format, nor the old inline "(failed: ...)" form.
    expect(sp).not.toContain("ECONNREFUSED");
    expect(sp).not.toContain("beta: failed");
    expect(sp).not.toContain("(failed:");
  });

  it("system prompt is byte-identical when a server flips connected -> failed", () => {
    getMcpStatusMap.mockReturnValue({ alpha: { status: "connected" }, beta: { status: "connected" } });
    const healthy = buildSystemPrompt(session());
    getMcpStatusMap.mockReturnValue({ alpha: { status: "connected" }, beta: { status: "failed", error: "boom" } });
    const degraded = buildSystemPrompt(session());
    // The whole point of P1: a status flip must not bust the cache prefix.
    expect(degraded).toBe(healthy);
  });

  it("volatile reminder surfaces only non-connected servers", () => {
    getMcpStatusMap.mockReturnValue({
      alpha: { status: "connected" },
      beta: { status: "failed", error: "ECONNREFUSED" },
      gamma: { status: "disabled" },
    });
    const reminder = buildVolatileContextReminder(session());
    expect(reminder).toContain("MCP server status");
    expect(reminder).toContain("beta: failed (ECONNREFUSED)");
    expect(reminder).toContain("gamma: disabled");
    // Healthy servers are not repeated in the volatile block.
    expect(reminder).not.toContain("alpha");
  });

  it("volatile reminder is empty when every server is connected", () => {
    getMcpStatusMap.mockReturnValue({ alpha: { status: "connected" }, beta: { status: "connected" } });
    expect(buildVolatileContextReminder(session())).toBe("");
  });

  it("does not disclose servers outside the active profile allow-list", () => {
    const profileName = "mcp-alpha-only-test";
    const baseProfile = profiles.find((profile) => profile.name === "default")!;
    profiles.push({ ...baseProfile, name: profileName, mcpServers: ["alpha"] });
    try {
      getMcpStatusMap.mockReturnValue({
        alpha: { status: "failed", error: "alpha failed" },
        beta: { status: "failed", error: "beta failed" },
      });
      const state = session(profileName);

      const systemPrompt = buildSystemPrompt(state);
      const reminder = buildVolatileContextReminder(state);

      expect(systemPrompt).toContain("- alpha");
      expect(systemPrompt).not.toContain("- beta");
      expect(reminder).toContain("alpha: failed (alpha failed)");
      expect(reminder).not.toContain("beta");
    } finally {
      profiles.pop();
    }
  });
});
