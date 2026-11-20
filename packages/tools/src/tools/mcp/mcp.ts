import { z } from "zod";
import { errorMessage } from "@reina/protocol";
import type { ToolImplementation } from "../../types.js";
import { formatJson, truncateToolOutput } from "../../utils.js";
import { isServerEnabled, loadMcpServers, resolveMcpServer } from "../../mcp-config.js";
import { getMcpStatusForCwd, listMcpResources, readMcpResource } from "../../mcp-client.js";
import { description as mcpListResourcesDescription } from "../../prompts/mcp-list-resources.js";
import { description as mcpReadResourceDescription } from "../../prompts/mcp-read-resource.js";
import { description as mcpStatusDescription } from "../../prompts/mcp-status.js";

const resourceListSchema = z.object({
  server: z
    .string()
    .optional()
    .describe(
      "Optional. Name of an MCP server available to the active agent profile. Omit to list across every server available to that profile.",
    ),
});
const resourceReadSchema = z.object({
  server: z
    .string()
    .describe("Name of the MCP server hosting the resource (from the list returned by mcp_list_resources)."),
  uri: z.string().describe("Resource URI as returned by mcp_list_resources."),
});
const statusSchema = z.object({});

function isMcpServerAllowed(name: string, allowed: ReadonlyArray<string> | undefined): boolean {
  return !allowed?.length || allowed.includes(name);
}

function assertMcpServerAllowed(name: string, allowed: ReadonlyArray<string> | undefined): void {
  if (!isMcpServerAllowed(name, allowed)) {
    throw new Error(`MCP server "${name}" is not available to the active agent profile.`);
  }
}

export const mcpListResourcesTool: ToolImplementation = {
  descriptor: {
    name: "mcp_list_resources",
    description: mcpListResourcesDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "List resources exposed by MCP servers available to this profile.",
    inputSchema: resourceListSchema,
  },
  async execute(input, options) {
    const parsed = resourceListSchema.parse(input ?? {});
    if (parsed.server) assertMcpServerAllowed(parsed.server, options.allowedMcpServers);
    const servers = await loadMcpServers(options.cwd);
    const available = Object.keys(servers).filter(
      (name) => isServerEnabled(servers[name]!) && isMcpServerAllowed(name, options.allowedMcpServers),
    );
    // Validate the filter before doing any work: if the model passed a name
    // that isn't configured, fail fast with the list of names it should pick
    // from. This is what was hallucinated as `desktop` in the original report.
    if (parsed.server && !available.includes(parsed.server)) {
      const hint =
        available.length === 0
          ? "No MCP servers are configured. Add one to ~/.reina/mcp.json or <workspace>/.reina/mcp.json before retrying."
          : `Available servers: ${available.join(", ")}. Retry with one of these names, or omit the server argument to fan out across all of them.`;
      return `MCP server not found: ${parsed.server}. ${hint}`;
    }
    const names = parsed.server ? [parsed.server] : available;
    if (names.length === 0) {
      return options.allowedMcpServers?.length
        ? "No MCP servers available to the active agent profile."
        : "No MCP servers configured.";
    }
    const results = [];
    for (const name of names) {
      try {
        const config = resolveMcpServer(options.cwd, name, servers);
        const result = await listMcpResources(name, config);
        results.push({ server: name, resources: result.resources ?? [] });
      } catch (error) {
        results.push({ server: name, error: errorMessage(error) });
      }
    }
    return (await truncateToolOutput(options.cwd, formatJson(results))).content;
  },
};

export const mcpReadResourceTool: ToolImplementation = {
  descriptor: {
    name: "mcp_read_resource",
    description: mcpReadResourceDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Read one permitted MCP resource by (server, uri).",
    inputSchema: resourceReadSchema,
  },
  async execute(input, options) {
    const parsed = resourceReadSchema.parse(input);
    assertMcpServerAllowed(parsed.server, options.allowedMcpServers);
    const servers = await loadMcpServers(options.cwd);
    const allowedServers = options.allowedMcpServers;
    const visibleServers = allowedServers?.length
      ? Object.fromEntries(Object.entries(servers).filter(([name]) => allowedServers.includes(name)))
      : servers;
    const config = resolveMcpServer(options.cwd, parsed.server, visibleServers);
    return (await truncateToolOutput(options.cwd, formatJson(await readMcpResource(parsed.server, config, parsed.uri))))
      .content;
  },
};

export const mcpStatusTool: ToolImplementation = {
  descriptor: {
    name: "mcp_status",
    description: mcpStatusDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Report permitted MCP servers + their connection status.",
    inputSchema: statusSchema,
  },
  async execute(_input, options) {
    const status = await getMcpStatusForCwd(options.cwd);
    const available = Object.fromEntries(
      Object.entries(status).filter(([name]) => isMcpServerAllowed(name, options.allowedMcpServers)),
    );
    if (Object.keys(available).length === 0) {
      return options.allowedMcpServers?.length
        ? "No MCP servers available to the active agent profile."
        : "No MCP servers configured.";
    }
    return (await truncateToolOutput(options.cwd, formatJson(available))).content;
  },
};
