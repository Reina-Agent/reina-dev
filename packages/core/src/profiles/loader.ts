import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "@reina/protocol";

const VALID_MODES = new Set<AgentProfile["mode"]>(["primary", "subagent", "all"]);

function customAgentsPath(): string {
  const base = process.env.REINA_HOME ?? join(homedir(), ".reina");
  return join(base, "agents.json");
}

let cachedCustom: { mtime: number; profiles: AgentProfile[] } | null = null;

/** Load user-defined profiles from `$REINA_HOME/agents.json`. Returns []
 * silently when the file is missing / malformed — the engine just runs
 * with the built-in set in that case. Cached by mtime so repeat calls in
 * the same session don't re-read the disk. */
export function loadCustomProfiles(): AgentProfile[] {
  try {
    const path = customAgentsPath();
    const stat = statSync(path);
    if (cachedCustom && cachedCustom.mtime === stat.mtimeMs) return cachedCustom.profiles;
    const raw = readFileSync(path, "utf8");
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed) ? parsed.map(sanitizeCustomProfile).filter((p): p is AgentProfile => p !== null) : [];
    cachedCustom = { mtime: stat.mtimeMs, profiles: list };
    return list;
  } catch {
    cachedCustom = { mtime: 0, profiles: [] };
    return [];
  }
}

function sanitizeCustomProfile(entry: unknown): AgentProfile | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const name = typeof e.name === "string" ? e.name.trim() : "";
  const description = typeof e.description === "string" ? e.description.trim() : "";
  const prompt = typeof e.prompt === "string" ? e.prompt : "";
  const mode = typeof e.mode === "string" && VALID_MODES.has(e.mode as AgentProfile["mode"]) ? (e.mode as AgentProfile["mode"]) : "subagent";
  if (!name || !description || !prompt) return null;
  const out: AgentProfile = { name, description, prompt, mode, toolPermissions: {} };
  if (typeof e.maxSteps === "number" && Number.isFinite(e.maxSteps) && e.maxSteps > 0) out.maxSteps = Math.floor(e.maxSteps);
  if (typeof e.subagentTimeoutMs === "number" && Number.isFinite(e.subagentTimeoutMs) && e.subagentTimeoutMs > 0) {
    out.subagentTimeoutMs = Math.floor(e.subagentTimeoutMs);
  }
  if (typeof e.staleIdleMs === "number" && Number.isFinite(e.staleIdleMs) && e.staleIdleMs > 0) {
    out.staleIdleMs = Math.floor(e.staleIdleMs);
  }
  if (typeof e.staleInToolMs === "number" && Number.isFinite(e.staleInToolMs) && e.staleInToolMs > 0) {
    out.staleInToolMs = Math.floor(e.staleInToolMs);
  }
  if (e.toolPermissions && typeof e.toolPermissions === "object") {
    out.toolPermissions = e.toolPermissions as AgentProfile["toolPermissions"];
  }
  if (Array.isArray(e.tools)) {
    const tools = e.tools.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (tools.length > 0) out.tools = tools as AgentProfile["tools"];
  }
  if (Array.isArray(e.extraDirectTools)) {
    const tools = e.extraDirectTools.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (tools.length > 0) out.extraDirectTools = tools as AgentProfile["extraDirectTools"];
  }
  if (typeof e.color === "string" && /^#[0-9a-fA-F]{6}$/.test(e.color)) {
    out.color = e.color;
  }
  if (Array.isArray(e.skills)) {
    const skills = e.skills.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (skills.length > 0) out.skills = skills;
  }
  if (typeof e.initialPrompt === "string" && e.initialPrompt.trim().length > 0) {
    out.initialPrompt = e.initialPrompt;
  }
  if (Array.isArray(e.requiredMcpServers)) {
    const required = e.requiredMcpServers.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (required.length > 0) out.requiredMcpServers = required;
  }
  if (Array.isArray(e.mcpServers)) {
    const mcp = e.mcpServers.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (mcp.length > 0) out.mcpServers = mcp;
  }
  return out;
}
