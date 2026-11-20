import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMcpClients, getMcpStatusForCwd } from "./mcp-client.js";
import { runTool } from "./index.js";
import { loadMcpServers } from "./mcp-config.js";
import { clearMcpRuntimeToolsCache, loadMcpRuntimeTools, runMcpRuntimeTool } from "./mcp-runtime.js";

let cwd: string;
let oldConfigHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-mcp-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await mkdir(path.join(cwd, ".reina"), { recursive: true });
  await symlink(path.join(process.cwd(), "node_modules"), path.join(cwd, "node_modules"), "junction");
  await writeFile(
    path.join(cwd, "server.mjs"),
    `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

await writeFile(
  new URL("./starts.txt", import.meta.url),
  String((Number(await readFile(new URL("./starts.txt", import.meta.url), "utf8").catch(() => "0")) || 0) + 1),
  "utf8",
);
await writeFile(new URL("./server-env.txt", import.meta.url), process.env.REINA_MCP_TEST_ENV ?? "", "utf8");
await writeFile(new URL("./pid.txt", import.meta.url), String(process.pid), "utf8");

const server = new McpServer({ name: "reina-test", version: "1.0.0" });
server.registerResource("note", "reina://note", {
  title: "Note",
  description: "Test resource",
  mimeType: "text/plain"
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello resource" }] }));
server.registerTool("echo", {
  description: "Echo text",
  inputSchema: { text: z.string() }
}, async ({ text }) => ({ content: [{ type: "text", text }] }));
server.registerTool("explode", {
  description: "Write stderr then fail",
  inputSchema: {}
}, async () => {
  console.error("expected stderr from mcp server");
  throw new Error("boom");
});
server.registerTool("sleep", {
  description: "Hang for a long time (test cancellation)",
  inputSchema: {}
}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 600000));
  return { content: [{ type: "text", text: "slept" }] };
});
server.registerTool("refresh_catalog", {
  description: "Register a new tool and emit tools/list_changed",
  inputSchema: {}
}, async () => {
  setTimeout(() => {
    server.registerTool("after_refresh", {
      description: "Tool added after a live catalog refresh",
      inputSchema: { value: z.string() },
      annotations: { readOnlyHint: true }
    }, async ({ value }) => ({ content: [{ type: "text", text: value }] }));
  }, 10);
  return { content: [{ type: "text", text: "refresh scheduled" }] };
});
await server.connect(new StdioServerTransport());
`,
    "utf8",
  );
  await writeFile(path.join(cwd, "starts.txt"), "0", "utf8");
  await writeFile(
    path.join(cwd, ".reina", "mcp.json"),
    JSON.stringify({
      servers: {
        test: {
          type: "stdio",
          command: process.execPath,
          args: [path.join(cwd, "server.mjs")],
          cwd,
          timeoutMs: 5000,
          env: {
            REINA_MCP_TEST_ENV: "merged",
          },
        },
      },
    }),
    "utf8",
  );
  // Real-process setup (mkdtemp + junction symlink + config writes). The
  // default 10s hook budget gets blown on overloaded CI runners — seen at
  // collect≈42s loads — so give lifecycle hooks explicit headroom.
}, 30_000);

afterEach(async () => {
  await closeMcpClients();
  // The runtime tool cache is keyed on cwd. mkdtemp gives every test a fresh
  // cwd so leakage is unlikely in practice, but clearing here keeps the cache
  // honest across runs and stops one test's tool list from masking another's
  // after a config rewrite.
  clearMcpRuntimeToolsCache();
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
  // Waits on real MCP child-process shutdown before deleting its cwd — same
  // slow-runner headroom rationale as the beforeEach above.
}, 30_000);

describe("MCP tools", () => {
  it("cancels an in-flight MCP tool call when the abort signal fires", async () => {
    await loadMcpRuntimeTools(cwd);
    const controller = new AbortController();
    const started = Date.now();
    const call = runMcpRuntimeTool("mcp__test__sleep", {}, { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    // Without the signal threaded through to the SDK call, this would hang for
    // the server's full 600s sleep (and only a restart would free it).
    await expect(call).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("exposes and calls stdio MCP tools as direct runtime tools", async () => {
    const tools = await loadMcpRuntimeTools(cwd);
    const echo = tools.find((tool) => tool.name === "mcp__test__echo");
    const output = await runMcpRuntimeTool("mcp__test__echo", { text: "hello mcp" }, { cwd });
    const schema = echo?.inputJsonSchema as
      | { properties?: Record<string, { type?: string }>; required?: string[] }
      | undefined;

    expect(echo?.description).toContain("[MCP:test]");
    expect(schema?.properties?.text?.type).toBe("string");
    expect(schema?.required).toContain("text");
    expect(output).toContain("hello mcp");
  });

  it("filters disabled MCP tools from runtime tools", async () => {
    await writeFile(
      path.join(cwd, ".reina", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            cwd,
            timeoutMs: 5000,
            disabledTools: ["explode"],
          },
        },
      }),
      "utf8",
    );

    const toolNames = (await loadMcpRuntimeTools(cwd)).map((tool) => tool.name);

    expect(toolNames).toContain("mcp__test__echo");
    expect(toolNames).not.toContain("mcp__test__explode");
  });

  it("ignores non-Reina MCP config files", async () => {
    await rm(path.join(cwd, ".reina", "mcp.json"), { force: true });
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          claude: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            cwd,
            timeoutMs: 5000,
          },
        },
      }),
      "utf8",
    );
    await mkdir(path.join(cwd, ".codex"), { recursive: true });
    await writeFile(
      path.join(cwd, ".codex", "config.toml"),
      `
[mcp_servers.codex]
command = '${process.execPath.replaceAll("\\", "\\\\")}'
args = ['${path.join(cwd, "server.mjs").replaceAll("\\", "\\\\")}']
`,
      "utf8",
    );

    const toolNames = (await loadMcpRuntimeTools(cwd)).map((tool) => tool.name);

    expect(toolNames).not.toContain("mcp__claude__echo");
    expect(toolNames).not.toContain("mcp__codex__echo");
  });

  it("normalizes serverUrl and disabled fields in Reina config", async () => {
    await writeFile(
      path.join(cwd, ".reina", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          off: {
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            disabled: true,
          },
          remote: {
            type: "sse",
            serverUrl: "https://example.test/sse",
            disabled: false,
          },
        },
      }),
      "utf8",
    );

    const servers = await loadMcpServers(cwd);

    expect(servers.off?.enabled).toBe(false);
    expect(servers.remote).toMatchObject({
      type: "remote",
      url: "https://example.test/sse",
      transport: "sse",
      enabled: true,
    });
  });

  it("reuses stdio MCP clients for runtime tools", async () => {
    await loadMcpRuntimeTools(cwd);
    await loadMcpRuntimeTools(cwd);
    const output = await runMcpRuntimeTool("mcp__test__echo", { text: "direct mcp" }, { cwd });

    const starts = await import("node:fs/promises").then((fs) => fs.readFile(path.join(cwd, "starts.txt"), "utf8"));
    const env = await import("node:fs/promises").then((fs) => fs.readFile(path.join(cwd, "server-env.txt"), "utf8"));

    expect(output).toContain("direct mcp");
    expect(starts).toBe("1");
    expect(env).toBe("merged");
  });

  it("returns the cached descriptor array on a second call with unchanged config", async () => {
    // Identity-stability is the load-bearing assertion: downstream code can
    // hash the descriptor array (or compare references) to detect "MCP
    // catalog changed this turn", which lets Phase 2's dynamic catalog skip
    // rebuild work and keeps prompt-cache prefixes stable.
    const first = await loadMcpRuntimeTools(cwd);
    const second = await loadMcpRuntimeTools(cwd);
    expect(second).toBe(first);
  });

  it("refreshes runtime schemas after a tools/list_changed notification", async () => {
    const before = await loadMcpRuntimeTools(cwd);
    expect(before.find((tool) => tool.name === "mcp__test__after_refresh")).toBeUndefined();

    await runMcpRuntimeTool("mcp__test__refresh_catalog", {}, { cwd });

    let after = before;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      after = await loadMcpRuntimeTools(cwd);
      if (after.some((tool) => tool.name === "mcp__test__after_refresh")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const added = after.find((tool) => tool.name === "mcp__test__after_refresh");
    expect(after).not.toBe(before);
    expect(added).toMatchObject({
      description: "[MCP:test] Tool added after a live catalog refresh",
      permission: "read",
      requiresApproval: false,
    });
    expect(added?.inputJsonSchema).toMatchObject({
      type: "object",
      properties: { value: expect.objectContaining({ type: "string" }) },
      required: ["value"],
    });
  });

  it("invalidates the cache when mcp.json gains or loses a server", async () => {
    const before = await loadMcpRuntimeTools(cwd);
    // Disable the existing server — the loaded config changes, so the cache
    // key changes, so the next call must rebuild.
    await writeFile(
      path.join(cwd, ".reina", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            cwd,
            timeoutMs: 5000,
            disabled: true,
          },
        },
      }),
      "utf8",
    );
    const after = await loadMcpRuntimeTools(cwd);
    expect(after).not.toBe(before);
    expect(after.find((tool) => tool.name === "mcp__test__echo")).toBeUndefined();
  });

  it("keeps MCP tool errors in the tool output", async () => {
    const output = await runMcpRuntimeTool("mcp__test__explode", {}, { cwd });

    expect(output).toContain("[MCP tool returned error]");
    expect(output).toContain("boom");
  });

  it("lists and reads MCP resources", async () => {
    const listed = await runTool("mcp_list_resources", { server: "test" }, { cwd });
    const read = await runTool("mcp_read_resource", { server: "test", uri: "reina://note" }, { cwd });

    expect(listed.error).toBeUndefined();
    expect(read.error).toBeUndefined();
    expect(listed.output).toContain("reina://note");
    expect(read.output).toContain("hello resource");
  });

  it("restricts MCP resource fan-out, explicit reads, and status to the profile server allow-list", async () => {
    await writeFile(
      path.join(cwd, ".reina", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            cwd,
            timeoutMs: 5000,
          },
          blocked: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(cwd, "server.mjs")],
            cwd,
            timeoutMs: 5000,
          },
        },
      }),
      "utf8",
    );
    const options = { cwd, allowedMcpServers: ["test"] };

    const listed = await runTool("mcp_list_resources", {}, options);
    const blockedRead = await runTool("mcp_read_resource", { server: "blocked", uri: "reina://note" }, options);
    const missingAllowedRead = await runTool(
      "mcp_read_resource",
      { server: "missing", uri: "reina://note" },
      { cwd, allowedMcpServers: ["test", "missing"] },
    );
    const status = await runTool("mcp_status", {}, options);

    expect(listed.error).toBeUndefined();
    expect(listed.output).toContain('"server": "test"');
    expect(listed.output).not.toContain('"server": "blocked"');
    expect(blockedRead.error).toContain('MCP server "blocked" is not available to the active agent profile.');
    expect(missingAllowedRead.error).toContain("Available servers: test.");
    expect(missingAllowedRead.error).not.toContain("blocked");
    expect(status.error).toBeUndefined();
    expect(status.output).toContain('"test"');
    expect(status.output).not.toContain('"blocked"');
  });

  it("flips MCP status to failed when the transport closes unexpectedly", async () => {
    // Warm-up call connects the client and records the live status.
    await runMcpRuntimeTool("mcp__test__echo", { text: "warmup" }, { cwd });
    expect((await getMcpStatusForCwd(cwd)).test).toEqual({ status: "connected" });

    // Kill the server out-of-band so the transport.onclose wiring (not the
    // in-flight catch path in withMcpClient) is what fires onDisconnect.
    // The server wrote its pid on startup; we kill it directly.
    const { readFile } = await import("node:fs/promises");
    const pid = Number(await readFile(path.join(cwd, "pid.txt"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    process.kill(pid);

    // onclose lands on the next event-loop tick once the OS reaps the child;
    // poll briefly so the test isn't a sleep-and-pray race.
    const deadline = Date.now() + 2000;
    let status: { status: string } | undefined;
    while (Date.now() < deadline) {
      status = (await getMcpStatusForCwd(cwd)).test;
      if (status?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status?.status).toBe("failed");

    // The pool entry must also be gone — otherwise the next call would
    // reuse a dead client. Easy proxy: the next echo triggers a fresh
    // server start (starts.txt counter bumps to 2).
    await runMcpRuntimeTool("mcp__test__echo", { text: "after restart" }, { cwd });
    const starts = await readFile(path.join(cwd, "starts.txt"), "utf8");
    expect(starts).toBe("2");
  });
});
