import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  catalogRevision: 0,
  servers: {} as Record<string, { command: string }>,
  defs: {} as Record<
    string,
    Array<{ name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown> } }>
  >,
  calls: [] as Array<{ server: string; tool: string }>,
}));

vi.mock("./mcp-client.js", () => ({
  getMcpToolCatalogRevision: () => h.catalogRevision,
  listMcpToolDefs: vi.fn(async (server: string) => h.defs[server] ?? []),
  callMcpTool: vi.fn(async (server: string, _config: unknown, tool: string) => {
    h.calls.push({ server, tool });
    return `called ${server}/${tool}`;
  }),
}));

vi.mock("./mcp-config.js", () => ({
  loadMcpServers: vi.fn(async () => h.servers),
  isServerEnabled: () => true,
  resolveMcpServer: (_cwd: string, name: string, servers: Record<string, unknown>) => {
    const server = servers[name];
    if (!server) throw new Error(`MCP server not found: ${name}`);
    return server;
  },
}));

const { clearMcpRuntimeToolsCache, loadMcpRuntimeTools, resolveMcpRuntimeToolName, runMcpRuntimeTool } =
  await import("./mcp-runtime.js");

const cwd = "/fake/workspace";

function tool(name: string) {
  return { name, description: name, inputSchema: { type: "object" as const, properties: {} } };
}

beforeEach(() => {
  clearMcpRuntimeToolsCache();
  h.catalogRevision = 0;
  h.servers = { srv: { command: "srv-cmd" } };
  h.defs = { srv: [tool("echo")] };
  h.calls = [];
});

describe("MCP runtime routing identity", () => {
  it("calls the original MCP tool name when the model-facing name was sanitized", async () => {
    h.servers = { "srv.one": { command: "srv-one" } };
    h.defs = { "srv.one": [tool("repo.create")] };

    const catalog = await loadMcpRuntimeTools(cwd);
    expect(catalog.map((entry) => entry.name)).toEqual(["mcp__srv_one__repo_create"]);

    await runMcpRuntimeTool("mcp__srv_one__repo_create", { title: "x" }, { cwd });

    expect(h.calls).toEqual([{ server: "srv.one", tool: "repo.create" }]);
  });

  it("keeps a bound target stable when a longer-prefix server appears before execution", async () => {
    h.servers = {
      foo: { command: "original" },
      foo__bar: { command: "new-longer-prefix" },
    };

    await runMcpRuntimeTool("mcp__foo__bar__danger", {}, { cwd }, { mcpServer: "foo", mcpTool: "bar__danger" });

    expect(h.calls).toEqual([{ server: "foo", tool: "bar__danger" }]);
  });

  it("does not redirect a bound target across sanitize-colliding server keys", async () => {
    h.servers = {
      "foo.bar": { command: "first-but-denied" },
      "foo/bar": { command: "approved" },
    };

    await runMcpRuntimeTool("mcp__foo_bar__danger", {}, { cwd }, { mcpServer: "foo/bar", mcpTool: "danger" });

    expect(h.calls).toEqual([{ server: "foo/bar", tool: "danger" }]);
  });

  it("fails the catalog closed when raw identities collapse to one generated name", async () => {
    h.servers = {
      "foo.bar": { command: "first" },
      "foo/bar": { command: "second" },
    };
    h.defs = {
      "foo.bar": [tool("danger")],
      "foo/bar": [tool("danger")],
    };

    await expect(loadMcpRuntimeTools(cwd)).rejects.toThrow(/name collision after sanitization/i);
  });

  it("rejects zero-match fallback calls and ambiguous legacy server prefixes", async () => {
    await expect(runMcpRuntimeTool("mcp__missing__tool", {}, { cwd })).rejects.toThrow(/unavailable/i);
    expect(() => resolveMcpRuntimeToolName("mcp__foo_bar__danger", ["foo.bar", "foo/bar"])).toThrow(/ambiguous/i);
    expect(h.calls).toHaveLength(0);
  });
});
