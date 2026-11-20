import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "./engine.js";
import { runCompletionVerify } from "./completion-verifier.js";
import type { GoalCommand } from "@reina/protocol";

vi.mock("./completion-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./completion-verifier.js")>();
  return { ...actual, runCompletionVerify: vi.fn() };
});

const verifyMock = vi.mocked(runCompletionVerify);
let cwd: string;
let oldConfigHome: string | undefined;

async function createGoalEngine(verify: { maxRounds?: number; failOpen?: boolean } = {}): Promise<AgentEngine> {
  const engine = await AgentEngine.create({
    cwd,
    agent: "default",
    goal: {
      verify: {
        ...verify,
        model: { provider: "anthropic-messages", model: "claude-judge" },
      },
    },
  });
  engine.executeGoalCommand({ type: "create", objective: "ship the thing", completionCriterion: "tests pass" });
  return engine;
}

function claim(engine: AgentEngine, evidence = "42 tests passed"): string {
  const goalId = engine.session.goal!.current!.id;
  const result = (engine as unknown as {
    goals: { execute(command: GoalCommand, actor: "model"): { ok: true } | { ok: false; message: string } };
  }).goals.execute({ type: "claim_complete", goalId, evidence }, "model");
  if (!result.ok) throw new Error(result.message);
  return engine.session.goal!.completionClaim!.id;
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-goal-verify-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  verifyMock.mockReset();
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await removeTempDir(cwd);
});

async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

describe("Goal completion verification", () => {
  it("keeps the Goal active until the independent verifier passes", async () => {
    verifyMock.mockResolvedValue({ pass: true, reason: "verified", feedback: "" });
    const engine = await createGoalEngine();
    claim(engine);
    expect(engine.session.goal?.current?.status).toBe("active");

    expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(engine.session.goal?.current).toMatchObject({ status: "complete", evidence: "42 tests passed" });
    expect(engine.session.goal?.run).toBeNull();
    await engine.dispose();
  });

  it("records rejection feedback and continues without complete-to-active reopening", async () => {
    verifyMock.mockResolvedValue({
      pass: false,
      reason: "test output is missing",
      feedback: "run the suite and attach stdout",
    });
    const engine = await createGoalEngine();
    claim(engine, "looks good");

    expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
    expect(engine.session.goal?.current?.status).toBe("active");
    expect(engine.session.goal?.completionClaim).toBeUndefined();
    expect(engine.session.goal?.run).toMatchObject({
      verifyRounds: 1,
      lastVerifyReason: "test output is missing",
      lastVerifyFeedback: "run the suite and attach stdout",
    });
    expect(engine.goalContinuationPrompt()).toContain("test output is missing");
    await engine.dispose();
  });

  it("fails open on verifier errors by default", async () => {
    verifyMock.mockRejectedValue(new Error("provider down"));
    const engine = await createGoalEngine();
    claim(engine);
    expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
    expect(engine.session.goal?.current?.status).toBe("complete");
    await engine.dispose();
  });

  it("keeps the claim active when verification is interrupted", async () => {
    const engine = await createGoalEngine();
    const claimId = claim(engine);
    verifyMock.mockImplementation(async () => {
      engine.session.interrupted = true;
      throw new Error("aborted");
    });
    expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
    expect(engine.session.goal?.completionClaim?.id).toBe(claimId);
    expect(engine.session.goal?.current?.status).toBe("active");
    await engine.dispose();
  });

  it("accepts after the configured verification cap without another judge call", async () => {
    const engine = await createGoalEngine({ maxRounds: 2 });
    engine.session.goal!.run!.verifyRounds = 2;
    claim(engine);
    expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(engine.session.goal?.current?.status).toBe("complete");
    await engine.dispose();
  });

  it("deduplicates overlapping idle-boundary verification", async () => {
    let release!: (value: { pass: boolean; reason: string; feedback: string }) => void;
    let markVerifierEntered!: () => void;
    const verifierEntered = new Promise<void>((resolve) => { markVerifierEntered = resolve; });
    verifyMock.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      markVerifierEntered();
    }));
    const engine = await createGoalEngine();
    claim(engine);
    const first = engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false });
    // Config refresh can reorder calls before the runtime acquires its guard.
    await verifierEntered;
    try {
      const second = engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false });
      expect(await second).toBe(false);
    } finally {
      release({ pass: true, reason: "verified", feedback: "" });
    }
    expect(await first).toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });

  it("reads legacy autopilot.verify once for pre-Goal-v2 config compatibility", async () => {
    verifyMock.mockResolvedValue({ pass: true, reason: "legacy config migrated", feedback: "" });
    const engine = await AgentEngine.create({
      cwd,
      agent: "default",
      autopilot: {
        verify: { model: { provider: "anthropic-messages", model: "legacy-judge" } },
      },
    });
    engine.executeGoalCommand({ type: "create", objective: "verify compatibility" });
    claim(engine);
    await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false });
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(engine.session.goal?.current?.status).toBe("complete");
    await engine.dispose();
  });
});
