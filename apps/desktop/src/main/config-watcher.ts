// Config watcher — the single source of "global config changed" truth.
//
// Reina runs several BrowserWindows (chat / settings / workspace), each a
// separate renderer that loads global config (models.json, agents.json,
// subscriptions.json, skills/) into its OWN in-memory snapshot at mount. The
// files on disk under $REINA_HOME (and a workspace's .reina/) are the real
// source of truth, owned by the main process.
//
// Previously each *writer* had to remember to broadcast a "<domain>-changed"
// event and each *reader* had to subscribe — an O(writers × readers) hand-wired
// matrix. Miss either half (a forgotten broadcast, an unlistened event) and a
// window silently drifts stale until an app restart. External edits (hand-edit,
// PowerShell, `git pull`) weren't covered at all.
//
// This watcher closes the gap at the root: it watches the config files directly
// and broadcasts the SAME domain events the renderer already listens for,
// regardless of HOW the file changed. The per-IPC broadcasts stay as the fast
// path (instant, no debounce); this is the safety net that makes drift
// impossible and a new write path can never "forget" to notify.

import { watch, mkdirSync, type FSWatcher } from "node:fs";
import path from "node:path";

type Broadcast = (event: string, payload: unknown) => void;
type Scope = "global" | "workspace";

// Changed top-level file → the renderer event that invalidates its cache.
// (mcp.json is intentionally absent: MCP config is read host-side per session,
// so no renderer cache depends on it — adding a dead event would be noise.)
const FILE_EVENT: Record<string, string> = {
  "models.json": "custom-models-changed",
  "agents.json": "custom-agents-changed",
  "subscriptions.json": "subscriptions-changed",
};

// fs.watch emits several events per save (and atomic write = rename + change),
// and a subscription-token refresh rewrites subscriptions.json — coalesce.
const DEBOUNCE_MS = 200;

export interface ConfigWatcher {
  /** Re-point the workspace-scoped watch at a new cwd (null clears it). */
  setWorkspace(cwd: string | null): void;
  dispose(): void;
}

export function startConfigWatcher(opts: {
  configHome: string;
  initialWorkspaceCwd: string | null;
  broadcast: Broadcast;
}): ConfigWatcher {
  const { configHome, broadcast } = opts;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const fire = (event: string, payload: unknown) => {
    const prev = timers.get(event);
    if (prev) clearTimeout(prev);
    timers.set(
      event,
      setTimeout(() => {
        timers.delete(event);
        broadcast(event, payload);
      }, DEBOUNCE_MS),
    );
  };

  // Map a changed path (relative to a watched root) to its domain event.
  const handleChange = (root: string, filename: string | null, scope: Scope) => {
    if (!filename) return;
    const norm = filename.replaceAll("\\", "/");
    const base = norm.split("/").pop() ?? norm;
    if (FILE_EVENT[base]) {
      fire(FILE_EVENT[base], { scope, path: path.join(root, norm) });
      return;
    }
    // Skills live under <root>/skills/<name>/SKILL.md — any change in that tree
    // invalidates the slash launcher's skills cache.
    if (norm === "skills" || norm.startsWith("skills/")) {
      fire("skills-changed", { scope, path: path.join(root, norm) });
    }
  };

  // Watch a directory, preferring recursive (covers the nested skills/ tree;
  // supported on the app's Windows + macOS targets). Falls back to a flat watch
  // (top-level json still arrives) and tolerates a not-yet-created dir.
  const watchDir = (dir: string, scope: Scope): FSWatcher | null => {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort — watch() below still tolerates absence */
    }
    try {
      return watch(dir, { recursive: true }, (_evt, filename) => handleChange(dir, filename, scope));
    } catch {
      try {
        return watch(dir, (_evt, filename) => handleChange(dir, filename, scope));
      } catch {
        return null;
      }
    }
  };

  const globalWatcher = watchDir(configHome, "global");

  let wsWatcher: FSWatcher | null = null;
  let wsCwd: string | null = null;
  const setWorkspace = (cwd: string | null) => {
    if (cwd === wsCwd) return;
    wsCwd = cwd;
    if (wsWatcher) {
      try { wsWatcher.close(); } catch { /* ignore */ }
      wsWatcher = null;
    }
    if (cwd) wsWatcher = watchDir(path.join(cwd, ".reina"), "workspace");
  };
  setWorkspace(opts.initialWorkspaceCwd);

  return {
    setWorkspace,
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      try { globalWatcher?.close(); } catch { /* ignore */ }
      try { wsWatcher?.close(); } catch { /* ignore */ }
    },
  };
}
