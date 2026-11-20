import { describe, expect, it } from "vitest";
import type { GoalStatus, SessionState } from "@reina/protocol";
import { buildVolatileContextReminder } from "./engine-prompt.js";

function session(status?: GoalStatus): SessionState {
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
    todos: [],
    pendingQuestions: [],
    skills: [],
    ...(status
      ? {
          goal: {
            current: {
              id: "goal_a",
              objective: "ship and verify",
              completionCriterion: "all tests pass",
              status,
              revision: 2,
              createdBy: "user",
              createdAt: "t",
              updatedAt: "t",
              usage: { tokensUsed: 12, turnsUsed: 1, wallClockMs: 1000 },
              ...(status === "blocked" ? { terminalReason: "CI unavailable" } : {}),
            },
            history: [],
            run: status === "active"
              ? {
                  id: "run_a",
                  goalId: "goal_a",
                  goalRevision: 2,
                  startedAt: "t",
                  tokenBaseline: 0,
                  turnBaseline: 0,
                  rounds: 1,
                  stagnantTurns: 0,
                  verifyRounds: 0,
                }
              : null,
            revision: 3,
          },
        }
      : {}),
  } as SessionState;
}

describe("Goal v2 dynamic context", () => {
  it("renders no current-Goal block when none exists", () => {
    expect(buildVolatileContextReminder(session())).not.toContain("## Current Goal");
  });

  it("pins the authoritative active Goal and forbids duplicate creation", () => {
    const text = buildVolatileContextReminder(session("active"));
    expect(text).toContain("## Current Goal");
    expect(text).toContain("State revision: 3");
    expect(text).toContain("Objective: ship and verify");
    expect(text).toContain("Completion criterion: all tests pass");
    expect(text).toContain("Do NOT call create_goal");
    expect(text).toContain("update_goal(status=complete");
  });

  it("suspends model work for a paused Goal", () => {
    const text = buildVolatileContextReminder(session("paused"));
    expect(text).toContain("status paused");
    expect(text).toContain("Do not pursue or resolve it");
  });

  it("surfaces blocked and complete terminal states without reopening them", () => {
    expect(buildVolatileContextReminder(session("blocked"))).toContain("CI unavailable");
    expect(buildVolatileContextReminder(session("complete"))).toContain("Do not create another Goal");
  });
});
