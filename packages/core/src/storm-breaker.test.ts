import { describe, expect, it } from "vitest";
import { StormBreaker } from "./storm-breaker.js";
import type { ToolCallRecord } from "@reina/protocol";

const RO = false; // read-only call (read / network)
const MUT = true; // mutating call (write / execute / state)

describe("StormBreaker", () => {
  it("passes the first two identical calls and suppresses the third", () => {
    const sb = new StormBreaker();
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
    const third = sb.inspect("read_file", { path: "/x" }, RO);
    expect(third.suppress).toBe(true);
    expect(third.reason).toMatch(/repeat-loop guard/);
  });

  it("treats different inputs as distinct (key order independent)", () => {
    const sb = new StormBreaker();
    sb.inspect("read_file", { path: "/a", limit: 10 }, RO);
    sb.inspect("read_file", { limit: 10, path: "/a" }, RO); // same input, reordered keys
    const third = sb.inspect("read_file", { path: "/a", limit: 10 }, RO);
    expect(third.suppress).toBe(true);
  });

  it("treats different tools as distinct", () => {
    const sb = new StormBreaker();
    sb.inspect("read_file", { path: "/x" }, RO);
    sb.inspect("write_file", { path: "/x", content: "hi" }, MUT);
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
  });

  it("clears read-only history after a mutating call succeeds (edit-then-verify-read is legitimate)", () => {
    const sb = new StormBreaker();
    sb.inspect("read_file", { path: "/x" }, RO); // read 1
    sb.inspect("read_file", { path: "/x" }, RO); // read 2
    const edit = { path: "/x", oldText: "a", newText: "b" };
    sb.inspect("edit_file", edit, MUT);
    sb.recordResult(result("edit_file", edit, "edited", "write"));
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false); // fresh window
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(true);
  });

  it("a state-changing call (e.g. write_todos) also clears prior read-only history", () => {
    const sb = new StormBreaker();
    sb.inspect("read_file", { path: "/x" }, RO);
    sb.inspect("read_file", { path: "/x" }, RO);
    // write_todos has permission "state" → caller passes MUT
    sb.inspect("write_todos", { todos: [{ text: "do it", done: false }] }, MUT);
    sb.recordResult(result("write_todos", { todos: [{ text: "do it", done: false }] }, "saved", "state"));
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
  });

  it("still suppresses identical mutating calls (3x same edit is a loop)", () => {
    const sb = new StormBreaker();
    const args = { path: "/x", oldText: "a", newText: "b" };
    expect(sb.inspect("edit_file", args, MUT).suppress).toBe(false);
    expect(sb.inspect("edit_file", args, MUT).suppress).toBe(false);
    expect(sb.inspect("edit_file", args, MUT).suppress).toBe(true);
  });

  it("allows the same shell verification after successful file edits", () => {
    const sb = new StormBreaker();
    const shell = { command: "npm test" };
    for (let i = 0; i < 5; i++) {
      expect(sb.inspect("run_shell", shell, MUT).suppress).toBe(false);
      sb.recordResult(result("run_shell", shell, "1 test failed"));
      const edit = { path: "/x", oldText: String(i), newText: String(i + 1) };
      expect(sb.inspect("edit_file", edit, MUT).suppress).toBe(false);
      sb.recordResult(result("edit_file", edit, "edited", "write"));
    }
  });

  it("does not clear verification history for a failed edit", () => {
    const sb = new StormBreaker();
    const shell = { command: "npm test" };
    for (let i = 0; i < 2; i++) {
      sb.inspect("run_shell", shell, MUT);
      sb.recordResult(result("run_shell", shell, "1 test failed"));
    }
    const edit = { path: "/x", oldText: "missing", newText: "new" };
    sb.inspect("edit_file", edit, MUT);
    sb.recordResult({ ...result("edit_file", edit, "", "write"), status: "failed", error: "not found" });
    expect(sb.inspect("run_shell", shell, MUT).suppress).toBe(true);
  });

  it("allows repeated calls while successful results are new", () => {
    const sb = new StormBreaker();
    const args = { command: "check-status" };
    for (let i = 0; i < 12; i++) {
      expect(sb.inspect("run_shell", args, MUT).suppress).toBe(false);
      sb.recordResult(result("run_shell", args, `completed jobs: ${i}`));
    }
  });

  it.each(["completed", "failed"] as const)("still guards unchanged %s results", (status) => {
    const sb = new StormBreaker();
    const args = { command: "check-status" };
    for (let i = 0; i < 2; i++) {
      expect(sb.inspect("run_shell", args, MUT).suppress).toBe(false);
      sb.recordResult({ ...result("run_shell", args, "unchanged"), status });
    }
    expect(sb.inspect("run_shell", args, MUT).suppress).toBe(true);
  });

  it("does not treat alternating old outputs as new progress", () => {
    const sb = new StormBreaker();
    const args = { command: "check-status" };
    for (const output of ["A", "B", "A"]) {
      expect(sb.inspect("run_shell", args, MUT).suppress).toBe(false);
      sb.recordResult(result("run_shell", args, output));
    }
    expect(sb.inspect("run_shell", args, MUT).suppress).toBe(true);
  });

  it("describes a repeated call within the window without claiming consecutive calls", () => {
    const sb = new StormBreaker();
    const args = { command: "npm test" };
    sb.inspect("run_shell", args, MUT);
    sb.inspect("read_file", { path: "/a" }, RO);
    sb.inspect("run_shell", args, MUT);
    const verdict = sb.inspect("run_shell", args, MUT);
    expect(verdict.suppress).toBe(true);
    expect(verdict.reason).toContain("recent");
    expect(verdict.reason).not.toContain("in a row");
  });

  it("exempts task_output from the storm guard (polling background tasks is fine)", () => {
    const sb = new StormBreaker();
    for (let i = 0; i < 10; i++) {
      expect(sb.inspect("task_output", { taskId: "t1" }, RO).suppress).toBe(false);
    }
  });

  it.each(["monitor", "wait_async_tasks"])("allows repeated blocking %s calls", (name) => {
    const sb = new StormBreaker();
    for (const timeoutMs of [undefined, 30_000]) {
      for (let i = 0; i < 10; i++) {
        expect(sb.inspect(name, { taskId: "t1", timeoutMs }, RO).suppress).toBe(false);
      }
    }
  });

  it("still guards immediate monitor snapshots", () => {
    const sb = new StormBreaker();
    const args = { taskId: "t1", timeoutMs: 0 };
    expect(sb.inspect("monitor", args, RO).suppress).toBe(false);
    expect(sb.inspect("monitor", args, RO).suppress).toBe(false);
    expect(sb.inspect("monitor", args, RO).suppress).toBe(true);
  });

  it("allows task waits whose zero timeout is clamped to a blocking interval", () => {
    const sb = new StormBreaker();
    for (let i = 0; i < 10; i++) {
      expect(sb.inspect("wait_async_tasks", { taskIds: ["t1"], timeoutMs: 0 }, RO).suppress).toBe(false);
    }
  });

  it("does not exempt repeated stdin writes", () => {
    const sb = new StormBreaker();
    const args = { taskId: "t1", chars: "run\n" };
    expect(sb.inspect("write_stdin", args, MUT).suppress).toBe(false);
    expect(sb.inspect("write_stdin", args, MUT).suppress).toBe(false);
    expect(sb.inspect("write_stdin", args, MUT).suppress).toBe(true);
  });

  it("reset() drops history", () => {
    const sb = new StormBreaker();
    sb.inspect("read_file", { path: "/x" }, RO);
    sb.inspect("read_file", { path: "/x" }, RO);
    sb.reset();
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(true);
  });

  it("respects the sliding window size", () => {
    const sb = new StormBreaker(3, 3); // window=3, threshold=3
    sb.inspect("read_file", { path: "/x" }, RO); // recent: [x]
    sb.inspect("read_file", { path: "/y" }, RO); // recent: [x, y]
    sb.inspect("read_file", { path: "/x" }, RO); // recent: [x, y, x] — count(x) = 2
    sb.inspect("read_file", { path: "/y" }, RO); // window evicts oldest x → [y, x, y], count(y) = 2
    // Next x: count(x in current window [y, x, y]) = 1 → not yet at threshold-1 (2)
    expect(sb.inspect("read_file", { path: "/x" }, RO).suppress).toBe(false);
  });
});

function result(
  name: ToolCallRecord["name"], input: unknown, output: string,
  permission: ToolCallRecord["permission"] = "execute",
): ToolCallRecord {
  return { id: "call", name, input, output, permission, summary: name, status: "completed", createdAt: new Date().toISOString() };
}
