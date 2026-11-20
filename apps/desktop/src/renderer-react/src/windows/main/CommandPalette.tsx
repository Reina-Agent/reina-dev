// CommandPalette — React port of the legacy Ctrl+P / Ctrl+K command palette
// (apps/desktop/src/renderer/command-palette.js pure view +
// apps/desktop/src/renderer/actions/commands.js registry). Faithful port:
// reproduces the EXACT legacy DOM (same class names / ids / structure as the
// static `#command-palette` block in MainApp.tsx) and reuses the already-linked
// legacy palette.css. ZERO visual/behavioral change.
//
// Design mirrors HitlDock / ComposerPickers: React renders ONLY the static
// shell (`#command-palette` overlay → `.command-panel` → `.command-search-wrap`
// with the `#command-search` input + the empty `#command-results`). The result
// ROWS are built imperatively — byte-for-byte the same `createElement` /
// innerHTML the legacy `renderCommandPaletteView` produces (`<button
// class="command-row"><span/><small/><kbd/></button>`, `.command-empty`) — so
// the list stays identical to legacy with zero re-implementation drift.
//
// Behavior (mirror of the legacy renderer + keymap.js wiring):
//   - Open: Ctrl+K / Ctrl+Shift+P (empty query) and Ctrl+P (legacy primed "@"
//     for the file search; the React chat window has no file pane, so it opens
//     empty — see caveats). The `#topbar-search` button and the public
//     `openCommandPalette()` export open it too.
//   - On open: unhide, set the query, focus + select the input, render rows.
//   - Search input `input` → re-render the filtered list.
//   - Search input `Enter` → run the first non-disabled `.command-row` (legacy
//     runFirstPaletteCommand: it `.click()`s the first enabled row).
//   - Search input `Escape` → close (refocus the `#prompt` textarea, as legacy
//     closeCommandPaletteView refocused promptEl).
//   - Backdrop click (event.target === overlay) → close.
//   - Running a command closes the palette first, then runs.
//
// Note on keyboard nav: the LEGACY palette has NO ↑/↓ arrow navigation —
// highlight is hover/focus via CSS (.command-row:hover/:focus) and Enter runs
// the first enabled row. This port reproduces that exactly (no arrow nav added).
//
// The command registry below is the React-equivalent of buildBaseCommands:
// each command is wired to the existing React action where one exists
// (sessionStore: newDraftSession / interrupt; setLayout toggles; agentSettings:
// setMode / setSessionMode; bridge: openSettingsWindow / openWorkspaceWindow /
// reloadRenderer). Commands whose target subsystem is NOT yet ported to React
// (file search, prompt context, prompt templates, per-profile agent switch,
// skill picker, rules scaffolding, compaction) are either omitted or made
// safe no-ops — see the caveats in the task report. The dynamic command groups
// (prompts / agent profiles) are intentionally not reproduced. Zoom (in/out/
// reset) IS wired — palette commands + Ctrl+=/Ctrl+-/Ctrl+0 keybindings.

import { useEffect, useRef } from "react";
import { bridge } from "~/lib/bridge";
import { displayKeybind } from "~/lib/keybinds";
import {
  appendSystemNotice,
  compactSession,
  getMainState,
  interrupt,
  newDraftSession,
  setLayout,
  toggleHitlDock,
} from "./sessionStore";
import {
  PERMISSION_MODES,
  getAgentSettingsState,
  setMode,
  setSessionMode,
} from "./agentSettings";

// ── Command shape (mirror legacy command objects) ───────────────────────────

interface Command {
  id: string;
  title: string;
  category: string;
  keybind?: string;
  slash?: string;
  disabled?: () => boolean;
  run: () => void | Promise<void>;
}

// Prime the composer textarea with a slash command (mirror the legacy
// team/goal/verify/cancel entries that set promptEl.value + caret). The React
// composer textarea ships with id="prompt", same as legacy.
function primeComposer(text: string): void {
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
  if (!prompt) return;
  prompt.value = text;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  // Fire `input` so the React composer's onChange syncs its controlled state /
  // autosize / slash-popover (the composer listens on the textarea).
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

// Cycle the permission mode forward (mirror legacy cyclePermissionMode →
// Shift+Tab). Wraps around the PERMISSION_MODES list. Exported so the Composer
// can wire the Shift+Tab keybinding its mode-button tooltip advertises.
export function cyclePermissionMode(): void {
  const current = getAgentSettingsState().agentSettings.modeId;
  const index = PERMISSION_MODES.findIndex((mode) => mode.id === current);
  const next = PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length];
  setMode(next.id);
}

// Open the desktop log file (mirror legacy renderer.js openLog): the main
// process writes to `<repoRoot>/reina-desktop.log` (main/logging.ts), and
// default_cwd resolves that repo root. openPath hands it to the OS.
async function openLog(): Promise<void> {
  const api = bridge();
  const cwd = (await api.invoke("default_cwd").catch(() => null)) as string | null;
  if (!cwd) return;
  await api.openPath(`${cwd}/reina-desktop.log`).catch(() => undefined);
}

// Scaffold the rules files (mirror legacy renderer.js scaffoldRulesFiles): create
// AGENTS.md + workspace/global rules.md only when absent, post a system notice,
// then open Settings → Rules. Uses the same readRulesFile/writeRulesFile bridge
// the rules editor uses (fileKey "rules.md@workspace" / "rules.md@global").
async function scaffoldRules(): Promise<void> {
  const cwd = getMainState().workspaceCwd;
  if (!cwd) {
    appendSystemNotice("Open a workspace first.");
    return;
  }
  const api = bridge();
  const projectName = cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "project";
  const files: Array<{ key: string; template: string }> = [
    { key: "AGENTS.md", template: `# ${projectName}\n\nWorkspace notes for collaborators.\n` },
    { key: "rules.md@workspace", template: "# Workspace rules\n\n- <project-specific rule>\n" },
    { key: "rules.md@global", template: "# Global rules\n\nThese rules apply to every workspace.\n\n- <user-wide rule>\n" },
  ];
  try {
    for (const { key, template } of files) {
      const existing = (await api.readRulesFile(cwd, key)) as { exists?: boolean } | null;
      if (!existing?.exists) await api.writeRulesFile(cwd, key, template);
    }
    appendSystemNotice(`Scaffolded rules in ${cwd}. Open Settings → Rules to edit.`);
    void api.openSettingsWindow("rules");
  } catch (error) {
    appendSystemNotice(error instanceof Error ? error.message : String(error));
  }
}

// Renderer zoom (mirror legacy commands.js zoom: clamp 0.7–1.6, step 0.1, via
// the getZoomFactor/setZoomFactor bridge). Kept here so both the palette
// commands and the Ctrl+=/Ctrl+-/Ctrl+0 keybindings share one implementation.
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
async function adjustZoom(delta: number): Promise<void> {
  const api = bridge();
  const current = await api.getZoomFactor().catch(() => 1);
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((current + delta) * 10) / 10));
  await api.setZoomFactor(next);
}
async function resetZoom(): Promise<void> {
  await bridge().setZoomFactor(1).catch(() => undefined);
}

// The base command registry — React-equivalent of buildBaseCommands. Only the
// commands whose target subsystem exists in the React chat window are wired to a
// real action; the rest are omitted (see caveats). Order matches legacy where
// the entry is reproduced.
function buildCommands(): Command[] {
  const api = bridge();
  return [
    {
      id: "command.palette",
      title: "Open command palette",
      category: "General",
      keybind: "Ctrl+K",
      slash: "/commands",
      run: () => openCommandPalette(),
    },
    {
      id: "session.new",
      title: "New session",
      category: "Session",
      keybind: "Ctrl+Shift+S",
      slash: "/new",
      disabled: () => !getMainState().workspaceCwd,
      run: () => void newDraftSession(),
    },
    {
      id: "workspace.open",
      title: "Open workspace",
      category: "Workspace",
      keybind: "Ctrl+O",
      slash: "/open",
      disabled: () => getMainState().working,
      run: () => void api.openWorkspaceWindow(),
    },
    {
      // /team <task> — prime the composer; the actual escalation happens when
      // the user submits the slash command (mirror legacy team.escalate).
      id: "team.escalate",
      title: "Team mode: dispatch task with DAG coordination",
      category: "Agent",
      slash: "/team",
      disabled: () => {
        const s = getMainState();
        return s.working || s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0 || !s.sessionId;
      },
      run: () => primeComposer("/team "),
    },
    {
      id: "goal.set",
      title: "Goal: pursue a durable objective until independently verified",
      category: "Agent",
      slash: "/goal",
      disabled: () => {
        const s = getMainState();
        return s.working || s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0 || !s.sessionId;
      },
      run: () => primeComposer("/goal "),
    },
    {
      id: "verify.run",
      title: "Verify: pause and check the last claim with evidence",
      category: "Agent",
      slash: "/verify",
      disabled: () => {
        const s = getMainState();
        return s.working || s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0 || !s.sessionId;
      },
      run: () => primeComposer("/verify "),
    },
    {
      id: "cancel.all",
      title: "Cancel: gracefully wind down autopilot + async tasks + phase",
      category: "Agent",
      slash: "/cancel",
      disabled: () => {
        const s = getMainState();
        return s.working || s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0 || !s.sessionId;
      },
      run: () => primeComposer("/cancel "),
    },
    {
      id: "session.interrupt",
      title: "Interrupt current turn",
      category: "Session",
      keybind: "Esc",
      slash: "/interrupt",
      disabled: () => {
        const s = getMainState();
        return !s.working || s.stopping || !s.sessionId;
      },
      run: () => void interrupt(),
    },
    {
      id: "hitl.toggle",
      title: "Toggle approval dock",
      category: "Session",
      slash: "/approval",
      disabled: () => {
        const s = getMainState();
        return s.pendingPermissions.length === 0 && s.pendingQuestions.length === 0;
      },
      run: () => toggleHitlDock(),
    },
    {
      id: "logs.open",
      title: "Open desktop log",
      category: "Help",
      slash: "/logs",
      run: () => void openLog(),
    },
    {
      id: "mode.cycle",
      title: "Cycle permission mode (Shift+Tab)",
      category: "Agent",
      slash: "/mode",
      run: () => cyclePermissionMode(),
    },
    {
      id: "session.clear",
      title: "Clear current session (start fresh)",
      category: "Session",
      slash: "/clear",
      disabled: () => getMainState().working,
      run: () => void newDraftSession(),
    },
    {
      id: "session.compact",
      title: "Compact conversation history",
      category: "Session",
      slash: "/compact",
      disabled: () => getMainState().working || !getMainState().sessionId,
      run: () => void compactSession(),
    },
    {
      id: "rules.init",
      title: "Generate CLAUDE.md / AGENTS.md scaffolding",
      category: "Rules",
      slash: "/init",
      disabled: () => !getMainState().workspaceCwd,
      run: () => void scaffoldRules(),
    },
    {
      id: "rules.edit",
      title: "Edit project rules (CLAUDE.md / AGENTS.md / memory)",
      category: "Rules",
      slash: "/rules",
      run: () => void api.openSettingsWindow("rules"),
    },
    {
      id: "settings.open",
      title: "Open settings",
      category: "General",
      slash: "/settings",
      run: () => void api.openSettingsWindow(),
    },
    {
      id: "settings.models",
      title: "Open settings → Models",
      category: "General",
      slash: "/model",
      run: () => void api.openSettingsWindow("models"),
    },
    {
      id: "settings.agents",
      title: "Open settings → Agents",
      category: "General",
      slash: "/agents",
      run: () => void api.openSettingsWindow("agents"),
    },
    {
      id: "settings.permissions",
      title: "Open settings → Permissions",
      category: "General",
      slash: "/permissions",
      run: () => void api.openSettingsWindow("permissions"),
    },
    {
      id: "settings.outputStyle",
      title: "Open settings → Output Style",
      category: "General",
      slash: "/output-style",
      run: () => void api.openSettingsWindow("agents"),
    },
    {
      // Team remains a session-mode toggle. Goal is a dedicated lifecycle and
      // starts through `/goal`, so there is deliberately no Goal mode toggle.
      id: "mode.toggle.team",
      title: "Toggle session mode → Team",
      category: "Agent",
      run: () => void setSessionMode("team", !(getAgentSettingsState().sessionModes.team === true)),
    },
    {
      // Layout toggles — React-only conveniences backed by setLayout (the legacy
      // palette toggled panes through workspaceActions; here they map to the
      // store's collapse flags the legacy CSS keys off).
      id: "view.toggleSessions",
      title: "Toggle session sidebar",
      category: "View",
      // Pop the floating session-sidebar window (legacy default placement), same
      // as the topbar toggle. The main process broadcasts session-sidebar-state,
      // which MainApp reflects onto the toggle button + inline pane.
      run: () => void bridge().toggleSessionSidebarWindow().catch(() => undefined),
    },
    {
      id: "view.toggleTask",
      title: "Toggle task panel",
      category: "View",
      run: () => setLayout({ taskOpen: !getMainState().layout.taskOpen }),
    },
    {
      id: "view.zoomIn",
      title: "Zoom in",
      category: "View",
      keybind: "Ctrl++",
      run: () => void adjustZoom(0.1),
    },
    {
      id: "view.zoomOut",
      title: "Zoom out",
      category: "View",
      keybind: "Ctrl+-",
      run: () => void adjustZoom(-0.1),
    },
    {
      id: "view.zoomReset",
      title: "Reset zoom",
      category: "View",
      keybind: "Ctrl+0",
      run: () => void resetZoom(),
    },
    {
      id: "view.reload",
      title: "Reload window",
      category: "View",
      run: () => void api.reloadRenderer(),
    },
  ];
}

// ── Module-level palette machinery (mirror the legacy openCommandPalette /
// closeCommandPalette closures over the static DOM nodes) ────────────────────
//
// The legacy renderer kept the palette open/close/render functions bound to the
// `#command-palette` / `#command-search` / `#command-results` DOM nodes via the
// `els` map. We keep the same shape, bound to the live nodes the React
// component owns via refs, set at mount.

let paletteEl: HTMLDivElement | null = null;
let searchEl: HTMLInputElement | null = null;
let resultsEl: HTMLDivElement | null = null;

// Build once at mount so the command closures keep a stable identity for the
// session (legacy built the base commands once too).
let commands: Command[] = [];

function renderPalette(): void {
  if (!searchEl || !resultsEl) return;
  const query = searchEl.value.trim().toLowerCase();
  resultsEl.textContent = "";
  // Legacy: a leading "@" switches to file search. The React chat window has no
  // file pane / workspaceFiles, so there are no files to list — render the empty
  // state, matching legacy's "No files" when the workspace has none.
  if (query.startsWith("@")) {
    renderEmpty(resultsEl, "No files");
    return;
  }
  const filtered = commands.filter((command) => {
    const haystack = `${command.title} ${command.category} ${command.id} ${command.slash || ""}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  for (const command of filtered) {
    const row = document.createElement("button");
    row.className = "command-row";
    row.disabled = Boolean(command.disabled?.());
    row.innerHTML = "<span></span><small></small><kbd></kbd>";
    row.querySelector("span")!.textContent = command.title;
    row.querySelector("small")!.textContent = command.category;
    row.querySelector("kbd")!.textContent = command.keybind ? displayKeybind(command.keybind) : command.slash || "";
    row.onclick = () => {
      closeCommandPalette();
      void runCommand(command.id);
    };
    resultsEl.appendChild(row);
  }
  if (filtered.length === 0) renderEmpty(resultsEl, "No commands");
}

function renderEmpty(parent: HTMLElement, text: string): void {
  const empty = document.createElement("div");
  empty.className = "command-empty";
  empty.textContent = text;
  parent.appendChild(empty);
}

async function runCommand(id: string): Promise<void> {
  const command = commands.find((entry) => entry.id === id);
  if (!command || command.disabled?.()) return;
  try {
    await command.run();
  } catch (error) {
    console.error(error);
  }
}

/** Execute a "/foo" slash token against the command registry (mirror the tail of
 * legacy runSlashCommand: find the command whose `slash` matches and run it; if
 * none matches, open the palette seeded with the raw message). Exported for
 * runSlashCommand.ts, which handles the steer/switch special-cases first and only
 * delegates the generic tokens here. `commands` is built at palette mount and the
 * palette is always mounted, so the registry is populated by the time a user can
 * send. */
export async function runSlashByToken(name: string, message: string): Promise<void> {
  const command = commands.find((entry) => entry.slash === name);
  if (!command) {
    openCommandPalette(message);
    return;
  }
  if (command.disabled?.()) return;
  try {
    await command.run();
  } catch (error) {
    console.error(error);
  }
}

// Run the first non-disabled row (mirror legacy runFirstPaletteCommand: it
// queried `.command-row:not(:disabled)` and clicked it — which closes + runs).
function runFirstPaletteCommand(): void {
  if (!resultsEl) return;
  const first = resultsEl.querySelector<HTMLButtonElement>(".command-row:not(:disabled)");
  first?.click();
}

/** Open the palette with an optional initial query. Exported so the parent can
 * wire the `#topbar-search` button + the global Ctrl+P/K keybinding to it
 * (mirror legacy actions.openCommandPalette). */
export function openCommandPalette(query = ""): void {
  if (!paletteEl || !searchEl) return;
  paletteEl.hidden = false;
  searchEl.value = query;
  renderPalette();
  searchEl.focus();
  searchEl.select();
}

/** Close the palette and refocus the composer (mirror legacy
 * closeCommandPaletteView, which refocused promptEl). */
export function closeCommandPalette(): void {
  if (!paletteEl) return;
  paletteEl.hidden = true;
  (document.getElementById("prompt") as HTMLTextAreaElement | null)?.focus();
}

function paletteIsOpen(): boolean {
  return Boolean(paletteEl && !paletteEl.hidden);
}

// ── React shell ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const paletteRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Bind the module-level machinery to the live DOM nodes + build the command
  // registry once on mount.
  useEffect(() => {
    paletteEl = paletteRef.current;
    searchEl = searchRef.current;
    resultsEl = resultsRef.current;
    commands = buildCommands();
    return () => {
      paletteEl = null;
      searchEl = null;
      resultsEl = null;
      commands = [];
    };
  }, []);

  // Native application-menu items (File→New Session, View→Command Palette,
  // macOS app menu→Settings…) arrive as menu-command events carrying a command
  // id from this registry. Without this listener the menu is dead — and on
  // macOS the menu ACCELERATORS are handled by the system before the page sees
  // the keydown, so ⌘K/⌘⇧S themselves depend on this wiring there.
  useEffect(() => {
    return bridge().events.on("menu-command", (payload) => {
      if (typeof payload === "string") void runCommand(payload);
    });
  }, []);

  // Global keybindings (mirror legacy keymap.js window keydown): Ctrl/Cmd+P,
  // Ctrl/Cmd+K, Ctrl/Cmd+Shift+P open; Escape closes when open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (mod && key === "p" && !event.shiftKey) {
        event.preventDefault();
        // Legacy primed "@" (file search); no file pane in React → open empty.
        openCommandPalette();
        return;
      }
      if (mod && (key === "k" || (event.shiftKey && key === "p"))) {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      // Renderer zoom (mirror legacy keymap.js): Ctrl/Cmd +/-/0.
      if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        void adjustZoom(0.1);
        return;
      }
      if (mod && key === "-") {
        event.preventDefault();
        void adjustZoom(-0.1);
        return;
      }
      if (mod && key === "0") {
        event.preventDefault();
        void resetZoom();
        return;
      }
      if (event.key === "Escape" && paletteIsOpen()) {
        event.preventDefault();
        closeCommandPalette();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      id="command-palette"
      className="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      hidden
      ref={paletteRef}
      onClick={(event) => {
        // Backdrop click closes (mirror legacy: target === commandPalette).
        if (event.target === event.currentTarget) closeCommandPalette();
      }}
    >
      <div className="command-panel">
        <div className="command-search-wrap">
          <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
            <use href="#i-search" />
          </svg>
          <input
            id="command-search"
            aria-label="Search commands"
            placeholder="Search commands"
            autoComplete="off"
            spellCheck={false}
            ref={searchRef}
            onChange={renderPalette}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeCommandPalette();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                runFirstPaletteCommand();
              }
            }}
          />
        </div>
        {/* Result rows built imperatively to stay byte-identical to legacy
            renderCommandPaletteView. */}
        <div id="command-results" className="command-results" ref={resultsRef} />
      </div>
    </div>
  );
}
