import type { AgentProfile, ToolDescriptor } from "@reina/protocol";
import { getMcpStatusForCwd } from "@reina/tools";

/** Default wall-clock cap for `waitForRequiredMcp`. 30s mirrors Claude
 * Code's gating budget — long enough to absorb slow OAuth-flow servers
 * coming online, short enough to fail the dispatch fast when a server
 * is permanently broken. */
export const DEFAULT_REQUIRED_MCP_TIMEOUT_MS = 30_000;

/** How often we re-poll `getMcpStatusForCwd` while waiting. Sub-second
 * granularity keeps the perceived latency near the actual readiness
 * boundary on fast-start servers; the poll itself is a cheap config-
 * file read + status map lookup. */
const POLL_INTERVAL_MS = 250;

export interface RequiredMcpGateError {
  /** Which servers were declared `requiredMcpServers` but failed to
   * reach `connected` within the timeout. */
  missing: string[];
  /** Servers that came up but in a `failed` state. Listed separately
   * so the error message can distinguish "not ready yet" from "broken
   * configuration" — the latter is usually a user-fixable issue. */
  failed: Array<{ name: string; error: string }>;
}

/** Wait until every name in `profile.requiredMcpServers` is in
 * `connected` state for the given cwd. Resolves silently on success.
 * Throws an Error with a `gate` field of type `RequiredMcpGateError`
 * when the wait times out — the caller (subagent manager / engine)
 * can surface the structured detail in the tool observation.
 *
 * The function is a no-op when the profile declares no required
 * servers, so it's safe to call unconditionally before dispatch. */
export async function waitForRequiredMcp(
  cwd: string,
  profile: AgentProfile,
  timeoutMs: number = DEFAULT_REQUIRED_MCP_TIMEOUT_MS,
): Promise<void> {
  const required = profile.requiredMcpServers;
  if (!required || required.length === 0) return;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await getMcpStatusForCwd(cwd);
    const gate = evaluateGate(required, status);
    if (gate.missing.length === 0 && gate.failed.length === 0) return;
    if (Date.now() >= deadline) {
      const message = formatGateError(gate, timeoutMs);
      const err = new Error(message) as Error & { gate: RequiredMcpGateError };
      err.gate = gate;
      throw err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Compute which required servers are not yet ready vs. ready-but-broken.
 * Pulled out as a pure function so unit tests can drive it without a
 * real MCP fixture. */
export function evaluateGate(
  required: ReadonlyArray<string>,
  status: Record<string, { status: string; error?: string }>,
): RequiredMcpGateError {
  const missing: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const name of required) {
    const entry = status[name];
    if (!entry) {
      missing.push(name);
      continue;
    }
    if (entry.status === "connected") continue;
    if (entry.status === "failed") {
      failed.push({ name, error: entry.error ?? "unknown error" });
    } else {
      missing.push(name);
    }
  }
  return { missing, failed };
}

function formatGateError(gate: RequiredMcpGateError, timeoutMs: number): string {
  const parts: string[] = [];
  if (gate.missing.length > 0) {
    parts.push(`Required MCP server(s) not connected within ${timeoutMs}ms: ${gate.missing.join(", ")}`);
  }
  if (gate.failed.length > 0) {
    parts.push(`Required MCP server(s) failed: ${gate.failed.map((f) => `${f.name} (${f.error})`).join(", ")}`);
  }
  return parts.join(". ");
}

/** Narrow a freshly-loaded MCP tool list to just the servers named in
 * `profile.mcpServers`. When the profile has no whitelist, the input
 * is returned unchanged. Runtime descriptors carry the original server name;
 * descriptors without that identity fail closed because encoded names are
 * ambiguous when a server itself contains `__`. */
export function filterMcpTools(tools: ReadonlyArray<ToolDescriptor>, profile: AgentProfile): ToolDescriptor[] {
  const allowed = profile.mcpServers;
  if (!allowed || allowed.length === 0) return [...tools];
  const allowSet = new Set(allowed);
  return tools.filter((tool) => {
    if (!tool.name.startsWith("mcp__")) return true;
    const runtimeServer = (tool as ToolDescriptor & { mcpServer?: unknown }).mcpServer;
    return typeof runtimeServer === "string" && allowSet.has(runtimeServer);
  });
}
