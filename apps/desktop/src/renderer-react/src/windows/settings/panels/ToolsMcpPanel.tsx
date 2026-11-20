import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT, type TFunc } from "~/lib/i18n";
import { Button, Toggle } from "~/components/ui";

// ── Types ─────────────────────────────────────────────────────────────────────

type McpScope = "workspace" | "global";

type StatusLevel = "info" | "success" | "error";

interface McpConfigPayload {
  workspace?: string;
  global?: string;
  workspacePath?: string;
  globalPath?: string;
}

interface EngineConfigPayload {
  workspace?: Record<string, unknown>;
  global?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  workspacePath?: string;
  globalPath?: string;
}

interface McpToolStatus {
  name: string;
  description?: string;
  enabled?: boolean;
}

interface McpServerSource {
  label?: string;
  path?: string;
}

interface McpServerStatus {
  enabled?: boolean;
  deferred?: boolean;
  status?: string;
  error?: string;
  tools?: McpToolStatus[];
  source?: McpServerSource;
}

type McpStatusMap = Record<string, McpServerStatus>;

// Editors we know how to launch with a file argument, by platform. Mirrors
// local-settings.js CONFIG_EDITORS so the raw-config button reuses whatever
// editor the user actually has installed — not just VS Code.
const CONFIG_EDITORS: Record<string, Record<string, string>> = {
  win32: { vscode: "code", cursor: "cursor", antigravity: "antigravity", zed: "zed", intellij: "idea64", pycharm: "pycharm64", sublime: "subl" },
  darwin: { vscode: "Visual Studio Code", cursor: "Cursor", antigravity: "Antigravity", zed: "Zed", intellij: "IntelliJ IDEA", pycharm: "PyCharm", sublime: "Sublime Text" },
  linux: { vscode: "code", cursor: "cursor", zed: "zed", sublime: "subl" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

/** A directory to run MCP operations in: the active workspace if one is open,
 * else the global config dir (~/.reina, dirname of the global mcp.json). Global
 * servers and reina.json live there, so global-scope reads/writes/probes work
 * without an open workspace. */
async function resolveMcpCwd(): Promise<string | undefined> {
  const ws = await getWorkspaceCwd();
  if (ws) return ws;
  try {
    const payload = (await bridge().readMcpConfig(undefined)) as { globalPath?: string };
    return (payload.globalPath ?? "").replace(/[\\/][^\\/]*$/, "") || undefined;
  } catch {
    return undefined;
  }
}

function parseMcpConfig(raw: string): { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> } & Record<string, unknown> {
  // Strip a leading UTF-8 BOM (U+FEFF) — PowerShell's ConvertTo-Json writes the
  // global mcp.json with a BOM, and JSON.parse throws on a leading BOM.
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return { servers: {} };
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { servers: {} };
  // Support both `servers` and legacy `mcpServers` key
  if (!parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
    if (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
      return parsed;
    }
    parsed.servers = {};
  }
  return parsed;
}

/** Mutable servers map for a parsed config (supports both key spellings). */
function mcpServersMap(config: Record<string, unknown>): Record<string, unknown> {
  if (config.servers && typeof config.servers === "object" && !Array.isArray(config.servers)) {
    return config.servers as Record<string, unknown>;
  }
  if (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)) {
    return config.mcpServers as Record<string, unknown>;
  }
  config.servers = {};
  return config.servers as Record<string, unknown>;
}

function mcpStatusText(t: TFunc, entry: McpServerStatus | undefined): string {
  if (!entry) return "";
  if (entry.status === "failed") return t("tools.statusFailed", { error: entry.error ?? t("tools.unknownError") });
  if (entry.status === "checking") return t("tools.statusChecking");
  if (entry.status === "timeout") return entry.error || t("tools.statusTimeout");
  if (entry.enabled === false) return t("tools.statusDisabledHint");
  return entry.status ?? "disabled";
}

function mcpEmptyDetailText(t: TFunc, entry: McpServerStatus | undefined): string {
  if (!entry) return t("tools.noServerSelected");
  if (entry.status === "failed" || entry.status === "timeout") return mcpStatusText(t, entry);
  if (entry.enabled === false || entry.status === "disabled") return mcpStatusText(t, entry);
  if (entry.status === "checking") return t("tools.checkingConnection");
  return t("tools.connectedNoTools");
}

/** Short, localized label for the connection badge when not connected (the
 * connected case shows an enabled/total count instead). Unknown statuses fall
 * back to the raw value. */
function badgeStatusLabel(t: TFunc, status: string): string {
  switch (status) {
    case "checking": return t("tools.badgeChecking");
    case "configured": return t("tools.badgeConfigured");
    case "disabled": return t("tools.badgeDisabled");
    case "failed": return t("tools.badgeFailed");
    case "timeout": return t("tools.badgeTimeout");
    default: return status;
  }
}

/** Visual tone for the connection badge in the server list. */
function badgeTone(entry: McpServerStatus | undefined): string {
  const status = entry?.status ?? (entry?.enabled === false ? "disabled" : "unknown");
  if (status === "connected") return "border-success-foreground/40 text-success-foreground";
  if (status === "failed" || status === "timeout") return "border-destructive/40 text-destructive";
  if (status === "checking") return "border-border text-muted-foreground";
  return "border-border text-muted-foreground/70";
}

function configEditorOs(): "win32" | "darwin" | "linux" {
  const value = navigator.platform || navigator.userAgent || "";
  if (/Win/i.test(value)) return "win32";
  if (/Mac/i.test(value)) return "darwin";
  return "linux";
}

/** Pick an installed editor: the user's saved "Open with" choice first, then
 * any other known editor. Returns the resolved binary path, or null if none
 * is installed — the caller then falls back to the OS default handler. */
async function resolveConfigEditor(): Promise<string | null> {
  const map = CONFIG_EDITORS[configEditorOs()] ?? CONFIG_EDITORS.linux;
  let saved: string | null = null;
  try {
    saved = await bridge().storeGet("view-settings", "openWithApp");
  } catch {
    saved = null;
  }
  const order: string[] = [];
  if (saved && map[saved]) order.push(map[saved]);
  for (const bin of Object.values(map)) if (!order.includes(bin)) order.push(bin);
  for (const bin of order) {
    const resolved = await bridge().resolveAppPath(bin).catch(() => null);
    if (resolved) return resolved;
  }
  return null;
}

async function openConfigPath(filePath: string): Promise<void> {
  const bin = await resolveConfigEditor();
  const result = await bridge().openPath(filePath, bin || undefined);
  if (typeof result === "string" && result) throw new Error(result);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ToolsMcpPanel() {
  const t = useT();
  // ── MCP config cache (raw mcp.json, used to list configured servers + to
  // resolve the file path for "Open raw config") ───────────────────────────────
  const [status, setStatus] = useState("");
  const [statusLevel, setStatusLevel] = useState<StatusLevel>("info");
  const [mcpCache, setMcpCache] = useState<McpConfigPayload | null>(null);

  // ── MCP server status (live connection probe via list_mcp_status) ─────────
  const [mcpServers, setMcpServers] = useState<McpStatusMap>({});
  const [selectedServer, setSelectedServer] = useState("");
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");
  // Bounds the auto re-probe below so a genuinely server-less / never-connecting
  // setup can't spin forever.
  const probeRetriesRef = useRef(0);

  // Live connection status — separate IPC from the raw read because it needs a
  // connection probe, not just a file read.
  const refreshMcpStatus = useCallback(async () => {
    // Probe live MCP status (connection + tools per server). The legacy renderer
    // required an open workspace, but list_mcp_status only needs *a* directory to
    // resolve workspace-scoped configs and to spawn stdio servers — the global
    // ~/.reina/mcp.json servers probe fine with the global config dir as cwd. So
    // fall back to that dir when no workspace is active, instead of refusing to
    // probe (which left the page listing servers with no tools and no status).
    const cwd = await resolveMcpCwd();
    if (!cwd) {
      setMcpError(t("tools.cannotResolveProbeDir"));
      return;
    }
    setMcpLoading(true);
    setMcpError("");
    try {
      const result = (await bridge().invoke("list_mcp_status", { cwd })) as {
        servers?: McpStatusMap;
      } | null;
      setMcpServers(result?.servers ?? {});
    } catch (err: unknown) {
      setMcpServers({});
      setMcpError(t("tools.failedLoadStatus", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setMcpLoading(false);
    }
  }, []);

  // Read the raw mcp.json (global, plus the workspace file when one is open) so
  // the manager can list configured servers and resolve the path for editing.
  const loadMcp = useCallback(async () => {
    const cwd = await getWorkspaceCwd();
    try {
      const payload = (await bridge().readMcpConfig(cwd)) as McpConfigPayload;
      setMcpCache(payload);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusLevel("error");
    }
  }, []);

  useEffect(() => {
    void loadMcp();
    void refreshMcpStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Land on live status by default. Global servers (~/.reina/mcp.json) probe
  // without an open workspace, but the settings window can mount before the
  // agent-host is ready to answer list_mcp_status — leaving the probe empty even
  // though servers ARE configured. When that happens, re-probe a few times so
  // the panel settles on connected status instead of stranding on the
  // "configured" placeholder. A server that connects-and-fails still appears in
  // mcpServers (status: "failed"), so an *empty* map is the unambiguous "host
  // wasn't ready / cwd didn't resolve yet" signal — safe to retry.
  useEffect(() => {
    if (mcpLoading) return;
    if (Object.keys(mcpServers).length > 0) {
      probeRetriesRef.current = 0;
      return;
    }
    if (!mcpCache) return; // config not read yet — nothing to compare against
    const hasConfigured = [mcpCache.global, mcpCache.workspace].some((raw) => {
      if (!raw) return false;
      try {
        return Object.keys(mcpServersMap(parseMcpConfig(raw))).length > 0;
      } catch {
        return false;
      }
    });
    if (!hasConfigured || probeRetriesRef.current >= 3) return;
    probeRetriesRef.current += 1;
    const timer = setTimeout(() => void refreshMcpStatus(), 700);
    return () => clearTimeout(timer);
  }, [mcpLoading, mcpServers, mcpCache, refreshMcpStatus]);

  // Keep a valid selection as the server map (live or configured) changes.
  useEffect(() => {
    setSelectedServer((prev) => {
      const configured: string[] = [];
      for (const raw of [mcpCache?.global, mcpCache?.workspace]) {
        if (!raw) continue;
        try {
          configured.push(...Object.keys(mcpServersMap(parseMcpConfig(raw))));
        } catch {
          /* ignore */
        }
      }
      const all = [...new Set([...configured, ...Object.keys(mcpServers)])];
      if (prev && all.includes(prev)) return prev;
      return all[0] ?? "";
    });
  }, [mcpServers, mcpCache]);

  // ── Server config mutations (read/modify/write the portable mcp.json) ─────

  /** Find which scope's mcp.json holds a server (workspace wins over global). */
  const findServerScope = useCallback(
    (name: string): McpScope => {
      try {
        if (mcpServersMap(parseMcpConfig(mcpCache?.workspace ?? ""))[name]) return "workspace";
        if (mcpServersMap(parseMcpConfig(mcpCache?.global ?? ""))[name]) return "global";
      } catch {
        return "global";
      }
      return "global";
    },
    [mcpCache],
  );

  /** Read the owning scope's config, mutate the server entry, write it back. */
  const updateServerConfig = useCallback(
    async (name: string, mutate: (server: Record<string, unknown>) => void) => {
      const cwd = await getWorkspaceCwd();
      // Re-read the file NOW instead of trusting the mount-time cache: this
      // panel also offers "Open raw config" for external editing, so the cache
      // can be minutes stale — and the write below replaces the whole file, so
      // basing it on a stale snapshot would silently revert outside edits.
      let payload = mcpCache;
      try {
        payload = (await bridge().readMcpConfig(cwd)) as McpConfigPayload;
        setMcpCache(payload);
      } catch {
        // Read failed — fall back to the cache (same data the old code used).
      }
      const scopeOf = (): McpScope => {
        try {
          if (mcpServersMap(parseMcpConfig(payload?.workspace ?? ""))[name]) return "workspace";
          if (mcpServersMap(parseMcpConfig(payload?.global ?? ""))[name]) return "global";
        } catch {
          return "global";
        }
        return "global";
      };
      const targetScope = scopeOf();
      // Global servers write to ~/.reina/mcp.json and need no workspace; only a
      // workspace-scoped server requires an open workspace to resolve its path.
      if (targetScope === "workspace" && !cwd) {
        setStatus(t("tools.openWorkspaceToEditServer"));
        setStatusLevel("error");
        // Re-probe so an optimistic caller (setServerEnabled's instant flip)
        // doesn't leave the UI showing a state that was never written.
        await refreshMcpStatus();
        return;
      }
      try {
        const raw = targetScope === "workspace" ? payload?.workspace ?? "" : payload?.global ?? "";
        const config = parseMcpConfig(raw);
        const server = mcpServersMap(config)[name] as Record<string, unknown> | undefined;
        if (!server) throw new Error(t("tools.serverNotFound", { name }));
        mutate(server);
        const next = `${JSON.stringify(config, null, 2)}\n`;
        const result = (await bridge().writeMcpConfig(cwd, targetScope, next)) as { bytes?: number };
        // Keep the local cache coherent with the write.
        setMcpCache((prev) => {
          const updated = { ...(prev ?? {}) };
          if (targetScope === "workspace") updated.workspace = next;
          else updated.global = next;
          return updated;
        });
        const bytes = result?.bytes;
        setStatus(bytes !== undefined ? t("tools.savedBytes", { bytes }) : t("tools.saved"));
        setStatusLevel("success");
        await refreshMcpStatus();
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusLevel("error");
        await refreshMcpStatus();
      }
    },
    [mcpCache, refreshMcpStatus],
  );

  /** Enable / disable a server (delete vs set `enabled: false` in mcp.json). */
  const setServerEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      // Optimistic local flip so the toggle responds instantly.
      setMcpServers((prev) => {
        const entry = prev[name];
        if (!entry) return prev;
        return {
          ...prev,
          [name]: {
            ...entry,
            enabled,
            status: enabled ? "checking" : "disabled",
            tools: enabled ? [] : entry.tools ?? [],
          },
        };
      });
      await updateServerConfig(name, (server) => {
        if (enabled) delete server.enabled;
        else server.enabled = false;
      });
    },
    [updateServerConfig],
  );

  /** Toggle a single tool by adding/removing it from server.disabledTools. */
  const setToolEnabled = useCallback(
    async (name: string, toolName: string, enabled: boolean) => {
      await updateServerConfig(name, (server) => {
        const disabled = new Set(Array.isArray(server.disabledTools) ? (server.disabledTools as string[]) : []);
        if (enabled) disabled.delete(toolName);
        else disabled.add(toolName);
        if (disabled.size === 0) delete server.disabledTools;
        else server.disabledTools = [...disabled].sort((a, b) => a.localeCompare(b));
      });
    },
    [updateServerConfig],
  );

  /** Flip a server between Resident (default) and Deferred. Mutates
   * `mcp.deferredServers` in the global reina.json — that file is Reina's own
   * preferences; mcp.json stays in the portable cross-agent format. */
  const setServerDeferred = useCallback(
    async (name: string, resident: boolean) => {
      // Residency lives in the global reina.json, so it works without a
      // workspace — fall back to the global config dir.
      const cwd = await resolveMcpCwd();
      if (!cwd) {
        setStatus(t("tools.cannotResolveResidencyDir"));
        setStatusLevel("error");
        return;
      }
      // Optimistic flip so the toggle responds instantly.
      setMcpServers((prev) => {
        const entry = prev[name];
        if (!entry) return prev;
        return { ...prev, [name]: { ...entry, deferred: !resident } };
      });
      try {
        const payload = (await bridge().readEngineConfig(cwd)) as EngineConfigPayload;
        const current = (payload?.global ?? {}) as Record<string, unknown>;
        const currentMcp = (current.mcp ?? {}) as Record<string, unknown>;
        const existing = Array.isArray(currentMcp.deferredServers) ? (currentMcp.deferredServers as string[]) : [];
        const set = new Set(existing.filter((entry) => typeof entry === "string"));
        if (resident) set.delete(name);
        else set.add(name);
        const sorted = [...set].sort((a, b) => a.localeCompare(b));
        const next: Record<string, unknown> = { ...current };
        if (sorted.length > 0) {
          next.mcp = { ...currentMcp, deferredServers: sorted };
        } else {
          const rest = { ...currentMcp };
          delete rest.deferredServers;
          if (Object.keys(rest).length > 0) next.mcp = rest;
          else delete next.mcp;
        }
        await bridge().writeEngineConfig(cwd, "global", next);
        setStatus(resident ? t("tools.serverResident", { name }) : t("tools.serverDeferred", { name }));
        setStatusLevel("success");
        await refreshMcpStatus();
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusLevel("error");
        // Roll back the optimistic flip from the authoritative re-read.
        await refreshMcpStatus();
      }
    },
    [refreshMcpStatus],
  );

  // ── Open-in-editor actions ────────────────────────────────────────────────

  /** Open the raw mcp.json for the given scope in the user's external editor.
   * The global config lives at $REINA_HOME/mcp.json and needs no workspace;
   * only the workspace-scoped file requires an open workspace. */
  const openRawConfig = useCallback(
    async (openScope: McpScope) => {
      const cwd = await getWorkspaceCwd();
      if (openScope === "workspace" && !cwd) {
        setStatus(t("tools.openWorkspaceFirstMcp"));
        setStatusLevel("error");
        return;
      }
      try {
        // Resolve the file path; (re)read the config if the cache doesn't have it.
        let cache = mcpCache;
        let filePath = openScope === "workspace" ? cache?.workspacePath : cache?.globalPath;
        if (!filePath) {
          cache = (await bridge().readMcpConfig(cwd)) as McpConfigPayload;
          setMcpCache(cache);
          filePath = openScope === "workspace" ? cache.workspacePath : cache.globalPath;
        }
        if (!filePath) throw new Error(t("tools.configPathUnavailable"));
        // Seed an empty file so the editor opens a real document.
        const contents = openScope === "workspace" ? cache?.workspace ?? "" : cache?.global ?? "";
        if (!contents.trim()) {
          await bridge().writeMcpConfig(cwd, openScope, '{\n  "mcpServers": {}\n}\n');
        }
        await openConfigPath(filePath);
        setStatus("");
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusLevel("error");
      }
    },
    [mcpCache],
  );

  /** Open the source file that actually defines a server (may live in an
   * external agent config), falling back to the owning scope's mcp.json. */
  const openServerConfig = useCallback(
    async (name: string) => {
      try {
        const source = mcpServers[name]?.source;
        if (source?.path) {
          await openConfigPath(source.path);
          return;
        }
        await openRawConfig(findServerScope(name));
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusLevel("error");
      }
    },
    [findServerScope, mcpServers, openRawConfig],
  );

  // ── Derived render data ───────────────────────────────────────────────────

  // Servers declared in mcp.json (global + workspace), independent of any live
  // connection — so the manager lists the user's configured servers even when
  // no workspace is open and the live probe returned nothing.
  const configuredServers: Record<string, { scope: McpScope; config: Record<string, unknown> }> = {};
  for (const sc of ["global", "workspace"] as const) {
    const raw = sc === "global" ? mcpCache?.global : mcpCache?.workspace;
    if (!raw) continue;
    try {
      const servers = mcpServersMap(parseMcpConfig(raw));
      for (const [name, cfg] of Object.entries(servers)) {
        configuredServers[name] = { scope: sc, config: (cfg ?? {}) as Record<string, unknown> };
      }
    } catch {
      /* ignore invalid JSON — the live probe still covers connected servers */
    }
  }

  const serverNames = Array.from(
    new Set([...Object.keys(configuredServers), ...Object.keys(mcpServers)]),
  ).sort((a, b) => {
    const sourceA = mcpServers[a]?.source?.label ?? (configuredServers[a] ? t("tools.sourceConfigured") : t("tools.sourceOther"));
    const sourceB = mcpServers[b]?.source?.label ?? (configuredServers[b] ? t("tools.sourceConfigured") : t("tools.sourceOther"));
    return sourceA.localeCompare(sourceB) || a.localeCompare(b);
  });
  const selectedEntry = selectedServer ? mcpServers[selectedServer] : undefined;
  const selectedConfig = selectedServer ? configuredServers[selectedServer] : undefined;
  const selectedTools = Array.isArray(selectedEntry?.tools) ? selectedEntry.tools : [];
  const totalServers = serverNames.length;
  const totalTools = Object.values(mcpServers).reduce(
    (sum, server) => sum + (Array.isArray(server?.tools) ? server.tools.length : 0),
    0,
  );
  const selectedEnabled = selectedEntry
    ? selectedEntry.enabled !== false
    : selectedConfig
      ? selectedConfig.config.enabled !== false && selectedConfig.config.disabled !== true
      : false;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="pane-enter flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("tools.manageServers")}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("tools.manageServersDesc")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(status || mcpError) && (
            <span className={`max-w-[40ch] truncate text-[11px] ${status ? statusColor(statusLevel) : "text-muted-foreground"}`}>
              {status || mcpError}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {totalServers} {totalServers === 1 ? t("tools.serverWord") : t("tools.serversWord")}
            {totalTools > 0 ? ` · ${t("tools.toolsCount", { count: totalTools })}` : ""}
          </span>
          <Button onClick={() => void openRawConfig("global")}>{t("tools.openRawConfig")}</Button>
          <Button onClick={() => void refreshMcpStatus()} disabled={mcpLoading}>
            {mcpLoading ? t("tools.refreshing") : t("tools.refresh")}
          </Button>
        </div>
      </div>

      {/* Columns — fill the rest of the panel, flush to the edges */}
      <div className="flex min-h-0 flex-1">
          {/* Server list */}
          <aside className="flex w-56 shrink-0 flex-col border-r border-(--surface-divider)">
            <div className="flex-1 overflow-y-auto py-1">
              {serverNames.length === 0 && (
                <div className="px-3 py-3 text-[12px] text-muted-foreground">
                  {mcpLoading ? t("tools.loadingServers") : t("tools.noServersConfigured")}
                </div>
              )}
              {(() => {
                let currentSource = "";
                return serverNames.map((name) => {
                  const entry = mcpServers[name];
                  const cfg = configuredServers[name]?.config;
                  const sourceLabel = entry?.source?.label ?? (configuredServers[name] ? t("tools.sourceConfigured") : t("tools.sourceOther"));
                  const tools = Array.isArray(entry?.tools) ? entry.tools : [];
                  const enabledCount = tools.filter((t) => t.enabled !== false).length;
                  const disabledInCfg = cfg?.enabled === false || cfg?.disabled === true;
                  const status =
                    entry?.status ?? (disabledInCfg ? "disabled" : mcpLoading ? "checking" : "configured");
                  const heading = sourceLabel !== currentSource ? sourceLabel : null;
                  currentSource = sourceLabel;
                  return (
                    <div key={name}>
                      {heading && (
                        <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {heading}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedServer(name)}
                        title={[mcpStatusText(t, entry), entry?.source?.path].filter(Boolean).join("\n")}
                        className={
                          "flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors duration-(--motion-fast) hover:bg-secondary " +
                          (name === selectedServer ? "bg-secondary font-medium" : "")
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <span
                          className={
                            "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] " + badgeTone(entry)
                          }
                        >
                          {status === "connected" ? `${enabledCount}/${tools.length}` : badgeStatusLabel(t, status)}
                        </span>
                      </button>
                    </div>
                  );
                });
              })()}
            </div>
          </aside>

          {/* Detail pane */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header: title + status + actions */}
            <div className="border-b p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{selectedServer || t("tools.mcpServer")}</div>
                  <div className="mt-0.5 whitespace-pre-line text-[11.5px] text-muted-foreground">
                    {selectedEntry
                      ? [
                          mcpStatusText(t, selectedEntry),
                          selectedEntry.source
                            ? t("tools.sourceLine", {
                                label: selectedEntry.source.label ?? t("tools.sourceOther"),
                              }) + (selectedEntry.source.path ? ` (${selectedEntry.source.path})` : "")
                            : "",
                        ]
                          .filter(Boolean)
                          .join("\n")
                      : selectedConfig
                        ? mcpLoading
                          ? t("tools.checkingConnection")
                          : t("tools.configuredNotConnected", { scope: selectedConfig.scope })
                        : t("tools.selectServerToInspect")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    onClick={() => selectedServer && void openServerConfig(selectedServer)}
                    disabled={!selectedServer}
                  >
                    {t("tools.configure")}
                  </Button>
                </div>
              </div>

              {/* Enabled + Resident toggles */}
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-[12.5px]">
                  <Toggle
                    checked={selectedEnabled}
                    onChange={(v) => selectedServer && void setServerEnabled(selectedServer, v)}
                  />
                  <span className={selectedEntry || selectedConfig ? "" : "text-muted-foreground"}>{t("tools.enabled")}</span>
                </label>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <Toggle
                    checked={selectedEntry ? selectedEntry.deferred !== true : false}
                    onChange={(v) => selectedServer && void setServerDeferred(selectedServer, v)}
                  />
                  <span className={selectedEntry && selectedEnabled ? "" : "text-muted-foreground"}>{t("tools.resident")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("tools.residentHint")}
                  </span>
                </label>
              </div>
            </div>

            {/* Tool list */}
            <div className="flex-1 overflow-y-auto">
              {selectedEntry && selectedTools.length > 0 ? (
                <div className="divide-y divide-(--surface-divider)">
                  {selectedTools.map((tool, index) => (
                    <div key={tool.name} className="flex items-start justify-between gap-4 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="font-mono text-[12.5px]">
                          {index + 1}. {tool.name}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                          {tool.description || t("tools.noDescription")}
                        </div>
                      </div>
                      <div className="shrink-0 pt-0.5">
                        <Toggle
                          checked={tool.enabled !== false}
                          onChange={(v) =>
                            selectedServer && void setToolEnabled(selectedServer, tool.name, v)
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : selectedEntry ? (
                <div
                  className={
                    "px-4 py-6 text-center text-[12px] " +
                    (selectedEntry.status === "failed" || selectedEntry.status === "timeout"
                      ? "text-destructive"
                      : "text-muted-foreground")
                  }
                >
                  {mcpEmptyDetailText(t, selectedEntry)}
                </div>
              ) : selectedConfig ? (
                <div className="px-4 py-6 text-[12px] text-muted-foreground">
                  <div>
                    {t("tools.configuredIn", { scope: selectedConfig.scope })}
                  </div>
                  {(() => {
                    const cfg = selectedConfig.config;
                    const cmd =
                      typeof cfg.url === "string"
                        ? cfg.url
                        : [
                            typeof cfg.command === "string" ? cfg.command : "",
                            Array.isArray(cfg.args) ? cfg.args.join(" ") : "",
                          ]
                            .filter(Boolean)
                            .join(" ");
                    return cmd ? (
                      <div className="mt-2 break-all font-mono text-[11.5px] text-foreground/80">{cmd}</div>
                    ) : null;
                  })()}
                  <div className="mt-3">
                    {mcpLoading
                      ? t("tools.checkingAndListing")
                      : t("tools.notConnectedRetry")}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                  {t("tools.noServerSelected")}
                </div>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}
