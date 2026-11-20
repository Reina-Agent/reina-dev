// Typed view of the preload bridge (apps/desktop/src/preload.ts).
// This interface IS the renderer-migration parity checklist: every method the
// legacy renderer uses appears here. Keep it in sync with preload.ts — the
// contract itself must not change during the migration.
import type { RemoteModelParams } from "../../../main/remote-models.js";
import type { ContextHistory, ContextRequestDetail } from "@reina/protocol";

export type UnsubscribeFn = () => void;
export type EventHandler = (payload: unknown) => void;

export type StoreName = string;

// Mirror of AutoUpdateStatus in apps/desktop/src/main/auto-update.ts. Pushed to
// all windows on the `auto-update-status` event and returned by getUpdateInfo().
export type UpdateStatus =
  | { status: "idle" }
  | { status: "unsupported"; detail: string }
  | { status: "checking"; triggeredByUser: boolean }
  | { status: "available"; version: string; triggeredByUser: boolean }
  | { status: "not-available"; triggeredByUser: boolean }
  | { status: "downloading"; percent: number; version?: string; triggeredByUser: boolean }
  | { status: "downloaded"; version: string; triggeredByUser: boolean }
  | { status: "error"; detail: string; version?: string; triggeredByUser: boolean; duringDownload: boolean };

export interface UpdateInfo {
  version: string;
  supported: boolean;
  status: UpdateStatus;
}

export interface ReinaDesktopBridge {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  awaitInitialization: (onStep?: EventHandler) => Promise<unknown>;
  killAgentHost: () => Promise<unknown>;
  getWindowConfig: () => Promise<unknown>;
  consumeInitialDeepLinks: () => Promise<string[]>;
  getDefaultServerUrl: () => Promise<string | null>;
  setDefaultServerUrl: (url: string | null) => Promise<unknown>;
  getWslConfig: () => Promise<{ enabled: boolean }>;
  setWslConfig: (config: { enabled: boolean }) => Promise<unknown>;
  getDisplayBackend: () => Promise<string | null>;
  setDisplayBackend: (backend: string | null) => Promise<unknown>;
  parseMarkdownCommand: (markdown: string) => Promise<unknown>;
  checkAppExists: (appName: string) => Promise<boolean>;
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>;
  resolveAppPath: (appName: string) => Promise<string | null>;
  storeGet: (name: StoreName, key: string) => Promise<string | null>;
  storeGetAll: (name: StoreName) => Promise<Record<string, string>>;
  storeSet: (name: StoreName, key: string, value: string) => Promise<unknown>;
  storeDelete: (name: StoreName, key: string) => Promise<unknown>;
  storeClear: (name: StoreName) => Promise<unknown>;
  storeKeys: (name: StoreName) => Promise<string[]>;
  storeLength: (name: StoreName) => Promise<number>;
  getDesktopState: () => Promise<unknown>;
  clearActiveWorkspace: () => Promise<unknown>;
  getDesktopConfig: (cwd?: string) => Promise<unknown>;
  touchWorkspace: (cwd: string) => Promise<unknown>;
  removeWorkspace: (workspaceId: string) => Promise<unknown>;
  recordSession: (session: Record<string, unknown>, title?: string) => Promise<unknown>;
  deleteSession: (sessionId: string) => Promise<unknown>;
  renameSession: (sessionId: string, title: string) => Promise<unknown>;
  setSessionFlags: (sessionId: string, flags: { pinned?: boolean; archived?: boolean }) => Promise<unknown>;
  setProjectOrder: (orderedIds: string[]) => Promise<unknown>;
  setSessionOrder: (sessionId: string, orderTs: string | null) => Promise<unknown>;
  listWorkspace: (cwd?: string) => Promise<unknown>;
  listWorkspaceDir: (cwd: string | undefined, relDir: string) => Promise<unknown>;
  readWorkspaceFile: (cwd: string | undefined, filePath: string) => Promise<unknown>;
  writeWorkspaceFile: (cwd: string | undefined, filePath: string, content: string) => Promise<unknown>;
  readSubagentActivity: (cwd: string | undefined, taskId: string) => Promise<unknown>;
  listNotes: (cwd?: string, scope?: "workspace" | "global") => Promise<unknown>;
  readNote: (cwd: string | undefined, noteId: string, scope?: "workspace" | "global") => Promise<unknown>;
  getNotesDir: (cwd: string | undefined, scope?: "workspace" | "global") => Promise<string>;
  openNotesFolder: (cwd: string | undefined, scope?: "workspace" | "global") => Promise<void>;
  getContextHistory: (sessionId: string, taskId?: string) => Promise<ContextHistory>;
  getContextRequest: (sessionId: string, requestId: string, taskId?: string) => Promise<ContextRequestDetail | null>;
  listGitChanges: (cwd?: string) => Promise<unknown>;
  getGitDiff: (cwd: string | undefined, filePath: string, mode?: "unified" | "split") => Promise<unknown>;
  openDirectoryPicker: (opts?: Record<string, unknown>) => Promise<string | null>;
  openFilePicker: (opts?: Record<string, unknown>) => Promise<string[] | null>;
  saveFilePicker: (opts?: Record<string, unknown>) => Promise<string | null>;
  openLink: (url: string) => void;
  openPath: (path: string, app?: string) => Promise<unknown>;
  openShellIn: (cwd: string, shell?: string) => Promise<unknown>;
  revealInFolder: (path: string) => Promise<unknown>;
  clipboardWrite: (text: string) => Promise<unknown>;
  createWorkspaceEntry: (cwd: string | undefined, relPath: string, type: "file" | "directory") => Promise<unknown>;
  listAgentProfiles: () => Promise<unknown>;
  listKnownModels: () => Promise<unknown>;
  readRulesFile: (cwd: string | undefined, fileKey: string) => Promise<unknown>;
  writeRulesFile: (cwd: string | undefined, fileKey: string, content: string) => Promise<unknown>;
  readSelfEvolveDirective: () => Promise<unknown>;
  writeSelfEvolveDirective: (content: string) => Promise<unknown>;
  readEngineConfig: (cwd: string | undefined) => Promise<unknown>;
  writeEngineConfig: (
    cwd: string | undefined,
    scope: "workspace" | "global",
    config: Record<string, unknown>,
  ) => Promise<unknown>;
  readMcpConfig: (cwd: string | undefined) => Promise<unknown>;
  writeMcpConfig: (cwd: string | undefined, scope: "workspace" | "global", contents: string) => Promise<unknown>;
  addPermissionRule: (
    cwd: string | undefined,
    scope: "workspace" | "global",
    rule: Record<string, unknown>,
  ) => Promise<unknown>;
  listTools: () => Promise<unknown>;
  listSkills: (cwd: string | undefined) => Promise<unknown>;
  createSkill: (
    cwd: string | undefined,
    scope: "workspace" | "global",
    name: string,
    description: string,
  ) => Promise<unknown>;
  readCustomModels: (cwd: string | undefined) => Promise<unknown>;
  writeCustomModels: (cwd: string | undefined, scope: "workspace" | "global", models: unknown) => Promise<unknown>;
  readCustomAgents: () => Promise<unknown>;
  writeCustomAgents: (agents: unknown) => Promise<unknown>;
  fetchRemoteModels: (params: RemoteModelParams) => Promise<unknown>;
  modelsDevEnrich: (models: unknown) => Promise<unknown>;
  probeRemoteConnection: (params: RemoteModelParams) => Promise<unknown>;
  probeModel: (params: RemoteModelParams & { model: string }) => Promise<unknown>;
  listSubscriptions: () => Promise<unknown>;
  connectSubscription: (kind: "anthropic-oauth" | "openai-codex" | "kimi-oauth") => Promise<unknown>;
  importSubscription: (kind: "anthropic-oauth" | "openai-codex" | "kimi-oauth") => Promise<unknown>;
  subscriptionCliAvailable: (kind: "anthropic-oauth" | "openai-codex" | "kimi-oauth") => Promise<boolean>;
  disconnectSubscription: (id: string) => Promise<unknown>;
  updateSubscription: (
    id: string,
    patch: { label?: string; model?: string; contextTokens?: number },
  ) => Promise<unknown>;
  listSubscriptionModels: (id: string) => Promise<unknown>;
  subscriptionUsage: (id: string) => Promise<unknown>;
  listShells: () => Promise<unknown>;
  reloadRenderer: () => Promise<unknown>;
  readClipboardImage: () => Promise<unknown>;
  showNotification: (title: string, body?: string, options?: { silent?: boolean }) => void;
  windowMinimize: () => Promise<unknown>;
  windowToggleMaximize: () => Promise<unknown>;
  windowClose: () => Promise<unknown>;
  windowIsMaximized: () => Promise<boolean>;
  windowIsFullScreen: () => Promise<boolean>;
  openWorkspaceWindow: (target?: { tab?: string; detached?: boolean; sideChatDraft?: string }) => Promise<unknown>;
  openSettingsWindow: (panel?: string) => Promise<unknown>;
  toggleSessionSidebarWindow: () => Promise<unknown>;
  hideSessionSidebarWindow: () => Promise<unknown>;
  getSessionSidebarState: () => Promise<unknown>;
  openSessionInMain: (index: unknown) => Promise<unknown>;
  runCommandInMain: (commandId: string) => Promise<unknown>;
  openWorkspaceInMain: (cwd: string) => Promise<unknown>;
  openCommandPaletteInMain: (query?: string) => Promise<unknown>;
  openConversationSearchInMain: () => Promise<unknown>;
  useSkillInMain: (skill: unknown) => Promise<unknown>;
  setActiveSession: (
    session: string | null | { sessionId: string | null; draft?: boolean; cwd?: string },
  ) => Promise<unknown>;
  getWindowCount: () => Promise<number>;
  getWindowFocused: () => Promise<boolean>;
  setWindowFocus: () => Promise<unknown>;
  showWindow: () => Promise<unknown>;
  relaunch: () => void;
  getZoomFactor: () => Promise<number>;
  setZoomFactor: (factor: number) => Promise<unknown>;
  setTitlebar: (theme: Record<string, unknown>) => Promise<unknown>;
  loadingWindowComplete: () => void;
  runUpdater: (alertOnFail: boolean) => Promise<unknown>;
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>;
  downloadUpdate: () => Promise<unknown>;
  installUpdate: () => Promise<unknown>;
  getUpdateInfo: () => Promise<UpdateInfo>;
  setBackgroundColor: (color: string) => Promise<unknown>;
  popupMenu: (key: string, x?: number, y?: number, payload?: unknown) => void;
  conversationMenuAction: (action: string) => void;
  conversationMenuReady: (revision?: number) => void;
  closeConversationMenu: () => void;
  terminalCreate: (payload: {
    id: string;
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }) => Promise<unknown>;
  terminalWrite: (id: string, data: string) => void;
  terminalResize: (id: string, cols: number, rows: number) => void;
  terminalDispose: (id: string) => void;
  terminalDisposeWindow: () => void;
  events: {
    on: (event: string, handler: EventHandler) => UnsubscribeFn;
  };
}

declare global {
  interface Window {
    reinaDesktop: ReinaDesktopBridge;
  }
}

export function bridge(): ReinaDesktopBridge {
  let api = window.reinaDesktop;
  // The inline Workspace is the same local workspace.html renderer hosted in a
  // same-origin iframe. Electron intentionally does not run the privileged
  // preload in subframes, so reuse the parent frame's narrow contextBridge API
  // instead of enabling nodeIntegrationInSubFrames for every future iframe.
  if (!api && window.parent !== window) {
    try {
      api = window.parent.reinaDesktop;
    } catch {
      // Cross-origin frames cannot inspect their parent. Reina only embeds the
      // packaged local workspace page, but keep the normal missing-bridge error.
    }
  }
  if (!api) throw new Error("reinaDesktop bridge missing — preload not loaded?");
  return api;
}
