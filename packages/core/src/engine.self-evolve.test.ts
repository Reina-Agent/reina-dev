import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "./engine.js";

// The Hermes-style learning loop: verify the CADENCE + guards around the
// review fork without driving a real model. We stub the review body and count
// how often the trigger fires as top-level turns complete.

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
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-se-eng-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
});

afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

/** Replace the review body with a counter so we test the trigger, not the fork. */
function stubReview(engine: AgentEngine): () => number {
  let fired = 0;
  (engine as unknown as { runSelfEvolveReview: () => Promise<void> }).runSelfEvolveReview = async () => {
    fired += 1;
  };
  return () => fired;
}

describe("self-evolve trigger cadence", () => {
  it("fires once every `everyTurns` top-level turns when enabled", async () => {
    const engine = await createEngine({
      cwd,
      agent: "default",
      selfEvolve: { enabled: true, everyTurns: 2, notify: false },
    });
    const fired = stubReview(engine);
    await engine.runTurn("hi"); // turn 1 → not yet
    expect(fired()).toBe(0);
    await engine.runTurn("hi"); // turn 2 → fires, counter resets
    expect(fired()).toBe(1);
    await engine.runTurn("hi"); // turn 3 → not yet
    expect(fired()).toBe(1);
    await engine.runTurn("hi"); // turn 4 → fires again
    expect(fired()).toBe(2);
  });

  it("never fires when disabled (default)", async () => {
    const engine = await createEngine({ cwd, agent: "default", selfEvolve: { enabled: false, everyTurns: 1 } });
    const fired = stubReview(engine);
    await engine.runTurn("hi");
    await engine.runTurn("hi");
    expect(fired()).toBe(0);
  });
});
