import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
// Runtime require so vitest's resolver never sees the experimental
// `node:sqlite` URL — same pattern as session-store.test.ts.
import type * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = createRequire(process.execPath)("node:sqlite") as typeof NodeSqlite;
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, nowIso } from "@reina/protocol";
import type { ChatMessage, MemoryChunk, SessionState } from "@reina/protocol";
import { SessionStore } from "./session-store.js";
import { INITIAL_SCHEMA, MEMORY_CHUNKS_SCHEMA } from "./schema.js";
import { searchMatchQuery, searchTerms } from "./search-terms.js";

/** CJK uni+bigram search terms (kimi minidb tokenizer port, migration v7):
 * Chinese queries hit an indexed FTS lookup instead of the old unbounded
 * LIKE scan — including cross-word queries LIKE could never match. */

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = nowIso();
  return {
    id: overrides.id ?? createId("ses"),
    title: "Reina",
    agent: "default",
    cwd: "/tmp/workspace",
    permissionMode: "default",
    model: { provider: "deterministic", model: "reina-deterministic" },
    messages: [],
    toolCalls: [],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as SessionState;
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

describe("searchTerms / searchMatchQuery", () => {
  it("tokenizes latin words plus CJK unigrams and bigrams", () => {
    const terms = searchTerms("Webpack 压缩记忆").split(" ");
    expect(terms).toContain("webpack");
    expect(terms).toContain("压");
    expect(terms).toContain("压缩");
    expect(terms).toContain("缩记");
    expect(terms).toContain("记忆");
    expect(terms).toContain("忆");
  });

  it("builds AND-of-terms match queries with latin prefix matching", () => {
    expect(searchMatchQuery("compact 记忆")).toBe('"compact"* AND "记忆"');
    expect(searchMatchQuery("压缩记忆")).toBe('"压缩" AND "缩记" AND "记忆"');
    expect(searchMatchQuery("火")).toBe('"火"');
    expect(searchMatchQuery("!!!")).toBeNull();
  });
});

describe("CJK search over the terms index", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = SessionStore.open("unused", { inMemory: true });
  });

  afterEach(() => {
    store.close();
  });

  it("finds Chinese cross-word queries the LIKE scan could never match", () => {
    const session = makeSession({
      messages: [
        makeMessage("user", "我们在做记忆压缩的调研工作"),
        makeMessage("assistant", "webpack config updated"),
      ],
    });
    store.persistSession(session);

    // "记忆 调研" is NOT a contiguous substring of the content — LIKE misses,
    // the AND-of-bigrams terms index hits.
    const crossWord = store.searchMessages("记忆 调研");
    expect(crossWord.length).toBe(1);
    expect(crossWord[0]!.sessionId).toBe(session.id);

    // Contiguous query: hit with a <mark>ed snippet.
    const contiguous = store.searchMessages("压缩");
    expect(contiguous.length).toBe(1);
    expect(contiguous[0]!.snippet).toContain("<mark>压缩</mark>");

    // Latin path untouched.
    expect(store.searchMessages("webpack").length).toBe(1);
    // Miss stays a miss.
    expect(store.searchMessages("不存在的词组").length).toBe(0);
  });

  it("stays consistent across persistSession's wipe-and-reinsert (trigger sync)", () => {
    const session = makeSession({ messages: [makeMessage("user", "记忆固化游标拆双键")] });
    store.persistSession(session);
    store.persistSession(session);
    store.persistSession(session);
    // One message row → exactly one hit; stale terms rows would surface as
    // duplicates or ghost rowids here.
    expect(store.searchMessages("固化 游标").length).toBe(1);
  });

  it("searches memory chunks through the terms index (CJK and latin prefix)", () => {
    const session = makeSession();
    store.persistSession(session);
    const chunk: MemoryChunk = {
      id: "c_001",
      sessionId: session.id,
      createdAt: nowIso(),
      topicLine: "compaction offload 设计讨论",
      toolNames: ["note"],
      tokenCount: 42,
      messageIds: ["m1"],
      content: "记忆检索与压缩的笔记正文",
    };
    store.insertMemoryChunks(session.id, [chunk]);

    // Cross-word CJK (LIKE would miss: "检索 笔记" is not a substring).
    const cjk = store.searchMemoryChunks("检索 笔记");
    expect(cjk.length).toBe(1);
    expect(cjk[0]!.chunkId).toBe("c_001");

    // Latin prefix: "compact" matches the indexed token "compaction".
    expect(store.searchMemoryChunks("compact").length).toBe(1);
    expect(store.searchMemoryChunks("完全无关").length).toBe(0);
  });
});

describe("v6 → v7 backfill", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "reina-search-terms-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("indexes pre-existing messages when the migration runs on an older DB", () => {
    // Seed a v6-shaped DB by hand (same technique as the v5→v6 test): base
    // schema + one session + one Chinese message, version pinned to 6.
    const dbPath = path.join(dir, ".reina", "reina.db");
    const { mkdirSync } = createRequire(process.execPath)("node:fs") as typeof import("node:fs");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    for (const stmt of [...INITIAL_SCHEMA, ...MEMORY_CHUNKS_SCHEMA]) raw.exec(stmt);
    raw
      .prepare(
        `INSERT INTO sessions (id, title, cwd, agent, model_provider, model_name, permission_mode, created_at, updated_at)
         VALUES ('ses_old', 'Old', '/tmp', 'default', 'deterministic', 'reina-deterministic', 'default', ?, ?)`,
      )
      .run(nowIso(), nowIso());
    raw
      .prepare(
        `INSERT INTO messages (id, session_id, ordinal, role, content, in_model_view, created_at)
         VALUES ('msg_old', 'ses_old', 0, 'user', '历史消息里的记忆压缩讨论', 1, ?)`,
      )
      .run(nowIso());
    raw.prepare(`INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', 6)`).run();
    raw.close();

    const store = SessionStore.open(dir);
    try {
      const hits = store.searchMessages("记忆 讨论");
      expect(hits.length).toBe(1);
      expect(hits[0]!.messageId).toBe("msg_old");
    } finally {
      store.close();
    }
  });
});
