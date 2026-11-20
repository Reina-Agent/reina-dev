import { spawn } from "node:child_process";
import { errorMessage } from "@reina/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CallToolResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  ContentBlock,
  ListResourcesResult,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { isRemoteServer, isServerEnabled, loadMcpServers, resolveMcpServer } from "./mcp-config.js";
import type { McpRemoteServerConfig, McpServerConfig, McpStdioServerConfig } from "./mcp-config.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 16 * 1024;
const connections = new Map<string, Promise<McpConnection>>();
/** In-flight `withMcpClient` call count per connection key. A shared client is
 * only torn down on error when no sibling call is still using it — see
 * `withMcpClient`. */
const inFlightByKey = new Map<string, number>();

/** Per-server connection state. The model can introspect this via the
 * `mcp_status` tool, and the desktop UI surfaces it in the MCP settings
 * panel so users see at a glance whether a server is reachable. */
export type McpStatus = { status: "connected" } | { status: "disabled" } | { status: "failed"; error: string };

const statusMap = new Map<string, McpStatus>();
let toolCatalogRevision = 0;

/** Monotonic process-local revision for successful tools/list_changed refreshes.
 * Runtime descriptor caches include this value in their validity check so a
 * server-side schema/annotation update becomes visible on the next load. */
export function getMcpToolCatalogRevision(): number {
  return toolCatalogRevision;
}

type McpConnection = {
  client: Client;
  stderr: string[];
  tools: Tool[];
  /** Stdio only — keep the spawned process's pid around so we can kill the
   * whole tree on shutdown (the SDK only SIGTERMs the direct child, leaving
   * grandchildren orphaned). */
  pid?: number;
};

const tolerantToolSchema = ToolSchema.extend({
  outputSchema: z.unknown().optional(),
});

const tolerantListToolsResultSchema = z.looseObject({
  tools: z.array(tolerantToolSchema),
  nextCursor: z.string().optional(),
});

export function getMcpStatusMap(): Record<string, McpStatus> {
  return Object.fromEntries(statusMap.entries());
}

/** Compute the live status for every configured server in `cwd`. Configured
 * but never-touched servers default to "disabled" (we haven't tried yet) or
 * "failed" if they previously errored. Useful for settings UIs that want to
 * render a colored dot per server before the model has touched any of them. */
export async function getMcpStatusForCwd(cwd: string): Promise<Record<string, McpStatus>> {
  const servers = await loadMcpServers(cwd).catch(() => ({}));
  const result: Record<string, McpStatus> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!isServerEnabled(config)) {
      result[name] = { status: "disabled" };
      continue;
    }
    result[name] = statusMap.get(name) ?? { status: "disabled" };
  }
  return result;
}

/** Connect every enabled server in parallel without blocking the caller on a
 * single slow / broken one. Errors are captured into the status map; this
 * never throws. Intended for warm-up at session boot. */
export async function precomputeMcpServers(cwd: string): Promise<void> {
  const servers = await loadMcpServers(cwd).catch(() => ({}));
  await Promise.allSettled(
    Object.entries(servers)
      .filter(([, config]) => isServerEnabled(config))
      .map(async ([name, config]) => {
        try {
          const resolved = resolveMcpServer(cwd, name, servers);
          await listMcpToolDefs(name, resolved);
        } catch {
          // resolve/list errors are already recorded in statusMap by
          // createConnection. Don't propagate — pre-connect is best-effort.
        }
      }),
  );
}

export async function withMcpClient<T>(
  name: string,
  config: McpServerConfig,
  fn: (connection: McpConnection, timeoutMs: number) => Promise<T>,
): Promise<T> {
  if (!isServerEnabled(config)) {
    statusMap.set(name, { status: "disabled" });
    throw new Error(`MCP server "${name}" is disabled in config (set "enabled": true to use it).`);
  }
  const key = connectionKey(name, config);
  const connection = await getConnection(key, name, config);
  inFlightByKey.set(key, (inFlightByKey.get(key) ?? 0) + 1);
  try {
    return await fn(connection, timeoutFor(config));
  } catch (error) {
    statusMap.set(name, { status: "failed", error: errorMessage(error) });
    // The client is SHARED (cached per key). Only tear it down when this is the
    // sole in-flight call — closing it while a sibling batched call is mid-
    // request makes the SDK reject that sibling with "Connection closed",
    // turning one call's (often application-level) error into many spurious
    // failures. If the connection is genuinely dead, the last remaining call
    // cleans it up here.
    if ((inFlightByKey.get(key) ?? 0) <= 1) {
      connections.delete(key);
      await connection.client.close().catch(() => undefined);
    }
    throw new Error(formatMcpError(name, error, connection.stderr));
  } finally {
    const remaining = (inFlightByKey.get(key) ?? 1) - 1;
    if (remaining <= 0) inFlightByKey.delete(key);
    else inFlightByKey.set(key, remaining);
  }
}

export async function listMcpToolDefs(name: string, config: McpServerConfig): Promise<Tool[]> {
  return withMcpClient(name, config, async (connection) => connection.tools);
}

export async function closeMcpClients(): Promise<void> {
  const existing = [...connections.values()];
  connections.clear();
  await Promise.all(
    existing.map(async (promise) => {
      const connection = await promise.catch(() => undefined);
      if (!connection) return;
      if (typeof connection.pid === "number") await killProcessTree(connection.pid).catch(() => undefined);
      await connection.client.close().catch(() => undefined);
    }),
  );
  statusMap.clear();
}

function getConnection(key: string, name: string, config: McpServerConfig): Promise<McpConnection> {
  const existing = connections.get(key);
  if (existing) return existing;
  const created = createConnection(name, config).catch((error) => {
    connections.delete(key);
    statusMap.set(name, { status: "failed", error: errorMessage(error) });
    throw error;
  });
  connections.set(key, created);
  return created;
}

async function createConnection(name: string, config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "reina", version: "0.1.0" }, { capabilities: {} });
  const stderr: string[] = [];
  let pid: number | undefined;
  const key = connectionKey(name, config);

  // Proactive disconnect detection: when the underlying transport closes
  // (child process exits, HTTP/SSE connection dropped) or errors out, drop
  // the connection from the pool and update status. Without this, the
  // cache returns a dead client until the next operation fails, which
  // looks like "connected" in the UI for arbitrarily long.
  const onDisconnect = (reason: "close" | "error", error?: Error): void => {
    const existing = connections.get(key);
    if (!existing) return;
    connections.delete(key);
    const msg = error ? `${reason}: ${error.message}` : `transport ${reason}`;
    statusMap.set(name, { status: "failed", error: msg });
    void existing.then((conn) => conn.client.close().catch(() => undefined)).catch(() => undefined);
  };

  const timeout = timeoutFor(config);
  try {
    if (isRemoteServer(config)) {
      const transport = buildRemoteTransport(name, config);
      transport.onclose = () => onDisconnect("close");
      transport.onerror = (error) => onDisconnect("error", error);
      await client.connect(transport, { timeout });
    } else {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: resolveEnvironment(config),
        cwd: config.cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => {
        stderr.push(String(chunk));
        while (Buffer.byteLength(stderr.join(""), "utf8") > MAX_STDERR_BYTES) stderr.shift();
      });
      transport.onclose = () => onDisconnect("close");
      transport.onerror = (error) => onDisconnect("error", error);
      await client.connect(transport, { timeout });
      pid = transport.pid ?? undefined;
    }

    let tools = await fetchToolDefs(name, client, timeout);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        tools = await fetchToolDefs(name, client, timeout);
        toolCatalogRevision += 1;
      } catch {
        // Keep the last known-good catalog and revision. A failed refresh must
        // not invalidate runtime schemas to another equally stale snapshot.
      }
    });
    statusMap.set(name, { status: "connected" });
    return {
      client,
      stderr,
      pid,
      get tools() {
        return tools;
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    statusMap.set(name, { status: "failed", error: errorMessage(error) });
    throw new Error(formatMcpError(name, error, stderr));
  }
}

function buildRemoteTransport(name: string, config: McpRemoteServerConfig) {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`Invalid MCP remote URL for "${name}": ${config.url}`);
  }
  const requestInit: RequestInit | undefined = config.headers ? { headers: config.headers } : undefined;
  const transport = config.transport ?? "http";
  if (transport === "sse") return new SSEClientTransport(url, { requestInit });
  return new StreamableHTTPClientTransport(url, { requestInit });
}

function timeoutFor(config: McpServerConfig): number {
  return config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
}

/** Wall-clock ceiling for one tool call that `resetTimeoutOnProgress` cannot
 * extend past. A misbehaving or malicious MCP server can stream periodic
 * progress notifications to defer the regular `timeout` indefinitely; this
 * cap ensures every call settles within a bounded window. Default: 10× the
 * regular timeout, floor 5 min. Override via REINA_MCP_TOOL_HARD_CAP_MS. */
function callHardCapMs(config: McpServerConfig): number {
  const raw = process.env.REINA_MCP_TOOL_HARD_CAP_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const base = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  return Math.max(base * 10, 5 * 60_000);
}

async function withCallHardCap<T>(promise: Promise<T>, capMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${label} exceeded hard cap of ${capMs}ms; resetTimeoutOnProgress cannot extend past this ceiling.`),
      );
    }, capMs);
  });
  try {
    return await Promise.race([promise, cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatMcpToolResult(result: CallToolResult): string {
  if (!("content" in result)) return JSON.stringify(result, null, 2);
  const blocks = result.content.map(formatContentBlock);
  return [result.isError ? "[MCP tool returned error]" : undefined, ...blocks].filter(Boolean).join("\n");
}

function formatContentBlock(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "resource") {
    const resource = block.resource;
    if ("text" in resource)
      return [
        `Resource: ${resource.uri}`,
        resource.mimeType ? `MIME: ${resource.mimeType}` : undefined,
        "",
        resource.text,
      ]
        .filter((line) => line !== undefined)
        .join("\n");
    return [
      `Resource: ${resource.uri}`,
      resource.mimeType ? `MIME: ${resource.mimeType}` : undefined,
      "",
      `[blob content: ${resource.blob.length} base64 chars]`,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  return JSON.stringify(block);
}

function formatMcpError(name: string, error: unknown, stderr: string[]): string {
  const message = errorMessage(error);
  const output = stderr.join("").trim();
  // A spawn ENOENT means the server's `command` isn't on this machine's PATH —
  // the #1 failure on end-user installs (e.g. `npx` with no Node.js, or a
  // GUI-launched app that can't see shell-profile PATH entries). Say so
  // instead of surfacing the bare syscall error.
  const hint = /\bENOENT\b/.test(message)
    ? 'The configured command was not found on this machine. Install the runtime it needs (e.g. Node.js for "npx") or set an absolute command path in mcp.json.'
    : undefined;
  return [`MCP server ${name} failed: ${message}`, hint, output ? `stderr:\n${output}` : undefined]
    .filter(Boolean)
    .join("\n");
}

function resolveEnvironment(config: McpStdioServerConfig): Record<string, string> | undefined {
  const base = config.inheritEnv === false ? {} : getDefaultEnvironment();
  return { ...base, ...config.env };
}

function connectionKey(name: string, config: McpServerConfig): string {
  if (isRemoteServer(config)) {
    return JSON.stringify({
      kind: "remote",
      name,
      url: config.url,
      transport: config.transport ?? "http",
      headers: config.headers ?? {},
      timeoutMs: timeoutFor(config),
    });
  }
  return JSON.stringify({
    kind: "stdio",
    name,
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    env: config.env ?? {},
    inheritEnv: config.inheritEnv ?? true,
    timeoutMs: timeoutFor(config),
  });
}

async function fetchToolDefs(name: string, client: Client, timeout: number): Promise<Tool[]> {
  try {
    return (await client.listTools(undefined, { timeout })).tools;
  } catch (error) {
    if (!isOutputSchemaValidationError(error)) throw error;
    const result = await client.request({ method: "tools/list" }, tolerantListToolsResultSchema, { timeout });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })) as Tool[];
  }
}

export async function callMcpTool(
  name: string,
  config: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const capMs = callHardCapMs(config);
  const result = await withMcpClient(name, config, async (connection, timeout) =>
    withCallHardCap(
      // Thread the engine's abort signal into the SDK request so a user
      // interrupt (or session teardown) cancels an in-flight call — without it
      // a hung/long-running MCP tool can only be escaped by restarting the
      // whole agent-host process.
      connection.client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
        resetTimeoutOnProgress: true,
        timeout,
        signal,
      }),
      capMs,
      `MCP tool ${tool} on ${name}`,
    ),
  );
  return formatMcpToolResult(result as CallToolResult);
}

export async function listMcpResources(name: string, config: McpServerConfig): Promise<ListResourcesResult> {
  return withMcpClient(name, config, async (connection, timeout) =>
    connection.client.request({ method: "resources/list" }, ListResourcesResultSchema, { timeout }),
  );
}

export async function readMcpResource(name: string, config: McpServerConfig, uri: string): Promise<ReadResourceResult> {
  return withMcpClient(name, config, async (connection, timeout) =>
    connection.client.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema, { timeout }),
  );
}

function isOutputSchemaValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /can't resolve reference|outputSchema|schema.*reference|reference.*schema/i.test(error.message)
  );
}

/** Kill the process and all its descendants. The MCP SDK only SIGTERMs the
 * direct child it spawned, so anything the server itself forked (e.g. a node
 * wrapper script that launched a python helper) hangs around as a zombie.
 * Windows: `taskkill /T /F /PID` walks the tree natively. Unix: walk via
 * `pgrep -P` recursively and SIGTERM each pid we find. */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
    return;
  }
  const pids = await collectDescendants(pid);
  for (const p of [...pids, pid]) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // Already gone or out of our perms — fine, keep walking.
    }
  }
}

async function collectDescendants(pid: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  const collected: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const children = await pgrepChildren(current).catch(() => []);
    for (const child of children) {
      if (collected.includes(child)) continue;
      collected.push(child);
      queue.push(child);
    }
  }
  return collected;
}

function pgrepChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-P", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk as Buffer));
    child.on("exit", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const pids = text
        .split(/\s+/)
        .map((value) => parseInt(value, 10))
        .filter((value) => Number.isFinite(value));
      resolve(pids);
    });
    child.on("error", () => resolve([]));
  });
}
