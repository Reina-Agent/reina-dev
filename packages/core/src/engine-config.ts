import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReinaConfig } from "@reina/protocol";
import { normalizePermissionMode } from "@reina/protocol";
import {
  configPathFor as globalConfigPathFor,
  mcpConfigPathFor,
  workspaceConfigPathFor,
} from "@reina/tools";

export { mcpConfigPathFor };

export function configPathFor(cwd: string): string {
  return globalConfigPathFor(cwd);
}

export async function ensureConfig(cwd: string): Promise<{ path: string; mcpPath: string; config: ReinaConfig; created: boolean; mcpCreated: boolean }> {
  const file = globalConfigPathFor(cwd);
  const mcpFile = mcpConfigPathFor(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const raw = await readFile(file, "utf8").catch(() => undefined);
  const workspaceRaw = await readFile(workspaceConfigPathFor(cwd), "utf8").catch(() => undefined);
  const config = {
    // Malformed JSON (a stray trailing comma, a hand-edit) must not abort session
    // creation: parseConfig returns null on a parse error and we fall back to
    // defaults (global) / no overlay (workspace). We deliberately don't rewrite
    // the file here, so the user's (broken) config is preserved for them to fix.
    ...(raw ? parseConfig(raw) ?? defaultConfig() : defaultConfig()),
    ...(workspaceRaw ? parseConfig(workspaceRaw) ?? {} : {}),
  };
  let created = false;
  if (!raw) {
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    created = true;
  }
  const mcpRaw = await readFile(mcpFile, "utf8").catch(() => undefined);
  if (!mcpRaw) await writeFile(mcpFile, `${JSON.stringify(defaultMcpConfig(), null, 2)}\n`, "utf8");
  return { path: file, mcpPath: mcpFile, config, created, mcpCreated: !mcpRaw };
}

/** Read settings without creating files. An incomplete editor write must not
 * replace a running engine's last valid configuration with defaults. */
export async function readRuntimeConfig(cwd: string): Promise<ReinaConfig | null> {
  const files = [globalConfigPathFor(cwd), workspaceConfigPathFor(cwd)];
  const raw = await Promise.all(files.map((file) => readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })));
  const parsed = raw.map((value) => value === undefined ? {} : parseConfig(value));
  if (parsed.some((value) => value === null)) return null;
  return { ...(raw[0] === undefined ? defaultConfig() : parsed[0]), ...parsed[1] };
}

function parseConfig(raw: string): ReinaConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return null; // malformed JSON — caller falls back to defaults
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const config = parsed as ReinaConfig;
  if (config.permissionMode) config.permissionMode = normalizePermissionMode(config.permissionMode);
  return config;
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function defaultConfig(): ReinaConfig {
  return {
    agent: "default",
    permissionMode: "default",
    model: {
      provider: "deterministic",
      model: "reina-deterministic",
      baseUrl: undefined,
      apiKey: undefined,
    },
    autoTitle: {
      enabled: true,
    },
    toolLoop: {
      hardMaxSteps: 256,
      stagnationLimit: 20,
      repeatedActionLimit: 40,
      consecutiveErrorLimit: 12,
      autoRepair: true,
    },
    subagent: {
      forkEnabled: true,
    },
    // Opt-in: a review forks a background turn every few turns, which costs
    // tokens. Off by default; users flip `enabled: true` to grow memory/skills.
    selfEvolve: {
      enabled: false,
      everyTurns: 5,
      notify: true,
    },
    tui: {
      mouse: false,
    },
  };
}

function defaultMcpConfig(): NonNullable<ReinaConfig["mcp"]> {
  return {
    servers: {
      example: {
        type: "stdio",
        enabled: false,
        command: "node",
        args: ["./mcp-server.js"],
        cwd: ".",
        timeoutMs: 30000,
        env: {
          EXAMPLE_ENV: "value",
        },
      },
    },
  };
}

/** Read the Reina-specific MCP residency policy out of reina.json (global +
 * workspace overlay). The portable mcp.json never carries this — it's
 * shared with Claude Desktop / Cursor / Codex and stays in the standard
 * shape. Returns an empty set when no config exists or the field is unset,
 * which yields the "everything resident" default. */
export async function loadMcpResidencyPolicy(cwd: string): Promise<{ deferredServers: Set<string> }> {
  const globalFile = globalConfigPathFor(cwd);
  const workspaceFile = workspaceConfigPathFor(cwd);
  const globalRaw = await readFile(globalFile, "utf8").catch(() => undefined);
  const workspaceRaw = await readFile(workspaceFile, "utf8").catch(() => undefined);
  const deferred = new Set<string>();
  for (const raw of [globalRaw, workspaceRaw]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(stripBom(raw)) as { mcp?: { deferredServers?: string[] } };
      for (const name of parsed.mcp?.deferredServers ?? []) deferred.add(name);
    } catch {
      // Parse failure here would otherwise crash session start over a typo
      // in deferredServers — swallow and continue with whatever loaded.
    }
  }
  return { deferredServers: deferred };
}
