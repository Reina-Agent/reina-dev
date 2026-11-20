import type { RolloutItem, SessionState } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { TodosController, parsePlanSteps } from "./todos.js";

/** Minimal session slice the TodosController actually reads/writes. Cast to
 * SessionState — the controller only touches todos / toolCalls /
 * lastWriteTodosToolCallIndex, so a full session isn't needed here. */
function stubHost(overrides: Partial<SessionState> = {}) {
  const recorded: RolloutItem[] = [];
  const session = {
    todos: [],
    toolCalls: [],
    ...overrides,
  } as unknown as SessionState;
  const host = {
    session,
    record: (item: RolloutItem) => recorded.push(item),
  };
  return { host, session, recorded };
}

describe("parsePlanSteps", () => {
  it("extracts numbered steps and ignores prose around them", () => {
    const plan = [
      "Here is my plan:",
      "",
      "1. Read the config loader",
      "2. Add the new flag",
      "3) Wire it into the UI",
      "",
      "That should do it.",
    ].join("\n");
    expect(parsePlanSteps(plan)).toEqual([
      "Read the config loader",
      "Add the new flag",
      "Wire it into the UI",
    ]);
  });

  it("prefers numbered over bullets when both are present at top level", () => {
    const plan = ["1. First", "2. Second", "", "- a stray bullet"].join("\n");
    expect(parsePlanSteps(plan)).toEqual(["First", "Second"]);
  });

  it("falls back to checklist items, then plain bullets", () => {
    expect(parsePlanSteps("- [ ] alpha\n- [x] beta")).toEqual(["alpha", "beta"]);
    expect(parsePlanSteps("- alpha\n* beta\n+ gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("ignores nested sub-points, headings, and fenced code", () => {
    const plan = [
      "## Plan",
      "1. Top step",
      "    - nested detail that should not become a todo",
      "```",
      "1. this is code, not a step",
      "```",
      "2. Second step",
    ].join("\n");
    expect(parsePlanSteps(plan)).toEqual(["Top step", "Second step"]);
  });

  it("strips bold/inline-code markers from step text", () => {
    expect(parsePlanSteps("1. **Build** the `agent-host` bundle")).toEqual([
      "Build the agent-host bundle",
    ]);
  });

  it("returns [] for prose with no list structure", () => {
    expect(parsePlanSteps("Just refactor the thing and ship it.")).toEqual([]);
  });

  it("caps the number of seeded steps", () => {
    const plan = Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n");
    expect(parsePlanSteps(plan)).toHaveLength(20);
  });
});

describe("TodosController.seedFromPlan", () => {
  it("seeds pending todos from the plan and records a rollout event", () => {
    const { host, session, recorded } = stubHost({ toolCalls: [{} as never, {} as never] });
    const controller = new TodosController(host);

    const seeded = controller.seedFromPlan("1. Read loader\n2. Add flag");

    expect(seeded).toBe(2);
    expect(session.todos).toEqual([
      { id: "todo_1", content: "Read loader", activeForm: "Read loader", status: "pending" },
      { id: "todo_2", content: "Add flag", activeForm: "Add flag", status: "pending" },
    ]);
    // Bookkeeping mirrors write(): marks the list "just touched" so the
    // "haven't used recently" nudge stays quiet.
    expect(session.lastWriteTodosToolCallIndex).toBe(2);
    expect(recorded).toEqual([{ type: "todos", todos: session.todos }]);
  });

  it("seeds nothing when the plan is prose-only", () => {
    const { host, session, recorded } = stubHost();
    const seeded = new TodosController(host).seedFromPlan("Refactor and ship.");
    expect(seeded).toBe(0);
    expect(session.todos).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("never clobbers an existing non-empty todo list", () => {
    const existing = [{ id: "todo_1", content: "in progress", activeForm: "doing it", status: "in_progress" as const }];
    const { host, session, recorded } = stubHost({ todos: existing });
    const seeded = new TodosController(host).seedFromPlan("1. New step");
    expect(seeded).toBe(0);
    expect(session.todos).toBe(existing);
    expect(recorded).toEqual([]);
  });
});
