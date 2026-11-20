// ProjectManager — the "Manage Projects…" modal opened from the workspace
// switcher popover. JetBrains-Welcome-style list of every workspace Reina
// remembers: search box, letter-tile rows (name + Active badge + path +
// sessions · last used), a per-row ⋮ context menu (Open / Reveal in File
// Explorer / Remove…), and a GitHub-Desktop-style remove confirm: ONE Remove…
// entry whose dialog carries an opt-in "also permanently delete .reina data"
// checkbox — destructive intent is a checkbox inside the dialog, not a second
// red button on the row.
//
// Removal routes through the agent-host's `remove_workspace` (force-closes the
// workspace's idle sessions, closes the SQLite store, deletes `<cwd>/.reina`
// when asked; refuses while a turn runs — surfaced as an error inside the
// dialog, list untouched). Because this lives in the MAIN window it can remove
// the ACTIVE workspace too: it clears the chat back to the Welcome overlay —
// the capability the (removed) settings-page panel could never have.
//
// Wiring mirrors SessionContextMenu: module-level imperative openers
// (`openProjectManager`, `requestRemoveWorkspace`) bound to the mounted
// component, so the imperative popover DOM in WorkspaceSwitcher can trigger
// both without owning any React state. The confirm dialog is shared by the
// manager rows AND the popover's hover ×, keeping one removal flow everywhere.
// Styled with plain chat CSS (`pm-*` in sidebar.css) — the main window doesn't
// load Tailwind.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";
import { isSidebarWindow } from "~/lib/windowKind";
import { openAppContextMenu } from "./SessionContextMenu";
import {
  clearWorkspaceToWelcome,
  getMainState,
  refreshDesktopState,
  useMainStore,
} from "./sessionStore";
import type { DesktopWorkspace } from "./protocol";

// ── Module-level imperative API (mirror SessionContextMenu's openers) ──────────

let openManagerImpl: (() => void) | null = null;
let requestRemoveImpl: ((ws: DesktopWorkspace) => void) | null = null;

/** Open the Manage Projects modal (popover footer entry). */
export function openProjectManager(): void {
  openManagerImpl?.();
}

/** Open the remove-confirm dialog for a workspace (popover hover ×). */
export function requestRemoveWorkspace(ws: DesktopWorkspace): void {
  requestRemoveImpl?.(ws);
}

// ── Row helpers ─────────────────────────────────────────────────────────────────

function baseName(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || cwd;
}

// Stable per-project hue from the cwd — the letter tile's identity color
// (JetBrains-style visual anchor). Alpha backgrounds keep it legible on both
// dark and light base46 themes.
function hueOf(cwd: string): number {
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 31 + cwd.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function formatLastUsed(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface ProjectManagerProps {
  /** Switch the chat to a workspace (WorkspaceSwitcher's switchWorkspace). */
  onOpenWorkspace: (cwd: string) => Promise<void>;
  /** Called after a successful removal so the popover can re-render if open. */
  onChanged?: () => void;
}

export function ProjectManager({ onOpenWorkspace, onChanged }: ProjectManagerProps) {
  const t = useT();
  const desktop = useMainStore((s) => s.desktop);
  const activeCwd = useMainStore((s) => s.workspaceCwd);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmWs, setConfirmWs] = useState<DesktopWorkspace | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const beginRemove = useCallback((ws: DesktopWorkspace) => {
    // The floating sidebar can't clear the main window's chat surface, so the
    // active workspace must be removed from the main window.
    if (isSidebarWindow && getMainState().workspaceCwd === ws.cwd) return;
    setDeleteData(false);
    setError("");
    setConfirmWs(ws);
  }, []);

  // Bind the module-level openers to this mounted instance.
  useEffect(() => {
    openManagerImpl = () => {
      setQuery("");
      setOpen(true);
      void refreshDesktopState().catch(() => undefined);
    };
    requestRemoveImpl = beginRemove;
    return () => {
      openManagerImpl = null;
      requestRemoveImpl = null;
    };
  }, [beginRemove]);

  // showModal/close the native confirm <dialog> alongside confirmWs.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirmWs && !dialog.open) dialog.showModal();
    else if (!confirmWs && dialog.open) dialog.close();
  }, [confirmWs]);

  // Focus the search box when the manager opens.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Escape closes the manager — unless the confirm dialog is up (the native
  // dialog swallows its own Escape via the cancel event).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmWs) {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, confirmWs]);

  const rows = useMemo(() => {
    const projectName = new Map((desktop?.projects ?? []).map((p) => [p.id, p.name]));
    const sessions = desktop?.sessions ?? [];
    const list = (desktop?.workspaces ?? []).map((ws) => ({
      ws,
      name: (ws.projectId ? projectName.get(ws.projectId) : undefined) || baseName(ws.cwd),
      sessionCount: sessions.filter((s) => s.cwd === ws.cwd && !s.archivedAt).length,
      isActive: ws.cwd === activeCwd,
    }));
    list.sort((a, b) => (b.ws.lastUsedAt ?? "").localeCompare(a.ws.lastUsedAt ?? ""));
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (row) => row.name.toLowerCase().includes(needle) || row.ws.cwd.toLowerCase().includes(needle),
    );
  }, [desktop, activeCwd, query]);

  const openWorkspace = useCallback(
    async (cwd: string) => {
      setOpen(false);
      await onOpenWorkspace(cwd);
    },
    [onOpenWorkspace],
  );

  const openRowMenu = useCallback(
    (event: React.MouseEvent, row: (typeof rows)[number]) => {
      event.stopPropagation();
      const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openAppContextMenu({
        x: anchor.right,
        y: anchor.bottom + 4,
        items: [
          {
            label: t("projects.open"),
            disabled: row.isActive,
            onSelect: () => void openWorkspace(row.ws.cwd),
          },
          {
            label: t("projects.reveal"),
            onSelect: () => void bridge().revealInFolder(row.ws.cwd).catch(() => undefined),
          },
          { separator: true },
          {
            label: t("projects.remove"),
            danger: true,
            disabled: isSidebarWindow && row.isActive,
            onSelect: () => beginRemove(row.ws),
          },
        ],
      });
    },
    [t, openWorkspace, beginRemove],
  );

  const pickFolder = useCallback(async () => {
    const picked = (await bridge()
      .openDirectoryPicker({ title: "Open workspace" })
      .catch(() => null)) as string | null;
    if (picked) await openWorkspace(picked);
  }, [openWorkspace]);

  const doRemove = useCallback(async () => {
    if (!confirmWs || busy) return;
    setBusy(true);
    setError("");
    try {
      // Host first: force-close idle sessions + close the SQLite store
      // (+ delete `<cwd>/.reina` when the checkbox is on). Throws while a
      // turn is running — surface it in the dialog, list untouched.
      await bridge().invoke("remove_workspace", { cwd: confirmWs.cwd, deleteData });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (getMainState().workspaceCwd === confirmWs.cwd && !isSidebarWindow) {
      // Removing the active workspace: clear the chat back to Welcome
      // (mirror of closeCurrentWorkspace's tail).
      await bridge()
        .clearActiveWorkspace()
        .catch(() => null);
      clearWorkspaceToWelcome();
    }
    await bridge()
      .removeWorkspace(confirmWs.id)
      .catch(() => null);
    await refreshDesktopState();
    setBusy(false);
    setConfirmWs(null);
    onChanged?.();
  }, [confirmWs, deleteData, busy, onChanged]);

  const confirmName = confirmWs
    ? (desktop?.projects?.find((p) => p.id === confirmWs.projectId)?.name ?? baseName(confirmWs.cwd))
    : "";

  return createPortal(
    <>
      {open && (
        <div
          className="pm-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="pm-panel" role="dialog" aria-modal aria-label={t("projects.title")}>
            <header className="pm-header">
              <div className="pm-header-top">
                <h2 className="pm-title">{t("projects.title")}</h2>
                <button
                  type="button"
                  className="pm-close"
                  aria-label={t("projects.close")}
                  onClick={() => setOpen(false)}
                >
                  <svg className="icon">
                    <use href="#i-x" />
                  </svg>
                </button>
              </div>
              <div className="pm-search">
                <svg className="icon">
                  <use href="#i-search" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  placeholder={t("projects.searchPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                  spellCheck={false}
                />
              </div>
            </header>
            <div className="pm-list">
              {rows.length === 0 ? (
                <div className="pm-empty">
                  {query.trim() ? t("projects.noMatch", { query: query.trim() }) : t("projects.empty")}
                </div>
              ) : (
                rows.map((row) => (
                  <div
                    key={row.ws.id}
                    className={"pm-row" + (row.isActive ? " active" : "")}
                    role="button"
                    tabIndex={0}
                    title={row.ws.cwd}
                    onClick={() => {
                      if (!row.isActive) void openWorkspace(row.ws.cwd);
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && !row.isActive) {
                        event.preventDefault();
                        void openWorkspace(row.ws.cwd);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openRowMenu(event, row);
                    }}
                  >
                    <span className="pm-tile" style={{ ["--pm-hue" as string]: hueOf(row.ws.cwd) }}>
                      {row.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="pm-row-main">
                      <span className="pm-row-name">
                        <span className="pm-row-title">{row.name}</span>
                        {row.ws.branch && <span className="pm-badge pm-badge-branch">{row.ws.branch}</span>}
                        {row.isActive && <span className="pm-badge">{t("projects.active")}</span>}
                      </span>
                      <span className="pm-row-path">{row.ws.cwd}</span>
                      <span className="pm-row-meta">
                        {t("projects.sessions", { count: row.sessionCount })}
                        {row.ws.lastUsedAt ? ` · ${formatLastUsed(row.ws.lastUsedAt)}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="pm-row-more"
                      aria-label={t("projects.rowMenu", { name: row.name })}
                      onClick={(event) => openRowMenu(event, row)}
                    >
                      <svg className="icon">
                        <use href="#i-more-horizontal" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
            <footer className="pm-footer">
              <span className="pm-count">{t("projects.count", { count: rows.length })}</span>
              <button type="button" className="pm-open-folder" onClick={() => void pickFolder()}>
                <svg className="icon">
                  <use href="#i-folder-plus" />
                </svg>
                <span>{t("projects.openFolder")}</span>
              </button>
            </footer>
          </div>
        </div>
      )}
      {/* Remove-confirm dialog — shared by manager rows and the popover ×.
          Native <dialog> (top layer) so it stacks above the manager overlay
          AND the workspace popover. Reuses the rename-dialog shell styles. */}
      <dialog
        ref={dialogRef}
        className="rename-dialog pm-confirm"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setConfirmWs(null);
        }}
        onClose={() => setConfirmWs(null)}
      >
        <div className="rename-dialog-form">
          <h3 className="rename-dialog-title">{t("projects.removeTitle")}</h3>
          <p className="rename-dialog-hint">{t("projects.removeMessage", { name: confirmName })}</p>
          <label className="pm-confirm-checkbox">
            <input
              type="checkbox"
              checked={deleteData}
              disabled={busy}
              onChange={(event) => setDeleteData(event.target.checked)}
            />
            <span>{t("projects.deleteCheckbox")}</span>
          </label>
          {error && <p className="pm-confirm-error">{error}</p>}
          <div className="rename-dialog-actions">
            <button
              type="button"
              className="rename-dialog-button"
              disabled={busy}
              onClick={() => setConfirmWs(null)}
            >
              {t("projects.cancel")}
            </button>
            <button
              type="button"
              className="rename-dialog-button pm-confirm-danger"
              disabled={busy}
              onClick={() => void doRemove()}
            >
              {busy ? "…" : deleteData ? t("projects.removeAndDelete") : t("projects.removeConfirm")}
            </button>
          </div>
        </div>
      </dialog>
    </>,
    document.body,
  );
}
