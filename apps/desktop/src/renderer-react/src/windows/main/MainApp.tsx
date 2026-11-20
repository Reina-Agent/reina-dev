// Main chat window — React port (tech-stack swap, byte-identical look).
// This component reproduces the exact DOM of the legacy
// apps/desktop/src/renderer/main.html: same classes, same ids, same structure,
// so the verbatim-reused legacy CSS (./legacy-styles/*) renders identically.
// Dynamic regions (#session-list, #timeline, composer state, etc.) start as the
// same empty containers the legacy HTML ships; the logic subsystems fill them.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addPendingSkill,
  getMainState,
  initMainStore,
  interrupt,
  loadSession,
  newDraftSession,
  refreshDesktopState,
  requestComposerDraft,
  setLayout,
  setSidebarActiveSession,
  useMainStore,
} from "./sessionStore";
import { isSidebarWindow } from "~/lib/windowKind";
import type { SessionListItem } from "./protocol";
import { bindHorizontalResizer, restorePaneSizes } from "./paneResizers";
import { SessionList } from "./SessionList";
import { loadWorkspace } from "./WorkspaceSwitcher";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { HitlDock } from "./HitlDock";
import { TaskPane } from "./TaskPane";
import { OpenWith } from "./OpenWith";
import { Welcome } from "./Welcome";
import { SearchOverlay, openSearchOverlay } from "./SearchOverlay";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { CommandPalette, openCommandPalette } from "./CommandPalette";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateSidebarButton } from "./UpdateSidebarButton";
import { bridge } from "~/lib/bridge";
import { createWorkspaceFrameContextMessage } from "../workspace/workspaceFrameContext";

// macOS draws native traffic lights (titleBarStyle:"hidden"); don't render our
// own Windows-style min/max/close there — the native controls top-left are the
// only window controls on mac.
const isMac = navigator.platform.toLowerCase().includes("mac");

const WORKSPACE_PANE_ANIMATION_MS = 240;
const WORKSPACE_CHAT_MIN_WIDTH = 480;
const WORKSPACE_PANE_MIN_WIDTH = 420;

type WorkspaceTracks = [chat: number, resizer: number, workspace: number];
type WorkspaceAnimation = {
  timer: number;
  onTransitionEnd: (event: TransitionEvent) => void;
};

function getWorkspaceTracks(app: HTMLElement, collapsed: boolean): WorkspaceTracks {
  const width = app.clientWidth;
  if (collapsed) return [width, 0, 0];
  if (window.matchMedia("(max-width: 980px)").matches) return [0, 0, width];

  const styles = getComputedStyle(app);
  const storedChatWidth =
    Number.parseFloat(styles.getPropertyValue("--chat-pane-width")) || 760;
  const resizerWidth =
    Number.parseFloat(styles.getPropertyValue("--main-resizer-width")) || 6;
  const maxChatWidth = Math.max(
    WORKSPACE_CHAT_MIN_WIDTH,
    width - WORKSPACE_PANE_MIN_WIDTH - resizerWidth,
  );
  const chatWidth = Math.min(
    maxChatWidth,
    Math.max(WORKSPACE_CHAT_MIN_WIDTH, storedChatWidth),
  );
  return [chatWidth, resizerWidth, Math.max(0, width - chatWidth - resizerWidth)];
}

function readWorkspaceTracks(app: HTMLElement): WorkspaceTracks | null {
  const values = getComputedStyle(app)
    .gridTemplateColumns.match(/-?\d+(?:\.\d+)?px/g)
    ?.map(Number.parseFloat);
  return values?.length === 3 ? [values[0], values[1], values[2]] : null;
}

function writeWorkspaceTracks(app: HTMLElement, [chat, resizer, workspace]: WorkspaceTracks): void {
  app.style.setProperty("--workspace-chat-animated-width", `${chat}px`);
  app.style.setProperty("--workspace-resizer-animated-width", `${resizer}px`);
  app.style.setProperty("--workspace-pane-animated-width", `${workspace}px`);
}

// Tiny helper to keep the JSX close to the legacy <svg class="icon"> markup.
function Icon({ name, className = "icon" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function MainApp() {
  const layout = useMainStore((s) => s.layout);
  const workspaceCwd = useMainStore((s) => s.workspaceCwd);
  const sessionId = useMainStore((s) => s.sessionId);
  const appRef = useRef<HTMLDivElement>(null);
  const sessionResizerRef = useRef<HTMLDivElement>(null);
  const workspaceResizerRef = useRef<HTMLDivElement>(null);
  const workspaceIframeRef = useRef<HTMLIFrameElement>(null);
  const workspaceReadyRef = useRef(false);
  const pendingWorkspaceTabRef = useRef<string | null>(null);
  const pendingSideChatQuoteRef = useRef<string | null>(null);
  const pendingNewSideChatRef = useRef(false);
  const previousWorkspaceCollapsedRef = useRef(layout.workspaceCollapsed);
  const workspaceAnimationRef = useRef<WorkspaceAnimation | null>(null);
  const [workspaceEverOpened, setWorkspaceEverOpened] = useState(false);
  const [workspacePlacement, setWorkspacePlacement] = useState<"floating" | "inline">("inline");

  useEffect(() => {
    let cancelled = false;
    const b = bridge();
    void b.storeGet("view-settings", "workspacePlacement").then((value) => {
      if (!cancelled) setWorkspacePlacement(value === "floating" ? "floating" : "inline");
    }).catch(() => undefined);
    const off = b.events.on("view-settings-changed", (payload) => {
      const setting = payload as { key?: string; value?: unknown } | null;
      if (setting?.key === "workspacePlacement") {
        cancelled = true;
        setWorkspacePlacement(setting.value === "floating" ? "floating" : "inline");
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const clearWorkspaceAnimation = useCallback(() => {
    const animation = workspaceAnimationRef.current;
    if (animation) {
      if (animation.timer) window.clearTimeout(animation.timer);
      appRef.current?.removeEventListener("transitionend", animation.onTransitionEnd);
      workspaceAnimationRef.current = null;
    }
    const app = appRef.current;
    if (!app) return;
    app.removeAttribute("data-workspace-sliding");
    app.removeAttribute("data-workspace-slide-seed");
    app.style.removeProperty("--workspace-chat-animated-width");
    app.style.removeProperty("--workspace-resizer-animated-width");
    app.style.removeProperty("--workspace-pane-animated-width");
    app.style.removeProperty("--workspace-content-pin");
  }, []);

  useLayoutEffect(() => {
    const collapsed = layout.workspaceCollapsed;
    const previous = previousWorkspaceCollapsedRef.current;
    previousWorkspaceCollapsedRef.current = collapsed;
    const app = appRef.current;
    if (!app || previous === collapsed) return;

    const start = workspaceAnimationRef.current
      ? (readWorkspaceTracks(app) ?? getWorkspaceTracks(app, previous))
      : getWorkspaceTracks(app, previous);
    clearWorkspaceAnimation();
    const target = getWorkspaceTracks(app, collapsed);
    const workspacePane = app.querySelector<HTMLElement>(".workspace-pane");
    const paneMargin = workspacePane
      ? Number.parseFloat(getComputedStyle(workspacePane).marginRight) || 0
      : 0;

    app.setAttribute("data-workspace-sliding", "");
    app.setAttribute("data-workspace-slide-seed", "");
    writeWorkspaceTracks(app, start);
    app.style.setProperty(
      "--workspace-content-pin",
      `${Math.max(0, Math.max(start[2], target[2]) - paneMargin)}px`,
    );
    void app.offsetWidth;

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === app && event.propertyName === "grid-template-columns") {
        clearWorkspaceAnimation();
      }
    };
    const animation: WorkspaceAnimation = { timer: 0, onTransitionEnd };
    workspaceAnimationRef.current = animation;
    app.addEventListener("transitionend", onTransitionEnd);
    app.removeAttribute("data-workspace-slide-seed");
    void app.offsetWidth;
    writeWorkspaceTracks(app, target);
    animation.timer = window.setTimeout(() => {
      if (workspaceAnimationRef.current === animation && !document.hidden) clearWorkspaceAnimation();
    }, WORKSPACE_PANE_ANIMATION_MS + 40);
  }, [clearWorkspaceAnimation, layout.workspaceCollapsed]);

  useLayoutEffect(() => () => clearWorkspaceAnimation(), [clearWorkspaceAnimation]);

  useEffect(() => {
    void initMainStore();
  }, []);

  // Port of the legacy layout.js pane-resizer wiring: restore persisted pane
  // sizes onto the `.app` element, then bind the session-pane drag handle so
  // dragging writes --session-pane-width inline on `.app` and persists to
  // localStorage ("reina:desktop:pane-sizes"). Matches bindPaneResizers'
  // session-handle config (min 240, max 520, forward).
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    restorePaneSizes(app);
    const unbindSession = bindHorizontalResizer({
      app,
      handle: sessionResizerRef.current,
      cssVariable: "--session-pane-width",
      storageField: "session",
      min: 240,
      max: 520,
      direction: "forward",
    });
    // The outer split is main conversation surface | Workspace. Dragging the
    // divider right gives the conversation more room; the remainder belongs to
    // the embedded workbench.
    const unbindWorkspace = bindHorizontalResizer({
      app,
      handle: workspaceResizerRef.current,
      cssVariable: "--chat-pane-width",
      storageField: "chat",
      min: 480,
      // Preserve the Workspace's 420px usable minimum at the current window
      // width. The CSS grid applies the same bound while the window resizes.
      max: () => Math.max(480, app.clientWidth - 426),
      direction: "forward",
    });
    return () => {
      unbindSession();
      unbindWorkspace();
    };
  }, []);

  // Track the OS window's maximized state so the control flips between the
  // maximize/restore glyph (mirror legacy window-state handling; React's main
  // window previously never subscribed, so the icon was always "maximize").
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const b = bridge();
    // macOS hides its traffic lights in fullscreen; stamp body[data-fullscreen]
    // so topbar.css can collapse the left-edge reserve instead of leaving a gap.
    const setFullScreen = (on: boolean) => {
      // Delete (not set to "") when off: `[data-fullscreen]` matches on attribute
      // presence, so an empty-string value would keep the reserve collapsed.
      if (on) document.body.dataset.fullscreen = "true";
      else delete document.body.dataset.fullscreen;
    };
    void b.windowIsMaximized().then(setMaximized).catch(() => undefined);
    void b.windowIsFullScreen().then(setFullScreen).catch(() => undefined);
    return b.events.on("window-state", (payload) => {
      const s = payload as { maximized?: boolean; fullscreen?: boolean } | undefined;
      if (typeof s?.maximized === "boolean") setMaximized(s.maximized);
      if (typeof s?.fullscreen === "boolean") setFullScreen(s.fullscreen);
    });
  }, []);

  // Agent-host crash banner: show on host-exit with a Restart action; hide once
  // the host re-initializes (mirror legacy host-exit / init-step handling). React
  // previously rendered the banner DOM but never subscribed, so crashes were silent.
  const [hostCrash, setHostCrash] = useState<string | null>(null);
  useEffect(() => {
    const b = bridge();
    const offExit = b.events.on("host-exit", (payload) => {
      const p = payload as { detail?: string; code?: number } | undefined;
      setHostCrash(p?.detail ?? `Agent host exited${p?.code != null ? ` (code ${p.code})` : ""}`);
    });
    const offInit = b.events.on("init-step", (payload) => {
      const p = payload as { done?: boolean } | undefined;
      if (p?.done) setHostCrash(null);
    });
    return () => {
      offExit?.();
      offInit?.();
    };
  }, []);

  // Window-level Esc → interrupt the running turn (mirror legacy keymap.js:
  // when no popover/palette/dialog is open and a turn is live, Escape stops it).
  // The spinner advertises "(esc to interrupt)", but React previously only wired
  // Esc to close overlays — so Esc was a no-op while working. Guard on
  // defaultPrevented (popovers + the command palette preventDefault their own
  // Escape, and the palette's window listener registers first as a child) and on
  // any open native <dialog> (the session-rename modal) so we never steal their Esc.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      const s = getMainState();
      if (s.working && !s.stopping && s.sessionId) {
        event.preventDefault();
        void interrupt();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const api = bridge();

  const postWorkspaceTab = useCallback((tab?: string | null) => {
    workspaceIframeRef.current?.contentWindow?.postMessage(
      { type: "reina:focus-workspace-tab", tab: tab ?? null },
      "*",
    );
  }, []);

  const postWorkspaceContext = useCallback(() => {
    if (!workspaceReadyRef.current) return;
    workspaceIframeRef.current?.contentWindow?.postMessage(
      createWorkspaceFrameContextMessage(workspaceCwd, sessionId),
      "*",
    );
  }, [sessionId, workspaceCwd]);

  const deliverPendingSideChatQuote = useCallback(() => {
    const quote = pendingSideChatQuoteRef.current;
    if (!quote || !workspaceReadyRef.current) return;
    workspaceIframeRef.current?.contentWindow?.postMessage(
      { type: "reina:side-chat-draft", draft: quote },
      "*",
    );
    pendingSideChatQuoteRef.current = null;
  }, []);

  const deliverPendingNewSideChat = useCallback(() => {
    if (!pendingNewSideChatRef.current || !workspaceReadyRef.current) return;
    workspaceIframeRef.current?.contentWindow?.postMessage({ type: "reina:new-side-chat" }, "*");
    pendingNewSideChatRef.current = false;
  }, []);

  const showInlineWorkspace = useCallback((tab?: string) => {
    pendingWorkspaceTabRef.current = tab ?? null;
    setWorkspaceEverOpened(true);
    // Task status floats over the chat, so opening Workspace does not need to
    // dismiss it or rewrite the conversation width.
    setLayout({ workspaceCollapsed: false });
  }, []);

  const startNewSideChat = useCallback(() => {
    pendingNewSideChatRef.current = true;
    showInlineWorkspace("sideChat");
    queueMicrotask(deliverPendingNewSideChat);
  }, [deliverPendingNewSideChat, showInlineWorkspace]);

  useEffect(() => {
    const onOpenSideChat = (event: Event) => {
      const quote = (event as CustomEvent<{ quote?: unknown }>).detail?.quote;
      if (typeof quote !== "string" || !quote.trim()) return;
      pendingSideChatQuoteRef.current = quote;
      showInlineWorkspace("sideChat");
      queueMicrotask(deliverPendingSideChatQuote);
    };
    window.addEventListener("reina:open-side-chat", onOpenSideChat);
    return () => window.removeEventListener("reina:open-side-chat", onOpenSideChat);
  }, [deliverPendingSideChatQuote, showInlineWorkspace]);

  // Main-process routing sends Workspace entry points here in inline mode. The
  // iframe stays mounted after first open, preserving Files/Terminal/Diff state
  // while the user collapses the pane.
  useEffect(() => {
    if (isSidebarWindow) return;
    const b = bridge();
    const offOpen = b.events.on("open-inline-workspace", (payload) => {
      const tab = (payload as { tab?: unknown } | null)?.tab;
      showInlineWorkspace(typeof tab === "string" ? tab : undefined);
      if (workspaceReadyRef.current) postWorkspaceTab(typeof tab === "string" ? tab : undefined);
    });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== workspaceIframeRef.current?.contentWindow) return;
      const message = event.data as { type?: unknown; text?: unknown } | null;
      if (message?.type === "reina:workspace-ready") {
        workspaceReadyRef.current = true;
        postWorkspaceContext();
        postWorkspaceTab(pendingWorkspaceTabRef.current);
        deliverPendingNewSideChat();
        deliverPendingSideChatQuote();
      } else if (message?.type === "reina:add-to-conversation" && typeof message.text === "string") {
        requestComposerDraft(message.text, "prepend");
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      offOpen();
      window.removeEventListener("message", onMessage);
    };
  }, [deliverPendingNewSideChat, deliverPendingSideChatQuote, postWorkspaceContext, postWorkspaceTab, showInlineWorkspace]);

  useEffect(() => {
    postWorkspaceContext();
  }, [postWorkspaceContext]);

  useEffect(() => {
    if (layout.workspaceCollapsed || !workspaceEverOpened) return;
    postWorkspaceTab(pendingWorkspaceTabRef.current);
  }, [layout.workspaceCollapsed, postWorkspaceTab, workspaceEverOpened]);

  // Floating session-sidebar window. The sidebar toggle does NOT collapse an
  // inline column (legacy default placement is "floating"): it pops the session
  // list out as a separate window snapped to the main window's left edge, with
  // the slide/snap reveal animated in the main process (openSessionSidebarWindow
  // in main.ts). We just reflect the returned {visible, mode} onto the toggle
  // button's `active` state and the inline pane. Mirrors legacy toggleSessionPane
  // / applySessionSidebarState.
  const [sidebarVisible, setSidebarVisible] = useState(false);
  // Set when the narrow-viewport guard auto-hid the sidebar, so widening back
  // past the threshold can restore it (but a manual dismiss while narrow won't).
  const sidebarAutoHiddenRef = useRef(false);
  const applySidebarState = useCallback((payload: unknown) => {
    const s = (payload ?? {}) as { visible?: boolean; mode?: string };
    const visible = Boolean(s.visible);
    setSidebarVisible(visible);
    // "inline" placement docks the list inside the main window (show/hide the
    // pane); "floating" keeps the inline pane hidden — the window is the sidebar.
    setLayout({ sessionCollapsed: s.mode === "inline" ? !visible : true });
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isSidebarWindow) {
      // In the sidebar window the toggle (hidden by CSS, but wired for parity)
      // dismisses the floating window — mirror legacy hideSessionSidebarWindow.
      void bridge().hideSessionSidebarWindow().catch(() => undefined);
      return;
    }
    // A manual toggle is an explicit choice — drop any pending auto-restore so
    // the narrow-guard doesn't re-open a sidebar the user just dismissed.
    sidebarAutoHiddenRef.current = false;
    void bridge().toggleSessionSidebarWindow().then(applySidebarState).catch(() => undefined);
  }, [applySidebarState]);

  // Narrow-viewport guard (mirror legacy NARROW_INLINE_SIDEBAR_MAX + the resize
  // listener in renderer.js): below this main-window width the open sidebar
  // crowds the chat, so auto-hide it; restore it when widened back past the
  // threshold — but only if WE hid it, never overriding a manual dismiss. Only
  // acts on the actual threshold crossing, not every resize tick.
  useEffect(() => {
    if (isSidebarWindow) return;
    const NARROW_MAX = 760;
    const fits = () => window.innerWidth >= NARROW_MAX;
    let last = fits();
    const onResize = () => {
      const now = fits();
      if (now === last) return;
      last = now;
      if (!now) {
        if (sidebarVisible) {
          sidebarAutoHiddenRef.current = true;
          void bridge().hideSessionSidebarWindow().then(applySidebarState).catch(() => undefined);
        }
      } else if (sidebarAutoHiddenRef.current) {
        sidebarAutoHiddenRef.current = false;
        void bridge().toggleSessionSidebarWindow().then(applySidebarState).catch(() => undefined);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarVisible, applySidebarState]);

  // Cross-window IPC wiring (mirror the legacy desktop.events listeners):
  //  • main window  — the floating sidebar drives it: reflect sidebar visibility
  //    state, and load the session / workspace the sidebar picked.
  //  • sidebar window — follow the main window's active session for the row
  //    highlight (the sidebar never loads a transcript itself).
  useEffect(() => {
    const b = bridge();
    if (isSidebarWindow) {
      return b.events.on("active-session", (payload) => {
        const p = (payload ?? {}) as { sessionId?: string | null };
        setSidebarActiveSession(p.sessionId ?? null);
        void refreshDesktopState();
      });
    }
    const offState = b.events.on("session-sidebar-state", applySidebarState);
    // Restore the sidebar to its last-exit open/closed state. Pull it now that
    // the listener above is attached (main pushes nothing on boot to avoid
    // racing this subscription).
    void b.getSessionSidebarState().then(applySidebarState).catch(() => undefined);
    const offOpenSession = b.events.on("open-session", (payload) => {
      if (!payload || typeof payload !== "object") return;
      // A `{ draft: true }` descriptor is the sidebar's "New Agent" request —
      // start a fresh draft here (the sidebar can't, it has no chat surface).
      const item = payload as SessionListItem & { draft?: boolean };
      if (item.draft) {
        void newDraftSession(item.cwd ?? undefined);
        return;
      }
      void loadSession(item);
    });
    const offOpenWorkspace = b.events.on("open-workspace", (payload) => {
      if (typeof payload !== "string" || !payload) return;
      void loadWorkspace(payload);
    });
    // The floating sidebar's "Search" routes here (it has no chat surface — the
    // palette must open over the main transcript, not inside the sidebar window).
    const offOpenPalette = b.events.on("open-command-palette", (payload) => {
      const p = (payload ?? {}) as { query?: string };
      openCommandPalette(typeof p.query === "string" ? p.query : "");
    });
    // The floating sidebar's "Search" (conversation search) also routes here.
    const offOpenSearch = b.events.on("open-conversation-search", () => {
      openSearchOverlay();
    });
    // The Settings window's "Use" button routes here (Settings has no composer):
    // main.ts focuses this window and forwards the picked skill — stage it as a
    // composer tag exactly like the /skill picker (addPendingSkill).
    const offUseSkill = b.events.on("use-skill", (payload) => {
      if (!payload || typeof payload !== "object") return;
      const skill = payload as { name?: string; description?: string };
      if (typeof skill.name !== "string" || !skill.name) return;
      addPendingSkill({ name: skill.name, description: skill.description });
    });
    return () => {
      offState?.();
      offOpenSession?.();
      offOpenWorkspace?.();
      offOpenPalette?.();
      offOpenSearch?.();
      offUseSkill?.();
    };
  }, [applySidebarState]);

  // "New Agent" starts a fresh draft. The floating sidebar window has no chat
  // surface, so — like handleSelect's session-pick branch — it must route the
  // request to the MAIN window rather than reset its own (invisible) store;
  // otherwise the main chat keeps the old transcript ("新建 session 主页面没切换").
  const newSession = () => {
    if (isSidebarWindow) {
      // Optimistically drop the sidebar's row highlight onto the draft (mirror
      // handleSelect's setSidebarActiveSession before openSessionInMain) so the
      // "New session" row appears immediately, then ask the main window to start
      // the draft. The main window's active-session broadcast confirms it.
      setSidebarActiveSession(null);
      void bridge()
        .openSessionInMain({ draft: true, cwd: getMainState().workspaceCwd ?? undefined })
        .catch(() => undefined);
      return;
    }
    void newDraftSession();
  };
  const openSettings = () => void api.openSettingsWindow();
  const openSkills = () => void api.openSettingsWindow("skills");
  const toggleWorkspace = () => {
    if (workspacePlacement === "floating") {
      void api.openWorkspaceWindow().then(() => setLayout({ workspaceCollapsed: true })).catch(() => undefined);
      return;
    }
    if (layout.workspaceCollapsed) void api.openWorkspaceWindow().catch(() => undefined);
    else setLayout({ workspaceCollapsed: true });
  };
  const workspaceToggleTitle = workspacePlacement === "floating"
    ? "Open Workspace in separate window"
    : layout.workspaceCollapsed ? "Open Workspace on right" : "Collapse Workspace";

  // Reproduce the legacy `.app` layout classes from store flags.
  const appClass =
    "app" +
    (layout.workspaceCollapsed ? " workspace-collapsed" : "") +
    (layout.sessionCollapsed ? " session-collapsed" : "");

  return (
    <>
      {/* Welcome screen — full-screen overlay shown when no workspace is open.
          Only in the main chat window: the floating sidebar window has no chat
          surface, and the fixed/inset overlay would otherwise cover its list. */}
      {!isSidebarWindow && <Welcome />}

      {/* Main app shell. */}
      <div className={appClass} data-shell="main" ref={appRef}>
        {/* One titlebar owns the whole native window. Keeping every interactive
            control inside its drag parent lets Electron carve reliable no-drag
            islands instead of resolving overlapping sibling regions. */}
        <header className="topbar global-titlebar" role="toolbar" aria-label="Window and workspace controls">
          <div className="topbar-start" role="group" aria-label="Navigation and conversation controls">
            <button className={"title-icon-button" + (sidebarVisible ? " active" : "")} id="toggle-rail" type="button" onClick={toggleSidebar}
              title="Toggle sidebar" aria-label="Toggle sidebar" aria-controls="session-pane">
              <Icon name="sidebar-left" />
            </button>
            <button className="title-icon-button" id="topbar-quick-new-session" type="button" onClick={newSession}
              title="New Agent" aria-label="New Agent">
              <Icon name="edit" />
            </button>
            {!isSidebarWindow && <OpenWith onOpenSideChat={startNewSideChat} />}
          </div>

          <div className="topbar-title-wrap" aria-live="polite">
            <h2 className="topbar-title" id="chat-title">Current session</h2>
            <span className="chat-header-meta" hidden>
              <span id="chat-session-model" className="chat-chip" title="" />
            </span>
          </div>

          {!isSidebarWindow && (
            <div className="global-titlebar-trailing">
              <div className="topbar-end global-topbar-actions" role="group" aria-label="Workspace controls">
                <button
                  className={"title-icon-button topbar-workspace-toggle" + (workspacePlacement === "inline" && !layout.workspaceCollapsed ? " active" : "")}
                  id="toggle-workspace"
                  type="button"
                  onClick={toggleWorkspace}
                  title={workspaceToggleTitle}
                  aria-label={workspaceToggleTitle}
                  aria-controls={workspacePlacement === "inline" ? "workspace-pane" : undefined}
                  aria-expanded={workspacePlacement === "inline" ? !layout.workspaceCollapsed : undefined}
                >
                  <Icon name={workspacePlacement === "floating" ? "external" : "sidebar-right"} />
                </button>
              </div>

              {!isMac && (
                <div className="window-controls global-window-controls" role="group" aria-label="Window controls">
                  <button className="window-control" id="win-minimize" type="button" title="Minimize" aria-label="Minimize"
                    onClick={() => void api.windowMinimize()}>
                    <Icon name="win-minimize" />
                  </button>
                  <button className="window-control" id="win-maximize" type="button"
                    title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"}
                    onClick={() => void api.windowToggleMaximize()}>
                    <Icon name={maximized ? "win-restore" : "win-maximize"} />
                  </button>
                  <button className="window-control window-control-close" id="win-close" type="button" title="Close" aria-label="Close"
                    onClick={() => void api.windowClose()}>
                    <Icon name="win-close" />
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        <section className="main-surface" aria-label="Reina workspace">

          {/* ── Main layout: sidebar | resizer | chat-pane | resizer | task-pane ── */}
          <div className="main-layout" data-layout="main">
            <aside className="session-pane" id="session-pane" aria-label="Sessions">
              <WorkspaceSwitcher />

              <div className="session-actions-top" role="group" aria-label="Session actions">
                <button className="new-session" id="topbar-new-session" type="button" onClick={newSession}>
                  <Icon name="edit" />
                  <span>New Agent</span>
                </button>
                <button className="new-session" id="topbar-search" type="button"
                  onClick={() => {
                    // Conversation content search (FTS over this workspace's
                    // sessions). The command palette stays on Ctrl+P/K. In the
                    // floating sidebar the overlay must open over the main
                    // window's chat (a clicked hit loads a session there).
                    if (isSidebarWindow) {
                      void bridge().openConversationSearchInMain().catch(() => undefined);
                      return;
                    }
                    openSearchOverlay();
                  }}>
                  <Icon name="search" />
                  <span>Search</span>
                </button>
                <button className="new-session" id="topbar-skills" type="button" onClick={openSkills}>
                  <Icon name="sparkles" />
                  <span>Skills</span>
                </button>
              </div>

              <div className="session-list" id="session-list" aria-label="Conversation sessions">
                <SessionList />
              </div>
              <div id="session-meta" className="meta" aria-live="polite" />

              <div className="session-footer">
                <div className="session-user">
                  <div className="session-avatar" aria-hidden>
                    <img src="./legacy-assets/icon.png" alt="" />
                  </div>
                  <div className="session-user-text">
                    <div className="session-user-name">Reina</div>
                    <div className="session-user-plan">Local Plan</div>
                  </div>
                </div>
                <div className="session-footer-actions">
                  <UpdateSidebarButton />
                  <button className="sidebar-icon-button" id="settings-button" type="button" title="Settings" aria-label="Settings" onClick={openSettings}>
                    <Icon name="settings" />
                  </button>
                </div>
              </div>
            </aside>
            <div className="session-window-drag-region" aria-hidden />

            <div ref={sessionResizerRef} className="pane-resizer session-pane-resizer" id="session-pane-resizer" title="Resize sidebar"
              role="separator" aria-orientation="vertical" aria-label="Resize session sidebar" aria-controls="session-pane" />

            {/* ── Chat pane ── */}
            <main className="chat-pane" aria-label="Conversation">
              {/* The toast portals to document.body (position:fixed), escaping the
                  sidebar window's hidden .chat-pane — guard it like Welcome, or it
                  pops up centered inside the narrow floating sidebar. */}
              {!isSidebarWindow && <UpdateBanner />}
              <div id="host-crash-banner" className="host-crash-banner" role="alert" hidden={!hostCrash}>
                <Icon name="zap" />
                <span className="host-crash-text" id="host-crash-text">{hostCrash}</span>
                <button id="host-crash-restart" type="button" className="settings-action settings-action-accent"
                  onClick={() => bridge().relaunch()}>
                  Restart agent host
                </button>
              </div>

              <section id="timeline" className="timeline" role="log" aria-live="polite" aria-relevant="additions text">
                <Timeline />
              </section>

              <HitlDock />

              <Composer />
            </main>

            {/* Conversation-anchored task status: floating capsule → docked details. */}
            <aside className="task-pane" id="task-pane" aria-label="Task progress">
              <TaskPane />
            </aside>
          </div>
        </section>

        <div
          ref={workspaceResizerRef}
          className="pane-resizer workspace-pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Workspace"
          aria-controls="workspace-pane"
        />

        <aside className="workspace-pane" id="workspace-pane" aria-label="Workspace tools">
          {workspaceEverOpened ? (
            <iframe
              ref={workspaceIframeRef}
              className="workspace-frame"
              src="./workspace.html?embedded=1"
              title="Reina Workspace"
              onLoad={() => {
                workspaceReadyRef.current = true;
                postWorkspaceContext();
                postWorkspaceTab(pendingWorkspaceTabRef.current);
              }}
            />
          ) : null}
        </aside>

      </div>

      {/* Ctrl+P command palette. */}
      <CommandPalette />

      {/* Conversation content search (sidebar Search button). */}
      <SearchOverlay />
    </>
  );
}
