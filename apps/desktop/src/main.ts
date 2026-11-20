import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, Tray } from "electron";
import { AgentHostController, sendRendererEvent } from "./main/agent-host-controller.js";
import { pruneMissingSessions, setActiveSession } from "./main/desktop-state.js";
import { disposeAllTerminalsForWindow } from "./main/terminal.js";
import { handleHostRequest } from "./main/host-handlers.js";
import { clearAllWakeups, rehydrateWakeups } from "./main/wakeup-scheduler.js";
import { registerIpc } from "./main/ipc.js";
import { initAutoUpdate } from "./main/auto-update.js";
import { startConfigWatcher, type ConfigWatcher } from "./main/config-watcher.js";
import { createLogger } from "./main/logging.js";
import { readStoreValue, writeStoreValue } from "./main/store.js";
import {
  createMainWindow,
  createMenu,
  createSessionSidebarWindow,
  createSettingsWindow,
  createWorkspaceWindow,
  sendMenuCommand,
  windowIconPath,
} from "./main/windows.js";

app.setName("Reina");

let mainWindow: BrowserWindow | null = null;
let sessionSidebarWindow: BrowserWindow | null = null;
let workspaceWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let host: AgentHostController;
let configWatcher: ConfigWatcher | null = null;
let tray: Tray | null = null;
// Close-to-tray: window close hides instead of quitting until a real quit
// (tray menu / app.quit) flips this in before-quit.
let quitting = false;
let syncingSessionSidebarBounds = false;
let sessionSidebarSnapped = true;
let sessionSidebarSnapTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSidebarSyncTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSidebarAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSidebarVisibilityTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSidebarVisible = false;
let suppressSessionSidebarHideEvent = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const hostCwd = app.isPackaged ? process.resourcesPath : repoRoot;
const defaultCwd = app.isPackaged ? app.getPath("userData") : repoRoot;
const preloadPath = path.join(__dirname, "preload.cjs");

// Renderer root. The React renderer (Vite build under
// dist/apps/desktop/renderer-react) is a full port of every window — chat,
// settings, workspace. The legacy plain-JS renderer has been removed, so this
// is the only renderer now.
const rendererRoot = app.isPackaged
  ? path.join(__dirname, "renderer-react")
  : path.resolve(repoRoot, "dist/apps/desktop/renderer-react");
const auxRendererRoot = rendererRoot;
const log = createLogger(defaultCwd);
const pendingDeepLinks: string[] = [];
let sessionSidebarWidth = 260;
const sessionSidebarMinWidth = 232;
const sessionSidebarMaxWidth = 560;
const sidebarGap = 8;
const sidebarSnapDistance = 72;
const sidebarSnapAnimationMs = 160;
const sidebarVisibilityAnimationMs = 180;
const sidebarRevealOffset = 18;
const sidebarSnapAnimationFrameMs = 16;

type SessionSidebarMode = "floating" | "inline";
type SessionSidebarState = {
  visible: boolean;
  mode: SessionSidebarMode;
};

// User preference (view-settings: sidebarPlacement). "inline" docks the session
// sidebar inside the main window; "floating" pops it out as a snapped side
// window when the main window isn't maximized. Cached here — not read from disk
// per call — because mainWindowUsesInlineSidebar() runs on every window
// move/resize. Initialized from the store at startup; default "inline".
let sidebarPlacement: SessionSidebarMode = "inline";

log(`Desktop main loaded. repoRoot=${repoRoot} hostCwd=${hostCwd} defaultCwd=${defaultCwd}`);

process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${error.stack ?? error.message}`);
});

process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

// Close-to-tray prompt (Windows/Linux). Async because only the async
// dialog.showMessageBox returns the "remember" checkbox — the *Sync variant
// gives back a button index only. The window's close is already prevented, so
// it stays open until the user picks. Persists the choice when the box is
// checked, which is what the General panel's "closeAction" dropdown reads back.
async function promptCloseAction(win: BrowserWindow): Promise<"tray" | "quit" | "cancel"> {
  const lang = readStoreValue("view-settings", "language") ?? app.getLocale();
  const zh = lang.toLowerCase().startsWith("zh");
  const t = zh
    ? {
        title: "关闭 Reina",
        message: "关闭窗口时要怎么做？",
        detail: "最小化到托盘后，后台任务会继续运行。",
        buttons: ["最小化到托盘", "退出", "取消"],
        remember: "记住我的选择",
      }
    : {
        title: "Close Reina",
        message: "What should closing the window do?",
        detail: "Background tasks keep running when minimized to the tray.",
        buttons: ["Minimize to tray", "Quit", "Cancel"],
        remember: "Remember my choice",
      };
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: t.buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: t.title,
    message: t.message,
    detail: t.detail,
    checkboxLabel: t.remember,
    checkboxChecked: false,
  });
  const choice = response === 1 ? "quit" : response === 2 ? "cancel" : "tray";
  if (checkboxChecked && choice !== "cancel") {
    writeStoreValue("view-settings", "closeAction", choice);
  }
  return choice;
}

function createWindow(): BrowserWindow {
  const win = createMainWindow({
    repoRoot,
    rendererRoot,
    preloadPath,
    log,
    onMenuCommand: (id) => sendMenuCommand(win, id),
  });
  mainWindow = win;
  win.on("move", syncSessionSidebarBounds);
  win.on("resize", syncSessionSidebarBounds);
  win.on("maximize", applySessionSidebarPlacement);
  win.on("unmaximize", applySessionSidebarPlacement);
  win.on("enter-full-screen", applySessionSidebarPlacement);
  win.on("leave-full-screen", applySessionSidebarPlacement);
  win.on("minimize", () => hideExternalSessionSidebar(true));
  win.on("restore", () => {
    if (sessionSidebarVisible) applySessionSidebarPlacement();
  });
  // Keep the floating sidebar grouped with the main window: clicking the main
  // window raises the sidebar back on top of it so they travel as one stack.
  win.on("focus", syncSessionWindowZOrder);
  // Close-to-tray (Windows/Linux): the X button's behaviour is user-configurable
  // via view-settings.closeAction (General panel). Default "ask" pops a dialog;
  // "tray" hides so the agent-host and any running turns keep going in the
  // background; "quit" exits cleanly. macOS keeps the app alive in the dock.
  win.on("close", (event) => {
    if (quitting || process.platform === "darwin") return;
    event.preventDefault();
    const hideToTray = () => {
      hideExternalSessionSidebar(true);
      win.hide();
    };
    const action = readStoreValue("view-settings", "closeAction");
    if (action === "quit") {
      app.quit();
    } else if (action === "tray") {
      hideToTray();
    } else {
      // "ask" (or unset): let the user choose; remember when the box is checked.
      void promptCloseAction(win).then((choice) => {
        if (choice === "quit") app.quit();
        else if (choice === "tray") hideToTray();
        // "cancel": window stays open (close already prevented).
      });
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // The main window is the app: when it closes, tear down every auxiliary
    // window (floating sidebar, workspace switcher, settings) so none are left
    // orphaned without a chat/engine to talk to.
    for (const aux of [sessionSidebarWindow, workspaceWindow, settingsWindow]) {
      if (aux && !aux.isDestroyed()) aux.close();
    }
    sessionSidebarWindow = null;
    workspaceWindow = null;
    settingsWindow = null;
  });
  return win;
}

function mainWindowUsesInlineSidebar(): boolean {
  // User opted to keep the sidebar docked inside the main window.
  if (sidebarPlacement === "inline") return true;
  // "floating" still falls back to inline when maximized/fullscreen, where a
  // snapped side window would land off-screen.
  return Boolean(mainWindow && !mainWindow.isDestroyed() && (mainWindow.isMaximized() || mainWindow.isFullScreen()));
}

// Switch placement live from a settings change: re-apply so the sidebar moves
// between docked (inline) and snapped (floating) without a relaunch.
function setSidebarPlacement(mode: SessionSidebarMode): void {
  if (sidebarPlacement === mode) return;
  sidebarPlacement = mode;
  applySessionSidebarPlacement();
}

function sendSessionSidebarState(state: SessionSidebarState): SessionSidebarState {
  mainWindow?.webContents.send("reina:event:session-sidebar-state", state);
  return state;
}

function sendActiveSessionState(input: unknown): boolean {
  let payload: { sessionId: string | null; draft?: boolean; cwd?: string };
  if (input && typeof input === "object") {
    const candidate = input as { sessionId?: unknown; draft?: unknown; cwd?: unknown };
    const sessionId = candidate.sessionId ?? null;
    if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) return false;
    payload = { sessionId };
    if (candidate.draft === true) payload.draft = true;
    if (typeof candidate.cwd === "string" && candidate.cwd) payload.cwd = candidate.cwd;
  } else {
    if (input !== null && (typeof input !== "string" || !input)) return false;
    payload = { sessionId: input };
  }
  sessionSidebarWindow?.webContents.send("reina:event:active-session", payload);
  // Also notify the Workspace window so its DAG / Agent Team / Conversation /
  // Notes tabs re-bind to the foreground session instead of following whichever
  // (possibly background) session emitted the last engine event.
  workspaceWindow?.webContents.send("reina:event:active-session", payload);
  // Persist the viewed session so the next launch reopens it. Previously this
  // only broadcast to the sidebar, so activeSessionId on disk only ever tracked
  // the last session a message was *recorded* in (recordSession) — viewing a
  // session without chatting was lost on exit. A draft (sessionId null) clears
  // the pointer so the app reopens to a fresh draft.
  try {
    setActiveSession(payload.sessionId);
  } catch (error) {
    log(`setActiveSession persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

function clampSessionSidebarWidth(width: number): number {
  return Math.round(Math.min(sessionSidebarMaxWidth, Math.max(sessionSidebarMinWidth, width)));
}

function sessionSidebarBounds(width = sessionSidebarWidth): Electron.Rectangle {
  const owner = mainWindow?.getBounds() ?? { x: 80, y: 80, width: 1200, height: 820 };
  const display = screen.getDisplayMatching(owner);
  const minX = display.workArea.x;
  const nextWidth = clampSessionSidebarWidth(width);
  return {
    x: Math.max(minX, owner.x - nextWidth - sidebarGap),
    y: owner.y,
    width: nextWidth,
    height: owner.height,
  };
}

function syncSessionSidebarBounds(options: { animate?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!sessionSidebarWindow || sessionSidebarWindow.isDestroyed()) return;
  if (!sessionSidebarSnapped) return;
  if (mainWindowUsesInlineSidebar()) return;
  const animate = options.animate === true;
  const win = sessionSidebarWindow;
  const target = sessionSidebarBounds();
  syncingSessionSidebarBounds = true;
  if (sessionSidebarSyncTimer) clearTimeout(sessionSidebarSyncTimer);
  if (sessionSidebarAnimationTimer) {
    clearTimeout(sessionSidebarAnimationTimer);
    sessionSidebarAnimationTimer = null;
  }
  const finishSync = () => {
    sessionSidebarSyncTimer = setTimeout(() => {
      sessionSidebarSyncTimer = null;
      syncingSessionSidebarBounds = false;
    }, 180);
  };

  if (!animate) {
    win.setBounds(target, false);
    finishSync();
    return;
  }

  const start = win.getBounds();
  const startedAt = Date.now();
  const step = () => {
    if (win.isDestroyed() || sessionSidebarWindow !== win) {
      sessionSidebarAnimationTimer = null;
      syncingSessionSidebarBounds = false;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / sidebarSnapAnimationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased),
      width: Math.round(start.width + (target.width - start.width) * eased),
      height: Math.round(start.height + (target.height - start.height) * eased),
    }, false);
    if (progress < 1) {
      sessionSidebarAnimationTimer = setTimeout(step, sidebarSnapAnimationFrameMs);
      return;
    }
    sessionSidebarSyncTimer = null;
    sessionSidebarAnimationTimer = null;
    finishSync();
  };
  step();
}

function maybeSnapSessionSidebarWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!sessionSidebarWindow || sessionSidebarWindow.isDestroyed() || syncingSessionSidebarBounds) return;

  const bounds = sessionSidebarWindow.getBounds();
  const target = sessionSidebarBounds();
  const distance = Math.max(
    Math.abs(bounds.x - target.x),
    Math.abs(bounds.y - target.y),
  );
  sessionSidebarSnapped = distance <= sidebarSnapDistance;
  syncSessionSidebarBounds({ animate: distance > 1 });
}

function scheduleSessionSidebarSnapCheck(): void {
  if (syncingSessionSidebarBounds) return;
  if (sessionSidebarSnapTimer) clearTimeout(sessionSidebarSnapTimer);
  sessionSidebarSnapTimer = setTimeout(() => {
    sessionSidebarSnapTimer = null;
    maybeSnapSessionSidebarWindow();
  }, 90);
}

// Raise the main window and the floating sidebar together so they read as one
// z-ordered group — without this, showing/focusing the sidebar leaves the main
// window stranded behind whatever was on top. moveTop() reorders without
// stealing focus, so the caller decides who stays focused. No-op while the
// sidebar is hidden (incl. the maximized inline-overlay mode), and — by design —
// only when the sidebar is snapped to the main window: once the user drags it
// off to float freely, the two are independent and shouldn't drag each other up.
function syncSessionWindowZOrder(): void {
  if (!sessionSidebarSnapped) return;
  if (!sessionSidebarWindow || sessionSidebarWindow.isDestroyed() || !sessionSidebarWindow.isVisible()) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  mainWindow.moveTop();
  sessionSidebarWindow.moveTop();
}

function clearSessionSidebarVisibilityAnimation(): void {
  if (!sessionSidebarVisibilityTimer) return;
  clearTimeout(sessionSidebarVisibilityTimer);
  sessionSidebarVisibilityTimer = null;
}

function animateSessionSidebarVisibility(win: BrowserWindow, visible: boolean): void {
  clearSessionSidebarVisibilityAnimation();
  if (win.isDestroyed()) return;
  const end = sessionSidebarSnapped ? sessionSidebarBounds() : win.getBounds();
  const start = visible
    ? { ...end, x: end.x - sidebarRevealOffset }
    : win.getBounds();
  const deltaX = visible ? sidebarRevealOffset : -sidebarRevealOffset;
  const startedAt = Date.now();

  if (visible) {
    win.setBounds(start, false);
    win.setOpacity(0);
    win.show();
    win.focus();
    syncSessionWindowZOrder();
  }

  const step = () => {
    if (win.isDestroyed() || sessionSidebarWindow !== win) {
      sessionSidebarVisibilityTimer = null;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / sidebarVisibilityAnimationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    const x = Math.round(start.x + deltaX * eased);
    win.setBounds({ ...start, x }, false);
    win.setOpacity(visible ? eased : 1 - eased);
    if (progress < 1) {
      sessionSidebarVisibilityTimer = setTimeout(step, sidebarSnapAnimationFrameMs);
      return;
    }
    sessionSidebarVisibilityTimer = null;
    if (visible) {
      win.setBounds(end, false);
      win.setOpacity(1);
      return;
    }
    win.hide();
    win.setBounds(sessionSidebarSnapped ? sessionSidebarBounds() : start, false);
    win.setOpacity(1);
  };
  step();
}

function openSessionSidebarWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (sessionSidebarWindow && !sessionSidebarWindow.isDestroyed()) {
    syncSessionSidebarBounds();
    animateSessionSidebarVisibility(sessionSidebarWindow, true);
    return sessionSidebarWindow;
  }
  const bounds = sessionSidebarBounds();
  sessionSidebarSnapped = true;
  const win = createSessionSidebarWindow({
    repoRoot,
    rendererRoot,
    preloadPath,
    log,
    minWidth: sessionSidebarMinWidth,
    maxWidth: sessionSidebarMaxWidth,
    ...bounds,
    onMenuCommand: (id) => sendMenuCommand(win, id),
  });
  sessionSidebarWindow = win;
  win.once("ready-to-show", () => {
    animateSessionSidebarVisibility(win, true);
  });
  win.on("closed", () => {
    if (sessionSidebarWindow === win) sessionSidebarWindow = null;
    sessionSidebarVisible = false;
    sendSessionSidebarState({ visible: false, mode: "floating" });
  });
  win.on("hide", () => {
    if (suppressSessionSidebarHideEvent) return;
    sessionSidebarVisible = false;
    sendSessionSidebarState({ visible: false, mode: "floating" });
  });
  win.on("show", () => {
    if (mainWindowUsesInlineSidebar()) {
      hideExternalSessionSidebar(true);
      if (sessionSidebarVisible) sendSessionSidebarState({ visible: true, mode: "inline" });
      return;
    }
    sessionSidebarVisible = true;
    sendSessionSidebarState({ visible: true, mode: "floating" });
    syncSessionWindowZOrder();
  });
  // Clicking the sidebar raises the main window back up directly beneath it.
  win.on("focus", syncSessionWindowZOrder);
  win.on("resize", () => {
    if (win.isDestroyed() || syncingSessionSidebarBounds) return;
    sessionSidebarWidth = clampSessionSidebarWidth(win.getBounds().width);
    scheduleSessionSidebarSnapCheck();
  });
  win.on("move", scheduleSessionSidebarSnapCheck);
  return win;
}

function hideExternalSessionSidebar(silent = false): void {
  if (!sessionSidebarWindow || sessionSidebarWindow.isDestroyed() || !sessionSidebarWindow.isVisible()) return;
  suppressSessionSidebarHideEvent = silent;
  animateSessionSidebarVisibility(sessionSidebarWindow, false);
  setTimeout(() => {
    suppressSessionSidebarHideEvent = false;
  }, sidebarVisibilityAnimationMs + sidebarSnapAnimationFrameMs);
}

function showInlineSessionSidebar(): SessionSidebarState {
  sessionSidebarVisible = true;
  hideExternalSessionSidebar(true);
  return sendSessionSidebarState({ visible: true, mode: "inline" });
}

function showFloatingSessionSidebar(): SessionSidebarState {
  sessionSidebarVisible = true;
  openSessionSidebarWindow();
  return sendSessionSidebarState({ visible: true, mode: "floating" });
}

function applySessionSidebarPlacement(): SessionSidebarState {
  if (!sessionSidebarVisible) {
    return sendSessionSidebarState({
      visible: false,
      mode: mainWindowUsesInlineSidebar() ? "inline" : "floating",
    });
  }
  return mainWindowUsesInlineSidebar()
    ? showInlineSessionSidebar()
    : showFloatingSessionSidebar();
}

// Persist the sidebar open/closed preference so the next launch restores it.
// Only the explicit toggle (the title-bar rail button — the user's real control
// for showing/hiding) writes here; the narrow-viewport auto-hide goes through
// hideSessionSidebarWindow and deliberately does NOT persist, so a transient
// width-driven collapse can't overwrite the user's choice.
function persistSessionSidebarVisible(visible: boolean): void {
  try {
    writeStoreValue("view-settings", "sidebarVisible", String(visible));
  } catch (error) {
    log(`persist sidebarVisible failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Restore the sidebar to its last-exit state. Pulled by the main renderer on
// mount (a push right after createWindow races the renderer's event listener —
// see the fresh-window subscription race) so the inline pane / floating window
// reappears without a manual toggle.
function getSessionSidebarState(): SessionSidebarState {
  return applySessionSidebarPlacement();
}

function toggleSessionSidebarWindow(): SessionSidebarState {
  if (sessionSidebarVisible) {
    sessionSidebarVisible = false;
    persistSessionSidebarVisible(false);
    hideExternalSessionSidebar(true);
    return sendSessionSidebarState({
      visible: false,
      mode: mainWindowUsesInlineSidebar() ? "inline" : "floating",
    });
  }
  sessionSidebarVisible = true;
  persistSessionSidebarVisible(true);
  return applySessionSidebarPlacement();
}

function hideSessionSidebarWindow(): SessionSidebarState {
  sessionSidebarVisible = false;
  hideExternalSessionSidebar(true);
  return sendSessionSidebarState({
    visible: false,
    mode: mainWindowUsesInlineSidebar() ? "inline" : "floating",
  });
}

function openSessionInMain(index: unknown): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:open-session", index);
  return true;
}

function runCommandInMain(commandId: unknown): boolean {
  if (typeof commandId !== "string" || !commandId) return false;
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:menu-command", commandId);
  return true;
}

// Drive the main window to load a workspace. The floating sidebar switches
// workspaces locally, but the chat/engine — and therefore "New Agent" — lives
// in the main window, so without this the main window keeps its stale cwd and
// new sessions land in the wrong project.
function openWorkspaceInMain(cwd: unknown): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:open-workspace", cwd);
  // Also forward to the workspace window (if open). Its Git / Files / Notes /
  // Terminal tabs are cwd-derived and listen for exactly this event to re-point;
  // without the forward they stay stuck on the old workspace (the handler there
  // is otherwise dead code). Mirrors the active-session forward above.
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.webContents.send("reina:event:open-workspace", cwd);
  }
  // Re-point the workspace-scoped config watch at the newly active workspace so
  // its .reina/{models,agents}.json + skills/ edits propagate too.
  configWatcher?.setWorkspace(cwd);
  return true;
}

function openCommandPaletteInMain(query: unknown): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:open-command-palette", {
    query: typeof query === "string" ? query : "",
  });
  return true;
}

// Conversation search overlay lives in the main window (it loads sessions into
// the chat surface); the floating sidebar's Search button routes here.
function openConversationSearchInMain(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:open-conversation-search", {});
  return true;
}

// Attach a skill chosen in the (separate) Settings window to the main chat
// composer. The Settings window has no composer of its own and runs in a
// different renderer, so it can't mount the pending-skill locally — route it to
// the main window, which owns the composer + pendingSkills state.
function useSkillInMain(skill: unknown): boolean {
  if (!skill || typeof skill !== "object") return false;
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("reina:event:use-skill", skill);
  return true;
}

function openWorkspaceWindow(target?: { tab?: string; detached?: boolean; sideChatDraft?: string }): BrowserWindow {
  const tab = typeof target?.tab === "string" ? target.tab : undefined;
  const sideChatDraft = typeof target?.sideChatDraft === "string" ? target.sideChatDraft : undefined;
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.show();
    workspaceWindow.focus();
    // Window already up: the renderer is subscribed, so hand it the tab live.
    if (tab) workspaceWindow.webContents.send("reina:event:focus-workspace-tab", { tab });
    if (sideChatDraft) workspaceWindow.webContents.send("reina:event:side-chat-draft", { draft: sideChatDraft });
    return workspaceWindow;
  }
  // Fresh window: the live event would race the renderer's subscription, so
  // seed the initial tab via the load query (same pattern as Settings' panel).
  const win = createWorkspaceWindow(
    {
      repoRoot,
      rendererRoot: auxRendererRoot,
      preloadPath,
      log,
      onMenuCommand: (id) => sendMenuCommand(win, id),
    },
    { tab, sideChatDraft },
  );
  workspaceWindow = win;
  // Capture the id now: after "closed" the native window is gone and `win.id`
  // throws. node-pty children spawned for this window's Terminal tab are owned
  // by the main process, so the renderer's React-unmount cleanup does NOT run on
  // a title-bar / OS close — without this main-side net they survive until app
  // exit and every reopen leaks another.
  const workspaceWindowId = win.id;
  win.on("closed", () => {
    if (workspaceWindow === win) workspaceWindow = null;
    disposeAllTerminalsForWindow(workspaceWindowId);
  });
  return win;
}

/** Open Workspace in the user's preferred surface, with an explicit `detached`
 * action still able to open a separate window regardless of the default. */
function openWorkspaceSurface(target?: { tab?: string; detached?: boolean; sideChatDraft?: string }): BrowserWindow {
  if (target?.detached || readStoreValue("view-settings", "workspacePlacement") === "floating") {
    return openWorkspaceWindow(target);
  }

  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();

  const payload = typeof target?.tab === "string" ? { tab: target.tab } : {};
  const send = () => mainWindow?.webContents.send("reina:event:open-inline-workspace", payload);
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once("did-finish-load", send);
  else send();
  return mainWindow;
}

function openSettingsWindow(panel?: string): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (panel) settingsWindow.webContents.send("reina:event:open-settings-panel", panel);
    return settingsWindow;
  }
  const win = createSettingsWindow({
    repoRoot,
    rendererRoot: auxRendererRoot,
    preloadPath,
    log,
    onMenuCommand: (id) => sendMenuCommand(win, id),
  }, panel);
  settingsWindow = win;
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  return win;
}

function showMainWindowFromTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // win.show() fires no "restore" event, so bring the floating sidebar back
  // ourselves (mirrors the minimize/restore pair on the main window).
  if (sessionSidebarVisible) applySessionSidebarPlacement();
}

function createTray(): void {
  const iconPath = windowIconPath(repoRoot);
  // macOS: no tray — the dock already keeps the app alive after close.
  if (!iconPath) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Reina");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Reina", click: showMainWindowFromTray },
      { type: "separator" },
      { label: "Quit Reina", click: () => app.quit() },
    ]),
  );
  tray.on("click", showMainWindowFromTray);
  tray.on("double-click", showMainWindowFromTray);
}

function emitDeepLinks(urls: string[]): void {
  if (urls.length === 0) return;
  pendingDeepLinks.push(...urls);
  sendRendererEvent("deep-link", urls);
}

async function shutdown(): Promise<void> {
  // Cancel any pending wakeup timers so they don't fire after the host is
  // gone. The agent has already received the wakeup's confirmation event;
  // we just stop the scheduled side effect.
  clearAllWakeups();
  configWatcher?.dispose();
  configWatcher = null;
  await host.shutdown();
}

function disablePackagedDebugSwitches(): void {
  if (!app.isPackaged) return;
  for (const name of [
    "remote-debugging-port",
    "remote-debugging-address",
    "remote-allow-origins",
    "inspect",
    "inspect-brk",
    "auto-open-devtools-for-tabs",
  ]) {
    app.commandLine.removeSwitch(name);
  }
}

async function main(): Promise<void> {
  disablePackagedDebugSwitches();
  app.setAppUserModelId("app.reina.desktop");

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  host = new AgentHostController({
    repoRoot,
    hostCwd,
    defaultCwd,
    log,
    onHostRequest: (kind, params, sessionId) =>
      handleHostRequest(kind, params, sessionId, {
        log,
        // Routes the wakeup's eventual send_message back into the host so it
        // reaches the same engine that scheduled it.
        sendHostRequest: (request) => host.send(request),
      }),
  });

  app.on("second-instance", (_event, argv) => {
    const urls = argv.filter((arg) => arg.startsWith("reina://"));
    emitDeepLinks(urls);
    showMainWindowFromTray();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    emitDeepLinks([url]);
  });

  app.on("before-quit", (event) => {
    // Flip before the windows receive "close" so the close-to-tray intercept
    // lets them actually close during quit.
    quitting = true;
    tray?.destroy();
    tray = null;
    if (!host.isRunning) return;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  await app.whenReady();
  log("Electron app ready.");
  app.setAsDefaultProtocolClient("reina");
  createTray();

  // Before the renderer asks for the session list, drop any indexed
  // sessions whose on-disk files have vanished (typically: the user
  // deleted .reina/ out-of-band). Without this the sidebar shows
  // ghost rows that error out on click. Best-effort: stat failures
  // shouldn't block startup, so we never throw out of here.
  try {
    const { removed } = await pruneMissingSessions();
    if (removed.length > 0) {
      log(`Pruned ${removed.length} stale session(s) with no on-disk data: ${removed.join(", ")}`);
    }
  } catch (error) {
    log(`pruneMissingSessions failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }

  const storedSidebarPlacement = readStoreValue("view-settings", "sidebarPlacement");
  if (storedSidebarPlacement === "inline" || storedSidebarPlacement === "floating") {
    sidebarPlacement = storedSidebarPlacement;
  }
  // Restore the sidebar open/closed preference; the renderer pulls the concrete
  // placement via getSessionSidebarState once it has mounted.
  sessionSidebarVisible = readStoreValue("view-settings", "sidebarVisible") === "true";

  registerIpc({
    repoRoot,
    defaultCwd,
    hostStatus: () => ({ running: host.isRunning, ready: host.isReady }),
    awaitInitialization: () => host.awaitInitialization(),
    shutdownHost: () => host.shutdown(),
    sendHostRequest: (request) => host.send(request),
    consumeDeepLinks: () => pendingDeepLinks.splice(0),
    openWorkspaceWindow: openWorkspaceSurface,
    openSettingsWindow,
    toggleSessionSidebarWindow,
    hideSessionSidebarWindow,
    getSessionSidebarState,
    openSessionInMain,
    runCommandInMain,
    openWorkspaceInMain,
    openCommandPaletteInMain,
    openConversationSearchInMain,
    useSkillInMain,
    setActiveSession: sendActiveSessionState,
    onViewSettingChanged: (key, value) => {
      if (key === "sidebarPlacement") setSidebarPlacement(value === "floating" ? "floating" : "inline");
    },
  });

  // Watch global ($REINA_HOME) + the active workspace's .reina config so any
  // change — in-app write, hand-edit, PowerShell, git pull — re-broadcasts the
  // matching domain event to every window. Makes the per-IPC broadcasts a fast
  // path rather than the only path, so windows can't drift stale (the root fix
  // for "configure a model in Settings, then restart before chat sees it").
  const configHome = process.env.REINA_CONFIG_HOME
    ? path.resolve(process.env.REINA_CONFIG_HOME)
    : path.join(os.homedir(), ".reina");
  configWatcher = startConfigWatcher({
    configHome,
    initialWorkspaceCwd: defaultCwd,
    broadcast: sendRendererEvent,
  });

  host.start();
  // Re-arm any wakeups that were pending when the app last exited so they fire
  // even across crashes / reboots / clean shutdowns. Fire-and-forget — disk I/O
  // failure is logged, not fatal.
  void rehydrateWakeups({
    log,
    sendHostRequest: (request) => host.send(request),
  }).catch((error) => {
    log(`rehydrateWakeups failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  });
  createMenu((id) => {
    if (mainWindow) sendMenuCommand(mainWindow, id);
  }, createWindow);
  createWindow();

  // Start background update checks (Windows distribution builds only; a no-op
  // otherwise). Fire-and-forget — never let the updater block startup.
  initAutoUpdate(log);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

void main();
