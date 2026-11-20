import { describe, expect, it } from "vitest";
import type { SessionState } from "@reina/protocol";
import { buildSystemPrompt, buildVolatileContextReminder } from "./engine-prompt.js";

// Holistic prefix-stability guard. The provider prompt cache (Anthropic
// ephemeral / OpenAI auto-prefix) only hits when the cached `[system + tools]`
// prefix is BYTE-IDENTICAL across turns. Per-turn volatile state therefore
// MUST ship via `buildVolatileContextReminder` (outside the cached prefix),
// never via `buildSystemPrompt`.
//
// Individual leaks are already guarded piecemeal (e.g. MCP status in
// engine-prompt.mcp.test.ts, hidden-tools roster in engine.test.ts). This file
// is the catch-all: mutate EVERY volatile source at once and assert the system
// prompt does not move. It exists to fail loudly the day someone wires a
// turn-varying value into `buildSystemPrompt` — the silent cache-bust that has
// no other test watching for it. Mirrors Reasonix's `verifyFingerprint()`
// drift assertion, expressed as a regression test.

function baseSession(): SessionState {
  return {
    id: "t",
    title: "t",
    agent: "default",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    cwd: process.cwd(),
    model: { provider: "deterministic", model: "x" },
    permissionMode: "default",
    messages: [],
    toolCalls: [],
    trace: [],
    approvals: [],
    questions: [],
    skills: [],
    asyncTasks: [],
    subagentDepth: 0,
  } as unknown as SessionState;
}

/** Populate every state field that `buildVolatileContextReminder` consumes —
 * Goal, todos, plan, shared notebook, autopilot and offloaded memory chunks. */
function withVolatileState(session: SessionState): SessionState {
  const s = session as unknown as Record<string, unknown>;
  s.todos = [
    { id: "t1", status: "in_progress", content: "wire up the thing" },
    { id: "t2", status: "pending", content: "test the thing" },
  ];
  s.plan = { status: "active", content: "1. do X\n2. do Y" };
  s.notes = [
    {
      id: "n_1",
      status: "confirmed",
      title: "auth bypass via header",
      tags: ["kind:hypothesis"],
      refs: [],
      createdAt: "2025-01-01T00:00:01Z",
    },
  ];
  s.autopilot = {
    running: true,
    goal: "audit the auth surface",
    rounds: 3,
    maxRounds: 20,
    startedAt: "2025-01-01T00:00:00Z",
    maxWallClockMs: 600_000,
  };
  s.goal = {
    current: {
      id: "goal_1",
      objective: "ship and verify",
      status: "active",
      revision: 1,
      createdBy: "user",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      usage: { tokensUsed: 200, turnsUsed: 2, wallClockMs: 5000 },
    },
    history: [],
    run: {
      id: "run_1",
      goalId: "goal_1",
      goalRevision: 1,
      startedAt: "2025-01-01T00:00:00Z",
      tokenBaseline: 0,
      turnBaseline: 0,
      rounds: 2,
      stagnantTurns: 0,
      verifyRounds: 0,
    },
    revision: 3,
  };
  s.memoryChunks = [
    {
      id: "c_1",
      createdAt: "2025-01-01T00:00:00Z",
      tokenCount: 1234,
      topicLine: "earlier exploration of the router",
      toolNames: ["read_file", "search_files"],
    },
  ];
  return session;
}

describe("system prompt prefix stability", () => {
  it("is byte-identical whether or not volatile turn state is present", () => {
    const empty = buildSystemPrompt(baseSession());
    const loaded = buildSystemPrompt(withVolatileState(baseSession()));
    // The whole point: todos/plan/notes/autopilot/memory churn every turn and
    // must NOT bust the cached prefix. If this fails, a volatile value leaked
    // into buildSystemPrompt — move it to buildVolatileContextReminder.
    expect(loaded).toBe(empty);
  });

  it("the volatile reminder DOES move (guards against a vacuous equality above)", () => {
    // If this didn't change, the equality test above would be meaningless —
    // it would prove the fields are ignored everywhere, not that they're
    // correctly routed to the uncached reminder.
    const empty = buildVolatileContextReminder(baseSession());
    const loaded = buildVolatileContextReminder(withVolatileState(baseSession()));
    expect(loaded).not.toBe(empty);
    expect(loaded).toContain("wire up the thing");
    expect(loaded).toContain("## Current Goal");
  });
});
