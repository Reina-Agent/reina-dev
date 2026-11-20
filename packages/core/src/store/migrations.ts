/**
 * Schema migration runner.
 *
 * Every migration carries a `version` (1-indexed monotonically) and an `up`
 * function that mutates the DB. The runner reads `schema_version.value`,
 * applies every migration whose version is higher, then bumps the value to
 * match the highest applied version.
 *
 * Each migration runs in its own transaction. If `up` throws, the txn is
 * rolled back and the runner aborts — the DB stays at the previous version.
 *
 * Adding a new migration:
 *   1. Append an entry to `MIGRATIONS` with `version: N+1` (N = current max).
 *   2. Bump `CURRENT_SCHEMA_VERSION` in schema.ts to match.
 *   3. Test against a fresh DB AND a DB at version N.
 *
 * Down migrations are intentionally not supported. If you need to roll
 * back, restore from backup — irreversible changes (data deletion, type
 * narrowing) are normal in production schemas.
 */

import type { DatabaseSync } from "node:sqlite";
import { errorMessage } from "@reina/protocol";
import { CURRENT_SCHEMA_VERSION, INITIAL_SCHEMA, MEMORY_CHUNKS_SCHEMA, SEARCH_TERMS_SCHEMA } from "./schema.js";

export type Migration = {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
};

/** Ordered list of all migrations. Version 1 is the initial schema; future
 * migrations append here. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial schema: sessions, messages, tool_calls, trace_events, async_tasks, FTS5",
    up: (db) => {
      for (const stmt of INITIAL_SCHEMA) {
        db.exec(stmt);
      }
    },
  },
  {
    version: 2,
    description: "Add memory_chunks table for Phase B compaction offload",
    up: (db) => {
      for (const stmt of MEMORY_CHUNKS_SCHEMA) {
        db.exec(stmt);
      }
    },
  },
  {
    version: 3,
    description: "Add durable async task recovery metadata and event ledger",
    up: (db) => {
      addColumnIfMissing(db, "async_tasks", "child_session_id", "TEXT");
      addColumnIfMissing(db, "async_tasks", "worktree_head", "TEXT");
      addColumnIfMissing(db, "async_tasks", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "async_tasks", "resume_count", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "async_tasks", "last_heartbeat_at", "TEXT");
      addColumnIfMissing(db, "async_tasks", "lease_owner", "TEXT");
      addColumnIfMissing(db, "async_tasks", "lease_expires_at", "TEXT");
      addColumnIfMissing(db, "async_tasks", "recovery_json", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS async_task_events (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_async_task_events_task_created ON async_task_events(task_id, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_async_task_events_parent_created ON async_task_events(parent_session_id, created_at)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS async_task_attempts (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          child_session_id TEXT,
          worker_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT,
          completed_at TEXT,
          error TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_async_task_attempts_task_started ON async_task_attempts(task_id, started_at)`);
    },
  },
  {
    version: 4,
    description: "Add durable subagent edge projection and async task update queue",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subagent_edges (
          parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          close_reason TEXT,
          recovery_json TEXT,
          PRIMARY KEY(parent_session_id, task_id, child_session_id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_subagent_edges_parent_status_updated ON subagent_edges(parent_session_id, status, updated_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_subagent_edges_child ON subagent_edges(child_session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_subagent_edges_task_status ON subagent_edges(task_id, status)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS async_task_updates (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          applied_at TEXT,
          dropped_at TEXT,
          error TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_async_task_updates_task_status_created ON async_task_updates(parent_session_id, task_id, status, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_async_task_updates_lease ON async_task_updates(status, lease_expires_at)`);
    },
  },
  {
    version: 5,
    description: "Store complete async task snapshots alongside queryable projection columns",
    up: (db) => {
      addColumnIfMissing(db, "async_tasks", "snapshot_json", "TEXT");
    },
  },
  {
    version: 6,
    description: "Add messages.reasoning_trace for cross-turn structured reasoning replay",
    up: (db) => {
      addColumnIfMissing(db, "messages", "reasoning_trace", "TEXT");
    },
  },
  {
    version: 7,
    description: "CJK-aware search-terms FTS over messages + memory chunks (uni+bigram tokenizer)",
    up: (db) => {
      // The triggers and backfill call the JS-registered `reina_search_terms`
      // function (SessionStore.open registers it BEFORE migrate). On a runtime
      // without node:sqlite UDF support the function is absent — no-op rather
      // than fail the whole open; searches keep the LIKE fallback. Note the
      // version still advances, so such a DB stays on the LIKE path even
      // after a runtime upgrade — acceptable for the pre-22.13 edge case.
      try {
        db.prepare(`SELECT reina_search_terms('probe')`).get();
      } catch {
        console.warn("[store] node:sqlite UDFs unavailable — skipping CJK search-terms index (LIKE fallback stays)");
        return;
      }
      for (const stmt of SEARCH_TERMS_SCHEMA) {
        db.exec(stmt);
      }
      // Backfill existing rows. Runs inside the migration's transaction like
      // every other migration step.
      db.exec(`INSERT INTO messages_fts_terms(rowid, terms) SELECT rowid, reina_search_terms(content) FROM messages`);
      db.exec(
        `INSERT INTO memory_chunks_fts(rowid, terms) SELECT rowid, reina_search_terms(topic_line || ' ' || content) FROM memory_chunks`,
      );
    },
  },
  {
    version: 8,
    description: "Preserve provider-facing message metadata across session reloads",
    up: (db) => {
      addColumnIfMissing(db, "messages", "metadata_json", "TEXT");
    },
  },
  {
    version: 9,
    description: "Backfill cache-critical metadata on legacy model-context messages",
    up: (db) => {
      const rows = db
        .prepare(`SELECT id, session_id, role, content FROM messages WHERE metadata_json IS NULL`)
        .all() as Array<{ id: string; session_id: string; role: string; content: string }>;
      const findCall = db.prepare(`SELECT name, input FROM tool_calls WHERE session_id = ? AND id = ?`);
      const update = db.prepare(`UPDATE messages SET metadata_json = ? WHERE id = ?`);
      for (const row of rows) {
        if (row.role !== "user") continue;
        if (row.content.startsWith("<system-reminder>\n")) {
          update.run(JSON.stringify({ ephemeral: true }), row.id);
          continue;
        }
        const match = /^Tool (\S+) \(([^)]+)\) result:\n([\s\S]*)$/.exec(row.content);
        if (!match) continue;
        const call = findCall.get(row.session_id, match[2]) as { name?: string; input?: string | null } | undefined;
        if (!call || call.name !== match[1]) continue;
        update.run(
          JSON.stringify({
            ephemeral: true,
            toolResult: {
              callId: match[2],
              name: match[1],
              ...(call.input ? { input: JSON.parse(call.input) } : {}),
              output: match[3],
            },
          }),
          row.id,
        );
      }
    },
  },
];

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** Read the DB's current schema version. Returns 0 for a fresh DB (no
 * schema_version row yet). */
export function getSchemaVersion(db: DatabaseSync): number {
  // schema_version table itself may not exist on a brand-new DB.
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get() as { name?: string } | undefined;
  if (!row?.name) return 0;
  const v = db.prepare(`SELECT value FROM schema_version WHERE key='version'`).get() as
    | { value?: number }
    | undefined;
  return v?.value ?? 0;
}

/** Apply every migration whose version is higher than the DB's current
 * version. Returns the new schema version. Throws on first failed
 * migration; the failing migration is rolled back (its transaction is
 * aborted) and earlier ones stay applied.
 *
 * Idempotent: running twice on the same DB is a no-op the second time. */
export function migrate(db: DatabaseSync): number {
  const start = getSchemaVersion(db);
  let applied = start;
  const pending = MIGRATIONS.filter((m) => m.version > start).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        `INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', ?)`,
      ).run(migration.version);
      db.exec("COMMIT");
      applied = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration v${migration.version} (${migration.description}) failed: ${errorMessage(error)}`,
      );
    }
  }
  if (applied !== CURRENT_SCHEMA_VERSION) {
    // Defensive: the migration list and the CURRENT_SCHEMA_VERSION constant
    // must agree. If they don't, the runner reached a state we didn't plan
    // for.
    throw new Error(
      `Schema version mismatch after migration: applied=${applied}, expected=${CURRENT_SCHEMA_VERSION}. ` +
        `Check that MIGRATIONS in migrations.ts covers version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  return applied;
}
