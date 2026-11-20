/**
 * SQLite schema for a Reina workspace database.
 *
 * Design notes:
 *
 *  - Per-workspace DB at `<workspace>/.reina/reina.db`. The workspace is the
 *    authoritative boundary; cross-workspace queries don't exist.
 *
 *  - Hot tables (sessions / messages / tool_calls / trace_events / async_tasks)
 *    are explicitly columned so the sidebar listing, FTS5 search, and status
 *    queries are first-class indexed operations.
 *
 *  - Cold session state (todos, plan, summary, providerState, skills snapshot,
 *    memory snapshot, recentFiles, pendingQuestions, compactBoundaries) lives
 *    in a single JSON blob in `session_state_blob` keyed by session_id. Cheap
 *    to read/write as a whole, never queried by field. If any of these later
 *    grow into a queryable concern, we promote them to their own table — the
 *    SessionStore API hides that detail.
 *
 *  - FTS5 over `messages.content` is wired through triggers so any INSERT /
 *    UPDATE / DELETE on `messages` keeps the search index in sync. Renderer
 *    can `MATCH 'webpack'` across every message ever recorded in this
 *    workspace in O(log n).
 *
 *  - `schema_version` is a single-row table that the migration runner reads
 *    to decide which migrations still need to apply.
 *
 *  - PRAGMA choices on every open:
 *      journal_mode = WAL     concurrent reads alongside a writer — DOWNGRADED
 *                             to TRUNCATE when the DB sits on a network
 *                             filesystem (UNC share, NFS/SMB/FUSE mount): WAL's
 *                             `-shm` file is mmap-based shared memory, which
 *                             network filesystems can't keep coherent, risking
 *                             corruption/crashes. See resolveJournalMode in
 *                             session-store.ts (REINA_SQLITE_JOURNAL_MODE
 *                             overrides the auto-detection).
 *      foreign_keys = ON      cascading deletes for session children
 *      busy_timeout = 5000    wait up to 5s on a locked write before erroring
 *      synchronous = NORMAL   durability/perf tradeoff suited for desktop UX
 */

export function pragmasFor(journalMode: "WAL" | "TRUNCATE"): readonly string[] {
  return [
    `PRAGMA journal_mode = ${journalMode}`,
    "PRAGMA foreign_keys = ON",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA synchronous = NORMAL",
  ];
}

/** The current schema version. Bumped any time MIGRATIONS gains an entry. */
export const CURRENT_SCHEMA_VERSION = 9;

/** DDL for the CJK-aware search-terms indexes (migration v7).
 *
 * `messages_fts` (unicode61, below) cannot tokenize Chinese — CJK queries
 * used to fall back to an unbounded LIKE scan. These contentless FTS5 tables
 * index the uni+bigram term set produced by the `reina_search_terms` SQL
 * function (registered from JS in SessionStore.open, implementation in
 * search-terms.ts), synced by triggers exactly like messages_fts so every
 * write path — appendMessage, persistSession's wipe-and-reinsert, cascade
 * deletes — stays covered without JS-side dual writes.
 *
 * Runtime note: the triggers call a JS-registered function, so they only
 * work on connections that registered it (every SessionStore.open does).
 * On a runtime too old for node:sqlite UDFs the migration no-ops and the
 * query side falls back to the LIKE scan (searchMessagesTerms try/catch). */
export const SEARCH_TERMS_SCHEMA: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_terms USING fts5(
    terms,
    content='',
    contentless_delete=1
  )`,
  `CREATE TRIGGER IF NOT EXISTS messages_terms_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts_terms(rowid, terms) VALUES (new.rowid, reina_search_terms(new.content));
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_terms_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts_terms WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_terms_au AFTER UPDATE OF content ON messages BEGIN
    DELETE FROM messages_fts_terms WHERE rowid = old.rowid;
    INSERT INTO messages_fts_terms(rowid, terms) VALUES (new.rowid, reina_search_terms(new.content));
  END`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
    terms,
    content='',
    contentless_delete=1
  )`,
  `CREATE TRIGGER IF NOT EXISTS memory_chunks_terms_ai AFTER INSERT ON memory_chunks BEGIN
    INSERT INTO memory_chunks_fts(rowid, terms) VALUES (new.rowid, reina_search_terms(new.topic_line || ' ' || new.content));
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_chunks_terms_ad AFTER DELETE ON memory_chunks BEGIN
    DELETE FROM memory_chunks_fts WHERE rowid = old.rowid;
  END`,
];

/** DDL for the memory_chunks table (migration v2). Offloaded conversation
 * chunks produced at compaction time when REINA_COMPACTION_OFFLOAD=1.
 * Each row is one "turn arc" (user→assistant→tools). Content is lossless
 * original text; topic_line + tool_names give the model enough to decide
 * whether to recall the full body via `recall_memory_chunk`. */
export const MEMORY_CHUNKS_SCHEMA: readonly string[] = [
  // Composite PK (session_id, id) so per-session ids like `c_001` can repeat
  // across sessions without collision while still being unique inside each
  // session (the model-facing identifier the recall tool calls).
  `CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    topic_line TEXT NOT NULL,
    tool_names TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    message_ids TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_ordinal ON memory_chunks(session_id, ordinal)`,
];

/** Initial DDL applied when a fresh DB is created. Idempotent: every
 * statement uses IF NOT EXISTS so re-running on an existing DB is harmless.
 *
 * Format: array of SQL strings so they can be executed in order inside a
 * single transaction. */
export const INITIAL_SCHEMA: readonly string[] = [
  // Schema version tracking — one row, key="version".
  `CREATE TABLE IF NOT EXISTS schema_version (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO schema_version (key, value) VALUES ('version', 0)`,

  // Workspace-level metadata (user-facing name, last opened, etc.). One row
  // per key, simple KV. The workspace identity itself is the DB path.
  `CREATE TABLE IF NOT EXISTS workspace_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Sessions: the index. Sidebar renders straight off this table; sort by
  // updated_at DESC for "most recent first".
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    agent TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_base_url TEXT,
    model_context_window_tokens INTEGER,
    model_reasoning_effort TEXT,
    permission_mode TEXT NOT NULL,
    output_style TEXT,
    output_style_custom TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_count INTEGER NOT NULL DEFAULT 0,
    usage_input_tokens INTEGER NOT NULL DEFAULT 0,
    usage_output_tokens INTEGER NOT NULL DEFAULT 0,
    usage_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    usage_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    usage_turns INTEGER NOT NULL DEFAULT 0,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    subagent_depth INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_archived_updated ON sessions(archived_at, updated_at DESC)`,

  // Per-session "everything else" blob. Holds infrequent / non-queried state
  // (todos, plan, summary, providerState, skills, memory, pendingQuestions,
  // recentFiles, compactBoundaries). Replace columns later if a field grows
  // into a queryable concern.
  `CREATE TABLE IF NOT EXISTS session_state_blob (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  )`,

  // Messages: full transcript. ordinal is the position within the session,
  // monotonically increasing. in_model_view marks whether this message is
  // still in the model's send-view (false after compaction trimmed it).
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    attachments TEXT,
    in_model_view INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal)`,

  // Tool calls: one row per invocation. status reflects current lifecycle.
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    permission TEXT NOT NULL,
    summary TEXT,
    input TEXT,
    preview TEXT,
    output TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_ordinal ON tool_calls(session_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_status ON tool_calls(session_id, status)`,

  // Trace events: debug log. Cheap to query by type for "show me every
  // background.error event in this session".
  `CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trace_session_ordinal ON trace_events(session_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_type ON trace_events(type, created_at DESC)`,

  // Async subagent tasks. Queried by status for the Agent Team panel.
  `CREATE TABLE IF NOT EXISTS async_tasks (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    isolation TEXT NOT NULL,
    worktree_path TEXT,
    worktree_branch TEXT,
    turns INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    usage_input_tokens INTEGER NOT NULL DEFAULT 0,
    usage_output_tokens INTEGER NOT NULL DEFAULT 0,
    usage_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    usage_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    notified_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_async_parent_started ON async_tasks(parent_session_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_async_status ON async_tasks(status, started_at DESC)`,

  // FTS5 over message content. external content table = `messages.content`,
  // synced via triggers so we never have to write to two places.
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  )`,

  // Sync triggers: keep FTS5 mirror in lockstep with messages table.
  `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,

  // Cascading delete trigger: removing a session removes its row in
  // session_state_blob (FK already cascades, but explicit for clarity).
  // No-op when FK cascade does the job; harmless to keep for documentation.
];
