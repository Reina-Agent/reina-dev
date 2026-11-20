import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelConfig, SessionState, ToolDescriptor } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

/** Coverage for the cache-reuse summary fast path (compaction.ts). The provider
 * is MOCKED because the built-in deterministic provider can't emit a clean
 * <summary> turn — it returns the "deterministic provider only handles" stub or
 * planned tool calls, which would force the fast path to fall back every time
 * and hide the behavior under test. We keep the rest of @reina/providers real
 * via `...actual`. */

const h = vi.hoisted(() => ({
  count: 0,
  // Scripted per-call turns. Each entry is what nextModelTurnStream resolves to
  // on that call; the last entry repeats if there are more calls than entries.
  turns: [] as Array<{ content?: string; truncated?: boolean; toolCalls: Array<{ id: string; name: string; arguments: string }> }>,
  requests: [] as Array<{ messages: ChatMessage[]; tools: ToolDescriptor[]; systemPrompt: string; observations: unknown[] }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async (
      _config: unknown,
      request: { messages: ChatMessage[]; tools: ToolDescriptor[]; systemPrompt: string; observations: unknown[] },
    ) => {
      h.requests.push(request);
      const i = h.count++;
      return h.turns[Math.min(i, h.turns.length - 1)] ?? { toolCalls: [] };
    },
  };
});

const { compactSessionContext } = await import("./compaction.js");

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-compaction-cache-"));
  h.count = 0;
  h.turns = [];
  h.requests = [];
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function compactableSession(): SessionState {
  // Heavy bodies so the 8-message tail already exceeds COMPACT_KEEP_RECENT_TOKENS
  // and a real prefix (> COMPACT_MIN_COMPACTED_TOKENS) is left to summarize.
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

const MAIN_SYS = "MAIN-AGENT-SYSTEM-PROMPT";
const mainTools = [{ name: "read_file" }] as unknown as ToolDescriptor[];

describe("compaction cache-reuse fast path", () => {
  it("reuses the main system+tools prefix and sends the native slice (no flatten/opener)", async () => {
    h.turns = [{ content: "<analysis>x</analysis><summary>Reused summary OK</summary>", toolCalls: [] }];
    const session = compactableSession();
    const sliceLen = session.modelMessages!.length; // upper bound; real slice is a prefix

    const boundary = await compactSessionContext(session, "auto", "ctx pressure", {
      cacheReuse: { systemPrompt: MAIN_SYS, tools: mainTools },
    });

    expect(boundary).toBeDefined();
    expect(session.summary).toContain("Reused summary OK");
    // Exactly one model call — a clean fast-path result must NOT trigger the
    // fenced fallback.
    expect(h.requests).toHaveLength(1);

    const req = h.requests[0]!;
    // Cache-reuse contract: the main agent's exact prefix is reused verbatim.
    expect(req.systemPrompt).toBe(MAIN_SYS);
    expect(req.tools).toBe(mainTools);
    // Native slice + a single trailing instruction — NOT the safe path's
    // prepended opener, and nothing flattened.
    expect(req.messages.length).toBeGreaterThan(1);
    expect(req.messages.length).toBeLessThanOrEqual(sliceLen + 1);
    expect(req.messages[0]!.content).not.toContain("Conversation segment to summarize follows");
    const instruction = req.messages[req.messages.length - 1]!;
    expect(instruction.role).toBe("user");
    expect(instruction.content).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(instruction.content).toContain("Compaction reason: ctx pressure");
    // The first sent message is an original slice message, byte-for-byte —
    // proof the slice was sent natively rather than re-serialized.
    expect(req.messages[0]!.content).toBe(`message body 0 `.repeat(300));
  });

  it("falls back to the fenced no-tools path when the model defects to a tool call", async () => {
    h.turns = [
      // Fast path: model ignores the instruction and calls a tool.
      { content: "let me check", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      // Safe path: clean summary.
      { content: "<summary>Safe path summary</summary>", toolCalls: [] },
    ];
    const session = compactableSession();

    const boundary = await compactSessionContext(session, "auto", "ctx pressure", {
      cacheReuse: { systemPrompt: MAIN_SYS, tools: mainTools },
    });

    expect(boundary).toBeDefined();
    expect(session.summary).toContain("Safe path summary");
    // Two calls: the defected fast-path attempt, then the fenced fallback.
    expect(h.requests).toHaveLength(2);

    const [fast, safe] = h.requests;
    // Fast path used the reused prefix...
    expect(fast!.systemPrompt).toBe(MAIN_SYS);
    expect(fast!.tools).toBe(mainTools);
    // ...the fallback used the dedicated no-tools summary prompt + empty tools
    // + the flattened-with-opener message shape.
    expect(safe!.systemPrompt).not.toBe(MAIN_SYS);
    expect(safe!.tools).toHaveLength(0);
    expect(safe!.messages[0]!.content).toContain("Conversation segment to summarize follows");
  });

  it("stays on the safe path entirely when no cacheReuse is supplied", async () => {
    h.turns = [{ content: "<summary>Safe only</summary>", toolCalls: [] }];
    const session = compactableSession();

    await compactSessionContext(session, "auto", "ctx pressure");

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.tools).toHaveLength(0);
    expect(h.requests[0]!.systemPrompt).not.toBe(MAIN_SYS);
  });

  it("falls back to the safe path when the cached-prefix summary is truncated", async () => {
    h.turns = [
      { content: "<summary>INCOMPLETE_FAST_SUMMARY</summary>", toolCalls: [], truncated: true },
      { content: "<summary>Complete safe summary</summary>", toolCalls: [] },
    ];
    const session = compactableSession();

    await compactSessionContext(session, "auto", "ctx pressure", {
      cacheReuse: { systemPrompt: MAIN_SYS, tools: mainTools },
    });

    expect(session.summary).toContain("Complete safe summary");
    expect(session.summary).not.toContain("INCOMPLETE_FAST_SUMMARY");
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.tools).toHaveLength(0);
  });
});
