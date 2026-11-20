import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A turn that stops at the output-token cap (`truncated`) may carry tool
 * calls whose streamed argument JSON was cut mid-output and then silently
 * "completed" by repairTruncatedJson (tool-compat.ts) — parseable but
 * incomplete. None of those calls are safe to execute: e.g. a write_file
 * whose `content` lost its tail would still write a valid-looking file.
 * The engine must reject every tool call in a truncated turn with an error
 * observation telling the model to re-issue, and keep the loop going.
 * Mirrors pi #6285. Provider is mocked (same seam as engine.retry.test.ts). */

const h = vi.hoisted(() => ({
  count: 0,
  turns: [] as Array<{
    content?: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    truncated?: boolean;
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
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-trunc-"));
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

describe("truncated turns with tool calls", () => {
  it("rejects every tool call from a length-truncated turn instead of executing it", async () => {
    h.turns = [
      {
        content: "",
        toolCalls: [{ id: "call_trunc", name: "read_file", input: { path: "README.md" } }],
        truncated: true,
      },
      { content: "done", toolCalls: [] },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("read the readme");

    // The call was rejected, not executed.
    const record = engine.session.toolCalls.find((r) => r.id === "call_trunc");
    expect(record?.status).toBe("rejected");
    expect(record?.error).toContain("output-token limit");

    // The model saw an error observation asking it to re-issue — never the
    // file content — and the loop continued to a second model round.
    expect(h.count).toBe(2);
    const observation = h.requests[1]!.observations.find((o) => o.error || o.output);
    expect(observation?.error).toContain("Re-issue");
    expect(observation?.output ?? "").not.toContain("hello from readme");
  });

  it("still executes tool calls normally when the turn was not truncated", async () => {
    h.turns = [
      {
        content: "",
        toolCalls: [{ id: "call_ok", name: "read_file", input: { path: "README.md" } }],
      },
      { content: "done", toolCalls: [] },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("read the readme");

    const record = engine.session.toolCalls.find((r) => r.id === "call_ok");
    expect(record?.status).toBe("completed");
    const observation = h.requests[1]!.observations.find((o) => o.output);
    expect(observation?.output).toContain("hello from readme");
  });
});
