import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallRecord, ToolObservation } from "@reina/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  count: 0,
  turns: [] as Array<{
    content?: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async () => h.turns[h.count++] ?? { content: "done", toolCalls: [] },
  };
});

import { AgentEngine, type CreateSessionInput } from "./engine.js";

let cwd: string;
let oldConfigHome: string | undefined;
let engine: AgentEngine | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-loop-guards-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  h.count = 0;
  h.turns = [];
});

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
  vi.restoreAllMocks();
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

function toolTurn(id: string, name: string, input: Record<string, unknown>) {
  return { toolCalls: [{ id, name, input }] };
}

async function createEngine(
  execute: (record: ToolCallRecord) => Promise<ToolObservation>,
  toolLoop: CreateSessionInput["toolLoop"] = {},
) {
  engine = await AgentEngine.create({
    cwd,
    agent: "default",
    permissionMode: "bypass",
    autoTitle: { enabled: false },
    toolLoop: {
      stagnationLimit: 5,
      repeatedActionLimit: 40,
      consecutiveErrorLimit: 3,
      ...toolLoop,
    },
  });
  const internals = engine as unknown as {
    executeToolOrEngine(record: ToolCallRecord): Promise<ToolObservation>;
  };
  const dispatch = vi.spyOn(internals, "executeToolOrEngine").mockImplementation(execute);
  return { engine, dispatch };
}

function lastAssistant(engine: AgentEngine) {
  return engine.session.messages.filter((message) => message.role === "assistant").at(-1)?.content;
}

describe("tool-loop guards through AgentEngine", () => {
  it("allows the same shell verification after each successful edit", async () => {
    h.turns = Array.from({ length: 12 }, (_, index) => [
      toolTurn(`shell_${index}`, "run_shell", { command: "npm test" }),
      toolTurn(`edit_${index}`, "edit_file", { path: "target.txt", newText: `revision ${index}` }),
    ]).flat();
    h.turns.push(toolTurn("shell_final", "run_shell", { command: "npm test" }));
    h.turns.push({ content: "verified all edits", toolCalls: [] });
    const { engine, dispatch } = await createEngine(async (record) => {
      if (record.name === "edit_file") {
        await writeFile(path.join(cwd, "target.txt"), (record.input as { newText: string }).newText);
      }
      return { callId: record.id, name: record.name, output: record.name === "run_shell" ? "tests passed" : "file updated" };
    }, { repeatedActionLimit: 10 });

    await engine.runTurn("update the file and verify each edit");

    expect(dispatch).toHaveBeenCalledTimes(25);
    expect(engine.session.toolCalls.every((record) => record.status === "completed")).toBe(true);
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("revision 11");
    expect(lastAssistant(engine)).toBe("verified all edits");
    expect(engine.session.trace.filter((event) => event.type === "loop.limit" || event.type === "loop.repair")).toEqual([]);
  });

  it("continues identical calls while each successful result provides new output", async () => {
    h.turns = Array.from({ length: 7 }, (_, index) => toolTurn(`poll_${index}`, "run_shell", { command: "read-progress" }));
    h.turns.push({ content: "progress completed", toolCalls: [] });
    let completed = 0;
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      output: `completed step ${++completed}`,
    }), { stagnationLimit: 3, repeatedActionLimit: 4 });

    await engine.runTurn("read progress until complete");

    expect(dispatch).toHaveBeenCalledTimes(7);
    expect(engine.session.toolCalls.every((record) => record.status === "completed")).toBe(true);
    expect(lastAssistant(engine)).toBe("progress completed");
    expect(engine.session.trace.filter((event) => event.type === "loop.limit" || event.type === "loop.repair")).toEqual([]);
  });

  it("counts storm rejections as errors and stops an unchanged loop after only one repair", async () => {
    h.turns = Array.from({ length: 18 }, (_, index) => toolTurn(`repeat_${index}`, "run_shell", { command: "unchanged-command" }));
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      output: "unchanged result",
    }));

    await engine.runTurn("inspect the result");

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(engine.session.toolCalls.some((record) => record.status === "rejected" && record.error?.includes("repeat-loop guard"))).toBe(true);
    const repairs = engine.session.trace.filter((event) => event.type === "loop.repair");
    const limits = engine.session.trace.filter((event) => event.type === "loop.limit");
    expect(repairs).toHaveLength(1);
    expect(limits).toHaveLength(1);
    expect(["consecutive_errors", "repeated_action"]).toContain(repairs[0]!.data.reason);
    expect(["consecutive_errors", "repeated_action"]).toContain(limits[0]!.data.reason);
    expect(h.count).toBeLessThan(18);
    expect(engine.session.messages.at(-1)?.content).toContain("repeat-loop guard");
    expect(engine.session.messages.at(-1)?.content).not.toContain("reason=no_progress");
  });

  it("gives a changed recovery action room to fail once and then succeed", async () => {
    h.turns = [
      toolTurn("old_1", "run_shell", { command: "broken-first-command" }),
      toolTurn("old_2", "run_shell", { command: "broken-second-command" }),
      toolTurn("recovery_1", "run_shell", { command: "new-recovery-command" }),
      toolTurn("recovery_2", "run_shell", { command: "new-recovery-command" }),
      { content: "recovery verified", toolCalls: [] },
    ];
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      ...(record.id === "recovery_2" ? { output: "recovered" } : { error: "temporary failure" }),
    }), { stagnationLimit: 2, consecutiveErrorLimit: 2 });

    await engine.runTurn("recover from the failed approach");

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(lastAssistant(engine)).toBe("recovery verified");
    expect(engine.session.trace.filter((event) => event.type === "loop.repair")).toHaveLength(1);
    expect(engine.session.trace.filter((event) => event.type === "loop.limit")).toEqual([]);
    expect(engine.session.toolCalls.at(-1)).toMatchObject({ id: "recovery_2", status: "completed", output: "recovered" });
  });

  it.each(["requested", "timed"])("stops duplicate background shell launches with changing task IDs (%s)", async (background) => {
    const input = { command: "long-running-command", ...(background === "requested" ? { background: true } : { timeoutMs: 100 }) };
    h.turns = Array.from({ length: 18 }, (_, index) => toolTurn(`background_${index}`, "run_shell", input));
    let launched = 0;
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      output: JSON.stringify({ taskId: `shell_${++launched}`, status: "running", background, elapsedMs: launched }),
    }));

    await engine.runTurn("start the long-running command");

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(engine.session.toolCalls.some((record) => record.status === "rejected" && record.error?.includes("repeat-loop guard"))).toBe(true);
    expect(engine.session.trace.filter((event) => event.type === "loop.repair")).toHaveLength(1);
    expect(engine.session.trace.filter((event) => event.type === "loop.limit")).toHaveLength(1);
    expect(h.count).toBeLessThan(18);
  });

  it("stops unchanged shell failures whose output-file paths change on each attempt", async () => {
    h.turns = Array.from({ length: 18 }, (_, index) => toolTurn(`failed_shell_${index}`, "run_shell", { command: "failing-command" }));
    let attempts = 0;
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      output: `<exit_code>1</exit_code>\nTest assertion failed\n...[full output saved to .reina/tool-output/tool_${++attempts}.txt]`,
    }));

    await engine.runTurn("run the verification command");

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(engine.session.toolCalls.some((record) => record.status === "rejected" && record.error?.includes("repeat-loop guard"))).toBe(true);
    expect(engine.session.trace.filter((event) => event.type === "loop.repair")).toHaveLength(1);
    expect(engine.session.trace.filter((event) => event.type === "loop.limit")).toHaveLength(1);
    expect(h.count).toBeLessThan(18);
  });

  it("allows verification after an identical call recovers from failure and then provides new results", async () => {
    h.turns = [
      toolTurn("first_failure", "run_shell", { command: "recovering-command" }),
      toolTurn("first_success", "run_shell", { command: "recovering-command" }),
      toolTurn("next_success", "run_shell", { command: "recovering-command" }),
      { content: "successful recovery verified", toolCalls: [] },
    ];
    const { engine, dispatch } = await createEngine(async (record) => ({
      callId: record.id,
      name: record.name,
      ...(record.id === "first_failure" ? { error: "temporary failure" } : { output: `result ${record.id}` }),
    }));

    await engine.runTurn("verify the recovering command");

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(engine.session.toolCalls.map((record) => record.status)).toEqual(["failed", "completed", "completed"]);
    expect(lastAssistant(engine)).toBe("successful recovery verified");
    expect(engine.session.trace.filter((event) => event.type === "loop.limit" || event.type === "loop.repair")).toEqual([]);
  });
});
