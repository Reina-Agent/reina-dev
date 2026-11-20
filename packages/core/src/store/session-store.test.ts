import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
// Runtime require (not a static import) so vitest's Vite resolver never sees
// the experimental `node:sqlite` URL — mirrors session-store.ts. Used only by
// the v5→v6 migration test, which needs a raw DB seeded to an older version.
import type * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = createRequire(process.execPath)("node:sqlite") as typeof NodeSqlite;
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, nowIso } from "@reina/protocol";
import type { AsyncTaskRecord, ChatMessage, MemoryChunk, SessionState, ToolCallRecord, TraceEvent } from "@reina/protocol";
import { resolveJournalMode, SessionStore } from "./session-store.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { getSchemaVersion, MIGRATIONS, migrate } from "./migrations.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = nowIso();
  return {
    id: overrides.id ?? createId("ses"),
    title: overrides.title ?? "Reina",
    agent: overrides.agent ?? "default",
    cwd: overrides.cwd ?? "/tmp/workspace",
    permissionMode: overrides.permissionMode ?? "default",
    model: overrides.model ?? { provider: "deterministic", model: "reina-deterministic" },
    messages: overrides.messages ?? [],
    toolCalls: overrides.toolCalls ?? [],
    todos: overrides.todos ?? [],
    pendingQuestions: overrides.pendingQuestions ?? [],
    skills: overrides.skills ?? [],
    trace: overrides.trace ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  } as SessionState;
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function makeToolCall(name: string, status: ToolCallRecord["status"] = "completed"): ToolCallRecord {
  return {
    id: createId("call"),
    name: name as ToolCallRecord["name"],
    input: { path: "README.md" },
    summary: `Run ${name}`,
    permission: "read",
    status,
    createdAt: nowIso(),
  };
}

function makeTrace(type: TraceEvent["type"]): TraceEvent {
  return { id: createId("evt"), type, createdAt: nowIso(), data: { foo: "bar" } };
}

// A memory chunk as produced by extractChunks (no `ordinal` — that's assigned
// by insertMemoryChunks at write time). `sessionId` here is a placeholder; the
// store keys the row by the `sessionId` argument, not this field.
function makeChunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: overrides.id ?? "c_001",
    sessionId: overrides.sessionId ?? "placeholder",
    createdAt: overrides.createdAt ?? nowIso(),
    topicLine: overrides.topicLine ?? "Fix the build",
    toolNames: overrides.toolNames ?? ["read_file"],
    tokenCount: overrides.tokenCount ?? 42,
    messageIds: overrides.messageIds ?? ["m1", "m2"],
    content: overrides.content ?? "[t] user: hi\n\n[t] assistant: hello",
    ...overrides,
  };
}

describe("SessionStore", () => {
  let cwd: string;
  let store: SessionStore;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "reina-store-"));
    store = SessionStore.open(cwd);
  });

  afterEach(async () => {
    store?.close();
    await rm(cwd, { recursive: true, force: true });
  });

  describe("schema + migrations", () => {
    it("applies the latest schema version on a fresh DB", () => {
      const v = getSchemaVersion(
        (store as unknown as { db: { prepare: (sql: string) => { get: () => unknown } } }).db as unknown as Parameters<typeof getSchemaVersion>[0],
      );
      expect(v).toBe(CURRENT_SCHEMA_VERSION);
    });

    it("is idempotent: opening the same DB twice is a no-op the second time", () => {
      store.close();
      const reopened = SessionStore.open(cwd);
      const v = getSchemaVersion(
        (reopened as unknown as { db: Parameters<typeof getSchemaVersion>[0] }).db,
      );
      expect(v).toBe(CURRENT_SCHEMA_VERSION);
      reopened.close();
    });

    it("migrates a v5 DB to v6 by adding messages.reasoning_trace", () => {
      // Seed a raw DB to exactly v5 (run migrations 1..5, no reasoning_trace col).
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA foreign_keys = OFF"); // raw DB: insert a message without a parent session row
      for (const m of MIGRATIONS.filter((x) => x.version <= 5).sort((a, b) => a.version - b.version)) {
        m.up(db);
      }
      db.prepare(`INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', ?)`).run(5);
      const colsBefore = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>;
      expect(colsBefore.some((c) => c.name === "reasoning_trace")).toBe(false);

      expect(migrate(db)).toBe(CURRENT_SCHEMA_VERSION);

      const colsAfter = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>;
      expect(colsAfter.some((c) => c.name === "reasoning_trace")).toBe(true);
      // The new column is usable: store + read back a JSON trace.
      const trace = { provider: "anthropic-messages", model: "claude-x", blocks: [{ type: "thinking" }] };
      db.prepare(
        `INSERT INTO messages (id, session_id, ordinal, role, content, reasoning, reasoning_trace, attachments, in_model_view, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("m1", "s1", 0, "assistant", "hi", null, JSON.stringify(trace), null, 1, nowIso());
      const row = db.prepare(`SELECT reasoning_trace FROM messages WHERE id = 'm1'`).get() as {
        reasoning_trace: string;
      };
      expect(JSON.parse(row.reasoning_trace).model).toBe("claude-x");
      db.close();
    });

    it("migrates a v7 DB to v8 by adding messages.metadata_json", () => {
      const db = new DatabaseSync(":memory:");
      for (const migration of MIGRATIONS.filter((item) => item.version <= 7).sort((a, b) => a.version - b.version)) {
        migration.up(db);
      }
      db.prepare(`INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', ?)`).run(7);
      expect((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>).some((col) => col.name === "metadata_json")).toBe(false);

      expect(migrate(db)).toBe(CURRENT_SCHEMA_VERSION);

      expect((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>).some((col) => col.name === "metadata_json")).toBe(true);
      db.close();
    });

    it("backfills legacy tool-result and reminder metadata without touching ordinary user messages", () => {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA foreign_keys = OFF");
      for (const migration of MIGRATIONS.filter((item) => item.version <= 8).sort((a, b) => a.version - b.version)) {
        migration.up(db);
      }
      db.prepare(`INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', ?)`).run(8);
      const insertMessage = db.prepare(
        `INSERT INTO messages (id, session_id, ordinal, role, content, reasoning, reasoning_trace, attachments, metadata_json, in_model_view, created_at)
         VALUES (?, 's1', ?, 'user', ?, NULL, NULL, NULL, NULL, 1, ?)`,
      );
      insertMessage.run("tool-msg", 0, "Tool read_file (call-old) result:\ncanonical output", nowIso());
      insertMessage.run("reminder-msg", 1, "<system-reminder>\ncache state\n</system-reminder>", nowIso());
      insertMessage.run("ordinary-msg", 2, "ordinary user text", nowIso());
      db.prepare(
        `INSERT INTO tool_calls (id, session_id, ordinal, name, status, permission, summary, input, preview, output, error, created_at, completed_at)
         VALUES ('call-old', 's1', 0, 'read_file', 'completed', 'read', '', ?, NULL, 'raw output', NULL, ?, ?)`,
      ).run(JSON.stringify({ path: "README.md" }), nowIso(), nowIso());

      expect(migrate(db)).toBe(CURRENT_SCHEMA_VERSION);

      const metadata = Object.fromEntries(
        (db.prepare(`SELECT id, metadata_json FROM messages ORDER BY ordinal`).all() as Array<{ id: string; metadata_json: string | null }>).map(
          (row) => [row.id, row.metadata_json ? JSON.parse(row.metadata_json) : null],
        ),
      );
      expect(metadata["tool-msg"]).toEqual({
        ephemeral: true,
        toolResult: {
          callId: "call-old",
          name: "read_file",
          input: { path: "README.md" },
          output: "canonical output",
        },
      });
      expect(metadata["reminder-msg"]).toEqual({ ephemeral: true });
      expect(metadata["ordinary-msg"]).toBeNull();
      db.close();
    });

    it("creates the .reina directory if missing", async () => {
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(path.join(cwd, ".reina"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("works with :memory: for tests without touching disk", () => {
      const mem = SessionStore.open("/this-path-is-ignored", { inMemory: true });
      expect(mem.dbPath).toBe(":memory:");
      mem.close();
    });
  });

  describe("session CRUD", () => {
    it("upsert + getSessionSummary round-trips the index fields", () => {
      const session = makeSession({ title: "Hello world", agent: "plan" });
      store.upsertSession(session);

      const summary = store.getSessionSummary(session.id);
      expect(summary?.id).toBe(session.id);
      expect(summary?.title).toBe("Hello world");
      expect(summary?.agent).toBe("plan");
      expect(summary?.messageCount).toBe(0);
      expect(summary?.toolCount).toBe(0);
    });

    it("upsert updates an existing row in place (no duplicate)", () => {
      const session = makeSession({ title: "v1" });
      store.upsertSession(session);
      store.upsertSession({ ...session, title: "v2", updatedAt: nowIso() });

      const list = store.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("v2");
    });

    it("listSessions orders by updated_at DESC", async () => {
      const a = makeSession({ title: "a", updatedAt: "2026-05-14T10:00:00.000Z" });
      const b = makeSession({ title: "b", updatedAt: "2026-05-14T11:00:00.000Z" });
      const c = makeSession({ title: "c", updatedAt: "2026-05-14T09:00:00.000Z" });
      store.upsertSession(a);
      store.upsertSession(b);
      store.upsertSession(c);

      const list = store.listSessions();
      expect(list.map((s) => s.title)).toEqual(["b", "a", "c"]);
    });

    it("listSessions excludes archived sessions by default", () => {
      const a = makeSession({ title: "live" });
      const b = makeSession({ title: "archived" });
      store.upsertSession(a);
      store.upsertSession(b);
      store.archiveSession(b.id, nowIso());

      expect(store.listSessions().map((s) => s.title)).toEqual(["live"]);
      expect(
        store.listSessions({ includeArchived: true }).map((s) => s.title).sort(),
      ).toEqual(["archived", "live"]);
    });

    it("listSessions excludes subagents by default", () => {
      const parent = makeSession({ title: "parent", isSubagent: false });
      const child = makeSession({ title: "child", isSubagent: true, subagentDepth: 1 });
      store.upsertSession(parent);
      store.upsertSession(child);

      expect(store.listSessions().map((s) => s.title)).toEqual(["parent"]);
      expect(
        store.listSessions({ includeSubagents: true }).map((s) => s.title).sort(),
      ).toEqual(["child", "parent"]);
    });

    it("renameSession changes title and bumps updated_at", () => {
      const session = makeSession({ title: "old" });
      store.upsertSession(session);
      const later = nowIso();
      store.renameSession(session.id, "new", later);

      const summary = store.getSessionSummary(session.id);
      expect(summary?.title).toBe("new");
      expect(summary?.updatedAt).toBe(later);
    });

    it("deleteSession removes the row + cascades to child tables", () => {
      const session = makeSession({
        title: "doomed",
        messages: [makeMessage("user", "hello")],
      });
      store.persistSession(session);
      expect(store.listSessions()).toHaveLength(1);

      store.deleteSession(session.id);
      expect(store.listSessions()).toHaveLength(0);
      const orphanMessages = store.rawAll(
        `SELECT * FROM messages WHERE session_id = ?`,
        session.id,
      );
      expect(orphanMessages).toEqual([]);
    });

    it("upsert preserves model fields including baseUrl + reasoning effort", () => {
      const session = makeSession({
        model: {
          provider: "anthropic-messages",
          model: "claude-opus-4-7",
          baseUrl: "https://example.com/v1",
          reasoningEffort: "high",
          contextWindowTokens: 200_000,
        },
      });
      store.upsertSession(session);
      const loaded = store.loadSession(session.id);
      expect(loaded?.model.provider).toBe("anthropic-messages");
      expect(loaded?.model.model).toBe("claude-opus-4-7");
      expect(loaded?.model.baseUrl).toBe("https://example.com/v1");
      expect(loaded?.model.reasoningEffort).toBe("high");
      expect(loaded?.model.contextWindowTokens).toBe(200_000);
    });
  });

  describe("persistSession + loadSession", () => {
    it("preserves context-state metadata on incremental message appends", () => {
      const session = makeSession();
      store.upsertSession(session);
      const contextMessage: ChatMessage = {
        id: createId("msg"),
        role: "user",
        content: "<system-reminder>plan changed</system-reminder>",
        ephemeral: true,
        contextState: {
          version: 1,
          sections: { plan: "hash-plan-v1" },
        },
        createdAt: nowIso(),
      };

      store.appendMessage(session.id, contextMessage, 0);

      expect(store.loadSession(session.id)?.messages[0]).toMatchObject({
        ephemeral: true,
        contextState: {
          version: 1,
          sections: { plan: "hash-plan-v1" },
        },
      });
    });

    it("round-trips a full session including messages, tools, and trace", () => {
      const session = makeSession({
        title: "with content",
        messages: [
          makeMessage("user", "hi"),
          makeMessage("assistant", "hello back"),
        ],
        toolCalls: [makeToolCall("read_file")],
        trace: [makeTrace("turn.completed")],
        todos: [{ id: "t1", content: "Do thing", activeForm: "Doing thing", status: "pending" }],
      });
      store.persistSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded?.title).toBe("with content");
      expect(loaded?.messages.map((m) => m.content)).toEqual(["hi", "hello back"]);
      expect(loaded?.toolCalls).toHaveLength(1);
      expect(loaded?.toolCalls[0]?.name).toBe("read_file");
      expect(loaded?.trace.map((t) => t.type)).toEqual(["turn.completed"]);
      expect(loaded?.todos).toEqual([{ id: "t1", content: "Do thing", activeForm: "Doing thing", status: "pending" }]);
    });

    it("round-trips full token usage needed for exact context-window display", () => {
      const session = makeSession({
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 7,
          cacheCreationInputTokens: 5,
          reasoningTokens: 3,
          turns: 4,
          childInputTokens: 11,
          childOutputTokens: 2,
          contextTokens: 123,
          contextTokensSource: "provider",
          lastTurn: {
            createdAt: "2026-05-19T01:02:03.000Z",
            inputTokens: 101,
            outputTokens: 22,
            cachedInputTokens: 7,
            cacheCreationInputTokens: 5,
            reasoningTokens: 3,
            totalTokens: 123,
          },
          lastRequest: {
            createdAt: "2026-05-19T01:02:02.000Z",
            provider: "openai-chat",
            model: "glm-5.1",
            messagesCount: 2,
            observationsCount: 1,
            toolsCount: 1,
            systemPromptChars: 40,
            systemPromptTokens: 10,
            messagesChars: 80,
            messagesTokens: 20,
            observationsChars: 16,
            observationsTokens: 4,
            toolsDescriptionChars: 30,
            toolsSchemaChars: 60,
            toolsTokens: 15,
            totalChars: 226,
            estimatedInputTokens: 49,
            toolNames: ["read_file"],
            categories: {
              systemPromptBase: 6,
              systemPromptSkills: 2,
              systemPromptUserRules: 2,
              messages: 20,
              observations: 4,
              reminders: 0,
              toolsCore: 15,
              toolsMcp: 0,
              toolsCoreDeferred: 3,
              toolsMcpDeferred: 0,
              autocompactBuffer: 10,
              freeSpace: 199_938,
              contextWindow: 200_000,
            },
            toolDetails: [{ name: "read_file", tokens: 15, deferred: false, mcp: false }],
          },
          requestTotals: {
            estimatedInputTokens: 49,
            systemPromptTokens: 10,
            messagesTokens: 20,
            observationsTokens: 4,
            toolsTokens: 15,
          },
        },
      });
      store.persistSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded?.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 7,
        cacheCreationInputTokens: 5,
        reasoningTokens: 3,
        turns: 4,
        childInputTokens: 11,
        childOutputTokens: 2,
        contextTokens: 123,
        contextTokensSource: "provider",
        lastTurn: { inputTokens: 101, outputTokens: 22, totalTokens: 123 },
        requestTotals: { estimatedInputTokens: 49 },
      });
      expect(loaded?.usage?.lastRequest?.categories?.freeSpace).toBe(199_938);
      expect(loaded?.usage?.lastRequest?.toolDetails?.[0]?.name).toBe("read_file");
    });

    it("round-trips subagent recovery cold state and active task projection", () => {
      const session = makeSession({
        asyncTasks: [
          {
            id: "task_live",
            agent: "default",
            description: "live task",
            status: "recoverable",
            isolation: "none",
            startedAt: "2026-05-14T11:00:00.000Z",
            recovery: {
              status: "recoverable",
              reason: "restart",
              checkedAt: "2026-05-14T11:01:00.000Z",
              worktreeStatus: "none",
            },
          },
        ],
        asyncTasksArchived: [
          {
            id: "task_archived",
            agent: "default",
            description: "archived task",
            status: "completed",
            isolation: "none",
            startedAt: "2026-05-14T10:00:00.000Z",
            completedAt: "2026-05-14T10:05:00.000Z",
            result: "done",
            archived: true,
          },
        ],
        failedBriefs: [{ agent: "default", briefKey: "broken brief", count: 3, lastFailedAt: "2026-05-14T10:00:00.000Z" }],
        lastTurnTaskStatuses: { task_live: "running" },
      });

      store.persistSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded?.asyncTasks?.map((task) => task.id)).toEqual(["task_live"]);
      expect(loaded?.asyncTasks?.[0]?.recovery?.reason).toBe("restart");
      expect(loaded?.asyncTasksArchived?.map((task) => task.id)).toEqual(["task_archived"]);
      expect(loaded?.failedBriefs).toEqual([{ agent: "default", briefKey: "broken brief", count: 3, lastFailedAt: "2026-05-14T10:00:00.000Z" }]);
      expect(loaded?.lastTurnTaskStatuses).toEqual({ task_live: "running" });
    });

    it("round-trips the self-evolve log (persistent transcript notices)", () => {
      const session = makeSession({
        selfEvolveLog: [
          { summary: "记忆 +2（用户偏好中文回复、喜欢直接结论）", at: "2026-05-14T10:00:00.000Z" },
          { summary: "技能 1（debug-electron）", at: "2026-05-14T10:05:00.000Z" },
        ],
      });

      store.persistSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded?.selfEvolveLog).toEqual([
        { summary: "记忆 +2（用户偏好中文回复、喜欢直接结论）", at: "2026-05-14T10:00:00.000Z" },
        { summary: "技能 1（debug-electron）", at: "2026-05-14T10:05:00.000Z" },
      ]);
    });

    it("persistSession is atomic: a failed sub-insert rolls back the row count", () => {
      const session = makeSession({
        messages: [makeMessage("user", "first")],
      });
      store.persistSession(session);
      expect(store.getSessionSummary(session.id)?.messageCount).toBe(1);

      // Force a unique-constraint violation: two new messages share the
      // SAME id, so the second INSERT in the txn hits the PK conflict.
      // The transaction must roll back, leaving the session intact with
      // its original message and content.
      const sharedId = createId("msg");
      const bad: SessionState = {
        ...session,
        messages: [
          { id: sharedId, role: "user", content: "new-a", createdAt: nowIso() },
          { id: sharedId, role: "assistant", content: "new-b", createdAt: nowIso() },
        ],
      };
      expect(() => store.persistSession(bad)).toThrow();
      const reloaded = store.loadSession(session.id);
      expect(reloaded?.messages).toHaveLength(1);
      expect(reloaded?.messages[0]?.content).toBe("first");
    });

    it("replaces messages/tools/trace on persist (not append)", () => {
      const session = makeSession({
        messages: [makeMessage("user", "v1-only")],
      });
      store.persistSession(session);
      const next = { ...session, messages: [makeMessage("user", "v2-only")] };
      store.persistSession(next);

      const loaded = store.loadSession(session.id);
      expect(loaded?.messages.map((m) => m.content)).toEqual(["v2-only"]);
    });

    it("preserves attachments, reasoning, and provider-facing metadata on messages", () => {
      const userMsg: ChatMessage = {
        id: createId("msg"),
        role: "user",
        content: "look at this",
        attachments: [{ kind: "image", mime: "image/png", dataBase64: "AAA=" }],
        createdAt: nowIso(),
      };
      const assistantMsg: ChatMessage = {
        id: createId("msg"),
        role: "assistant",
        content: "I see a logo",
        reasoning: "Recognised by shape",
        reasoningTrace: {
          provider: "anthropic-messages",
          model: "claude-test",
          blocks: [{ type: "thinking", thinking: "shape analysis", signature: "sig-abc" }],
        },
        stopReason: "tool_calls",
        tokenUsage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 900, totalTokens: 1280 },
        createdAt: nowIso(),
      };
      const toolResultMsg: ChatMessage = {
        id: createId("msg"),
        role: "user",
        content: "[tool result] read_file",
        ephemeral: true,
        contextState: {
          version: 1,
          sections: { plan: "abc123" },
        },
        toolResult: {
          callId: "call_reload",
          name: "read_file",
          input: { path: "README.md" },
          output: "canonical output",
        },
        createdAt: nowIso(),
      };
      const session = makeSession({ messages: [userMsg, assistantMsg, toolResultMsg] });
      store.persistSession(session);

      const loaded = store.loadSession(session.id);
      expect(loaded?.messages[0]?.attachments).toEqual([
        { kind: "image", mime: "image/png", dataBase64: "AAA=" },
      ]);
      expect(loaded?.messages[1]?.reasoning).toBe("Recognised by shape");
      expect(loaded?.messages[1]?.reasoningTrace).toEqual({
        provider: "anthropic-messages",
        model: "claude-test",
        blocks: [{ type: "thinking", thinking: "shape analysis", signature: "sig-abc" }],
      });
      expect(loaded?.messages[1]?.stopReason).toBe("tool_calls");
      expect(loaded?.messages[1]?.tokenUsage).toEqual({
        inputTokens: 1200,
        outputTokens: 80,
        cachedInputTokens: 900,
        totalTokens: 1280,
      });
      expect(loaded?.messages[2]).toMatchObject({
        ephemeral: true,
        contextState: {
          version: 1,
          sections: { plan: "abc123" },
        },
        toolResult: {
          callId: "call_reload",
          name: "read_file",
          input: { path: "README.md" },
          output: "canonical output",
        },
      });
      // A message with no trace loads with reasoningTrace undefined (old rows).
      expect(loaded?.messages[0]?.reasoningTrace).toBeUndefined();
    });
  });

  describe("FTS5 search", () => {
    it("matches a single keyword", () => {
      const a = makeSession({
        messages: [makeMessage("user", "How do I configure webpack for module federation?")],
      });
      const b = makeSession({
        messages: [makeMessage("user", "Help me write a SQL query for monthly aggregates")],
      });
      store.persistSession(a);
      store.persistSession(b);

      const hits = store.searchMessages("webpack");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.sessionId).toBe(a.id);
      expect(hits[0]?.snippet).toContain("<mark>webpack</mark>");
    });

    it("routes CJK queries to the LIKE scan (unicode61 can't segment them)", () => {
      // 新闻 buried in a longer Han run — invisible to FTS's unicode61
      // tokenizer (the whole run is one token)…
      const inline = makeSession({
        messages: [makeMessage("user", "帮我看看今天的新闻热点有哪些")],
      });
      // …and 新闻 standing alone, which FTS *can* match. A CJK query must
      // return BOTH — a partial FTS result set must not mask the rest.
      const standalone = makeSession({
        messages: [makeMessage("user", "搜索 新闻 关键词")],
      });
      store.persistSession(inline);
      store.persistSession(standalone);
      const hits = store.searchMessages("新闻");
      expect(hits.map((h) => h.sessionId).sort()).toEqual([inline.id, standalone.id].sort());
      for (const hit of hits) expect(hit.snippet).toContain("<mark>新闻</mark>");
    });

    it("supports phrase + boolean queries", () => {
      const s1 = makeSession({
        messages: [makeMessage("user", "I tried module federation but it errored")],
      });
      const s2 = makeSession({
        messages: [makeMessage("user", "Use a federation plugin for the build")],
      });
      const s3 = makeSession({
        messages: [makeMessage("user", "monthly federation summary")],
      });
      store.persistSession(s1);
      store.persistSession(s2);
      store.persistSession(s3);

      // Phrase: only consecutive occurrence in s1 should match.
      const phraseHits = store.searchMessages(`"module federation"`);
      expect(phraseHits.map((h) => h.sessionId)).toEqual([s1.id]);

      // Boolean: federation but not monthly.
      const boolHits = store.searchMessages(`federation NOT monthly`);
      const ids = boolHits.map((h) => h.sessionId).sort();
      expect(ids).toEqual([s1.id, s2.id].sort());
    });

    it("returns empty for empty query", () => {
      const s = makeSession({ messages: [makeMessage("user", "anything")] });
      store.persistSession(s);
      expect(store.searchMessages("")).toEqual([]);
      expect(store.searchMessages("   ")).toEqual([]);
    });

    it("FTS index stays in sync after message replace via persistSession", () => {
      const session = makeSession({
        messages: [makeMessage("user", "first webpack")],
      });
      store.persistSession(session);
      expect(store.searchMessages("webpack")).toHaveLength(1);

      // Replace with a message that doesn't contain "webpack".
      const updated = { ...session, messages: [makeMessage("user", "different topic")] };
      store.persistSession(updated);
      expect(store.searchMessages("webpack")).toEqual([]);
      expect(store.searchMessages("different")).toHaveLength(1);
    });

    it("FTS index drops rows when session is deleted", () => {
      const session = makeSession({
        messages: [makeMessage("user", "rare keyword: hyperbolic")],
      });
      store.persistSession(session);
      expect(store.searchMessages("hyperbolic")).toHaveLength(1);

      store.deleteSession(session.id);
      expect(store.searchMessages("hyperbolic")).toEqual([]);
    });
  });

  describe("async tasks", () => {
    it("upsert + fetch round-trip + sort by started_at ASC", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      const earlier: import("@reina/protocol").AsyncTaskRecord = {
        id: "task_a",
        agent: "plan",
        description: "earlier",
        status: "completed",
        isolation: "none",
        startedAt: "2026-05-14T10:00:00.000Z",
      };
      const later: import("@reina/protocol").AsyncTaskRecord = {
        id: "task_b",
        agent: "plan",
        description: "later",
        status: "recoverable",
        isolation: "none",
        startedAt: "2026-05-14T11:00:00.000Z",
        attemptCount: 1,
        resumeCount: 0,
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-05-14T11:05:00.000Z",
        recovery: {
          status: "recoverable",
          reason: "restart",
          checkedAt: "2026-05-14T11:01:00.000Z",
          worktreeStatus: "none",
        },
      };
      store.upsertAsyncTask(parent.id, earlier);
      store.upsertAsyncTask(parent.id, later);

      const all = store.fetchAsyncTasks(parent.id);
      expect(all.map((t) => t.id)).toEqual(["task_a", "task_b"]);
      expect(all[1]?.status).toBe("recoverable");
      expect(all[1]?.recovery?.reason).toBe("restart");
      expect(all[1]?.leaseOwner).toBe("worker-a");
    });

    it("acquires a recovery lease only once", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      store.upsertAsyncTask(parent.id, {
        id: "task_lease",
        agent: "plan",
        description: "lease",
        status: "recoverable",
        isolation: "none",
        startedAt: "2026-05-14T11:00:00.000Z",
      });

      expect(store.tryAcquireAsyncTaskLease(parent.id, "task_lease", "worker-a", "2026-05-14T11:05:00.000Z", "2026-05-14T11:01:00.000Z")).toBe(true);
      expect(store.tryAcquireAsyncTaskLease(parent.id, "task_lease", "worker-b", "2026-05-14T11:06:00.000Z", "2026-05-14T11:02:00.000Z")).toBe(false);
    });

    it("projects child attempts and subagent edges from async task upserts", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      const task: AsyncTaskRecord = {
        id: "task_projection",
        agent: "plan",
        description: "projection",
        status: "running",
        isolation: "none",
        startedAt: "2026-05-14T11:00:00.000Z",
        childSessionId: "child_a",
        attemptCount: 1,
        lastHeartbeatAt: "2026-05-14T11:01:00.000Z",
      };

      store.upsertAsyncTask(parent.id, task);

      const attempts = store.rawAll(
        `SELECT task_id, child_session_id, status, heartbeat_at, completed_at
         FROM async_task_attempts
         WHERE task_id = ?`,
        task.id,
      ) as Array<{ task_id: string; child_session_id: string; status: string; heartbeat_at: string; completed_at: string | null }>;
      expect(attempts).toEqual([
        {
          task_id: "task_projection",
          child_session_id: "child_a",
          status: "running",
          heartbeat_at: "2026-05-14T11:01:00.000Z",
          completed_at: null,
        },
      ]);
      expect(
        store.rawAll(
          `SELECT child_session_id, status, attempt_count, closed_at
           FROM subagent_edges
           WHERE task_id = ?`,
          task.id,
        ),
      ).toEqual([
        {
          child_session_id: "child_a",
          status: "open",
          attempt_count: 1,
          closed_at: null,
        },
      ]);

      store.upsertAsyncTask(parent.id, {
        ...task,
        status: "completed",
        completedAt: "2026-05-14T11:05:00.000Z",
        result: "done",
      });

      expect(
        store.rawAll(
          `SELECT child_session_id, status, completed_at
           FROM async_task_attempts
           WHERE task_id = ?`,
          task.id,
        ),
      ).toEqual([
        {
          child_session_id: "child_a",
          status: "completed",
          completed_at: "2026-05-14T11:05:00.000Z",
        },
      ]);
      expect(
        store.rawAll(
          `SELECT child_session_id, status, closed_at, close_reason
           FROM subagent_edges
           WHERE task_id = ?`,
          task.id,
        ),
      ).toEqual([
        {
          child_session_id: "child_a",
          status: "closed",
          closed_at: "2026-05-14T11:05:00.000Z",
          close_reason: "completed",
        },
      ]);
    });

    it("closes superseded subagent edges when a fresh child attempt starts", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      const task: AsyncTaskRecord = {
        id: "task_resume_edge",
        agent: "plan",
        description: "resume",
        status: "running",
        isolation: "none",
        startedAt: "2026-05-14T11:00:00.000Z",
        childSessionId: "child_old",
        attemptCount: 1,
      };
      store.upsertAsyncTask(parent.id, task);
      store.upsertAsyncTask(parent.id, {
        ...task,
        status: "resuming",
        childSessionId: "child_new",
        attemptCount: 2,
        lastHeartbeatAt: "2026-05-14T11:03:00.000Z",
      });

      expect(
        store.rawAll(
          `SELECT child_session_id, status, close_reason
           FROM subagent_edges
           WHERE task_id = ?
           ORDER BY child_session_id ASC`,
          task.id,
        ),
      ).toEqual([
        { child_session_id: "child_new", status: "open", close_reason: null },
        { child_session_id: "child_old", status: "closed", close_reason: "superseded_by_attempt" },
      ]);
    });

    it("claims async task updates FIFO with leases and terminal drop", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      const firstId = store.enqueueAsyncTaskUpdate(parent.id, "task_updates", "first", "2026-05-14T11:00:00.000Z");
      const secondId = store.enqueueAsyncTaskUpdate(parent.id, "task_updates", "second", "2026-05-14T11:01:00.000Z");

      const claimed = store.claimPendingAsyncTaskUpdates(
        parent.id,
        "task_updates",
        "worker-a",
        "2026-05-14T11:05:00.000Z",
        2,
        "2026-05-14T11:02:00.000Z",
      );
      expect(claimed.map((update) => update.id)).toEqual([firstId, secondId]);
      expect(claimed.map((update) => update.message)).toEqual(["first", "second"]);
      expect(
        store.claimPendingAsyncTaskUpdates(
          parent.id,
          "task_updates",
          "worker-b",
          "2026-05-14T11:06:00.000Z",
          2,
          "2026-05-14T11:03:00.000Z",
        ),
      ).toEqual([]);

      store.markAsyncTaskUpdatesApplied(parent.id, [firstId, secondId], "2026-05-14T11:03:00.000Z");
      expect(
        store.rawAll(
          `SELECT id, status, applied_at
           FROM async_task_updates
           WHERE id IN (?, ?)
           ORDER BY created_at ASC`,
          firstId,
          secondId,
        ),
      ).toEqual([
        { id: firstId, status: "applied", applied_at: "2026-05-14T11:03:00.000Z" },
        { id: secondId, status: "applied", applied_at: "2026-05-14T11:03:00.000Z" },
      ]);

      const leasedId = store.enqueueAsyncTaskUpdate(parent.id, "task_updates", "leased", "2026-05-14T11:04:00.000Z");
      expect(
        store.claimPendingAsyncTaskUpdates(
          parent.id,
          "task_updates",
          "worker-a",
          "2026-05-14T11:05:00.000Z",
          1,
          "2026-05-14T11:04:30.000Z",
        ).map((update) => update.id),
      ).toEqual([leasedId]);
      expect(
        store.claimPendingAsyncTaskUpdates(
          parent.id,
          "task_updates",
          "worker-b",
          "2026-05-14T11:06:00.000Z",
          1,
          "2026-05-14T11:04:45.000Z",
        ),
      ).toEqual([]);
      expect(
        store.claimPendingAsyncTaskUpdates(
          parent.id,
          "task_updates",
          "worker-b",
          "2026-05-14T11:10:00.000Z",
          1,
          "2026-05-14T11:06:00.000Z",
        ).map((update) => update.id),
      ).toEqual([leasedId]);

      const droppedId = store.enqueueAsyncTaskUpdate(parent.id, "task_updates", "drop me", "2026-05-14T11:07:00.000Z");
      store.dropPendingAsyncTaskUpdates(parent.id, "task_updates", "task_settled", "2026-05-14T11:08:00.000Z");
      expect(
        store.rawAll(
          `SELECT id, status, error, dropped_at
           FROM async_task_updates
           WHERE id = ?`,
          droppedId,
        ),
      ).toEqual([
        {
          id: droppedId,
          status: "dropped",
          error: "task_settled",
          dropped_at: "2026-05-14T11:08:00.000Z",
        },
      ]);
    });

    it("rebuilds async task projection from event snapshots", () => {
      const parent = makeSession({ title: "parent" });
      store.upsertSession(parent);
      const task: AsyncTaskRecord = {
        id: "task_from_event",
        name: "event-worker",
        agent: "default",
        description: "event sourced task",
        status: "completed",
        isolation: "none",
        startedAt: "2026-05-14T11:00:00.000Z",
        completedAt: "2026-05-14T11:02:00.000Z",
        result: "done",
        background: true,
      };
      store.appendAsyncTaskEvent(
        parent.id,
        task.id,
        "task.status.completed",
        { status: task.status, taskSnapshot: task },
        "2026-05-14T11:02:00.000Z",
      );

      expect(store.fetchAsyncTasks(parent.id)).toEqual([]);
      expect(store.rebuildAsyncTaskProjectionFromEvents(parent.id)).toBe(1);
      expect(store.fetchAsyncTasks(parent.id).map((entry) => entry.id)).toEqual(["task_from_event"]);
      expect(store.fetchAsyncTasks(parent.id)[0]?.result).toBe("done");
      expect(store.fetchAsyncTasks(parent.id)[0]?.name).toBe("event-worker");
      expect(store.fetchAsyncTasks(parent.id)[0]?.background).toBe(true);
    });

    it("cascades on parent session deletion", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.upsertAsyncTask(parent.id, {
        id: "task_x",
        agent: "plan",
        description: "orphan-me",
        status: "running",
        isolation: "none",
        startedAt: nowIso(),
      });
      store.deleteSession(parent.id);
      expect(store.fetchAsyncTasks(parent.id)).toEqual([]);
    });
  });

  describe("memory chunks (compaction offload)", () => {
    it("insert + list round-trips metadata without the content body", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.insertMemoryChunks(parent.id, [
        makeChunk({ id: "c_001", topicLine: "first arc", tokenCount: 10 }),
        makeChunk({ id: "c_002", topicLine: "second arc", tokenCount: 20, toolNames: ["run_shell", "edit"] }),
      ]);

      const list = store.listMemoryChunks(parent.id);
      expect(list.map((c) => c.id)).toEqual(["c_001", "c_002"]);
      expect(list[0]?.topicLine).toBe("first arc");
      expect(list[1]?.toolNames).toEqual(["run_shell", "edit"]);
      expect(list[1]?.messageIds).toEqual(["m1", "m2"]);
      // The list index is metadata-only — the (large) content body must NOT
      // ride along, since it's injected per-row into the system prompt index.
      expect((list[0] as { content?: string }).content).toBeUndefined();
    });

    it("readMemoryChunk returns the full content body; unknown id is undefined", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_001", content: "lossless original text" })]);

      expect(store.readMemoryChunk(parent.id, "c_001")?.content).toBe("lossless original text");
      expect(store.readMemoryChunk(parent.id, "c_999")).toBeUndefined();
    });

    it("assigns ordinals continuing from the session max across batches", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      // Two separate insert calls — the second must continue numbering past the
      // first so list order stays oldest→newest, not reset to 0.
      store.insertMemoryChunks(parent.id, [
        makeChunk({ id: "c_001" }),
        makeChunk({ id: "c_002" }),
      ]);
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_003" })]);

      expect(store.listMemoryChunks(parent.id).map((c) => c.id)).toEqual(["c_001", "c_002", "c_003"]);
    });

    it("is idempotent on id: re-inserting the same chunk keeps the original (no overwrite)", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_001", content: "v1" })]);
      // Re-running compaction can re-emit an already-stored id; INSERT OR IGNORE
      // must make that a no-op rather than duplicate the row or clobber content.
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_001", content: "v2" })]);

      const list = store.listMemoryChunks(parent.id);
      expect(list).toHaveLength(1);
      expect(store.readMemoryChunk(parent.id, "c_001")?.content).toBe("v1");
    });

    it("scopes chunk ids per session: the same id in two sessions does not collide", () => {
      const a = makeSession();
      const b = makeSession();
      store.upsertSession(a);
      store.upsertSession(b);
      store.insertMemoryChunks(a.id, [makeChunk({ id: "c_001", content: "from A" })]);
      store.insertMemoryChunks(b.id, [makeChunk({ id: "c_001", content: "from B" })]);

      expect(store.readMemoryChunk(a.id, "c_001")?.content).toBe("from A");
      expect(store.readMemoryChunk(b.id, "c_001")?.content).toBe("from B");
      expect(store.listMemoryChunks(a.id)).toHaveLength(1);
    });

    it("cascades: deleting the session drops its chunks", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_001" })]);
      expect(store.listMemoryChunks(parent.id)).toHaveLength(1);

      store.deleteSession(parent.id);
      expect(store.listMemoryChunks(parent.id)).toEqual([]);
    });

    it("survives a close + reopen (chunks persist to disk for rehydration)", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      store.insertMemoryChunks(parent.id, [makeChunk({ id: "c_001", content: "durable" })]);
      store.close();

      const reopened = SessionStore.open(cwd);
      try {
        expect(reopened.listMemoryChunks(parent.id).map((c) => c.id)).toEqual(["c_001"]);
        expect(reopened.readMemoryChunk(parent.id, "c_001")?.content).toBe("durable");
      } finally {
        reopened.close();
      }
    });

    it("insert is a no-op for an empty chunk array", () => {
      const parent = makeSession();
      store.upsertSession(parent);
      expect(() => store.insertMemoryChunks(parent.id, [])).not.toThrow();
      expect(store.listMemoryChunks(parent.id)).toEqual([]);
    });
  });

  describe("workspace metadata", () => {
    it("round-trips a KV", () => {
      store.setWorkspaceMeta("name", "Reina");
      expect(store.getWorkspaceMeta("name")).toBe("Reina");
      expect(store.getWorkspaceMeta("missing")).toBeUndefined();
    });

    it("overwrites on second set with same key", () => {
      store.setWorkspaceMeta("name", "First");
      store.setWorkspaceMeta("name", "Second");
      expect(store.getWorkspaceMeta("name")).toBe("Second");
    });
  });
});

describe("resolveJournalMode (network-filesystem defense)", () => {
  const ENV = "REINA_SQLITE_JOURNAL_MODE";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("defaults to WAL on a local path", () => {
    expect(resolveJournalMode(path.join(os.tmpdir(), "reina.db"))).toBe("WAL");
  });

  it("downgrades to TRUNCATE on a Windows UNC share", () => {
    if (process.platform !== "win32") return; // UNC detection is win32-only
    expect(resolveJournalMode(String.raw`\\server\share\ws\.reina\reina.db`)).toBe("TRUNCATE");
    expect(resolveJournalMode("//server/share/ws/.reina/reina.db")).toBe("TRUNCATE");
  });

  it("honours the env override in both directions", () => {
    process.env[ENV] = "truncate";
    expect(resolveJournalMode(path.join(os.tmpdir(), "reina.db"))).toBe("TRUNCATE");
    process.env[ENV] = "wal";
    if (process.platform === "win32") {
      expect(resolveJournalMode(String.raw`\\server\share\reina.db`)).toBe("WAL");
    }
  });

  it("falls back to auto-detection on an unknown override value", () => {
    process.env[ENV] = "yolo";
    expect(resolveJournalMode(path.join(os.tmpdir(), "reina.db"))).toBe("WAL");
  });
});
