import { describe, expect, it } from "vitest";
import type { ModelStreamEvent, RolloutItem, SessionState, ToolCallRecord } from "@reina/protocol";
import { GoalService } from "./service.js";

function call(name: ToolCallRecord["name"], input: unknown): ToolCallRecord {
  return {
    id: `call_${name}`,
    name,
    input,
    summary: name,
    permission: "state",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("GoalService", () => {
  it("publishes one authoritative snapshot and makes a repeated create a no-op", () => {
    const session = {} as SessionState;
    const rollout: RolloutItem[] = [];
    const stream: ModelStreamEvent[] = [];
    let persisted = 0;
    const goals = new GoalService({
      session,
      record: (item) => rollout.push(item),
      emitStream: (event) => stream.push(event),
      persist: () => {
        persisted += 1;
      },
    });

    const first = goals.create(call("create_goal", { objective: "Ship the fix" }));
    const repeated = goals.create(call("create_goal", { objective: "  ship   THE fix " }));

    expect(first.error).toBeUndefined();
    expect(repeated.output).toContain("no duplicate");
    expect(session.goal?.current?.objective).toBe("Ship the fix");
    expect(rollout).toHaveLength(1);
    expect(rollout[0]).toMatchObject({ type: "goal_event", event: { kind: "create", actor: "model" } });
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({ type: "goal-state-changed", event: { kind: "create" } });
    expect(persisted).toBe(1);
  });
});
