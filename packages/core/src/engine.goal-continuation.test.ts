import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Stagnation escalation in goalContinuationPrompt: kimi-code's dedupe-ladder
 * shape applied to goal continuation. A continuation round with no new
 * progress (the trace-observed failure: the model narrates the next step and
 * ends the turn WITHOUT calling the tool) must get a firmer directive the
 * next round; a fresh round must read exactly as before. */

import { AgentEngine } from "./engine.js";

let cwd: string;
let oldConfigHome: string | undefined;
const engines: AgentEngine[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-goal-cont-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

async function engineWithGoal(stagnantTurns: number): Promise<AgentEngine> {
  const engine = await AgentEngine.create({ cwd, agent: "default" });
  engines.push(engine);
  engine.executeGoalCommand({ type: "create", objective: "finish the probe" });
  engine.session.goal!.run!.rounds = 3;
  engine.session.goal!.run!.stagnantTurns = stagnantTurns;
  return engine;
}

describe("goalContinuationPrompt stagnation escalation", () => {
  it("adds no escalation on a fresh round (stagnantTurns = 0)", async () => {
    const engine = await engineWithGoal(0);
    const prompt = engine.goalContinuationPrompt();
    expect(prompt).not.toContain("previous continuation recorded no new progress");
    expect(prompt).toContain("<goal>");
  });

  it("stagnantTurns = 1 demands execution instead of narration", async () => {
    const engine = await engineWithGoal(1);
    const prompt = engine.goalContinuationPrompt();
    expect(prompt).toContain("previous continuation recorded no new progress");
    expect(prompt).toContain("Execute the next concrete action now");
  });

  it("stagnantTurns >= 2 warns that the next stagnant round stops the run", async () => {
    const engine = await engineWithGoal(2);
    const prompt = engine.goalContinuationPrompt();
    expect(prompt).toContain("2 consecutive continuations recorded no progress");
    expect(prompt).toContain("Produce new evidence");
  });
});
