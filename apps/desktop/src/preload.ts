import { contextBridge, ipcRenderer } from "electron";
import type { RemoteModelParams } from "./main/remote-models.js";

type EventHandler = (payload: unknown) => void;

const onEvent = (event: string, handler: EventHandler): (() => void) => {
  const channel = `reina:event:${event}`;
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("reinaDesktop", {
  invoke: (command: string, args?: Record<string, unknown>) => ipcRenderer.invoke("reina:invoke", command, args),
  awaitInitialization: (onStep?: EventHandler) => {
    const off = onStep ? onEvent("init-step", onStep) : undefined;
    return ipcRenderer.invoke("reina:await-initialization").finally(() => off?.());
  },
  killAgentHost: () => ipcRenderer.invoke("reina:kill-agent-host"),
  getWindowConfig: () => ipcRenderer.invoke("reina:get-window-config"),
  consumeInitialDeepLinks: () => ipcRenderer.invoke("reina:consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("reina:get-default-server-url"),
  setDefaultServerUrl: (url: string | null) => ipcRenderer.invoke("reina:set-default-server-url", url),
  getWslConfig: () => ipcRenderer.invoke("reina:get-wsl-config"),
  setWslConfig: (config: { enabled: boolean }) => ipcRenderer.invoke("reina:set-wsl-config", config),
  getDisplayBackend: () => ipcRenderer.invoke("reina:get-display-backend"),
  setDisplayBackend: (backend: string | null) => ipcRenderer.invoke("reina:set-display-backend", backend),
  parseMarkdownCommand: (markdown: string) => ipcRenderer.invoke("reina:parse-markdown", markdown),
  checkAppExists: (appName: string) => ipcRenderer.invoke("reina:check-app-exists", appName),
  wslPath: (path: string, mode: "windows" | "linux" | null) => ipcRenderer.invoke("reina:wsl-path", path, mode),
  resolveAppPath: (appName: string) => ipcRenderer.invoke("reina:resolve-app-path", appName),
  storeGet: (name: string, key: string) => ipcRenderer.invoke("reina:store-get", name, key),
  storeGetAll: (name: string) => ipcRenderer.invoke("reina:store-get-all", name),
  storeSet: (name: string, key: string, value: string) => ipcRenderer.invoke("reina:store-set", name, key, value),
  storeDelete: (name: string, key: string) => ipcRenderer.invoke("reina:store-delete", name, key),
  storeClear: (name: string) => ipcRenderer.invoke("reina:store-clear", name),
  storeKeys: (name: string) => ipcRenderer.invoke("reina:store-keys", name),
  storeLength: (name: string) => ipcRenderer.invoke("reina:store-length", name),
  getDesktopState: () => ipcRenderer.invoke("reina:get-desktop-state"),
  clearActiveWorkspace: () => ipcRenderer.invoke("reina:clear-active-workspace"),
  getDesktopConfig: (cwd?: string) => ipcRenderer.invoke("reina:get-desktop-config", cwd),
  touchWorkspace: (cwd: string) => ipcRenderer.invoke("reina:touch-workspace", cwd),
  removeWorkspace: (workspaceId: string) => ipcRenderer.invoke("reina:remove-workspace", workspaceId),
  recordSession: (session: Record<string, unknown>, title?: string) => ipcRenderer.invoke("reina:record-session", session, title),
  deleteSession: (sessionId: string) => ipcRenderer.invoke("reina:delete-session", sessionId),
  renameSession: (sessionId: string, title: string) => ipcRenderer.invoke("reina:rename-session", sessionId, title),
  setSessionFlags: (sessionId: string, flags: { pinned?: boolean; archived?: boolean }) =>
    ipcRenderer.invoke("reina:set-session-flags", sessionId, flags),
  setProjectOrder: (orderedIds: string[]) => ipcRenderer.invoke("reina:set-project-order", orderedIds),
  setSessionOrder: (sessionId: string, orderTs: string | null) =>
    ipcRenderer.invoke("reina:set-session-order", sessionId, orderTs),
  listWorkspace: (cwd?: string) => ipcRenderer.invoke("reina:list-workspace", cwd),
  listWorkspaceDir: (cwd: string | undefined, relDir: string) => ipcRenderer.invoke("reina:list-workspace-dir", cwd, relDir),
  readWorkspaceFile: (cwd: string | undefined, filePath: string) => ipcRenderer.invoke("reina:read-workspace-file", cwd, filePath),
  writeWorkspaceFile: (cwd: string | undefined, filePath: string, content: string) =>
    ipcRenderer.invoke("reina:write-workspace-file", cwd, filePath, content),
  readSubagentActivity: (cwd: string | undefined, taskId: string) =>
    ipcRenderer.invoke("reina:read-subagent-activity", cwd, taskId),
  listNotes: (cwd?: string, scope?: "workspace" | "global") =>
    ipcRenderer.invoke("reina:list-notes", cwd, scope),
  readNote: (cwd: string | undefined, noteId: string, scope?: "workspace" | "global") =>
    ipcRenderer.invoke("reina:read-note", cwd, noteId, scope),
  getNotesDir: (cwd: string | undefined, scope?: "workspace" | "global") =>
    ipcRenderer.invoke("reina:get-notes-dir", cwd, scope),
  openNotesFolder: (cwd: string | undefined, scope?: "workspace" | "global") =>
    ipcRenderer.invoke("reina:open-notes-folder", cwd, scope),
  getContextHistory: (sessionId: string, taskId?: string) =>
    ipcRenderer.invoke("reina:invoke", "get_context_history", { sessionId, taskId }),
  getContextRequest: (sessionId: string, requestId: string, taskId?: string) =>
    ipcRenderer.invoke("reina:invoke", "get_context_request", { sessionId, requestId, taskId }),
  listGitChanges: (cwd?: string) => ipcRenderer.invoke("reina:list-git-changes", cwd),
  getGitDiff: (cwd: string | undefined, filePath: string, mode?: "unified" | "split") => ipcRenderer.invoke("reina:get-git-diff", cwd, filePath, mode),
  openDirectoryPicker: (opts?: Record<string, unknown>) => ipcRenderer.invoke("reina:open-directory-picker", opts),
  openFilePicker: (opts?: Record<string, unknown>) => ipcRenderer.invoke("reina:open-file-picker", opts),
  saveFilePicker: (opts?: Record<string, unknown>) => ipcRenderer.invoke("reina:save-file-picker", opts),
  openLink: (url: string) => ipcRenderer.send("reina:open-link", url),
  openPath: (path: string, app?: string) => ipcRenderer.invoke("reina:open-path", path, app),
  openShellIn: (cwd: string, shell?: string) => ipcRenderer.invoke("reina:open-shell-in", cwd, shell),
  revealInFolder: (path: string) => ipcRenderer.invoke("reina:reveal-in-folder", path),
  clipboardWrite: (text: string) => ipcRenderer.invoke("reina:clipboard-write", text),
  createWorkspaceEntry: (cwd: string | undefined, relPath: string, type: "file" | "directory") =>
    ipcRenderer.invoke("reina:create-workspace-entry", cwd, relPath, type),
  listAgentProfiles: () => ipcRenderer.invoke("reina:list-agent-profiles"),
  listKnownModels: () => ipcRenderer.invoke("reina:list-known-models"),
  readRulesFile: (cwd: string | undefined, fileKey: string) =>
    ipcRenderer.invoke("reina:read-rules-file", cwd, fileKey),
  writeRulesFile: (cwd: string | undefined, fileKey: string, content: string) =>
    ipcRenderer.invoke("reina:write-rules-file", cwd, fileKey, content),
  readSelfEvolveDirective: () => ipcRenderer.invoke("reina:read-self-evolve-directive"),
  writeSelfEvolveDirective: (content: string) =>
    ipcRenderer.invoke("reina:write-self-evolve-directive", content),
  readEngineConfig: (cwd: string | undefined) =>
    ipcRenderer.invoke("reina:read-engine-config", cwd),
  writeEngineConfig: (cwd: string | undefined, scope: "workspace" | "global", config: Record<string, unknown>) =>
    ipcRenderer.invoke("reina:write-engine-config", cwd, scope, config),
  readMcpConfig: (cwd: string | undefined) => ipcRenderer.invoke("reina:read-mcp-config", cwd),
  writeMcpConfig: (cwd: string | undefined, scope: "workspace" | "global", contents: string) =>
    ipcRenderer.invoke("reina:write-mcp-config", cwd, scope, contents),
  addPermissionRule: (cwd: string | undefined, scope: "workspace" | "global", rule: Record<string, unknown>) =>
    ipcRenderer.invoke("reina:add-permission-rule", cwd, scope, rule),
  listTools: () => ipcRenderer.invoke("reina:list-tools"),
  listSkills: (cwd: string | undefined) => ipcRenderer.invoke("reina:list-skills", cwd),
  createSkill: (cwd: string | undefined, scope: "workspace" | "global", name: string, description: string) =>
    ipcRenderer.invoke("reina:create-skill", cwd, scope, name, description),
  readCustomModels: (cwd: string | undefined) => ipcRenderer.invoke("reina:read-custom-models", cwd),
  writeCustomModels: (cwd: string | undefined, scope: "workspace" | "global", models: unknown) =>
    ipcRenderer.invoke("reina:write-custom-models", cwd, scope, models),
  readCustomAgents: () => ipcRenderer.invoke("reina:read-custom-agents"),
  writeCustomAgents: (agents: unknown) => ipcRenderer.invoke("reina:write-custom-agents", agents),
  fetchRemoteModels: (params: RemoteModelParams) =>
    ipcRenderer.invoke("reina:fetch-remote-models", params),
  modelsDevEnrich: (models: unknown) => ipcRenderer.invoke("reina:models-dev-enrich", models),
  probeRemoteConnection: (params: RemoteModelParams) =>
    ipcRenderer.invoke("reina:probe-remote-connection", params),
  probeModel: (params: RemoteModelParams & { model: string }) =>
    ipcRenderer.invoke("reina:probe-model", params),
  // Subscription accounts (OAuth-backed Claude/Codex). Secrets stay in main;
  // these only ever exchange the token-free public view.
  listSubscriptions: () => ipcRenderer.invoke("reina:list-subscriptions"),
  connectSubscription: (kind: "anthropic-oauth" | "openai-codex") =>
    ipcRenderer.invoke("reina:connect-subscription", kind),
  importSubscription: (kind: "anthropic-oauth" | "openai-codex") =>
    ipcRenderer.invoke("reina:import-subscription", kind),
  subscriptionCliAvailable: (kind: "anthropic-oauth" | "openai-codex") =>
    ipcRenderer.invoke("reina:subscription-cli-available", kind),
  disconnectSubscription: (id: string) => ipcRenderer.invoke("reina:disconnect-subscription", id),
  updateSubscription: (id: string, patch: { label?: string; model?: string; contextTokens?: number }) =>
    ipcRenderer.invoke("reina:update-subscription", id, patch),
  listSubscriptionModels: (id: string) => ipcRenderer.invoke("reina:list-subscription-models", id),
  subscriptionUsage: (id: string) => ipcRenderer.invoke("reina:subscription-usage", id),
  listShells: () => ipcRenderer.invoke("reina:list-shells"),
  reloadRenderer: () => ipcRenderer.invoke("reina:reload-renderer"),
  readClipboardImage: () => ipcRenderer.invoke("reina:read-clipboard-image"),
  showNotification: (title: string, body?: string, options?: { silent?: boolean }) =>
    ipcRenderer.send("reina:show-notification", title, body, options),
  windowMinimize: () => ipcRenderer.invoke("reina:window-minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("reina:window-toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("reina:window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("reina:window-is-maximized"),
  windowIsFullScreen: () => ipcRenderer.invoke("reina:window-is-fullscreen"),
  openWorkspaceWindow: (target?: { tab?: string; detached?: boolean; sideChatDraft?: string }) =>
    ipcRenderer.invoke("reina:open-workspace-window", target),
  openSettingsWindow: (panel?: string) => ipcRenderer.invoke("reina:open-settings-window", panel),
  toggleSessionSidebarWindow: () => ipcRenderer.invoke("reina:toggle-session-sidebar-window"),
  hideSessionSidebarWindow: () => ipcRenderer.invoke("reina:hide-session-sidebar-window"),
  getSessionSidebarState: () => ipcRenderer.invoke("reina:get-session-sidebar-state"),
  openSessionInMain: (index: unknown) => ipcRenderer.invoke("reina:open-session-in-main", index),
  runCommandInMain: (commandId: string) => ipcRenderer.invoke("reina:run-command-in-main", commandId),
  openWorkspaceInMain: (cwd: string) => ipcRenderer.invoke("reina:open-workspace-in-main", cwd),
  openCommandPaletteInMain: (query?: string) => ipcRenderer.invoke("reina:open-command-palette-in-main", query),
  openConversationSearchInMain: () => ipcRenderer.invoke("reina:open-conversation-search-in-main"),
  useSkillInMain: (skill: unknown) => ipcRenderer.invoke("reina:use-skill-in-main", skill),
  setActiveSession: (session: string | null | { sessionId: string | null; draft?: boolean; cwd?: string }) =>
    ipcRenderer.invoke("reina:set-active-session", session),
  getWindowCount: () => ipcRenderer.invoke("reina:get-window-count"),
  getWindowFocused: () => ipcRenderer.invoke("reina:get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("reina:set-window-focus"),
  showWindow: () => ipcRenderer.invoke("reina:show-window"),
  relaunch: () => ipcRenderer.send("reina:relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("reina:get-zoom-factor"),
  setZoomFactor: (factor: number) => ipcRenderer.invoke("reina:set-zoom-factor", factor),
  setTitlebar: (theme: Record<string, unknown>) => ipcRenderer.invoke("reina:set-titlebar", theme),
  loadingWindowComplete: () => ipcRenderer.send("reina:loading-window-complete"),
  runUpdater: (alertOnFail: boolean) => ipcRenderer.invoke("reina:run-updater", alertOnFail),
  checkUpdate: () => ipcRenderer.invoke("reina:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("reina:download-update"),
  installUpdate: () => ipcRenderer.invoke("reina:install-update"),
  getUpdateInfo: () => ipcRenderer.invoke("reina:get-update-info"),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("reina:set-background-color", color),
  popupMenu: (key: string, x?: number, y?: number, payload?: unknown) =>
    ipcRenderer.send("reina:menu-popup", key, x, y, payload),
  conversationMenuAction: (action: string) => ipcRenderer.send("reina:conversation-menu-action", action),
  conversationMenuReady: (revision?: number) => ipcRenderer.send("reina:conversation-menu-ready", revision),
  closeConversationMenu: () => ipcRenderer.send("reina:conversation-menu-close"),
  terminalCreate: (payload: { id: string; cwd?: string; shell?: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke("reina:terminal:create", payload),
  terminalWrite: (id: string, data: string) => ipcRenderer.send("reina:terminal:write", id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("reina:terminal:resize", id, cols, rows),
  terminalDispose: (id: string) => ipcRenderer.send("reina:terminal:dispose", id),
  terminalDisposeWindow: () => ipcRenderer.send("reina:terminal:dispose-window"),
  events: {
    on: onEvent,
  },
});
