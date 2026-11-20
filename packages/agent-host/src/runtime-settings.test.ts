import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEngine } from "@reina/core";
import type { CompactionSettings } from "@reina/desktop-protocol";
import type { SessionState, ToolCallRecord } from "@reina/protocol";
import { autoCompactThreshold, compactSessionContext, effectiveContextWindow, shouldAutoCompactSession } from "../../core/src/compaction.js";
import { isCompactionOffloadEnabled } from "../../core/src/chunks.js";
import { SubagentManager } from "../../core/src/subagent/manager.js";
import { testHost, testSession } from "../../core/src/subagent/test-helpers.js";
import { AgentHost } from "./index.js";

let cwd: string;
let host: AgentHost;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-runtime-settings-"));
  vi.stubEnv("REINA_CONFIG_HOME", cwd);
  for (const key of ["AUTO", "OFFLOAD", "TRIGGER_PERCENT", "BUFFER_TOKENS", "KEEP_RECENT"]) {
    vi.stubEnv(`REINA_COMPACTION_${key}`, undefined);
  }
  vi.stubEnv("REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS", undefined);
  host = new AgentHost(() => undefined);
});

afterEach(async () => {
  await host.close();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const settings: CompactionSettings = {
  compactionAuto: true,
  compactionOffload: false,
  compactionTriggerPercent: 80,
  compactionBufferTokens: 13_000,
  compactionKeepRecent: 8,
};

describe("host runtime settings", () => {
  test("binds a newly created idle session before its first catalog edit", async () => {
    const model = { provider: "deterministic" as const, model: "catalog-bound", apiKey: "old-key" };
    const catalogFile = path.join(cwd, "models.json");
    await writeFile(catalogFile, JSON.stringify([{ id: "chosen", ...model }]));
    const created = await host.handle({ type: "create_session", cwd, model });
    expect(created).toMatchObject({ success: true });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const sessions = (host as unknown as { sessions: Map<string, { engine: AgentEngine }> }).sessions;
    const engine = sessions.get(sessionId)!.engine;
    expect(engine.session.model.apiKey).toBe("old-key");

    await writeFile(catalogFile, JSON.stringify([{ id: "chosen", ...model, apiKey: "new-rotated-key" }]));
    expect(await host.handle({ type: "refresh_session_settings", sessionId }))
      .toMatchObject({ success: true, data: { applied: true } });
    expect(sessions.get(sessionId)!.engine).toBe(engine);
    expect(engine.session.model.apiKey).toBe("new-rotated-key");
    expect(engine.session.messages.some((message) => message.role === "user")).toBe(false);
  });

  test("settings deltas affect only the foreground session and retain its model connection", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await host.handle({
        type: "create_session", cwd,
        model: { provider: "deterministic", model: `session-${index}`, baseUrl: `https://session-${index}.example`, apiKey: "session-key", reasoningEffort: "high" },
      });
      ids.push((response as { data: { sessionId: string } }).data.sessionId);
    }
    const sessions = (host as unknown as { sessions: Map<string, { engine: AgentEngine }> }).sessions;
    const backgroundBefore = { ...sessions.get(ids[1])!.engine.session.model };
    expect(await host.handle({
      type: "patch_agent_settings", sessionId: ids[0], patch: { effort: "low", outputStyle: "learning" },
    })).toMatchObject({ success: true, data: { applied: true } });
    expect(sessions.get(ids[0])!.engine.session.model).toMatchObject({
      provider: "deterministic", model: "session-0", baseUrl: "https://session-0.example", apiKey: "session-key", reasoningEffort: "low",
    });
    expect(sessions.get(ids[0])!.engine.session.outputStyle).toBe("learning");
    expect(sessions.get(ids[1])!.engine.session.model).toEqual(backgroundBefore);
  });

  test("updates existing sessions without recreating them and clears percentage mode", async () => {
    const sessions: SessionState[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await host.handle({
        type: "create_session",
        cwd,
        model: { provider: "deterministic", model: "reina-deterministic", contextWindowTokens: 100_000 },
      });
      expect(response).toMatchObject({ success: true });
      const id = (response as { data: { sessionId: string } }).data.sessionId;
      const live = (host as unknown as { sessions: Map<string, { engine: AgentEngine }> }).sessions.get(id)!;
      live.engine.session.messages = Array.from({ length: 24 }, (_, i) => ({
        id: `message-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Step ${i}: ${"continuation context ".repeat(500)}`,
        createdAt: new Date().toISOString(),
      }));
      live.engine.session.usage = {
        turns: 12, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0,
        contextTokens: 75_000, contextTokensSource: "provider",
      };
      sessions.push(live.engine.session);
    }

    expect(await host.handle({ type: "update_compaction_settings", settings }))
      .toMatchObject({ success: true, data: { applied: true } });
    for (const session of sessions) expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);

    await host.handle({ type: "update_compaction_settings", settings: { ...settings, compactionTriggerPercent: 70 } });
    for (const session of sessions) expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);

    await host.handle({
      type: "update_compaction_settings",
      settings: { ...settings, compactionAuto: false, compactionOffload: true, compactionTriggerPercent: 0 },
    });
    expect(process.env.REINA_COMPACTION_TRIGGER_PERCENT).toBeUndefined();
    expect(isCompactionOffloadEnabled()).toBe(true);
    for (const session of sessions) {
      expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
      expect(autoCompactThreshold(session.model)).toBe(effectiveContextWindow(session.model) - 13_000);
    }

    await host.handle({ type: "update_compaction_settings", settings: { ...settings, compactionKeepRecent: 64 } });
    expect(isCompactionOffloadEnabled()).toBe(false);
    expect(await compactSessionContext(sessions[0], "manual", "keep all recent messages")).toBeUndefined();
    await host.handle({ type: "update_compaction_settings", settings });
    expect(await compactSessionContext(sessions[0], "manual", "updated retention budget")).toBeDefined();
  });

  test("an existing subagent manager uses higher and lower live concurrency caps", async () => {
    const session = testSession({ cwd });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let childCount = 0;
    const { host: subagentHost } = testHost(session, {
      spawnChild: () => ({
        session: { id: `child-${++childCount}`, messages: [], toolCalls: [] },
        onStream: () => () => undefined,
        setUserQuestionHandler: () => undefined,
        setBubbleApprovalHandler: () => undefined,
        setSiblingMessageHandler: () => undefined,
        runTurn: () => pending,
        interrupt: () => undefined,
      }) as unknown as AgentEngine,
    });
    const manager = new SubagentManager(subagentHost);
    const dispatch = (description: string) => manager.startAsync({
      id: description, name: "start_async_task", input: { description, background: true }, summary: description,
      permission: "state", status: "running", createdAt: new Date().toISOString(),
    } as ToolCallRecord);
    try {
      expect(await host.handle({ type: "update_subagent_concurrency", concurrency: 1 }))
        .toMatchObject({ success: true, data: { applied: true } });
      expect((await dispatch("first worker")).error).toBeUndefined();
      expect((await dispatch("second worker")).error).toContain("(1/1)");
      await host.handle({ type: "update_subagent_concurrency", concurrency: 2 });
      expect((await dispatch("second worker")).error).toBeUndefined();
      expect(manager.children.size).toBe(2);
      await host.handle({ type: "update_subagent_concurrency", concurrency: 1 });
      expect((await dispatch("third worker")).error).toContain("(2/1)");
      expect(manager.children.size).toBe(2);
    } finally {
      release();
      await vi.waitFor(() => expect(manager.children.size).toBe(0));
    }
  });
});
