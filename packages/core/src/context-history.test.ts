import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextRequestRecord, ModelRequest } from "@reina/protocol";
import { apportionContextTokens, captureContextSections, CONTEXT_HISTORY_LIMIT, ContextHistoryStore } from "./context-history.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "reina-context-history-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); });

function record(id: string, sessionId = "child-one"): ContextRequestRecord {
  return {
    id, sessionId, turnId: "turn-one", attempt: 1, startedAt: "2026-09-09T00:00:00.000Z", status: "running",
    provider: "deterministic", model: "test", breakdown: {
      createdAt: "2026-09-09T00:00:00.000Z", provider: "deterministic", model: "test",
      messagesCount: 1, observationsCount: 0, toolsCount: 0, systemPromptChars: 4, systemPromptTokens: 1,
      messagesChars: 4, messagesTokens: 1, observationsChars: 0, observationsTokens: 0,
      toolsDescriptionChars: 0, toolsSchemaChars: 0, toolsTokens: 0, totalChars: 8,
      estimatedInputTokens: 2, toolNames: [],
    },
  };
}

const request: ModelRequest = {
  systemPrompt: "system instruction", tools: [], observations: [],
  messages: [{ id: "user-one", role: "user", content: "original request", createdAt: "2026-09-09T00:00:00.000Z" }],
};

describe("context inspection storage", () => {
  it("preserves the starting body while terminal metadata and actual usage replace a running attempt", async () => {
    const store = new ContextHistoryStore({ cwd, sessionId: "parent" });
    const start = record("request-one");
    store.recordRequest(start, captureContextSections(request));
    store.recordRequest({ ...start, status: "completed", completedAt: "2026-09-09T00:00:01.000Z", usage: { inputTokens: 123, outputTokens: 4 } });
    const reopened = new ContextHistoryStore({ cwd, sessionId: "parent" });
    const history = await reopened.history();
    expect(history.requests).toHaveLength(1);
    expect(history.requests[0]).toMatchObject({ status: "completed", breakdown: { estimatedInputTokens: 2 }, usage: { inputTokens: 123 } });
    expect(JSON.stringify(await reopened.request(start.id))).toContain("original request");
    expect(await reopened.request("missing")).toBeNull();
  });

  it("serializes writes from replaced child engines without mixing parents or tasks", async () => {
    const owner = { cwd, sessionId: "parent", taskId: "task-one" };
    const first = new ContextHistoryStore(owner);
    const second = new ContextHistoryStore(owner);
    first.recordRequest(record("request-one", "child-one"), captureContextSections(request));
    second.recordRequest(record("request-two", "child-two"), captureContextSections(request));
    const sibling = new ContextHistoryStore({ ...owner, taskId: "task-two" });
    sibling.recordRequest(record("request-three", "child-three"), captureContextSections(request));
    expect((await second.history()).requests.map((entry) => entry.sessionId)).toEqual(["child-one", "child-two"]);
    expect((await sibling.history()).requests.map((entry) => entry.sessionId)).toEqual(["child-three"]);
    expect((await new ContextHistoryStore({ ...owner, sessionId: "other-parent" }).history()).requests).toEqual([]);
    expect(await second.request("request-three")).toBeNull();
  });

  it("removes expired detail files and bounds the request and compaction metadata", async () => {
    const store = new ContextHistoryStore({ cwd, sessionId: "retention" });
    for (let i = 0; i < CONTEXT_HISTORY_LIMIT + 2; i++) {
      store.recordRequest(record("request-" + i), captureContextSections(request));
    }
    let history = await store.history();
    expect(history.requests).toHaveLength(CONTEXT_HISTORY_LIMIT);
    expect(history.requests[0]!.id).toBe("request-2");
    expect(await store.request("request-0")).toBeNull();
    expect((await readdir(store.directory)).filter((entry) => entry.endsWith(".json"))).toHaveLength(CONTEXT_HISTORY_LIMIT + 1);
    for (let i = 0; i < 201; i++) store.recordEvent({ id: "event-" + i, createdAt: "now", status: "started" });
    history = await store.history();
    expect(history.events).toHaveLength(200);
    expect(history.events[0]!.id).toBe("event-1");
  });

  it("updates compaction lifecycle and marks unfinished records from a previous process", async () => {
    const store = new ContextHistoryStore({ cwd, sessionId: "restart" });
    store.recordRequest(record("unfinished"), captureContextSections(request));
    store.recordEvent({ id: "compact-done", createdAt: "now", status: "started" });
    store.recordEvent({ id: "compact-done", createdAt: "later", status: "completed" });
    store.recordEvent({ id: "compact-unfinished", createdAt: "now", status: "started" });
    expect((await store.history()).events).toHaveLength(2);
    expect((await new ContextHistoryStore({ cwd, sessionId: "restart" }).history()).requests[0]!.status).toBe("running");
    const file = path.join(store.directory, "index.json");
    const persisted = JSON.parse(await readFile(file, "utf8"));
    persisted.writerId = "previous-process";
    await writeFile(file, JSON.stringify(persisted));
    const recovered = await new ContextHistoryStore({ cwd, sessionId: "restart" }).history();
    expect(recovered.requests[0]).toMatchObject({ status: "cancelled", error: expect.stringContaining("previous agent-host") });
    expect(recovered.events.map((event) => event.status)).toEqual(["completed", "failed"]);
  });

  it("omits credentials, provider state and media without modifying the actual request", () => {
    const input = {
      ...request, providerState: { secret: "provider-state-secret" },
      messages: [{ ...request.messages[0]!, content: "inline data:image/png;base64,QUJDRA==", attachments: [{ dataBase64: "media-secret", mimeType: "image/png" }] }],
      observations: [{ callId: "call", name: "read_file", output: "visible output", apiKey: "transport-secret" }],
    } as unknown as ModelRequest;
    const before = JSON.stringify(input);
    const captured = JSON.stringify(captureContextSections(input));
    expect(captured).toContain("visible output");
    for (const secret of ["provider-state-secret", "media-secret", "transport-secret", "QUJDRA=="]) expect(captured).not.toContain(secret);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("marks truncated items while keeping the inspection copy bounded", () => {
    const sections = captureContextSections({
      ...request, systemPrompt: "context ".repeat(20_000),
      messages: Array.from({ length: 20 }, (_, index) => ({ ...request.messages[0]!, id: "message-" + index, content: "context ".repeat(20_000) })),
    });
    const items = sections.flatMap((section) => section.items);
    expect(items.some((item) => item.truncated)).toBe(true);
    expect(items.reduce((total, item) => total + item.content.length, 0)).toBeLessThan(401_000);
    expect(items.every((item) => item.tokens === undefined)).toBe(true);
    const measured = captureContextSections({ ...request, systemPrompt: "context ".repeat(20_000) },
      { system: 20_000, tools: 0, user: 10, injected: 0, assistant: 0, toolResults: 0 });
    expect(measured[0]!.items[0]!.tokens).toBeUndefined();
    expect(measured[1]!.items[0]!.tokens).toBe(10);
    const omittedTail = captureContextSections({
      ...request,
      messages: [request.messages[0]!,
        ...Array.from({ length: 7 }, (_, index) => ({ ...request.messages[0]!, id: `large-${index}`, role: "assistant" as const, content: "x".repeat(70_000) })),
        { ...request.messages[0]!, id: "omitted-user", content: "unseen user input" },
      ],
    }, { system: 20, tools: 0, user: 50_000, injected: 0, assistant: 100_000, toolResults: 0 });
    expect(omittedTail[1]!.items[0]!.tokens).toBeUndefined();
  });

  it("classifies hidden context and tool results once while retaining inspectable provenance", () => {
    const composition = { system: 20, tools: 0, user: 10, injected: 30, assistant: 40, toolResults: 50 };
    const sections = captureContextSections({
      ...request,
      messages: [request.messages[0]!,
        { ...request.messages[0]!, id: "state", content: "state change", ephemeral: true, contextState: { version: 1, sections: {} } },
        { ...request.messages[0]!, id: "result", content: "read result", ephemeral: true, toolResult: { callId: "read", name: "read_file", input: { path: "README.md" }, output: "read result" } },
        { ...request.messages[0]!, id: "answer", role: "assistant", content: "answer" },
      ],
      systemReminders: ["new reminder"],
    }, composition);
    const items = sections.flatMap((entry) => entry.items);
    expect(items.find((entry) => entry.id === "result")).toMatchObject({ category: "toolResults", source: "read_file", tokens: 50 });
    expect(items.find((entry) => entry.id === "state")).toMatchObject({ category: "injected", source: "context-state" });
    expect(items.filter((entry) => entry.category === "injected").reduce((sum, entry) => sum + entry.tokens!, 0)).toBe(30);
    expect(items.reduce((sum, entry) => sum + entry.tokens!, 0)).toBe(150);
    expect(JSON.stringify(items)).toContain("README.md");
    expect(apportionContextTokens([3, 1, 2], 13).reduce((sum, value) => sum + value, 0)).toBe(13);
  });

  it("isolates disk failure from the caller and does not leak an unhandled write rejection", async () => {
    await writeFile(path.join(cwd, ".reina"), "not a directory");
    const failures: unknown[] = [];
    const store = new ContextHistoryStore({ cwd, sessionId: "failed" }, (error) => { failures.push(error); });
    expect(() => store.recordRequest(record("request-one"), captureContextSections(request))).not.toThrow();
    await store.flush();
    expect(failures).toHaveLength(1);
    expect(await readFile(path.join(cwd, ".reina"), "utf8")).toBe("not a directory");
  });
});
