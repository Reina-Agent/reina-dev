import { readFile } from "node:fs/promises";
import { errorMessage } from "@reina/protocol";
import os from "node:os";
import path from "node:path";
import { z, ZodError } from "zod";

// stdio: spawn a local process and talk over its stdin/stdout. The bulk of
// existing MCP servers (filesystem, git, sqlite, postgres…) are distributed
// this way. `type` is optional so older configs without the discriminator keep
// parsing under the stdio path.
export const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  inheritEnv: z.boolean().optional(),
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
});

// remote: talk to an HTTP MCP endpoint. Defaults to the StreamableHTTP
// transport (the current MCP standard); SSE remains for older servers that
// only speak the legacy text/event-stream protocol. `headers` is the auth
// channel — bearer tokens / API keys get attached to every request.
export const mcpRemoteServerSchema = z.object({
  type: z.literal("remote"),
  url: z.string(),
  transport: z.enum(["http", "sse"]).optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
});

export const mcpServerSchema = z.union([mcpStdioServerSchema, mcpRemoteServerSchema]);

export type McpStdioServerConfig = z.infer<typeof mcpStdioServerSchema> & { type?: "stdio" };
export type McpRemoteServerConfig = z.infer<typeof mcpRemoteServerSchema>;
export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export type McpServerSource = {
  id: string;
  label: string;
  path: string;
};

const mcpConfigSchema = z.object({
  mcp: z
    .object({
      servers: z.record(mcpServerSchema).optional(),
    })
    .optional(),
});

const standaloneMcpConfigSchema = z.object({
  servers: z.record(mcpServerSchema).optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
});

export function isStdioServer(config: McpServerConfig): config is McpStdioServerConfig {
  return (config.type ?? "stdio") === "stdio";
}

export function isRemoteServer(config: McpServerConfig): config is McpRemoteServerConfig {
  return config.type === "remote";
}

export function isServerEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

export async function loadMcpServers(cwd: string): Promise<Record<string, McpServerConfig>> {
  const globalMcpFile = mcpConfigPathFor(cwd);
  const workspaceMcpFile = workspaceMcpConfigPathFor(cwd);
  const globalMcpRaw = await readFile(globalMcpFile, "utf8").catch(() => undefined);
  const workspaceMcpRaw = await readFile(workspaceMcpFile, "utf8").catch(() => undefined);
  if (globalMcpRaw || workspaceMcpRaw) {
    return {
      ...(globalMcpRaw ? parseStandaloneMcpJson(globalMcpFile, globalMcpRaw) : {}),
      ...(workspaceMcpRaw ? parseStandaloneMcpJson(workspaceMcpFile, workspaceMcpRaw) : {}),
    };
  }
  const globalJsonFile = configPathFor(cwd);
  const workspaceJsonFile = path.join(cwd, ".reina", "config.json");
  const raw = (await readFile(workspaceJsonFile, "utf8").catch(() => undefined)) ?? (await readFile(globalJsonFile, "utf8").catch(() => undefined));
  if (!raw) return {};
  try {
    const parsed = mcpConfigSchema.parse(JSON.parse(stripBom(raw)));
    return parsed.mcp?.servers ?? {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid legacy workspace .reina/config.json MCP config: ${error.message}`);
    }
    if (error instanceof ZodError) {
      throw new Error(`Invalid legacy workspace .reina/config.json MCP config: ${error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    throw error;
  }
}

export function mcpConfigPathFor(_cwd?: string): string {
  return path.join(reinaConfigHome(), "mcp.json");
}

export function workspaceMcpConfigPathFor(cwd: string): string {
  return path.join(path.resolve(cwd), ".reina", "mcp.json");
}

export function configPathFor(_cwd?: string): string {
  return path.join(reinaConfigHome(), "config.json");
}

export function workspaceConfigPathFor(cwd: string): string {
  return path.join(path.resolve(cwd), ".reina", "config.json");
}

export function reinaConfigHome(): string {
  return process.env.REINA_CONFIG_HOME ? path.resolve(process.env.REINA_CONFIG_HOME) : path.join(os.homedir(), ".reina");
}

export async function loadMcpServerSources(cwd: string): Promise<Record<string, McpServerSource>> {
  const sources: Record<string, McpServerSource> = {};
  const add = (source: McpServerSource, servers: Record<string, McpServerConfig>) => {
    for (const name of Object.keys(servers)) sources[name] = source;
  };
  const resolvedCwd = path.resolve(cwd);
  const globalMcpFile = mcpConfigPathFor(cwd);
  const workspaceMcpFile = workspaceMcpConfigPathFor(cwd);
  const globalJsonFile = configPathFor(cwd);
  const workspaceJsonFile = path.join(resolvedCwd, ".reina", "config.json");

  const [globalMcpRaw, workspaceMcpRaw] = await Promise.all([
    readFile(globalMcpFile, "utf8").catch(() => undefined),
    readFile(workspaceMcpFile, "utf8").catch(() => undefined),
  ]);

  if (globalMcpRaw) add({ id: "reina-global", label: "Reina global", path: globalMcpFile }, parseStandaloneMcpJson(globalMcpFile, globalMcpRaw));
  if (workspaceMcpRaw) add({ id: "reina-project", label: "Reina project", path: workspaceMcpFile }, parseStandaloneMcpJson(workspaceMcpFile, workspaceMcpRaw));

  if (!globalMcpRaw && !workspaceMcpRaw) {
    const raw = (await readFile(workspaceJsonFile, "utf8").catch(() => undefined)) ?? (await readFile(globalJsonFile, "utf8").catch(() => undefined));
    if (raw) {
      const file = await readFile(workspaceJsonFile, "utf8").catch(() => undefined) ? workspaceJsonFile : globalJsonFile;
      const parsed = mcpConfigSchema.parse(JSON.parse(stripBom(raw)));
      add({ id: file === workspaceJsonFile ? "reina-legacy-project" : "reina-legacy-global", label: file === workspaceJsonFile ? "Reina legacy project" : "Reina legacy global", path: file }, parsed.mcp?.servers ?? {});
    }
  }

  return sources;
}

function parseStandaloneMcpJson(file: string, raw: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(stripBom(raw));
    const out: Record<string, McpServerConfig> = {};
    mergeMcpServerRecord(out, parsed?.servers);
    mergeMcpServerRecord(out, parsed?.mcpServers);
    return out;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${file}: ${error.message}`);
    }
    throw new Error(`Invalid ${file}: ${errorMessage(error)}`);
  }
}

function mergeMcpServerRecord(out: Record<string, McpServerConfig>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [name, config] of Object.entries(value)) {
    const parsed = mcpServerSchema.safeParse(normalizeMcpServerConfig(config));
    if (parsed.success) out[name] = parsed.data;
  }
}

function normalizeMcpServerConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw.disabled === "boolean" && typeof raw.enabled !== "boolean") out.enabled = !raw.disabled;
  if (typeof raw.serverUrl === "string" && typeof raw.url !== "string") out.url = raw.serverUrl;
  if (typeof out.url === "string") {
    const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
    out.type = "remote";
    if (type === "sse") out.transport = "sse";
    if (type === "http" || type === "streamable-http") out.transport = "http";
  }
  if (typeof raw.timeout === "number" && typeof raw.timeoutMs !== "number") out.timeoutMs = raw.timeout;
  delete out.disabled;
  delete out.serverUrl;
  delete out.autoApprove;
  delete out.autoApproveTools;
  return out;
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** Look up a server by name and return a normalized config. Throws an error
 * that names *available* servers when the lookup misses — keeps the model from
 * guessing wildly on a 404 and gives the user a clear hint when they typo a
 * name in their config. */
export function resolveMcpServer(cwd: string, name: string, servers: Record<string, McpServerConfig>): McpServerConfig {
  const server = servers[name];
  if (!server) {
    const available = Object.keys(servers);
    const hint = available.length === 0
      ? "No MCP servers are configured. Add one to ~/.reina/mcp.json or <workspace>/.reina/mcp.json before calling MCP tools."
      : `Available servers: ${available.join(", ")}. Re-run the tool with one of these names, or omit the server argument to fan out across all of them.`;
    throw new Error(`MCP server not found: ${name}. ${hint}`);
  }
  if (isStdioServer(server)) {
    return {
      ...server,
      cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
    };
  }
  return server;
}
