import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeWorktree } from "./worktree.js";

// Background filesystem GC sweeps, fired fire-and-forget from the AgentEngine
// constructor (every construction — parent AND subagent child engines — sweeps
// its own cwd). Free functions rather than a controller: they own no
// SessionState slice and emit nothing themselves; everything they need from
// the engine arrives as three narrow callbacks.
//
// `getCwd` / `getActiveTaskIds` are getters, NOT snapshots, to preserve the
// original methods' lazy reads exactly: the active-task set was computed from
// `this.session.asyncTasks` AFTER the first await, and the worktree sweep
// re-read `this.session.cwd` at the removeWorktree call — loadSession can swap
// `engine.session` while a sweep is mid-flight (the same reassignable-field
// hazard the controller hosts document at the constructor wiring site).

/** Matches AgentEngine.reportBackgroundError — emits a background-error
 * stream event and pushes a session trace entry; injected as a callback so
 * this module stays free of session/stream concerns. */
type ReportBackgroundError = (category: string, error: unknown, context?: Record<string, unknown>) => void;

/** Sweep per-task event log directories under `.reina/tasks/` that
 * haven't been written to in a while. Keeps the directory bounded
 * across long-lived workspaces — without this, every async subagent
 * ever fired leaves a `<taskId>/stream.jsonl` behind forever.
 *
 * Best-effort: missing dir is fine (no tasks yet), per-entry failures
 * get logged but don't stop the sweep. Active tasks in the current
 * session are explicitly skipped even if their files happen to be
 * older than the cutoff (extreme edge case — task hasn't streamed
 * anything in days but is still flagged running). */
export async function sweepStaleTaskDirs(
  getCwd: () => string,
  getActiveTaskIds: () => Set<string>,
  reportError: ReportBackgroundError,
): Promise<void> {
  const tasksRoot = path.join(getCwd(), ".reina", "tasks");
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let entries: string[];
  try {
    entries = await readdir(tasksRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  const activeTaskIds = getActiveTaskIds();
  for (const entry of entries) {
    if (activeTaskIds.has(entry)) continue;
    const dir = path.join(tasksRoot, entry);
    try {
      const streamFile = path.join(dir, "stream.jsonl");
      // Probe the actual log file rather than the directory — directory
      // mtime semantics are platform-dependent and don't track file
      // writes reliably on Windows.
      const stats = await stat(streamFile).catch(() => null);
      if (!stats) {
        // No stream file: either a half-created task dir or a totally
        // empty one. Either way, safe to drop if the directory itself
        // is also old.
        const dirStats = await stat(dir);
        if (!dirStats.isDirectory() || dirStats.mtimeMs > cutoff) continue;
      } else if (stats.mtimeMs > cutoff) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      reportError("task_dir.sweep", error, { dir });
    }
  }
}

/** Cross-session orphan worktree sweep. The per-session recovery path
 * (recoverStaleAsyncTasks) only knows about this session's tasks; a
 * worktree created by a SIBLING session that crashed mid-task is
 * invisible to it. This sweep catches them via a time-based heuristic:
 * tasks are bounded by the 10-minute hard cap, so anything still on
 * disk after 24 hours must be orphaned.
 *
 * Best-effort: failures get logged. Doesn't touch dirs younger than
 * the cutoff to avoid racing with active sibling sessions. */
export async function sweepOrphanWorktrees(
  getCwd: () => string,
  getActiveTaskIds: () => Set<string>,
  reportError: ReportBackgroundError,
): Promise<void> {
  const worktreesRoot = path.join(getCwd(), ".reina", "worktrees");
  const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24h — well past any legitimate task lifetime
  let entries: string[];
  try {
    entries = await readdir(worktreesRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  // Anything still tracked as running in THIS session: skip. (Sibling
  // sessions' running tasks will be protected by the age cutoff —
  // they can't be > 24h old without violating the hard cap.)
  const activeTaskIds = getActiveTaskIds();
  for (const entry of entries) {
    if (activeTaskIds.has(entry)) continue;
    const dir = path.join(worktreesRoot, entry);
    try {
      const stats = await stat(dir);
      if (!stats.isDirectory()) continue;
      if (stats.mtimeMs > cutoff) continue;
      // Use removeWorktree (git worktree remove --force) so git's
      // administrative state stays consistent. Falls back to plain
      // rm if git remove fails (e.g. the worktree was already
      // unregistered).
      await removeWorktree(getCwd(), dir).catch(async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      });
    } catch (error) {
      reportError("worktree.sweep", error, { dir });
    }
  }
}
