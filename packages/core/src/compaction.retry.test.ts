import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelConfig, SessionState } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

/** Coverage for summaryTurnWithRetries (compaction.ts): a transient provider
 * failure on the summary side request must be retried — not silently degrade
 * the summary to the extractive fallback — while non-retryable errors still
 * fall through immediately. isRetryableStreamError stays REAL via `...actual`
 * so the retryable/non-retryable classification under test is the production
 * one. */

const h = vi.hoisted(() => ({
  count: 0,
  // Scripted per-call outcomes; the last entry repeats.
  script: [] as Array<{ error?: string; content?: string; truncated?: boolean }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async () => {
      const i = h.count++;
      const step = h.script[Math.min(i, h.script.length - 1)] ?? {};
      if (step.error) throw new Error(step.error);
      return { content: step.content, truncated: step.truncated, toolCalls: [] };
    },
  };
});

const { compactSessionContext, POST_COMPACT_CONTEXT_PREFIX } = await import("./compaction.js");

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-compaction-retry-"));
  h.count = 0;
  h.script = [];
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function compactableSession(): SessionState {
  const long = Array.from({ length: 20 }, (_, i) =>
    makeMessage(i % 2 === 0 ? "user" : "assistant", `message body ${i} `.repeat(300)),
  );
  return {
    id: createId("sess"),
    title: "test",
    agent: "default",
    cwd,
    permissionMode: "default",
    model: { provider: "anthropic-messages", model: "claude-test" } as ModelConfig,
    messages: [],
    modelMessages: long,
    toolCalls: [],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as unknown as SessionState;
}

describe("summary side-request retries", () => {
  it("retries a transient failure instead of degrading to the extractive fallback", async () => {
    h.script = [{ error: "socket hang up" }, { content: "<summary>Recovered model summary</summary>" }];
    const session = compactableSession();

    const boundary = await compactSessionContext(session, "auto", "ctx pressure");

    expect(boundary).toBeDefined();
    expect(session.summary).toContain("Recovered model summary");
    expect(h.count).toBe(2);
  }, 15_000);

  it("does not retry non-retryable (quota) failures — extractive fallback, one call", async () => {
    h.script = [{ error: "429 insufficient_quota" }, { content: "<summary>should never be reached</summary>" }];
    const session = compactableSession();

    const boundary = await compactSessionContext(session, "auto", "ctx pressure");

    // Extractive fallback still produced a boundary, without a second call.
    expect(boundary).toBeDefined();
    expect(session.summary).not.toContain("should never be reached");
    expect(h.count).toBe(1);
  });

  it.each([500, 7_950])("keeps new constraints and progress with %i characters of prior context", async (priorLength) => {
    h.script = [{ error: "429 insufficient_quota" }];
    const session = compactableSession();
    session.summary = `ORIGINAL_GOAL ${"previous detail ".repeat(530).slice(0, priorLength)} PRIOR_NEXT_STEP`;
    const source = session.modelMessages!;
    source[0]!.content = `NEW_CONSTRAINT_REVIEW_ONLY ${source[0]!.content} DO_NOT_DEPLOY`;
    source[11]!.content = `${source[11]!.content} LATEST_PROGRESS_TESTS_PENDING`;
    const notice = makeMessage("user", "INJECTED_NOTICE_NOT_A_REQUEST".repeat(500));
    notice.origin = "task-delta";
    source.unshift(
      makeMessage("user", `${POST_COMPACT_CONTEXT_PREFIX}\nConversation summary:\n${session.summary}`),
      notice,
    );
    session.messages = source.slice();

    const boundary = await compactSessionContext(session, "auto", "fallback preservation");

    expect(boundary).toBeDefined();
    expect(boundary!.preservedMessageIds).not.toContain(source[2]!.id);
    expect(boundary!.preservedMessageIds).not.toContain(source[13]!.id);
    for (const text of ["ORIGINAL_GOAL", "PRIOR_NEXT_STEP", "NEW_CONSTRAINT_REVIEW_ONLY", "DO_NOT_DEPLOY", "LATEST_PROGRESS_TESTS_PENDING"]) {
      expect(session.summary).toContain(text);
      expect(session.modelMessages![0]!.content).toContain(text);
    }
    expect(session.summary!.length).toBeLessThanOrEqual(8_000);
    expect(session.summary).not.toContain(POST_COMPACT_CONTEXT_PREFIX);
    expect(session.summary).not.toContain("INJECTED_NOTICE_NOT_A_REQUEST");
    const history = await readFile(path.resolve(cwd, boundary!.historyPath!), "utf8");
    expect(history).toContain("NEW_CONSTRAINT_REVIEW_ONLY");
    expect(h.count).toBe(1);
  });

  it("reserves room for the latest user correction among many tool results", async () => {
    h.script = [{ error: "429 insufficient_quota" }];
    const session = compactableSession();
    session.model.contextWindowTokens = 32_000;
    session.summary = "previous detail ".repeat(530);
    const requests = Array.from({ length: 18 }, (_, index) =>
      makeMessage("user", `request-${index} ${"request details ".repeat(50)}`),
    );
    requests[0]!.content = "INITIAL_REQUEST " + requests[0]!.content;
    requests.at(-1)!.content += " LATEST_CORRECTION_KEEP_EXISTING_FILES";
    const tools = Array.from({ length: 40 }, () => ({
      ...makeMessage("user", "TOOL_OUTPUT_IS_NOT_USER_INSTRUCTION ".repeat(100)),
      toolResult: { callId: createId("call"), name: "run_shell" },
    }));
    const tail = session.modelMessages!.map((item) => ({ ...item, role: "assistant" as const }));
    session.modelMessages = [...requests, ...tools, ...tail];

    const boundary = await compactSessionContext(session, "auto", "tool-heavy fallback");

    expect(boundary!.preservedMessageIds).not.toContain(requests.at(-1)!.id);
    expect(session.summary).toContain("INITIAL_REQUEST");
    expect(session.summary).toContain("LATEST_CORRECTION_KEEP_EXISTING_FILES");
    expect(session.summary!.length).toBeLessThanOrEqual(8_000);
  });

  it("does not accept a provider-truncated summary as a completed summary", async () => {
    h.script = [{ content: "<summary>PARTIAL_MODEL_SUMMARY</summary>", truncated: true }];
    const session = compactableSession();

    await compactSessionContext(session, "auto", "truncated summary");

    expect(session.summary).not.toContain("PARTIAL_MODEL_SUMMARY");
    expect(session.summary).toContain("Compacted conversation:");
    expect(session.summary).toContain("message body 0");
    expect(h.count).toBe(1);
  });

  it("retains a new constraint across a successful compaction followed by a failed one", async () => {
    h.script = [
      { content: `<summary>ORIGINAL_GOAL ${"earlier details ".repeat(530)} NEXT_STEP</summary>` },
      { error: "429 insufficient_quota" },
    ];
    const session = compactableSession();
    session.model.contextWindowTokens = 32_000;
    await compactSessionContext(session, "auto", "first compaction");
    const correction = makeMessage("user", "NEW_CONSTRAINT_PRESERVE_EXISTING_CHANGES");
    const continuation = Array.from({ length: 20 }, (_, index) =>
      makeMessage("assistant", `continuation ${index} `.repeat(400)),
    );
    session.modelMessages!.push(correction, ...continuation);

    const boundary = await compactSessionContext(session, "auto", "second compaction");

    expect(boundary!.preservedMessageIds).not.toContain(correction.id);
    expect(session.compactBoundaries).toHaveLength(2);
    expect(session.summary).toContain("ORIGINAL_GOAL");
    expect(session.summary).toContain("NEW_CONSTRAINT_PRESERVE_EXISTING_CHANGES");
    expect(session.modelMessages![0]!.content).toContain("NEW_CONSTRAINT_PRESERVE_EXISTING_CHANGES");
    expect(session.summary!.length).toBeLessThanOrEqual(8_000);
    expect(session.summary).not.toContain(POST_COMPACT_CONTEXT_PREFIX);
    expect(h.count).toBe(2);
  });

  it("keeps both rounds of user constraints after consecutive fallback compactions", async () => {
    h.script = [{ error: "429 insufficient_quota" }];
    const session = compactableSession();
    session.model.contextWindowTokens = 32_000;
    session.summary = `ORIGINAL_GOAL ${"previous detail ".repeat(530)}`;
    session.modelMessages![10]!.content += " FIRST_CORRECTION_KEEP_EXISTING_FILES";
    session.modelMessages!.unshift(makeMessage("user", `${POST_COMPACT_CONTEXT_PREFIX}\n${session.summary}`));
    await compactSessionContext(session, "auto", "first fallback");
    expect(session.summary).toContain("FIRST_CORRECTION_KEEP_EXISTING_FILES");
    const correction = makeMessage("user", "SECOND_CORRECTION_REVIEW_BEFORE_COMMIT");
    session.modelMessages!.push(
      correction,
      ...Array.from({ length: 20 }, (_, index) => makeMessage("assistant", `continuation ${index} `.repeat(400))),
    );

    const boundary = await compactSessionContext(session, "auto", "second fallback");

    expect(boundary!.preservedMessageIds).not.toContain(correction.id);
    expect(session.compactBoundaries).toHaveLength(2);
    for (const text of ["ORIGINAL_GOAL", "FIRST_CORRECTION_KEEP_EXISTING_FILES", "SECOND_CORRECTION_REVIEW_BEFORE_COMMIT"]) {
      expect(session.summary).toContain(text);
      expect(session.modelMessages![0]!.content).toContain(text);
    }
    expect(session.summary!.length).toBeLessThanOrEqual(8_000);
    expect(h.count).toBe(2);
  });

  it("keeps the next step at the end of a complete oversized model summary", async () => {
    h.script = [{ content: `<summary>PRIMARY_REQUEST ${"historical details ".repeat(800)} NEXT_STEP_RUN_REGRESSION</summary>` }];
    const session = compactableSession();

    await compactSessionContext(session, "auto", "long completed summary");

    expect(session.summary).toContain("PRIMARY_REQUEST");
    expect(session.summary).toContain("NEXT_STEP_RUN_REGRESSION");
    expect(session.summary!.length).toBeLessThanOrEqual(8_000);
    expect(h.count).toBe(1);
  });
});
