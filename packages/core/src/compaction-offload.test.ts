import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ModelConfig, SessionState } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { extractChunks, isCompactionOffloadEnabled } from "./chunks.js";
import { compactSessionContext, estimateTextTokens } from "./compaction.js";
import { SessionStore } from "./store/index.js";

let cwd: string;
let store: SessionStore;
const previousFlag = process.env.REINA_COMPACTION_OFFLOAD;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-offload-"));
  store = SessionStore.open(cwd, { inMemory: true });
});

afterEach(async () => {
  store.close();
  if (previousFlag === undefined) delete process.env.REINA_COMPACTION_OFFLOAD;
  else process.env.REINA_COMPACTION_OFFLOAD = previousFlag;
  await rm(cwd, { recursive: true, force: true });
});

const deterministicModel: ModelConfig = {
  provider: "deterministic",
  model: "deterministic-test",
};

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: createId("sess"),
    title: "offload-test",
    agent: "default",
    cwd,
    permissionMode: "default",
    model: deterministicModel,
    messages: [],
    toolCalls: [],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

describe("isCompactionOffloadEnabled", () => {
  it("returns true only when the env flag is exactly '1'", () => {
    process.env.REINA_COMPACTION_OFFLOAD = "1";
    expect(isCompactionOffloadEnabled()).toBe(true);
    process.env.REINA_COMPACTION_OFFLOAD = "0";
    expect(isCompactionOffloadEnabled()).toBe(false);
    process.env.REINA_COMPACTION_OFFLOAD = "true";
    expect(isCompactionOffloadEnabled()).toBe(false);
    delete process.env.REINA_COMPACTION_OFFLOAD;
    expect(isCompactionOffloadEnabled()).toBe(false);
  });
});

describe("extractChunks", () => {
  const messages: ChatMessage[] = [
    makeMessage("user", "first user question about refactoring profiles.ts"),
    makeMessage("assistant", "I'll look at profiles.ts"),
    makeMessage("assistant", "Used read_file on profiles.ts"),
    makeMessage("user", "second user question about the renderer bug"),
    makeMessage("assistant", "Looking at the renderer"),
  ];

  it("splits at user-message boundaries", () => {
    const chunks = extractChunks({
      messages,
      sessionId: "s",
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.id).toBe("c_001");
    expect(chunks[1]!.id).toBe("c_002");
    expect(chunks[0]!.messageIds).toHaveLength(3);
    expect(chunks[1]!.messageIds).toHaveLength(2);
  });

  it("populates the topic line from the first user message in the chunk", () => {
    const chunks = extractChunks({
      messages,
      sessionId: "s",
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    expect(chunks[0]!.topicLine).toMatch(/first user question about refactoring/);
    expect(chunks[1]!.topicLine).toMatch(/second user question about the renderer/);
  });

  it("force-splits chunks that exceed the token budget", () => {
    // One single user message + assistant message of 5000 tokens each → forced split
    const heavy = "x ".repeat(4000); // ~4000 tokens of cl100k
    const overflowing: ChatMessage[] = [
      makeMessage("user", "start " + heavy),
      makeMessage("assistant", heavy),
      makeMessage("assistant", heavy),
      makeMessage("assistant", heavy),
    ];
    const chunks = extractChunks({
      messages: overflowing,
      sessionId: "s",
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
      maxTokens: 4_000,
    });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("starts ids from the provided ordinal", () => {
    const chunks = extractChunks({
      messages,
      sessionId: "s",
      startOrdinal: 42,
      estimateTokens: estimateTextTokens,
    });
    expect(chunks[0]!.id).toBe("c_042");
    expect(chunks[1]!.id).toBe("c_043");
  });

  it("returns an empty array on empty input", () => {
    expect(
      extractChunks({
        messages: [],
        sessionId: "s",
        startOrdinal: 1,
        estimateTokens: estimateTextTokens,
      }),
    ).toEqual([]);
  });
});

describe("SessionStore memory_chunks", () => {
  it("inserts, lists, and reads chunks scoped per session", () => {
    const sessionId = createId("sess");
    store.upsertSession(makeSession({ id: sessionId }));

    const messages = [makeMessage("user", "topic A"), makeMessage("assistant", "doing A")];
    const chunks = extractChunks({
      messages,
      sessionId,
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    store.insertMemoryChunks(sessionId, chunks);

    const listed = store.listMemoryChunks(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("c_001");
    expect(listed[0]!.topicLine).toMatch(/topic A/);

    const full = store.readMemoryChunk(sessionId, "c_001");
    expect(full).toBeDefined();
    expect(full!.content).toContain("doing A");
  });

  it("hydrates memory chunk metadata when loading a session", () => {
    const sessionId = createId("sess");
    store.persistSession(makeSession({ id: sessionId }));

    const chunks = extractChunks({
      messages: [makeMessage("user", "reload topic"), makeMessage("assistant", "reload body")],
      sessionId,
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    store.insertMemoryChunks(sessionId, chunks);

    const loaded = store.loadSession(sessionId);
    expect(loaded?.memoryChunks).toHaveLength(1);
    expect(loaded?.memoryChunks?.[0]?.id).toBe("c_001");
    expect(loaded?.memoryChunks?.[0]?.topicLine).toMatch(/reload topic/);
  });

  it("keeps chunks from different sessions isolated", () => {
    const parentId = createId("parent");
    const childId = createId("child");
    store.upsertSession(makeSession({ id: parentId }));
    store.upsertSession(makeSession({ id: childId, isSubagent: true, subagentDepth: 1 }));

    const parentChunks = extractChunks({
      messages: [makeMessage("user", "parent work")],
      sessionId: parentId,
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    const childChunks = extractChunks({
      messages: [makeMessage("user", "child work")],
      sessionId: childId,
      startOrdinal: 1,
      estimateTokens: estimateTextTokens,
    });
    store.insertMemoryChunks(parentId, parentChunks);
    store.insertMemoryChunks(childId, childChunks);

    expect(store.listMemoryChunks(parentId)).toHaveLength(1);
    expect(store.listMemoryChunks(childId)).toHaveLength(1);
    expect(store.listMemoryChunks(parentId)[0]!.topicLine).toMatch(/parent work/);
    expect(store.listMemoryChunks(childId)[0]!.topicLine).toMatch(/child work/);
  });
});

describe("compactSessionContext onCompactedMessages", () => {
  it("fires once with the messages about to be dropped", async () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `body ${i} `.repeat(300)),
    );
    const session = makeSession({ modelMessages: long });
    let captured: ChatMessage[] | undefined;
    const boundary = await compactSessionContext(
      session,
      "manual",
      "callback test",
      { onCompactedMessages: (compacted) => { captured = [...compacted]; } },
    );
    expect(boundary).toBeDefined();
    expect(captured).toBeDefined();
    expect(captured!.length).toBe(boundary!.messagesCompacted);
  });

  it("awaits async callbacks before continuing", async () => {
    const long = Array.from({ length: 16 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `body ${i} `.repeat(300)),
    );
    const session = makeSession({ modelMessages: long });
    let resolved = false;
    await compactSessionContext(session, "manual", "async cb test", {
      onCompactedMessages: async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    });
    expect(resolved).toBe(true);
  });
});
