// WorkspaceSwitcher — React port of the legacy actions/workspace-switcher.js
// sidebar project card + workspace switcher popover. Faithful port: reproduces
// the EXACT legacy DOM (same class names / ids / structure as the static
// `#project-card` section + `#workspace-popover` div in main.html /
// MainApp.tsx) and reuses the already-linked legacy session.css. ZERO
// visual/behavioral change.
//
// The control is two pieces:
//   - `#project-card`: a role="button" card showing the CURRENT workspace
//     (folder icon + #project-name + #project-path + caret). Clicking (or
//     Enter/Space) toggles the popover. Its text is driven from the desktop
//     store, mirroring the legacy `renderProject(cwd)` in actions/session.js.
//   - `#workspace-popover`: a menu listing recent workspaces (Recent section)
//     plus a pinned footer (Open Folder… / Close Workspace). Selecting a row
//     switches the active workspace.
//
// Design mirrors ComposerPickers: React renders ONLY the static shell (the
// `#project-card` section + the empty `#workspace-popover` element). The popover
// CONTENT is built imperatively — byte-for-byte the same `createElement` /
// innerHTML the legacy `renderPopover` produces — so the popover stays identical
// to legacy with zero re-implementation drift. The card's #project-name /
// #project-path / title are React-rendered from the store (mirror of
// renderProject).
//
// Notes vs legacy:
//   - "Active workspace cwd" — legacy tracked `state.activeWorkspaceCwd`; the
//     React main store's equivalent is `workspaceCwd` (sessionStore). We read it
//     for the active-row highlight + Close-Workspace visibility.
//   - switchWorkspace — legacy ran in either the main or floating-sidebar
//     window; the React chat window is ALWAYS the main window, so we take the
//     main-window branch: open_workspace + load the workspace (touchWorkspace,
//     refresh desktop state, resume the latest live session or start a fresh
//     draft). The sidebar-only `openWorkspaceInMain` hop is not needed here.
//   - Welcome screen — the React welcome overlay (Welcome.tsx) is gated on
//     `Boolean(workspaceCwd)`, so closing the current workspace nulls
//     workspaceCwd via clearWorkspaceToWelcome() to re-show it, matching the
//     legacy renderer's showWelcome().
//   - `lastUsedAt` — legacy sorts recent workspaces by it; the React
//     DesktopWorkspace type doesn't declare the field, so we read it defensively
//     (same sort, missing-value-safe).

import { useEffect, useRef } from "react";
import { bridge } from "~/lib/bridge";
import { isSidebarWindow } from "~/lib/windowKind";
import { ProjectManager, openProjectManager, requestRemoveWorkspace } from "./ProjectManager";
import { shortPath } from "./sessionHelpers";
import {
  clearWorkspaceToWelcome,
  getMainState,
  loadSession,
  newDraftSession,
  refreshDesktopState,
  useMainStore,
} from "./sessionStore";
import type { DesktopState, DesktopWorkspace, SessionListItem } from "./protocol";

// ── Module-level popover machinery (mirror of the legacy closures) ─────────────
//
// The legacy file kept a single `#workspace-popover` element plus a pair of
// outside-click / Escape listeners installed only while the popover is open. We
// keep the same shape, bound to the live DOM nodes the React component owns via
// refs, set at mount.

let popoverEl: HTMLDivElement | null = null;
let cardEl: HTMLElement | null = null;

function popoverIsOpen(): boolean {
  return Boolean(popoverEl && !popoverEl.hidden);
}

function closePopover(): void {
  if (!popoverEl) return;
  popoverEl.hidden = true;
  popoverEl.textContent = "";
  cardEl?.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onOutsideClick, true);
  document.removeEventListener("keydown", onPopoverKey, true);
}

function onOutsideClick(event: Event): void {
  const target = event.target as Node;
  if (popoverEl?.contains(target)) return;
  if (cardEl?.contains(target)) return;
  closePopover();
}

function onPopoverKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closePopover();
  }
}

// Read the most-recent workspaces from desktop state, sorted desc by
// lastUsedAt. Returns at most 10. (mirror legacy recentWorkspaces)
function recentWorkspaces(): DesktopWorkspace[] {
  const workspaces = getMainState().desktop?.workspaces ?? [];
  return [...workspaces]
    .sort((a, b) => lastUsedAt(b).localeCompare(lastUsedAt(a)))
    .slice(0, 10);
}

function lastUsedAt(ws: DesktopWorkspace): string {
  return ws.lastUsedAt ?? "";
}

// Just the folder name for the row's primary line — the full path is shown on
// the secondary line below it. (mirror legacy workspaceLabel)
function workspaceLabel(workspace: DesktopWorkspace): string {
  const normalized = shortPath(workspace.cwd || "").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || normalized || workspace.cwd;
}

// Load a workspace end-to-end in THIS (main) window: persist + open the
// SessionStore, refresh desktop state, then resume the most recent live session
// in that workspace (or start a fresh draft). Mirror of the legacy main-window
// loadWorkspace (renderer.js), expressed via the React store actions.
export async function loadWorkspace(cwd: string): Promise<void> {
  if (!cwd) return;
  // Persist on the main process so the next launch can auto-restore; also tells
  // the agent-host to open this workspace's SessionStore.
  await bridge()
    .touchWorkspace(cwd)
    .catch(() => null);
  await bridge()
    .invoke("open_workspace", { cwd })
    .catch(() => undefined);
  await refreshDesktopState();
  // Pick a session to display: most recent live one in this cwd, else a fresh
  // draft.
  const sessions = (getMainState().desktop?.sessions ?? []).filter(
    (s) => s.cwd === cwd && !s.archivedAt,
  );
  const latest: SessionListItem | undefined = sessions[0];
  if (latest) {
    await loadSession(latest);
    return;
  }
  await newDraftSession(cwd);
}

async function switchWorkspace(cwd: string): Promise<void> {
  if (!cwd) return;
  closePopover();
  // In the floating sidebar window the chat/engine lives in the MAIN window, so
  // switching workspaces here delegates to it over IPC (the main window then
  // loads the workspace + resumes a session). Mirrors the legacy
  // workspace-switcher.js sidebar branch (openWorkspaceInMain).
  if (isSidebarWindow) {
    await bridge().openWorkspaceInMain(cwd).catch((error) => console.error(error));
    return;
  }
  try {
    await bridge().invoke("open_workspace", { cwd });
    await loadWorkspace(cwd);
  } catch (error) {
    console.error(error);
  }
}

async function pickFolder(): Promise<void> {
  try {
    const picked = await bridge().openDirectoryPicker({ title: "Open workspace" });
    if (!picked) return;
    await switchWorkspace(picked);
  } catch (error) {
    console.error(error);
  }
}

async function closeCurrentWorkspace(): Promise<void> {
  const cwd = getMainState().workspaceCwd;
  if (!cwd) return;
  closePopover();
  try {
    await bridge().invoke("close_workspace", { cwd });
  } catch (error) {
    // close_workspace refuses if a session is still loaded; treat that as a
    // successful "do nothing".
    console.error(error);
  }
  await bridge()
    .clearActiveWorkspace()
    .catch(() => null);
  await refreshDesktopState();
  // Null out workspaceCwd + active session so the Welcome overlay re-shows,
  // matching the legacy renderer's showWelcome() on close.
  clearWorkspaceToWelcome();
}

// Removal (hover × / manager rows) lives in ProjectManager: one confirm dialog
// with an opt-in "also delete .reina data" checkbox, shared by every entry
// point. The × below just forwards to requestRemoveWorkspace.

// Build the popover content imperatively — byte-for-byte the legacy renderPopover
// markup — so it stays identical to legacy with zero re-implementation drift.
function renderPopover(): void {
  if (!popoverEl) return;
  popoverEl.textContent = "";
  const activeCwd = getMainState().workspaceCwd;
  // Scrollable list region — recent workspaces grow here without pushing the
  // footer actions out of view.
  const list = document.createElement("div");
  list.className = "workspace-popover-list";
  const recent = recentWorkspaces();
  if (recent.length > 0) {
    const title = document.createElement("div");
    title.className = "workspace-popover-section-title";
    title.textContent = "Recent";
    list.appendChild(title);
    for (const ws of recent) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workspace-popover-row" + (activeCwd === ws.cwd ? " active" : "");
      const name = document.createElement("span");
      name.textContent = workspaceLabel(ws);
      const pathEl = document.createElement("span");
      pathEl.className = "workspace-popover-row-path";
      pathEl.textContent = ws.cwd;
      row.appendChild(name);
      row.appendChild(pathEl);
      row.onclick = () => void switchWorkspace(ws.cwd);
      // Hover-revealed × — opens the shared remove-confirm dialog (top-layer
      // <dialog> owned by ProjectManager, so it stacks above this popover). A
      // span (not a nested <button>, which is invalid HTML inside the row
      // button); stopPropagation keeps the row's switch handler from firing.
      const remove = document.createElement("span");
      remove.className = "workspace-popover-row-remove";
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", `Remove ${workspaceLabel(ws)}…`);
      remove.title = "Remove…";
      remove.innerHTML = `<svg class="icon"><use href="#i-x"/></svg>`;
      remove.onclick = (event) => {
        event.stopPropagation();
        // Close the popover first — any click inside the top-layer dialog
        // would land in our outside-click handler and close it anyway; doing
        // it deliberately avoids a half-dead popover behind the dialog.
        closePopover();
        requestRemoveWorkspace(ws);
      };
      row.appendChild(remove);
      list.appendChild(row);
    }
  }
  popoverEl.appendChild(list);
  // Pinned footer — Open Folder / Close Workspace stay put while the list above
  // scrolls.
  const footer = document.createElement("div");
  footer.className = "workspace-popover-footer";
  const openFolder = document.createElement("button");
  openFolder.type = "button";
  openFolder.className = "workspace-popover-action";
  openFolder.innerHTML = `<svg class="icon"><use href="#i-folder"/></svg><span>Open Folder…</span>`;
  openFolder.onclick = () => void pickFolder();
  footer.appendChild(openFolder);
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "workspace-popover-action";
  manage.innerHTML = `<svg class="icon"><use href="#i-folder-open"/></svg><span>Manage Projects…</span>`;
  manage.onclick = () => {
    closePopover();
    openProjectManager();
  };
  footer.appendChild(manage);
  if (activeCwd) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "workspace-popover-action";
    close.innerHTML = `<svg class="icon"><use href="#i-x"/></svg><span>Close Workspace</span>`;
    close.onclick = () => void closeCurrentWorkspace();
    footer.appendChild(close);
  }
  popoverEl.appendChild(footer);
}

function openPopover(): void {
  if (!popoverEl) return;
  renderPopover();
  // The list renders instantly from the cached store, then re-renders once a
  // fresh desktop state lands — picks up mutations made from OTHER windows
  // (e.g. the settings Projects panel removing a workspace).
  void refreshDesktopState()
    .then(() => {
      if (popoverIsOpen()) renderPopover();
    })
    .catch(() => undefined);
  popoverEl.hidden = false;
  cardEl?.setAttribute("aria-expanded", "true");
  // Defer listener install so the click that opened us doesn't close it.
  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onPopoverKey, true);
  }, 0);
}

function togglePopover(): void {
  if (popoverIsOpen()) closePopover();
  else openPopover();
}

// ── Project-card text (mirror legacy renderProject in actions/session.js) ──────

interface ProjectCardText {
  name: string;
  path: string;
  title: string;
}

function projectCardText(desktop: DesktopState | null, cwd: string | null): ProjectCardText {
  if (!cwd) {
    // No workspace yet — keep the legacy main.html static defaults.
    return { name: "Reina", path: "Loading workspace", title: "Click to switch workspace" };
  }
  const workspace = desktop?.workspaces?.find(
    (item) => item.cwd === cwd || item.id === desktop?.activeWorkspaceId,
  );
  const project = workspace
    ? desktop?.projects?.find((item) => item.id === workspace.projectId)
    : undefined;
  if (project) {
    const path = workspace?.cwd || project.root;
    return { name: project.name ?? path, path, title: path };
  }
  const normalized = cwd.replaceAll("\\", "/");
  const fallbackName = normalized.split("/").filter(Boolean).at(-1) || "Workspace";
  return { name: fallbackName, path: cwd, title: cwd };
}

// ── React shell ────────────────────────────────────────────────────────────────

export function WorkspaceSwitcher() {
  // Card text is driven from the store (mirror applyComposerLabels-style live
  // subscription). renderProject reads both the active cwd and the desktop state.
  const workspaceCwd = useMainStore((s) => s.workspaceCwd);
  const desktop = useMainStore((s) => s.desktop);

  const cardRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Bind the module-level popover machinery to the live DOM nodes on mount.
  useEffect(() => {
    cardEl = cardRef.current;
    popoverEl = popoverRef.current;
    return () => {
      closePopover();
      cardEl = null;
      popoverEl = null;
    };
  }, []);

  const onCardClick = (event: React.MouseEvent) => {
    // Avoid the click instantly closing the popover via outside-click.
    event.stopPropagation();
    togglePopover();
  };

  const onCardKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePopover();
    }
  };

  const text = projectCardText(desktop, workspaceCwd);

  return (
    <>
      <section
        className="project-card"
        id="project-card"
        role="button"
        tabIndex={0}
        title={text.title}
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-controls="workspace-popover"
        aria-expanded="false"
        ref={cardRef}
        onClick={onCardClick}
        onKeyDown={onCardKeyDown}
      >
        <svg className="icon project-card-icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
          <use href="#i-folder" />
        </svg>
        <div>
          <h1 id="project-name">{text.name}</h1>
          <p id="project-path">{text.path}</p>
        </div>
        <svg className="icon project-card-caret" viewBox="0 0 24 24" aria-hidden focusable={false}>
          <use href="#i-chevron-down" />
        </svg>
      </section>
      {/* Shared workspace popover. Content built imperatively to stay
          byte-identical to legacy renderPopover. */}
      <div
        className="workspace-popover"
        id="workspace-popover"
        role="menu"
        aria-label="Workspace switcher"
        hidden
        ref={popoverRef}
      />
      {/* Manage Projects modal + the shared remove-confirm dialog (also
          serves the popover's hover ×). Portals to document.body. */}
      <ProjectManager
        onOpenWorkspace={switchWorkspace}
        onChanged={() => {
          if (popoverIsOpen()) renderPopover();
        }}
      />
    </>
  );
}
