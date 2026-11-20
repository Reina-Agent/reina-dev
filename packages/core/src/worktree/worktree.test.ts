import { describe, expect, it } from "vitest";
import { worktreeBranchFor, worktreePathFor } from "./git.js";
import {
  expandHookArg,
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  type WorktreeHooksConfig,
} from "./hooks.js";

describe("git path / branch naming", () => {
  it("derives the standard branch name from the task id", () => {
    expect(worktreeBranchFor("sub_abcd1234")).toBe("reina/sub/sub_abcd1234");
  });

  it("places the worktree dir under <parent>/.reina/worktrees/<id>/", () => {
    const p = worktreePathFor("/repo", "sub_aa");
    // Path separator depends on OS; assert by component.
    expect(p.endsWith(".reina/worktrees/sub_aa") || p.endsWith(".reina\\worktrees\\sub_aa")).toBe(true);
  });
});

describe("hook config accessors", () => {
  it("treats undefined / empty config as 'no hooks'", () => {
    expect(hasWorktreeCreateHook(undefined)).toBe(false);
    expect(hasWorktreeRemoveHook(undefined)).toBe(false);
    expect(hasWorktreeCreateHook({})).toBe(false);
    expect(hasWorktreeRemoveHook({})).toBe(false);
  });

  it("recognizes a configured create hook", () => {
    const cfg: WorktreeHooksConfig = { worktreeCreate: { command: "/usr/bin/foo" } };
    expect(hasWorktreeCreateHook(cfg)).toBe(true);
    expect(hasWorktreeRemoveHook(cfg)).toBe(false);
  });

  it("treats an empty command string as 'no hook'", () => {
    expect(hasWorktreeCreateHook({ worktreeCreate: { command: "" } })).toBe(false);
  });
});

describe("expandHookArg", () => {
  it("substitutes the three documented placeholders", () => {
    expect(
      expandHookArg("--id ${TASK_ID} --base ${BASE_REV} --path ${WORKTREE_PATH}", {
        taskId: "sub_a",
        baseRev: "abc123",
        worktreePath: "/tmp/wt",
      }),
    ).toBe("--id sub_a --base abc123 --path /tmp/wt");
  });

  it("substitutes missing vars with empty strings (no undefined leaking)", () => {
    expect(expandHookArg("[${TASK_ID}]", {})).toBe("[]");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(expandHookArg("${UNKNOWN}-${TASK_ID}", { taskId: "x" })).toBe("${UNKNOWN}-x");
  });

  it("replaces every occurrence (global, not just the first)", () => {
    expect(expandHookArg("${TASK_ID}/${TASK_ID}", { taskId: "x" })).toBe("x/x");
  });
});
