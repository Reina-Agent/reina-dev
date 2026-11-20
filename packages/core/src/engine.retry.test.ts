import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** End-to-end coverage for the turn-level model-call retry in continueLoop.
 *
 * A transient API failure must NOT silently end the turn — for a subagent that
 * path produces a task that "completes" with `Model request failed: ...` as its
 * result. The provider is MOCKED here (throw-then-succeed) because the built-in
 * deterministic provider has no error-injection seam. We keep the real
 * isRetryableStreamError via `...actual` so the retryable/non-retryable
 * classification under test is the production one. */

const h = vi.hoisted(() => ({
  count: 0,
  behaviors: [] as Array<"retryable" | "fatal" | "context" | "tool" | "ok">,
  onRequest: undefined as ((index: number) => void) | undefined,
  requests: [] as Array<{
    messages: Array<{
      role?: string;
      content?: string;
      ephemeral?: boolean;
      contextState?: { version: 1; sections: Record<string, string> };
    }>;
    observations: Array<{ output?: string; error?: string }>;
    systemReminders?: string[];
  }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async (
      _config: unknown,
      request: {
        messages: Array<{
          role?: string;
          content?: string;
          ephemeral?: boolean;
          contextState?: { version: 1; sections: Record<string, string> };
        }>;
        observations: Array<{ output?: string; error?: string }>;
        systemReminders?: string[];
      },
    ) => {
      h.requests.push(request);
      const i = h.count++;
      h.onRequest?.(i);
      const behavior = h.behaviors[Math.min(i, h.behaviors.length - 1)] ?? "ok";
      // Plain Error → isRetryableStreamError() treats it as network/unknown → retryable.
      if (behavior === "retryable") throw new Error("upstream overloaded (simulated)");
      // Quota/billing wording → isRetryableStreamError() returns false → no retry.
      if (behavior === "fatal") throw new Error("insufficient_quota: credit balance is too low");
      if (behavior === "context") {
        const error = new Error("context_length_exceeded: maximum context length exceeded");
        (error as Error & { status?: number }).status = 400;
        throw error;
      }
      if (behavior === "tool") {
        return { toolCalls: [{ id: "call_cache_prefix", name: "read_file", input: { path: "README.md" } }] };
      }
      return { content: "recovered ok", toolCalls: [] };
    },
  };
});

import { AgentEngine } from "./engine.js";
import type { ChatMessage, ToolObservation } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { formatSystemReminders } from "@reina/providers";
import { estimateTextTokens } from "./compaction.js";

let cwd: string;
let oldConfigHome: string | undefined;
let oldMaxRetries: string | undefined;
let engines: AgentEngine[] = [];

async function createEngine(input: Parameters<typeof AgentEngine.create>[0]): Promise<AgentEngine> {
  const engine = await AgentEngine.create(input);
  engines.push(engine);
  return engine;
}

beforeEach(async () => {
  engines = [];
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-retry-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  oldMaxRetries = process.env.REINA_TURN_MAX_RETRIES;
  await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
  h.count = 0;
  h.behaviors = [];
  h.onRequest = undefined;
  h.requests = [];
});

afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  if (oldMaxRetries === undefined) delete process.env.REINA_TURN_MAX_RETRIES;
  else process.env.REINA_TURN_MAX_RETRIES = oldMaxRetries;
  await rm(cwd, { recursive: true, force: true });
});

function lastAssistant(engine: AgentEngine): string {
  const m = engine.session.messages.filter((x) => x.role === "assistant").at(-1);
  return typeof m?.content === "string" ? m.content : "";
}

describe("continueLoop model-call retry", () => {
  it("retries a transient failure and continues the turn instead of ending it", async () => {
    h.behaviors = ["retryable", "ok"];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    expect(lastAssistant(engine)).toBe("recovered ok");
    expect(lastAssistant(engine)).not.toContain("Model request failed");
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(true);
    expect(h.count).toBe(2); // one failed attempt + one successful retry
  });

  it("does not retry a non-retryable error (quota/billing) — fails fast", async () => {
    h.behaviors = ["fatal"];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    expect(lastAssistant(engine)).toContain("Model request failed");
    expect(lastAssistant(engine)).not.toContain("after"); // not "...after N retries"
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(false);
    expect(h.count).toBe(1); // single attempt, no retry
  });

  it("gives up after the retry budget is spent and surfaces the failure", async () => {
    process.env.REINA_TURN_MAX_RETRIES = "1";
    h.behaviors = ["retryable", "retryable"];
    const engine = await createEngine({ cwd, agent: "default" });
    await engine.runTurn("hi");
    expect(lastAssistant(engine)).toContain("Model request failed after 1 retry");
    expect(h.count).toBe(2); // initial attempt + 1 retry, then give up
  });

  it("trims oversized pending observations once before retrying a context-window error", async () => {
    h.behaviors = ["context", "ok"];
    const engine = await createEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      pendingObservations: ToolObservation[];
      continueLoop(): Promise<void>;
    };
    internals.pendingObservations = [
      {
        callId: "call_big",
        name: "read_file",
        output: `head ${"chunk value ".repeat(4_000)} tail`,
      },
    ];

    await internals.continueLoop();

    expect(lastAssistant(engine)).toBe("recovered ok");
    expect(h.count).toBe(2);
    expect(h.requests[0]!.observations[0]!.output!.length).toBeGreaterThan(30_000);
    expect(h.requests[1]!.observations[0]!.output!.length).toBeLessThanOrEqual(6_000);
    expect(h.requests[1]!.observations[0]!.output).toContain("emergency context recovery");
    expect(
      engine.session.trace.some(
        (e) => e.type === "model.context_overflow_recovery" && e.data.strategy === "trim_observations",
      ),
    ).toBe(true);
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(false);
  });

  it("compacts old model context before retrying a context-window error", async () => {
    h.behaviors = ["context", "ok"];
    const engine = await createEngine({ cwd, agent: "default" });
    engine.session.messages.push(...longHistory());

    await engine.runTurn("continue after overflow");

    expect(lastAssistant(engine)).toBe("recovered ok");
    expect(h.count).toBe(3);
    expect(engine.session.compactBoundaries?.at(-1)?.type).toBe("auto");
    expect(engine.session.summary).toBeTruthy();
    expect(
      engine.session.trace.some(
        (e) => e.type === "model.context_overflow_recovery" && e.data.strategy === "compact_context",
      ),
    ).toBe(true);
    expect(engine.session.trace.some((e) => e.type === "model.retry")).toBe(false);
  });

  it.each(["openai-chat", "openai-responses", "openai-codex-responses", "anthropic-messages"] as const)(
    "materializes %s context updates so a tool follow-up extends the prior request prefix",
    async (provider) => {
      h.behaviors = ["tool", "ok"];
      const engine = await createEngine({
        cwd,
        agent: "default",
        model: { provider, model: "test-model", apiKey: "test-key" },
      });

      await engine.runTurn("read the readme", { reminders: ["cache-prefix-marker"] });

      expect(h.requests).toHaveLength(2);
      expect(h.requests[0]!.systemReminders).toContain("cache-prefix-marker");
      const materialized = h.requests[1]!.messages.find(
        (item) => item.ephemeral && item.content?.includes("cache-prefix-marker"),
      );
      expect(materialized?.role).toBe("user");
      expect(materialized?.content).toContain("<system-reminder>");
      expect(materialized?.contextState?.version).toBe(1);
      expect(h.requests[1]!.systemReminders).toBeUndefined();
    },
  );

  it("adds zero reminder text on a fresh turn when dynamic context is unchanged", async () => {
    h.behaviors = ["ok", "ok"];
    const engine = await createEngine({
      cwd,
      agent: "default",
      model: { provider: "openai-responses", model: "test-model", apiKey: "test-key" },
    });

    await engine.runTurn("first", { reminders: ["one-shot-marker"] });
    expect(engine.session.usage?.lastRequest?.categories?.reminders).toBeGreaterThan(0);
    await engine.runTurn("second");

    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.systemReminders).toContain("one-shot-marker");
    expect(h.requests[1]!.systemReminders).toBeUndefined();
    expect(h.requests[1]!.messages.filter((item) => item.ephemeral && item.contextState)).toHaveLength(1);
    expect(engine.session.usage?.lastRequest?.categories?.reminders).toBe(0);
  });

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "does not repeat a %s mode-exit reminder after delivering it in the active tool loop",
    async (provider) => {
      h.behaviors = ["tool", "ok", "ok"];
      const engine = await createEngine({
        cwd,
        agent: "default",
        model: { provider, model: "test-model", apiKey: "test-key" },
      });
      engine.setSessionMode("team", true);
      h.onRequest = (index) => {
        if (index === 0) engine.setSessionMode("team", false);
      };

      await engine.runTurn("delegate a task");
      const deliveredUpdate = h.requests[1]!.systemReminders;
      expect(deliveredUpdate).toHaveLength(1);
      expect(engine.session.usage?.lastRequest?.categories?.reminders).toBe(
        estimateTextTokens(formatSystemReminders(deliveredUpdate) ?? ""),
      );
      h.onRequest = undefined;
      await engine.runTurn("continue");

      const exitReminder = '<session-mode-exit name="team">';
      expect(h.requests).toHaveLength(3);
      expect(h.requests[1]!.systemReminders?.some((item) => item.includes(exitReminder))).toBe(true);
      expect(h.requests[2]!.systemReminders?.some((item) => item.includes(exitReminder)) ?? false).toBe(false);
    },
  );
});

function longHistory(): ChatMessage[] {
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor. ";
  return Array.from({ length: 14 }, (_, index) => [
    {
      id: `msg_user_${index}`,
      role: "user" as const,
      content: `overflow history user ${index} ${filler.repeat(40)}`,
      createdAt: nowIso(),
    },
    {
      id: `msg_assistant_${index}`,
      role: "assistant" as const,
      content: `overflow history assistant ${index} ${filler.repeat(40)}`,
      createdAt: nowIso(),
    },
  ]).flat();
}
