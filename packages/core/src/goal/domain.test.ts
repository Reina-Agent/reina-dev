import { describe, expect, it } from "vitest";
import type { GoalState, SessionState } from "@reina/protocol";
import { emptyGoalState, migrateLegacyGoalState, projectedGoalUsage, transitionGoal } from "./domain.js";

const ids = (() => {
  let value = 0;
  return () => `id_${++value}`;
})();

function apply(
  state: GoalState | undefined,
  command: Parameters<typeof transitionGoal>[1],
  actor: Parameters<typeof transitionGoal>[2] = "user",
  usage = { tokens: 0, turns: 0 },
  now = "2026-01-01T00:00:00.000Z",
): GoalState {
  const result = transitionGoal(state, command, actor, { usage, now, createId: ids });
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

describe("Goal domain", () => {
  it("creates one host-owned current goal before any model action", () => {
    const state = apply(undefined, { type: "create", objective: "Ship the fix" });
    expect(state.current).toMatchObject({
      objective: "Ship the fix",
      status: "active",
      revision: 1,
      createdBy: "user",
    });
    expect(state.run).toMatchObject({ goalId: state.current!.id, rounds: 0, tokenBaseline: 0 });
    expect(state.revision).toBe(1);
  });

  it("makes a repeated semantic create idempotent and rejects a different unfinished goal", () => {
    const state = apply(undefined, { type: "create", objective: "Ship   the fix" });
    const same = transitionGoal(state, { type: "create", objective: " ship the FIX " }, "model", { createId: ids });
    expect(same).toMatchObject({ ok: true, changed: false });
    if (same.ok) expect(same.state.revision).toBe(state.revision);

    const conflict = transitionGoal(state, { type: "create", objective: "Start something else" }, "model", {
      createId: ids,
    });
    expect(conflict).toMatchObject({ ok: false, code: "GOAL_EXISTS" });
  });

  it("rejects invalid budgets at the state-machine boundary", () => {
    for (const budgetLimits of [{ tokenBudget: 0 }, { turnBudget: -1 }, { wallClockBudgetMs: 1.5 }]) {
      expect(
        transitionGoal(undefined, { type: "create", objective: "Bounded work", budgetLimits }, "user", {
          createId: ids,
        }),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("keeps a completion claim active until an independent verifier passes it", () => {
    let state = apply(undefined, { type: "create", objective: "Pass tests" });
    state = apply(state, { type: "claim_complete", goalId: state.current!.id, evidence: "42 tests passed" }, "model", {
      tokens: 120,
      turns: 1,
    });
    expect(state.current?.status).toBe("active");
    expect(state.completionClaim?.evidence).toBe("42 tests passed");

    state = apply(state, { type: "verification_passed", claimId: state.completionClaim!.id }, "verifier", {
      tokens: 140,
      turns: 1,
    });
    expect(state.current).toMatchObject({ status: "complete", evidence: "42 tests passed" });
    expect(state.run).toBeNull();
    expect(state.completionClaim).toBeUndefined();
  });

  it("rejects stale state revisions and stale verification claims", () => {
    let state = apply(undefined, { type: "create", objective: "Old target" });
    const staleRevision = transitionGoal(
      state,
      { type: "pause", goalId: state.current!.id, expectedRevision: state.revision - 1 },
      "user",
      { createId: ids },
    );
    expect(staleRevision).toMatchObject({ ok: false, code: "STALE_REVISION" });

    state = apply(state, { type: "claim_complete", goalId: state.current!.id, evidence: "proof" }, "model");
    const claimId = state.completionClaim!.id;
    state = apply(state, { type: "pause", goalId: state.current!.id });
    expect(state.completionClaim).toBeUndefined();
    const staleClaim = transitionGoal(state, { type: "verification_passed", claimId }, "verifier", { createId: ids });
    expect(staleClaim).toMatchObject({ ok: false, code: "STALE_CLAIM" });
  });

  it("enforces lifecycle authority at the state-machine boundary", () => {
    const state = apply(undefined, { type: "create", objective: "Protected Goal" });
    expect(
      transitionGoal(state, { type: "claim_complete", goalId: state.current!.id, evidence: "user bypass" }, "user", {
        createId: ids,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(
      transitionGoal(state, { type: "verification_passed", claimId: "fake" }, "model", { createId: ids }),
    ).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(transitionGoal(state, { type: "advance_run", progressKey: "x" }, "user", { createId: ids })).toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });

  it("settles per-goal usage across pause and resume without counting earlier session usage", () => {
    let state = apply(undefined, { type: "create", objective: "Bounded work" }, "user", { tokens: 1000, turns: 10 });
    expect(projectedGoalUsage(state, { tokens: 1250, turns: 12 }, "2026-01-01T00:00:05.000Z")).toEqual({
      tokensUsed: 250,
      turnsUsed: 2,
      wallClockMs: 5000,
    });
    state = apply(
      state,
      { type: "pause", goalId: state.current!.id },
      "user",
      { tokens: 1250, turns: 12 },
      "2026-01-01T00:00:05.000Z",
    );
    state = apply(
      state,
      { type: "resume", goalId: state.current!.id },
      "user",
      { tokens: 2000, turns: 20 },
      "2026-01-01T00:01:00.000Z",
    );
    expect(projectedGoalUsage(state, { tokens: 2100, turns: 21 }, "2026-01-01T00:01:02.000Z")).toEqual({
      tokensUsed: 350,
      turnsUsed: 3,
      wallClockMs: 7000,
    });
  });

  it("migrates legacy arrays and drops the old Goal mode flag", () => {
    const session = {
      id: "s",
      sessionModes: { goal: true, team: true },
      autopilot: { running: true, goal: "Live", startedAt: "t2", rounds: 3, activeGoalId: "old_live" },
      activeGoals: [
        {
          id: "old_done",
          condition: "Old",
          status: "met",
          createdAt: "t0",
          createdBy: "user",
          resolvedAt: "t1",
          evidence: "ok",
        },
        { id: "old_live", condition: "Live", status: "active", createdAt: "t2", createdBy: "user" },
      ],
      usage: { inputTokens: 50, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0, turns: 2 },
    } as unknown as SessionState;

    expect(migrateLegacyGoalState(session, "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(session.goal?.current).toMatchObject({ id: "old_live", objective: "Live", status: "active" });
    expect(session.goal?.history[0]).toMatchObject({ id: "old_done", status: "complete", evidence: "ok" });
    expect(session.goal?.run).toMatchObject({ tokenBaseline: 70, turnBaseline: 2 });
    expect(session.activeGoals).toBeUndefined();
    expect(session.autopilot).toBeUndefined();
    expect(session.sessionModes).toEqual({ team: true });
  });

  it("starts from a stable empty state", () => {
    expect(emptyGoalState()).toEqual({ current: null, history: [], run: null, revision: 0 });
  });
});
