import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Characterization coverage for the auto-title subsystem (generateAutoTitle
 * and its helpers). Every other engine test runs the deterministic provider,
 * which generateAutoTitle deliberately short-circuits on — so the async path
 * (model call, cleanup, in-flight latch, post-await rename guard, background
 * error reporting) was previously unpinned. The provider is MOCKED here the
 * same way engine.retry.test.ts does it (spread `...actual`, override
 * nextModelTurnStream) because there is no error/latency-injection seam in
 * the deterministic provider. */

const h = vi.hoisted(() => ({
  calls: [] as Array<{
    config: { provider: string; model: string };
    request: {
      messages: Array<{ role: string; content: string }>;
      systemPrompt?: string;
      tools: unknown[];
    };
  }>,
  respond: (async () => ({ content: "Stub Title", toolCalls: [] })) as () => Promise<{
    content: string;
    toolCalls: never[];
  }>,
}));

vi.mock("@reina/providers", async (importActual) => {
  const actual = await importActual<typeof import("@reina/providers")>();
  return {
    ...actual,
    nextModelTurnStream: async (
      config: { provider: string; model: string },
      request: { messages: Array<{ role: string; content: string }>; systemPrompt?: string; tools: unknown[] },
    ) => {
      h.calls.push({ config, request });
      return h.respond();
    },
  };
});

import { AgentEngine } from "./engine.js";
import type { ModelStreamEvent } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

let cwd: string;
let oldConfigHome: string | undefined;

const TITLE_MODEL = { provider: "anthropic-messages", model: "claude-title-test", apiKey: "test-key" } as const;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-title-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello reina", "utf8");
  h.calls = [];
  h.respond = async () => ({ content: "Stub Title", toolCalls: [] });
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

async function closeEngineRecorder(engine: AgentEngine): Promise<void> {
  // Full quiesce, not just the recorder: dispose also settles the detached
  // notes-service inits so the afterEach rm doesn't race their writes
  // (EBUSY/ENOTEMPTY on Windows under full-suite load).
  await engine.dispose();
}

/** Seed the first user/assistant exchange directly — runTurn would route
 * through the (mocked) provider and muddy the call log under test. */
function seedExchange(engine: AgentEngine, userText: string, assistantText = "Sure — here is a summary."): void {
  engine.session.messages.push(
    { id: createId("msg"), role: "user", content: userText, createdAt: nowIso() },
    { id: createId("msg"), role: "assistant", content: assistantText, createdAt: nowIso() },
  );
}

describe("generateAutoTitle", () => {
  it("skips the model call entirely when the effective title model is deterministic", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    seedExchange(engine, "Rename all the widgets please.");

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(engine.session.title).toBe("Reina");
    await closeEngineRecorder(engine);
  });

  it("returns null without calling the model when autoTitle is disabled", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL, autoTitle: { enabled: false } });
    seedExchange(engine, "Rename all the widgets please.");

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(h.calls).toHaveLength(0);
    await closeEngineRecorder(engine);
  });

  it("returns null when the first exchange is incomplete (no assistant reply yet)", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    engine.session.messages.push({ id: createId("msg"), role: "user", content: "hello", createdAt: nowIso() });

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(h.calls).toHaveLength(0);
    await closeEngineRecorder(engine);
  });

  it("leaves a non-default title alone without calling the model", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    engine.session.title = "My Custom Name";
    seedExchange(engine, "Rename all the widgets please.");

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(engine.session.title).toBe("My Custom Name");
    await closeEngineRecorder(engine);
  });

  it("sets a cleaned model title, records it, and persists across reload", async () => {
    h.respond = async () => ({ content: "Title: Fix the renderer build.\nSecond line ignored", toolCalls: [] });
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    seedExchange(engine, "The renderer build fails on Windows.", "Let me look at the Vite config.");

    const title = await engine.generateAutoTitle();

    // cleanTitle: "Title:" prefix stripped, first line only, trailing punctuation removed.
    expect(title).toBe("Fix the renderer build");
    expect(engine.session.title).toBe("Fix the renderer build");
    expect(engine.session.trace.some((e) => e.type === "session.autotitled")).toBe(true);

    // The prompt is built from the first exchange with the fixed naming system prompt.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.config.provider).toBe("anthropic-messages");
    expect(h.calls[0]?.config.model).toBe("claude-title-test");
    expect(h.calls[0]?.request.systemPrompt).toContain("You name chat conversations");
    expect(h.calls[0]?.request.tools).toEqual([]);
    expect(h.calls[0]?.request.messages).toHaveLength(1);
    expect(h.calls[0]?.request.messages[0]?.content).toBe(
      "Conversation:\nUser: The renderer build fails on Windows.\nAssistant: Let me look at the Vite config.",
    );

    // record({type:"config"}) + flushToStore make the title survive a reload.
    await engine.saveSession();
    await closeEngineRecorder(engine);
    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    expect(reopened.session.title).toBe("Fix the renderer build");
    await closeEngineRecorder(reopened);
  });

  it("replaces only the exact provisional first-message title", async () => {
    h.respond = async () => ({ content: "Repair sidebar titles", toolCalls: [] });
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    const provisional = engine.ensureTitleFromFirstUserMessage("Fix automatic task naming");
    seedExchange(engine, "Fix automatic task naming", "I will inspect the title synchronization path.");

    expect(provisional).toBe("Fix automatic task naming");
    expect(await engine.generateAutoTitle(provisional ?? undefined)).toBe("Repair sidebar titles");
    expect(engine.session.title).toBe("Repair sidebar titles");
    await closeEngineRecorder(engine);
  });

  it("truncates long exchange text in the title prompt", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    seedExchange(engine, `start-${"u".repeat(700)}`, "ok");

    await engine.generateAutoTitle();

    const prompt = h.calls[0]?.request.messages[0]?.content ?? "";
    expect(prompt).toContain(`start-${"u".repeat(594)}…`);
    expect(prompt).not.toContain("u".repeat(695));
    await closeEngineRecorder(engine);
  });

  it("never overwrites a title set during the model call, and latches re-entry", async () => {
    let release!: (value: { content: string; toolCalls: never[] }) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    h.respond = () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    };
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    const provisional = engine.ensureTitleFromFirstUserMessage("Slow model race.");
    seedExchange(engine, "Slow model race.");

    const first = engine.generateAutoTitle(provisional ?? undefined);
    await enteredPromise;
    // Re-entry while the first call is awaiting the model: latched, no 2nd call.
    expect(await engine.generateAutoTitle()).toBeNull();
    expect(h.calls).toHaveLength(1);

    // The user renames the session mid-flight — auto-title must not clobber it.
    engine.session.title = "User Renamed";
    release({ content: "Model Title", toolCalls: [] });
    expect(await first).toBeNull();
    expect(engine.session.title).toBe("User Renamed");
    await closeEngineRecorder(engine);
  });

  it("reports a background error when the cleaned title comes back empty", async () => {
    h.respond = async () => ({ content: "\n", toolCalls: [] });
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    seedExchange(engine, "Empty title from model.");
    const events: ModelStreamEvent[] = [];
    engine.onStream((event) => events.push(event));

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(engine.session.title).toBe("Reina");
    expect(events.some((e) => e.type === "background-error" && e.category === "autotitle")).toBe(true);
    await closeEngineRecorder(engine);
  });

  it("swallows model failures and reports them as background errors", async () => {
    h.respond = async () => {
      throw new Error("upstream exploded (simulated)");
    };
    const engine = await AgentEngine.create({ cwd, agent: "default", titleModel: TITLE_MODEL });
    seedExchange(engine, "Model throws.");
    const events: ModelStreamEvent[] = [];
    engine.onStream((event) => events.push(event));

    expect(await engine.generateAutoTitle()).toBeNull();
    expect(engine.session.title).toBe("Reina");
    expect(events.some((e) => e.type === "background-error" && e.category === "autotitle")).toBe(true);
    // The latch must be released by the failure so a later attempt still works.
    h.respond = async () => ({ content: "Recovered Title", toolCalls: [] });
    expect(await engine.generateAutoTitle()).toBe("Recovered Title");
    await closeEngineRecorder(engine);
  });
});
