// Terminal tab body — React port of the legacy workspace terminal panel
// (apps/desktop/src/renderer/actions/terminal.js). Reproduces the legacy
// FUNCTIONALITY (multiple PTY-backed xterm sessions, collapsible session
// sidebar with live/dead state + close buttons, new/clear/restart actions,
// fit-on-resize → PTY resize, process-exit banner) in the React/Tailwind
// workspace style (matching NotesTab / FileTree / GitChanges).
//
// xterm.js comes from the real npm deps (@xterm/xterm + @xterm/addon-fit),
// which Vite resolves directly — no need to import the legacy vendored ESM.
//
// PTY wiring via the preload bridge:
//   terminalCreate({ id, cwd, shell, cols, rows }) -> { shell } (start a PTY)
//   terminalWrite(id, data)        — forward keystrokes to the PTY
//   terminalResize(id, cols, rows) — keep the PTY sized to the xterm grid
//   terminalDispose(id)            — kill one PTY
//   terminalDisposeWindow()        — kill every PTY for this window (unmount)
//   events.on("terminal-data", { id, data })          — PTY → xterm output
//   events.on("terminal-exit", { id, exitCode, signal }) — PTY exited
//
// Only mounts xterm / creates sessions / subscribes to events while `active`
// is true, so the terminal is inert for workspaces the user never opens it on.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "~/lib/bridge";
import { getViewSettings } from "~/lib/viewSettings";
import { ResizeHandle } from "~/components/ResizeHandle";
import { useResizableSidebar } from "~/lib/useResizableSidebar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TerminalSession {
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  title: string;
  cwd: string | undefined;
  alive: boolean;
  createdAt: number;
  lastDimensions: { cols: number; rows: number };
}

interface TerminalDataPayload {
  id: string;
  data: string;
}

interface TerminalExitPayload {
  id: string;
  exitCode?: number;
  signal?: number;
}

// ── xterm theme (mirrors legacy makeXterm theme) ──────────────────────────────

const XTERM_THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#d6d6d6",
  cursor: "#d6d6d6",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#264f78",
  black: "#1d1d1d",
  red: "#ff6b68",
  green: "#77c986",
  yellow: "#e3d083",
  blue: "#5da0ff",
  magenta: "#c594c5",
  cyan: "#7fd1e0",
  white: "#d6d6d6",
  brightBlack: "#6f6f6f",
  brightRed: "#ff8f84",
  brightGreen: "#9be8a8",
  brightYellow: "#ffd97a",
  brightBlue: "#7fb4ff",
  brightMagenta: "#d6a3d6",
  brightCyan: "#9fe1ee",
  brightWhite: "#ffffff",
};

// ── Helpers (mirror legacy shortShellName / title helpers) ────────────────────

function newId(): string {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortShellName(shell: string | undefined): string {
  if (!shell) return "shell";
  const base = shell.replaceAll("\\", "/").split("/").at(-1) || shell;
  return base.replace(/\.exe$/i, "");
}

function codeFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--code-font-size").trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 8 && n <= 32 ? n : 13;
}

function codeFontFamily(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--font-mono-family").trim();
  return raw || "Cascadia Code, SFMono-Regular, Consolas, monospace";
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function TerminalGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function IconButton({
  title,
  onClick,
  children,
  active,
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-fast) disabled:pointer-events-none disabled:opacity-40 " +
        (active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TerminalTab({ cwd, active }: { cwd: string | null; active: boolean }) {
  // Sessions live in a ref Map (imperative xterm instances); a render-version
  // counter forces re-renders of the sidebar/list when the map mutates.
  const sessionsRef = useRef<Map<string, TerminalSession>>(new Map());
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((v) => v + 1), []);

  const activeIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Drag-to-resize width for the session sidebar (collapse stays in the
  // view-settings store above so it syncs cross-window). The fit ResizeObserver
  // already refits xterm when this width changes the surface.
  const sidebar = useResizableSidebar({
    storageKey: "reina.workspace.terminalSidebarWidth",
    defaultWidth: 224,
    minWidth: 160,
    maxWidth: 420,
  });

  // Host elements per session — registered via the ref callback below.
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFit = useRef<number | null>(null);
  const initialMountDone = useRef(false);
  const eventsAttached = useRef(false);
  const dataUnsub = useRef<(() => void) | null>(null);
  const exitUnsub = useRef<(() => void) | null>(null);

  // Keep a live ref to cwd so async create paths read the latest workspace.
  const cwdRef = useRef<string | null>(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  // ── Fit the active terminal to its host, syncing PTY size ──────────────────
  const fitSession = useCallback((session: TerminalSession | undefined) => {
    if (!session) return;
    const host = hostsRef.current.get(session.id);
    if (!host || host.offsetWidth === 0) return;
    try {
      session.fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = session.term;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    if (session.alive && (cols !== session.lastDimensions.cols || rows !== session.lastDimensions.rows)) {
      session.lastDimensions = { cols, rows };
      bridge().terminalResize(session.id, cols, rows);
    }
  }, []);

  const scheduleFit = useCallback(() => {
    if (pendingFit.current != null) cancelAnimationFrame(pendingFit.current);
    pendingFit.current = requestAnimationFrame(() => {
      pendingFit.current = null;
      fitSession(sessionsRef.current.get(activeIdRef.current ?? ""));
    });
  }, [fitSession]);

  // ── Global PTY event wiring (attach once a session exists) ──────────────────
  const attachGlobalEvents = useCallback(() => {
    if (eventsAttached.current) return;
    eventsAttached.current = true;
    dataUnsub.current = bridge().events.on("terminal-data", (payload) => {
      const p = payload as TerminalDataPayload | null;
      if (!p) return;
      const session = sessionsRef.current.get(p.id);
      session?.term.write(p.data);
    });
    exitUnsub.current = bridge().events.on("terminal-exit", (payload) => {
      const p = payload as TerminalExitPayload | null;
      if (!p) return;
      const session = sessionsRef.current.get(p.id);
      if (!session) return;
      const exitCode = typeof p.exitCode === "number" ? p.exitCode : "?";
      session.alive = false;
      session.term.writeln("");
      session.term.writeln(`\x1b[2;37m[process exited: ${exitCode}]\x1b[0m`);
      rerender();
    });
  }, [rerender]);

  const detachGlobalEvents = useCallback(() => {
    dataUnsub.current?.();
    exitUnsub.current?.();
    dataUnsub.current = null;
    exitUnsub.current = null;
    eventsAttached.current = false;
  }, []);

  // ── Set active session: show its host, hide the rest, focus + fit ──────────
  const setActiveSession = useCallback((id: string) => {
    if (!sessionsRef.current.has(id)) return;
    activeIdRef.current = id;
    setActiveId(id);
    for (const session of sessionsRef.current.values()) {
      const host = hostsRef.current.get(session.id);
      if (host) host.hidden = session.id !== id;
    }
    rerender();
    scheduleFit();
    const session = sessionsRef.current.get(id);
    session?.term.focus();
  }, [rerender, scheduleFit]);

  // ── Unique title for a freshly-started shell (legacy nextTitleForShell) ────
  const nextTitleForShell = useCallback((shell: string | undefined): string => {
    const base = shortShellName(shell);
    const taken = new Set([...sessionsRef.current.values()].map((s) => s.title));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 999; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }, []);

  // ── Create a session: spin up xterm, register a host, then start the PTY ───
  const createSession = useCallback(async (opts: { cwd?: string; shell?: string } = {}) => {
    attachGlobalEvents();

    const id = newId();
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: codeFontFamily(),
      fontSize: codeFontSize(),
      lineHeight: 1.2,
      scrollback: 5000,
      allowProposedApi: true,
      theme: XTERM_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const sessionCwd = opts.cwd ?? cwdRef.current ?? undefined;
    const session: TerminalSession = {
      id,
      term,
      fitAddon,
      title: `Terminal ${sessionsRef.current.size + 1}`,
      cwd: sessionCwd,
      alive: false,
      createdAt: Date.now(),
      lastDimensions: { cols: 0, rows: 0 },
    };

    term.onData((data) => {
      if (sessionsRef.current.get(id)?.alive) bridge().terminalWrite(id, data);
    });
    term.onResize(({ cols, rows }) => {
      const s = sessionsRef.current.get(id);
      if (!s?.alive) return;
      if (cols !== s.lastDimensions.cols || rows !== s.lastDimensions.rows) {
        s.lastDimensions = { cols, rows };
        bridge().terminalResize(id, cols, rows);
      }
    });

    sessionsRef.current.set(id, session);
    // Render so React creates the host element; its ref callback opens xterm.
    setActiveSession(id);

    // Give React a frame to commit the host <div>; the ref callback normally
    // opens xterm. Fall back to opening here if it hasn't (guard on
    // term.element so we never double-open), then fit for accurate cols/rows.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const host = hostsRef.current.get(id);
    if (host && !term.element) term.open(host);
    fitSession(session);

    try {
      const defaults = getViewSettings();
      const result = (await bridge().terminalCreate({
        id,
        cwd: sessionCwd,
        shell: opts.shell || defaults.terminalShell || undefined,
        cols: term.cols || defaults.terminalCols || 100,
        rows: term.rows || defaults.terminalRows || 30,
      })) as { shell?: string } | null;
      session.alive = true;
      session.title = nextTitleForShell(result?.shell);
      rerender();
      scheduleFit();
      term.focus();
    } catch (error) {
      session.alive = false;
      const message = error instanceof Error ? error.message : String(error);
      term.writeln(`\x1b[1;31mFailed to start terminal: ${message}\x1b[0m`);
      rerender();
    }
    return session;
  }, [attachGlobalEvents, fitSession, nextTitleForShell, rerender, scheduleFit, setActiveSession]);

  // ── Close a session: kill PTY, dispose xterm, pick the next active ─────────
  const closeSession = useCallback((id: string) => {
    const session = sessionsRef.current.get(id);
    if (!session) return;
    try {
      bridge().terminalDispose(id);
    } catch {
      // ignore
    }
    session.term.dispose();
    hostsRef.current.delete(id);
    sessionsRef.current.delete(id);
    if (activeIdRef.current === id) {
      const next = [...sessionsRef.current.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (next) {
        setActiveSession(next.id);
      } else {
        activeIdRef.current = null;
        setActiveId(null);
      }
    }
    rerender();
    if (sessionsRef.current.size === 0) detachGlobalEvents();
  }, [detachGlobalEvents, rerender, setActiveSession]);

  // ── Toolbar actions (legacy clear / restart / toggleSidebar) ───────────────
  const clearActiveTerminal = useCallback(() => {
    sessionsRef.current.get(activeIdRef.current ?? "")?.term.clear();
  }, []);

  const restartActiveTerminal = useCallback(async () => {
    const session = sessionsRef.current.get(activeIdRef.current ?? "");
    if (!session) return;
    const sessionCwd = session.cwd;
    closeSession(session.id);
    await createSession({ cwd: sessionCwd });
  }, [closeSession, createSession]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      void bridge()
        .storeSet("view-settings", "terminalSidebarCollapsed", next ? "1" : "0")
        .catch(() => undefined);
      return next;
    });
    scheduleFit();
  }, [scheduleFit]);

  // ── Load the persisted sidebar-collapsed flag once on mount ────────────────
  useEffect(() => {
    let cancelled = false;
    void bridge()
      .storeGet("view-settings", "terminalSidebarCollapsed")
      .then((value) => {
        if (!cancelled) setSidebarCollapsed(value === "1");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Activate: create the first session when the tab first becomes active ───
  useEffect(() => {
    if (!active) return;
    if (!initialMountDone.current) {
      initialMountDone.current = true;
      void createSession({ cwd: cwdRef.current ?? undefined });
    } else if (sessionsRef.current.size === 0) {
      void createSession({ cwd: cwdRef.current ?? undefined });
    } else {
      scheduleFit();
      sessionsRef.current.get(activeIdRef.current ?? "")?.term.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── Keep the active terminal fitted to its container while active ──────────
  useEffect(() => {
    if (!active) return;
    const host = hostsRef.current.get(activeId ?? "");
    const observed = host?.parentElement ?? null;
    if (!observed) return;
    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(observed);
    window.addEventListener("resize", scheduleFit);
    scheduleFit();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", scheduleFit);
    };
  }, [active, activeId, scheduleFit, sidebarCollapsed]);

  // ── Teardown every PTY + xterm when the tab unmounts ───────────────────────
  useEffect(() => {
    return () => {
      for (const session of sessionsRef.current.values()) {
        try {
          bridge().terminalDispose(session.id);
        } catch {
          // ignore
        }
        session.term.dispose();
      }
      sessionsRef.current.clear();
      hostsRef.current.clear();
      detachGlobalEvents();
      bridge().terminalDisposeWindow?.();
      if (pendingFit.current != null) cancelAnimationFrame(pendingFit.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const sessions = [...sessionsRef.current.values()].sort((a, b) => a.createdAt - b.createdAt);
  const activeSession = activeId ? sessionsRef.current.get(activeId) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* terminal sub-toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
        <IconButton
          title={sidebarCollapsed ? "Show terminals list" : "Hide terminals list"}
          onClick={toggleSidebar}
          active={sidebarCollapsed}
        >
          <SidebarIcon />
        </IconButton>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
          {activeSession?.title || "Terminal"}
          {sessions.length > 1 && (
            <span className="ml-1.5 rounded-full bg-secondary px-1 text-[10px] text-muted-foreground">
              {sessions.length}
            </span>
          )}
        </span>
        <IconButton title="Clear terminal" onClick={clearActiveTerminal} disabled={!activeSession}>
          <ClearIcon />
        </IconButton>
        <IconButton title="Restart terminal" onClick={() => void restartActiveTerminal()} disabled={!activeSession}>
          <RestartIcon />
        </IconButton>
        <IconButton title="New terminal" onClick={() => void createSession({ cwd: cwdRef.current ?? undefined })}>
          <PlusIcon />
        </IconButton>
      </div>

      {/* body: session sidebar + terminal surface */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* session sidebar */}
        {!sidebarCollapsed && (
          <div
            style={{ width: sidebar.width }}
            className="flex shrink-0 flex-col overflow-hidden border-r border-(--surface-divider) bg-card"
          >
            <div className="min-h-0 flex-1 overflow-auto py-1.5">
              {sessions.length === 0 ? (
                <div className="px-3 py-2 text-xs italic text-muted-foreground">No terminals open.</div>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === activeId;
                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      title={session.title}
                      onClick={() => setActiveSession(session.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveSession(session.id);
                        }
                      }}
                      className={
                        "group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-left text-[12.5px] transition-colors duration-(--motion-fast) " +
                        (isActive
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                      }
                    >
                      <span className={"shrink-0 " + (session.alive ? "text-green-400" : "text-muted-foreground/50")}>
                        <TerminalGlyph />
                      </span>
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {session.title}
                      </span>
                      {!session.alive && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">exited</span>
                      )}
                      <button
                        type="button"
                        title="Close terminal"
                        aria-label="Close terminal"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeSession(session.id);
                        }}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity duration-(--motion-fast) hover:text-foreground group-hover:opacity-100"
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
        {!sidebarCollapsed && (
          <ResizeHandle onPointerDown={sidebar.startResize} active={sidebar.resizing} ariaLabel="Resize terminals list" />
        )}

        {/* terminal surface: one always-mounted host per session, toggled by `hidden` */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#0a0a0a]">
          {sessions.map((session) => (
            <div
              key={session.id}
              ref={(el) => {
                if (el) {
                  hostsRef.current.set(session.id, el);
                  el.hidden = session.id !== activeIdRef.current;
                  // Open xterm into the host the moment it mounts. Doing this
                  // here (rather than via a one-rAF wait in createSession) is
                  // robust against the React-commit timing race that left the
                  // PTY live but the surface blank (term never opened).
                  if (!session.term.element) {
                    session.term.open(el);
                    scheduleFit();
                  }
                } else {
                  hostsRef.current.delete(session.id);
                }
              }}
              className="absolute inset-0 p-1.5"
            />
          ))}
          {sessions.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <TerminalGlyph />
              <p className="text-xs">Starting terminal…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
