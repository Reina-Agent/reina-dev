// Resident tools ship from turn 1; discovered tools join subsequent requests.
// The array stays stable while the active set and live MCP pool are unchanged.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelProviders, type AgentProfile, type ToolName, type ToolObservation } from "@reina/protocol";

// Two fake MCP servers: `github` stays resident (not listed in
// deferredServers), `slack` is explicitly deferred. The pool shape mirrors
// what mcp-runtime.ts builds; `_def` satisfies the schema-token estimator.
const fakePool = [
  {
    name: "mcp__github__create_issue",
    description: "[MCP:github] Create a GitHub issue.",
    permission: "execute",
    requiresApproval: true,
    inputSchema: { _def: {} },
    inputJsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    mcpServer: "github",
    mcpTool: "create_issue",
  },
  {
    name: "mcp__slack__post_message",
    description: "[MCP:slack] Post a message to a Slack channel.",
    permission: "execute",
    requiresApproval: true,
    inputSchema: { _def: {} },
    inputJsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    mcpServer: "slack",
    mcpTool: "post_message",
  },
];

vi.mock("@reina/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reina/tools")>();
  return {
    ...actual,
    loadMcpRuntimeTools: vi.fn(async () => fakePool),
    runMcpRuntimeTool: vi.fn(async () => "mcp ok"),
  };
});

import { AgentEngine } from "./engine.js";
import { loadMcpRuntimeTools, runMcpRuntimeTool } from "@reina/tools";
import * as providers from "@reina/providers";
import { profiles, resolveProfile } from "./profiles.js";

let cwd: string;
let oldConfigHome: string | undefined;
const engines: AgentEngine[] = [];
const profileCount = profiles.length;

beforeEach(async () => {
  vi.mocked(loadMcpRuntimeTools).mockReset();
  vi.mocked(loadMcpRuntimeTools).mockResolvedValue(
    fakePool as unknown as Awaited<ReturnType<typeof loadMcpRuntimeTools>>,
  );
  vi.mocked(runMcpRuntimeTool).mockReset();
  vi.mocked(runMcpRuntimeTool).mockResolvedValue("mcp ok");
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-mcp-stability-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await mkdir(path.join(cwd, "home-config"), { recursive: true });
  await writeFile(
    path.join(cwd, "home-config", "config.json"),
    JSON.stringify({ mcp: { deferredServers: ["slack"] } }),
    "utf8",
  );
  await writeFile(path.join(cwd, "README.md"), "hello reina", "utf8");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  vi.restoreAllMocks();
  profiles.splice(profileCount);
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

async function runDirectCalls(
  engine: AgentEngine,
  calls: Array<{ name: ToolName; input: Record<string, unknown> }>,
): Promise<ToolObservation[]> {
  const observations: ToolObservation[] = [];
  let round = 0;
  vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
    observations.push(...request.observations);
    round += 1;
    return round === 1
      ? {
          toolCalls: calls.map((call, index) => ({
            id: `direct_${index}`,
            name: call.name,
            input: call.input,
            summary: `Call ${call.name}`,
          })),
        }
      : { content: "done", toolCalls: [] };
  });
  await engine.runTurn("Call the requested hidden tools directly");
  return observations;
}

describe("MCP tools-array byte-stability", () => {
  it("applies a saved residency policy on the next request of an existing turn", async () => {
    const requests: string[][] = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push(request.tools.map((tool) => tool.name));
      if (requests.length > 1) return { content: "done", toolCalls: [] };
      await writeFile(
        path.join(cwd, "home-config", "config.json"),
        JSON.stringify({ mcp: { deferredServers: ["github"] } }),
        "utf8",
      );
      return { toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" }, summary: "Read" }] };
    });
    const engine = new AgentEngine({ cwd, agent: "default" });
    engines.push(engine);

    await engine.runTurn("Read the workspace");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("mcp__github__create_issue");
    expect(requests[0]).not.toContain("mcp__slack__post_message");
    expect(requests[1]).not.toContain("mcp__github__create_issue");
    expect(requests[1]).toContain("mcp__slack__post_message");
  });

  it("sends a definition on the request immediately after search_tool discovers it", async () => {
    const requests: string[][] = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push(request.tools.map((tool) => tool.name));
      return requests.length === 1
        ? {
            toolCalls: [
              { id: "discover", name: "search_tool", input: { query: "notify", limit: 1 }, summary: "Find notify" },
            ],
          }
        : { content: "done", toolCalls: [] };
    });
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      hostBridge: async () => ({ delivered: true }),
    });
    engines.push(engine);
    await engine.runTurn("Find the notification tool");
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain("notify");
    expect(requests[1]).toContain("notify");
    expect(engine.session.activeDeferredTools).toContain("notify");
  });

  it("builds the same discovered schema array for every provider config and then keeps it stable", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      hostBridge: async () => ({ delivered: true }),
    });
    engines.push(engine);
    // Residency applies on the first turn (one-shot inside continueLoop).
    await engine.runTurn("read README");

    const before = (await engine.availableTools()).map((t) => t.name);
    // Resident server (github): in the array from turn 1.
    expect(before).toContain("mcp__github__create_issue");
    // Deferred server (slack): hidden.
    expect(before).not.toContain("mcp__slack__post_message");
    // Residency is engine-instance state, not session bookkeeping — the
    // unmask set stays reserved for genuine mid-session discoveries.
    expect(engine.session.activeDeferredTools ?? []).not.toContain("mcp__github__create_issue");

    // Simulate the model unmasking the slack tool (search_tool metadata or
    // direct-call fallback both funnel into unmaskDeferredTool).
    (engine as unknown as { unmaskDeferredTool(...names: string[]): void }).unmaskDeferredTool(
      "mcp__slack__post_message",
    );
    expect(engine.session.activeDeferredTools).toContain("mcp__slack__post_message");

    const after = (await engine.availableTools()).map((t) => t.name);
    expect(after).toEqual([...before, "mcp__slack__post_message"]);
    await engine.runTurn("read README");
    const request = engine.session.usage?.lastRequest;
    expect(request?.categories?.toolsMcpActiveDeferred).toBeGreaterThan(0);
    expect(request?.toolDetails?.filter((t) => t.name === "mcp__slack__post_message")).toEqual([
      expect.objectContaining({ deferred: false, activeDeferred: true }),
    ]);

    engine.session.activeDeferredTools!.push("notify");
    const expected = (await engine.availableTools()).map((t) => t.name);
    for (const provider of modelProviders) {
      // availableTools does not call the provider or use real credentials.
      engine.setModel({ provider, model: "test" });
      engine.session.activeDeferredTools = ["notify", "mcp__slack__post_message", "notify", "unknown"];
      const tools = await engine.availableTools();
      expect(tools.map((t) => t.name)).toEqual(expected);
      expect(tools.find((t) => t.name === "notify")?.inputSchema).toBeDefined();
      expect(tools.find((t) => t.name === "mcp__slack__post_message")?.inputJsonSchema).toEqual(
        fakePool[1]!.inputJsonSchema,
      );
    }

    vi.mocked(loadMcpRuntimeTools).mockResolvedValueOnce([]);
    expect((await engine.availableTools()).some((t) => t.name.startsWith("mcp__"))).toBe(false);
    expect(vi.mocked(loadMcpRuntimeTools).mock.calls.every(([requestedCwd]) => requestedCwd === cwd)).toBe(true);
  });

  it("uses one permitted MCP snapshot for the request, hidden roster, budget, and fallback", async () => {
    const loader = vi.mocked(loadMcpRuntimeTools);
    loader.mockReset();
    loader
      .mockResolvedValueOnce(fakePool as unknown as Awaited<ReturnType<typeof loadMcpRuntimeTools>>)
      .mockResolvedValueOnce([]);
    const requests: Array<Parameters<typeof providers.nextModelTurnStream>[1]> = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push(request);
      return {
        toolCalls: [
          {
            id: "direct_snapshot_mcp",
            name: "mcp__slack__post_message",
            input: { text: "x" },
            summary: "Use the hidden MCP tool",
          },
        ],
      };
    });
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    engines.push(engine);
    const internals = engine as unknown as {
      mcpResidencyApplied: boolean;
      residentMcpToolNames: Set<string>;
    };
    internals.mcpResidencyApplied = true;
    internals.residentMcpToolNames = new Set(["mcp__github__create_issue"]);

    await engine.runTurn("Use the current MCP snapshot");

    expect(loader).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools.map((tool) => tool.name)).toContain("mcp__github__create_issue");
    expect(requests[0]!.systemReminders?.join("\n")).toContain("mcp__slack__post_message");
    expect(engine.session.activeDeferredTools).toContain("mcp__slack__post_message");
    expect(engine.session.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mcp__slack__post_message", status: "pending_approval" }),
      ]),
    );
    expect(engine.session.usage?.lastRequest?.toolDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mcp__github__create_issue", deferred: false }),
        expect.objectContaining({ name: "mcp__slack__post_message", deferred: true }),
      ]),
    );
  });

  it("keeps MCP names out of a narrow profile's request, hidden roster, and budget", async () => {
    profiles.push({ ...resolveProfile("default"), name: "test-narrow-roster", tools: ["read_file"] });
    const requests: Array<Parameters<typeof providers.nextModelTurnStream>[1]> = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push(request);
      return { content: "done", toolCalls: [] };
    });
    const engine = new AgentEngine({ cwd, agent: "test-narrow-roster" });
    engines.push(engine);
    engine.session.activeDeferredTools = ["mcp__slack__post_message"];
    const internals = engine as unknown as {
      mcpResidencyApplied: boolean;
      residentMcpToolNames: Set<string>;
    };
    internals.mcpResidencyApplied = true;
    internals.residentMcpToolNames = new Set(["mcp__github__create_issue"]);

    await engine.runTurn("Use only profile-permitted tools");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    const reminders = requests[0]!.systemReminders?.join("\n") ?? "";
    expect(reminders).not.toContain("mcp__github__create_issue");
    expect(reminders).not.toContain("mcp__slack__post_message");
    expect(engine.session.usage?.lastRequest?.toolDetails?.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
  });

  it("keeps servers outside profile.mcpServers out of the request, hidden roster, and budget", async () => {
    profiles.push({
      ...resolveProfile("default"),
      name: "test-github-only-roster",
      mcpServers: ["github"],
    });
    const requests: Array<Parameters<typeof providers.nextModelTurnStream>[1]> = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push(request);
      return { content: "done", toolCalls: [] };
    });
    const engine = new AgentEngine({ cwd, agent: "test-github-only-roster" });
    engines.push(engine);
    engine.session.activeDeferredTools = ["mcp__slack__post_message"];
    const internals = engine as unknown as {
      mcpResidencyApplied: boolean;
      residentMcpToolNames: Set<string>;
    };
    internals.mcpResidencyApplied = true;
    internals.residentMcpToolNames = new Set(["mcp__github__create_issue"]);

    await engine.runTurn("Use only the permitted MCP server");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools.map((tool) => tool.name)).toContain("mcp__github__create_issue");
    expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("mcp__slack__post_message");
    expect(requests[0]!.systemReminders?.join("\n") ?? "").not.toContain("mcp__slack__post_message");
    expect(
      engine.session.usage?.lastRequest?.toolDetails?.some((tool) => tool.name === "mcp__slack__post_message"),
    ).toBe(false);
  });

  it.each<Partial<AgentProfile>>([
    { tools: ["read_file"] },
    { mcpServers: ["github"] },
    { toolPermissions: { mcp__slack__post_message: "deny" } },
  ])("does not expose discovered MCP tools excluded by the profile: %j", async (overrides) => {
    profiles.push({ ...resolveProfile("default"), ...overrides, name: "test-deferred" });
    const engine = new AgentEngine({ cwd, agent: "test-deferred" });
    engines.push(engine);
    engine.session.activeDeferredTools = ["mcp__slack__post_message"];
    expect((await engine.availableTools()).map((t) => t.name)).not.toContain("mcp__slack__post_message");
  });

  it.each(["mcp__slack__post_message", "mcp__slack__*", "*"] as const)(
    "honors an MCP allow-list entry: %s",
    async (entry) => {
      profiles.push({ ...resolveProfile("default"), name: "test-deferred", tools: [entry] });
      const engine = new AgentEngine({ cwd, agent: "test-deferred" });
      engines.push(engine);
      engine.session.activeDeferredTools = ["mcp__slack__post_message"];
      expect((await engine.availableTools()).map((t) => t.name)).toContain("mcp__slack__post_message");
    },
  );

  it("uses runtime server identity to disambiguate MCP wildcard allow-lists", async () => {
    const nestedServerTool = {
      ...fakePool[1]!,
      name: "mcp__foo__bar__dangerous",
      mcpServer: "foo__bar",
      mcpTool: "dangerous",
    };
    vi.mocked(loadMcpRuntimeTools).mockResolvedValue([nestedServerTool] as unknown as Awaited<
      ReturnType<typeof loadMcpRuntimeTools>
    >);
    profiles.push({
      ...resolveProfile("default"),
      name: "test-foo-only",
      tools: ["mcp__foo__*"],
    });
    const denied = new AgentEngine({ cwd, agent: "test-foo-only", permissionMode: "bypass" });
    engines.push(denied);
    denied.session.activeDeferredTools = [nestedServerTool.name];
    expect((await denied.availableTools()).map((tool) => tool.name)).not.toContain(nestedServerTool.name);
    denied.session.activeDeferredTools = [];

    const observations = await runDirectCalls(denied, [
      { name: "mcp__foo__bar__dangerous", input: { text: "must not run" } },
    ]);
    expect(observations).toEqual([
      expect.objectContaining({
        name: "mcp__foo__bar__dangerous",
        error: expect.stringContaining("blocked"),
      }),
    ]);
    expect(denied.session.activeDeferredTools ?? []).not.toContain(nestedServerTool.name);
    expect(denied.session.toolCalls.some((record) => record.name === nestedServerTool.name)).toBe(false);

    profiles.push({
      ...resolveProfile("default"),
      name: "test-foo-nested",
      tools: ["mcp__foo__bar__*"],
    });
    const allowed = new AgentEngine({ cwd, agent: "test-foo-nested" });
    engines.push(allowed);
    allowed.session.activeDeferredTools = [nestedServerTool.name];
    expect((await allowed.availableTools()).map((tool) => tool.name)).toContain(nestedServerTool.name);
  });

  it("keeps the authorized MCP target bound across an approval pause and catalog drift", async () => {
    const approvedTool = {
      ...fakePool[1]!,
      name: "mcp__foo_bar__danger",
      mcpServer: "foo/bar",
      mcpTool: "danger",
    };
    const replacement = {
      ...approvedTool,
      description: "[MCP:foo.bar] A different colliding target.",
      mcpServer: "foo.bar",
    };
    vi.mocked(loadMcpRuntimeTools).mockResolvedValue([approvedTool] as unknown as Awaited<
      ReturnType<typeof loadMcpRuntimeTools>
    >);
    profiles.push({
      ...resolveProfile("default"),
      name: "test-bound-mcp-target",
      tools: ["*"],
      mcpServers: ["foo/bar"],
    });
    let round = 0;
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async () => {
      round += 1;
      return round === 1
        ? {
            toolCalls: [
              {
                id: "approved_mcp",
                name: approvedTool.name as ToolName,
                input: {},
                summary: "Call the approved MCP target",
              },
            ],
          }
        : { content: "done", toolCalls: [] };
    });
    const engine = new AgentEngine({ cwd, agent: "test-bound-mcp-target" });
    engines.push(engine);
    (engine as unknown as { mcpResidencyApplied: boolean }).mcpResidencyApplied = true;

    const first = await engine.runTurn("Use the MCP tool");
    const approval = first.pendingApprovals[0]!;
    expect(approval).toMatchObject({
      name: approvedTool.name,
      mcpServer: "foo/bar",
      mcpTool: "danger",
      status: "pending_approval",
    });

    vi.mocked(loadMcpRuntimeTools).mockResolvedValue([replacement] as unknown as Awaited<
      ReturnType<typeof loadMcpRuntimeTools>
    >);
    await engine.resolveApproval(approval.id, true);

    expect(vi.mocked(runMcpRuntimeTool)).toHaveBeenCalledWith(approvedTool.name, {}, expect.objectContaining({ cwd }), {
      mcpServer: "foo/bar",
      mcpTool: "danger",
    });
  });

  it("blocks direct native and MCP calls outside profile.tools before activation", async () => {
    profiles.push({ ...resolveProfile("default"), name: "test-direct-allow-list", tools: ["read_file"] });
    const hostBridge = vi.fn(async () => ({ delivered: true }));
    const engine = new AgentEngine({
      cwd,
      agent: "test-direct-allow-list",
      permissionMode: "bypass",
      hostBridge,
    });
    engines.push(engine);

    const observations = await runDirectCalls(engine, [
      { name: "notify", input: { title: "x", body: "y" } },
      { name: "mcp__slack__post_message", input: { text: "x" } },
    ]);

    expect(observations.filter((item) => item.error?.includes("blocked"))).toHaveLength(2);
    expect(engine.session.activeDeferredTools ?? []).not.toEqual(
      expect.arrayContaining(["notify", "mcp__slack__post_message"]),
    );
    expect(engine.session.toolCalls.some((call) => call.name === "notify" || call.name.startsWith("mcp__"))).toBe(
      false,
    );
    expect(hostBridge).not.toHaveBeenCalled();
  });

  it("blocks explicitly denied direct calls before activation", async () => {
    profiles.push({
      ...resolveProfile("default"),
      name: "test-direct-deny",
      tools: ["*"],
      toolPermissions: { notify: "deny", mcp__slack__post_message: "deny" },
    });
    const hostBridge = vi.fn(async () => ({ delivered: true }));
    const engine = new AgentEngine({
      cwd,
      agent: "test-direct-deny",
      permissionMode: "bypass",
      hostBridge,
    });
    engines.push(engine);

    const observations = await runDirectCalls(engine, [
      { name: "notify", input: { title: "x", body: "y" } },
      { name: "mcp__slack__post_message", input: { text: "x" } },
    ]);

    expect(observations.filter((item) => item.error?.includes("blocked"))).toHaveLength(2);
    expect(engine.session.activeDeferredTools ?? []).not.toEqual(
      expect.arrayContaining(["notify", "mcp__slack__post_message"]),
    );
    expect(hostBridge).not.toHaveBeenCalled();
  });

  it("blocks a subagent-only direct call before activation", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      permissionMode: "bypass",
      isSubagent: true,
      subagentDepth: 1,
    });
    engines.push(engine);

    const observations = await runDirectCalls(engine, [
      { name: "task", input: { agent: "default", description: "must not run" } },
    ]);

    expect(observations).toEqual([
      expect.objectContaining({ name: "task", error: expect.stringContaining("blocked") }),
    ]);
    expect(engine.session.activeDeferredTools ?? []).not.toContain("task");
    expect(engine.session.toolCalls.some((call) => call.name === "task")).toBe(false);
  });

  it("blocks direct host-backed tools without a bridge before activation", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "bypass" });
    engines.push(engine);

    const calls: Array<{ name: ToolName; input: Record<string, unknown> }> = [
      { name: "notify", input: { title: "x", body: "y" } },
      {
        name: "schedule_wakeup",
        input: { delaySeconds: 60, prompt: "resume", reason: "test" },
      },
      { name: "kimi_web_search", input: { query: "reina" } },
      { name: "kimi_web_fetch", input: { url: "https://example.com" } },
    ];
    const observations = await runDirectCalls(engine, calls);

    expect(observations.filter((item) => item.error?.includes("blocked"))).toHaveLength(calls.length);
    for (const call of calls) {
      expect(engine.session.activeDeferredTools ?? []).not.toContain(call.name);
      expect(engine.session.toolCalls.some((record) => record.name === call.name)).toBe(false);
    }
  });

  it("does not let subscription tools bypass a restrictive profile even with a host bridge", async () => {
    const hostBridge = vi.fn(async () => ({ delivered: true }));
    const engine = new AgentEngine({
      cwd,
      agent: "self-review",
      permissionMode: "bypass",
      hostBridge,
    });
    engines.push(engine);
    engine.session.model.subscriptionTools = ["kimi_web_search", "kimi_web_fetch"];

    const advertised = (await engine.availableTools()).map((tool) => tool.name);
    expect(advertised).not.toContain("kimi_web_search");
    expect(advertised).not.toContain("kimi_web_fetch");
    const observations = await runDirectCalls(engine, [
      { name: "kimi_web_search", input: { query: "reina" } },
      { name: "kimi_web_fetch", input: { url: "https://example.com" } },
    ]);

    expect(observations.filter((item) => item.error?.includes("blocked"))).toHaveLength(2);
    expect(hostBridge).not.toHaveBeenCalled();
    expect(engine.session.toolCalls.some((record) => record.name.startsWith("kimi_web_"))).toBe(false);
  });

  it("does not let background-shell or Goal promotions bypass a restrictive profile", async () => {
    const engine = new AgentEngine({ cwd, agent: "self-review" });
    engines.push(engine);
    vi.spyOn(engine, "backgroundShellTaskCount").mockReturnValue(1);
    engine.executeGoalCommand({ type: "create", objective: "must stay profile-scoped" });

    const names = (await engine.availableTools()).map((tool) => tool.name);
    for (const name of ["kill_shell", "task_output", "monitor", "write_stdin", "get_goal", "update_goal"]) {
      expect(names).not.toContain(name);
    }
  });
});
