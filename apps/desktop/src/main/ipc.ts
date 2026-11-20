import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesktopRequestWithout } from "@reina/desktop-protocol";
import { GLOBAL_NOTES_DIRNAME, MEMORY_DREAM_LIMITS, fromObsidianTag, fromWikiRef, parseSkillFrontmatter, type ModelConfig, type ModelProvider, type PermissionMode, type SessionState, type ReinaConfig } from "@reina/protocol";
import { parseCustomModels, sanitizeModel, type CustomModel } from "./custom-models.js";
import { enrichCustomModels } from "./models-dev.js";
import { fetchRemoteModels, probeModel, probeRemoteConnection, type RemoteModelParams } from "./remote-models.js";
import { execFilePromise, resolveExecutable } from "./apps.js";
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateInfo } from "./auto-update.js";

/** Mirrors `reinaConfigHome` from @reina/tools without importing the whole
 * package — the barrel pulls in CJS deps (execa) that esbuild can't tree-shake
 * out of an ESM bundle, breaking the Electron main process at startup. */
function reinaConfigHome(): string {
  return process.env.REINA_CONFIG_HOME
    ? path.resolve(process.env.REINA_CONFIG_HOME)
    : path.join(os.homedir(), ".reina");
}
import { readDesktopRuntimeConfig } from "./desktop-config.js";
import { type CustomAgent, isAllowedExternalUrl, parseCustomAgents, quotePowerShellSingleQuoted, safeRelativePath } from "./ipc-validators.js";
import { clearActiveWorkspace, deleteSession, loadDesktopState, recordSession, removeWorkspace, renameSession, setProjectOrder, setSessionFlags, setSessionSortTs, touchWorkspace } from "./desktop-state.js";
import { deleteStoreValue, readStore, readStoreValue, writeStore, writeStoreValue } from "./store.js";
import { saveRuntimeViewSettings } from "./runtime-view-settings.js";
import { writeConfigFile } from "./config-file.js";
import { saveAgentSettingsPatch } from "./agent-settings-sync.js";
import {
  connectSubscriptionAccount,
  ensureFreshToken,
  getAccountUsage,
  importSubscriptionFromCli,
  listModelsForAccount,
  listSubscriptions,
  removeSubscriptionAccount,
  updateSubscriptionAccount,
} from "./subscriptions/store.js";
import { cliCredentialsAvailable } from "./subscriptions/cli-import.js";
import { KIMI } from "./subscriptions/kimi.js";
import { subscriptionUserAgent } from "./subscriptions/models.js";
import type { SubscriptionKind } from "./subscriptions/types.js";
import { forgetSessionSnapshot, replayEngineSnapshotTo } from "./agent-host-controller.js";
import {
  applyGlassToAllWindows,
  closeConversationMenu,
  conversationMenuReady,
  isGlassEnabled,
  popupTopbarMenu,
  setBackgroundColor,
  type ConversationMenuPayload,
} from "./windows.js";
import {
  createTerminalSession,
  disposeAllTerminalsForWindow,
  disposeTerminal,
  resizeTerminal,
  writeToTerminal,
} from "./terminal.js";

type RegisterIpcInput = {
  repoRoot: string;
  defaultCwd: string;
  hostStatus: () => { running: boolean; ready: boolean };
  awaitInitialization: () => Promise<unknown> | unknown;
  shutdownHost: () => Promise<void>;
  sendHostRequest: (request: DesktopRequestWithout<"id">) => Promise<unknown>;
  consumeDeepLinks: () => string[];
  openWorkspaceWindow: (target?: { tab?: string; detached?: boolean; sideChatDraft?: string }) => BrowserWindow;
  openSettingsWindow: (panel?: string) => BrowserWindow;
  toggleSessionSidebarWindow: () => unknown;
  hideSessionSidebarWindow: () => unknown;
  getSessionSidebarState: () => unknown;
  openSessionInMain: (index: unknown) => boolean;
  runCommandInMain: (commandId: unknown) => boolean;
  openWorkspaceInMain: (cwd: unknown) => boolean;
  openCommandPaletteInMain: (query: unknown) => boolean;
  openConversationSearchInMain: () => boolean;
  useSkillInMain: (skill: unknown) => boolean;
  setActiveSession: (sessionId: unknown) => boolean;
  /** Notified after a view-settings key is written, so the main process can
   * react to settings it owns (e.g. live sidebar placement). */
  onViewSettingChanged?: (key: string, value: string) => void;
};

function broadcastRendererEvent(event: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(`reina:event:${event}`, payload);
  }
}

/** When a session's model points at a subscription account (`subscriptionId`),
 * resolve it to a concrete ModelConfig: a freshly-refreshed access token plus
 * the right provider/auth flags. The renderer never holds the token — it only
 * stores the `subscriptionId` reference, so this is where the secret is
 * attached, just before the request is forwarded to the host. */
async function resolveSubscriptionModel(model: Partial<ModelConfig>): Promise<Partial<ModelConfig>> {
  const subscriptionId = typeof model.subscriptionId === "string" ? model.subscriptionId.trim() : "";
  if (!subscriptionId) return model;
  const resolved = await ensureFreshToken(subscriptionId);
  if (!resolved) {
    throw new Error("Subscription account not found — reconnect it in Settings → 订阅账号.");
  }
  const provider: ModelProvider =
    resolved.kind === "openai-codex" ? "openai-codex-responses" : "anthropic-messages";
  const chosenModel = typeof model.model === "string" && model.model.trim() ? model.model.trim() : resolved.model;
  return {
    ...model,
    provider,
    ...(chosenModel ? { model: chosenModel } : {}),
    // A subscription model's endpoint is canonical (codex → chatgpt.com,
    // anthropic-oauth → api.anthropic.com, kimi → api.kimi.com/coding) — there
    // is no per-subscription baseUrl in the UI. Any baseUrl riding on the
    // session model is therefore stale leakage from a previously-selected
    // third-party entry (the cause of the cold-start 404: a kimi→codex switch
    // left kimi's baseUrl on the codex config, routing Codex's Responses call
    // to api.kimi.com). Pin it to the kind's canonical value — this also heals
    // sessions whose persisted snapshot already baked in a leaked baseUrl.
    // Kimi rides the Anthropic-compatible Messages endpoint its /models
    // catalog declares; the SDK appends /v1/messages to this base.
    baseUrl: resolved.kind === "kimi-oauth" ? KIMI.anthropicBase : undefined,
    // Subscription credentials and endpoints are resolved together. Never let
    // a previous custom provider's Authorization/header overrides travel here.
    headers: undefined,
    reasoningDialect: undefined,
    // Claude OAuth uses CLI impersonation; Kimi uses plain Bearer. Codex keys
    // its subscription behavior off the provider rather than authMode.
    authMode: resolved.kind === "anthropic-oauth" ? "oauth" : resolved.kind === "kimi-oauth" ? "bearer" : undefined,
    apiKey: resolved.access,
    accountId: resolved.accountId,
    // Forge the official CLI's User-Agent, built from the live npm package
    // version (no hardcoded version) so the provider's request fingerprint
    // matches a real client.
    subscriptionUserAgent: await subscriptionUserAgent(resolved.kind),
    // Context window isn't reported by the provider model endpoints; carry the
    // account's configured value so the engine + context panel size correctly.
    ...(resolved.contextTokens ? { contextWindowTokens: resolved.contextTokens } : {}),
    // Server-side tools the subscription ships. The engine promotes whatever
    // is listed into the model's tools array natively (first turn, no
    // search_tool hop) — vendor knowledge stays here, not in core.
    ...(resolved.kind === "kimi-oauth" ? { subscriptionTools: ["kimi_web_search", "kimi_web_fetch"] } : {}),
  };
}

export function registerIpc(input: RegisterIpcInput): void {
  const defaultCwd = input.defaultCwd || input.repoRoot;
  ipcMain.handle("reina:await-initialization", () => input.awaitInitialization());
  ipcMain.handle("reina:kill-agent-host", () => input.shutdownHost());
  ipcMain.handle("reina:get-window-config", () => ({ updaterEnabled: false, isPackaged: app.isPackaged }));
  ipcMain.handle("reina:consume-initial-deep-links", () => input.consumeDeepLinks());
  ipcMain.handle("reina:get-default-server-url", () => readStoreValue("desktop", "defaultServerUrl"));
  ipcMain.handle("reina:set-default-server-url", (_event, url: string | null) => {
    if (url) writeStoreValue("desktop", "defaultServerUrl", url);
    else deleteStoreValue("desktop", "defaultServerUrl");
  });
  ipcMain.handle("reina:get-wsl-config", () => ({ enabled: readStoreValue("desktop", "wslEnabled") === "true" }));
  ipcMain.handle("reina:set-wsl-config", (_event, config: { enabled: boolean }) => {
    writeStoreValue("desktop", "wslEnabled", String(Boolean(config.enabled)));
  });
  ipcMain.handle("reina:get-display-backend", () => readStoreValue("desktop", "displayBackend"));
  ipcMain.handle("reina:set-display-backend", (_event, backend: string | null) => {
    if (backend) writeStoreValue("desktop", "displayBackend", backend);
    else deleteStoreValue("desktop", "displayBackend");
  });
  ipcMain.handle("reina:parse-markdown", (_event, markdown: string) => markdown);
  ipcMain.handle("reina:check-app-exists", async (_event, appName: string) => Boolean(await resolveExecutable(appName)));
  ipcMain.handle("reina:resolve-app-path", (_event, appName: string) => resolveExecutable(appName));
  ipcMain.handle("reina:wsl-path", async (_event, targetPath: string) => targetPath);

  ipcMain.handle("reina:store-get", (_event, name: string, key: string) => readStoreValue(name, key));
  ipcMain.handle("reina:store-get-all", (_event, name: string) => readStore(name));
  ipcMain.handle("reina:store-set", (event, name: string, key: string, value: string) => {
    writeStoreValue(name, key, value);
    if (name === "desktop-settings" && key === "settings") {
      broadcastRendererEvent("desktop-settings-changed", {});
    }
    // view-settings drives theme / fonts / glass / language across the whole
    // app. Each window applies its own appearance on boot from this store,
    // so a change in the Settings window won't reach Main/Workspace unless we
    // tell them. Broadcast to every OTHER window — the sender already applied
    // it locally.
    if (name === "view-settings") {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.id === event.sender.id) continue;
        win.webContents.send("reina:event:view-settings-changed", { key, value });
      }
      // The frosted-glass flag also drives the native acrylic backdrop, which
      // lives in the main process — flip it on every window live (the value is
      // already persisted above, so new windows pick it up on creation too).
      if (key === "glass") {
        applyGlassToAllWindows(value === "true");
      }
      // Let the main process react to view-settings it owns natively (e.g.
      // sidebar placement, which moves windows around).
      input.onViewSettingChanged?.(key, value);
    }
  });
  ipcMain.handle("reina:store-delete", (_event, name: string, key: string) => {
    deleteStoreValue(name, key);
  });
  ipcMain.handle("reina:store-clear", (_event, name: string) => {
    writeStore(name, {});
  });
  ipcMain.handle("reina:store-keys", (_event, name: string) => Object.keys(readStore(name)));
  ipcMain.handle("reina:store-length", (_event, name: string) => Object.keys(readStore(name)).length);
  ipcMain.handle("reina:get-desktop-state", () => loadDesktopState());
  ipcMain.handle("reina:clear-active-workspace", () => clearActiveWorkspace());
  ipcMain.handle("reina:get-desktop-config", (_event, cwd?: string) => readDesktopRuntimeConfig(cwd || defaultCwd));
  ipcMain.handle("reina:touch-workspace", async (_event, cwd: string) => touchWorkspace(cwd || defaultCwd));
  ipcMain.handle("reina:remove-workspace", (_event, workspaceId: string) => removeWorkspace(workspaceId));
  ipcMain.handle("reina:record-session", async (_event, session: SessionState, title?: string) => recordSession(session, title));
  ipcMain.handle("reina:delete-session", (_event, sessionId: string) => deleteSession(sessionId));
  ipcMain.handle("reina:rename-session", (_event, sessionId: string, title: string) => renameSession(sessionId, title));
  ipcMain.handle("reina:set-session-flags", (_event, sessionId: string, flags: { pinned?: boolean; archived?: boolean }) => setSessionFlags(sessionId, flags));
  ipcMain.handle("reina:set-project-order", (_event, orderedIds: string[]) => setProjectOrder(Array.isArray(orderedIds) ? orderedIds : []));
  ipcMain.handle("reina:set-session-order", (_event, sessionId: string, orderTs: string | null) => setSessionSortTs(sessionId, typeof orderTs === "string" ? orderTs : null));
  ipcMain.handle("reina:list-workspace", async (_event, cwd?: string) => listWorkspaceDir(cwd || defaultCwd, ""));
  ipcMain.handle("reina:list-workspace-dir", async (_event, cwd: string | undefined, relDir: string) => listWorkspaceDir(cwd || defaultCwd, relDir ?? ""));
  ipcMain.handle("reina:read-workspace-file", async (_event, cwd: string | undefined, filePath: string) => readWorkspaceFile(cwd || defaultCwd, filePath));
  ipcMain.handle("reina:write-workspace-file", async (_event, cwd: string | undefined, filePath: string, content: string) =>
    writeWorkspaceFile(cwd || defaultCwd, filePath, content ?? ""),
  );
  ipcMain.handle("reina:read-subagent-activity", async (_event, cwd: string | undefined, taskId: string) =>
    readSubagentActivity(cwd || defaultCwd, taskId),
  );
  // Shared audit notebook: renderer fetches the disk-of-truth via these
  // two endpoints. The live `notes-updated` stream event drives
  // incremental UI; these handlers are for cold-load / explicit refresh.
  // `scope` mirrors the core note tools' axis (read_note(id, scope:"global"))
  // — "global" routes to the cross-project notebook, default is workspace.
  ipcMain.handle("reina:list-notes", async (_event, cwd?: string, scope?: "workspace" | "global") =>
    scope === "global" ? listGlobalNotesFromDisk() : listNotesFromDisk(cwd || defaultCwd),
  );
  ipcMain.handle("reina:read-note", async (_event, cwd: string | undefined, noteId: string, scope?: "workspace" | "global") =>
    scope === "global" ? readGlobalNoteFromDisk(noteId) : readNoteFromDisk(cwd || defaultCwd, noteId),
  );
  // Absolute path of the active notebook dir — the renderer's "Open in
  // Obsidian" needs the GLOBAL dir too, and only main knows REINA_HOME.
  ipcMain.handle("reina:get-notes-dir", async (_event, cwd: string | undefined, scope?: "workspace" | "global") =>
    scope === "global" ? globalNotesDir() : path.join(cwd || defaultCwd, ".reina", "notes"),
  );
  ipcMain.handle("reina:open-notes-folder", async (_event, cwd: string | undefined, scope?: "workspace" | "global") => {
    const notesDir = scope === "global" ? globalNotesDir() : path.join(cwd || defaultCwd, ".reina", "notes");
    await mkdir(notesDir, { recursive: true });
    const error = await shell.openPath(notesDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle("reina:list-git-changes", async (_event, cwd?: string) => listGitChanges(cwd || defaultCwd));
  ipcMain.handle("reina:get-git-diff", async (_event, cwd: string | undefined, filePath: string, mode?: "unified" | "split") =>
    getGitDiff(cwd || defaultCwd, filePath, mode ?? "unified"),
  );

  ipcMain.handle("reina:open-directory-picker", async (_event, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory", ...(opts?.multiple ? ["multiSelections" as const] : [])],
      title: opts?.title ?? "Choose a folder",
      defaultPath: opts?.defaultPath,
    });
    if (result.canceled) return null;
    return opts?.multiple ? result.filePaths : result.filePaths[0];
  });
  ipcMain.handle(
    "reina:open-file-picker",
    async (_event, opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: opts?.extensions?.length ? [{ name: "Files", extensions: opts.extensions }] : undefined,
      });
      if (result.canceled) return null;
      return opts?.multiple ? result.filePaths : result.filePaths[0];
    },
  );
  ipcMain.handle("reina:save-file-picker", async (_event, opts?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    });
    if (result.canceled) return null;
    return result.filePath ?? null;
  });

  ipcMain.on("reina:open-link", (_event, url: string) => {
    // shell.openExternal hands the URL to the OS, so an unfiltered renderer
    // string could launch file:// or any registered custom protocol handler.
    // Only http/https/mailto are opened; everything else is dropped.
    if (!isAllowedExternalUrl(url)) return;
    void shell.openExternal(url);
  });
  ipcMain.handle("reina:open-path", async (_event, targetPath: string, appPath?: string) => {
    if (!appPath) {
      // No editor resolved — hand the file to the OS default handler. On a fresh
      // machine the file type may have no associated program (common for .json
      // on a clean Windows install): openPath then returns a non-empty error
      // string and nothing opens.
      const error = await shell.openPath(targetPath);
      if (!error) return "";
      // Default handler failed. Fall back to an editor that always ships with
      // the OS so the file still opens for editing (notepad on Windows, TextEdit
      // via `open -t` on macOS) instead of leaving the user stranded. Only if
      // even that can't be launched do we reveal the file in the file manager.
      try {
        if (process.platform === "win32") {
          const notepad = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "notepad.exe");
          spawn(notepad, [targetPath], { detached: true, stdio: "ignore" }).unref();
          return "";
        }
        if (process.platform === "darwin") {
          spawn("open", ["-t", targetPath], { detached: true, stdio: "ignore" }).unref();
          return "";
        }
      } catch {
        /* fall through to reveal-in-folder */
      }
      shell.showItemInFolder(targetPath);
      return "";
    }
    // macOS GUI apps resolve to a .app bundle path (from resolveExecutable),
    // which can't be spawned directly. Hand it to `open -a <bundle> <file>` so
    // LaunchServices starts the app and passes the file as a document to open.
    if (process.platform === "darwin" && appPath.endsWith(".app")) {
      spawn("open", ["-a", appPath, targetPath], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    // Launch detached so the editor survives Reina exiting. On Windows the
    // common editor launchers (code.cmd / cursor.cmd / subl on PATH) are
    // .cmd shims that only run under a shell — but `shell: true` with an args
    // ARRAY concatenates them unquoted, so a standard install path like
    // "...\Microsoft VS Code\bin\code.cmd" dies at the first space. Hand the
    // shell one pre-quoted command line instead (quotes are shell-safe here:
    // '"' is illegal in Windows paths).
    const lower = appPath.toLowerCase();
    const needsShell = process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    if (needsShell) {
      spawn(`"${appPath}" "${targetPath}"`, { detached: true, stdio: "ignore", shell: true }).unref();
      return true;
    }
    spawn(appPath, [targetPath], { detached: true, stdio: "ignore" }).unref();
    return true;
  });
  // Open a terminal in a directory. Different from open-path which hands the
  // path as an argument — most shells don't accept a directory as their
  // first positional arg, so we spawn with cwd and force a new window.
  ipcMain.handle("reina:open-shell-in", async (_event, cwd: string, shellKind?: string) => {
    if (!cwd) return false;
    if (process.platform === "win32") {
      if (shellKind === "wsl") {
        spawn("cmd.exe", ["/c", "start", "", "wsl.exe", "--cd", cwd], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }).unref();
        return true;
      }
      const escaped = quotePowerShellSingleQuoted(cwd);
      spawn(
        "cmd.exe",
        ["/c", "start", "", "powershell.exe", "-NoExit", "-Command", `Set-Location -LiteralPath '${escaped}'`],
        { detached: true, stdio: "ignore", windowsHide: false },
      ).unref();
      return true;
    }
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", cwd], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    spawn("x-terminal-emulator", [], { cwd, detached: true, stdio: "ignore" }).unref();
    return true;
  });
  ipcMain.handle("reina:reveal-in-folder", async (_event, targetPath: string) => {
    if (!targetPath) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });
  ipcMain.handle("reina:clipboard-write", (_event, text: string) => {
    clipboard.writeText(text ?? "");
    return true;
  });
  ipcMain.handle("reina:create-workspace-entry", async (_event, cwd: string | undefined, relPath: string, type: "file" | "directory") => {
    return createWorkspaceEntry(cwd || defaultCwd, relPath, type);
  });
  ipcMain.handle("reina:list-agent-profiles", () => listAgentProfiles());
  ipcMain.handle("reina:list-known-models", () => listKnownModels(defaultCwd));
  ipcMain.handle("reina:read-rules-file", async (_event, cwd: string | undefined, fileKey: string) =>
    readRulesFile(cwd || defaultCwd, fileKey),
  );
  ipcMain.handle(
    "reina:write-rules-file",
    async (_event, cwd: string | undefined, fileKey: string, content: string) =>
      writeRulesFile(cwd || defaultCwd, fileKey, content ?? ""),
  );
  ipcMain.handle("reina:read-self-evolve-directive", async () => readSelfEvolveDirective());
  ipcMain.handle("reina:write-self-evolve-directive", async (_event, content: string) =>
    writeSelfEvolveDirective(content ?? ""),
  );
  ipcMain.handle("reina:read-engine-config", async (_event, cwd: string | undefined) =>
    readEngineConfig(cwd || defaultCwd),
  );
  ipcMain.handle(
    "reina:write-engine-config",
    async (
      _event,
      cwd: string | undefined,
      scope: "workspace" | "global",
      config: ReinaConfig,
    ) => writeEngineConfig(cwd || defaultCwd, scope, config),
  );
  ipcMain.handle("reina:read-mcp-config", async (_event, cwd: string | undefined) =>
    readMcpConfig(cwd || defaultCwd),
  );
  ipcMain.handle(
    "reina:write-mcp-config",
    async (_event, cwd: string | undefined, scope: "workspace" | "global", contents: string) =>
      writeMcpConfig(cwd || defaultCwd, scope, contents),
  );
  ipcMain.handle(
    "reina:add-permission-rule",
    async (
      _event,
      cwd: string | undefined,
      scope: "workspace" | "global",
      rule: PermissionRulePayload,
    ) => addPermissionRule(cwd || defaultCwd, scope, rule),
  );
  ipcMain.handle("reina:list-tools", () => listPublicTools());
  ipcMain.handle("reina:list-skills", async (_event, cwd: string | undefined) => listSkills(cwd || defaultCwd));
  ipcMain.handle("reina:create-skill", async (_event, cwd: string | undefined, scope: "workspace" | "global", name: string, description: string) =>
    createSkill(cwd || defaultCwd, scope, name, description),
  );
  ipcMain.handle("reina:read-custom-models", async (_event, cwd: string | undefined) =>
    readCustomModels(cwd || defaultCwd),
  );
  ipcMain.handle(
    "reina:write-custom-models",
    async (_event, cwd: string | undefined, scope: "workspace" | "global", models: unknown) =>
      writeCustomModels(cwd || defaultCwd, scope, models),
  );
  // === Subscription accounts (OAuth-backed Claude/Codex) ===
  // Config + secrets live separately from models.json, in
  // ~/.reina/subscriptions.json (managed entirely in main; the renderer only
  // ever sees the token-free public view).
  ipcMain.handle("reina:list-subscriptions", () => listSubscriptions());
  ipcMain.handle("reina:connect-subscription", async (_event, kind: SubscriptionKind) => {
    const account = await connectSubscriptionAccount(kind, (url) => {
      void shell.openExternal(url);
    });
    broadcastRendererEvent("subscriptions-changed", {});
    return account;
  });
  ipcMain.handle("reina:import-subscription", async (_event, kind: SubscriptionKind) => {
    const account = await importSubscriptionFromCli(kind);
    broadcastRendererEvent("subscriptions-changed", {});
    return account;
  });
  ipcMain.handle("reina:subscription-cli-available", async (_event, kind: SubscriptionKind) =>
    cliCredentialsAvailable(kind),
  );
  ipcMain.handle("reina:list-subscription-models", async (_event, id: string) => listModelsForAccount(id));
  ipcMain.handle("reina:subscription-usage", async (_event, id: string) => getAccountUsage(id));
  ipcMain.handle("reina:disconnect-subscription", async (_event, id: string) => {
    await removeSubscriptionAccount(id);
    broadcastRendererEvent("subscriptions-changed", {});
    return { ok: true };
  });
  ipcMain.handle("reina:update-subscription", async (_event, id: string, patch: { label?: string; model?: string; contextTokens?: number }) => {
    const account = await updateSubscriptionAccount(id, patch);
    broadcastRendererEvent("subscriptions-changed", {});
    return account;
  });
  ipcMain.handle("reina:read-custom-agents", () => readCustomAgents());
  ipcMain.handle("reina:write-custom-agents", async (_event, agents: unknown) => writeCustomAgents(agents));
  ipcMain.handle("reina:fetch-remote-models", async (_event, params: RemoteModelParams) =>
    fetchRemoteModels(params),
  );
  // models.dev pre-fill: sanitize the payload through the same parser as
  // writeCustomModels, then fill ONLY missing capability fields from the
  // (cached) models.dev catalog. Never overwrites user-set values.
  ipcMain.handle("reina:models-dev-enrich", async (_event, models: unknown) =>
    enrichCustomModels(parseCustomModels(JSON.stringify(models))),
  );
  ipcMain.handle("reina:probe-remote-connection", async (_event, params: RemoteModelParams) =>
    probeRemoteConnection(params),
  );
  ipcMain.handle("reina:probe-model", async (_event, params: RemoteModelParams & { model: string }) =>
    probeModel(params),
  );
  ipcMain.handle("reina:list-shells", () => listShells());
  ipcMain.handle("reina:reload-renderer", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.webContents.reload();
  });
  ipcMain.handle("reina:read-clipboard-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return { buffer: image.toPNG().buffer, width: size.width, height: size.height };
  });
  ipcMain.on("reina:show-notification", (event, title: string, body?: string, options?: { silent?: boolean }) => {
    if (readStoreValue("view-settings", "notifySystem") === "false") return;
    const win = BrowserWindow.fromWebContents(event.sender);
    const notification = new Notification({
      title,
      body,
      silent: Boolean(options?.silent) || readStoreValue("view-settings", "notifySound") !== "true",
    });
    notification.on("click", () => {
      win?.show();
      win?.focus();
    });
    notification.show();
  });

  ipcMain.handle("reina:window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("reina:window-toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });
  ipcMain.handle("reina:window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("reina:window-is-maximized", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );
  ipcMain.handle("reina:window-is-fullscreen", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false,
  );
  ipcMain.handle("reina:open-workspace-window", (_event, target?: { tab?: string; detached?: boolean; sideChatDraft?: string }) => {
    input.openWorkspaceWindow(target);
    return true;
  });
  ipcMain.handle("reina:open-settings-window", (_event, panel?: string) => {
    input.openSettingsWindow(panel);
    return true;
  });
  ipcMain.handle("reina:toggle-session-sidebar-window", () => input.toggleSessionSidebarWindow());
  ipcMain.handle("reina:hide-session-sidebar-window", () => input.hideSessionSidebarWindow());
  ipcMain.handle("reina:get-session-sidebar-state", () => input.getSessionSidebarState());
  ipcMain.handle("reina:open-session-in-main", (_event, index: unknown) => input.openSessionInMain(index));
  ipcMain.handle("reina:run-command-in-main", (_event, commandId: unknown) => input.runCommandInMain(commandId));
  ipcMain.handle("reina:open-workspace-in-main", (_event, cwd: unknown) => input.openWorkspaceInMain(cwd));
  ipcMain.handle("reina:open-conversation-search-in-main", () => input.openConversationSearchInMain());
  ipcMain.handle("reina:open-command-palette-in-main", (_event, query: unknown) =>
    input.openCommandPaletteInMain(query),
  );
  ipcMain.handle("reina:use-skill-in-main", (_event, skill: unknown) => input.useSkillInMain(skill));
  ipcMain.handle("reina:set-active-session", (_event, sessionId: unknown) => input.setActiveSession(sessionId));
  ipcMain.handle("reina:get-window-count", () => BrowserWindow.getAllWindows().length);
  ipcMain.handle("reina:get-window-focused", (event) => BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? false);
  ipcMain.handle("reina:set-window-focus", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.focus();
  });
  ipcMain.handle("reina:show-window", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.show();
  });
  ipcMain.handle("reina:get-zoom-factor", (event) => event.sender.getZoomFactor());
  ipcMain.handle("reina:set-zoom-factor", (event, factor: number) => {
    event.sender.setZoomFactor(factor);
  });
  ipcMain.handle("reina:set-titlebar", () => undefined);
  ipcMain.on("reina:loading-window-complete", () => undefined);
  ipcMain.handle("reina:run-updater", () => checkForUpdates());
  ipcMain.handle("reina:check-update", () => checkForUpdates());
  ipcMain.handle("reina:download-update", () => downloadUpdate());
  ipcMain.handle("reina:install-update", () => installUpdate());
  ipcMain.handle("reina:get-update-info", () => getUpdateInfo());
  ipcMain.handle("reina:set-background-color", (event, color: string) => {
    // Remember the opaque theme color for when glass turns back off, but don't
    // clobber the transparent acrylic backdrop while glass is on.
    setBackgroundColor(color);
    if (!isGlassEnabled()) {
      BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(color);
    }
  });

  ipcMain.on(
    "reina:menu-popup",
    (event, key: string, x?: number, y?: number, payload?: ConversationMenuPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      popupTopbarMenu(win, key, x, y, payload);
    },
  );

  ipcMain.on("reina:conversation-menu-action", (event, action: string) => {
    const popup = BrowserWindow.fromWebContents(event.sender);
    const owner = popup?.getParentWindow();
    if (!popup || !owner || !popup.isVisible() || typeof action !== "string") return;
    if (
      !/^conversation\.(?:pin|rename|copy-title|copy-id|copy-path|archive|new-side-chat|open-with:[a-z0-9-]{1,32})$/.test(
        action,
      )
    ) {
      return;
    }
    if (closeConversationMenu(popup)) owner.webContents.send("reina:event:menu-command", action);
  });

  ipcMain.on("reina:conversation-menu-ready", (event, revision?: number) => {
    const popup = BrowserWindow.fromWebContents(event.sender);
    if (popup) conversationMenuReady(popup, revision);
  });

  ipcMain.on("reina:conversation-menu-close", (event) => {
    const popup = BrowserWindow.fromWebContents(event.sender);
    if (popup) closeConversationMenu(popup);
  });

  ipcMain.handle(
    "reina:terminal:create",
    (
      event,
      payload: { id: string; cwd?: string; shell?: string; cols?: number; rows?: number },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error("No window for terminal create");
      return createTerminalSession(win, payload);
    },
  );
  ipcMain.on("reina:terminal:write", (_event, id: string, data: string) => {
    writeToTerminal(id, data);
  });
  ipcMain.on("reina:terminal:resize", (_event, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows);
  });
  ipcMain.on("reina:terminal:dispose", (_event, id: string) => {
    disposeTerminal(id);
  });
  ipcMain.on("reina:terminal:dispose-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    disposeAllTerminalsForWindow(win.id);
  });

  ipcMain.handle("reina:invoke", async (event, command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "patch_agent_settings": {
        const settings = await saveAgentSettingsPatch(args?.patch, loadDesktopState().activeSessionId, input.sendHostRequest);
        broadcastRendererEvent("agent-settings-changed", { settings });
        return true;
      }
      case "save_compaction_settings":
      case "save_subagent_concurrency": {
        const values = await saveRuntimeViewSettings(command, args, input.sendHostRequest);
        for (const [key, value] of Object.entries(values)) {
          broadcastRendererEvent("view-settings-changed", { key, value });
        }
        return true;
      }
      case "host_status":
        return input.hostStatus();
      case "default_cwd":
        return defaultCwd;
      case "replay_engine_snapshot":
        // Main-process-local: cold-load the active session's engine state into
        // the requesting window (the Workspace window calls this on mount so its
        // Agent Team / DAG tabs hydrate even when opened mid-turn).
        replayEngineSnapshotTo(BrowserWindow.fromWebContents(event.sender));
        return true;
      case "create_session":
      case "update_session_config": {
        // Inject a fresh subscription access token if the chosen model is an
        // OAuth account; otherwise forward unchanged.
        const next: Record<string, unknown> = { ...(args ?? {}) };
        if (next.model && typeof next.model === "object") {
          next.model = await resolveSubscriptionModel(next.model as Partial<ModelConfig>);
        }
        return await input.sendHostRequest({ type: command, ...next } as DesktopRequestWithout<"id">);
      }
      case "send_message":
      case "refresh_session_settings":
      case "approve_tool":
      case "answer_question":
      case "answer_question_group":
      case "cancel_async_task_external":
      case "update_async_task_external":
      case "get_context_history":
      case "get_context_request":
      case "interrupt":
      case "side_chat":
      case "retract_steer":
      case "goal_command":
      case "compact_session":
      case "rollback_session":
      case "fork_session":
      case "delete_message":
      case "save_session":
      case "list_sessions":
      case "load_session":
      // Workspace lifecycle + SessionStore-backed queries: forward straight
      // to the agent-host, which owns the SQLite stores.
      case "list_workspaces":
      case "open_workspace":
      case "close_workspace":
      case "remove_workspace":
      case "list_workspace_sessions":
      case "search_workspace_messages":
      case "delete_workspace_session":
      case "rename_workspace_session":
      case "list_background_shell_tasks":
      case "get_background_shell_task_output":
      case "stop_background_shell_task":
      case "list_mcp_status":
        return await input.sendHostRequest({ type: command, ...(args ?? {}) } as DesktopRequestWithout<"id">);
      case "close_session": {
        // Drop the main-process snapshot cache for this session before handing
        // off to the host, so closing/deleting a session can't leak its cached
        // snapshot for the app's lifetime.
        const sessionId = (args as { sessionId?: string } | undefined)?.sessionId;
        if (sessionId) forgetSessionSnapshot(sessionId);
        return await input.sendHostRequest({ type: command, ...(args ?? {}) } as DesktopRequestWithout<"id">);
      }
      default:
        throw new Error(`Unknown desktop command: ${command}`);
    }
  });
}

const WORKSPACE_IGNORED = new Set([".git", "node_modules", "dist", ".turbo", ".next", "coverage"]);
const WORKSPACE_DIR_MAX_ENTRIES = 800;

async function listWorkspaceDir(cwd: string, relDir: string): Promise<Array<{ name: string; path: string; type: "file" | "directory"; depth: number }>> {
  const absoluteCwd = path.resolve(cwd);
  const requested = relDir ? relDir.replaceAll("\\", "/") : "";
  const absoluteDir = path.resolve(absoluteCwd, requested || ".");
  const safeRel = path.relative(absoluteCwd, absoluteDir);
  if (safeRel.startsWith("..") || path.isAbsolute(safeRel)) return [];
  const info = await stat(absoluteDir).catch(() => null);
  if (!info || !info.isDirectory()) return [];
  const items = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const depthBase = safeRel === "" ? 0 : safeRel.split(/[\\/]/).filter(Boolean).length;
  return items
    .filter((item) => !WORKSPACE_IGNORED.has(item.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, WORKSPACE_DIR_MAX_ENTRIES)
    .map((item) => {
      const fullPath = path.join(absoluteDir, item.name);
      const relativePath = path.relative(absoluteCwd, fullPath) || item.name;
      return {
        name: item.name,
        path: relativePath,
        type: item.isDirectory() ? ("directory" as const) : ("file" as const),
        depth: depthBase,
      };
    });
}

async function createWorkspaceEntry(cwd: string, relPath: string, type: "file" | "directory"): Promise<{ path: string; type: "file" | "directory" }> {
  if (!relPath || !relPath.trim()) throw new Error("Empty path");
  const safePath = safeRelativePath(cwd, relPath);
  const fullPath = path.join(cwd, safePath);
  const existing = await stat(fullPath).catch(() => null);
  if (existing) throw new Error(`Already exists: ${safePath}`);
  if (type === "directory") {
    await mkdir(fullPath, { recursive: true });
  } else {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "", { flag: "wx" });
  }
  return { path: safePath, type };
}

type WorkspaceFileResult =
  | { kind: "file"; path: string; content: string; size: number; truncated: boolean; binary: boolean }
  | { kind: "directory"; path: string }
  | { kind: "not_found"; path: string };

/** Returns a discriminated result so callers can branch on kind. A directory
 * path is NOT an error — auto-linkified prose or `@dir` mentions can resolve
 * to one, and we'd rather let the renderer reveal it in the tree than throw.
 * A missing path is likewise not an error — auto-linkified text frequently
 * references files that don't exist (e.g. paths mentioned in tool
 * descriptions before any file is ever created), and a restored
 * `activeFilePath` may point at a file deleted between sessions. */
async function readWorkspaceFile(cwd: string, filePath: string): Promise<WorkspaceFileResult> {
  const safePath = safeRelativePath(cwd, filePath);
  const fullPath = path.join(cwd, safePath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not_found", path: safePath };
    throw error;
  }
  if (info.isDirectory()) return { kind: "directory", path: safePath };
  if (!info.isFile()) throw new Error(`Not a file or directory: ${safePath}`);
  const maxBytes = 512 * 1024;
  if (info.size > maxBytes) {
    return { kind: "file", path: safePath, content: "File is too large to preview.", size: info.size, truncated: true, binary: false };
  }
  const buffer = await readFile(fullPath);
  if (buffer.includes(0)) return { kind: "file", path: safePath, content: "Binary file preview is not available.", size: info.size, truncated: false, binary: true };
  return { kind: "file", path: safePath, content: buffer.toString("utf8"), size: info.size, truncated: false, binary: false };
}

async function writeWorkspaceFile(cwd: string, filePath: string, content: string): Promise<{ path: string; size: number }> {
  const safePath = safeRelativePath(cwd, filePath);
  const fullPath = path.join(cwd, safePath);
  const info = await stat(fullPath);
  if (!info.isFile()) throw new Error(`Not a file: ${safePath}`);
  await writeFile(fullPath, content, "utf8");
  const nextInfo = await stat(fullPath);
  return { path: safePath, size: nextInfo.size };
}

/** Replay a subagent's persisted event stream from disk.
 *
 * Each running subagent has an append-only JSONL file at
 *   `{cwd}/.reina/tasks/{taskId}/stream.jsonl`
 * containing the raw ModelStreamEvent sequence produced by the child engine.
 * The renderer's `state.subagentActivity` Map is the live hot path; this IPC
 * is the cold-path fallback so reloading a session, switching tabs, or first
 * opening the Agent Team detail panel for an old task can reconstruct the
 * same activity log without burdening the engine snapshot.
 *
 * `taskId` is treated as opaque text — we still join through path.resolve and
 * guard against escapes via the same `safeRelativePath` mechanism used for
 * workspace files. Returns events in append order. Empty array on missing
 * file (a task created before stream-writer support, or one that produced no
 * events). Malformed lines are silently skipped — the writer can append a
 * partial line if the process is killed mid-write; the rest of the file is
 * still recoverable. */
/** Read the on-disk shared notebook index. Returns lightweight rows
 * (frontmatter only) for every `<cwd>/.reina/notes/n_*.md`. The
 * renderer keeps an in-memory cache hydrated by this call + the live
 * `notes-updated` stream events that AgentEngine emits as new notes
 * land. */
/** Global cross-project notebook root (`<REINA_HOME>/notes`, `g_*` ids). The
 * per-workspace notebook lives at `<cwd>/.reina/notes` (`n_*`). Both are read
 * by the same disk helpers below, differing only in directory + id prefix. */
function globalNotesDir(): string {
  return path.join(reinaConfigHome(), GLOBAL_NOTES_DIRNAME);
}

/** Frontmatter row shape shared by the list/read helpers below — mirrors the
 * renderer's NoteMeta. One definition so adding a field can't silently
 * diverge between the listing and the detail read. */
type NoteListEntry = {
  id: string;
  title: string;
  tags: string[];
  refs: string[];
  status: string;
  author: string;
  recipient?: string;
  createdAt: string;
};

async function listNotesInDir(dir: string): Promise<{ notes: NoteListEntry[] }> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: [] };
    throw error;
  }
  // Read in parallel: the global notebook accumulates g_*.md across ALL
  // projects, and a sequential await-per-file loop makes its cold load pay
  // one disk round-trip per note.
  const parsed = await Promise.all(
    files.filter((file) => file.endsWith(".md")).map(async (file) => {
      try {
        const raw = await readFile(path.join(dir, file), "utf-8");
        // parseNoteFrontmatter returns null for the derived index.md / log.md /
        // schema.md (no `---` frontmatter), so they're skipped automatically.
        return parseNoteFrontmatter(raw);
      } catch {
        // Skip malformed entries; surfacing here would break the panel for one bad file.
        return null;
      }
    }),
  );
  const notes = parsed.filter((note): note is NoteListEntry => note !== null);
  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { notes };
}

function listNotesFromDisk(cwd: string): Promise<{ notes: NoteListEntry[] }> {
  return listNotesInDir(path.join(cwd, ".reina", "notes"));
}

/** Read one note's full markdown body. The renderer uses this for the
 * "open note" detail view. Returns null when the file doesn't exist. */
async function readNoteInDir(dir: string, noteId: string, idRe: RegExp): Promise<{
  meta: NoteListEntry;
  body: string;
} | null> {
  // Whitelist the id shape to refuse path-traversal payloads. Notes are always
  // `<prefix>_\d+`; if the model wrote anything else, refuse to read.
  if (!idRe.test(noteId)) return null;
  const full = path.join(dir, `${noteId}.md`);
  let raw: string;
  try {
    raw = await readFile(full, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const meta = parseNoteFrontmatter(raw);
  if (!meta) return null;
  // Extract body: everything after the closing `---` line.
  const lines = raw.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  const body = endIdx === -1 ? "" : lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return { meta, body };
}

function readNoteFromDisk(cwd: string, noteId: string) {
  return readNoteInDir(path.join(cwd, ".reina", "notes"), noteId, /^n_\d+$/);
}

/** List the GLOBAL cross-project notebook (`<REINA_HOME>/notes`, `g_*`). */
function listGlobalNotesFromDisk() {
  return listNotesInDir(globalNotesDir());
}

/** Read one GLOBAL note's body (`g_*` id). */
function readGlobalNoteFromDisk(noteId: string) {
  return readNoteInDir(globalNotesDir(), noteId, /^g_\d+$/);
}

/** Tiny frontmatter parser — duplicates the format produced by
 * packages/core/src/notes.ts. Kept self-contained so the main process
 * doesn't depend on the core package (which would pull in a lot of
 * transitive deps via @reina/tools).
 *
 * Format expectations match the NotesService writer: simple
 * `key: value` lines plus inline `[a, b]` string arrays for tags/refs. */
function parseNoteFrontmatter(raw: string): NoteListEntry | null {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;
  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const m = (lines[i] ?? "").match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s?(.*)$/);
    if (!m) continue;
    fm[m[1]!] = m[2] ?? "";
  }
  const id = fm.id?.trim();
  const title = parseFrontmatterScalar(fm.title);
  const status = fm.status?.trim();
  const author = fm.author?.trim();
  const createdAt = fm.createdAt?.trim();
  const recipient = parseFrontmatterScalar(fm.recipient).trim();
  if (!id || !title || !status || !author || !createdAt) return null;
  return {
    id,
    title,
    status,
    author,
    ...(recipient ? { recipient } : {}),
    createdAt,
    tags: parseFrontmatterList(fm.tags ?? "[]").map(fromObsidianTag),
    refs: parseFrontmatterList(fm.refs ?? "[]").map(fromWikiRef),
  };
}

// On-disk Obsidian interop: tags store the namespace ':' as '/'
// (`kind/finding`) and refs as `[[wikilinks]]`. fromObsidianTag / fromWikiRef
// (imported from @reina/protocol — the shared contract with the core
// NotesService writer) unwrap them so the Notes panel and the graph view see
// native `kind:finding` / `n_001` — without this the graph can't match a
// `[[n_001]]` ref to its node and draws no edges.

function parseFrontmatterScalar(raw: string | undefined): string {
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFrontmatterList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inString) {
      buf += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        buf += inner[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(parseFrontmatterScalar(buf));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(parseFrontmatterScalar(buf));
  return out;
}

async function readSubagentActivity(cwd: string, taskId: string): Promise<{ events: unknown[] }> {
  // Restrict to `.reina/tasks/<id>/stream.jsonl` under the workspace root.
  // safeRelativePath rejects absolute paths and `..` escapes, so a poisoned
  // `taskId` like "../../etc/passwd" can't read outside the workspace.
  const rel = path.join(".reina", "tasks", taskId, "stream.jsonl");
  const safe = safeRelativePath(cwd, rel);
  const full = path.join(cwd, safe);
  let buffer: Buffer;
  try {
    buffer = await readFile(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [] };
    throw error;
  }
  const events: unknown[] = [];
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Partial / corrupt line — keep going. Logging here would be noisy
      // for a file that's normally written by a long-running engine.
    }
  }
  return { events };
}

async function listGitChanges(cwd: string): Promise<Array<{ path: string; status: string }>> {
  try {
    // core.quotepath=false: git otherwise octal-escapes non-ASCII path bytes
    // ("\346\226\207...") and the changes list renders garbage for e.g.
    // Chinese filenames.
    const output = await execFilePromise("git", ["-c", "core.quotepath=false", "-C", cwd, "status", "--porcelain=v1"]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim() || "M", path: line.slice(3).trim() }));
  } catch {
    return [];
  }
}

async function getGitDiff(
  cwd: string,
  filePath: string,
  mode: "unified" | "split",
): Promise<{ path: string; mode: "unified" | "split"; diff: string; additions: number; deletions: number; binary: boolean }> {
  const safePath = safeRelativePath(cwd, filePath);
  const maxBuffer = 12 * 1024 * 1024;
  const staged = await execFilePromise("git", ["-c", "core.quotepath=false", "-C", cwd, "diff", "--cached", "--no-ext-diff", "--", safePath], { maxBuffer }).catch(() => "");
  const unstaged = await execFilePromise("git", ["-c", "core.quotepath=false", "-C", cwd, "diff", "--no-ext-diff", "--", safePath], { maxBuffer }).catch(() => "");
  let diff = [staged && `# Staged changes\n${staged}`, unstaged && `# Working tree changes\n${unstaged}`].filter(Boolean).join("\n");

  if (!diff.trim()) diff = await untrackedFileDiff(cwd, safePath);
  const binary = diff.includes("Binary files ") || diff.includes("GIT binary patch");
  const stats = diffStats(diff);
  return { path: safePath, mode, diff: diff.trim() || "No diff for this file.", additions: stats.additions, deletions: stats.deletions, binary };
}

async function untrackedFileDiff(cwd: string, filePath: string): Promise<string> {
  const fullPath = path.join(cwd, filePath);
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile()) return "";
  if (info.size > 512 * 1024) return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary or large file not shown.`;
  const content = await readFile(fullPath, "utf8").catch(() => "");
  if (content.includes("\u0000")) return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary file not shown.`;
  const lines = content.split(/\r?\n/);
  return [`diff --git a/${filePath} b/${filePath}`, "new file mode 100644", "--- /dev/null", `+++ b/${filePath}`, "@@", ...lines.map((line) => `+${line}`)].join("\n");
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

// === Agent profiles (mirrors packages/core/src/profiles.ts) ===

export type AgentProfileSummary = {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  builtin: boolean;
  prompt?: string;
  maxSteps?: number;
};

// NOTE: keep in sync with packages/core/src/profiles.ts `profiles`. The
// engine reads from there at runtime; this copy exists only so the settings
// panel can show the roster without importing @reina/core into the Electron
// main bundle (which transitively pulls execa/cross-spawn and breaks the
// pure-ESM bundle). Same name → same profile.
const builtinAgentProfiles: AgentProfileSummary[] = [
  { name: "default", description: "通用 Agent。直接执行为主；面对真正的 DAG 形状的复杂任务时，可自主升级到团队协调模式。", mode: "primary", builtin: true },
  { name: "summary", description: "总结 Agent，用于会话总结。", mode: "subagent", builtin: true },
  { name: "coordinator", description: "团队协调模式：把 DAG-shaped 大任务拆成 subtask，按依赖派 worker 并行执行。/team 一键切到这里。", mode: "primary", builtin: true },
];

function customAgentsPath(): string {
  return path.join(reinaConfigHomeForMain(), "agents.json");
}

async function readCustomAgents(): Promise<{ path: string; agents: CustomAgent[] }> {
  const filePath = customAgentsPath();
  const raw = await readFile(filePath, "utf8").catch(() => null);
  return { path: filePath, agents: parseCustomAgents(raw) };
}

async function writeCustomAgents(agents: unknown): Promise<{ path: string; agents: CustomAgent[] }> {
  if (!Array.isArray(agents)) throw new Error("Custom agents payload must be an array.");
  const sanitized = parseCustomAgents(JSON.stringify(agents));
  const filePath = customAgentsPath();
  await writeConfigFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
  // Mirror writeCustomModels: tell other windows the agent roster changed so the
  // chat composer's agent list (loaded once on mount) refreshes live instead of
  // requiring an app restart.
  broadcastRendererEvent("custom-agents-changed", { path: filePath });
  return { path: filePath, agents: sanitized };
}

async function listAgentProfiles(): Promise<AgentProfileSummary[]> {
  const { agents } = await readCustomAgents();
  const byName = new Map<string, AgentProfileSummary>();
  for (const p of builtinAgentProfiles) byName.set(p.name, p);
  for (const a of agents) {
    byName.set(a.name, {
      name: a.name,
      description: a.description,
      mode: a.mode,
      builtin: false,
      prompt: a.prompt,
      maxSteps: a.maxSteps,
    });
  }
  return [...byName.values()];
}

// === Known models ===

// Side-call pickers need the same transport and capabilities as the main model.
export type KnownModel = CustomModel;

const builtinKnownModels: KnownModel[] = [
  {
    id: "deterministic",
    label: "Deterministic (offline)",
    provider: "deterministic",
    model: "reina-deterministic",
    description: "Built-in deterministic fixture. No network calls. Add your own models below.",
  },
];

// Effective known-model list = built-in fixtures + the user's models.json
// (global + workspace). Pickers (compaction summary model, title model) expect
// this merged list; returning only the fixtures hid every configured model.
async function listKnownModels(cwd: string): Promise<KnownModel[]> {
  const out: KnownModel[] = [...builtinKnownModels];
  const seen = new Set(out.map((m) => m.id));
  try {
    const { effective } = await readCustomModels(cwd);
    for (const m of effective) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ ...m });
    }
  } catch {
    // best-effort — fall back to built-ins only
  }
  return out;
}

// === Custom models (user-defined) ===

function customModelsPath(): string {
  return path.join(reinaConfigHomeForMain(), "models.json");
}

function workspaceCustomModelsPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".reina", "models.json");
}

async function readCustomModels(cwd: string): Promise<{
  workspacePath: string;
  globalPath: string;
  workspace: CustomModel[];
  global: CustomModel[];
  effective: CustomModel[];
}> {
  const workspacePath = workspaceCustomModelsPath(cwd);
  const globalPath = customModelsPath();
  const [workspaceRaw, globalRaw] = await Promise.all([
    readFile(workspacePath, "utf8").catch(() => null),
    readFile(globalPath, "utf8").catch(() => null),
  ]);
  const workspace = parseCustomModels(workspaceRaw);
  const global = parseCustomModels(globalRaw);
  const byId = new Map<string, CustomModel>();
  for (const m of global) byId.set(m.id, m);
  for (const m of workspace) byId.set(m.id, m); // workspace wins
  return { workspacePath, globalPath, workspace, global, effective: [...byId.values()] };
}

async function writeCustomModels(
  cwd: string,
  scope: "workspace" | "global",
  models: unknown,
): Promise<{ path: string; models: CustomModel[] }> {
  if (!Array.isArray(models)) throw new Error("Custom models payload must be an array.");
  const sanitized = parseCustomModels(JSON.stringify(models));
  const target = scope === "workspace" ? workspaceCustomModelsPath(cwd) : customModelsPath();
  await writeConfigFile(target, `${JSON.stringify(sanitized, null, 2)}\n`);
  broadcastRendererEvent("custom-models-changed", { cwd: path.resolve(cwd), scope, path: target });
  return { path: target, models: sanitized };
}

// === Rules files ===

type RulesFileEntry = { resolve: (cwd: string) => string; display: string; label: string };

const RULES_FILE_MAP: Record<string, RulesFileEntry> = {
  "AGENTS.md": {
    resolve: (cwd) => path.resolve(cwd, "AGENTS.md"),
    display: "AGENTS.md",
    label: "AGENTS.md",
  },
  "rules.md@workspace": {
    resolve: (cwd) => path.resolve(cwd, ".reina", "rules.md"),
    display: ".reina/rules.md",
    label: "Workspace rules",
  },
  "rules.md@global": {
    resolve: () => path.join(reinaConfigHome(), "rules.md"),
    display: "~/.reina/rules.md",
    label: "Global rules",
  },
};

function resolveRulesFile(cwd: string, key: string): { absolute: string; relative: string } {
  const entry = RULES_FILE_MAP[key];
  if (!entry) throw new Error(`Unknown rules file key: ${key}`);
  return { absolute: entry.resolve(cwd), relative: entry.display };
}

async function readRulesFile(cwd: string, key: string): Promise<{ key: string; path: string; content: string; exists: boolean }> {
  const { absolute, relative } = resolveRulesFile(cwd, key);
  const content = await readFile(absolute, "utf8").catch(() => null);
  return { key, path: relative, content: content ?? "", exists: content !== null };
}

async function writeRulesFile(cwd: string, key: string, content: string): Promise<{ key: string; path: string; bytes: number }> {
  const { absolute, relative } = resolveRulesFile(cwd, key);
  await mkdir(path.dirname(absolute), { recursive: true });
  const normalized = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  await writeFile(absolute, normalized, "utf8");
  return { key, path: relative, bytes: Buffer.byteLength(normalized, "utf8") };
}

// === Self-evolve review directive ===

/** Editable file the self-evolve review fork reads as its task, at
 * `<REINA_HOME>/self-evolve.md`. Absent = the engine falls back to its built-in
 * default seed (see loadSelfEvolveDirective in @reina/core), so "not created
 * yet" is a valid, common state — we surface it as `exists: false` rather than
 * seeding here (main deliberately never imports @reina/core). */
function selfEvolveDirectivePathForMain(): string {
  return path.join(reinaConfigHome(), "self-evolve.md");
}

async function readSelfEvolveDirective(): Promise<{ path: string; content: string; exists: boolean }> {
  const target = selfEvolveDirectivePathForMain();
  const content = await readFile(target, "utf8").catch(() => null);
  return { path: target, content: content ?? "", exists: content !== null };
}

/** Persist the directive. A blank body means "use the built-in default" — we
 * delete the file rather than write an empty one, because the engine reads an
 * existing file verbatim and an empty directive would give the review no task. */
async function writeSelfEvolveDirective(content: string): Promise<{ path: string; exists: boolean; bytes: number }> {
  const target = selfEvolveDirectivePathForMain();
  if (!content || !content.trim()) {
    await rm(target, { force: true });
    return { path: target, exists: false, bytes: 0 };
  }
  await mkdir(path.dirname(target), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(target, normalized, "utf8");
  return { path: target, exists: true, bytes: Buffer.byteLength(normalized, "utf8") };
}

// === Permission rules (allowlist) ===

type PermissionRulePayload = {
  tool: string;
  mode: "allow" | "deny" | "ask";
  commandPrefix?: string;
  pathGlob?: string;
  reason?: string;
};

async function addPermissionRule(
  cwd: string,
  scope: "workspace" | "global",
  rule: PermissionRulePayload,
): Promise<{ path: string; rules: PermissionRulePayload[] }> {
  if (!rule || typeof rule !== "object") throw new Error("permission rule required");
  if (typeof rule.tool !== "string" || !rule.tool) throw new Error("rule.tool required");
  if (rule.mode !== "allow" && rule.mode !== "deny" && rule.mode !== "ask") {
    throw new Error(`invalid mode: ${String(rule.mode)}`);
  }
  const target =
    scope === "global"
      ? path.join(reinaConfigHome(), "permissions.json")
      : path.join(path.resolve(cwd), ".reina", "permissions.json");
  await mkdir(path.dirname(target), { recursive: true });
  let rules: PermissionRulePayload[] = [];
  const raw = await readFile(target, "utf8").catch(() => null);
  if (raw !== null && raw.trim()) {
    // trim() also strips a leading UTF-8 BOM (U+FEFF) from hand-edited files.
    // A file that EXISTS but doesn't parse must not fall through to the write
    // below — that would silently replace every rule the user already saved
    // with just this one. Fail the request instead.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch (error) {
      throw new Error(
        `Cannot add rule: ${target} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or delete the file, then retry.`,
      );
    }
    const list = (parsed as { rules?: unknown } | null)?.rules;
    if (Array.isArray(list)) rules = list as PermissionRulePayload[];
  }
  // Dedup by full equality (same tool + mode + selectors) so repeated clicks
  // on "Always allow git status*" don't bloat the file.
  const same = (a: PermissionRulePayload, b: PermissionRulePayload) =>
    a.tool === b.tool
    && a.mode === b.mode
    && (a.commandPrefix ?? "") === (b.commandPrefix ?? "")
    && (a.pathGlob ?? "") === (b.pathGlob ?? "");
  if (!rules.some((existing) => same(existing, rule))) rules.push(rule);
  await writeFile(target, `${JSON.stringify({ rules }, null, 2)}\n`, "utf8");
  return { path: target, rules };
}

// === Engine config (ReinaConfig) ===

export type EngineConfigPayload = {
  workspacePath: string;
  globalPath: string;
  workspace: ReinaConfig | null;
  global: ReinaConfig | null;
  effective: ReinaConfig;
  errors: string[];
};

function reinaConfigHomeForMain(): string {
  return process.env.REINA_CONFIG_HOME ? path.resolve(process.env.REINA_CONFIG_HOME) : path.join(os.homedir(), ".reina");
}

function globalEngineConfigPath(): string {
  return path.join(reinaConfigHomeForMain(), "config.json");
}

function workspaceEngineConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".reina", "config.json");
}

function defaultEngineConfig(): ReinaConfig {
  return {
    agent: "default",
    permissionMode: "default",
    model: {
      provider: "deterministic",
      model: "reina-deterministic",
    },
    toolLoop: {
      hardMaxSteps: 192,
      stagnationLimit: 12,
      repeatedActionLimit: 20,
      consecutiveErrorLimit: 8,
      autoRepair: true,
    },
  } satisfies ReinaConfig;
}

async function loadEngineConfigFile(filePath: string, errors: string[]): Promise<ReinaConfig | null> {
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(trimmed) as ReinaConfig;
  } catch (error) {
    errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readEngineConfig(cwd: string): Promise<EngineConfigPayload> {
  const workspacePath = workspaceEngineConfigPath(cwd);
  const globalPath = globalEngineConfigPath();
  const errors: string[] = [];
  const global = await loadEngineConfigFile(globalPath, errors);
  const workspace = await loadEngineConfigFile(workspacePath, errors);
  const fallback = defaultEngineConfig();
  const effective: ReinaConfig = {
    ...fallback,
    ...(global ?? {}),
    ...(workspace ?? {}),
    model: { ...fallback.model, ...(global?.model ?? {}), ...(workspace?.model ?? {}) },
    toolLoop: { ...fallback.toolLoop, ...(global?.toolLoop ?? {}), ...(workspace?.toolLoop ?? {}) },
    hooks: { ...(global?.hooks ?? {}), ...(workspace?.hooks ?? {}) },
  };
  return { workspacePath, globalPath, workspace, global, effective, errors };
}

const ENGINE_CONFIG_PERMISSIONS: PermissionMode[] = ["plan", "default", "accept-edits", "bypass"];

function sanitizeToolLoop(value: unknown): ReinaConfig["toolLoop"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const out: NonNullable<ReinaConfig["toolLoop"]> = {};
  const numericFields: Array<keyof NonNullable<ReinaConfig["toolLoop"]>> = [
    "hardMaxSteps",
    "stagnationLimit",
    "repeatedActionLimit",
    "consecutiveErrorLimit",
  ];
  for (const field of numericFields) {
    const raw = incoming[field];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) (out as Record<string, number>)[field] = Math.floor(raw);
  }
  if (typeof incoming.autoRepair === "boolean") out.autoRepair = incoming.autoRepair;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeCompletionVerify(value: unknown): NonNullable<NonNullable<ReinaConfig["goal"]>["verify"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const verify: NonNullable<NonNullable<ReinaConfig["goal"]>["verify"]> = {};
  if (typeof incoming.enabled === "boolean") verify.enabled = incoming.enabled;
  if (typeof incoming.failOpen === "boolean") verify.failOpen = incoming.failOpen;
  if (typeof incoming.maxRounds === "number" && Number.isFinite(incoming.maxRounds) && incoming.maxRounds > 0) {
    verify.maxRounds = Math.floor(incoming.maxRounds);
  }
  const model = sanitizeModel(incoming.model);
  if (model) verify.model = model;
  return Object.keys(verify).length ? verify : undefined;
}

function sanitizeGoal(value: unknown): ReinaConfig["goal"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const goal: NonNullable<ReinaConfig["goal"]> = {};
  for (const field of ["maxContinuationRounds", "stagnationLimit"] as const) {
    const raw = incoming[field];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) goal[field] = Math.floor(raw);
  }
  const verify = sanitizeCompletionVerify(incoming.verify);
  if (verify) goal.verify = verify;
  return Object.keys(goal).length ? goal : undefined;
}

function sanitizeAutopilot(value: unknown): ReinaConfig["autopilot"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const verifyRaw = (value as { verify?: unknown }).verify;
  if (!verifyRaw || typeof verifyRaw !== "object") return undefined;
  const verify = sanitizeCompletionVerify(verifyRaw);
  return verify ? { verify } : undefined;
}

function sanitizeSelfEvolve(value: unknown): ReinaConfig["selfEvolve"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const out: NonNullable<ReinaConfig["selfEvolve"]> = {};
  if (typeof incoming.enabled === "boolean") out.enabled = incoming.enabled;
  if (typeof incoming.everyTurns === "number" && Number.isFinite(incoming.everyTurns) && incoming.everyTurns > 0) {
    out.everyTurns = Math.floor(incoming.everyTurns);
  }
  if (typeof incoming.notify === "boolean") out.notify = incoming.notify;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeMemoryDream(value: unknown): ReinaConfig["memory"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const out: NonNullable<ReinaConfig["memory"]> = {};
  if (typeof incoming.dream === "boolean") out.dream = incoming.dream;
  for (const key of ["cooldownHours", "minSessions", "idleHours"] as const) {
    const v = incoming[key];
    // Clamp into the advertised range (shared MEMORY_DREAM_LIMITS table) so a
    // hand-edited reina.json can't smuggle in e.g. an 11-year idle window
    // that silently disables the background run.
    const { min, max } = MEMORY_DREAM_LIMITS[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = Math.min(max, Math.max(min, Math.floor(v)));
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeEngineConfig(incoming: ReinaConfig): ReinaConfig {
  const out: ReinaConfig = {};
  if (typeof incoming.agent === "string" && incoming.agent.trim()) out.agent = incoming.agent.trim();
  if (typeof incoming.permissionMode === "string" && (ENGINE_CONFIG_PERMISSIONS as string[]).includes(incoming.permissionMode)) {
    out.permissionMode = incoming.permissionMode as PermissionMode;
  }
  const model = sanitizeModel(incoming.model);
  if (model) out.model = model;
  const titleModel = sanitizeModel(incoming.titleModel);
  if (titleModel) out.titleModel = titleModel;
  const compactionModel = sanitizeModel(incoming.compactionModel);
  if (compactionModel) out.compactionModel = compactionModel;
  if (incoming.autoTitle && typeof incoming.autoTitle === "object") {
    out.autoTitle = { enabled: incoming.autoTitle.enabled !== false };
  }
  const goal = sanitizeGoal(incoming.goal);
  if (goal) out.goal = goal;
  const autopilot = sanitizeAutopilot(incoming.autopilot);
  if (autopilot) out.autopilot = autopilot;
  const toolLoop = sanitizeToolLoop(incoming.toolLoop);
  if (toolLoop) out.toolLoop = toolLoop;
  const hooks = sanitizeHooks(incoming.hooks);
  if (hooks) out.hooks = hooks;
  // Preserve `subagent` — forkEnabled comes from the fork-mode toggle (Agents
  // panel); secondaryModel is the hand-edited "all subagents on a cheap model"
  // knob. Without this branch the allowlist sanitizer drops the block on every
  // UI write and the settings never persist.
  if (incoming.subagent && typeof incoming.subagent === "object") {
    const sub = incoming.subagent as { forkEnabled?: unknown; secondaryModel?: unknown };
    const subOut: NonNullable<ReinaConfig["subagent"]> = {};
    if (typeof sub.forkEnabled === "boolean") subOut.forkEnabled = sub.forkEnabled;
    const secondaryModel = sanitizeModel(sub.secondaryModel);
    if (secondaryModel) subOut.secondaryModel = secondaryModel;
    if (Object.keys(subOut).length) out.subagent = subOut;
  }
  // Preserve `selfEvolve` — the self-evolve settings page writes it to global
  // config. Without this branch the allowlist sanitizer would drop it on every
  // write and the learning loop could never be enabled from the UI.
  const selfEvolve = sanitizeSelfEvolve(incoming.selfEvolve);
  if (selfEvolve) out.selfEvolve = selfEvolve;
  // Preserve `memory` — the memory-consolidation knobs on the self-evolve
  // settings page. Same allowlist trap as selfEvolve above: without this
  // branch the sanitizer drops the block on every write.
  const memory = sanitizeMemoryDream(incoming.memory);
  if (memory) out.memory = memory;
  // Preserve `mcp.deferredServers` — the only reina.json-side MCP knob
  // the engine reads (loadMcpResidencyPolicy). Without this branch the
  // sanitizer would silently drop the field every time the UI writes the
  // config, defeating the resident/deferred toggle.
  if (incoming.mcp && typeof incoming.mcp === "object") {
    const deferred = (incoming.mcp as { deferredServers?: unknown }).deferredServers;
    if (Array.isArray(deferred)) {
      const names = deferred.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
      if (names.length > 0) {
        out.mcp = { deferredServers: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
      }
    }
  }
  return out;
}

const HOOK_EVENT_NAMES = ["preToolUse", "postToolUse", "userPromptSubmit", "onStop"] as const;

function sanitizeHooks(value: unknown): ReinaConfig["hooks"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const incoming = value as Record<string, unknown>;
  const out: NonNullable<ReinaConfig["hooks"]> = {};
  for (const event of HOOK_EVENT_NAMES) {
    const list = incoming[event];
    if (!Array.isArray(list)) continue;
    const sanitized = list
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const e = entry as Record<string, unknown>;
        if (typeof e.command !== "string" || !e.command.trim()) return null;
        const hook: { command: string; matcher?: string; timeoutMs?: number } = { command: e.command };
        if (typeof e.matcher === "string" && e.matcher.trim()) hook.matcher = e.matcher.trim();
        if (typeof e.timeoutMs === "number" && Number.isFinite(e.timeoutMs) && e.timeoutMs > 0) hook.timeoutMs = Math.floor(e.timeoutMs);
        return hook;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (sanitized.length > 0) out[event] = sanitized;
  }
  return Object.keys(out).length ? out : undefined;
}

async function writeEngineConfig(
  cwd: string,
  scope: "workspace" | "global",
  config: ReinaConfig,
): Promise<{ path: string; config: ReinaConfig }> {
  const sanitized = sanitizeEngineConfig(config);
  const target = scope === "workspace" ? workspaceEngineConfigPath(cwd) : globalEngineConfigPath();
  await writeConfigFile(target, `${JSON.stringify(sanitized, null, 2)}\n`);
  return { path: target, config: sanitized };
}

// === MCP config files ===

function workspaceMcpConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".reina", "mcp.json");
}

function globalMcpConfigPath(): string {
  return path.join(reinaConfigHomeForMain(), "mcp.json");
}

function defaultMcpJson(): string {
  return `${JSON.stringify(
    {
      servers: {
        example: {
          type: "stdio",
          enabled: false,
          command: "node",
          args: ["./mcp-server.js"],
          cwd: ".",
          timeoutMs: 30000,
          env: { EXAMPLE_ENV: "value" },
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function readMcpConfig(cwd: string): Promise<{
  workspacePath: string;
  globalPath: string;
  workspace: string | null;
  global: string | null;
}> {
  const workspacePath = workspaceMcpConfigPath(cwd);
  const globalPath = globalMcpConfigPath();
  const [workspace, global] = await Promise.all([
    readFile(workspacePath, "utf8").catch(() => null),
    readFile(globalPath, "utf8").catch(() => null),
  ]);
  return { workspacePath, globalPath, workspace, global };
}

async function writeMcpConfig(
  cwd: string,
  scope: "workspace" | "global",
  contents: string,
): Promise<{ path: string; bytes: number }> {
  const target = scope === "workspace" ? workspaceMcpConfigPath(cwd) : globalMcpConfigPath();
  await mkdir(path.dirname(target), { recursive: true });
  let payload = contents && contents.trim() ? contents : defaultMcpJson();
  // Validate JSON before writing.
  try {
    JSON.parse(payload);
  } catch (error) {
    throw new Error(`MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload.endsWith("\n")) payload = `${payload}\n`;
  await writeConfigFile(target, payload);
  return { path: target, bytes: Buffer.byteLength(payload, "utf8") };
}

// === Public tool catalog (mirrors packages/tools/src/registry.ts) ===

type ToolCatalogEntry = {
  name: string;
  permission: "read" | "write" | "execute" | "network" | "state";
  description: string;
  requiresApproval: boolean;
};

const publicToolCatalog: ToolCatalogEntry[] = [
  { name: "read_file", permission: "read", description: "Read a file.", requiresApproval: false },
  { name: "write_file", permission: "write", description: "Create or overwrite a file.", requiresApproval: true },
  { name: "edit_file", permission: "write", description: "Apply a unified-style edit to a file.", requiresApproval: true },
  { name: "multi_edit", permission: "write", description: "Apply many edits in one call.", requiresApproval: true },
  { name: "run_shell", permission: "execute", description: "Run a shell command in the workspace.", requiresApproval: true },
  { name: "task_output", permission: "read", description: "Read output from a background shell task.", requiresApproval: false },
  { name: "kill_shell", permission: "execute", description: "Stop a background shell task.", requiresApproval: true },
  { name: "monitor", permission: "read", description: "Block until a regex matches a background task's output, or it exits.", requiresApproval: false },
  { name: "apply_patch", permission: "write", description: "Apply a git-style patch atomically.", requiresApproval: true },
  { name: "write_todos", permission: "state", description: "Maintain the in-session todo list.", requiresApproval: false },
  { name: "question", permission: "state", description: "Ask the human a clarifying question.", requiresApproval: false },
  { name: "plan", permission: "state", description: "Record or update the plan-mode plan.", requiresApproval: false },
  { name: "exit_plan_mode", permission: "state", description: "Submit the final plan for user approval; switches out of plan mode on approval.", requiresApproval: false },
  { name: "task", permission: "state", description: "Spawn a subagent for a focused task.", requiresApproval: false },
  { name: "list_skills", permission: "read", description: "List installed skills.", requiresApproval: false },
  { name: "read_skill", permission: "read", description: "Read a skill's instructions.", requiresApproval: false },
  { name: "web_fetch", permission: "network", description: "Fetch a URL over HTTP.", requiresApproval: true },
  { name: "mcp_list_resources", permission: "read", description: "List resources on an MCP server.", requiresApproval: false },
  { name: "mcp_read_resource", permission: "read", description: "Read a resource from an MCP server.", requiresApproval: false },
  { name: "notify", permission: "state", description: "Post a native desktop notification.", requiresApproval: false },
  { name: "schedule_wakeup", permission: "state", description: "Schedule a follow-up turn on this session.", requiresApproval: false },
];

function listPublicTools(): ToolCatalogEntry[] {
  return publicToolCatalog;
}

// === Shell discovery ===

// === Skills ===

export type SkillSummary = {
  name: string;
  description: string;
  scope: "workspace" | "global";
  path: string;
  allowedTools?: string[];
  /** Frontmatter `context: fork` — the skill is designed for one-shot
   * subagent dispatch; the /skill picker shows a fork badge. */
  context?: "inline" | "fork";
  /** Frontmatter `user-invocable: false` — model-only skill, hidden from the
   * /skill picker. Mirrors core skills.ts parsing. */
  userInvocable?: false;
};

function workspaceSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "skills");
}

function globalSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function sharedSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

async function listSkillsInDir(root: string, scope: "workspace" | "global"): Promise<SkillSummary[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: SkillSummary[] = [];
  for (const entry of entries) {
    // Symlinked skill directories report isDirectory() === false on the
    // Dirent — let the SKILL.md read decide whether the target resolves.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    const content = await readFile(skillFile, "utf8").catch(() => null);
    if (content === null) continue;
    // Shared parser (protocol) — the same implementation core loadSkills and
    // the list_skills/read_skill tools use, so the picker can never drift
    // from what the engine loads.
    const parsed = parseSkillFrontmatter(content, entry.name);
    out.push({
      name: parsed.name,
      description: parsed.description,
      allowedTools: parsed.allowedTools,
      scope,
      path: skillFile,
      ...(parsed.context ? { context: parsed.context } : {}),
      ...(parsed.userInvocable === false ? { userInvocable: false as const } : {}),
    });
  }
  return out;
}

async function listSkills(cwd: string): Promise<{
  workspaceDir: string;
  globalDir: string;
  skills: SkillSummary[];
}> {
  const workspaceDir = workspaceSkillsDir(cwd);
  const globalDir = globalSkillsDir();
  const [ws, gl, shared] = await Promise.all([
    listSkillsInDir(workspaceDir, "workspace"),
    listSkillsInDir(globalDir, "global"),
    listSkillsInDir(sharedSkillsDir(), "global"),
  ]);
  const seen = new Map<string, SkillSummary>();
  for (const s of shared) seen.set(s.name, s);
  for (const s of gl) seen.set(s.name, s);
  for (const s of ws) seen.set(s.name, s); // workspace wins
  return { workspaceDir, globalDir, skills: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

async function createSkill(
  cwd: string,
  scope: "workspace" | "global",
  rawName: string,
  rawDescription: string,
): Promise<{ path: string; name: string }> {
  const name = String(rawName || "").trim();
  if (!name) throw new Error("Skill name is required.");
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Skill name must start with a letter and contain only letters, numbers, hyphen, or underscore.");
  }
  const description = String(rawDescription || "").trim() || `Workspace skill ${name}`;
  const root = scope === "workspace" ? workspaceSkillsDir(cwd) : globalSkillsDir();
  const skillDir = path.join(root, name);
  const skillFile = path.join(skillDir, "SKILL.md");
  const existing = await stat(skillFile).catch(() => null);
  if (existing) throw new Error(`Skill already exists: ${skillFile}`);
  await mkdir(skillDir, { recursive: true });
  const body = `---\nname: ${name}\ndescription: ${description}\n# allowed-tools: read_file write_file run_shell\n---\n\n# ${name}\n\n${description}\n\n## When to use\n- describe the trigger conditions here\n\n## How to use\n1. step one\n2. step two\n\n## Notes\n- gotchas, references, links\n`;
  await writeFile(skillFile, body, "utf8");
  // Mirror writeCustomModels/Agents: notify other windows so the chat's slash
  // launcher invalidates its skills cache instead of needing an app restart.
  broadcastRendererEvent("skills-changed", { scope, path: skillFile });
  return { path: skillFile, name };
}

async function listShells(): Promise<Array<{ id: string; label: string; command: string; available: boolean }>> {
  const candidates: Array<{ id: string; label: string; command: string }> = [];
  if (process.platform === "win32") {
    candidates.push(
      { id: "powershell", label: "Windows PowerShell", command: "powershell.exe" },
      { id: "pwsh", label: "PowerShell 7", command: "pwsh.exe" },
      { id: "cmd", label: "Command Prompt", command: "cmd.exe" },
      { id: "bash", label: "Git Bash", command: "bash.exe" },
    );
  } else {
    candidates.push(
      { id: "bash", label: "Bash", command: "bash" },
      { id: "zsh", label: "Zsh", command: "zsh" },
      { id: "fish", label: "Fish", command: "fish" },
      { id: "sh", label: "POSIX sh", command: "sh" },
    );
  }
  const results: Array<{ id: string; label: string; command: string; available: boolean }> = [];
  for (const entry of candidates) {
    const resolved = await resolveExecutable(entry.command).catch(() => null);
    results.push({ ...entry, available: Boolean(resolved) });
  }
  return results;
}
