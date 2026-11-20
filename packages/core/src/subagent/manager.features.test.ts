import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionState, ToolCallRecord } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import type { AgentEngine } from "../engine.js";
import { SubagentManager, staleIdleMs, staleInToolMs, STALE_IDLE_MS } from "./manager.js";
import { buildFollowUpPrompt } from "./resume.js";
import { testHost, testSession } from "./test-helpers.js";

/** 2026-07 subagent parity features:
 *   ① configurable stale budgets (env / profile)
 *   ② settled-task follow-up via update_async_task
 *   ③ sibling messaging (send_task_message delivery)
 *   ④ batch fan-out (start_task_batch / check_task_batch)
 */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-subagent-features-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeChild(behavior: (child: { session: { interrupted: boolean; messages: Array<{ role: string; content: string }> } }) => Promise<void>) {
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
    runTurn: () => behavior(child),
    interrupt: () => {
      child.session.interrupted = true;
    },
  };
  return child;
}

function quickChild(reply: string, delayMs = 20) {
  return makeChild(async (child) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    child.session.messages.push({ role: "assistant", content: reply });
  });
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

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── ① configurable stale budgets ─────────────────────────────────────────────

describe("stale budget resolution", () => {
  it("env override wins, profile second, default last", () => {
    expect(staleIdleMs()).toBe(STALE_IDLE_MS);
    expect(staleInToolMs()).toBe(1_200_000);
    expect(staleIdleMs({ staleIdleMs: 90_000 } as never)).toBe(90_000);
    expect(staleInToolMs({ staleInToolMs: 60_000 } as never)).toBe(60_000);
    process.env.REINA_SUBAGENT_STALE_IDLE_MS = "30000";
    process.env.REINA_SUBAGENT_STALE_IN_TOOL_MS = "45000";
    try {
      expect(staleIdleMs({ staleIdleMs: 90_000 } as never)).toBe(30_000);
      expect(staleInToolMs({ staleInToolMs: 60_000 } as never)).toBe(45_000);
    } finally {
      delete process.env.REINA_SUBAGENT_STALE_IDLE_MS;
      delete process.env.REINA_SUBAGENT_STALE_IN_TOOL_MS;
    }
    // Floor guards a typo'd tiny value.
    process.env.REINA_SUBAGENT_STALE_IDLE_MS = "5";
    try {
      expect(staleIdleMs()).toBe(1_000);
    } finally {
      delete process.env.REINA_SUBAGENT_STALE_IDLE_MS;
    }
  });
});

// ── ② settled-task follow-up ─────────────────────────────────────────────────

describe("settled-task follow-up", () => {
  it("update_async_task re-opens a completed task and the follow-up settles with a new result", async () => {
    process.env.REINA_SUBAGENT_TIMEOUT_MS = "2000";
    try {
      const s = testSession({ id: "sess_followup", cwd } as Partial<SessionState>);
      const replies = ["first answer", "follow-up answer"];
      const { host, emitted } = testHost(s, {
        spawnChild: () => quickChild(replies.shift() ?? "?") as unknown as AgentEngine,
      });
      const mgr = new SubagentManager(host);

      const first = await mgr.runSync(call("task", { description: "answer the question", subagentType: "default" }));
      expect(first.output).toContain("first answer");
      const settled = s.asyncTasks?.find((t) => t.sync);
      expect(settled?.status).toBe("completed");

      const obs = mgr.update(call("update_async_task", { taskId: settled!.id, message: "and one more thing?" }));
      expect(obs.error).toBeUndefined();
      expect(obs.output).toContain("Re-opened settled task");
      expect(obs.output).toContain("attempt 2");
      const reopened = s.asyncTasks?.find((t) => t.id === settled!.id);
      expect(reopened?.status).toBe("running");
      expect(reopened?.attemptCount).toBe(2);

      const again = await waitFor(() => {
        const t = s.asyncTasks?.find((x) => x.id === settled!.id);
        return t && t.status !== "running" ? t : undefined;
      });
      expect(again.status).toBe("completed");
      expect(again.result).toContain("follow-up answer");
      // Follow-up runs as background → auto-injects its new result.
      expect(emitted.some((e) => (e as { type?: string }).type === "async-task-injected")).toBe(true);
    } finally {
      delete process.env.REINA_SUBAGENT_TIMEOUT_MS;
    }
  });

  it("buildFollowUpPrompt carries brief, prior outcome and the follow-up", () => {
    const prompt = buildFollowUpPrompt(
      { description: "original brief", status: "completed", result: "the old result" },
      "what about edge cases?",
      { taskId: "sub_x", attemptCount: 2 },
    );
    expect(prompt).toContain("original brief");
    expect(prompt).toContain("the old result");
    expect(prompt).toContain("what about edge cases?");
    expect(prompt).toContain("Attempt: 2");
    expect(prompt).toContain("NO hidden memory");
  });
});

// ── ③ sibling messaging ──────────────────────────────────────────────────────

describe("sibling messaging", () => {
  it("delivers to a running sibling (queue + interrupt) and refuses self / settled targets", async () => {
    const s = testSession({ id: "sess_sibling", cwd } as Partial<SessionState>);
    // A long-running target child that only finishes once interrupted.
    const target = makeChild(async (child) => {
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (child.session.interrupted) {
            clearInterval(tick);
            resolve();
          }
        }, 10);
      });
    });
    const { host } = testHost(s, { spawnChild: () => target as unknown as AgentEngine });
    const mgr = new SubagentManager(host);
    const internals = mgr as unknown as {
      deliverSiblingMessage(from: { taskId: string; name?: string }, targetRef: string, message: string): { ok: boolean; detail: string };
      pendingTaskUpdates: Map<string, string>;
    };

    const dispatch = await mgr.startAsync(call("start_async_task", { description: "long job", agent: "default", background: true }));
    const targetId = (dispatch.output ?? "").match(/<task_id>(\S+?)<\/task_id>/)?.[1];
    expect(targetId).toBeDefined();

    // Unknown target.
    expect(internals.deliverSiblingMessage({ taskId: "sub_from" }, "sub_nope", "hi").ok).toBe(false);
    // Self-send refused.
    expect(internals.deliverSiblingMessage({ taskId: targetId! }, targetId!, "hi").ok).toBe(false);

    const delivered = internals.deliverSiblingMessage({ taskId: "sub_from", name: "worker-a" }, targetId!, "schema is ready");
    expect(delivered.ok).toBe(true);
    expect(target.session.interrupted).toBe(true);
    // The queued message is attributed to the sender. (Interrupt → the drive
    // loop claims the queue and re-prompts; here we just assert the queue.)
    const queued = internals.pendingTaskUpdates.get(targetId!) ?? "";
    expect(queued).toContain("sibling worker sub_from (worker-a)");
    expect(queued).toContain("schema is ready");

    // Let the interrupted child settle (cancelled → claims queue → re-loops
    // with the message; the fake child completes immediately after).
    await waitFor(() => {
      const t = s.asyncTasks?.find((x) => x.id === targetId);
      return t && t.status !== "running" ? t : undefined;
    });
  });
});

// ── ④ batch fan-out ──────────────────────────────────────────────────────────

describe("batch fan-out", () => {
  it("dispatches maxConcurrent at a time, refills on settle, and check_task_batch reports done", async () => {
    const s = testSession({ id: "sess_batch", cwd } as Partial<SessionState>);
    let spawned = 0;
    const { host } = testHost(s, {
      spawnChild: () => {
        spawned += 1;
        return quickChild(`done-${spawned}`, 60) as unknown as AgentEngine;
      },
    });
    const mgr = new SubagentManager(host);

    const started = await mgr.startBatch(
      call("start_task_batch", {
        items: ["alpha", "beta", "gamma", "delta", "epsilon"],
        briefTemplate: "process {item} carefully",
        maxConcurrent: 2,
      }),
    );
    expect(started.error).toBeUndefined();
    const batchId = (started.output ?? "").match(/<batch_id>(\S+?)<\/batch_id>/)?.[1];
    expect(batchId).toBeDefined();
    // First wave respects the window.
    expect(started.output).toContain("<dispatched>2</dispatched>");
    expect(started.output).toContain("<queued>3</queued>");
    const firstWave = s.asyncTasks?.filter((t) => t.batchId === batchId) ?? [];
    expect(firstWave).toHaveLength(2);
    expect(firstWave.every((t) => t.description.startsWith("process ") && t.description.endsWith(" carefully"))).toBe(true);
    // Batch members must not auto-inject (no notification spam).
    expect(firstWave.every((t) => t.background === undefined)).toBe(true);

    // All five eventually settle via the refill loop.
    await waitFor(() => {
      const members = s.asyncTasks?.filter((t) => t.batchId === batchId) ?? [];
      return members.length === 5 && members.every((t) => t.status === "completed") ? members : undefined;
    }, 8000);

    const checked = mgr.checkBatch(call("check_task_batch", { batchId: batchId! }));
    expect(checked.error).toBeUndefined();
    expect(checked.output).toContain("<done>true</done>");
    expect(checked.output).toContain("completed=5");
    expect(checked.output).toContain("<queued>0</queued>");
  });

  it("requeues a rate-limited member (failed shape) and keeps the brief guard clean", async () => {
    process.env.REINA_BATCH_RATE_LIMIT_COOLDOWN_MS = "250";
    try {
      const s = testSession({ id: "sess_batch_rl", cwd } as Partial<SessionState>);
      let spawned = 0;
      const { host } = testHost(s, {
        spawnChild: () => {
          spawned += 1;
          // First attempt dies on a provider rate limit; the automatic retry succeeds.
          if (spawned === 1) {
            return makeChild(async () => {
              throw new Error("429 Too Many Requests: rate limit exceeded, please slow down");
            }) as unknown as AgentEngine;
          }
          return quickChild("recovered after retry") as unknown as AgentEngine;
        },
      });
      const mgr = new SubagentManager(host);

      const started = await mgr.startBatch(call("start_task_batch", { items: ["solo item"] }));
      expect(started.error).toBeUndefined();
      const batchId = (started.output ?? "").match(/<batch_id>(\S+?)<\/batch_id>/)?.[1];

      // First attempt settles failed — but with a retry armed the batch must
      // not read as done, and the model is told to keep its hands off.
      await waitFor(() => {
        const t = s.asyncTasks?.find((x) => x.batchId === batchId);
        return t && t.status === "failed" ? t : undefined;
      });
      const midFlight = mgr.checkBatch(call("check_task_batch", { batchId: batchId! }));
      expect(midFlight.output).toContain("<done>false</done>");
      expect(midFlight.output).toContain("awaiting automatic retry");

      // The cooldown expires, the member re-opens under the SAME task id, and
      // the retry completes. Rate-limit failures never count against the brief.
      const settled = await waitFor(() => {
        const t = s.asyncTasks?.find((x) => x.batchId === batchId);
        return t && t.status === "completed" ? t : undefined;
      });
      expect(settled.attemptCount).toBe(2);
      expect(settled.result).toContain("recovered after retry");
      expect(settled.background).toBeUndefined();
      expect(mgr.failedBriefCounts.size).toBe(0);
      const finalCheck = mgr.checkBatch(call("check_task_batch", { batchId: batchId! }));
      expect(finalCheck.output).toContain("<done>true</done>");
    } finally {
      delete process.env.REINA_BATCH_RATE_LIMIT_COOLDOWN_MS;
    }
  });

  it("retries the completed-shape rate limit (engine retry exhaustion) and caps the budget", async () => {
    process.env.REINA_BATCH_RATE_LIMIT_COOLDOWN_MS = "40";
    try {
      const s = testSession({ id: "sess_batch_rl_cap", cwd } as Partial<SessionState>);
      let spawned = 0;
      const { host } = testHost(s, {
        spawnChild: () => {
          spawned += 1;
          // Every attempt ends the way the engine ends an exhausted retry
          // budget: a graceful turn whose only output is the failure text —
          // which settles as a pseudo-"completed" record.
          return quickChild("Model request failed after 3 retries: 429 rate limit exceeded") as unknown as AgentEngine;
        },
      });
      const mgr = new SubagentManager(host);

      const started = await mgr.startBatch(call("start_task_batch", { items: ["stubborn item"] }));
      const batchId = (started.output ?? "").match(/<batch_id>(\S+?)<\/batch_id>/)?.[1];

      // Initial attempt + BATCH_RATE_LIMIT_MAX_RETRIES automatic retries, then stop.
      const final = await waitFor(() => {
        const t = s.asyncTasks?.find((x) => x.batchId === batchId);
        return t && t.attemptCount === 3 && t.status === "completed" ? t : undefined;
      });
      expect(spawned).toBe(3);
      // Budget exhausted — no further retry armed, so the batch settles as done.
      await waitFor(() => {
        const checked = mgr.checkBatch(call("check_task_batch", { batchId: batchId! }));
        return checked.output?.includes("<done>true</done>") ? checked : undefined;
      });
      expect(final.result).toContain("Model request failed");
    } finally {
      delete process.env.REINA_BATCH_RATE_LIMIT_COOLDOWN_MS;
    }
  });

  it("rejects a briefTemplate without {item} and an empty items array", async () => {
    const s = testSession({ id: "sess_batch_bad", cwd } as Partial<SessionState>);
    const { host } = testHost(s, {});
    const mgr = new SubagentManager(host);
    const noPlaceholder = await mgr.startBatch(call("start_task_batch", { items: ["a"], briefTemplate: "no placeholder" }));
    expect(noPlaceholder.error).toContain("{item}");
    const empty = await mgr.startBatch(call("start_task_batch", { items: [] }));
    expect(empty.error).toContain("non-empty");
  });
});
