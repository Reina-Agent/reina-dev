import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@reina/protocol";
import { ToolLoopBudget } from "./loop-budget.js";

describe("ToolLoopBudget", () => {
  it("updates limits without resetting consumed turns or error history", () => {
    const budget = new ToolLoopBudget({ baseSteps: 2, hardMaxSteps: 8, consecutiveErrorLimit: 4 });
    const failed = { ...record("read_file", { path: "missing" }), status: "failed" as const };
    expect(budget.recordTurn([failed])).toBeUndefined();
    budget.updateConfig({ baseSteps: 2, hardMaxSteps: 2, consecutiveErrorLimit: 2 });
    expect(budget.turnCount).toBe(1);
    expect(budget.recordTurn([failed])?.reason).toBe("consecutive_errors");
    expect(budget.canContinue()).toBe(false);
    expect(budget.exhaustedStop().hardMaxSteps).toBe(2);
  });

  it("extends the current budget while tool turns make progress", () => {
    const budget = new ToolLoopBudget({ baseSteps: 2, hardMaxSteps: 5 });

    expect(budget.canContinue()).toBe(true);
    expect(budget.recordTurn([record("read_file", { path: "a.ts" }, "a")])).toBeUndefined();
    expect(budget.recordTurn([record("read_file", { path: "b.ts" }, "b")])).toBeUndefined();
    expect(budget.canContinue()).toBe(true);
  });

  it("stops repeated actions that do not make progress", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, hardMaxSteps: 10, repeatedActionLimit: 3 });

    expect(budget.recordTurn([record("read_file", { path: "same.ts" }, "same")])).toBeUndefined();
    expect(budget.recordTurn([record("read_file", { path: "same.ts" }, "same")])).toBeUndefined();
    expect(budget.recordTurn([record("read_file", { path: "same.ts" }, "same")])?.reason).toBe("repeated_action");
  });

  it.each<ToolCallRecord["name"]>(["run_shell", "read_file"])("counts new successful %s results as progress until the hard turn limit", (name) => {
    const budget = new ToolLoopBudget({ baseSteps: 2, hardMaxSteps: 8, stagnationLimit: 2, repeatedActionLimit: 3 });
    for (let i = 0; i < 8; i++) {
      expect(budget.canContinue()).toBe(true);
      expect(budget.recordTurn([record(name, { command: "check" }, `result ${i}`)])).toBeUndefined();
    }
    expect(budget.canContinue()).toBe(false);
    expect(budget.exhaustedStop().reason).toBe("hard_max_steps");
  });

  it("stops unchanged shell results after the stagnation limit", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 2 });
    const result = record("run_shell", { command: "check" }, "unchanged");
    expect(budget.recordTurn([result])).toBeUndefined();
    expect(budget.recordTurn([result])).toBeUndefined();
    expect(budget.recordTurn([result])?.reason).toBe("no_progress");
  });

  it.each<ToolCallRecord["name"]>(["run_shell", "read_file"])("allows %s verification after each successful edit", (name) => {
    const budget = new ToolLoopBudget({ baseSteps: 30, hardMaxSteps: 30, stagnationLimit: 1, repeatedActionLimit: 3 });
    const check = { ...record(name, { path: "source.ts" }, "same result"), permission: name === "run_shell" ? "execute" as const : "read" as const };
    for (let i = 0; i < 12; i++) {
      const edit = { ...record("edit_file", { path: "source.ts", replacement: i }), permission: "write" as const };
      expect(budget.recordTurn([edit])).toBeUndefined();
      expect(budget.recordTurn([check])).toBeUndefined();
    }
  });

  it("invalidates validation results in record order within a batch", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 1 });
    const check = record("run_shell", { command: "check" }, "same");
    const edit = { ...record("edit_file", { path: "source.ts" }), permission: "write" as const };
    expect(budget.recordTurn([check])).toBeUndefined();
    expect(budget.recordTurn([check, edit])).toBeUndefined();
    expect(budget.recordTurn([check])).toBeUndefined();
    expect(budget.recordTurn([edit, check])).toBeUndefined();
    expect(budget.recordTurn([check])?.reason).toBe("no_progress");
  });

  it("does not invalidate validation history after a failed edit", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 3, repeatedActionLimit: 2 });
    const check = record("run_shell", { command: "check" }, "same");
    const edit = { ...record("edit_file", { path: "source.ts" }), permission: "write" as const, status: "failed" as const };
    expect(budget.recordTurn([check])).toBeUndefined();
    expect(budget.recordTurn([edit])).toBeUndefined();
    expect(budget.recordTurn([check])?.reason).toBe("repeated_action");
  });

  it("preserves write action repetition history across successful edits", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, repeatedActionLimit: 3 });
    const edit = { ...record("edit_file", { path: "source.ts" }), permission: "write" as const };
    expect(budget.recordTurn([edit])).toBeUndefined();
    expect(budget.recordTurn([edit])).toBeUndefined();
    expect(budget.recordTurn([{ ...edit, input: { path: "other.ts" } }])).toBeUndefined();
    expect(budget.recordTurn([{ ...edit, status: "failed" }])?.reason).toBe("repeated_action");
  });

  it("does not count alternating previously seen results as new progress", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 2 });
    for (const output of ["a", "b", "a"]) {
      expect(budget.recordTurn([record("run_shell", { command: "check" }, output)])).toBeUndefined();
    }
    expect(budget.recordTurn([record("run_shell", { command: "check" }, "b")])?.reason).toBe("no_progress");
  });

  it("remembers every result in a turn even when the first record makes progress", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 1 });
    const first = record("run_shell", { command: "check a" }, "a");
    const second = record("run_shell", { command: "check b" }, "b");
    expect(budget.recordTurn([first, second])).toBeUndefined();
    expect(budget.recordTurn([second])?.reason).toBe("no_progress");
  });

  it.each<ToolCallRecord["status"]>(["failed", "rejected"])("does not treat changing %s results as progress", (status) => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 2 });
    expect(budget.recordTurn([{ ...record("run_shell", { command: "check" }, "error a"), status }])).toBeUndefined();
    expect(budget.recordTurn([{ ...record("run_shell", { command: "check" }, "error b"), status }])?.reason).toBe("no_progress");
  });

  it("resets stagnation and consecutive errors to allow a different recovery action", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 2, consecutiveErrorLimit: 2 });
    const failed = { ...record("run_shell", { command: "old" }, "error"), status: "failed" as const };
    expect(budget.recordTurn([failed])).toBeUndefined();
    expect(budget.recordTurn([failed])?.reason).toBe("consecutive_errors");
    const limits = budget.exhaustedStop();

    budget.resetStagnation();

    expect(budget.turnCount).toBe(2);
    expect(budget.exhaustedStop()).toEqual(limits);
    expect(budget.recordTurn([{ ...failed, input: { command: "new" } }])).toBeUndefined();
    expect(budget.recordTurn([record("run_shell", { command: "new" }, "success")])).toBeUndefined();
  });

  it("preserves repeated action and result history when resetting stagnation", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 1, repeatedActionLimit: 3 });
    const result = record("run_shell", { command: "check" }, "same");
    expect(budget.recordTurn([result])).toBeUndefined();
    expect(budget.recordTurn([result])?.reason).toBe("no_progress");

    budget.resetStagnation();

    expect(budget.recordTurn([result])?.reason).toBe("repeated_action");
  });

  it("does not renew an exhausted budget when resetting stagnation", () => {
    const budget = new ToolLoopBudget({ baseSteps: 2, hardMaxSteps: 2 });
    expect(budget.recordTurn([])).toBeUndefined();
    expect(budget.recordTurn([])).toBeUndefined();
    const limits = budget.exhaustedStop();

    budget.resetStagnation();

    expect(budget.turnCount).toBe(2);
    expect(budget.canContinue()).toBe(false);
    expect(budget.exhaustedStop()).toEqual(limits);
  });

  it.each<[ToolCallRecord["name"], unknown]>([
    ["task_output", { taskId: "t1", block: true }],
    ["monitor", { taskId: "t1", pattern: "ready" }],
    ["wait_async_tasks", { taskIds: ["t1"] }],
    ["wait_async_tasks", { taskIds: ["t1"], timeoutMs: 0 }],
  ])("allows successful %s waits until the hard turn limit", (name, input) => {
    const budget = new ToolLoopBudget({
      baseSteps: 2,
      hardMaxSteps: 8,
      stagnationLimit: 2,
      repeatedActionLimit: 3,
    });
    // A timeout can legitimately return no new output on every wait.
    for (let i = 0; i < 8; i++) {
      expect(budget.canContinue()).toBe(true);
      expect(budget.recordTurn([record(name, input, "")])).toBeUndefined();
    }
    expect(budget.canContinue()).toBe(false);
    expect(budget.exhaustedStop().reason).toBe("hard_max_steps");
  });

  it.each<ToolCallRecord["name"]>(["task_output", "monitor", "wait_async_tasks"])("still stops consecutive %s failures", (name) => {
    const budget = new ToolLoopBudget({ baseSteps: 10, consecutiveErrorLimit: 3 });
    const failed = { ...record(name, { taskId: "t1", block: true }), status: "failed" as const, error: "unknown task" };
    expect(budget.recordTurn([failed])).toBeUndefined();
    expect(budget.recordTurn([failed])).toBeUndefined();
    expect(budget.recordTurn([failed])?.reason).toBe("consecutive_errors");
  });

  it("still stops repeated rejected waits", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, repeatedActionLimit: 3 });
    const rejected = { ...record("monitor", { taskId: "t1" }), status: "rejected" as const };
    expect(budget.recordTurn([rejected])).toBeUndefined();
    expect(budget.recordTurn([rejected])).toBeUndefined();
    expect(budget.recordTurn([rejected])?.reason).toBe("repeated_action");
  });

  it("does not treat immediate monitor snapshots as waiting", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, stagnationLimit: 2, repeatedActionLimit: 10 });
    const snapshot = record("monitor", { timeoutMs: 0 }, "unchanged");
    expect(budget.recordTurn([snapshot])).toBeUndefined();
    expect(budget.recordTurn([snapshot])).toBeUndefined();
    expect(budget.recordTurn([snapshot])?.reason).toBe("no_progress");
  });

  it("preserves successful non-blocking task_output polling", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, repeatedActionLimit: 3 });
    for (let i = 0; i < 5; i++) {
      expect(budget.recordTurn([record("task_output", { taskId: "t1", block: false }, "running")])).toBeUndefined();
    }
  });

  it("does not treat repeated stdin writes as waiting", () => {
    const budget = new ToolLoopBudget({ baseSteps: 10, repeatedActionLimit: 3 });
    const write = { ...record("write_stdin", { taskId: "t1", chars: "run\n" }, "sent"), permission: "execute" as const };
    expect(budget.recordTurn([write])).toBeUndefined();
    expect(budget.recordTurn([write])).toBeUndefined();
    expect(budget.recordTurn([write])?.reason).toBe("repeated_action");
  });
});

function record(name: ToolCallRecord["name"], input: unknown, output?: string): ToolCallRecord {
  return {
    id: "call",
    name,
    input,
    summary: name,
    permission: "read",
    status: "completed",
    output,
    createdAt: new Date().toISOString(),
  };
}
