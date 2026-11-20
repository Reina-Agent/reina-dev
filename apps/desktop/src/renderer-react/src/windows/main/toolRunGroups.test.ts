import { describe, expect, it } from "vitest";
import type { TimelinePart, TimelineToolPart, ToolCallStatus } from "./protocol";
import { groupToolRuns, summarizeToolRun } from "./toolRunGroups";

function tool(
  id: string,
  name: string,
  status: ToolCallStatus = "completed",
  count = 1,
): TimelineToolPart {
  return {
    id,
    type: "tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    name,
    status,
    title: name,
    summary: "",
    count,
    callIds: [id],
    detail: [],
  };
}

function answer(id: string, content: string): TimelinePart {
  return { id, type: "text", role: "assistant", createdAt: "", content };
}

function thought(id: string): TimelinePart {
  return { id, type: "text", role: "assistant", createdAt: "", content: "", reasoning: "hmm" };
}

describe("groupToolRuns", () => {
  it("batches 2+ consecutive settled tools into one run", () => {
    const items = groupToolRuns([tool("a", "run_shell"), tool("b", "read_file")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].parts.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("leaves a lone tool as a plain part", () => {
    const items = groupToolRuns([tool("a", "run_shell")]);
    expect(items).toEqual([{ kind: "part", part: tool("a", "run_shell") }]);
  });

  it("folds a running tool into the run; only pending_approval stays loose", () => {
    const running = tool("c", "run_shell", "running");
    const pending = tool("d", "run_shell", "pending_approval");
    const items = groupToolRuns([tool("a", "run_shell"), tool("b", "grep"), running, pending]);
    expect(items.map((i) => i.kind)).toEqual(["run", "part"]);
    expect(items[0].kind === "run" && items[0].parts.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(items[1]).toEqual({ kind: "part", part: pending });
  });

  it("assistant text with content breaks a run; reasoning-only rounds fold in", () => {
    const items = groupToolRuns([
      tool("a", "run_shell"),
      thought("t1"),
      tool("b", "grep"),
      answer("x", "found it"),
      tool("c", "read_file"),
      tool("d", "read_file"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["run", "part", "run"]);
    expect(items[0].kind === "run" && items[0].parts.map((p) => p.id)).toEqual(["a", "t1", "b"]);
    expect(items[1]).toEqual({ kind: "part", part: answer("x", "found it") });
  });

  it("does not turn a tool-less reasoning stretch into a run", () => {
    const items = groupToolRuns([thought("t1"), thought("t2")]);
    expect(items.map((i) => i.kind)).toEqual(["part", "part"]);
  });

  it("turns adjacent subagent dispatches into one chips row, running included", () => {
    const items = groupToolRuns([
      tool("a", "task"),
      tool("b", "start_async_task"),
      tool("c", "task", "running"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("chips");
    expect(items[0].kind === "chips" && items[0].parts.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("renders even a single dispatch as a chips row, never inside a run", () => {
    const items = groupToolRuns([tool("a", "run_shell"), tool("b", "task"), tool("c", "grep")]);
    expect(items.map((i) => i.kind)).toEqual(["part", "chips", "part"]);
  });

  it("keeps a pending_approval dispatch as a loose part (approval card)", () => {
    const items = groupToolRuns([tool("a", "task", "pending_approval"), tool("b", "task")]);
    expect(items.map((i) => i.kind)).toEqual(["part", "chips"]);
    expect(items[0]).toEqual({ kind: "part", part: tool("a", "task", "pending_approval") });
  });

  it("breaks a chips row on visible text but not on adjacency inside the row", () => {
    const items = groupToolRuns([
      tool("a", "task"),
      answer("x", "dispatched"),
      tool("b", "task"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["chips", "part", "chips"]);
  });
});

describe("summarizeToolRun", () => {
  it("builds the category phrase with counts and capitalizes the head", () => {
    const { label, count } = summarizeToolRun([
      tool("a", "run_shell"),
      tool("b", "run_shell"),
      tool("d", "read_file"),
      tool("e", "grep"),
      tool("f", "web_fetch"),
    ]);
    expect(label).toBe("Ran 2 commands, read a file, used 2 tools");
    expect(count).toBe(5);
  });

  it("counts host-folded read_file parts by their fold size", () => {
    const { label, count } = summarizeToolRun([tool("a", "read_file", "completed", 3)]);
    expect(label).toBe("Read 3 files");
    expect(count).toBe(3);
  });

  it("flags a failed child and ignores reasoning parts", () => {
    const { failed, count } = summarizeToolRun([
      tool("a", "run_shell", "failed"),
      thought("t1"),
      tool("b", "grep"),
    ]);
    expect(failed).toBe(true);
    expect(count).toBe(2);
  });

  it("flags a running child for the live header dot", () => {
    const settled = summarizeToolRun([tool("a", "run_shell"), tool("b", "grep")]);
    expect(settled.running).toBe(false);
    const live = summarizeToolRun([tool("a", "run_shell"), tool("b", "run_shell", "running")]);
    expect(live.running).toBe(true);
  });
});
