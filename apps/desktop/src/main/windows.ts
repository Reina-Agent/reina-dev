import path from "node:path";
import { app, BrowserWindow, Menu, screen, shell } from "electron";
import type { WebContentsConsoleMessageEventParams } from "electron";
import type { LogFn } from "./types.js";
import { readStore, readStoreValue, writeStore } from "./store.js";

type CreateWindowInput = {
  repoRoot: string;
  rendererRoot: string;
  preloadPath: string;
  log: LogFn;
  onMenuCommand: (id: string) => void;
};

type CreateSidebarWindowInput = CreateWindowInput & {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  maxWidth: number;
};

type RendererAssets = Pick<CreateWindowInput, "rendererRoot" | "preloadPath" | "log">;

const rendererAssetsByWindow = new WeakMap<BrowserWindow, RendererAssets>();
type ConversationMenu = {
  popup: BrowserWindow;
  rendererReady: boolean;
  readyToShow: boolean;
  requested: boolean;
  revision: number;
  renderedRevision: number;
  payload?: ConversationMenuPayload;
};
const conversationMenus = new Map<number, ConversationMenu>();

const isPackaged = app.isPackaged;
let backgroundColor = "#101010";
const mainWindowDefaultWidth = 1440;
const mainWindowDefaultHeight = 820;
const mainWindowMinWidth = 560;
const mainWindowMinHeight = 600;
// The inline Workspace shares the main window with Sessions + Chat. Keep a
// sensible screen-edge margin, but do not cap wide displays at the old
// chat-only 1280px ceiling.
const mainWindowMaxRestoredWidth = 1920;
const mainWindowScreenPadding = 48;

export function windowIconPath(repoRoot: string): string | undefined {
  if (process.platform === "darwin") return undefined;
  return path.resolve(repoRoot, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
}

export function setBackgroundColor(color: string): void {
  backgroundColor = color;
}

// Renderer console forwarding. Electron 36+ delivers `console-message` as a
// single event object whose `level` is a string ('debug' | 'info' | 'warning' |
// 'error'); CONSOLE_LEVEL_ORDINAL maps it back to the 0–3 ordinal we threshold
// on. Default to forwarding only warnings + errors — every renderer
// `console.log`/`debug` across all four windows otherwise floods the desktop
// log, which is the dominant source of log noise.
// `REINA_DESKTOP_LOG_LEVEL=verbose|info|warn|error` lowers the threshold.
const CONSOLE_LEVEL_ORDINAL: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

const consoleLogThreshold = ((): number => {
  const levels: Record<string, number> = { verbose: 0, debug: 0, info: 1, log: 1, warn: 2, warning: 2, error: 3 };
  return levels[(process.env.REINA_DESKTOP_LOG_LEVEL ?? "").toLowerCase()] ?? 2;
})();

function forwardRendererConsole(log: LogFn, label: string, event: WebContentsConsoleMessageEventParams): void {
  const level = CONSOLE_LEVEL_ORDINAL[event.level] ?? 1;
  if (level < consoleLogThreshold) return;
  log(`${label} console level=${level} ${event.sourceId}:${event.lineNumber} ${event.message}`);
}

// ── Frosted glass (毛玻璃) ──────────────────────────────────────────────
// When the view-settings `glass` flag is on, windows use the OS-native frosted
// material so the blurred desktop shows through behind a translucent renderer
// (see styles/glass.css): Windows 11 *acrylic*, macOS *vibrancy*. Same CSS,
// same toggle — the only platform-specific part is which native API we call.
// The window's backgroundColor must carry alpha for the material to show, so we
// paint it fully transparent and let the page paint its own translucent fills.
// Linux has no equivalent material, so native glass stays off there.
const GLASS_BG = "#00000000";
// "hud" gives macOS glass a darker, Raycast-like material. "under-window"
// sampled the wallpaper too strongly and made the whole app read as grey fog.
const MAC_VIBRANCY = "hud" as const;

// macOS keeps its native traffic lights with titleBarStyle:"hidden"; nudge them
// to sit vertically centered in our 36px topbar (--topbar-height): the 12px
// button cluster centers at y = (36-12)/2 = 12. Spread into each window
// constructor; no-op off macOS.
const macTrafficLights: { trafficLightPosition?: { x: number; y: number } } =
  process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 12 } } : {};

// macOS hides the native traffic lights in fullscreen, so the topbar's left-edge
// reserve (see body[data-fullscreen] rules in topbar.css / TitleBar) must be
// collapsed there. Broadcast enter/leave so every renderer can react. no-op off
// macOS (Win/Linux draw their own controls, unaffected by fullscreen).
function broadcastFullScreen(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  win.on("enter-full-screen", () => win.webContents.send("reina:event:window-state", { fullscreen: true }));
  win.on("leave-full-screen", () => win.webContents.send("reina:event:window-state", { fullscreen: false }));
}

function glassPlatformSupported(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

function hardenPackagedWindow(win: BrowserWindow): void {
  if (!isPackaged) return;
  win.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const shortcut =
      key === "f12" ||
      ((input.control || input.meta) && key === "r") ||
      ((input.control || input.meta) && input.shift && ["i", "j", "c"].includes(key));
    if (shortcut) event.preventDefault();
  });
}

export function isGlassEnabled(): boolean {
  return glassPlatformSupported() && readStoreValue("view-settings", "glass") === "true";
}

// Spread into a BrowserWindow constructor to apply the current glass state.
function glassWindowOptions(): {
  backgroundColor: string;
  backgroundMaterial?: "acrylic";
  vibrancy?: typeof MAC_VIBRANCY;
  visualEffectState?: "active";
} {
  if (!isGlassEnabled()) return { backgroundColor };
  return process.platform === "darwin"
    ? { backgroundColor: GLASS_BG, vibrancy: MAC_VIBRANCY, visualEffectState: "active" }
    : { backgroundColor: GLASS_BG, backgroundMaterial: "acrylic" };
}

// Toggle the native glass material on every open window without recreating
// them. Called from the IPC layer when the `glass` flag changes.
export function applyGlassToAllWindows(enabled: boolean): void {
  const on = enabled && glassPlatformSupported();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || getConversationMenu(win)) continue;
    win.setBackgroundColor(on ? GLASS_BG : backgroundColor);
    try {
      if (process.platform === "darwin") {
        win.setVibrancy(on ? MAC_VIBRANCY : null);
      } else if (process.platform === "win32") {
        win.setBackgroundMaterial(on ? "acrylic" : "none");
      }
    } catch {
      // setBackgroundMaterial throws on Windows builds < 11; ignore.
    }
  }
}

export function createMainWindow(input: CreateWindowInput): BrowserWindow {
  const state = normalizeMainWindowState(readWindowState());
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: mainWindowMinWidth,
    minHeight: mainWindowMinHeight,
    title: "Reina",
    show: false,
    icon: windowIconPath(input.repoRoot),
    ...glassWindowOptions(),
    titleBarStyle: "hidden",
    ...macTrafficLights,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isPackaged,
    },
  });
  rendererAssetsByWindow.set(win, {
    rendererRoot: input.rendererRoot,
    preloadPath: input.preloadPath,
    log: input.log,
  });

  win.setAutoHideMenuBar(true);
  win.setMenuBarVisibility(false);
  hardenPackagedWindow(win);

  win.webContents.on("console-message", (event) => {
    forwardRendererConsole(input.log, "renderer", event);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    input.log(`renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  win.webContents.on("did-finish-load", () => {
    input.log("renderer loaded.");
  });
  win.once("ready-to-show", () => {
    win.show();
    // Let the main window paint first, then prepare its hidden menu once.
    setTimeout(() => {
      if (!win.isDestroyed()) ensureConversationMenu(win);
    }, 0).unref();
  });
  win.on("close", () => {
    saveWindowState(win);
  });
  win.on("maximize", () => win.webContents.send("reina:event:window-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("reina:event:window-state", { maximized: false }));
  broadcastFullScreen(win);

  // Restore the maximized state from last exit. The BrowserWindow ctor only
  // takes x/y/width/height, so a window that quit maximized otherwise reopens
  // at its normal bounds (saveWindowState stores getNormalBounds when maxed).
  if (state.maximized) win.maximize();

  wireZoom(win);
  void win.loadFile(path.join(input.rendererRoot, "main.html"));
  return win;
}

export function createWorkspaceWindow(
  input: CreateWindowInput,
  target?: { tab?: string; sideChatDraft?: string },
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: "Reina Workspace",
    show: false,
    icon: windowIconPath(input.repoRoot),
    ...glassWindowOptions(),
    titleBarStyle: "hidden",
    ...macTrafficLights,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isPackaged,
    },
  });

  win.setAutoHideMenuBar(true);
  win.setMenuBarVisibility(false);
  hardenPackagedWindow(win);

  win.webContents.on("console-message", (event) => {
    forwardRendererConsole(input.log, "workspace renderer", event);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    input.log(`workspace renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  win.webContents.on("did-finish-load", () => {
    input.log("workspace renderer loaded.");
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  win.on("maximize", () => win.webContents.send("reina:event:window-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("reina:event:window-state", { maximized: false }));
  broadcastFullScreen(win);

  wireZoom(win);
  const query: Record<string, string> = { window: "workspace" };
  if (target?.tab) query.tab = target.tab;
  if (target?.sideChatDraft) query.sideChatDraft = target.sideChatDraft;
  void win.loadFile(path.join(input.rendererRoot, "workspace.html"), {
    query,
  });
  return win;
}

export function createSessionSidebarWindow(input: CreateSidebarWindowInput): BrowserWindow {
  const win = new BrowserWindow({
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    minWidth: input.minWidth,
    minHeight: 420,
    maxWidth: input.maxWidth,
    title: "Reina Sessions",
    show: false,
    skipTaskbar: true,
    icon: windowIconPath(input.repoRoot),
    resizable: true,
    ...glassWindowOptions(),
    titleBarStyle: "hidden",
    ...macTrafficLights,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isPackaged,
    },
  });

  win.setAutoHideMenuBar(true);
  win.setMenuBarVisibility(false);
  hardenPackagedWindow(win);
  // The sidebar is a companion panel toggled from the main window, so it needs
  // no window controls of its own — hide the macOS traffic lights entirely.
  if (process.platform === "darwin") win.setWindowButtonVisibility(false);

  win.webContents.on("console-message", (event) => {
    forwardRendererConsole(input.log, "sidebar renderer", event);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    input.log(`sidebar renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  win.webContents.on("did-finish-load", () => {
    input.log("sidebar renderer loaded.");
  });
  wireZoom(win);
  void win.loadFile(path.join(input.rendererRoot, "main.html"), {
    query: { window: "sidebar" },
  });
  return win;
}

export function createSettingsWindow(input: CreateWindowInput, panel?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: "Reina Settings",
    show: false,
    icon: windowIconPath(input.repoRoot),
    ...glassWindowOptions(),
    titleBarStyle: "hidden",
    ...macTrafficLights,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isPackaged,
    },
  });

  win.setAutoHideMenuBar(true);
  win.setMenuBarVisibility(false);
  hardenPackagedWindow(win);

  win.webContents.on("console-message", (event) => {
    forwardRendererConsole(input.log, "settings renderer", event);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    input.log(`settings renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  win.webContents.on("did-finish-load", () => {
    input.log("settings renderer loaded.");
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  win.on("maximize", () => win.webContents.send("reina:event:window-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("reina:event:window-state", { maximized: false }));
  broadcastFullScreen(win);

  wireZoom(win);
  void win.loadFile(path.join(input.rendererRoot, "settings.html"), {
    query: panel ? { window: "settings", panel } : { window: "settings" },
  });
  return win;
}

const submenuTemplates: Record<string, Electron.MenuItemConstructorOptions[]> = {};

export interface ConversationMenuPayload {
  hasSession: boolean;
  hasTarget: boolean;
  pinned: boolean;
  archived: boolean;
  selectedAppId: string;
  apps: Array<{ id: string; label: string }>;
}

export function createMenu(trigger: (id: string) => void, createWindow: () => void): void {
  const isMac = process.platform === "darwin";
  // CmdOrCtrl = ⌘ on macOS, Ctrl elsewhere. A literal "Ctrl+…" accelerator
  // would bind the Control key on macOS, which no mac user would ever find.
  const fileMenu: Electron.MenuItemConstructorOptions[] = [
    { label: "New Session", accelerator: "CmdOrCtrl+Shift+S", click: () => trigger("session.new") },
    { label: "Open Workspace...", accelerator: "CmdOrCtrl+O", click: () => trigger("workspace.open") },
    { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: createWindow },
    { type: "separator" },
    // macOS: ⌘W closes the window; Quit lives in the app menu. Elsewhere Quit
    // stays in File.
    isMac ? { role: "close" } : { role: "quit" },
  ];
  const editMenu: Electron.MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ];
  const viewMenu: Electron.MenuItemConstructorOptions[] = [
    { label: "Command Palette...", accelerator: "CmdOrCtrl+K", click: () => trigger("command.palette") },
    { type: "separator" },
    ...(!isPackaged
      ? [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ] satisfies Electron.MenuItemConstructorOptions[]
      : []),
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  const helpMenu: Electron.MenuItemConstructorOptions[] = [
    ...(!isPackaged ? [{ label: "Reina Logs", click: () => trigger("logs.open") }] : []),
    { label: "OpenCode Reference", click: () => shell.openExternal("https://opencode.ai") },
  ];

  submenuTemplates.file = fileMenu;
  submenuTemplates.edit = editMenu;
  submenuTemplates.view = viewMenu;
  submenuTemplates.help = helpMenu;

  // macOS renders template[0] as the application menu (bold app name), so
  // without an explicit app menu the File menu gets swallowed into that slot.
  // Built by hand (not role:"appMenu") to slot in the conventional
  // Settings… ⌘, item. windowMenu adds the standard Window menu (Minimize ⌘M /
  // Zoom / window list) mac users expect.
  const macAppMenu: Electron.MenuItemConstructorOptions = {
    role: "appMenu",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { label: "Settings…", accelerator: "Cmd+,", click: () => trigger("settings.open") },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    { label: "File", submenu: fileMenu },
    { label: "Edit", submenu: editMenu },
    { label: "View", submenu: viewMenu },
    ...(isMac ? [{ role: "windowMenu" } satisfies Electron.MenuItemConstructorOptions] : []),
    { label: "Help", submenu: helpMenu },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function normalizeConversationMenuPayload(input?: ConversationMenuPayload): ConversationMenuPayload {
  const apps = Array.isArray(input?.apps)
    ? input.apps
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            /^[a-z0-9-]{1,32}$/.test(entry.id) &&
            typeof entry.label === "string" &&
            entry.label.length > 0 &&
            entry.label.length <= 64,
        )
        .slice(0, 24)
    : [];
  return {
    hasSession: input?.hasSession === true,
    hasTarget: input?.hasTarget === true,
    pinned: input?.pinned === true,
    archived: input?.archived === true,
    selectedAppId: typeof input?.selectedAppId === "string" ? input.selectedAppId : "",
    apps,
  };
}

function popupConversationMenu(
  owner: BrowserWindow,
  x: number | undefined,
  y: number | undefined,
  input?: ConversationMenuPayload,
): void {
  const menu = ensureConversationMenu(owner);
  if (!menu) return;
  const payload = normalizeConversationMenuPayload(input);
  const ownerBounds = owner.getContentBounds();
  const display = screen.getDisplayMatching(ownerBounds);
  const menuWidth = 426;
  const menuHeight = Math.min(
    Math.max(222, 82 + payload.apps.length * 32),
    Math.max(222, display.workArea.height - 8),
  );
  const desiredX = ownerBounds.x + (Number.isFinite(x) ? Math.round(x as number) : 0);
  const desiredY = ownerBounds.y + (Number.isFinite(y) ? Math.round(y as number) : 0);
  const popupX = Math.max(
    display.workArea.x + 4,
    Math.min(desiredX, display.workArea.x + display.workArea.width - menuWidth - 4),
  );
  const popupY = Math.max(
    display.workArea.y + 4,
    Math.min(desiredY, display.workArea.y + display.workArea.height - menuHeight - 4),
  );

  menu.popup.setBounds({ x: popupX, y: popupY, width: menuWidth, height: menuHeight });
  menu.payload = payload;
  menu.revision += 1;
  menu.requested = true;
  sendConversationMenuState(menu);
}

function getConversationMenu(popup: BrowserWindow): ConversationMenu | undefined {
  if (popup.isDestroyed()) return;
  const owner = popup.getParentWindow();
  const menu = owner ? conversationMenus.get(owner.id) : undefined;
  return menu?.popup === popup ? menu : undefined;
}

function sendConversationMenuState(menu: ConversationMenu): void {
  if (!menu.rendererReady || !menu.requested) return;
  menu.popup.webContents.send("reina:event:conversation-menu-state", {
    revision: menu.revision,
    payload: menu.payload,
  });
}

function showConversationMenu(menu: ConversationMenu): void {
  if (!menu.requested || !menu.readyToShow || menu.renderedRevision !== menu.revision) return;
  if (!menu.popup.isVisible()) {
    menu.popup.show();
    menu.popup.focus();
  }
}

export function conversationMenuReady(popup: BrowserWindow, revision?: number): void {
  const menu = getConversationMenu(popup);
  if (!menu) return;
  if (revision === undefined) {
    menu.rendererReady = true;
    sendConversationMenuState(menu);
  } else if (revision === menu.revision) {
    menu.renderedRevision = revision;
    showConversationMenu(menu);
  }
}

export function closeConversationMenu(popup: BrowserWindow): boolean {
  const menu = getConversationMenu(popup);
  if (!menu) return false;
  menu.requested = false;
  if (popup.isVisible()) popup.hide();
  return true;
}

function ensureConversationMenu(owner: BrowserWindow): ConversationMenu | undefined {
  const existing = conversationMenus.get(owner.id);
  if (existing && !existing.popup.isDestroyed()) return existing;
  const assets = rendererAssetsByWindow.get(owner);
  if (!assets || owner.isDestroyed()) return;

  const popup = new BrowserWindow({
    parent: owner,
    width: 426,
    height: 222,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: assets.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isPackaged,
    },
  });
  const menu: ConversationMenu = {
    popup,
    rendererReady: false,
    readyToShow: false,
    requested: false,
    revision: 0,
    renderedRevision: -1,
  };
  conversationMenus.set(owner.id, menu);
  popup.setMenuBarVisibility(false);
  hardenPackagedWindow(popup);

  const hide = () => { closeConversationMenu(popup); };
  const destroy = () => { if (!popup.isDestroyed()) popup.destroy(); };
  const ownerBlur = () => { if (!popup.isVisible()) hide(); };
  owner.on("move", hide);
  owner.on("resize", hide);
  owner.on("hide", hide);
  owner.on("minimize", hide);
  owner.on("blur", ownerBlur);
  owner.on("closed", destroy);
  popup.on("closed", () => {
    owner.off("move", hide);
    owner.off("resize", hide);
    owner.off("hide", hide);
    owner.off("minimize", hide);
    owner.off("blur", ownerBlur);
    owner.off("closed", destroy);
    if (conversationMenus.get(owner.id) === menu) conversationMenus.delete(owner.id);
  });
  popup.on("close", (event) => {
    event.preventDefault();
    hide();
  });
  // A blur queued by the previous hide may arrive during the next open.
  popup.on("blur", () => { if (popup.isVisible()) hide(); });
  popup.webContents.on("render-process-gone", destroy);
  popup.webContents.on("console-message", (event) => {
    forwardRendererConsole(assets.log, "conversation-menu renderer", event);
  });
  popup.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    assets.log(`conversation-menu renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  popup.once("ready-to-show", () => {
    menu.readyToShow = true;
    showConversationMenu(menu);
  });
  void popup.loadFile(path.join(assets.rendererRoot, "conversation-menu.html")).catch((error: unknown) => {
    assets.log(`conversation-menu load failed: ${String(error)}`);
    destroy();
  });
  return menu;
}

export function popupTopbarMenu(
  win: BrowserWindow,
  key: string,
  x?: number,
  y?: number,
  payload?: ConversationMenuPayload,
): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "conversation") {
    popupConversationMenu(win, x, y, payload);
    return;
  }
  const submenu = submenuTemplates[normalizedKey];
  if (!submenu) return;
  const menu = Menu.buildFromTemplate(submenu);
  const options: Electron.PopupOptions = { window: win };
  if (Number.isFinite(x)) options.x = Math.round(x as number);
  if (Number.isFinite(y)) options.y = Math.round(y as number);
  menu.popup(options);
}

export function sendMenuCommand(win: BrowserWindow, id: string): void {
  win.webContents.send("reina:event:menu-command", id);
}

function wireZoom(win: BrowserWindow): void {
  win.webContents.setZoomFactor(1);
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1);
  });
}

type WindowState = { x?: number; y?: number; width: number; height: number; maximized?: boolean };

function readWindowState(): WindowState {
  const store = readStore("window");
  return {
    x: parseOptionalNumber(store.x),
    y: parseOptionalNumber(store.y),
    width: parseOptionalNumber(store.width) ?? mainWindowDefaultWidth,
    height: parseOptionalNumber(store.height) ?? mainWindowDefaultHeight,
    maximized: store.maximized === "true",
  };
}

function normalizeMainWindowState(state: WindowState): WindowState {
  const display = state.x !== undefined && state.y !== undefined
    ? screen.getDisplayNearestPoint({ x: state.x, y: state.y })
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const maxWidth = Math.max(mainWindowMinWidth, Math.min(mainWindowMaxRestoredWidth, workArea.width - mainWindowScreenPadding * 2));
  const maxHeight = Math.max(mainWindowMinHeight, workArea.height - mainWindowScreenPadding * 2);
  const width = clampNumber(state.width, mainWindowMinWidth, maxWidth);
  const height = clampNumber(state.height, mainWindowMinHeight, maxHeight);
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);
  return {
    x: state.x === undefined ? undefined : clampNumber(state.x, workArea.x, maxX),
    y: state.y === undefined ? undefined : clampNumber(state.y, workArea.y, maxY),
    width,
    height,
    maximized: state.maximized,
  };
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isMinimized()) return;
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  writeStore("window", {
    x: String(bounds.x),
    y: String(bounds.y),
    width: String(bounds.width),
    height: String(bounds.height),
    maximized: String(win.isMaximized() || win.isFullScreen()),
  });
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}
