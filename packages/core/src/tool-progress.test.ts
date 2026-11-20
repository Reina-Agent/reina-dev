import type { ToolCallRecord } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { toolResultFingerprint } from "./tool-progress.js";

describe("toolResultFingerprint", () => {
  it("compares command results while ignoring fresh output artifact paths", () => {
    const first = result("tests passed\n...[full output saved to .reina/tool-output/tool_1.txt]");
    const second = result("tests passed\n...[full output saved to .reina\\tool-output\\tool_2.txt]");
    expect(toolResultFingerprint(first)).toBe(toolResultFingerprint(second));
    expect(toolResultFingerprint(first)).not.toBe(toolResultFingerprint(result("new test result")));
  });

  it.each(["requested", "auto", "timed"])("ignores task IDs and timings in %s background receipts", (background) => {
    const receipt = (taskId: string, elapsedMs: number) => result(JSON.stringify({ taskId, elapsedMs, status: "running", background }));
    expect(toolResultFingerprint(receipt("shell_1", 1000))).toBe(toolResultFingerprint(receipt("shell_2", 2000)));
    expect(toolResultFingerprint(receipt("shell_1", 1000))).toBeTruthy();
  });

  it.each(["1", "undefined"])("does not count shell exit code %s as successful output", (exitCode) => {
    expect(toolResultFingerprint(result(`<exit_code>${exitCode}</exit_code>\ncommand failed`))).toBeUndefined();
  });

  it("preserves ordinary JSON results and malformed JSON output", () => {
    expect(toolResultFingerprint(result('{"completed": 1}'))).not.toBe(toolResultFingerprint(result('{"completed": 2}')));
    expect(toolResultFingerprint(result("{not json"))).toBeTruthy();
  });

  it("ignores failed and empty observations", () => {
    expect(toolResultFingerprint({ ...result("new output"), status: "failed" })).toBeUndefined();
    expect(toolResultFingerprint(result(" \n"))).toBeUndefined();
  });
});

function result(output: string): ToolCallRecord {
  return { id: "call", name: "run_shell", input: { command: "npm test" }, output, permission: "execute", summary: "test", status: "completed", createdAt: "2026-09-07T00:00:00.000Z" };
}
