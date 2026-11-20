import { z } from "zod";
import { errorMessage } from "@reina/protocol";
import type { ToolDescriptor, ToolName } from "@reina/protocol";
import { isServerEnabled, loadMcpServers, resolveMcpServer, type McpServerConfig } from "./mcp-config.js";
import { callMcpTool, getMcpToolCatalogRevision, listMcpToolDefs } from "./mcp-client.js";
import { summarizeToolSchema, synthesizeExampleFromJsonSchema } from "./schema-summary.js";
import type { ToolRuntimeOptions } from "./types.js";
import { truncateToolOutput } from "./utils.js";

const mcpToolPrefix = "mcp__";

export type McpRuntimeTool = ToolDescriptor & {
  mcpServer: string;
  mcpTool: string;
};

export type McpRuntimeTarget = Pick<McpRuntimeTool, "mcpServer" | "mcpTool">;

export function isMcpRuntimeTool(name: string): boolean {
  return name.startsWith(mcpToolPrefix);
}

// Per-cwd cache of the runtime tool descriptor array. `listMcpToolDefs` itself
// is cheap once a connection is warm (the MCP client caches the tools list at
// handshake), but rebuilding the descriptor array on every turn still costs
// two fs reads via `loadMcpServers`, a Promise.all fan-out, and a fresh
// allocation. The bigger reason this exists is identity stability: returning
// the same array reference turn-to-turn keeps downstream prompt-cache work
// from spuriously busting whenever the MCP catalog gets rebuilt. Keyed on
// stable JSON of the loaded servers config plus the MCP client's live catalog
// revision, so either an mcp.json edit or tools/list_changed invalidates it.
//
// `failedServers` records servers whose listTools failed when the entry was
// built (typically down at session boot). A non-empty list schedules a
// BACKGROUND rebuild on later cache hits (cooldown-gated) so a recovered
// server's tools eventually register — without it, a server down at boot
// stayed toolless until mcp.json was edited or the app restarted, and without
// the background part a down server's 30s listTools timeout would stall every
// turn start. (kimi-code's "keep tools registered across failures" patch
// addresses the same failure mode.)
type RuntimeToolsCacheEntry = {
  configKey: string;
  catalogRevision: number;
  tools: McpRuntimeTool[];
  failedServers: string[];
  refreshInFlight?: boolean;
  builtAt: number;
};
const runtimeToolsCache = new Map<string, RuntimeToolsCacheEntry>();

const FAILED_SERVER_REFRESH_COOLDOWN_MS = 60_000;

function configKeyFor(servers: Record<string, McpServerConfig>): string {
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(servers).sort()) sorted[name] = servers[name];
  return JSON.stringify(sorted);
}

/** Drop every cached runtime tool list. Tests use this between cases so a
 * fresh mcp.json doesn't get masked by a stale entry; `closeMcpClients`
 * could also reach for it when shutting down a session's MCP fleet, since
 * the descriptor array references connections that are about to die. */
export function clearMcpRuntimeToolsCache(): void {
  runtimeToolsCache.clear();
}

export async function loadMcpRuntimeTools(cwd: string): Promise<McpRuntimeTool[]> {
  const servers = await loadMcpServers(cwd);
  const configKey = configKeyFor(servers);
  const catalogRevision = getMcpToolCatalogRevision();
  const cached = runtimeToolsCache.get(cwd);
  if (cached && cached.configKey === configKey && cached.catalogRevision === catalogRevision) {
    maybeRefreshFailedServers(cwd, servers, configKey, cached);
    return cached.tools;
  }
  const entry = await buildRuntimeToolsEntry(cwd, servers, configKey, catalogRevision);
  runtimeToolsCache.set(cwd, entry);
  return entry.tools;
}

/** A cached catalog built while some servers were down gets rebuilt in the
 * BACKGROUND (fire-and-forget, cooldown-gated, single-flight) so the turn
 * that hit the cache never waits on a down server's listTools timeout; the
 * healed catalog lands for the next turn. */
function maybeRefreshFailedServers(
  cwd: string,
  servers: Record<string, McpServerConfig>,
  configKey: string,
  cached: RuntimeToolsCacheEntry,
): void {
  if (cached.failedServers.length === 0 || cached.refreshInFlight) return;
  if (Date.now() - cached.builtAt < FAILED_SERVER_REFRESH_COOLDOWN_MS) return;
  cached.refreshInFlight = true;
  void buildRuntimeToolsEntry(cwd, servers, configKey, getMcpToolCatalogRevision())
    .then((entry) => {
      // A concurrent mcp.json edit swapped the entry — the fresh build wins
      // only when it's still describing the same config.
      const current = runtimeToolsCache.get(cwd);
      if (current && current.configKey === configKey) runtimeToolsCache.set(cwd, entry);
    })
    .catch(() => {
      cached.refreshInFlight = false;
    });
}

async function buildRuntimeToolsEntry(
  cwd: string,
  servers: Record<string, McpServerConfig>,
  configKey: string,
  catalogRevision: number,
): Promise<RuntimeToolsCacheEntry> {
  // Fan out the listTools calls in parallel — most failures are cold-start
  // timeouts where each takes the full DEFAULT_MCP_TIMEOUT_MS, and serialising
  // them used to add up to a minute or more of dead air at session boot.
  const entries = await Promise.all(
    Object.entries(servers)
      .filter(([, config]) => isServerEnabled(config))
      .map(async ([name, config]) => {
        const resolved = resolveMcpServer(cwd, name, servers);
        const disabledTools = new Set(config.disabledTools ?? []);
        // `null` (listing failed) is kept distinct from "zero tools" so the
        // failure can schedule the background refresh above.
        const defs = await listMcpToolDefs(name, resolved).catch(() => null);
        return [name, defs === null ? null : defs.filter((def) => !disabledTools.has(def.name))] as const;
      }),
  );
  const result: McpRuntimeTool[] = [];
  const failedServers: string[] = [];
  for (const [name, defs] of entries) {
    if (defs === null) {
      failedServers.push(name);
      continue;
    }
    for (const def of defs) {
      result.push({
        name: mcpRuntimeToolName(name, def.name),
        description: `[MCP:${name}] ${def.description ?? def.name}`,
        permission: def.annotations?.readOnlyHint ? "read" : def.annotations?.openWorldHint ? "network" : "execute",
        requiresApproval: !def.annotations?.readOnlyHint,
        inputSchema: z.object({}).passthrough(),
        inputJsonSchema: mcpInputJsonSchema(def.inputSchema),
        mcpServer: name,
        mcpTool: def.name,
      });
    }
  }
  assertUniqueRuntimeToolNames(result);
  return { configKey, catalogRevision, tools: result, failedServers, builtAt: Date.now() };
}

export async function runMcpRuntimeTool(
  name: ToolName,
  input: unknown,
  options: ToolRuntimeOptions,
  boundTarget?: McpRuntimeTarget,
): Promise<string> {
  // The engine binds this raw identity when it authorizes the descriptor and
  // keeps it on the ToolCallRecord across approval pauses. Legacy/direct
  // callers without that binding may proceed only when the current catalog
  // contains exactly one descriptor for the model-facing name.
  const target = boundTarget ?? (await resolveUniqueRuntimeTarget(name, options.cwd));
  if (mcpRuntimeToolName(target.mcpServer, target.mcpTool) !== name) {
    throw new Error(`MCP runtime target does not match tool name ${name}: ${target.mcpServer}/${target.mcpTool}`);
  }
  const servers = await loadMcpServers(options.cwd);
  const config = resolveMcpServer(options.cwd, target.mcpServer, servers);
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  try {
    return (
      await truncateToolOutput(
        options.cwd,
        await callMcpTool(target.mcpServer, config, target.mcpTool, args, options.signal),
      )
    ).content;
  } catch (error) {
    // Re-throw with the tool's expected schema attached when the server's
    // bare "did not match the required schema" message would otherwise leave
    // the model with no idea which field is wrong. Enrichment is best-effort
    // — if the runtime catalog isn't cached yet the original message wins.
    const original = errorMessage(error);
    const enriched = await enrichMcpErrorMessage(name, options.cwd, args, original).catch(() => original);
    if (enriched === original) throw error;
    const wrapped = new Error(enriched);
    if (error instanceof Error && error.stack) wrapped.stack = error.stack;
    throw wrapped;
  }
}

async function resolveUniqueRuntimeTarget(name: ToolName, cwd: string): Promise<McpRuntimeTarget> {
  const matches = (await loadMcpRuntimeTools(cwd)).filter((tool) => tool.name === name);
  if (matches.length === 0) {
    throw new Error(`MCP runtime tool is unavailable in the current catalog: ${name}`);
  }
  if (matches.length > 1) {
    throw new Error(`MCP runtime tool name is ambiguous in the current catalog: ${name}`);
  }
  const match = matches[0]!;
  return { mcpServer: match.mcpServer, mcpTool: match.mcpTool };
}

function assertUniqueRuntimeToolNames(tools: ReadonlyArray<McpRuntimeTool>): void {
  const byName = new Map<string, McpRuntimeTool[]>();
  for (const tool of tools) {
    const matches = byName.get(tool.name);
    if (matches) matches.push(tool);
    else byName.set(tool.name, [tool]);
  }
  const collisions = [...byName.entries()]
    .filter(([, matches]) => matches.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
  if (collisions.length === 0) return;
  const detail = collisions
    .map(
      ([runtimeName, matches]) =>
        `${runtimeName} <= ${matches
          .map((tool) => `${JSON.stringify(tool.mcpServer)}/${JSON.stringify(tool.mcpTool)}`)
          .join(", ")}`,
    )
    .join("; ");
  throw new Error(
    `MCP runtime tool name collision after sanitization: ${detail}. Rename the colliding MCP server or tool so every generated name is unique.`,
  );
}

/** Heuristically detect schema/validation failures coming back from an MCP
 * server so we don't pad transport/network/auth errors with irrelevant schema
 * context. Keep loose — different MCP server implementations word the same
 * failure differently. */
function looksLikeMcpSchemaError(message: string): boolean {
  return /schema|valid|required|expected|missing|unknown|invalid|parameter|argument|type/i.test(message);
}

async function enrichMcpErrorMessage(
  name: ToolName,
  cwd: string,
  sentInput: Record<string, unknown>,
  originalMessage: string,
): Promise<string> {
  if (!looksLikeMcpSchemaError(originalMessage)) return originalMessage;
  const runtimeTools = await loadMcpRuntimeTools(cwd);
  const descriptor = runtimeTools.find((tool) => tool.name === name);
  if (!descriptor?.inputJsonSchema) return originalMessage;
  const params = summarizeToolSchema(descriptor);
  if (params.length === 0) return originalMessage;
  const required = params.filter((p) => p.required).map((p) => p.name);
  const accepted = params.map((p) => p.name);
  const sent = Object.keys(sentInput);
  const missing = required.filter((field) => !sent.includes(field));
  const unexpected = sent.filter((field) => !accepted.includes(field));
  const example = synthesizeExampleFromJsonSchema(descriptor.inputJsonSchema);
  const lines = [
    originalMessage,
    "",
    `required fields: ${required.length > 0 ? required.join(", ") : "(none)"}`,
    `accepted fields: ${accepted.join(", ")}`,
    `you sent: ${sent.length > 0 ? sent.join(", ") : "(empty body)"}`,
  ];
  if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) lines.push(`unexpected: ${unexpected.join(", ")}`);
  if (example) lines.push(`shape hint: ${JSON.stringify(example)}`);
  return lines.join("\n");
}

export function parseMcpRuntimeToolName(name: string): { server: string; tool: string } {
  if (!isMcpRuntimeTool(name)) throw new Error(`not an MCP runtime tool: ${name}`);
  const body = name.slice(mcpToolPrefix.length);
  const separator = body.indexOf("__");
  if (separator < 1) throw new Error(`invalid MCP runtime tool name: ${name}`);
  return {
    server: body.slice(0, separator),
    tool: body.slice(separator + 2),
  };
}

/** Legacy splitter for callers that only have a model-facing name. Runtime
 * execution uses the raw identity bound on the authorized descriptor instead.
 * Split into `{ server, tool }`, disambiguating against the
 * known server keys. A server name (and a tool name) can both contain `__`, so
 * `mcp__<server>__<tool>` is ambiguous on its own — a blind first-`__` split
 * resolves `mcp__foo__bar__t` to server `foo` and the configured `foo__bar`
 * server is missed, leaving the tool uncallable. Match the longest sanitized
 * server prefix instead; fall back to the first-`__` split when no configured
 * server matches. */
export function resolveMcpRuntimeToolName(
  name: string,
  serverKeys: Iterable<string>,
): { server: string; tool: string } {
  if (!isMcpRuntimeTool(name)) throw new Error(`not an MCP runtime tool: ${name}`);
  const body = name.slice(mcpToolPrefix.length);
  let best: { server: string; tool: string; prefixLen: number } | null = null;
  let tiedServers: string[] = [];
  for (const key of serverKeys) {
    const prefix = `${sanitize(key)}__`;
    if (body.startsWith(prefix) && body.length > prefix.length) {
      if (!best || prefix.length > best.prefixLen) {
        best = { server: key, tool: body.slice(prefix.length), prefixLen: prefix.length };
        tiedServers = [key];
      } else if (prefix.length === best.prefixLen) {
        tiedServers.push(key);
      }
    }
  }
  if (best && tiedServers.length > 1) {
    throw new Error(
      `ambiguous MCP runtime tool name ${name}: server keys ${tiedServers.map((key) => JSON.stringify(key)).join(", ")} share the same sanitized prefix`,
    );
  }
  if (best) return { server: best.server, tool: best.tool };
  return parseMcpRuntimeToolName(name);
}

function mcpRuntimeToolName(server: string, tool: string): ToolName {
  return `${mcpToolPrefix}${sanitize(server)}__${sanitize(tool)}` as ToolName;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mcpInputJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) return schema as Record<string, unknown>;
  return { type: "object", properties: {} };
}
