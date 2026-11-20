import type { AgentProfile, SessionState, ToolDescriptor } from "@reina/protocol";
import { deferredToolDescriptors, resolveExposedTools } from "@reina/tools";
import { builtinProfiles } from "./builtin.js";
import { loadCustomProfiles } from "./loader.js";
import { modeExtraDirectTools } from "../session-modes.js";

export { filterSkillsByProfile } from "./skills-preload.js";
export {
  DEFAULT_REQUIRED_MCP_TIMEOUT_MS,
  evaluateGate,
  filterMcpTools,
  waitForRequiredMcp,
  type RequiredMcpGateError,
} from "./mcp-gating.js";

/** Built-in profiles (legacy export name retained for back-compat — most
 * callers should prefer `listAllProfiles()` which also includes the user's
 * custom agents.json entries). */
export const profiles = builtinProfiles;

export function listAllProfiles(): AgentProfile[] {
  const custom = loadCustomProfiles();
  const byName = new Map<string, AgentProfile>();
  for (const p of builtinProfiles) byName.set(p.name, p);
  for (const p of custom) byName.set(p.name, p);
  return [...byName.values()];
}

export function resolveProfile(name: string): AgentProfile {
  const all = listAllProfiles();
  const profile = all.find((item) => item.name === name);
  if (profile) return profile;
  // Graceful fallback: an old config or stale session may name a profile that
  // no longer exists (e.g. renamed/removed). Prefer the first primary profile
  // so the engine keeps working instead of refusing to start.
  const fallback = all.find((item) => item.mode === "primary") ?? all[0];
  if (!fallback) {
    throw new Error(`unknown agent profile: ${name}. No profiles are registered.`);
  }
  return fallback;
}

export function availableTools(
  profile: AgentProfile,
  activeDeferred?: ReadonlyArray<string>,
  sessionModes?: SessionState["sessionModes"],
): ToolDescriptor[] {
  const denied = (tool: ToolDescriptor) => profile.toolPermissions[tool.name] === "deny";
  const direct = resolveExposedTools(activeDeferred).filter((tool) => !denied(tool));
  // Promote deferred-by-default tools listed in `extraDirectTools` (profile)
  // OR named by any active session mode (currently Team) into the
  // direct catalog. Dedup against the direct set and respect deny entries
  // either source can contribute to the overlay — same tool listed twice
  // shows up once. See session-modes.ts for the mode roster.
  const promoted: ToolDescriptor[] = [];
  const wanted = new Set<string>();
  if (profile.extraDirectTools) for (const n of profile.extraDirectTools) wanted.add(n);
  for (const n of modeExtraDirectTools(sessionModes)) wanted.add(n);
  if (wanted.size > 0) {
    const directNames = new Set(direct.map((t) => t.name));
    for (const tool of deferredToolDescriptors) {
      if (!wanted.has(tool.name)) continue;
      if (directNames.has(tool.name)) continue;
      if (denied(tool)) continue;
      promoted.push(tool);
    }
  }
  const exposed = promoted.length > 0 ? [...direct, ...promoted] : direct;
  // Profile/mode promotions remain explicit grants; discovery is not a grant.
  return exposed.filter((tool) => wanted.has(tool.name) || matchesToolAllowList(profile, tool));
}

/** Shared by native and MCP exposure. Runtime MCP descriptors carry the
 * original server identity, avoiding ambiguous prefix parsing when a server
 * name itself contains `__`. An MCP wildcard fails closed when that identity
 * is absent; exact tool names and `*` remain compatible. */
export function matchesToolAllowList(profile: AgentProfile, tool: ToolDescriptor): boolean {
  if (!profile.tools?.length) return true;
  const name = tool.name;
  const runtimeServer = (tool as ToolDescriptor & { mcpServer?: unknown }).mcpServer;
  return profile.tools.some((entry) => {
    if (entry === "*" || entry === name) return true;
    if (!entry.startsWith("mcp__") || !entry.endsWith("__*")) return false;
    const server = entry.slice("mcp__".length, -"__*".length);
    return typeof runtimeServer === "string" && server.length > 0 && server === runtimeServer;
  });
}

export function requiresApproval(profile: AgentProfile, tool: ToolDescriptor): boolean {
  const override = profile.toolPermissions[tool.name];
  if (override === "allow") return false;
  if (override === "ask") return true;
  return tool.requiresApproval;
}
