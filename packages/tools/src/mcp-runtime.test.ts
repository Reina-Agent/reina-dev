import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Coverage for the boot-failed-server recovery path in loadMcpRuntimeTools:
 * a server that was down when the catalog was first built used to cache an
 * empty tool list keyed on config JSON — its tools never registered again
 * until mcp.json was edited or the app restarted. Now the failure is recorded
 * and a cooldown-gated BACKGROUND rebuild heals the catalog. */

const h = vi.hoisted(() => ({
  listCalls: 0,
  serverDown: true,
  catalogRevision: 0,
}));

vi.mock("./mcp-client.js", () => ({
  getMcpToolCatalogRevision: () => h.catalogRevision,
  listMcpToolDefs: vi.fn(async () => {
    h.listCalls += 1;
    if (h.serverDown) throw new Error("connect ECONNREFUSED");
    return [{ name: "do_thing", description: "Do thing", inputSchema: { type: "object", properties: {} } }];
  }),
  callMcpTool: vi.fn(),
}));

vi.mock("./mcp-config.js", () => ({
  loadMcpServers: vi.fn(async () => ({ srv: { command: "srv-cmd" } })),
  isServerEnabled: () => true,
  resolveMcpServer: (_cwd: string, name: string, servers: Record<string, unknown>) => servers[name],
}));

const { loadMcpRuntimeTools, clearMcpRuntimeToolsCache } = await import("./mcp-runtime.js");

const cwd = "/fake/workspace";

beforeEach(() => {
  clearMcpRuntimeToolsCache();
  h.listCalls = 0;
  h.serverDown = true;
  h.catalogRevision = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP runtime tools cache — boot-failed server recovery", () => {
  it("re-registers a boot-failed server's tools after it recovers (background, cooldown-gated)", async () => {
    // Boot: server down → empty catalog, failure recorded.
    expect(await loadMcpRuntimeTools(cwd)).toHaveLength(0);
    expect(h.listCalls).toBe(1);

    // Within the cooldown: cache hit, NO rebuild attempt (a down server's
    // listTools timeout must not tax every turn).
    expect(await loadMcpRuntimeTools(cwd)).toHaveLength(0);
    expect(h.listCalls).toBe(1);

    // Server recovers; cooldown elapses. The next load still returns the
    // stale (empty) catalog — the rebuild is fire-and-forget so the turn
    // never blocks — but it kicks the background refresh.
    h.serverDown = false;
    vi.advanceTimersByTime(61_000);
    expect(await loadMcpRuntimeTools(cwd)).toHaveLength(0);
    expect(h.listCalls).toBe(2);

    // The background .then(cache update) lands within a few microtasks.
    await vi.waitFor(async () => expect(await loadMcpRuntimeTools(cwd)).toHaveLength(1));
    const healed = await loadMcpRuntimeTools(cwd);
    expect(healed[0]!.name).toBe("mcp__srv__do_thing");
  });

  it("does not rebuild when the catalog was built with all servers healthy", async () => {
    h.serverDown = false;
    expect(await loadMcpRuntimeTools(cwd)).toHaveLength(1);
    expect(h.listCalls).toBe(1);

    vi.advanceTimersByTime(120_000);
    expect(await loadMcpRuntimeTools(cwd)).toHaveLength(1);
    expect(h.listCalls).toBe(1);
  });

  it("rebuilds after the MCP client reports a successful tool-list refresh", async () => {
    h.serverDown = false;
    const before = await loadMcpRuntimeTools(cwd);
    expect(before[0]!.description).toBe("[MCP:srv] Do thing");

    h.catalogRevision += 1;
    const after = await loadMcpRuntimeTools(cwd);

    expect(after).not.toBe(before);
    expect(h.listCalls).toBe(2);
  });
});
