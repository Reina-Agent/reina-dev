/**
 * SessionStore — the workspace's persistent state.
 *
 * One instance per opened workspace. Wraps a node:sqlite DatabaseSync,
 * applies pragmas + migrations on open, and exposes a small, intentional
 * API that hides all SQL from callers.
 *
 * The engine, agent-host, and renderer never touch SQL directly — they all
 * go through this object. That keeps the storage layer swappable (we can
 * trade node:sqlite for better-sqlite3 or Postgres later by reimplementing
 * just this file).
 *
 * Concurrency model:
 *   - node:sqlite is synchronous; calls don't interleave with other
 *     JavaScript turns once they enter a SessionStore method
 *   - WAL mode lets readers proceed while a writer is mid-transaction
 *   - Multi-statement writes use explicit transactions (begin/commit) so
 *     partial writes don't ever land on disk
 *   - busy_timeout=5000 covers the (very rare) cross-process case where
 *     two processes opened the same DB
 */

import { mkdirSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
// Type-only import: erased at compile time. The runtime value comes from
// the createRequire call below so vitest's Vite resolver (which doesn't
// recognise the `node:` URL scheme for this experimental Node 22+ builtin)
// never sees a static import of node:sqlite. We anchor createRequire at
// `process.execPath` because (a) it's always defined, (b) `node:sqlite` is
// an absolute builtin URI so the anchor is only used to satisfy the API —
// no relative resolution actually occurs. This works under all three of
// our runtimes: pure ESM, tsup's CJS bundle (where import.meta.url is
// erased to undefined), and the vitest test runner.
import type * as NodeSqlite from "node:sqlite";
const sqliteModule = createRequire(process.execPath)("node:sqlite") as typeof NodeSqlite;
const DatabaseSync = sqliteModule.DatabaseSync;
type DatabaseSync = NodeSqlite.DatabaseSync;
import type {
  AsyncTaskRecord,
  ChatMessage,
  MemoryChunk,
  MemoryChunkMeta,
  ModelConfig,
  SessionState,
  ToolCallRecord,
  TraceEvent,
} from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { migrate } from "./migrations.js";
import { pragmasFor } from "./schema.js";
import { searchMatchQuery, searchTerms } from "./search-terms.js";

// ─── Journal-mode selection (network-filesystem defense) ────────────────────
//
// WAL keeps its reader/writer coordination state in a mmap'd `-shm` file.
// Network filesystems (SMB/UNC shares, NFS, FUSE-backed sync folders) cannot
// keep that shared memory coherent across clients — SQLite itself documents
// WAL as unsupported there — so a reina.db that lands on a network mount gets
// the plain rollback journal (TRUNCATE) instead. Adapted from Grok CLI's
// xai-sqlite-journal defense, trimmed to what a per-workspace desktop DB
// needs (no per-host filenames: the DB isn't intentionally shared).

/** Linux `statfs` f_type magic numbers of network/remote filesystems. */
const NETWORK_FS_MAGIC = new Set<number>([
  0x6969, // NFS
  0x517b, // SMB
  0xfe534d42, // SMB2
  0xff534d42, // CIFS
  0x65735546, // FUSE (sshfs, rclone, most cloud-sync mounts)
  0x00c36400, // CephFS
  0x0bd00bd0, // Lustre
  0x01161970, // GFS2
  0x7461636f, // OCFS2
  0x5346414f, // AFS
  0x73757245, // Coda
  0x01021997, // 9p (also WSL drvfs /mnt/c — Windows-side paths via 9p)
]);

function isNetworkPath(dbPath: string): boolean {
  if (process.platform === "win32") {
    // UNC shares are the unambiguous Windows case. Mapped drive letters
    // would need GetDriveTypeW (a native call Node doesn't expose) —
    // REINA_SQLITE_JOURNAL_MODE=truncate covers those. `\\?\` / `\\.\`
    // prefixed paths are LOCAL unless the namespace is UNC
    // (`\\?\UNC\server\share`), so don't let the double-slash fool us.
    const nsPrefix = /^[\\/]{2}[?.][\\/]/.exec(dbPath);
    if (nsPrefix) return /^UNC[\\/]/i.test(dbPath.slice(nsPrefix[0].length));
    return /^[\\/]{2}/.test(dbPath);
  }
  try {
    const type = Number((statfsSync(path.dirname(dbPath)) as { type?: number | bigint }).type ?? 0);
    return NETWORK_FS_MAGIC.has(type >>> 0);
  } catch {
    return false;
  }
}

/** Pick the journal mode for a DB path: explicit REINA_SQLITE_JOURNAL_MODE
 * override first (typos warn loudly instead of silently defaulting), then
 * network-filesystem auto-detection. Exported for tests. */
export function resolveJournalMode(dbPath: string): "WAL" | "TRUNCATE" {
  const override = process.env.REINA_SQLITE_JOURNAL_MODE?.trim().toLowerCase();
  if (override === "wal") return "WAL";
  if (override === "truncate") return "TRUNCATE";
  if (override) {
    console.warn(`[reina:store] unknown REINA_SQLITE_JOURNAL_MODE "${override}" (expected "wal" or "truncate") — auto-detecting instead`);
  }
  return isNetworkPath(dbPath) ? "TRUNCATE" : "WAL";
}

/** Compact view of a session for the sidebar. Cheap to load — does NOT
 * include messages, tool calls, or trace events. */
export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  agent: string;
  model: { provider: string; model: string };
  permissionMode: string;
  messageCount: number;
  toolCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    turns: number;
  };
  isSubagent: boolean;
  subagentDepth: number;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

/** Filter for listSessions. Defaults: live (archived excluded), most recent
 * first, no limit. */
export type SessionListFilter = {
  includeArchived?: boolean;
  includeSubagents?: boolean;
  limit?: number;
};

/** Hit returned by FTS5 search. The matching message and its parent
 * session id, enough for the UI to jump to the session and highlight. */
export type SearchHit = {
  sessionId: string;
  messageId: string;
  ordinal: number;
  role: string;
  /** Snippet with the matched terms highlighted by FTS5. */
  snippet: string;
  createdAt: string;
};

/** Han / kana / hangul — scripts the unicode61 FTS tokenizer can't segment,
 * Queries containing them route to the uni+bigram terms index
 * (messages_fts_terms, migration v7) with the LIKE scan as fallback. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/** Register the `reina_search_terms` SQL function (the CJK uni+bigram
 * tokenizer, search-terms.ts) on a connection. The search-terms triggers call
 * it on every messages/memory_chunks write, so this MUST run before
 * migrate(). Returns false on runtimes whose node:sqlite lacks
 * user-defined functions (< 22.13) — migration v7 then no-ops. */
function registerSearchTermsFunction(db: DatabaseSync): boolean {
  const register = (db as unknown as {
    function?: (name: string, options: { deterministic?: boolean }, fn: (arg: unknown) => string) => void;
  }).function;
  if (typeof register !== "function") return false;
  try {
    register.call(db, "reina_search_terms", { deterministic: true }, (text: unknown) => searchTerms(text));
    return true;
  } catch {
    return false;
  }
}

export type AsyncTaskUpdateRecord = {
  id: string;
  parentSessionId: string;
  taskId: string;
  message: string;
  status: "pending" | "claimed" | "applied" | "dropped";
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  claimedAt?: string;
  appliedAt?: string;
  droppedAt?: string;
  error?: string;
};

export type AsyncTaskEventRecord = {
  id: string;
  parentSessionId: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

// Cold session fields stowed in session_state_blob.data. Anything that's not
// queried — todos, plan, summary, providerState, etc. Promoted to its own
// table only when something needs to query it.
type SessionStateBlob = {
  todos?: SessionState["todos"];
  plan?: SessionState["plan"];
  summary?: SessionState["summary"];
  providerState?: SessionState["providerState"];
  usage?: SessionState["usage"];
  skills?: SessionState["skills"];
  pendingQuestions?: SessionState["pendingQuestions"];
  recentFiles?: SessionState["recentFiles"];
  readFileTimestamps?: SessionState["readFileTimestamps"];
  compactBoundaries?: SessionState["compactBoundaries"];
  modelMessages?: SessionState["modelMessages"];
  outputStyleCustom?: SessionState["outputStyleCustom"];
  interrupted?: SessionState["interrupted"];
  asyncTasksArchived?: SessionState["asyncTasksArchived"];
  failedBriefs?: SessionState["failedBriefs"];
  lastTurnTaskStatuses?: SessionState["lastTurnTaskStatuses"];
  mcpServerNamesSnapshot?: SessionState["mcpServerNamesSnapshot"];
  selfEvolveLog?: SessionState["selfEvolveLog"];
  modelOverride?: SessionState["modelOverride"];
};

export class SessionStore {
  private db: DatabaseSync;
  /** Resolved absolute path of the open DB file. Useful for diagnostics. */
  readonly dbPath: string;
  private closed = false;

  private constructor(db: DatabaseSync, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open the workspace's SQLite DB. Creates the file (and the .reina
   * directory) if missing, applies pragmas, and runs migrations to bring
   * the schema up to date.
   *
   * `workspaceCwd` is the workspace root; the DB lives at
   * `<workspaceCwd>/.reina/reina.db`.
   *
   * `inMemory` opens a `:memory:` DB ignoring the path entirely — used by
   * tests so they never touch disk.
   */
  static open(workspaceCwd: string, options: { inMemory?: boolean } = {}): SessionStore {
    let dbPath: string;
    let db: DatabaseSync;
    if (options.inMemory) {
      dbPath = ":memory:";
      db = new DatabaseSync(":memory:");
    } else {
      dbPath = path.resolve(workspaceCwd, ".reina", "reina.db");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
    }
    // :memory: DBs always journal in memory — the mode pragma is a no-op there.
    for (const pragma of pragmasFor(options.inMemory ? "WAL" : resolveJournalMode(dbPath))) {
      db.exec(pragma);
    }
    // Register the CJK tokenizer BEFORE migrations: the search-terms triggers
    // (migration v7) call it on every message/chunk write, and the migration
    // itself uses it for the backfill. Feature-detected — node:sqlite grew
    // user-defined functions in 22.13; without them the v7 migration no-ops
    // and CJK queries keep the LIKE fallback.
    registerSearchTermsFunction(db);
    migrate(db);
    return new SessionStore(db, dbPath);
  }

  /** Close the underlying DB handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ─── Workspace metadata ─────────────────────────────────────────────────

  /** Set a workspace-level metadata key (e.g. "name"). */
  setWorkspaceMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  /** Read a workspace-level metadata key. */
  getWorkspaceMeta(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM workspace_meta WHERE key = ?`)
      .get(key) as { value?: string } | undefined;
    return row?.value;
  }

  // ─── Sessions: index-level CRUD ─────────────────────────────────────────

  /** Insert or update the session's index row plus its cold-state blob.
   * Idempotent for the same (id, content) pair — safe to call after every
   * engine snapshot. */
  upsertSession(session: SessionState): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, title, cwd, agent,
        model_provider, model_name, model_base_url, model_context_window_tokens, model_reasoning_effort,
        permission_mode, output_style, output_style_custom,
        message_count, tool_count,
        usage_input_tokens, usage_output_tokens, usage_cached_input_tokens, usage_reasoning_tokens, usage_turns,
        is_subagent, subagent_depth, parent_id,
        created_at, updated_at, archived_at
      ) VALUES (
        @id, @title, @cwd, @agent,
        @model_provider, @model_name, @model_base_url, @model_context_window_tokens, @model_reasoning_effort,
        @permission_mode, @output_style, @output_style_custom,
        @message_count, @tool_count,
        @usage_input_tokens, @usage_output_tokens, @usage_cached_input_tokens, @usage_reasoning_tokens, @usage_turns,
        @is_subagent, @subagent_depth, @parent_id,
        @created_at, @updated_at, @archived_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        cwd = excluded.cwd,
        agent = excluded.agent,
        model_provider = excluded.model_provider,
        model_name = excluded.model_name,
        model_base_url = excluded.model_base_url,
        model_context_window_tokens = excluded.model_context_window_tokens,
        model_reasoning_effort = excluded.model_reasoning_effort,
        permission_mode = excluded.permission_mode,
        output_style = excluded.output_style,
        output_style_custom = excluded.output_style_custom,
        message_count = excluded.message_count,
        tool_count = excluded.tool_count,
        usage_input_tokens = excluded.usage_input_tokens,
        usage_output_tokens = excluded.usage_output_tokens,
        usage_cached_input_tokens = excluded.usage_cached_input_tokens,
        usage_reasoning_tokens = excluded.usage_reasoning_tokens,
        usage_turns = excluded.usage_turns,
        is_subagent = excluded.is_subagent,
        subagent_depth = excluded.subagent_depth,
        parent_id = excluded.parent_id,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `);
    stmt.run({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      agent: session.agent,
      model_provider: session.model.provider,
      model_name: session.model.model,
      model_base_url: session.model.baseUrl ?? null,
      model_context_window_tokens: session.model.contextWindowTokens ?? null,
      model_reasoning_effort: session.model.reasoningEffort ?? null,
      permission_mode: session.permissionMode,
      output_style: session.outputStyle ?? null,
      output_style_custom: session.outputStyleCustom ?? null,
      message_count: session.messages.length,
      tool_count: session.toolCalls.length,
      usage_input_tokens: session.usage?.inputTokens ?? 0,
      usage_output_tokens: session.usage?.outputTokens ?? 0,
      usage_cached_input_tokens: session.usage?.cachedInputTokens ?? 0,
      usage_reasoning_tokens: session.usage?.reasoningTokens ?? 0,
      usage_turns: session.usage?.turns ?? 0,
      is_subagent: session.isSubagent ? 1 : 0,
      subagent_depth: session.subagentDepth ?? 0,
      // Set for sessions created via the assistant menu "创建分支" fork; null for
      // normal/root sessions. Surfaces as SessionSummary.parentId.
      parent_id: session.parentSessionId ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      archived_at: null,
    });
    // Cold blob: everything not in the index. Stored as a single JSON blob;
    // promoted to columns only when something needs to query it.
    const blob: SessionStateBlob = {
      todos: session.todos,
      plan: session.plan,
      summary: session.summary,
      providerState: session.providerState,
      usage: session.usage,
      skills: session.skills,
      pendingQuestions: session.pendingQuestions,
      recentFiles: session.recentFiles,
      readFileTimestamps: session.readFileTimestamps,
      compactBoundaries: session.compactBoundaries,
      modelMessages: session.modelMessages,
      outputStyleCustom: session.outputStyleCustom,
      interrupted: session.interrupted,
      asyncTasksArchived: session.asyncTasksArchived,
      failedBriefs: session.failedBriefs,
      lastTurnTaskStatuses: session.lastTurnTaskStatuses,
      mcpServerNamesSnapshot: session.mcpServerNamesSnapshot,
      selfEvolveLog: session.selfEvolveLog,
      modelOverride: session.modelOverride,
    };
    this.db
      .prepare(
        `INSERT INTO session_state_blob (session_id, data) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
      )
      .run(session.id, JSON.stringify(blob));
  }

  /** Read the session's summary row only (no messages/tools/trace). Returns
   * undefined when the session id is unknown to this workspace. */
  getSessionSummary(sessionId: string): SessionSummary | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return rowToSummary(row);
  }

  /** List sessions for the sidebar. Sorted by updated_at DESC. */
  listSessions(filter: SessionListFilter = {}): SessionSummary[] {
    const where: string[] = [];
    if (!filter.includeArchived) where.push("archived_at IS NULL");
    if (!filter.includeSubagents) where.push("is_subagent = 0");
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${whereSql} ORDER BY updated_at DESC ${limitSql}`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToSummary);
  }

  /** Persist a full SessionState atomically: upserts the index row, the
   * cold-state blob, and replaces messages/tool_calls/trace_events with
   * the current authoritative arrays from the engine.
   *
   * Replace-not-merge is intentional: the engine's in-memory session IS
   * the source of truth; persistence is just mirroring it. Avoids any
   * drift between what the engine thinks it has and what's on disk. */
  persistSession(session: SessionState): void {
    this.db.exec("BEGIN");
    try {
      this.upsertSession(session);
      // Wipe and re-insert sub-collections. The volumes are small (<1k
      // typical) and the writes are batched in a single txn — perf is fine
      // through the low thousands of messages.
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(session.id);
      this.db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(session.id);
      this.db.prepare(`DELETE FROM trace_events WHERE session_id = ?`).run(session.id);
      this.db.prepare(`DELETE FROM async_tasks WHERE parent_session_id = ?`).run(session.id);
      this.insertMessages(session.id, session.messages, session.modelMessages);
      this.insertToolCalls(session.id, session.toolCalls);
      this.insertTraceEvents(session.id, session.trace);
      for (const task of session.asyncTasks ?? []) {
        this.upsertAsyncTask(session.id, task);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Load a full SessionState from disk. Returns undefined if unknown. */
  loadSession(sessionId: string): SessionState | undefined {
    const summary = this.getSessionSummary(sessionId);
    if (!summary) return undefined;
    const blobRow = this.db
      .prepare(`SELECT data FROM session_state_blob WHERE session_id = ?`)
      .get(sessionId) as { data?: string } | undefined;
    const blob: SessionStateBlob = blobRow?.data ? (JSON.parse(blobRow.data) as SessionStateBlob) : {};
    const messages = this.fetchMessages(sessionId);
    const toolCalls = this.fetchToolCalls(sessionId);
    const trace = this.fetchTraceEvents(sessionId);
    const model: ModelConfig = {
      provider: summary.model.provider as ModelConfig["provider"],
      model: summary.model.model,
    };
    const row = this.db
      .prepare(
        `SELECT model_base_url, model_context_window_tokens, model_reasoning_effort
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          model_base_url?: string | null;
          model_context_window_tokens?: number | null;
          model_reasoning_effort?: string | null;
        }
      | undefined;
    if (row?.model_base_url) model.baseUrl = row.model_base_url;
    if (row?.model_context_window_tokens) model.contextWindowTokens = row.model_context_window_tokens;
    if (row?.model_reasoning_effort) model.reasoningEffort = row.model_reasoning_effort as ModelConfig["reasoningEffort"];
    const usage: SessionState["usage"] = blob.usage
      ? {
          ...blob.usage,
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
          cachedInputTokens: summary.usage.cachedInputTokens,
          reasoningTokens: summary.usage.reasoningTokens,
          turns: summary.usage.turns,
        }
      : summary.usage;
    return {
      id: summary.id,
      title: summary.title,
      agent: summary.agent,
      cwd: summary.cwd,
      permissionMode: summary.permissionMode as SessionState["permissionMode"],
      model,
      outputStyle: undefined,
      outputStyleCustom: blob.outputStyleCustom,
      messages,
      modelMessages: blob.modelMessages,
      toolCalls,
      readFileTimestamps: blob.readFileTimestamps,
      recentFiles: blob.recentFiles,
      todos: blob.todos ?? [],
      pendingQuestions: blob.pendingQuestions ?? [],
      plan: blob.plan,
      skills: blob.skills ?? [],
      asyncTasks: this.fetchAsyncTasks(sessionId),
      asyncTasksArchived: blob.asyncTasksArchived,
      failedBriefs: blob.failedBriefs,
      lastTurnTaskStatuses: blob.lastTurnTaskStatuses,
      mcpServerNamesSnapshot: blob.mcpServerNamesSnapshot,
      selfEvolveLog: blob.selfEvolveLog,
      modelOverride: blob.modelOverride,
      subagentDepth: summary.subagentDepth,
      isSubagent: summary.isSubagent,
      trace,
      summary: blob.summary,
      compactBoundaries: blob.compactBoundaries,
      memoryChunks: this.listMemoryChunks(sessionId),
      providerState: blob.providerState,
      interrupted: blob.interrupted,
      usage,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    };
  }

  /** Soft-delete: flips archived_at so the session disappears from the
   * default list but its rows stay queryable. To truly delete, use
   * deleteSession. */
  archiveSession(sessionId: string, at: string): void {
    this.db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(at, sessionId);
  }

  /** Hard delete: removes the session row, which cascades to messages,
   * tool_calls, trace_events, async_tasks, and the state blob. */
  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  /** Move a session under a new title. Does not touch other fields. */
  renameSession(sessionId: string, title: string, updatedAt: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, updatedAt, sessionId);
  }

  // ─── Messages / tool calls / trace: append helpers ─────────────────────
  //
  // The engine usually emits these one at a time as a turn unfolds. The
  // bulk insert paths are used by `persistSession` (full replace) and by
  // the JSONL import migration.

  appendMessage(sessionId: string, message: ChatMessage, ordinal: number, inModelView = true): void {
    const metadata = messageMetadata(message);
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, ordinal, role, content, reasoning, reasoning_trace, attachments, metadata_json, in_model_view, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        ordinal,
        message.role,
        message.content,
        message.reasoning ?? null,
        message.reasoningTrace ? JSON.stringify(message.reasoningTrace) : null,
        message.attachments ? JSON.stringify(message.attachments) : null,
        metadata ? JSON.stringify(metadata) : null,
        inModelView ? 1 : 0,
        message.createdAt,
      );
  }

  appendToolCall(sessionId: string, record: ToolCallRecord, ordinal: number): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, ordinal, name, status, permission, summary, input, preview, output, error, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           summary = excluded.summary,
           input = excluded.input,
           preview = excluded.preview,
           output = excluded.output,
           error = excluded.error,
           completed_at = excluded.completed_at`,
      )
      .run(
        record.id,
        sessionId,
        ordinal,
        record.name,
        record.status,
        record.permission,
        record.summary ?? null,
        record.input !== undefined ? JSON.stringify(record.input) : null,
        record.preview !== undefined ? JSON.stringify(record.preview) : null,
        record.output ?? null,
        record.error ?? null,
        record.createdAt,
        record.completedAt ?? null,
      );
  }

  appendTrace(sessionId: string, event: TraceEvent, ordinal: number): void {
    this.db
      .prepare(
        `INSERT INTO trace_events (id, session_id, ordinal, type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.id, sessionId, ordinal, event.type, JSON.stringify(event.data), event.createdAt);
  }

  // ─── Async tasks ────────────────────────────────────────────────────────

  upsertAsyncTask(parentSessionId: string, task: AsyncTaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO async_tasks (
          id, parent_session_id, agent, description, status, result, error,
          isolation, worktree_path, worktree_branch, child_session_id, worktree_head,
          turns, tool_calls, attempt_count, resume_count,
          usage_input_tokens, usage_output_tokens, usage_cached_input_tokens, usage_reasoning_tokens, duration_ms,
          started_at, completed_at, notified_at, last_heartbeat_at, lease_owner, lease_expires_at, recovery_json, snapshot_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          agent = excluded.agent,
          description = excluded.description,
          status = excluded.status,
          result = excluded.result,
          error = excluded.error,
          isolation = excluded.isolation,
          worktree_path = excluded.worktree_path,
          worktree_branch = excluded.worktree_branch,
          child_session_id = excluded.child_session_id,
          worktree_head = excluded.worktree_head,
          turns = excluded.turns,
          tool_calls = excluded.tool_calls,
          attempt_count = excluded.attempt_count,
          resume_count = excluded.resume_count,
          usage_input_tokens = excluded.usage_input_tokens,
          usage_output_tokens = excluded.usage_output_tokens,
          usage_cached_input_tokens = excluded.usage_cached_input_tokens,
          usage_reasoning_tokens = excluded.usage_reasoning_tokens,
          duration_ms = excluded.duration_ms,
          completed_at = excluded.completed_at,
          notified_at = excluded.notified_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          recovery_json = excluded.recovery_json,
          snapshot_json = excluded.snapshot_json`,
      )
      .run(
        task.id,
        parentSessionId,
        task.agent,
        task.description,
        task.status,
        task.result ?? null,
        task.error ?? null,
        task.isolation,
        task.worktreePath ?? null,
        task.worktreeBranch ?? null,
        task.childSessionId ?? null,
        task.worktreeHead ?? null,
        task.turns ?? 0,
        task.toolCalls ?? 0,
        task.attemptCount ?? 0,
        task.resumeCount ?? 0,
        task.usage?.inputTokens ?? 0,
        task.usage?.outputTokens ?? 0,
        task.usage?.cachedInputTokens ?? 0,
        task.usage?.reasoningTokens ?? 0,
        task.usage?.durationMs ?? 0,
        task.startedAt,
        task.completedAt ?? null,
        task.notifiedAt ?? null,
        task.lastHeartbeatAt ?? null,
        task.leaseOwner ?? null,
        task.leaseExpiresAt ?? null,
        task.recovery ? JSON.stringify(task.recovery) : null,
        JSON.stringify(task),
      );
    this.upsertAsyncTaskAttempt(parentSessionId, task);
    this.upsertSubagentEdge(parentSessionId, task);
  }

  appendAsyncTaskEvent(
    parentSessionId: string,
    taskId: string,
    type: string,
    payload: unknown,
    createdAt = nowIso(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO async_task_events (id, parent_session_id, task_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(createId("ate"), parentSessionId, taskId, type, JSON.stringify(payload ?? {}), createdAt);
  }

  fetchAsyncTaskEvents(parentSessionId: string): AsyncTaskEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM async_task_events
         WHERE parent_session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(parentSessionId) as Record<string, unknown>[];
    return rows.map(rowToAsyncTaskEvent);
  }

  rebuildAsyncTaskProjectionFromEvents(parentSessionId: string): number {
    const events = this.fetchAsyncTaskEvents(parentSessionId);
    const latest = new Map<string, AsyncTaskRecord>();
    for (const event of events) {
      const snapshot = event.payload.taskSnapshot;
      if (!isAsyncTaskSnapshot(snapshot)) continue;
      latest.set(event.taskId, snapshot);
    }
    for (const task of latest.values()) {
      this.upsertAsyncTask(parentSessionId, task);
    }
    return latest.size;
  }

  tryAcquireAsyncTaskLease(
    parentSessionId: string,
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    now = nowIso(),
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE async_tasks
         SET status = 'resuming',
             lease_owner = ?,
             lease_expires_at = ?
         WHERE id = ?
           AND parent_session_id = ?
           AND status IN ('recoverable', 'evicted')
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(leaseOwner, leaseExpiresAt, taskId, parentSessionId, now);
    return result.changes === 1;
  }

  enqueueAsyncTaskUpdate(
    parentSessionId: string,
    taskId: string,
    message: string,
    createdAt = nowIso(),
  ): string {
    const id = createId("atu");
    this.db
      .prepare(
        `INSERT INTO async_task_updates (id, parent_session_id, task_id, message, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, parentSessionId, taskId, message, createdAt);
    return id;
  }

  claimPendingAsyncTaskUpdates(
    parentSessionId: string,
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    limit = 16,
    now = nowIso(),
  ): AsyncTaskUpdateRecord[] {
    const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT *
         FROM async_task_updates
         WHERE parent_session_id = ?
           AND task_id = ?
           AND (
             status = 'pending'
             OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(parentSessionId, taskId, now, cappedLimit) as Record<string, unknown>[];
    if (rows.length === 0) return [];

    const update = this.db.prepare(
      `UPDATE async_task_updates
       SET status = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           claimed_at = ?
       WHERE id = ?
         AND parent_session_id = ?
         AND task_id = ?
         AND (
           status = 'pending'
           OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         )`,
    );
    const claimed: AsyncTaskUpdateRecord[] = [];
    for (const row of rows) {
      const id = row.id as string;
      const result = update.run(leaseOwner, leaseExpiresAt, now, id, parentSessionId, taskId, now);
      if (result.changes !== 1) continue;
      claimed.push(
        rowToAsyncTaskUpdate({
          ...row,
          status: "claimed",
          lease_owner: leaseOwner,
          lease_expires_at: leaseExpiresAt,
          claimed_at: now,
        }),
      );
    }
    return claimed;
  }

  markAsyncTaskUpdatesApplied(
    parentSessionId: string,
    updateIds: string[],
    appliedAt = nowIso(),
  ): void {
    if (updateIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE async_task_updates
       SET status = 'applied',
           applied_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ?
         AND parent_session_id = ?
         AND status = 'claimed'`,
    );
    for (const id of updateIds) {
      stmt.run(appliedAt, id, parentSessionId);
    }
  }

  dropPendingAsyncTaskUpdates(
    parentSessionId: string,
    taskId: string,
    reason: string,
    droppedAt = nowIso(),
  ): void {
    this.db
      .prepare(
        `UPDATE async_task_updates
         SET status = 'dropped',
             dropped_at = ?,
             error = ?,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE parent_session_id = ?
           AND task_id = ?
           AND (
             status = 'pending'
             OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )`,
      )
      .run(droppedAt, reason, parentSessionId, taskId, droppedAt);
  }

  fetchAsyncTasks(parentSessionId: string): AsyncTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM async_tasks WHERE parent_session_id = ? ORDER BY started_at ASC`,
      )
      .all(parentSessionId) as Record<string, unknown>[];
    return rows.map(rowToAsyncTask);
  }

  // ─── FTS5 search ────────────────────────────────────────────────────────

  /** Full-text search across every message in this workspace. Query syntax
   * is FTS5's MATCH grammar — bare words for AND, "phrase" for quoted,
   * `OR`/`NOT` for boolean. Limit defaults to 50 hits.
   *
   * CJK queries skip FTS entirely and use a LIKE substring scan: the fts
   * table's default unicode61 tokenizer lumps consecutive CJK characters into
   * ONE token, so a Chinese word like 新闻 can only MATCH where it happens to
   * stand alone — a partial (and misleading) result set. Non-CJK queries that
   * produce zero FTS hits also fall back to LIKE. The scan is bounded by
   * LIMIT and per-workspace DBs are small, so both paths stay cheap. */
  searchMessages(query: string, limit = 50): SearchHit[] {
    if (!query.trim()) return [];
    if (CJK_RE.test(query)) {
      // Indexed CJK path (uni+bigram terms, migration v7). Zero hits still
      // fall through to the LIKE scan: the terms index matches whole latin
      // tokens + CJK bigrams, while LIKE finds raw substrings across
      // punctuation — keep the old recall as the safety net.
      const viaTerms = this.searchMessagesTerms(query, limit);
      if (viaTerms !== null && viaTerms.length > 0) return viaTerms;
      return this.searchMessagesLike(query, limit);
    }
    const rows = this.db
      .prepare(
        `SELECT
           m.id, m.session_id, m.ordinal, m.role, m.created_at,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(query, Math.max(1, Math.floor(limit))) as Array<{
        id: string;
        session_id: string;
        ordinal: number;
        role: string;
        created_at: string;
        snippet: string;
      }>;
    if (rows.length > 0) {
      return rows.map((r) => ({
        sessionId: r.session_id,
        messageId: r.id,
        ordinal: r.ordinal,
        role: r.role,
        snippet: r.snippet,
        createdAt: r.created_at,
      }));
    }
    return this.searchMessagesLike(query, limit);
  }

  /** CJK query via the uni+bigram terms index (messages_fts_terms). Returns
   * null when the index is unusable (pre-v7 DB whose migration no-oped, or a
   * MATCH grammar edge) so the caller falls back to the LIKE scan. Snippets
   * are built in JS from the raw content — the indexed terms string is
   * tokenizer output, useless for display. */
  private searchMessagesTerms(query: string, limit: number): SearchHit[] | null {
    const match = searchMatchQuery(query);
    if (!match) return null;
    let rows: Array<{ id: string; session_id: string; ordinal: number; role: string; created_at: string; content: string }>;
    try {
      rows = this.db
        .prepare(
          `SELECT m.id, m.session_id, m.ordinal, m.role, m.created_at, m.content
           FROM messages_fts_terms t
           JOIN messages m ON m.rowid = t.rowid
           WHERE messages_fts_terms MATCH ?
           ORDER BY m.created_at DESC
           LIMIT ?`,
        )
        .all(match, Math.max(1, Math.floor(limit))) as typeof rows;
    } catch {
      return null;
    }
    return rows.map((r) => this.toMarkedHit(r, query.trim()));
  }

  /** LIKE-based substring search over message content — the CJK fallback of
   * searchMessages. Builds FTS-compatible snippets (`<mark>` around the
   * first occurrence, ±80 chars of context) so callers can't tell the two
   * paths apart. */
  private searchMessagesLike(query: string, limit: number): SearchHit[] {
    const needle = query.trim();
    if (!needle) return [];
    const pattern = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT id, session_id, ordinal, role, created_at, content
         FROM messages
         WHERE content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(pattern, Math.max(1, Math.floor(limit))) as Array<{
        id: string;
        session_id: string;
        ordinal: number;
        role: string;
        created_at: string;
        content: string;
      }>;
    return rows.map((r) => this.toMarkedHit(r, needle));
  }

  /** Row → SearchHit with a `<mark>`ed snippet around the needle's first
   * occurrence (±80 chars). Shared by the LIKE scan and the terms-index path;
   * a terms hit whose needle isn't a literal substring (latin prefix match,
   * cross-punctuation bigrams) takes the plain head-slice branch. */
  private toMarkedHit(
    r: { id: string; session_id: string; ordinal: number; role: string; created_at: string; content: string },
    needle: string,
  ): SearchHit {
    const flat = r.content.replace(/\s+/g, " ");
    const idx = flat.toLowerCase().indexOf(needle.toLowerCase());
    // SQLite LIKE is ASCII-case-insensitive only, so idx can't miss for the
    // rows LIKE matched; guard anyway for exotic collation edge cases (and
    // for terms-index hits, where the needle may not appear verbatim).
    if (idx < 0) {
      return {
        sessionId: r.session_id,
        messageId: r.id,
        ordinal: r.ordinal,
        role: r.role,
        snippet: flat.slice(0, 160).trim() + (flat.length > 160 ? "…" : ""),
        createdAt: r.created_at,
      };
    }
    const start = Math.max(0, idx - 80);
    const end = Math.min(flat.length, idx + needle.length + 80);
    const snippet =
      (start > 0 ? "…" : "") +
      flat.slice(start, idx) +
      `<mark>${flat.slice(idx, idx + needle.length)}</mark>` +
      flat.slice(idx + needle.length, end) +
      (end < flat.length ? "…" : "");
    return {
      sessionId: r.session_id,
      messageId: r.id,
      ordinal: r.ordinal,
      role: r.role,
      snippet: snippet.trim(),
      createdAt: r.created_at,
    };
  }

  /** Search over offloaded memory chunks across EVERY session in this
   * workspace (topic line + content). Tries the uni+bigram terms index first
   * (memory_chunks_fts, migration v7 — covers CJK and latin-prefix queries
   * with an indexed lookup instead of the old unbounded LIKE scan), then
   * falls back to the LIKE substring scan for raw-substring recall and
   * pre-v7 DBs. */
  searchMemoryChunks(query: string, limit = 20): Array<{
    sessionId: string;
    chunkId: string;
    topicLine: string;
    tokenCount: number;
    createdAt: string;
    snippet: string;
  }> {
    const needle = query.trim();
    if (!needle) return [];
    type ChunkRow = {
      session_id: string;
      id: string;
      topic_line: string;
      token_count: number;
      created_at: string;
      content: string;
    };
    let rows: ChunkRow[] | null = null;
    const match = searchMatchQuery(needle);
    if (match) {
      try {
        rows = this.db
          .prepare(
            `SELECT c.session_id, c.id, c.topic_line, c.token_count, c.created_at, c.content
             FROM memory_chunks_fts t
             JOIN memory_chunks c ON c.rowid = t.rowid
             WHERE memory_chunks_fts MATCH ?
             ORDER BY c.created_at DESC
             LIMIT ?`,
          )
          .all(match, Math.max(1, Math.floor(limit))) as ChunkRow[];
      } catch {
        rows = null; // terms index unavailable (pre-v7 no-op migration) — LIKE below
      }
    }
    if (!rows || rows.length === 0) {
      const pattern = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      rows = this.db
        .prepare(
          `SELECT session_id, id, topic_line, token_count, created_at, content
           FROM memory_chunks
           WHERE topic_line LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(pattern, pattern, Math.max(1, Math.floor(limit))) as ChunkRow[];
    }
    return rows.map((r) => {
      const idx = r.content.toLowerCase().indexOf(needle.toLowerCase());
      const start = Math.max(0, idx - 80);
      const raw = idx >= 0 ? r.content.slice(start, idx + needle.length + 120) : r.content.slice(0, 200);
      const snippet = `${start > 0 ? "…" : ""}${raw.replace(/\s+/g, " ").trim()}…`;
      return {
        sessionId: r.session_id,
        chunkId: r.id,
        topicLine: r.topic_line,
        tokenCount: r.token_count,
        createdAt: r.created_at,
        snippet,
      };
    });
  }

  /** Titles for a set of session ids — used to label cross-session search
   * hits without loading full sessions. */
  getSessionTitles(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, title FROM sessions WHERE id IN (${placeholders})`)
      .all(...unique) as Array<{ id: string; title: string }>;
    for (const row of rows) out.set(row.id, row.title);
    return out;
  }

  /** Compact briefs of sessions updated after `sinceIso` (all when omitted),
   * newest first — the raw material for memory consolidation. `summary` is
   * the session's rolling compaction summary, extracted in SQL from the cold
   * blob (json_valid gates json_extract, which THROWS on malformed JSON —
   * a corrupt blob just loses its summary). Subagent and archived sessions
   * are excluded, same as
   * listSessions — worker transcripts aren't durable material. `untilIso`
   * bounds the window from above (codex-style idle filter: only sessions
   * that have gone quiet are settled enough to summarize). */
  listRecentSessionBriefs(sinceIso?: string, limit = 20, untilIso?: string): Array<{
    id: string;
    title: string;
    agent: string;
    updatedAt: string;
    messageCount: number;
    summary?: string;
  }> {
    const sinceClause = (sinceIso ? " AND s.updated_at > ?" : "") + (untilIso ? " AND s.updated_at <= ?" : "");
    const params: unknown[] = [...(sinceIso ? [sinceIso] : []), ...(untilIso ? [untilIso] : [])];
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.agent, s.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                CASE WHEN json_valid(b.data) THEN json_extract(b.data, '$.summary') END AS summary
         FROM sessions s
         LEFT JOIN session_state_blob b ON b.session_id = s.id
         WHERE s.is_subagent = 0 AND s.archived_at IS NULL${sinceClause}
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(...(params as never[]), Math.max(1, Math.floor(limit))) as Array<{
        id: string;
        title: string;
        agent: string;
        updated_at: string;
        message_count: number;
        summary: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      agent: r.agent,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
      ...(typeof r.summary === "string" && r.summary.trim() ? { summary: r.summary } : {}),
    }));
  }

  /** Count of top-level live sessions updated after `sinceIso` (all when
   * omitted). Drives the memory-consolidation gate — subagent and
   * archived sessions don't count toward it. `untilIso` bounds the window
   * from above so still-active sessions don't open the gate early. */
  countSessionsUpdatedSince(sinceIso?: string, untilIso?: string): number {
    const clauses = ["is_subagent = 0", "archived_at IS NULL"];
    const params: unknown[] = [];
    if (sinceIso) {
      clauses.push("updated_at > ?");
      params.push(sinceIso);
    }
    if (untilIso) {
      clauses.push("updated_at <= ?");
      params.push(untilIso);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${clauses.join(" AND ")}`)
      .get(...(params as never[])) as { n: number };
    return row.n;
  }

  /** True when at least one of `ids` is a top-level, non-archived session.
   * Backs the retrieval-as-signal check in search_memory: a hit only counts
   * as "a past session needed this twice" when it comes from a real user
   * session, not a subagent/worker transcript or an archived one. */
  hasDurableSessions(ids: string[]): boolean {
    if (ids.length === 0) return false;
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM sessions WHERE id IN (${placeholders}) AND is_subagent = 0 AND archived_at IS NULL LIMIT 1`)
      .get(...(unique as never[])) as { hit: number } | undefined;
    return row !== undefined;
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────

  /** Run a one-off raw SQL query. ONLY for tests / debug tools — production
   * code MUST go through the typed API above. */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }
  rawAll(sql: string, ...params: unknown[]): unknown[] {
    return this.db.prepare(sql).all(...(params as never[])) as unknown[];
  }

  private upsertAsyncTaskAttempt(parentSessionId: string, task: AsyncTaskRecord): void {
    if (!task.childSessionId) return;
    const completedAt = isTerminalAsyncTaskStatus(task.status) ? (task.completedAt ?? null) : null;
    const attemptId = `${task.id}:${task.childSessionId}`;
    this.db
      .prepare(
        `INSERT INTO async_task_attempts (
          id, parent_session_id, task_id, child_session_id, worker_id,
          status, started_at, heartbeat_at, completed_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          heartbeat_at = excluded.heartbeat_at,
          completed_at = excluded.completed_at,
          error = excluded.error`,
      )
      .run(
        attemptId,
        parentSessionId,
        task.id,
        task.childSessionId,
        task.leaseOwner ?? task.childSessionId,
        task.status,
        task.startedAt,
        task.lastHeartbeatAt ?? null,
        completedAt,
        task.error ?? null,
      );
  }

  private upsertSubagentEdge(parentSessionId: string, task: AsyncTaskRecord): void {
    if (!task.childSessionId) return;
    const updatedAt = task.completedAt ?? task.lastHeartbeatAt ?? nowIso();
    const edgeStatus = edgeStatusForAsyncTask(task.status);
    this.db
      .prepare(
        `UPDATE subagent_edges
         SET status = 'closed',
             updated_at = ?,
             closed_at = ?,
             close_reason = 'superseded_by_attempt'
         WHERE parent_session_id = ?
           AND task_id = ?
           AND child_session_id <> ?
           AND status <> 'closed'`,
      )
      .run(updatedAt, updatedAt, parentSessionId, task.id, task.childSessionId);
    const closedAt = edgeStatus === "closed" ? (task.completedAt ?? updatedAt) : null;
    const closeReason = edgeStatus === "closed" ? task.status : null;
    this.db
      .prepare(
        `INSERT INTO subagent_edges (
          parent_session_id, task_id, child_session_id, agent, status,
          attempt_count, created_at, updated_at, closed_at, close_reason, recovery_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(parent_session_id, task_id, child_session_id) DO UPDATE SET
          agent = excluded.agent,
          status = excluded.status,
          attempt_count = excluded.attempt_count,
          updated_at = excluded.updated_at,
          closed_at = excluded.closed_at,
          close_reason = excluded.close_reason,
          recovery_json = excluded.recovery_json`,
      )
      .run(
        parentSessionId,
        task.id,
        task.childSessionId,
        task.agent,
        edgeStatus,
        task.attemptCount ?? 0,
        task.startedAt,
        updatedAt,
        closedAt,
        closeReason,
        task.recovery ? JSON.stringify(task.recovery) : null,
      );
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private insertMessages(
    sessionId: string,
    messages: ChatMessage[],
    modelMessages: ChatMessage[] | undefined,
  ): void {
    if (messages.length === 0) return;
    const modelMessageIds = new Set(modelMessages?.map((m) => m.id) ?? []);
    const inModelViewByIndex = (m: ChatMessage) => {
      // When the engine hasn't done any compaction, modelMessages is undefined
      // and every message is in-view. After compaction, only ids in
      // modelMessages are still in-view.
      if (!modelMessages) return 1;
      return modelMessageIds.has(m.id) ? 1 : 0;
    };
    const stmt = this.db.prepare(
      `INSERT INTO messages (id, session_id, ordinal, role, content, reasoning, reasoning_trace, attachments, metadata_json, in_model_view, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]!;
      const metadata = messageMetadata(m);
      stmt.run(
        m.id,
        sessionId,
        i,
        m.role,
        m.content,
        m.reasoning ?? null,
        m.reasoningTrace ? JSON.stringify(m.reasoningTrace) : null,
        m.attachments ? JSON.stringify(m.attachments) : null,
        metadata ? JSON.stringify(metadata) : null,
        inModelViewByIndex(m),
        m.createdAt,
      );
    }
  }

  private insertToolCalls(sessionId: string, calls: ToolCallRecord[]): void {
    if (calls.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO tool_calls (id, session_id, ordinal, name, status, permission, summary, input, preview, output, error, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i]!;
      stmt.run(
        c.id,
        sessionId,
        i,
        c.name,
        c.status,
        c.permission,
        c.summary ?? null,
        c.input !== undefined ? JSON.stringify(c.input) : null,
        c.preview !== undefined ? JSON.stringify(c.preview) : null,
        c.output ?? null,
        c.error ?? null,
        c.createdAt,
        c.completedAt ?? null,
      );
    }
  }

  private insertTraceEvents(sessionId: string, events: TraceEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO trace_events (id, session_id, ordinal, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]!;
      stmt.run(e.id, sessionId, i, e.type, JSON.stringify(e.data), e.createdAt);
    }
  }

  private fetchMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, reasoning, reasoning_trace, attachments, metadata_json, created_at
         FROM messages WHERE session_id = ? ORDER BY ordinal ASC`,
      )
      .all(sessionId) as Array<{
        id: string;
        role: string;
        content: string;
        reasoning: string | null;
        reasoning_trace: string | null;
        attachments: string | null;
        metadata_json: string | null;
        created_at: string;
      }>;
    return rows.map((row) => {
      const msg: ChatMessage = {
        id: row.id,
        role: row.role as ChatMessage["role"],
        content: row.content,
        createdAt: row.created_at,
      };
      if (row.reasoning) msg.reasoning = row.reasoning;
      if (row.reasoning_trace) msg.reasoningTrace = JSON.parse(row.reasoning_trace) as ChatMessage["reasoningTrace"];
      if (row.attachments) msg.attachments = JSON.parse(row.attachments) as ChatMessage["attachments"];
      if (row.metadata_json) Object.assign(msg, JSON.parse(row.metadata_json) as Partial<ChatMessage>);
      return msg;
    });
  }

  private fetchToolCalls(sessionId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_calls WHERE session_id = ? ORDER BY ordinal ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const record: ToolCallRecord = {
        id: row.id as string,
        name: row.name as ToolCallRecord["name"],
        input: row.input ? JSON.parse(row.input as string) : undefined,
        summary: (row.summary as string) ?? "",
        permission: row.permission as ToolCallRecord["permission"],
        status: row.status as ToolCallRecord["status"],
        createdAt: row.created_at as string,
      };
      if (row.preview) record.preview = JSON.parse(row.preview as string);
      if (row.output) record.output = row.output as string;
      if (row.error) record.error = row.error as string;
      if (row.completed_at) record.completedAt = row.completed_at as string;
      return record;
    });
  }

  private fetchTraceEvents(sessionId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, data, created_at FROM trace_events WHERE session_id = ? ORDER BY ordinal ASC`,
      )
      .all(sessionId) as Array<{ id: string; type: string; data: string; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type as TraceEvent["type"],
      createdAt: row.created_at,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }

  // ─── Memory chunks (Phase B compaction offload) ─────────────────────────

  /** Append a batch of compaction chunks for a session. Each chunk's
   * ordinal is computed as (max existing ordinal for this session) + 1 + i.
   * Idempotent on (id) — re-inserting the same id is a no-op. */
  insertMemoryChunks(sessionId: string, chunks: MemoryChunk[]): void {
    if (chunks.length === 0) return;
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(ordinal), -1) AS max_ord FROM memory_chunks WHERE session_id = ?`)
      .get(sessionId) as { max_ord: number };
    const startOrdinal = row.max_ord + 1;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_chunks (
        id, session_id, ordinal, topic_line, tool_names, token_count, message_ids, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      chunks.forEach((chunk, i) => {
        stmt.run(
          chunk.id,
          sessionId,
          startOrdinal + i,
          chunk.topicLine,
          JSON.stringify(chunk.toolNames),
          chunk.tokenCount,
          JSON.stringify(chunk.messageIds),
          chunk.content,
          chunk.createdAt,
        );
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Return all chunk metadata for a session, ordered oldest→newest.
   * Content body is NOT included — use `readMemoryChunk(id)` for that. */
  listMemoryChunks(sessionId: string): MemoryChunkMeta[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, topic_line, tool_names, token_count, message_ids, created_at
         FROM memory_chunks WHERE session_id = ? ORDER BY ordinal ASC`,
      )
      .all(sessionId) as Array<{
        id: string;
        session_id: string;
        topic_line: string;
        tool_names: string;
        token_count: number;
        message_ids: string;
        created_at: string;
      }>;
    return rows.map(rowToMemoryChunkMeta);
  }

  /** Load one chunk including content. Returns undefined if not found.
   * Scoped by session id because chunk ids (e.g. `c_001`) are unique per
   * session, not globally. */
  readMemoryChunk(sessionId: string, id: string): MemoryChunk | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, topic_line, tool_names, token_count, message_ids, content, created_at
         FROM memory_chunks WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, id) as
      | {
          id: string;
          session_id: string;
          topic_line: string;
          tool_names: string;
          token_count: number;
          message_ids: string;
          content: string;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return { ...rowToMemoryChunkMeta(row), content: row.content };
  }
}

function messageMetadata(message: ChatMessage): Record<string, unknown> | undefined {
  const metadata = {
    ...(message.ephemeral !== undefined ? { ephemeral: message.ephemeral } : {}),
    ...(message.contextState !== undefined ? { contextState: message.contextState } : {}),
    ...(message.origin !== undefined ? { origin: message.origin } : {}),
    ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
    ...(message.tokenUsage !== undefined ? { tokenUsage: message.tokenUsage } : {}),
    ...(message.toolResult !== undefined ? { toolResult: message.toolResult } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function rowToSummary(row: Record<string, unknown>): SessionSummary {
  const summary: SessionSummary = {
    id: row.id as string,
    title: row.title as string,
    cwd: row.cwd as string,
    agent: row.agent as string,
    model: {
      provider: row.model_provider as string,
      model: row.model_name as string,
    },
    permissionMode: row.permission_mode as string,
    messageCount: row.message_count as number,
    toolCount: row.tool_count as number,
    usage: {
      inputTokens: row.usage_input_tokens as number,
      outputTokens: row.usage_output_tokens as number,
      cachedInputTokens: row.usage_cached_input_tokens as number,
      reasoningTokens: row.usage_reasoning_tokens as number,
      turns: row.usage_turns as number,
    },
    isSubagent: Boolean(row.is_subagent),
    subagentDepth: row.subagent_depth as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  if (row.parent_id) summary.parentId = row.parent_id as string;
  if (row.archived_at) summary.archivedAt = row.archived_at as string;
  return summary;
}

function rowToAsyncTask(row: Record<string, unknown>): AsyncTaskRecord {
  const snapshot = typeof row.snapshot_json === "string"
    ? (JSON.parse(row.snapshot_json) as Partial<AsyncTaskRecord>)
    : {};
  const task: AsyncTaskRecord = {
    ...snapshot,
    id: row.id as string,
    agent: row.agent as string,
    description: row.description as string,
    status: row.status as AsyncTaskRecord["status"],
    isolation: row.isolation as AsyncTaskRecord["isolation"],
    startedAt: row.started_at as string,
    turns: row.turns as number,
    toolCalls: row.tool_calls as number,
  };
  if (row.result) task.result = row.result as string;
  if (row.error) task.error = row.error as string;
  if (row.worktree_path) task.worktreePath = row.worktree_path as string;
  if (row.worktree_branch) task.worktreeBranch = row.worktree_branch as string;
  if (row.child_session_id) task.childSessionId = row.child_session_id as string;
  if (row.worktree_head) task.worktreeHead = row.worktree_head as string;
  if (row.attempt_count !== undefined) task.attemptCount = row.attempt_count as number;
  if (row.resume_count !== undefined) task.resumeCount = row.resume_count as number;
  if (row.completed_at) task.completedAt = row.completed_at as string;
  if (row.notified_at) task.notifiedAt = row.notified_at as string;
  if (row.last_heartbeat_at) task.lastHeartbeatAt = row.last_heartbeat_at as string;
  if (row.lease_owner) task.leaseOwner = row.lease_owner as string;
  if (row.lease_expires_at) task.leaseExpiresAt = row.lease_expires_at as string;
  if (row.recovery_json) task.recovery = JSON.parse(row.recovery_json as string) as AsyncTaskRecord["recovery"];
  if (row.duration_ms !== undefined) {
    task.usage = {
      inputTokens: (row.usage_input_tokens as number) ?? 0,
      outputTokens: (row.usage_output_tokens as number) ?? 0,
      cachedInputTokens: (row.usage_cached_input_tokens as number) ?? 0,
      reasoningTokens: (row.usage_reasoning_tokens as number) ?? 0,
      durationMs: (row.duration_ms as number) ?? 0,
    };
  }
  return task;
}

function rowToAsyncTaskUpdate(row: Record<string, unknown>): AsyncTaskUpdateRecord {
  const record: AsyncTaskUpdateRecord = {
    id: row.id as string,
    parentSessionId: row.parent_session_id as string,
    taskId: row.task_id as string,
    message: row.message as string,
    status: row.status as AsyncTaskUpdateRecord["status"],
    createdAt: row.created_at as string,
  };
  if (row.lease_owner) record.leaseOwner = row.lease_owner as string;
  if (row.lease_expires_at) record.leaseExpiresAt = row.lease_expires_at as string;
  if (row.claimed_at) record.claimedAt = row.claimed_at as string;
  if (row.applied_at) record.appliedAt = row.applied_at as string;
  if (row.dropped_at) record.droppedAt = row.dropped_at as string;
  if (row.error) record.error = row.error as string;
  return record;
}

function rowToAsyncTaskEvent(row: Record<string, unknown>): AsyncTaskEventRecord {
  return {
    id: row.id as string,
    parentSessionId: row.parent_session_id as string,
    taskId: row.task_id as string,
    type: row.type as string,
    payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string,
  };
}

function isAsyncTaskSnapshot(value: unknown): value is AsyncTaskRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AsyncTaskRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.agent === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.startedAt === "string" &&
    (candidate.isolation === "none" || candidate.isolation === "worktree")
  );
}

function isTerminalAsyncTaskStatus(status: AsyncTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "failed_unrecoverable";
}

function edgeStatusForAsyncTask(status: AsyncTaskRecord["status"]): "open" | "recoverable" | "needs_attention" | "closed" {
  if (status === "recoverable" || status === "evicted" || status === "orphaned") return "recoverable";
  if (status === "needs_attention") return "needs_attention";
  if (isTerminalAsyncTaskStatus(status)) return "closed";
  return "open";
}

function rowToMemoryChunkMeta(row: {
  id: string;
  session_id: string;
  topic_line: string;
  tool_names: string;
  token_count: number;
  message_ids: string;
  created_at: string;
}): MemoryChunkMeta {
  return {
    id: row.id,
    sessionId: row.session_id,
    topicLine: row.topic_line,
    toolNames: JSON.parse(row.tool_names) as string[],
    tokenCount: row.token_count,
    messageIds: JSON.parse(row.message_ids) as string[],
    createdAt: row.created_at,
  };
}
