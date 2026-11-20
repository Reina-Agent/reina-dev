// Welcome — React port of the legacy welcome-screen overlay
// (apps/desktop/src/renderer/actions/workspace-switcher.js + the static
// `#welcome-screen` block in main.html). Faithful port: reproduces the EXACT
// legacy DOM (same class names / ids / structure as main.html) and reuses the
// already-linked legacy CSS. ZERO visual/behavioral change.
//
// The welcome screen is a full-screen overlay shown when no workspace is open.
// It lists the most-recent workspaces (newest first, capped at 10) plus an
// "Open Folder…" action. Clicking a recent row or picking a folder opens that
// workspace.
//
// Notes vs legacy (workspace-switcher.js):
//   - Show/hide: legacy renderer.js shows the overlay on boot only when there
//     is no explicitly-active workspace (no activeWorkspaceId), and hides it the
//     moment loadWorkspace() runs. The React main store mirrors that signal:
//     `workspaceCwd` becomes non-null once a session is loaded or a workspace is
//     opened; on a first run with no active workspace it stays null. So the
//     overlay is hidden iff a workspace is open. Driven by the `hidden`
//     attribute exactly like legacy.
//   - recentWorkspaces(): same sort (desc by lastUsedAt) + slice(0, 10), read
//     from desktop state's `workspaces`.
//   - workspaceLabel(): same folder-name derivation via shortPath.
//   - Open a workspace (switchWorkspace): mirrors legacy — touchWorkspace(cwd)
//     to persist + open the host SessionStore, then invoke("open_workspace"),
//     and refresh desktop state. The folder picker uses openDirectoryPicker.

import { bridge } from "~/lib/bridge";
import { shortPath } from "./sessionHelpers";
import { refreshDesktopState, useMainStore } from "./sessionStore";
import type { DesktopWorkspace } from "./protocol";

// lastUsedAt is carried on the persisted workspace record but isn't part of the
// trimmed DesktopWorkspace protocol type the React store declares; read it
// defensively (mirrors legacy `workspace.lastUsedAt ?? ""`).
type RecentWorkspace = DesktopWorkspace & { lastUsedAt?: string };

// Tiny helper to keep the JSX close to the legacy <svg class="icon"> markup.
function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

// Read the most-recent workspaces from desktop state, sorted desc by
// lastUsedAt. Returns at most 10. (Mirrors legacy recentWorkspaces().)
function recentWorkspaces(workspaces: RecentWorkspace[]): RecentWorkspace[] {
  return [...workspaces]
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
    .slice(0, 10);
}

// Just the folder name for the row's primary line — the full path is shown on
// the secondary line below it. (Mirrors legacy workspaceLabel().)
function workspaceLabel(workspace: RecentWorkspace): string {
  const normalized = shortPath(workspace.cwd || "").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || normalized || workspace.cwd;
}

// Open a workspace end-to-end (mirrors legacy switchWorkspace + loadWorkspace's
// touch/open steps): persist + open the host SessionStore, tell the engine to
// open the workspace, then refresh desktop state. The main chat window follows
// the new workspace once its active session loads via the store's event flow.
async function switchWorkspace(cwd: string): Promise<void> {
  if (!cwd) return;
  const api = bridge();
  try {
    await api.touchWorkspace(cwd).catch(() => undefined);
    await api.invoke("open_workspace", { cwd }).catch(() => undefined);
    await api.openWorkspaceInMain?.(cwd).catch(() => undefined);
    await refreshDesktopState();
  } catch {
    // Swallow — legacy surfaces errors via showError; the overlay simply stays
    // up so the user can retry.
  }
}

async function pickFolder(): Promise<void> {
  try {
    const picked = await bridge().openDirectoryPicker?.({ title: "Open workspace" });
    if (!picked) return;
    await switchWorkspace(picked);
  } catch {
    // ignore — see switchWorkspace.
  }
}

export function Welcome() {
  // Show the overlay when no workspace is open (mirrors legacy: hidden the
  // moment a workspace loads). `workspaceCwd` is null until a session/workspace
  // is active.
  const workspaceCwd = useMainStore((s) => s.workspaceCwd);
  const desktop = useMainStore((s) => s.desktop);

  const hidden = Boolean(workspaceCwd);
  const recent = recentWorkspaces((desktop?.workspaces ?? []) as RecentWorkspace[]);
  const empty = recent.length === 0;

  return (
    <section className="welcome-screen" id="welcome-screen" hidden={hidden}>
      <article className="welcome-card">
        <header className="welcome-header">
          <div className="welcome-avatar" aria-hidden>T</div>
          <div>
            <h1 className="welcome-title">Reina</h1>
            <p className="welcome-subtitle">Open a workspace to start a session.</p>
          </div>
        </header>
        <section className="welcome-recent" id="welcome-recent">
          <div className="welcome-recent-title">Recent</div>
          <div className="welcome-recent-list" id="welcome-recent-list">
            {recent.map((ws) => (
              <button
                key={ws.id || ws.cwd}
                type="button"
                className="welcome-recent-row"
                onClick={() => void switchWorkspace(ws.cwd)}
              >
                <span className="welcome-recent-row-name">{workspaceLabel(ws)}</span>
                <span className="welcome-recent-row-path">{ws.cwd}</span>
              </button>
            ))}
          </div>
          <div className="welcome-recent-empty" id="welcome-recent-empty" hidden={!empty}>
            No workspaces yet.
          </div>
        </section>
        <div className="welcome-actions">
          <button
            className="welcome-open"
            id="welcome-open-folder"
            type="button"
            onClick={() => void pickFolder()}
          >
            <Icon name="folder" />
            <span>Open Folder...</span>
          </button>
        </div>
      </article>
    </section>
  );
}
