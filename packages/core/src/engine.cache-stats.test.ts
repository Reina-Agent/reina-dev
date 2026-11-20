import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Engine wiring for cache-miss tracking (cache-stats.ts): every model round's
 * provider usage feeds the tracker; counted misses accumulate into
 * `session.usage.cacheWaste` (persisted, snapshot-visible) and push a
 * `cache.miss` trace entry. A compaction boundary resets the tracker — the
 * context legitimately changed, so the next round's prompt is new content,
 * not re-billed content. Provider mocked (same seam as engine.retry.test.ts). */

const h = vi.hoisted(() => ({
  count: 0,
  turns: [] as Array<{
    content: string;
    toolCalls: never[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
    };
  }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async () => {
      const i = h.count++;
      return h.turns[Math.min(i, h.turns.length - 1)] ?? { content: "ok", toolCalls: [] };
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
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-cachestats-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  h.count = 0;
  h.turns = [];
});

afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

const coldWrite = {
  content: "first",
  toolCalls: [] as never[],
  usage: { inputTokens: 20_000, outputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 20_000 },
};

describe("engine cache-miss tracking", () => {
  it("accumulates cacheWaste and traces cache.miss when a round re-bills the previous prompt", async () => {
    h.turns = [
      coldWrite,
      {
        content: "second",
        toolCalls: [],
        // Full re-bill: nothing read from cache although 20k was cached last round.
        usage: { inputTokens: 21_000, outputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 21_000 },
      },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    await engine.runTurn("again");

    expect(engine.session.usage?.cacheWaste).toEqual({
      missedTokens: 20_000,
      missCount: 1,
      method: "reusable-prefix-v2",
    });
    // Trace payload uses `missed`, not `missedTokens` — the trace redactor
    // blanks any key matching /token/i.
    const trace = engine.session.trace.find((e) => e.type === "cache.miss");
    expect(trace?.data.missed).toBe(20_000);
  });

  it("counts nothing on a full cache hit", async () => {
    h.turns = [
      coldWrite,
      {
        content: "second",
        toolCalls: [],
        usage: { inputTokens: 21_000, outputTokens: 10, cachedInputTokens: 20_000, cacheCreationInputTokens: 1_000 },
      },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    await engine.runTurn("again");

    expect(engine.session.usage?.cacheWaste).toBeUndefined();
    expect(engine.session.trace.some((e) => e.type === "cache.miss")).toBe(false);
  });

  it("drops an inflated v1 cacheWaste total on the next observed round", async () => {
    h.turns = [coldWrite];
    const engine = await createEngine({ cwd, agent: "default" });
    engine.session.usage = {
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      cacheWaste: { missedTokens: 999_999, missCount: 99 },
    };
    await engine.runTurn("hi");

    expect(engine.session.usage?.cacheWaste).toBeUndefined();
  });

  it("resets the tracker at a compaction boundary instead of counting the new prompt as a miss", async () => {
    h.turns = [
      coldWrite,
      {
        content: "second",
        toolCalls: [],
        usage: { inputTokens: 8_000, outputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 8_000 },
      },
    ];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    // Simulate a compaction landing between the two rounds: the boundary's
    // createdAt is after round 1, so round 2's zero-read prompt is new
    // content, not re-billed content.
    engine.session.compactBoundaries = [
      { id: "compact_test", type: "manual", createdAt: new Date(Date.now() + 1_000).toISOString(), reason: "test" } as never,
    ];
    await engine.runTurn("again");

    expect(engine.session.usage?.cacheWaste).toBeUndefined();
    expect(engine.session.trace.some((e) => e.type === "cache.miss")).toBe(false);
  });
});
