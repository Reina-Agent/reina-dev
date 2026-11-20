import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** kimi-code parity for turn-boundary stops in a normal (non-goal) session:
 * the engine does NOT second-guess a model stop — no pause_turn auto-resume
 * and no "unfinished todos" continuation nudge (kimi-code deliberately keeps
 * implicit continuation out of normal turns; heavy continuation lives in goal
 * mode). The one structural guard it DOES apply: tool calls from a paused
 * response are never executed, because a server-side pause can cut streamed
 * argument JSON mid-generation — they are rejected with a re-issue
 * observation and the loop continues, matching kimi-code's turn-step handling
 * (same rule as `truncated`, pi #6285). Provider is mocked (same seam as
 * engine.retry.test.ts). */

const h = vi.hoisted(() => ({
  count: 0,
  turns: [] as Array<{
    content?: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason?: string;
  }>,
  requests: [] as Array<{ observations: Array<{ output?: string; error?: string }> }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async (
      _config: unknown,
      request: { observations: Array<{ output?: string; error?: string }> },
    ) => {
      h.requests.push(request);
      const i = h.count++;
      return h.turns[Math.min(i, h.turns.length - 1)] ?? { content: "done", toolCalls: [] };
    },
  };
});

import { AgentEngine } from "./engine.js";

let cwd: string;
let oldConfigHome: string | undefined;
let engines: AgentEngine[] = [];

async function createEngine(input: Parameters<typeof AgentEngine.create>[0]): Promise<AgentEngine> {
  const engine = await AgentEngine.create(input);
  engines.push(engine);
  return engine;
}

beforeEach(async () => {
  engines = [];
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-turn-stop-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello from readme", "utf8");
  h.count = 0;
  h.turns = [];
  h.requests = [];
});

afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

describe("kimi-code parity: normal sessions never auto-continue a model stop", () => {
  it("ends a text-only pause_turn without an automatic resume", async () => {
    h.turns = [
      { content: "partial answer", toolCalls: [], stopReason: "pause_turn" },
      { content: "unexpected extra", toolCalls: [], stopReason: "end_turn" },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    expect(h.count).toBe(1); // the partial answer stands; the user decides to continue
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(false);
  });

  it("does not nudge an end_turn even when todos are unfinished", async () => {
    h.turns = [
      { content: "summary so far", toolCalls: [], stopReason: "end_turn" },
      { content: "unexpected extra", toolCalls: [], stopReason: "end_turn" },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    engine.session.todos.push({ id: "t1", content: "finish the refactor", activeForm: "finishing", status: "pending" });
    await engine.runTurn("hi");
    expect(h.count).toBe(1);
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(false);
  });

  it("rejects tool calls from a pause_turn response instead of executing them", async () => {
    h.turns = [
      {
        content: "",
        toolCalls: [{ id: "call_paused", name: "read_file", input: { path: "README.md" } }],
        stopReason: "pause_turn",
      },
      { content: "done", toolCalls: [], stopReason: "end_turn" },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("read the readme");

    // The call was rejected, not executed — a server-side pause may have cut
    // the streamed arguments mid-generation.
    const record = engine.session.toolCalls.find((r) => r.id === "call_paused");
    expect(record?.status).toBe("rejected");
    expect(record?.error).toContain("pause_turn");

    // The model saw a re-issue observation — never the file content — and the
    // loop continued to a second model round.
    expect(h.count).toBe(2);
    const observation = h.requests[1]!.observations.find((o) => o.error || o.output);
    expect(observation?.error).toContain("Re-issue");
    expect(observation?.output ?? "").not.toContain("hello from readme");
  });
});
