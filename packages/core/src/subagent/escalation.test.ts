import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelStreamEvent, ToolCallRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { AgentEngine } from "../engine.js";

/** User-escalation channel (PR1): a subagent worker has no UI of its own, so
 * when it calls `question` the engine routes the prompt up to the parent's
 * HITL flow. The parent mints a mirror pending question (attributed with
 * `bubbledFromTask`), surfaces it via the real-time `question-request` stream
 * event, and forwards the user's answer back to the awaiting child.
 *
 * These tests pin the parent-side adapter + the child-side `askQuestion`
 * bubble branch directly, mirroring bubble.test.ts (no full fork tool loop). */

let cwd: string;
let oldConfigHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-escalation-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hi", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
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

type Observation = { output?: string; error?: string };

type HostSeam = {
  requestUserQuestion: (input: {
    taskId: string;
    taskName?: string;
    prompt: string;
    options?: string[];
  }) => Promise<{ answer: string } | { cancelled: true }>;
};

function hostOf(engine: AgentEngine): HostSeam {
  const callable = (engine as unknown as { createSubagentHost: () => HostSeam }).createSubagentHost;
  return callable.call(engine);
}

function askQuestionOf(engine: AgentEngine): (r: ToolCallRecord) => Promise<Observation> | Observation {
  const ctl = (engine as unknown as { question: { ask: (r: ToolCallRecord) => Promise<Observation> | Observation } }).question;
  return ctl.ask.bind(ctl);
}

function questionRecord(input: unknown, id = "call_q"): ToolCallRecord {
  return {
    id,
    name: "question" as ToolCallRecord["name"],
    input,
    summary: "question",
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  };
}

describe("requestUserQuestion (parent-side escalation adapter)", () => {
  it("mints a mirror pending question with bubbledFromTask + emits question-request", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const events: ModelStreamEvent[] = [];
    engine.onStream((e) => events.push(e));
    const host = hostOf(engine);

    const pending = host.requestUserQuestion({
      taskId: "sub_q1",
      taskName: "scout",
      prompt: "Which database?",
      options: ["postgres", "sqlite"],
    });

    const mirror = engine.session.pendingQuestions.find((q) => q.bubbledFromTask?.id === "sub_q1");
    expect(mirror).toBeDefined();
    expect(mirror?.bubbledFromTask).toEqual({ id: "sub_q1", name: "scout" });
    expect(mirror?.status).toBe("pending");
    expect(mirror?.question).toBe("Which database?");
    expect(mirror?.options).toEqual([{ label: "postgres" }, { label: "sqlite" }]);
    expect(events.some((e) => e.type === "question-request")).toBe(true);

    await engine.answerQuestion(mirror!.id, "postgres");
    expect(await pending).toEqual({ answer: "postgres" });
    // Mirror is stamped answered for the parent's timeline.
    expect(engine.session.pendingQuestions.find((q) => q.id === mirror!.id)?.status).toBe("answered");
  });

  it("omits the name field when the task is unnamed", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const pending = host.requestUserQuestion({ taskId: "sub_anon", prompt: "Proceed?" });
    const mirror = engine.session.pendingQuestions.find((q) => q.bubbledFromTask?.id === "sub_anon")!;
    expect(mirror.bubbledFromTask).toEqual({ id: "sub_anon" });
    await engine.answerQuestion(mirror.id, "yes");
    expect(await pending).toEqual({ answer: "yes" });
  });

  it("interrupt() settles a pending bubbled question as cancelled", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const host = hostOf(engine);
    const pending = host.requestUserQuestion({ taskId: "sub_int", prompt: "Still there?" });
    expect(engine.session.pendingQuestions.some((q) => q.bubbledFromTask?.id === "sub_int")).toBe(true);

    engine.interrupt();

    // Same shape the unattended-prompt timer resolves with: the awaiting
    // child proceeds with "(no answer)" instead of parking the parent's turn
    // on the 5-minute safety valve — the host's close paths await that
    // settle since the shutdown rework.
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(engine.session.pendingQuestions.some((q) => q.bubbledFromTask?.id === "sub_int")).toBe(false);
  });
});

describe("setUserQuestionHandler", () => {
  it("installs a handler the engine can invoke, and clears it", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.setUserQuestionHandler(async () => ({ answer: "x" }));
    const installed = (engine as unknown as { userQuestionHandler?: unknown }).userQuestionHandler;
    expect(typeof installed).toBe("function");
    engine.setUserQuestionHandler(undefined);
    expect((engine as unknown as { userQuestionHandler?: unknown }).userQuestionHandler).toBeUndefined();
  });
});

describe("askQuestion bubble branch (child-side)", () => {
  it("routes a subagent's question to the handler and returns the answer", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.isSubagent = true;
    let askedPrompt = "";
    let askedOptions: string[] | undefined;
    engine.setUserQuestionHandler(async (input) => {
      askedPrompt = input.prompt;
      askedOptions = input.options;
      return { answer: "blue" };
    });

    const obs = await askQuestionOf(engine)(questionRecord({ question: "What color?", options: [{ label: "blue" }, { label: "red" }] }));
    expect(askedPrompt).toBe("What color?");
    expect(askedOptions).toEqual(["blue", "red"]);
    expect(obs.output).toBe("User answered: blue");
    // The child must NOT stash a local pending question (it would stall the loop).
    expect(engine.session.pendingQuestions).toHaveLength(0);
  });

  it("returns a graceful note when no answer comes back (cancelled)", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.isSubagent = true;
    engine.setUserQuestionHandler(async () => ({ cancelled: true }));
    const obs = await askQuestionOf(engine)(questionRecord({ question: "Anything?" }));
    expect(obs.output).toContain("User answered:");
    expect(obs.output).toContain("user unavailable");
  });

  it("asks batched questions sequentially and joins the answers", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.isSubagent = true;
    const seen: string[] = [];
    engine.setUserQuestionHandler(async (input) => {
      seen.push(input.prompt);
      return { answer: `ans-${seen.length}` };
    });
    const obs = await askQuestionOf(engine)(
      questionRecord({
        questions: [
          { question: "Q1", header: "First" },
          { question: "Q2", header: "Second" },
        ],
      }),
    );
    expect(seen).toEqual(["Q1", "Q2"]);
    expect(obs.output).toContain("First: ans-1");
    expect(obs.output).toContain("Second: ans-2");
  });

  it("does NOT bubble for a top-level (non-subagent) session", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    let handlerCalled = false;
    engine.setUserQuestionHandler(async () => {
      handlerCalled = true;
      return { answer: "nope" };
    });
    // Not a subagent: falls through to the normal pending-question path.
    const obs = await askQuestionOf(engine)(questionRecord({ question: "Top-level?" }));
    expect(handlerCalled).toBe(false);
    expect(obs.output).toContain("Question pending");
    expect(engine.session.pendingQuestions).toHaveLength(1);
  });
});
