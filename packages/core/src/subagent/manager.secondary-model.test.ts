import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelConfig, SessionState, ToolCallRecord } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** kimi #2064: `subagent.secondaryModel` — "all subagent children on a cheap
 * model, main session untouched". Merged over the child's inherited model at
 * spawn time; forks are excluded (a different model is a different
 * prompt-cache namespace, which would defeat fork prefix reuse). */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-subagent-secondary-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const PARENT_MODEL: ModelConfig = {
  provider: "anthropic-messages",
  model: "big-model",
  apiKey: "parent-key",
} as ModelConfig;

function makeChild() {
  const child = {
    session: {
      id: `child_${createId("sess").slice(-6)}`,
      agent: "default",
      model: { ...PARENT_MODEL },
      messages: [] as Array<{ role: string; content: string }>,
      toolCalls: [] as ToolCallRecord[],
      usage: { turns: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      interrupted: false,
    },
    onStream: () => () => undefined,
    setUserQuestionHandler: () => undefined,
    setBubbleApprovalHandler: () => undefined,
    setSiblingMessageHandler: () => undefined,
    runTurn: async () => {
      child.session.messages.push({ role: "assistant", content: "done" });
    },
    interrupt: () => {
      child.session.interrupted = true;
    },
  };
  return child;
}

function call(name: string, input: Record<string, unknown>): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: name as ToolCallRecord["name"],
    input,
    summary: name,
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  } as unknown as ToolCallRecord;
}

describe("subagent.secondaryModel", () => {
  it("merges the secondary model over a sync task child's inherited model (partial keeps provider/apiKey)", async () => {
    const s = testSession({ id: "sess_secondary_sync", cwd } as Partial<SessionState>);
    const child = makeChild();
    const { host } = testHost(s, {
      secondaryModel: { model: "cheap-model" },
      spawnChild: () => child as unknown as AgentEngine,
    });
    const mgr = new SubagentManager(host);
    const obs = await mgr.runSync(call("task", { description: "quick job", subagentType: "default" }));
    expect(obs.error).toBeUndefined();
    expect(child.session.model).toEqual({
      provider: "anthropic-messages",
      model: "cheap-model",
      apiKey: "parent-key",
    });
  });

  it("applies to async dispatches but NOT to fork:true children", async () => {
    const s = testSession({ id: "sess_secondary_fork", cwd } as Partial<SessionState>);
    const asyncChild = makeChild();
    const forkChild = makeChild();
    const children = [asyncChild, forkChild];
    const { host } = testHost(s, {
      secondaryModel: { model: "cheap-model" },
      forkEnabled: true,
      spawnChild: () => children.shift() as unknown as AgentEngine,
    });
    const mgr = new SubagentManager(host);

    // background:true → the dispatch returns right after spawn instead of
    // holding the foreground budget (the model merge under test happens at
    // spawn time either way).
    const plain = await mgr.startAsync(call("start_async_task", { description: "independent research", background: true }));
    expect(plain.error).toBeUndefined();
    expect(asyncChild.session.model.model).toBe("cheap-model");

    const forked = await mgr.startAsync(
      call("start_async_task", { description: "fanned-out audit", fork: true, background: true }),
    );
    expect(forked.error).toBeUndefined();
    // Fork keeps the parent model verbatim — cache-namespace constraint.
    expect(forkChild.session.model).toEqual(PARENT_MODEL);
    // Let the detached driveAsyncChild settle before afterEach removes cwd.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("leaves the child model untouched when no secondaryModel is configured", async () => {
    const s = testSession({ id: "sess_secondary_unset", cwd } as Partial<SessionState>);
    const child = makeChild();
    const { host } = testHost(s, { spawnChild: () => child as unknown as AgentEngine });
    const mgr = new SubagentManager(host);
    const obs = await mgr.runSync(call("task", { description: "quick job", subagentType: "default" }));
    expect(obs.error).toBeUndefined();
    expect(child.session.model).toEqual(PARENT_MODEL);
  });
});
