import { mkdir, open, readdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type {
  RolloutItem,
  RolloutLine,
  SessionMeta,
  SessionState,
  ToolCallRecord,
} from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

/**
 * Append-only persistence for sessions, modeled on openai/codex's rollout
 * recorder. One `<id>.jsonl` per session; every state mutation lands as a
 * single line `{ ts, type, ... }`. Loading replays the file through
 * `reduceRolloutItems` to reconstruct the current SessionState.
 *
 * Invariants:
 *   - Writes are `O_APPEND` only. No code path ever rewrites an existing
 *     byte, so concurrent writers (even across processes) cannot clobber
 *     each other's history.
 *   - Within a single Node process, a recorder keeps ONE file handle open
 *     for its lifetime, and serializes all appends through a Promise chain.
 *     This avoids re-open-per-append overhead and preserves the line order
 *     the engine cares about for replay.
 *   - I/O failures drop the handle (no `.close()` from a poisoned state) but
 *     keep the queue going; the next append reopens.
 *   - `flush()` awaits the queue *and* fsyncs the handle, guaranteeing
 *     durability for callers that block on save_session.
 *
 * Schema version: 1. Bump when reducer semantics or RolloutItem variants
 * change in a way that requires migration.
 */
export const ROLLOUT_SCHEMA_VERSION = 1 as const;

/** Where to forward warnings/errors when something unexpected happens during
 * rollout I/O. Defaults to `console.warn` but the engine wires in its own
 * logger so messages surface on the host's stderr stream. */
export type RolloutLogger = (level: "info" | "warn" | "error", message: string) => void;

const defaultLogger: RolloutLogger = (level, message) => {
  if (level === "error") console.error(`[rollout] ${message}`);
  else if (level === "warn") console.warn(`[rollout] ${message}`);
  else console.info(`[rollout] ${message}`);
};

/** Canonical wire encoding of ONE rollout line (`{ ts, ...item }` + newline).
 * The single source of truth for the envelope — append() and the deferred
 * session_meta head both go through here so the two can never diverge. */
function serializeLine(item: RolloutItem | { type: "session_meta"; meta: SessionMeta }): string {
  const line: RolloutLine = { ts: nowIso(), ...item };
  return `${JSON.stringify(line)}\n`;
}

export interface RolloutRecorderOptions {
  /** Write a `session_meta` line as the first append. Pass when opening a
   * brand-new session file; omit when reopening an existing one. */
  firstMeta?: SessionMeta;
  logger?: RolloutLogger;
}

/**
 * Per-session append-only recorder. Hold one of these for the engine's
 * lifetime; do NOT open a second recorder for the same path — both would
 * append, but cross-recorder ordering would no longer be deterministic.
 */
export class RolloutRecorder {
  private chain: Promise<unknown> = Promise.resolve();
  private handle: FileHandle | null = null;
  private closed = false;
  private readonly logger: RolloutLogger;
  /** session_meta held in memory until the first real append materializes
   * the file (codex-style deferred creation). A session that's created but
   * never used leaves NO file on disk — so abandoned drafts and throwaway
   * engines don't pile up as ghost "Reina" entries in the sidebar. */
  private pendingMeta: SessionMeta | null = null;

  private constructor(public readonly filePath: string, logger: RolloutLogger) {
    this.logger = logger;
  }

  static async open(filePath: string, opts: RolloutRecorderOptions = {}): Promise<RolloutRecorder> {
    const recorder = new RolloutRecorder(filePath, opts.logger ?? defaultLogger);
    // Deferred: no mkdir/open/write here. The first append() materializes
    // the file and writes the session_meta line ahead of the item.
    recorder.pendingMeta = opts.firstMeta ?? null;
    return recorder;
  }

  /** Enqueue an item for append. Returns a promise that resolves once the
   * line has been written. Callers normally fire-and-forget but may await
   * for write-ordering guarantees (e.g. before tearing the session down). */
  append(item: RolloutItem): Promise<void> {
    if (this.closed) return Promise.resolve();
    const text = serializeLine(item);
    const next = this.chain.then(() => this.writeLine(text)).catch((error) => {
      // Don't propagate — that'd reject every future caller. Surface via the
      // logger so the host's stderr stream picks it up. Subsequent appends
      // will trigger a reopen attempt inside writeLine.
      this.logger("error", `append failed for ${this.filePath}: ${(error as Error).message}`);
    });
    this.chain = next;
    return next;
  }

  /** Append and fsync one item before acknowledging delivery to its producer.
   * Unlike ordinary recording, failures reach the caller. The shared queue
   * still recovers so an I/O failure cannot poison later ordinary appends. */
  appendDurable(item: RolloutItem): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`Rollout recorder is closed: ${this.filePath}`));
    const text = serializeLine(item);
    const next = this.chain.then(async () => {
      await this.writeLine(text);
      // writeLine opens the handle; close waits for this same queue.
      await this.handle!.sync();
    });
    this.chain = next.catch((error) => {
      this.logger("error", `durable append failed for ${this.filePath}: ${(error as Error).message}`);
    });
    return next;
  }

  /**
   * Wait for the queue to drain AND fsync the file. After this returns the
   * caller can trust that every prior `append()` is durable on disk. Pair
   * with the host's `save_session` request before a session shuts down.
   */
  async flush(): Promise<void> {
    await this.chain;
    if (!this.handle) return;
    try {
      // Use sync (full data + metadata flush). datasync is faster but
      // doesn't update the file's metadata (mtime), which we rely on for
      // sidebar sort-by-modified.
      await this.handle.sync();
    } catch (error) {
      this.logger("error", `flush sync failed for ${this.filePath}: ${(error as Error).message}`);
    }
  }

  /** Close the underlying file handle. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.chain;
    } catch {
      // already logged
    }
    if (this.handle) {
      try {
        await this.handle.close();
      } catch (error) {
        this.logger("warn", `close failed for ${this.filePath}: ${(error as Error).message}`);
      }
      this.handle = null;
    }
  }

  private async writeLine(text: string): Promise<void> {
    if (!this.handle) {
      // First write (deferred materialization) or recovery path (previous
      // write failed and the handle was dropped). Open once; if it fails the
      // error bubbles into the chain's .catch and the next append retries.
      await mkdir(path.dirname(this.filePath), { recursive: true });
      this.handle = await openAppend(this.filePath, this.logger);
    }
    try {
      // Seed the session_meta head in the SAME write as the first item: one
      // syscall, and no crash window between two writes that could leave a
      // meta-only file — exactly the ghost-session shape deferral exists to
      // kill. pendingMeta is cleared only after the write succeeds; a failed
      // materialization keeps it pending so the retry re-seeds the file head
      // (a duplicate meta from a landed-but-errored write is tolerated by the
      // reducer: later metas override).
      const payload = this.pendingMeta
        ? serializeLine({ type: "session_meta", meta: this.pendingMeta }) + text
        : text;
      await this.handle.write(payload);
      this.pendingMeta = null;
    } catch (error) {
      // Drop the handle so subsequent appends try to reopen. Surface the
      // error to the chain so the .catch in append() logs it.
      try {
        await this.handle.close();
      } catch {
        // ignore
      }
      this.handle = null;
      throw error;
    }
  }
}

async function openAppend(filePath: string, logger: RolloutLogger): Promise<FileHandle> {
  try {
    return await open(filePath, "a");
  } catch (error) {
    logger("error", `open(${filePath}, "a") failed: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Read and replay a rollout JSONL into a SessionState.
 *
 * Returns `null` when the file is missing or empty. Per-line parse failures
 * are skipped — the rest of history is preserved — but they are not all the
 * same event: an unterminated final line is the expected artifact of a torn
 * write (crash / power loss mid-append) and only worth an info note, while a
 * malformed line in the MIDDLE of the file means real corruption and gets a
 * warn with line numbers so it can be investigated instead of silently
 * eroding history.
 */
export async function loadRolloutAsSession(
  filePath: string,
  opts: { logger?: RolloutLogger } = {},
): Promise<SessionState | null> {
  const logger = opts.logger ?? defaultLogger;
  const text = await readFile(filePath, "utf8").catch(() => null);
  if (text == null) return null;
  const items: RolloutItem[] = [];
  const rawLines = text.split("\n");
  // Index of the last non-empty line; if the file does not end with "\n",
  // a parse failure there is a torn final append, not corruption.
  let lastContentIndex = -1;
  for (let i = rawLines.length - 1; i >= 0; i -= 1) {
    if (rawLines[i]!.trim()) {
      lastContentIndex = i;
      break;
    }
  }
  const fileEndsWithNewline = text.endsWith("\n");
  const corruptLines: number[] = [];
  let tornTail = false;
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RolloutLine;
      const { ts: _ts, ...item } = parsed as RolloutLine & Record<string, unknown>;
      items.push(item as RolloutItem);
    } catch {
      if (i === lastContentIndex && !fileEndsWithNewline) tornTail = true;
      else corruptLines.push(i + 1);
    }
  }
  if (tornTail) logger("info", `${filePath}: dropped torn final line (interrupted write)`);
  if (corruptLines.length > 0) {
    logger("warn", `${filePath}: skipped ${corruptLines.length} corrupt mid-file line(s) at ${corruptLines.slice(0, 5).join(", ")}${corruptLines.length > 5 ? ", …" : ""}`);
  }
  if (items.length === 0) return null;
  return reduceRolloutItems(items);
}

/** Reduce a list of RolloutItems into a SessionState. The first session_meta
 * item seeds the header; subsequent items mutate. Multiple session_meta
 * lines are tolerated — later ones override (useful for snapshot rewrites). */
export function reduceRolloutItems(items: RolloutItem[]): SessionState | null {
  let session: SessionState | null = null;
  for (const item of items) {
    session = applyItem(session, item);
  }
  if (session) session.model = normalizeReducedModel(session.model);
  return session;
}

/** A Claude/Codex subscription model (subscriptionId set) has a canonical
 * endpoint — codex → chatgpt.com, anthropic-oauth → api.anthropic.com — and
 * no per-subscription baseUrl in the UI. A baseUrl on such a model is
 * therefore stale leakage from a previously-selected third-party entry (the
 * cold-start 404: a kimi→codex switch left kimi's baseUrl on the codex
 * config). Drop it at the reconstruction boundary so reloading a session that
 * baked the leak into a session_replace snapshot heals instead of routing to
 * the wrong host.
 *
 * EXCEPTION: the Kimi subscription ("kimi-oauth-*" ids) is the one kind whose
 * endpoint IS a baseUrl (api.kimi.com/coding, an Anthropic-compatible host) —
 * resolveSubscriptionModel pins it on every connect/update. Dropping it here
 * routed a replayed Kimi session to api.anthropic.com, which rejected the
 * Moonshot bearer token with a hard 401 on the first turn after a restart. */
function normalizeReducedModel(model: SessionState["model"]): SessionState["model"] {
  if (model.subscriptionId && !model.subscriptionId.startsWith("kimi-oauth-") && model.baseUrl !== undefined) {
    const { baseUrl: _drop, ...rest } = model;
    return rest;
  }
  return model;
}

function applyItem(prev: SessionState | null, item: RolloutItem): SessionState {
  if (item.type === "session_meta") {
    const meta = item.meta;
    const base: SessionState = prev ?? {
      id: meta.id,
      title: meta.title,
      agent: meta.agent,
      cwd: meta.cwd,
      permissionMode: meta.permissionMode,
      model: meta.model,
      outputStyle: meta.outputStyle,
      outputStyleCustom: meta.outputStyleCustom,
      messages: [],
      toolCalls: [],
      todos: [],
      pendingQuestions: [],
      skills: [],
      trace: [],
      createdAt: meta.createdAt,
      updatedAt: meta.createdAt,
    };
    return {
      ...base,
      id: meta.id,
      title: meta.title,
      agent: meta.agent,
      cwd: meta.cwd,
      permissionMode: meta.permissionMode,
      model: meta.model,
      outputStyle: meta.outputStyle,
      outputStyleCustom: meta.outputStyleCustom,
      createdAt: meta.createdAt,
    };
  }
  if (!prev) throw new Error(`rollout: ${item.type} before session_meta`);
  switch (item.type) {
    case "session_replace":
      return item.session;
    case "config": {
      const c = item.changes;
      return {
        ...prev,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.agent !== undefined ? { agent: c.agent } : {}),
        ...(c.permissionMode !== undefined ? { permissionMode: c.permissionMode } : {}),
        // Replace the model wholesale — do NOT shallow-merge over prev.model.
        // setModel (the sole recorder of a model change) always records a
        // COMPLETE ModelConfig: updateConfig sets every field, undefined where
        // absent, because switching to an entry with no baseUrl is meant to
        // CLEAR the prior baseUrl. A `{ ...prev.model, ...c.model }` merge leaks
        // transport fields across a provider switch — kimi (baseUrl
        // api.kimi.com) → codex kept kimi's baseUrl, so Codex's Responses
        // request hit the wrong host and 404'd on cold-start replay.
        ...(c.model !== undefined ? { model: c.model as SessionState["model"] } : {}),
        ...(c.outputStyle !== undefined ? { outputStyle: c.outputStyle } : {}),
        ...(c.outputStyleCustom !== undefined ? { outputStyleCustom: c.outputStyleCustom } : {}),
        ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
        ...(c.sessionModes ? { sessionModes: { ...(prev.sessionModes ?? {}), ...c.sessionModes } } : {}),
        updatedAt: nowIso(),
      };
    }
    case "message": {
      // Mirror the live engine's appendMessage double-push (engine.ts): once a
      // session has a compacted `modelMessages` view, every subsequent message
      // must land in BOTH arrays. Without this, replay freezes modelMessages at
      // the compaction boundary and the model loses every post-compaction turn
      // on reload (they survive only in the visible `messages` transcript).
      const next: SessionState = { ...prev, messages: [...prev.messages, item.message], updatedAt: nowIso() };
      if (prev.modelMessages) next.modelMessages = [...prev.modelMessages, item.message];
      return next;
    }
    case "tool_call":
      return { ...prev, toolCalls: [...prev.toolCalls, item.record], updatedAt: nowIso() };
    case "tool_update": {
      const next = prev.toolCalls.map((tc) => (tc.id === item.record.id ? mergeToolCall(tc, item.record) : tc));
      return { ...prev, toolCalls: next, updatedAt: nowIso() };
    }
    case "todos":
      return { ...prev, todos: item.todos, updatedAt: nowIso() };
    case "question":
      return {
        ...prev,
        pendingQuestions: [...prev.pendingQuestions, item.question],
        updatedAt: nowIso(),
      };
    case "question_update": {
      const next = prev.pendingQuestions.map((q) => (q.id === item.question.id ? { ...q, ...item.question } : q));
      return { ...prev, pendingQuestions: next, updatedAt: nowIso() };
    }
    case "provider_state":
      return { ...prev, providerState: item.state, updatedAt: nowIso() };
    case "provider_state_clear":
      return { ...prev, providerState: undefined, updatedAt: nowIso() };
    case "usage":
      return { ...prev, usage: item.usage, updatedAt: nowIso() };
    case "compacted":
      return {
        ...prev,
        compactBoundaries: [...(prev.compactBoundaries ?? []), item.boundary],
        updatedAt: nowIso(),
      };
    case "summary":
      return { ...prev, summary: item.summary, updatedAt: nowIso() };
    case "interrupted":
      return { ...prev, interrupted: true, updatedAt: item.at };
    case "plan":
      return { ...prev, plan: item.plan, updatedAt: nowIso() };
    case "skills":
      return { ...prev, skills: item.skills, updatedAt: nowIso() };
    case "trace":
      return { ...prev, trace: [...prev.trace, item.event], updatedAt: nowIso() };
    case "read_file": {
      const stamps = { ...(prev.readFileTimestamps ?? {}), [item.path]: item.mtimeMs };
      const recents = prev.recentFiles ?? [];
      const filtered = recents.filter((r) => r.path !== item.path);
      const next = [...filtered, { path: item.path, mtimeMs: item.mtimeMs, readAt: item.readAt }].slice(-200);
      return { ...prev, readFileTimestamps: stamps, recentFiles: next, updatedAt: nowIso() };
    }
    case "async_task": {
      const tasks = prev.asyncTasks ? [...prev.asyncTasks, item.task] : [item.task];
      return { ...prev, asyncTasks: tasks, updatedAt: nowIso() };
    }
    case "async_task_update": {
      const tasks = prev.asyncTasks ?? [];
      const next = tasks.map((task) => (task.id === item.task.id ? item.task : task));
      // If we never saw the original async_task event (e.g. a partial
      // rollout), still record the update — the reducer should converge to
      // the latest state we have evidence for.
      if (!tasks.some((task) => task.id === item.task.id)) next.push(item.task);
      return { ...prev, asyncTasks: next, updatedAt: nowIso() };
    }
    case "subtask": {
      const list = prev.subtasks ?? [];
      const without = list.filter((node) => node.id !== item.subtask.id);
      return { ...prev, subtasks: [...without, item.subtask], updatedAt: nowIso() };
    }
    case "subtask_update": {
      const list = prev.subtasks ?? [];
      const next = list.map((node) => (node.id === item.subtask.id ? item.subtask : node));
      if (!list.some((node) => node.id === item.subtask.id)) next.push(item.subtask);
      return { ...prev, subtasks: next, updatedAt: nowIso() };
    }
    case "phase":
      return { ...prev, phase: item.phase ?? undefined, updatedAt: nowIso() };
    case "goal_event":
      return {
        ...prev,
        goal: item.event.state,
        activeGoals: undefined,
        sessionModes: prev.sessionModes?.team ? { team: true } : undefined,
        updatedAt: item.event.at,
      };
    case "session_goal": {
      // Goals are uniquely identified by `id`. The reducer is upsert-by-id:
      // a later event for the same id (e.g. status `active` → `met`) wins.
      // A `removed` tombstone (user deleted the goal from the 目标 card)
      // drops the goal instead — replay must not resurrect it.
      const list = prev.activeGoals ?? [];
      const without = list.filter((g) => g.id !== item.goal.id);
      if (item.goal.removed) return { ...prev, activeGoals: without, updatedAt: nowIso() };
      return { ...prev, activeGoals: [...without, item.goal], updatedAt: nowIso() };
    }
    case "active_deferred_tools":
      return { ...prev, activeDeferredTools: [...item.names], updatedAt: nowIso() };
    case "mcp_servers_snapshot":
      // Idempotent: only the first event "wins" the snapshot for this session.
      // Re-emitting (e.g. legacy migration via decomposeSessionToItems) is a
      // no-op so we never accidentally drift the frozen prefix mid-replay.
      if (prev.mcpServerNamesSnapshot) return prev;
      return { ...prev, mcpServerNamesSnapshot: [...item.names], updatedAt: nowIso() };
    case "self_evolve":
      // Same cap as the engine-side push (most recent 50) so replay converges
      // to the identical log a live session holds.
      return {
        ...prev,
        selfEvolveLog: [...(prev.selfEvolveLog ?? []), item.entry].slice(-50),
        updatedAt: nowIso(),
      };
    default:
      // Unknown event type from a legacy rollout (e.g. deprecated "memory").
      // Ignore so old sessions still load.
      return prev;
  }
}

function mergeToolCall(prev: ToolCallRecord, next: ToolCallRecord): ToolCallRecord {
  // Sparse update: keep fields the new record left undefined, overwrite the
  // rest. Lets callers emit a `tool_update` with only the changed fields.
  const merged = { ...prev, ...next };
  // Except decision options: the engine clears allowedDecisions by assigning
  // undefined, which JSON.stringify drops from the tool_update line — the
  // sparse merge would then resurrect the original pending line's options on
  // every replay. Only a record still awaiting approval legitimately
  // carries them.
  if (merged.status !== "pending_approval") delete merged.allowedDecisions;
  return merged;
}

/**
 * One-shot migration: convert a legacy `<id>.json` whole-file snapshot into
 * a sequence of rollout items and append them to `<id>.jsonl`. Used the
 * first time we load an older session that pre-dates the event log.
 */
export async function migrateJsonSnapshotToJsonl(
  jsonPath: string,
  jsonlPath: string,
): Promise<boolean> {
  const text = await readFile(jsonPath, "utf8").catch(() => null);
  if (text == null) return false;
  let snap: SessionState;
  try {
    snap = JSON.parse(text) as SessionState;
  } catch {
    return false;
  }
  const items = decomposeSessionToItems(snap);
  // Write atomically: build full content, then rename into place. If the
  // process dies mid-migration we leave a `.migrating-<pid>` orphan but
  // never a half-written jsonl that the replayer would misinterpret.
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  const tmp = `${jsonlPath}.migrating-${process.pid}`;
  const content = items.map((item) => `${JSON.stringify({ ts: snap.updatedAt ?? nowIso(), ...item })}\n`).join("");
  await writeFile(tmp, content, "utf8");
  await rename(tmp, jsonlPath);
  return true;
}

/** Convert a SessionState snapshot into the equivalent event stream. Used by
 * the migration step. */
export function decomposeSessionToItems(s: SessionState): RolloutItem[] {
  const items: RolloutItem[] = [];
  items.push({
    type: "session_meta",
    meta: {
      id: s.id,
      title: s.title,
      agent: s.agent,
      cwd: s.cwd,
      permissionMode: s.permissionMode,
      model: s.model,
      outputStyle: s.outputStyle,
      outputStyleCustom: s.outputStyleCustom,
      createdAt: s.createdAt,
    },
  });
  for (const msg of s.messages) items.push({ type: "message", message: msg });
  for (const call of s.toolCalls) items.push({ type: "tool_call", record: call });
  if (s.todos.length > 0) items.push({ type: "todos", todos: s.todos });
  for (const q of s.pendingQuestions) items.push({ type: "question", question: q });
  if (s.providerState) items.push({ type: "provider_state", state: s.providerState });
  if (s.usage) items.push({ type: "usage", usage: s.usage });
  for (const b of s.compactBoundaries ?? []) items.push({ type: "compacted", boundary: b });
  if (s.summary) items.push({ type: "summary", summary: s.summary });
  if (s.plan) items.push({ type: "plan", plan: s.plan });
  if (s.activeDeferredTools && s.activeDeferredTools.length > 0) {
    items.push({ type: "active_deferred_tools", names: [...s.activeDeferredTools] });
  }
  if (s.mcpServerNamesSnapshot) {
    items.push({ type: "mcp_servers_snapshot", names: [...s.mcpServerNamesSnapshot] });
  }
  for (const subtask of s.subtasks ?? []) items.push({ type: "subtask", subtask });
  if (s.phase) items.push({ type: "phase", phase: s.phase });
  if (s.goal) {
    const at = nowIso();
    items.push({
      type: "goal_event",
      event: {
        id: `goal_event_${createId("ge").slice(-12)}`,
        kind: "migrated",
        actor: "system",
        at,
        state: s.goal,
      },
    });
  } else {
    for (const goal of s.activeGoals ?? []) items.push({ type: "session_goal", goal });
  }
  for (const entry of s.selfEvolveLog ?? []) items.push({ type: "self_evolve", entry });
  if (s.interrupted) items.push({ type: "interrupted", at: s.updatedAt });
  // Skills, memory, trace are recomputed at runtime (skills/memory from
  // disk; trace from in-memory events) — no need to persist them across
  // restarts.
  return items;
}

// =============================================================================
// Listing
// =============================================================================

const HEAD_RECORD_LIMIT = 32;

export interface SessionHead {
  filePath: string;
  sessionId: string;
  meta: SessionMeta | null;
  title: string | null;
  /** Latest config-derived metadata after replaying first `HEAD_RECORD_LIMIT`
   * lines plus all config events. Good enough for sidebar display without
   * reading the whole jsonl. */
  agent: string | null;
  modelDescriptor: string | null;
  modifiedMs: number;
  byteSize: number;
}

/**
 * Fast-listing for the sidebar — reads just enough of each `<cwd>/.reina/
 * sessions/*.jsonl` to extract the title and basic metadata, without
 * replaying the entire history. Inspired by codex's `read_head_for_summary`.
 *
 * Reads:
 *   1. The first line (must be session_meta)
 *   2. Up to HEAD_RECORD_LIMIT subsequent lines, but always picks up
 *      `config` events along the way so the latest title wins
 *   3. Falls back to scanning the WHOLE file only when the head didn't have
 *      a config title and the user renamed deep into the session.
 */
export async function listSessionHeads(
  cwd: string,
  opts: { logger?: RolloutLogger; archived?: boolean } = {},
): Promise<SessionHead[]> {
  const dir = path.join(cwd, ".reina", opts.archived ? "archived_sessions" : "sessions");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const jsonlEntries = entries.filter((entry) => entry.endsWith(".jsonl"));
  const heads = await Promise.all(
    jsonlEntries.map((name) => readSessionHead(path.join(dir, name), opts.logger)),
  );
  return heads.filter((head): head is SessionHead => head !== null);
}

async function readSessionHead(filePath: string, logger?: RolloutLogger): Promise<SessionHead | null> {
  const log = logger ?? defaultLogger;
  let stats: Awaited<ReturnType<typeof stat>> | null;
  try {
    stats = await stat(filePath);
  } catch {
    return null;
  }
  const text = await readFile(filePath, "utf8").catch(() => null);
  if (text == null) return null;

  let meta: SessionMeta | null = null;
  let latestTitle: string | null = null;
  let latestAgent: string | null = null;
  let modelDescriptor: string | null = null;
  let inspected = 0;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type === "session_meta") {
      meta ??= parsed.meta;
      latestTitle ??= parsed.meta.title;
      latestAgent ??= parsed.meta.agent;
      modelDescriptor ??= `${parsed.meta.model.provider}/${parsed.meta.model.model}`;
    } else if (parsed.type === "config") {
      if (parsed.changes.title !== undefined) latestTitle = parsed.changes.title;
      if (parsed.changes.agent !== undefined) latestAgent = parsed.changes.agent;
      if (parsed.changes.model !== undefined && meta) {
        const merged = { ...meta.model, ...parsed.changes.model };
        modelDescriptor = `${merged.provider}/${merged.model}`;
      }
    }
    inspected++;
    // Once we've passed the head limit AND have at least a meta, stop early.
    // We still scan ALL config events because the latest title can be deep
    // in the file (e.g. after a long session is renamed).
    if (inspected > HEAD_RECORD_LIMIT && meta && latestTitle && parsed.type !== "config") {
      // Continue scanning — we want the LAST config, not the first. The
      // overhead is acceptable: each line is parsed as JSON exactly once
      // and the file is typically <1MB.
    }
  }
  if (!meta) {
    log("warn", `session jsonl missing session_meta: ${filePath}`);
    return null;
  }
  return {
    filePath,
    sessionId: meta.id,
    meta,
    title: latestTitle,
    agent: latestAgent,
    modelDescriptor,
    modifiedMs: stats.mtimeMs,
    byteSize: stats.size,
  };
}

// =============================================================================
// Archive / delete
// =============================================================================

const ARCHIVED_DIR = "archived_sessions";
const SESSIONS_DIR = "sessions";

/** Move a session's `.jsonl` (and legacy `.json` if any) to the archive
 * subdir. Reversible — `unarchiveSession` flips it back. Returns true on
 * success, false if the source didn't exist. */
export async function archiveSession(cwd: string, sessionId: string): Promise<boolean> {
  return moveSessionFiles(cwd, sessionId, SESSIONS_DIR, ARCHIVED_DIR);
}

export async function unarchiveSession(cwd: string, sessionId: string): Promise<boolean> {
  return moveSessionFiles(cwd, sessionId, ARCHIVED_DIR, SESSIONS_DIR);
}

async function moveSessionFiles(
  cwd: string,
  sessionId: string,
  fromSubdir: string,
  toSubdir: string,
): Promise<boolean> {
  const fromDir = path.join(cwd, ".reina", fromSubdir);
  const toDir = path.join(cwd, ".reina", toSubdir);
  await mkdir(toDir, { recursive: true });
  let moved = false;
  for (const ext of [".jsonl", ".json"] as const) {
    const src = path.join(fromDir, `${sessionId}${ext}`);
    const dst = path.join(toDir, `${sessionId}${ext}`);
    try {
      await rename(src, dst);
      moved = true;
    } catch {
      // file didn't exist in this subdir / ext — skip silently
    }
  }
  return moved;
}

/** Hard delete — removes both the active and archived copies of a session.
 * Use sparingly; `archiveSession` is the safer default for user-initiated
 * "delete" actions because it preserves the event log under archived/. */
export async function destroySession(cwd: string, sessionId: string): Promise<void> {
  const files = [
    path.join(cwd, ".reina", SESSIONS_DIR, `${sessionId}.jsonl`),
    path.join(cwd, ".reina", SESSIONS_DIR, `${sessionId}.json`),
    path.join(cwd, ".reina", ARCHIVED_DIR, `${sessionId}.jsonl`),
    path.join(cwd, ".reina", ARCHIVED_DIR, `${sessionId}.json`),
  ];
  await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
}

// =============================================================================
// Paths
// =============================================================================

export function rolloutPathFor(cwd: string, sessionId: string): string {
  return path.join(cwd, ".reina", SESSIONS_DIR, `${sessionId}.jsonl`);
}

export function legacyJsonPathFor(cwd: string, sessionId: string): string {
  return path.join(cwd, ".reina", SESSIONS_DIR, `${sessionId}.json`);
}

export function archivedRolloutPathFor(cwd: string, sessionId: string): string {
  return path.join(cwd, ".reina", ARCHIVED_DIR, `${sessionId}.jsonl`);
}
