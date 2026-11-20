import { describe, expect, it } from "vitest";
import type { AgentProfile, ToolDescriptor } from "@reina/protocol";
import { evaluateGate, filterMcpTools } from "./mcp-gating.js";

function tool(name: string, mcpServer?: string): ToolDescriptor {
  return {
    name: name as ToolDescriptor["name"],
    description: "",
    permission: "read",
    requiresApproval: false,
    inputSchema: { _def: {} } as unknown as ToolDescriptor["inputSchema"],
    ...(mcpServer ? { mcpServer } : {}),
  } as ToolDescriptor;
}

function profile(over: Partial<AgentProfile>): AgentProfile {
  return {
    name: "test",
    description: "test",
    mode: "primary",
    prompt: "",
    toolPermissions: {},
    ...over,
  };
}

describe("evaluateGate", () => {
  it("returns empty arrays when every required server is connected", () => {
    const gate = evaluateGate(["a", "b"], {
      a: { status: "connected" },
      b: { status: "connected" },
    });
    expect(gate.missing).toEqual([]);
    expect(gate.failed).toEqual([]);
  });

  it("treats absent servers as missing", () => {
    const gate = evaluateGate(["a", "b"], {
      a: { status: "connected" },
    });
    expect(gate.missing).toEqual(["b"]);
    expect(gate.failed).toEqual([]);
  });

  it("treats disabled / pending servers as missing (not failed)", () => {
    const gate = evaluateGate(["a"], { a: { status: "disabled" } });
    expect(gate.missing).toEqual(["a"]);
    expect(gate.failed).toEqual([]);
  });

  it("surfaces failed servers in the failed bucket with the error string", () => {
    const gate = evaluateGate(["a"], {
      a: { status: "failed", error: "oauth token expired" },
    });
    expect(gate.missing).toEqual([]);
    expect(gate.failed).toEqual([{ name: "a", error: "oauth token expired" }]);
  });

  it("substitutes a placeholder when a failed server omits the error string", () => {
    const gate = evaluateGate(["a"], { a: { status: "failed" } });
    expect(gate.failed).toEqual([{ name: "a", error: "unknown error" }]);
  });
});

describe("filterMcpTools", () => {
  const tools: ToolDescriptor[] = [
    tool("read_file"),
    tool("write_file"),
    tool("mcp__github__create_issue" as string, "github"),
    tool("mcp__slack__post_message" as string, "slack"),
    tool("mcp__github__list_repos" as string, "github"),
  ];

  it("returns the input unchanged when the profile declares no whitelist", () => {
    expect(
      filterMcpTools(tools, profile({}))
        .map((t) => t.name)
        .sort(),
    ).toEqual(tools.map((t) => t.name).sort());
  });

  it("keeps non-MCP tools intact while narrowing MCP to the whitelist", () => {
    const filtered = filterMcpTools(tools, profile({ mcpServers: ["github"] })).map((t) => t.name);
    expect(filtered).toContain("read_file");
    expect(filtered).toContain("write_file");
    expect(filtered).toContain("mcp__github__create_issue");
    expect(filtered).toContain("mcp__github__list_repos");
    expect(filtered).not.toContain("mcp__slack__post_message");
  });

  it("returns no MCP tools when the whitelist names a server with no tools loaded", () => {
    const filtered = filterMcpTools(tools, profile({ mcpServers: ["notion"] })).map((t) => t.name);
    expect(filtered.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(filtered).toContain("read_file");
  });

  it("empty mcpServers array is treated as 'no whitelist' (all visible)", () => {
    expect(filterMcpTools(tools, profile({ mcpServers: [] })).length).toBe(tools.length);
  });

  it("matches server names containing __ by runtime identity and fails identity-less descriptors closed", () => {
    const runtime = {
      ...tool("mcp__my__server__runtime_tool"),
      mcpServer: "my__server",
    } as ToolDescriptor & { mcpServer: string };
    const compatibility = tool("mcp__my__server__compat_tool");
    const filtered = filterMcpTools(
      [runtime, compatibility, tool("mcp__other__ignored")],
      profile({ mcpServers: ["my__server"] }),
    );

    expect(filtered.map((entry) => entry.name)).toEqual(["mcp__my__server__runtime_tool"]);
  });
});
