/**
 * One-shot migration: scan a workspace's `.reina/sessions/*.jsonl` files
 * and import any session that isn't already present in the SQLite store.
 *
 * Idempotent: sessions already in the store are skipped. Safe to run on
 * every workspace open; the first pass migrates, subsequent passes are no-ops.
 *
 * The JSONL files are NOT deleted by this pass — they remain on disk as a
 * safety net. A future "clean up old format" UI action (or a 30-day grace
 * timer) can remove `.jsonl` files whose session id is now in the store.
 *
 * On a failed migration of a single file, the migration logs an error and
 * continues with the rest. One bad JSONL must not block the whole import.
 */

import { readdir } from "node:fs/promises";
import { errorMessage } from "@reina/protocol";
import path from "node:path";
import type { SessionState } from "@reina/protocol";
import { loadRolloutAsSession } from "../rollout.js";
import type { SessionStore } from "./session-store.js";

export type MigrationReport = {
  scanned: number;
  imported: number;
  skipped: number;
  failed: Array<{ file: string; error: string }>;
};

/** Migrate all JSONL session files under `<workspaceCwd>/.reina/sessions/`
 * into the given store. Returns a summary the caller can log or display. */
export async function migrateWorkspaceJsonl(
  workspaceCwd: string,
  store: SessionStore,
): Promise<MigrationReport> {
  const report: MigrationReport = { scanned: 0, imported: 0, skipped: 0, failed: [] };
  const sessionsDir = path.join(workspaceCwd, ".reina", "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    // No .reina/sessions directory == nothing to migrate. Normal for a
    // brand-new workspace.
    return report;
  }

  // Build the set of session ids already in the store ONCE upfront so the
  // per-file loop doesn't query SQLite repeatedly.
  const existingIds = new Set(store.listSessions({ includeArchived: true, includeSubagents: true }).map((s) => s.id));

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    report.scanned += 1;
    const sessionId = entry.replace(/\.jsonl$/i, "");
    if (existingIds.has(sessionId)) {
      report.skipped += 1;
      continue;
    }
    const filePath = path.join(sessionsDir, entry);
    try {
      const session = await loadRolloutAsSession(filePath);
      if (!session) {
        // Empty / unreadable file — skip silently. Not a failure mode worth
        // surfacing; the JSONL might just be a stray that never got real
        // content.
        report.skipped += 1;
        continue;
      }
      // Make sure the loaded session's cwd matches the workspace we're
      // importing into. If a user has copied sessions around between
      // workspaces, the cwd field is stale — overwrite it so the imported
      // row lives under the right workspace.
      const fixed: SessionState = { ...session, cwd: workspaceCwd };
      store.persistSession(fixed);
      report.imported += 1;
    } catch (error) {
      report.failed.push({
        file: entry,
        error: errorMessage(error),
      });
    }
  }
  return report;
}
