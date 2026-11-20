import type { SessionState } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { buildCompletionVerifyTrace, parseVerdict } from "./completion-verifier.js";

function stubSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    autopilot: { running: true, goal: "g", startedAt: "t", rounds: 2 },
    activeGoals: [],
    ...overrides,
  } as unknown as SessionState;
}

describe("buildCompletionVerifyTrace", () => {
  it("summarizes rounds, tool sequence, assistant text, goals + evidence, and the declaration", () => {
    const session = stubSession({
      messages: [
        { id: "1", role: "assistant", content: "Investigating the auth flow.", createdAt: "t" },
        {
          id: "2",
          role: "user",
          content: "irrelevant",
          createdAt: "t",
          toolResult: { callId: "c1", name: "read_file" },
        },
        {
          id: "3",
          role: "user",
          content: "irrelevant",
          createdAt: "t",
          toolResult: { callId: "c2", name: "run_shell" },
        },
        { id: "4", role: "assistant", content: "Fixed the bug and ran tests.", createdAt: "t" },
      ] as unknown as SessionState["messages"],
      usage: { inputTokens: 100, outputTokens: 50 } as SessionState["usage"],
      activeGoals: [
        {
          id: "goal_1",
          condition: "all tests pass",
          status: "met",
          evidence: "npm test: 879 passed",
          createdAt: "t",
          createdBy: "user",
        },
      ] as unknown as SessionState["activeGoals"],
    });
    const trace = buildCompletionVerifyTrace(session, { status: "complete", summary: "Done — tests green." });

    expect(trace).toContain("Continuation rounds: 2");
    expect(trace).toContain("Model tokens used: 150");
    expect(trace).toContain("Tool calls: 2");
    expect(trace).toContain("[1] read_file");
    expect(trace).toContain("[2] run_shell");
    expect(trace).toContain("Fixed the bug and ran tests.");
    expect(trace).toContain("[goal_1] (met) all tests pass");
    expect(trace).toContain("evidence: npm test: 879 passed");
    expect(trace).toContain("status=complete");
    expect(trace).toContain("Done — tests green.");
  });

  it("handles an empty run without throwing", () => {
    const trace = buildCompletionVerifyTrace(stubSession(), { status: "complete", summary: "" });
    expect(trace).toContain("Tool calls: 0");
  });
});

describe("parseVerdict", () => {
  it("parses a bare JSON object", () => {
    const v = parseVerdict('{"pass": true, "reason": "ok", "feedback": ""}');
    expect(v).toEqual({ pass: true, reason: "ok", feedback: "" });
  });

  it("extracts JSON wrapped in prose / code fences", () => {
    const v = parseVerdict(
      'Here is my verdict:\n```json\n{"pass": false, "reason": "no evidence", "feedback": "run the tests"}\n```\nThanks.',
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("no evidence");
  });

  it("tolerates a brace inside a string value", () => {
    const v = parseVerdict('{"pass": false, "reason": "missing }brace test", "feedback": ""}');
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("missing }brace test");
  });

  it("defaults missing optional fields", () => {
    const v = parseVerdict('{"pass": true}');
    expect(v).toEqual({ pass: true, reason: "", feedback: "" });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseVerdict("I cannot determine this.")).toThrow();
  });

  it("throws when `pass` is not a boolean", () => {
    expect(() => parseVerdict('{"reason": "no pass field"}')).toThrow();
  });
});
