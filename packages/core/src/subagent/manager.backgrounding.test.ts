import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionState, ToolCallRecord } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** Foreground-budget backgrounding ("don't hard-kill working children"):
 * a sync `task` whose child outlives subagentTimeoutMs is NOT interrupted.
 * The dispatch observation converts into a background pointer, the child
 * keeps running, and settlement lands on the task record with an injector
 * notification queued for the supervisor's next safe boundary. */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-backgrounding-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function slowChild(runtimeMs: number) {
  const child = {
    session: {
      id: `child_${createId("sess").slice(-6)}`,
      agent: "default",
      messages: [] as Array<{ role: string; content: string }>,
      toolCalls: [] as ToolCallRecord[],
      usage: { turns: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      interrupted: false,
      submittedResponse: undefined as string | undefined,
    },
    onStream: () => () => undefined,
    setUserQuestionHandler: () => undefined,
    setBubbleApprovalHandler: () => undefined,
    setSiblingMessageHandler: () => undefined,
    runTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, runtimeMs));
      child.session.messages.push({ role: "assistant", content: "slow but done" });
    },
    interrupt: () => {
      child.session.interrupted = true;
    },
  };
  return child;
}

function taskCall(description: string): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: "task" as ToolCallRecord["name"],
    input: { description, subagentType: "default" },
    summary: "task",
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  } as unknown as ToolCallRecord;
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("foreground budget detaches instead of killing", () => {
  it("runSync over budget returns a background pointer and the child survives to settle", async () => {
    process.env.REINA_SUBAGENT_TIMEOUT_MS = "100"; // budget far below child runtime
    try {
      const s = testSession({ id: "sess_bg", cwd } as Partial<SessionState>);
      const child = slowChild(500);
      const { host, emitted } = testHost(s, { spawnChild: () => child as unknown as AgentEngine });
      const mgr = new SubagentManager(host);

      const obs = await mgr.runSync(taskCall("long haul"));

      // Budget verdict: a pointer OUTPUT (not an error), child untouched.
      expect(obs.error).toBeUndefined();
      expect(obs.output).toContain("<background>true</background>");
      expect(obs.output).toContain("<status>running</status>");
      expect(child.session.interrupted).toBe(false);
      const running = s.asyncTasks?.find((t) => t.sync);
      expect(running?.status).toBe("running");
      expect(running?.background).toBe(true);

      // The child keeps working and settles as a normal completion.
      const settled = await waitFor(() => {
        const t = s.asyncTasks?.find((x) => x.sync);
        return t && t.status !== "running" ? t : undefined;
      });
      expect(settled.status).toBe("completed");
      expect(settled.result).toContain("slow but done");
      expect(child.session.interrupted).toBe(false);
      // Settlement queued the auto-notification for the supervisor.
      expect(emitted.some((e) => (e as { type?: string }).type === "async-task-injected")).toBe(true);
    } finally {
      delete process.env.REINA_SUBAGENT_TIMEOUT_MS;
    }
  });

  it("runSync within budget still returns the child's result inline", async () => {
    process.env.REINA_SUBAGENT_TIMEOUT_MS = "2000"; // generous budget
    try {
      const s = testSession({ id: "sess_fg", cwd } as Partial<SessionState>);
      const child = slowChild(50);
      const { host } = testHost(s, { spawnChild: () => child as unknown as AgentEngine });
      const mgr = new SubagentManager(host);

      const obs = await mgr.runSync(taskCall("quick job"));

      expect(obs.error).toBeUndefined();
      expect(obs.output).toContain("slow but done");
      const settled = s.asyncTasks?.find((t) => t.sync);
      expect(settled?.status).toBe("completed");
      // Foreground consumption acknowledged the record — no auto-injection.
      expect(settled?.background).toBeUndefined();
      expect(settled?.notifiedAt).toBeDefined();
    } finally {
      delete process.env.REINA_SUBAGENT_TIMEOUT_MS;
    }
  });
});
