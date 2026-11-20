// SessionContextMenu — React port of the legacy session-row context menu
// (apps/desktop/src/renderer/context-menu.js + the session-row actions in
// apps/desktop/src/renderer/actions/session.js: openSessionContextMenu /
// startInlineRename / applyRename / togglePinSession / toggleArchiveSession /
// deleteIndexedSession).
//
// Faithful tech-stack swap: ZERO visual/behavioral change. Reproduces the EXACT
// legacy DOM (.context-menu / .context-menu-item / .context-menu-separator with
// the inner <span class="label">, plus the #rename-session-dialog .rename-dialog
// native <dialog>) and reuses the already-linked legacy sidebar.css verbatim. No
// Tailwind, no new styles.
//
// Design mirrors HitlDock / ComposerPickers: React renders ONLY the static
// shells (a shared host <div> the menu mounts into + the rename <dialog>). The
// menu body is built imperatively — byte-for-byte the same createElement the
// legacy `openContextMenu` produced — so the popup stays identical with zero
// drift. The component exposes a module-level imperative API
// (`openSessionContextMenu`, `startSessionRename`) so the SessionList rows can
// trigger it from a right-click / ⋯ button / double-click WITHOUT SessionList
// having to render the menu itself.
//
// Bridge mapping (legacy desktop.* → typed React bridge()):
//   renameSession / deleteSession / setSessionFlags / clipboardWrite /
//   invoke("update_session_config") / invoke("close_session").
// Store: refreshDesktopState() (re-pull desktop state after a mutation),
//   loadSession() ("Open" a row), getMainState() (active-session checks).

import { useEffect, useRef } from "react";
import { bridge } from "~/lib/bridge";
import { forgetSession, getMainState, loadSession, newDraftSession, refreshDesktopState, subscribeMainStore } from "./sessionStore";
import type { SessionListItem } from "./protocol";

// ── Module-level singletons (mirror of the legacy file globals) ─────────────────
//
// The legacy context-menu.js kept a single `active` menu element + a set of
// global outside-click / Escape / scroll / blur / resize listeners installed
// only while a menu is open. We keep the same shape, bound to the live host
// element the React component owns via a ref (set at mount).

let menuHostEl: HTMLDivElement | null = null;
let dialogEl: HTMLDialogElement | null = null;
let inputEl: HTMLInputElement | null = null;
let cancelButtonEl: HTMLButtonElement | null = null;

// The currently-open menu node (appended into menuHostEl). Null when closed.
let activeMenu: HTMLDivElement | null = null;
// The row that opened the active menu (gets the `.context-target` highlight).
let activeTarget: HTMLElement | null = null;

interface MenuItemSpec {
  label?: string;
  onSelect?: (event: MouseEvent) => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  separator?: boolean;
}

// ── Outside-click / keyboard / viewport listeners (mirror legacy close wiring) ──

function closeMenu(): void {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  if (activeTarget) {
    activeTarget.classList.remove("context-target");
    activeTarget = null;
  }
  document.removeEventListener("mousedown", onOutsideMouse, true);
  document.removeEventListener("keydown", onMenuKey, true);
  document.removeEventListener("scroll", closeMenu, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
}

function onOutsideMouse(event: MouseEvent): void {
  if (!activeMenu) return;
  if (activeMenu.contains(event.target as Node)) return;
  closeMenu();
}

function onMenuKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeMenu();
  }
}

// Clamp the menu into the viewport (mirror legacy `position`). The element is
// `position: fixed`, so clientX/clientY map directly to left/top.
function positionMenu(menu: HTMLDivElement, x: number, y: number): void {
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
}

// Build + show a dark popup at (x, y) with the given items (mirror legacy
// `openContextMenu`). Items: { label, onSelect, danger?, disabled?, shortcut? }
// or { separator: true }.
// Exported for other main-window surfaces (ProjectManager's row ⋮ menu) —
// same look, positioning, and close wiring as the session-row menu.
export function openAppContextMenu(options: { x: number; y: number; items: MenuItemSpec[] }): void {
  openContextMenu(options);
}

function openContextMenu({ x, y, items }: { x: number; y: number; items: MenuItemSpec[] }): void {
  closeMenu();
  if (!menuHostEl) return;
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item" + (item.danger ? " danger" : "");
    if (item.disabled) button.disabled = true;
    button.setAttribute("role", "menuitem");
    button.innerHTML = `<span class="label"></span>${item.shortcut ? `<span class="shortcut"></span>` : ""}`;
    (button.querySelector(".label") as HTMLElement).textContent = item.label ?? "";
    if (item.shortcut) (button.querySelector(".shortcut") as HTMLElement).textContent = item.shortcut;
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      closeMenu();
      try {
        item.onSelect?.(event);
      } catch (error) {
        console.error("context menu action failed", error);
      }
    };
    menu.appendChild(button);
  }
  menuHostEl.appendChild(menu);
  positionMenu(menu, x, y);
  activeMenu = menu;
  document.addEventListener("mousedown", onOutsideMouse, true);
  document.addEventListener("keydown", onMenuKey, true);
  document.addEventListener("scroll", closeMenu, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
}

// ── Session-row mutations (mirror legacy actions/session.js) ─────────────────────

function sessionFallbackTitle(item: SessionListItem): string {
  return item.title || `Session ${item.id.slice(0, 8)}`;
}

async function togglePinSession(item: SessionListItem): Promise<void> {
  try {
    await bridge().setSessionFlags(item.id, { pinned: !item.pinnedAt });
    await refreshDesktopState();
  } catch (error) {
    console.error(error);
  }
}

async function toggleArchiveSession(item: SessionListItem): Promise<void> {
  try {
    await bridge().setSessionFlags(item.id, { archived: !item.archivedAt });
    await refreshDesktopState();
  } catch (error) {
    console.error(error);
  }
}

// Rename the durable index first, then push the same title into any live host
// session. The latter includes background tasks so an in-flight auto-title sees
// the manual rename and fails its expected-title guard instead of overwriting it.
async function applyRename(item: SessionListItem, nextTitle: string): Promise<void> {
  try {
    await bridge().renameSession(item.id, nextTitle);
    await bridge()
      .invoke("update_session_config", { sessionId: item.id, title: nextTitle })
      .catch(() => undefined);
    await refreshDesktopState();
  } catch (error) {
    console.error(error);
  }
}

// Mirror legacy deleteIndexedSession: confirm, drop the backend engine, delete
// the saved session, then re-pull state. If the deleted session was the active
// one, fall back to the most-recent sibling (or a draft) so the chat doesn't
// dangle.
async function deleteSession(item: SessionListItem): Promise<void> {
  const title = sessionFallbackTitle(item);
  if (!window.confirm(`Permanently delete session "${title}"? This cannot be undone.`)) return;
  // Tell the backend to drop its engine so the deleted session can't keep
  // streaming events into the renderer after we forget about it.
  void bridge().invoke("close_session", { sessionId: item.id }).catch(() => undefined);
  try {
    await bridge().deleteSession(item.id);
  } catch (error) {
    console.error(error);
    return;
  }
  // Release the deleted session's parked per-session UI cache + sidebar badge so
  // they don't leak for the window's lifetime (it holds a full snapshot).
  forgetSession(item.id);
  const wasActive = getMainState().sessionId === item.id;
  await refreshDesktopState();
  if (!wasActive) return;
  // The active session vanished — switch to the newest sibling in the same
  // workspace/project, mirroring legacy finishSessionRemoval's fallback.
  const desktop = getMainState().desktop;
  const fallback = desktop?.sessions?.find(
    (candidate) =>
      candidate.id !== item.id &&
      (candidate.workspaceId === item.workspaceId || candidate.projectId === item.projectId),
  );
  if (fallback) await loadSession(fallback);
  // No sibling left — open a fresh draft so the chat doesn't dangle on the
  // just-deleted session's stale transcript/sessionId (mirror legacy
  // finishSessionRemoval's createSession fallback).
  else await newDraftSession(item.cwd);
}

// ── Rename dialog (mirror legacy startInlineRename) ─────────────────────────────
//
// Uses the native <dialog> element this component renders so backdrop / Escape /
// focus trap behave correctly without a custom modal manager. The dialog is a
// singleton — we rebind its handlers each time, so the same DOM serves every
// rename.

export function startSessionRename(item: SessionListItem): void {
  const dialog = dialogEl;
  const input = inputEl;
  const cancel = cancelButtonEl;
  if (!dialog || !input || !cancel) return;
  const original = sessionFallbackTitle(item);
  input.value = original;

  let settled = false;
  const cleanup = (): void => {
    input.removeEventListener("keydown", onKey);
    cancel.removeEventListener("click", onCancel);
    dialog.removeEventListener("close", onClose);
    dialog.removeEventListener("submit", onSubmit);
  };
  const finish = (action?: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (dialog.open) dialog.close();
    action?.();
  };
  const onCancel = (): void => finish();
  const onClose = (): void => finish();
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      // The native <dialog> already handles Escape, but catch it here so the
      // cleanup path runs deterministically before the dialog close event.
      event.preventDefault();
      finish();
    }
  };
  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next || next === original) {
      finish();
      return;
    }
    finish(() => {
      void applyRename(item, next);
    });
  };

  input.addEventListener("keydown", onKey);
  cancel.addEventListener("click", onCancel);
  dialog.addEventListener("close", onClose);
  dialog.addEventListener("submit", onSubmit);

  dialog.showModal();
  // Focus + select after the dialog actually opens — focus before showModal
  // lands on the wrong context in some browsers.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// ── Public imperative open API (called by SessionList rows) ─────────────────────
//
// `event` may be a React.MouseEvent or a native MouseEvent — we only read
// clientX/clientY + the EventTarget, both present on each.

export function openSessionContextMenu(
  event: { clientX: number; clientY: number },
  item: SessionListItem,
  rowNode: HTMLElement,
): void {
  // Highlight the row that owns the menu (mirror legacy `.context-target`).
  rowNode.classList.add("context-target");
  activeTarget = rowNode;

  const isActive = getMainState().sessionId === item.id;
  openContextMenu({
    x: event.clientX,
    y: event.clientY,
    items: [
      {
        label: "Open",
        disabled: isActive,
        onSelect: () => {
          if (item.draft) return;
          void loadSession(item);
        },
      },
      {
        label: "Rename…",
        onSelect: () => startSessionRename(item),
      },
      {
        label: "Copy ID",
        onSelect: () => {
          void bridge().clipboardWrite(item.id).catch(() => undefined);
        },
      },
      {
        label: "Copy title",
        onSelect: () => {
          void bridge().clipboardWrite(sessionFallbackTitle(item)).catch(() => undefined);
        },
      },
      {
        label: "Copy path",
        onSelect: () => {
          void bridge().clipboardWrite(item.cwd || "").catch(() => undefined);
        },
      },
      { separator: true },
      {
        label: item.pinnedAt ? "Unpin" : "Pin to top",
        onSelect: () => {
          void togglePinSession(item);
        },
      },
      {
        label: item.archivedAt ? "Unarchive" : "Archive",
        onSelect: () => {
          void toggleArchiveSession(item);
        },
      },
      { separator: true },
      {
        label: "Delete…",
        danger: true,
        onSelect: () => {
          void deleteSession(item);
        },
      },
    ],
  });
}

// ── React shell ─────────────────────────────────────────────────────────────────
//
// Renders ONLY the static host for the imperatively-built menu + the rename
// <dialog>. Mount ONCE near the top of the main chat tree (e.g. in MainApp,
// alongside SessionList). The menu/dialog are global singletons, so a single
// instance serves every session row.

export function SessionContextMenu() {
  const hostRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Bind the module-level singletons to the live DOM nodes on mount; tear down
  // any open menu on unmount.
  useEffect(() => {
    menuHostEl = hostRef.current;
    dialogEl = dialogRef.current;
    inputEl = inputRef.current;
    cancelButtonEl = cancelRef.current;
    return () => {
      closeMenu();
      menuHostEl = null;
      dialogEl = null;
      inputEl = null;
      cancelButtonEl = null;
    };
  }, []);

  // Close any open menu when the active session changes underneath it (e.g. a
  // background turn re-pulls desktop state and re-renders the rows). Keeps the
  // popup from pointing at a stale, detached row.
  useEffect(() => subscribeMainStore(() => {
    if (activeTarget && !activeTarget.isConnected) closeMenu();
  }), []);

  return (
    <>
      {/* Host for the imperatively-built `.context-menu` (position: fixed, so the
          host itself is layout-neutral). */}
      <div ref={hostRef} />

      {/* Rename dialog — byte-identical to the legacy #rename-session-dialog in
          main.html, styled by the already-linked .rename-dialog CSS. */}
      <dialog
        id="rename-session-dialog"
        className="rename-dialog"
        aria-labelledby="rename-session-title"
        aria-describedby="rename-session-hint"
        ref={dialogRef}
      >
        <form method="dialog" className="rename-dialog-form">
          <h3 className="rename-dialog-title" id="rename-session-title">
            Rename session
          </h3>
          <p className="rename-dialog-hint" id="rename-session-hint">
            Choose a name for this conversation.
          </p>
          <input
            type="text"
            id="rename-session-input"
            className="rename-dialog-input"
            maxLength={120}
            autoComplete="off"
            aria-label="Session name"
            ref={inputRef}
          />
          <div className="rename-dialog-actions">
            <button type="button" id="rename-session-cancel" className="rename-dialog-button" ref={cancelRef}>
              Cancel
            </button>
            <button
              type="submit"
              id="rename-session-confirm"
              className="rename-dialog-button rename-dialog-button-primary"
            >
              Rename
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
