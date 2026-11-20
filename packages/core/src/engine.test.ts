import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTool } from "@reina/tools";
import { AgentEngine, stripReplayPrefix, turnMaxRetries, turnRetryBackoffMs } from "./engine.js";
import { NotesService } from "./notes.js";
import { loadMcpResidencyPolicy } from "./engine-config.js";
import {
  buildHiddenToolsReminder,
  buildSystemPrompt,
  buildVolatileContextReminder,
  formatDeferredToolsCatalog,
} from "./engine-prompt.js";
import { profiles, resolveProfile } from "./profiles.js";
import { autoCompactBodyLimit, autoCompactThreshold, shouldAutoCompactSession } from "./compaction.js";
import { SessionStore } from "./store/session-store.js";
import type {
  AgentProfile,
  ChatMessage,
  GoalActor,
  GoalCommand,
  ModelStreamEvent,
  ToolCallRecord,
  ToolObservation,
} from "@reina/protocol";
import type { ToolLoopStop } from "./loop-budget.js";

// Filler for the compaction tests. MUST be varied text, never a long run of a
// single character: js-tiktoken's pure-JS BPE is roughly quadratic on long
// single-char runs (`"x".repeat(2200)` alone takes ~8s to encode), and a
// compaction runTurn tokenizes the transcript several times — that product
// blew the compaction tests past their timeouts on CI's slower runner. This
// unit is ~15 tokens and encodes in microseconds; repeat it to reach a target
// per-message weight (×19 ≈ 270 tokens, ×54 ≈ 760 tokens).
const COMPACT_FILLER_UNIT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor. ";

const nowStamp = (): string => new Date().toISOString();

let cwd: string;
let oldConfigHome: string | undefined;

async function closeEngineRecorder(engine: AgentEngine): Promise<void> {
  // Full quiesce, not just the recorder: dispose also settles the detached
  // notes-service inits so the afterEach rm doesn't race their writes
  // (EBUSY/ENOTEMPTY on Windows under full-suite load).
  await engine.dispose();
}

function executeInternalGoal(engine: AgentEngine, command: GoalCommand, actor: GoalActor) {
  return (
    engine as unknown as {
      goals: { execute(command: GoalCommand, actor: GoalActor): unknown };
    }
  ).goals.execute(command, actor);
}

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

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-core-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello reina", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

describe("AgentEngine", () => {
  it("hasPendingCompletionNotifications reflects the completion injector", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      subagent: { injector: { enqueue(task: { id: string }): void; drainAtSafeBoundary(): unknown[] } };
    };
    // Nothing settled yet.
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
    // A settled background task queued for injection flips it true.
    internals.subagent.injector.enqueue({ id: "sub_pending" });
    expect(engine.hasPendingCompletionNotifications()).toBe(true);
    // Draining (what runTurn does at its start) clears it.
    internals.subagent.injector.drainAtSafeBoundary();
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
    await closeEngineRecorder(engine);
  });

  it("materializes consumed tool outputs into the transcript as ephemeral messages", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      materializePendingToolResults(): void;
      pendingObservations: ToolObservation[];
      toolOutput: { modelObservations(): ToolObservation[] };
    };
    engine.session.messages.length = 0;
    engine.session.messages.push(
      { id: "u1", role: "user", content: "list the workspace", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: "Listing it now.", createdAt: "2026-01-01T00:00:01.000Z" },
    );
    engine.session.toolCalls.push({
      id: "call_done",
      name: "read_file",
      input: {},
      summary: "read",
      permission: "allow",
      status: "completed",
      output: "DIR-LISTING-MARKER",
      createdAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    } as unknown as ToolCallRecord);
    // A question-answer observation has no tool-call record — it was never
    // replayed and must stay one-shot (not materialized into history).
    internals.pendingObservations = [
      { callId: "call_done", name: "read_file", output: "DIR-LISTING-MARKER" },
      { callId: "q1", name: "question", output: "User answered: yes" },
    ];

    const modelObservations = internals.toolOutput.modelObservations();

    internals.materializePendingToolResults();

    // The consumed tool result is persisted as an ephemeral user message,
    // positioned after the assistant turn that requested it.
    const materialized = engine.session.messages.find(
      (item) => item.role === "user" && item.content.includes("DIR-LISTING-MARKER"),
    );
    expect(materialized).toBeDefined();
    expect(materialized!.ephemeral).toBe(true);
    // Dual-write: the structured pair rides the same message so providers can
    // render native tool history (the text content stays the fallback).
    expect(materialized!.toolResult).toMatchObject({ callId: "call_done", name: "read_file" });
    expect(modelObservations[0]?.output).toBe(materialized!.toolResult!.output);
    expect(modelObservations[0]?.output).toBe("DIR-LISTING-MARKER");
    expect(engine.session.messages.indexOf(materialized!)).toBeGreaterThan(
      engine.session.messages.findIndex((item) => item.id === "a1"),
    );
    // The non-tool (question) observation is NOT materialized.
    expect(engine.session.messages.some((item) => item.content.includes("User answered"))).toBe(false);

    // Materializing again after clearing pending must not duplicate it.
    internals.pendingObservations = [];
    internals.materializePendingToolResults();
    expect(engine.session.messages.filter((item) => item.content.includes("DIR-LISTING-MARKER")).length).toBe(1);

    await closeEngineRecorder(engine);
  });

  it("spills a single over-cap observation to its on-disk copy (routine turn budget)", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      enforceTurnObservationBudget(): void;
      pendingObservations: ToolObservation[];
    };
    const record = (id: string, outputFile?: string): ToolCallRecord =>
      ({
        id,
        name: "run_shell",
        input: {},
        summary: "sh",
        permission: "allow",
        status: "completed",
        createdAt: nowStamp(),
        completedAt: nowStamp(),
        ...(outputFile ? { outputFile } : {}),
      }) as unknown as ToolCallRecord;
    engine.session.toolCalls.push(
      record("call_huge", ".reina/tool_outputs/call_huge.txt"),
      record("call_small", ".reina/tool_outputs/call_small.txt"),
    );
    // Over the 100k per-result cap — the case an MCP tool output (which
    // bypasses the per-tool caps inside @reina/tools) would hit.
    const huge = "H".repeat(150_000);
    const small = "s".repeat(50_000); // under the cap, total stays under budget after the spill
    internals.pendingObservations = [
      { callId: "call_huge", name: "run_shell", output: huge },
      { callId: "call_small", name: "run_shell", output: small },
      // Non-tool observation (no record / on-disk copy): never spilled.
      { callId: "q1", name: "question", output: "Q".repeat(120_000) },
    ];

    internals.enforceTurnObservationBudget();

    const [spilled, kept, question] = internals.pendingObservations;
    expect(spilled!.output!.length).toBeLessThan(10_000);
    expect(spilled!.output).toContain("Full output saved to");
    expect(spilled!.output).toContain(".reina/tool_outputs/call_huge.txt");
    expect(kept!.output).toBe(small);
    expect(question!.output!.length).toBe(120_000);
    await closeEngineRecorder(engine);
  });

  it("spills largest-first only until the round total fits the turn budget", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      enforceTurnObservationBudget(): void;
      pendingObservations: ToolObservation[];
    };
    for (const id of ["call_a", "call_b", "call_c"]) {
      engine.session.toolCalls.push({
        id,
        name: "run_shell",
        input: {},
        summary: "sh",
        permission: "allow",
        status: "completed",
        createdAt: nowStamp(),
        completedAt: nowStamp(),
        outputFile: `.reina/tool_outputs/${id}.txt`,
      } as unknown as ToolCallRecord);
    }
    // Each under the per-result cap, but 3 × 90k = 270k breaches the 200k
    // aggregate budget — exactly ONE spill (largest first) brings it back under.
    internals.pendingObservations = [
      { callId: "call_a", name: "run_shell", output: "a".repeat(90_000) },
      { callId: "call_b", name: "run_shell", output: "b".repeat(90_001) },
      { callId: "call_c", name: "run_shell", output: "c".repeat(90_000) },
    ];

    internals.enforceTurnObservationBudget();

    const spilled = internals.pendingObservations.filter((o) => o.output!.includes("Full output saved to"));
    expect(spilled).toHaveLength(1);
    expect(spilled[0]!.callId).toBe("call_b");
    const total = internals.pendingObservations.reduce((sum, o) => sum + o.output!.length, 0);
    expect(total).toBeLessThanOrEqual(200_000);
    await closeEngineRecorder(engine);
  });

  it("emergency trim keeps a read_file pointer to the persisted full output", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      trimPendingObservationsForContextOverflow(): { changed: boolean };
      pendingObservations: ToolObservation[];
    };
    engine.session.toolCalls.push({
      id: "call_big",
      name: "run_shell",
      input: {},
      summary: "sh",
      permission: "allow",
      status: "completed",
      createdAt: nowStamp(),
      completedAt: nowStamp(),
      outputFile: ".reina/tool_outputs/call_big.txt",
    } as unknown as ToolCallRecord);
    internals.pendingObservations = [{ callId: "call_big", name: "run_shell", output: "Z".repeat(40_000) }];

    const trim = internals.trimPendingObservationsForContextOverflow();

    expect(trim.changed).toBe(true);
    // The lossy emergency form is no longer a dead end — the full copy on disk
    // is called out so the model can recover it.
    expect(internals.pendingObservations[0]!.output).toContain(".reina/tool_outputs/call_big.txt");
    await closeEngineRecorder(engine);
  });

  it("scales the materialized tool-output preview cap to the model context window", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      materializePendingToolResults(): void;
      pendingObservations: ToolObservation[];
    };
    // One ~10k-char output with a marker buried in the middle: it only survives
    // materialization whole if the per-output preview cap is large enough.
    const bigOutput = `${"x".repeat(5000)}MIDDLE-MARKER${"y".repeat(5000)}`;
    engine.session.toolCalls.length = 0;
    engine.session.toolCalls.push({
      id: "big",
      name: "read_file",
      input: {},
      summary: "r",
      permission: "allow",
      status: "completed",
      output: bigOutput,
      createdAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    } as unknown as ToolCallRecord);

    const materialize = (window: number): string => {
      engine.session.messages.length = 0;
      engine.session.model = { ...engine.session.model, contextWindowTokens: window };
      internals.pendingObservations = [{ callId: "big", name: "read_file", output: bigOutput }];
      internals.materializePendingToolResults();
      internals.pendingObservations = [];
      return engine.session.messages.map((item) => item.content).join("\n");
    };

    // Large window (≥400k): cap (16k) keeps this ~10k output whole.
    const big = materialize(1_000_000);
    expect(big).toContain("MIDDLE-MARKER");
    expect(big).not.toContain("chars truncated");

    // Small window (<32k): tight 4k excerpt — the buried middle is dropped.
    const small = materialize(16_000);
    expect(small).not.toContain("MIDDLE-MARKER");
    expect(small).toContain("chars truncated");

    await closeEngineRecorder(engine);
  });

  it("offloads a large tool output to disk and points replay at the file", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    engine.session.model = { ...engine.session.model, contextWindowTokens: 16_000 }; // replay cap = 4k
    const internals = engine as unknown as {
      persistToolOutput(record: ToolCallRecord, text: string): Promise<void>;
      materializePendingToolResults(): void;
      pendingObservations: ToolObservation[];
    };
    internals.pendingObservations = [];
    engine.session.messages.length = 0;
    engine.session.messages.push(
      { id: "u1", role: "user", content: "go", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: "did it", createdAt: "2026-01-01T00:00:01.000Z" },
    );
    const bigOutput = `${"x".repeat(5000)}MIDDLE-MARKER${"y".repeat(5000)}`;
    const record = {
      id: "call_big_1",
      name: "read_file",
      input: {},
      summary: "r",
      permission: "allow",
      status: "completed",
      output: bigOutput,
      createdAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    } as unknown as ToolCallRecord;

    await internals.persistToolOutput(record, bigOutput);

    // Full output lands on disk verbatim at the recorded relative path.
    expect(record.outputFile).toBe(path.join(".reina", "tool_outputs", "call_big_1.txt"));
    const onDisk = await readFile(path.join(cwd, record.outputFile!), "utf8");
    expect(onDisk).toBe(bigOutput);

    // The materialized preview drops the buried middle (truncated excerpt) but
    // appends a pointer so the model can read_file the complete output on demand.
    engine.session.toolCalls.length = 0;
    engine.session.toolCalls.push(record);
    internals.pendingObservations = [{ callId: "call_big_1", name: "read_file", output: bigOutput }];
    internals.materializePendingToolResults();
    const woven = engine.session.messages.map((item) => item.content).join("\n");
    expect(woven).not.toContain("MIDDLE-MARKER");
    expect(woven).toContain("chars truncated");
    expect(woven).toContain(`Full output saved to ${record.outputFile}`);
    expect(woven).toContain("read_file");

    await closeEngineRecorder(engine);
  });

  it("persists small tool outputs too, but adds no replay pointer when not truncated", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    engine.session.model = { ...engine.session.model, contextWindowTokens: 16_000 }; // replay cap = 4k
    const internals = engine as unknown as {
      persistToolOutput(record: ToolCallRecord, text: string): Promise<void>;
      materializePendingToolResults(): void;
      pendingObservations: ToolObservation[];
    };
    internals.pendingObservations = [];
    engine.session.messages.length = 0;
    engine.session.messages.push(
      { id: "u1", role: "user", content: "go", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: "did it", createdAt: "2026-01-01T00:00:01.000Z" },
    );
    const smallOutput = "tiny result the model keeps in full";
    const record = {
      id: "call_small_1",
      name: "read_file",
      input: {},
      summary: "r",
      permission: "allow",
      status: "completed",
      output: smallOutput,
      createdAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    } as unknown as ToolCallRecord;

    await internals.persistToolOutput(record, smallOutput);

    // Saved to disk even though it's small — full audit trail of every call.
    expect(record.outputFile).toBe(path.join(".reina", "tool_outputs", "call_small_1.txt"));
    expect(await readFile(path.join(cwd, record.outputFile!), "utf8")).toBe(smallOutput);

    // The materialized message shows the full output with NO truncation and NO
    // pointer (the model already has everything it needs inline).
    engine.session.toolCalls.length = 0;
    engine.session.toolCalls.push(record);
    internals.pendingObservations = [{ callId: "call_small_1", name: "read_file", output: smallOutput }];
    internals.materializePendingToolResults();
    const woven = engine.session.messages.map((item) => item.content).join("\n");
    expect(woven).toContain(smallOutput);
    expect(woven).not.toContain("Full output saved to");
    expect(woven).not.toContain("chars truncated");

    await closeEngineRecorder(engine);
  });

  it("backfills out-of-band tool outputs for sessions persisted before the in-band migration", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as { backfillInbandToolResults(): void };
    engine.session.messages.length = 0;
    engine.session.messages.push(
      { id: "u1", role: "user", content: "audit", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: "ran a tool", createdAt: "2026-01-01T00:00:01.000Z" },
    );
    engine.session.toolCalls.push(
      // Within the live window → backfilled.
      {
        id: "call_legacy",
        name: "run_shell",
        input: {},
        summary: "r",
        permission: "execute",
        status: "completed",
        output: "LEGACY-TOOL-OUTPUT",
        createdAt: "2026-01-01T00:00:02.000Z",
        completedAt: "2026-01-01T00:00:03.000Z",
      } as unknown as ToolCallRecord,
      // Before the first message (its conversation was compacted away) → NOT resurrected.
      {
        id: "call_ancient",
        name: "run_shell",
        input: {},
        summary: "r",
        permission: "execute",
        status: "completed",
        output: "ANCIENT-OUTPUT",
        createdAt: "2025-12-31T00:00:00.000Z",
        completedAt: "2025-12-31T00:00:01.000Z",
      } as unknown as ToolCallRecord,
    );

    internals.backfillInbandToolResults();

    const restored = engine.session.messages.find(
      (m) => m.ephemeral === true && m.content.includes("LEGACY-TOOL-OUTPUT"),
    );
    expect(restored).toBeDefined();
    expect(engine.session.messages.some((m) => m.content.includes("ANCIENT-OUTPUT"))).toBe(false);

    // Idempotent: a second pass (session now has in-band tool results) is a no-op.
    internals.backfillInbandToolResults();
    expect(engine.session.messages.filter((m) => m.content.includes("LEGACY-TOOL-OUTPUT")).length).toBe(1);

    await closeEngineRecorder(engine);
  });

  it("strips replayed reasoning suffixes from later tool-loop rounds", () => {
    expect(stripReplayPrefix("second roundnew tail", ["first round", "second round"])).toEqual({
      kind: "matched",
      tail: "new tail",
    });
  });

  it("holds partial reasoning replays until they diverge or complete", () => {
    expect(stripReplayPrefix("second", ["first round", "second round"])).toEqual({
      kind: "partial",
    });
  });

  it("still strips full-history reasoning replays first", () => {
    expect(stripReplayPrefix("first roundsecond roundnew tail", ["first round", "second round"])).toEqual({
      kind: "matched",
      tail: "new tail",
    });
  });

  it("strips replayed assistant text before emitting the next tool-loop round", () => {
    const replayed = "好的，我先审计项目结构。";
    expect(stripReplayPrefix(`${replayed}\nLet me inspect key files.`, [replayed])).toEqual({
      kind: "matched",
      tail: "Let me inspect key files.",
    });
  });

  it("starts new sessions with the stable default title", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });

    expect(engine.session.title).toBe("Reina");
    expect(engine.session.title).not.toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("uses the first user message as the default-title fallback and persists it", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const result = await engine.runTurn("Please optimize delayed session creation so empty drafts are not saved.");
    const title = engine.ensureTitleFromFirstUserMessage();

    expect(title).toBe("Please optimize delayed session creation so empty drafts are not saved.");
    expect(result.session.title).toBe(title);

    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    expect(reopened.session.title).toBe(title);
    await closeEngineRecorder(reopened);
  });

  it("routes controller writes to the live session after loadSession swaps it", async () => {
    // Regression: controllers used to capture session by reference at
    // construction time. loadSession replaces engine.session with a
    // freshly-rehydrated object, so a captured ref pointed at dead state
    // and a tool dispatch after load wrote into the orphan instead of
    // the visible session. The fix is a getter-backed host.
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    await engine.runTurn("hi");
    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    const liveSessionBefore = reopened.session;

    const controllers = reopened as unknown as {
      todos: { write(r: { id: string; name: string; input: unknown }): ToolObservation };
      goals: { create(r: { id: string; name: "create_goal"; input: unknown }): ToolObservation };
    };
    controllers.todos.write({
      id: "call_t",
      name: "write_todos",
      input: { todos: [{ content: "post-load task", activeForm: "doing post-load task", status: "pending" }] },
    });
    controllers.goals.create({
      id: "call_g",
      name: "create_goal",
      input: { objective: "post-load goal" },
    });

    // The mutations must land on the SAME object the rest of the engine
    // reads from (reopened.session). If they wrote into a captured stale
    // ref, reopened.session.todos / goal would still be empty here.
    expect(reopened.session).toBe(liveSessionBefore);
    expect(reopened.session.todos).toHaveLength(1);
    expect(reopened.session.todos[0]?.content).toBe("post-load task");
    expect(reopened.session.goal?.current?.objective).toBe("post-load goal");
    await closeEngineRecorder(reopened);
  });

  it("still treats legacy random placeholders as replaceable default titles", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.title = "Amber Acorn";
    await engine.runTurn("Summarize the workspace setup.");

    expect(engine.ensureTitleFromFirstUserMessage()).toBe("Summarize the workspace setup.");
  });

  it("runs deterministic read tool loops", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const result = await engine.runTurn("read README");
    expect(result.session.toolCalls[0]?.name).toBe("read_file");
    expect(result.session.messages.at(-1)?.content).toContain("completed");
  });

  it("records request-level token estimates even without provider usage", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });

    await engine.runTurn("read README");

    const usage = engine.session.usage;
    expect(usage?.turns).toBe(0);
    expect(usage?.lastRequest?.systemPromptTokens).toBeGreaterThan(0);
    expect(usage?.lastRequest?.toolsCount).toBeGreaterThan(0);
    expect(usage?.lastRequest?.toolNames).toContain("read_file");
    expect(usage?.lastRequest?.estimatedInputTokens).toBeGreaterThanOrEqual(
      (usage?.lastRequest?.systemPromptTokens ?? 0) + (usage?.lastRequest?.toolsTokens ?? 0),
    );
    const cats = usage?.lastRequest?.categories;
    expect(cats).toBeTruthy();
    if (cats) {
      const active =
        cats.systemPromptBase +
        cats.systemPromptSkills +
        cats.systemPromptUserRules +
        cats.messages +
        cats.observations +
        cats.reminders +
        cats.toolsCore +
        cats.toolsMcp;
      const reserved = cats.toolsCoreDeferred + cats.toolsMcpDeferred + cats.autocompactBuffer;
      expect(active).toBe(usage?.lastRequest?.estimatedInputTokens);
      expect(active + reserved + cats.freeSpace).toBe(cats.contextWindow);
    }
    expect(usage?.requestTotals?.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("live context footprint climbs with pending tool output and derives its base from restored usage", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      pendingObservations: ToolObservation[];
      lastContextBase: number | undefined;
      emitLiveContext(): void;
    };

    // An authoritative provider total from a completed request is the base.
    engine.session.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: 50_000,
      contextTokensSource: "provider",
    };

    // No explicit base set yet: liveContextBase() must derive it from the
    // restored provider total, so a reloaded session still anchors correctly.
    internals.lastContextBase = undefined;
    internals.emitLiveContext();
    expect(engine.session.usage!.liveContextTokens).toBe(50_000);

    // A tool produces output → the footprint climbs above the base by the
    // o200k estimate of that pending observation (not yet sent to the model).
    internals.pendingObservations.push({ callId: "c1", name: "read_file", output: COMPACT_FILLER_UNIT.repeat(54) });
    internals.emitLiveContext();
    const afterOne = engine.session.usage!.liveContextTokens!;
    expect(afterOne).toBeGreaterThan(50_000);

    // A second observation climbs further still — the ring tracks growth
    // between model responses instead of freezing at the last total.
    internals.pendingObservations.push({ callId: "c2", name: "read_file", output: COMPACT_FILLER_UNIT.repeat(54) });
    internals.emitLiveContext();
    expect(engine.session.usage!.liveContextTokens!).toBeGreaterThan(afterOne);
  });

  it("does not diagnose 0-read/0-write Anthropic cache responses as TTL misses", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const internals = engine as unknown as {
        diagnoseCachePrefix(usage: unknown, systemPrompt: string, tools: []): void;
      };
      internals.diagnoseCachePrefix({ cacheCreationInputTokens: 0, cachedInputTokens: 0 }, "stable system", []);
      internals.diagnoseCachePrefix({ cacheCreationInputTokens: 0, cachedInputTokens: 0 }, "stable system", []);
      expect(writes).toEqual([]);

      internals.diagnoseCachePrefix({ cacheCreationInputTokens: 12, cachedInputTokens: 0 }, "stable system", []);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("provider rewrote 12 cache tokens");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("flags 0%-cached OpenAI/Codex turns (no write-side reporting) and attributes prefix changes", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const internals = engine as unknown as {
        diagnoseCachePrefix(usage: unknown, systemPrompt: string, tools: []): void;
      };
      // First turn: nothing to compare against — silent.
      internals.diagnoseCachePrefix({ inputTokens: 50_000, outputTokens: 1, cachedInputTokens: 0 }, "sys", []);
      expect(writes).toEqual([]);
      // Unchanged prefix but a cold cache on a big request — the expensive case.
      internals.diagnoseCachePrefix({ inputTokens: 50_000, outputTokens: 1, cachedInputTokens: 0 }, "sys", []);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("miss with unchanged prefix — 0 of 50000 input tokens cached");
      // Healthy hit — silent.
      internals.diagnoseCachePrefix({ inputTokens: 50_000, outputTokens: 1, cachedInputTokens: 40_000 }, "sys", []);
      expect(writes).toHaveLength(1);
      // Prefix change is attributed, not blamed on the provider.
      internals.diagnoseCachePrefix({ inputTokens: 50_000, outputTokens: 1, cachedInputTokens: 0 }, "sys CHANGED", []);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toContain("prefix changed (system)");
      // Provider reports no prompt details at all → diagnostic stays silent.
      internals.diagnoseCachePrefix({ inputTokens: 50_000, outputTokens: 1 }, "sys CHANGED", []);
      // Tiny request below the cacheable minimum → silent.
      internals.diagnoseCachePrefix({ inputTokens: 600, outputTokens: 1, cachedInputTokens: 0 }, "sys CHANGED", []);
      expect(writes).toHaveLength(2);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  // Cold-start baseline: no discovered definitions should be charged to the
  // active-deferred buckets, and the MCP-only hidden reminder is empty when
  // there is no runtime MCP pool. Later tests cover the post-discovery cost.
  it("cold-start has zero active-deferred tools and an empty hidden-tools reminder (no MCP)", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");
    const last = engine.session.usage?.lastRequest;
    const cats = last?.categories;
    expect(cats).toBeTruthy();
    if (!cats || !last) return;
    expect(cats.toolsCoreActiveDeferred ?? 0).toBe(0);
    expect(cats.toolsMcpActiveDeferred ?? 0).toBe(0);
    // The native deferred catalog lives in the cached system prompt now; the
    // per-turn reminder only carries hidden MCP tools, and a cold-start
    // session has no MCP pool — so the sub-bucket is zero.
    expect(cats.hiddenToolsReminder ?? 0).toBe(0);
    // Sub-bucket invariants: the new fields must fit inside their parents.
    expect(cats.hiddenToolsReminder ?? 0).toBeLessThanOrEqual(cats.reminders);
    expect(cats.toolsCoreActiveDeferred ?? 0).toBeLessThanOrEqual(cats.toolsCore);
    expect(cats.toolsMcpActiveDeferred ?? 0).toBeLessThanOrEqual(cats.toolsMcp);
    // No tool in the request was originally deferred, so no detail row
    // carries the activeDeferred flag.
    expect((last.toolDetails ?? []).every((d) => !d.activeDeferred)).toBe(true);
  });

  it("activated deferred tools ship their schemas and count toward the request budget", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      hostBridge: async () => ({ delivered: true }),
    });
    try {
      engine.session.activeDeferredTools = ["notify"];
      await engine.runTurn("read README");
      const last = engine.session.usage?.lastRequest;
      expect(last?.toolNames).toContain("notify");
      expect(last?.categories?.toolsCoreActiveDeferred).toBeGreaterThan(0);
      const details = last?.toolDetails?.filter((d) => d.name === "notify");
      expect(details).toHaveLength(1);
      expect(details?.[0]).toMatchObject({ deferred: false, activeDeferred: true });
      await engine.runTurn("read README");
      expect(engine.session.usage?.lastRequest?.toolNames).toEqual(last?.toolNames);
    } finally {
      await engine.dispose();
    }
  });

  it("exposes subscription-declared server tools natively (kimi web tools)", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      hostBridge: async () => ({ delivered: true }),
    });
    // Mirrors what resolveSubscriptionModel attaches for a kimi-oauth account.
    engine.session.model.subscriptionTools = ["kimi_web_search", "kimi_web_fetch"];
    await engine.runTurn("read README");
    const toolNames = engine.session.usage?.lastRequest?.toolNames ?? [];
    expect(toolNames).toContain("kimi_web_search");
    expect(toolNames).toContain("kimi_web_fetch");

    // Control: without the kimi subscription the tools stay deferred.
    const plain = new AgentEngine({ cwd, agent: "default" });
    await plain.runTurn("read README");
    const plainNames = plain.session.usage?.lastRequest?.toolNames ?? [];
    expect(plainNames).not.toContain("kimi_web_search");
    expect(plainNames).not.toContain("kimi_web_fetch");
  });

  it("lets planned tool calls run before a mid-stream steer lands (codex-aligned)", async () => {
    // Codex does not discard tool calls the model already committed to when a
    // steer arrives mid-stream — it runs the in-flight batch first, then the
    // steer's user message lands AFTER the tool results, and the model answers
    // it on the following turn. Here the steer is injected on the drain call
    // that fires at the iteration boundary AFTER read_file executes.
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      drainPendingSteers(): boolean;
    };
    const originalDrain = internals.drainPendingSteers.bind(engine);
    let drainCount = 0;
    internals.drainPendingSteers = () => {
      drainCount += 1;
      if (drainCount === 2) engine.injectSteer("actually do not read anything");
      return originalDrain();
    };

    const result = await engine.runTurn("read README");

    // The planned read_file actually ran (was committed + executed) rather
    // than being discarded the moment the steer arrived.
    const readCall = result.session.toolCalls.find((call) => call.name === "read_file");
    expect(readCall).toBeDefined();
    expect(readCall?.status).not.toBe("rejected");
    // The steer still landed as a user message, and it was created AFTER the
    // read_file tool call (it drained at the iteration boundary that follows
    // the read) — the tool ran first, then the steer, then the model answered.
    const steerMsg = result.session.messages.find(
      (item) => item.role === "user" && item.content === "actually do not read anything",
    );
    expect(steerMsg).toBeDefined();
    expect((readCall?.createdAt ?? "").localeCompare(steerMsg?.createdAt ?? "")).toBeLessThanOrEqual(0);
    // The model saw the read_file result (now that it ran) and summarized it,
    // rather than hitting the no-tool fallback the discarded path produced.
    expect(result.session.messages.at(-1)?.content).toContain("Tool work completed");
  });

  it("retractSteer withdraws a queued steer before it drains, and refuses once it's gone", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.injectSteer("take this back");
    engine.injectSteer("keep this one");
    expect(engine.retractSteer({ message: "take this back" })).toBe(true);
    // Already withdrawn (same semantics as "already drained"): nothing to pull.
    expect(engine.retractSteer({ message: "take this back" })).toBe(false);
    // The other queued steer is untouched.
    const internals = engine as unknown as { pendingSteers: Array<{ id: string; message: string }> };
    expect(internals.pendingSteers.map((s) => s.message)).toEqual(["keep this one"]);
  });

  it("retractSteer by steerId removes exactly the addressed entry among same-text steers", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const first = engine.injectSteer("continue", undefined, undefined, "steer_renderer_1");
    const second = engine.injectSteer("continue");
    expect(first).toBe("steer_renderer_1");
    // Retract the SECOND same-text steer by id — the first must survive.
    expect(engine.retractSteer({ steerId: second })).toBe(true);
    const internals = engine as unknown as { pendingSteers: Array<{ id: string; message: string }> };
    expect(internals.pendingSteers.map((s) => s.id)).toEqual(["steer_renderer_1"]);
    // A provided id that no longer matches must NOT fall back to text —
    // "not found by id" means that specific steer already drained.
    expect(engine.retractSteer({ steerId: second, message: "continue" })).toBe(false);
    expect(internals.pendingSteers).toHaveLength(1);
  });

  it("does not expose internal or redundant tools by default", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const names = (await engine.availableTools()).map((tool) => tool.name);

    expect(names).not.toContain("search");
    expect(names).not.toContain("invalid_tool");
    expect(names).not.toContain("repo_clone");
    expect(names).not.toContain("mcp_list_tools");
    expect(names).not.toContain("mcp_call_tool");
  });

  it("setSessionMode flips a Codex-style toggle, mutates SessionState, and overlays its tools onto availableTools", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    // Default profile does not carry team tools; team mode overlay does.
    const cold = new Set((await engine.availableTools()).map((t) => t.name));
    expect(cold.has("create_subtask")).toBe(false);
    expect(cold.has("task")).toBe(false);
    expect(cold.has("get_async_tasks")).toBe(false);

    engine.setSessionMode("team", true);
    expect(engine.session.sessionModes?.team).toBe(true);
    const withTeam = new Set((await engine.availableTools()).map((t) => t.name));
    expect(withTeam.has("create_subtask")).toBe(true);
    expect(withTeam.has("task")).toBe(true);
    expect(withTeam.has("get_async_tasks")).toBe(true);

    // Goal is state-owned rather than a session mode.
    expect(engine.session.sessionModes?.goal).toBeUndefined();

    // Idempotent on no-op (same value).
    const beforeIdempotent = engine.session.toolCalls.length;
    engine.setSessionMode("team", true);
    expect(engine.session.toolCalls.length).toBe(beforeIdempotent);

    // Turning off removes the tools again.
    engine.setSessionMode("team", false);
    const afterTeam = new Set((await engine.availableTools()).map((t) => t.name));
    expect(afterTeam.has("create_subtask")).toBe(false);
  });

  it("promotes Goal read/update tools from host state while mechanically hiding duplicate create", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const cold = new Set((await engine.availableTools()).map((tool) => tool.name));
    expect(cold.has("get_goal")).toBe(false);
    expect(cold.has("update_goal")).toBe(false);
    expect(cold.has("create_goal")).toBe(false);

    engine.executeGoalCommand({ type: "create", objective: "ship it" });
    engine.setSessionMode("team", true);
    engine.session.model = { provider: "anthropic-messages", model: "test-model" };
    engine.session.activeDeferredTools = ["create_goal"];
    const active = new Set((await engine.availableTools()).map((tool) => tool.name));
    expect(active.has("get_goal")).toBe(true);
    expect(active.has("update_goal")).toBe(true);
    expect(active.has("create_goal")).toBe(false);
    expect(active.has("create_subtask")).toBe(true);
    expect(engine.session.sessionModes?.team).toBe(true);
    expect(engine.session.goal?.history).toHaveLength(0);
  });

  it("falls back to a primary profile when the requested agent is unknown", () => {
    // Graceful migration: old configs may name a profile that has been
    // renamed or removed. Don't crash — fall back to the first primary
    // profile so the engine keeps working.
    const engine = new AgentEngine({ cwd, agent: "missing-agent" });
    const fallback = profiles.find((p) => p.mode === "primary")!;
    expect(engine.session.agent).toBe(fallback.name);
  });

  it("surfaces completion discipline for the current Goal", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.executeGoalCommand({ type: "create", objective: "finish the feature and verify it" });

    const prompt = buildVolatileContextReminder(engine.session);

    expect(prompt).toContain("## Current Goal");
    expect(prompt).toContain("already created by the host");
    expect(prompt).toContain("update_goal(status=complete");
  });

  it("can mark active goals budget_limited without claiming completion", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const events: string[] = [];
    engine.onStream((event) => {
      if (event.type === "goal-state-changed") events.push(event.state.current?.status ?? "none");
    });
    engine.executeGoalCommand({ type: "create", objective: "finish long audit" });
    const result = executeInternalGoal(
      engine,
      {
        type: "budget_reached",
        reason: "autopilot tokens limit reached after 3 rounds",
      },
      "runtime",
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(engine.session.goal?.current?.status).toBe("blocked");
    expect(engine.session.goal?.current?.terminalReason).toBe("autopilot tokens limit reached after 3 rounds");
    expect(engine.session.goal?.current?.completedAt).toBeTruthy();
    expect(engine.session.goal?.current?.evidence).toBeUndefined();
    expect(events).toEqual(["active", "blocked"]);
  });

  it("preserves pending tool results when the tool loop guard stops a turn", async () => {
    const defaultProfile = profiles.find((profile) => profile.name === "default")!;
    const oldMaxSteps = defaultProfile.maxSteps;
    defaultProfile.maxSteps = 0;
    try {
      const engine = new AgentEngine({ cwd, agent: "default" });
      const events: string[] = [];
      const stop = engine.onStream((event) => {
        if (event.type === "loop-limit") events.push(event.reason);
      });
      const internals = engine as unknown as {
        pendingObservations: ToolObservation[];
        continueLoop(): Promise<void>;
      };
      internals.pendingObservations = [{ callId: "call_1", name: "read_file", output: "important result" }];

      await internals.continueLoop();
      stop();

      expect(internals.pendingObservations).toEqual([]);
      expect(engine.session.providerState).toBeUndefined();
      expect(engine.session.messages.at(-1)?.role).toBe("user");
      expect(engine.session.messages.at(-1)?.content).toContain("important result");
      expect(engine.session.trace.at(-1)?.type).toBe("loop.limit");
      expect(events).toEqual(["hard_max_steps"]);
    } finally {
      defaultProfile.maxSteps = oldMaxSteps;
    }
  });

  it("injects one automatic repair prompt for recoverable tool loop stalls", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const events: string[] = [];
    const stop = engine.onStream((event) => {
      if (event.type === "loop-repair") events.push(event.reason);
    });
    const internals = engine as unknown as {
      pendingObservations: ToolObservation[];
      autoRepairToolLoop(
        stop: ToolLoopStop & { reason: "no_progress" | "repeated_action" | "consecutive_errors" },
      ): void;
    };
    internals.pendingObservations = [{ callId: "call_1", name: "read_file", output: "same file" }];

    internals.autoRepairToolLoop({
      reason: "repeated_action",
      message: "Paused after repeating the same tool action.",
      turnCount: 3,
      maxSteps: 24,
      hardMaxSteps: 96,
    });
    stop();

    expect(internals.pendingObservations).toEqual([]);
    expect(engine.session.providerState).toBeUndefined();
    expect(engine.session.messages.at(-1)?.role).toBe("user");
    expect(engine.session.messages.at(-1)?.content).toContain("Automatic recovery triggered");
    expect(engine.session.messages.at(-1)?.content).toContain("Do not repeat the same tool call");
    expect(engine.session.trace.at(-1)?.type).toBe("loop.repair");
    expect(events).toEqual(["repeated_action"]);
  });

  it("loads workspace config overrides when created asynchronously", async () => {
    await mkdir(path.join(cwd, ".reina"), { recursive: true });
    await writeFile(
      path.join(cwd, ".reina", "config.json"),
      JSON.stringify({
        agent: "default",
        permissionMode: "plan",
        model: { provider: "deterministic", model: "configured" },
      }),
      "utf8",
    );

    const engine = await AgentEngine.create({ cwd });
    try {
      expect(engine.session.agent).toBe("default");
      expect(engine.session.permissionMode).toBe("plan");
      expect(engine.session.model.model).toBe("configured");
    } finally {
      await closeEngineRecorder(engine);
    }
  });

  it("creates global config files when missing", async () => {
    const engine = await AgentEngine.create({ cwd });
    try {
      const config = JSON.parse(await readFile(engine.configPath, "utf8"));
      const mcpConfig = JSON.parse(await readFile(engine.mcpConfigPath, "utf8"));

      expect(engine.configPath).toContain("home-config");
      expect(engine.mcpConfigPath).toContain("mcp.json");
      expect(config.agent).toBe("default");
      expect(config.model.provider).toBe("deterministic");
      expect(config.model.apiKey).toBeUndefined();
      expect(config.mcp).toBeUndefined();
      expect(mcpConfig.servers.example.command).toBe("node");
    } finally {
      await closeEngineRecorder(engine);
    }
  });

  it("creates approval records with previews for write tools", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    await engine.runTurn("run echo hello");
    const approval = engine.session.toolCalls.find((call) => call.status === "pending_approval");

    expect(approval?.name).toBe("run_shell");
    expect(approval?.preview).toContain("Command to run");
  });

  it("auto-allows obvious read-only shell commands", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const result = await engine.runTurn("run whoami");

    expect(result.pendingApprovals).toHaveLength(0);
    expect(engine.session.toolCalls.some((call) => call.name === "run_shell" && call.status === "completed")).toBe(
      true,
    );
  });

  it("emits shell progress events to stream listeners", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const events: string[] = [];
    const stop = engine.onStream((event) => {
      if (event.type === "tool-progress" && event.name === "run_shell") events.push(event.status);
    });

    await engine.runTurn("run whoami");
    stop();

    expect(events).toContain("running");
    expect(events).toContain("completed");
  });

  it("emits progress for read-only tools that do not stream their own progress", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    const events: string[] = [];
    const stop = engine.onStream((event) => {
      if (event.type === "tool-progress" && event.name === "read_file") events.push(event.status);
    });

    await engine.runTurn("read README");
    stop();

    expect(events).toEqual(["running", "completed"]);
  });

  it("does not auto-follow requested background shell tasks; returns a taskId for the model to read", async () => {
    // The engine no longer injects a synthetic task_output after a
    // backgrounded run_shell (that fabricated call_id orphaned the tool
    // result and 400'd OpenAI-compatible providers). run_shell now just
    // returns the taskId; the model reads it via task_output itself.
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    let result = await engine.runTurn("run node -e \"setTimeout(() => console.log('background-follow-ok'), 50)\"");
    const approval = result.pendingApprovals[0];

    expect(approval?.name).toBe("run_shell");
    result = await engine.resolveApproval(approval!.id, true, {
      updatedInput: {
        command: "node -e \"setTimeout(() => console.log('background-follow-ok'), 50)\"",
        runInBackground: true,
      },
    });

    expect(result.session.toolCalls.some((call) => call.name === "task_output")).toBe(false);
    const runShell = result.session.toolCalls.find((call) => call.name === "run_shell");
    const runShellOutput = runShell?.output ?? "";
    expect(runShell?.status).toBe("completed");
    expect(runShellOutput).toContain('"background": "requested"');
    expect(runShellOutput).toMatch(/"taskId":\s*"shell_/);
    const taskId = runShellOutput.match(/"taskId":\s*"(shell_[^"]+)"/)?.[1];
    if (!taskId) throw new Error("expected background run_shell to return a taskId");
    await runTool("task_output", { taskId, block: true, timeoutMs: 2000 }, { cwd });
  });

  it("keeps background lifecycle tools stable after first use and session reload", async () => {
    // Fixes the "kill_shell: command not found" failure mode: when the model
    // holds a shell_<id>, the lifecycle tools must be real callable tools (not
    // deferred), or it types the tool name into run_shell → bash exit 127.
    const engine = await AgentEngine.create({ cwd, agent: "default", permissionMode: "default" });
    const lifecycle = ["task_output", "kill_shell", "monitor", "write_stdin"];
    let reopened: AgentEngine | undefined;
    try {
      engine.backgroundShellTaskCount = () => 0;
      const cold = (await engine.availableTools()).map((tool) => tool.name);
      for (const name of lifecycle) expect(cold).not.toContain(name);

      engine.backgroundShellTaskCount = () => 1;
      const warm = await engine.availableTools();
      for (const name of lifecycle) expect(warm.map((tool) => tool.name)).toContain(name);
      // Compare full definitions and ordering from the FIRST promoted request.
      for (const running of [1, 0, 1, 0]) {
        engine.backgroundShellTaskCount = () => running;
        expect(await engine.availableTools()).toEqual(warm);
      }

      await engine.saveSession();
      await closeEngineRecorder(engine);
      reopened = await AgentEngine.create({ cwd, agent: "default" });
      await reopened.loadSession(engine.session.id);
      expect(reopened.backgroundShellTaskCount()).toBe(0);
      expect(await reopened.availableTools()).toEqual(warm);
    } finally {
      await closeEngineRecorder(engine);
      if (reopened) await closeEngineRecorder(reopened);
    }
  });

  it.each<Partial<AgentProfile>>([
    { tools: ["read_file", "task_output"] },
    { toolPermissions: { kill_shell: "deny", monitor: "deny", write_stdin: "deny" } },
  ])("respects profile restrictions before and after background tool promotion: %j", async (restriction) => {
    const base = resolveProfile("default");
    const profile = { ...base, ...restriction, name: "test-background-cache" };
    profiles.push(profile);
    const engine = new AgentEngine({ cwd, agent: profile.name });
    const restricted = ["kill_shell", "monitor", "write_stdin"];
    try {
      engine.backgroundShellTaskCount = () => 1;
      const initial = (await engine.availableTools()).map((tool) => tool.name);
      expect(initial).toContain("task_output");
      for (const name of restricted) {
        expect(initial).not.toContain(name);
        expect(engine.session.activeDeferredTools ?? []).not.toContain(name);
      }

      profile.tools = base.tools;
      profile.toolPermissions = base.toolPermissions;
      const allowed = (await engine.availableTools()).map((tool) => tool.name);
      for (const name of restricted) expect(allowed).toContain(name);

      engine.backgroundShellTaskCount = () => 0;
      Object.assign(profile, restriction);
      const narrowed = (await engine.availableTools()).map((tool) => tool.name);
      expect(narrowed).toContain("task_output");
      for (const name of restricted) {
        expect(engine.session.activeDeferredTools).toContain(name);
        expect(narrowed).not.toContain(name);
      }
    } finally {
      profiles.splice(profiles.indexOf(profile), 1);
      await closeEngineRecorder(engine);
    }
  });

  it("can remember exact shell approvals for the current session", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "default" });
    let result = await engine.runTurn("run echo hello");
    const approval = result.pendingApprovals[0];

    expect(approval?.name).toBe("run_shell");
    result = await engine.resolveApproval(approval!.id, true, { remember: "session" });
    expect(result.pendingApprovals).toHaveLength(0);

    result = await engine.runTurn("run echo hello");
    expect(result.pendingApprovals).toHaveLength(0);
  });

  it("runs task through a subagent", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const result = await engine.runTurn("task read README");

    expect(result.session.toolCalls.some((call) => call.name === "task" && call.status === "completed")).toBe(true);
  });

  it("loads workspace skills into session context", async () => {
    await mkdir(path.join(cwd, ".claude", "skills", "review"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code changes\nallowed-tools: read_file run_shell\n---\nUse this for code review.",
      "utf8",
    );

    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");

    expect(engine.session.skills.find((s) => s.name === "review")).toBeDefined();
    expect(engine.session.trace.some((event) => event.type === "turn.completed")).toBe(true);
  });

  it("exposes the subagent-delegation builtin skill without any workspace skill setup", async () => {
    // The supervisor fan-out guidance used to live in the system prompt and
    // bloated every cold-start turn by ~1.5-2k tokens. It is now a built-in
    // skill the model pulls on demand via read_skill — verify the entry is
    // present by default so the model can actually discover it.
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");

    const builtin = engine.session.skills.find((s) => s.name === "subagent-delegation");
    expect(builtin).toBeDefined();
    expect(builtin?.path.startsWith("builtin:")).toBe(true);
  });

  it("supervisor system prompt carries the crib note + skill index, not the full fan-out playbook", async () => {
    // Regression guard for the prompt-shrink work: the full body must not
    // appear on a cold turn; the model should see a short crib pointing to
    // read_skill("subagent-delegation") instead.
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");

    const prompt = buildSystemPrompt(engine.session);
    expect(prompt).not.toContain("Daisy-chain: workers cannot themselves spawn");
    expect(prompt).not.toContain("Wrong-tool pitfalls");
    expect(prompt).toContain("subagent-delegation");
    expect(prompt).toContain('read_skill("subagent-delegation")');
  });

  it("read_skill returns the subagent-delegation builtin body when no workspace file shadows it", async () => {
    const observation = await runTool("read_skill", { name: "subagent-delegation" }, { cwd });
    expect(observation.error).toBeUndefined();
    expect(observation.output).toContain("Anti-patterns");
    expect(observation.output).toContain("Daisy-chain: workers cannot themselves spawn");
  });

  it("workspace SKILL.md shadows a same-named builtin skill", async () => {
    // Escape hatch: users can drop their own .claude/skills/<name>/SKILL.md
    // to override a shipped builtin. Verify the workspace copy wins.
    await mkdir(path.join(cwd, ".claude", "skills", "subagent-delegation"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "skills", "subagent-delegation", "SKILL.md"),
      "---\nname: subagent-delegation\ndescription: workspace override\n---\nworkspace-only body",
      "utf8",
    );

    const observation = await runTool("read_skill", { name: "subagent-delegation" }, { cwd });
    expect(observation.output).toContain("workspace-only body");
    expect(observation.output).not.toContain("Daisy-chain");
  });

  it("deferred tools are NOT in the cold-start tool array", async () => {
    // The deferred candidates (notify, schedule_wakeup, web_fetch,
    // kill_shell, monitor, task_output, exit_plan_mode,
    // mcp_*, update_async_task, cancel_async_task,
    // get_async_tasks, and note mutations) should not appear in availableTools
    // until the session unmasks them via search_tool or direct call. This is
    // the token-saving mechanism — keeps the cold-start request small.
    const engine = new AgentEngine({ cwd, agent: "default" });
    const names = (await engine.availableTools()).map((t) => t.name);
    expect(names).not.toContain("notify");
    expect(names).not.toContain("schedule_wakeup");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("mcp_status");
    expect(names).not.toContain("update_async_task");
    expect(names).not.toContain("note");
    expect(names).not.toContain("update_note");
    expect(names).not.toContain("delete_note");
    // search_tool itself must be direct — it's the discovery entry point.
    expect(names).toContain("search_tool");
    // The frequently-used core tools must remain direct.
    expect(names).toContain("read_file");
    expect(names).toContain("run_shell");
    expect(names).toContain("list_notes");
    expect(names).toContain("read_note");
    expect(names).not.toContain("task");
    expect(names).not.toContain("start_async_task");
    expect(names).not.toContain("get_async_tasks");
  });

  it("native deferred catalog lives INSIDE the cached system prompt; per-turn reminder is MCP-only", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");
    const prompt = buildSystemPrompt(engine.session);
    // The native catalog is static per build, so it belongs in the cached
    // [system + tools] prefix — paying cache-read prices per round instead of
    // the full-price per-round re-injection the reminder used to cost.
    // Discovery does not change these compiled capability counts, so the
    // system-prompt bytes stay stable even when the tools array later grows.
    expect(prompt).toContain("## Deferred tools (on demand)");
    const catalog = formatDeferredToolsCatalog();
    expect(catalog).toContain("- Async workers (8)");
    expect(catalog).toContain("- Notes (3)");
    expect(catalog).not.toContain("start_async_task");
    expect(catalog).not.toContain("update_note");
    expect(catalog).toContain("search_tool({ query:");
    // The static system prompt remains byte-stable across turns.
    expect(buildSystemPrompt(engine.session)).toBe(prompt);
    // With no MCP pool there is nothing left for the per-turn reminder.
    const reminder = buildHiddenToolsReminder();
    expect(reminder).toBe("");
  });

  it("MCP guidance distinguishes visible tools from configured tools that are still hidden", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.mcpServerNamesSnapshot = ["github", "slack"];
    const prompt = buildSystemPrompt(engine.session);

    expect(prompt).toContain("Resident or already activated server tools appear in your tool list");
    expect(prompt).toContain("still hidden, use `search_tool` to discover and activate the exact schema");
    expect(prompt).not.toContain("appear in your tool list — prefer those");
  });

  it("search_tool returns matching deferred tools and surfaces unmaskTools metadata", async () => {
    const observation = await runTool("search_tool", { query: "notify" }, { cwd });
    expect(observation.error).toBeUndefined();
    // Phase 1.2: matches render as <tool name="..."> blocks with an <input>
    // param summary, not the legacy `name: summary` one-liner.
    expect(observation.output).toContain('<tool name="notify">');
    expect((observation as any).metadata?.unmaskTools).toContain("notify");
  });

  it("search_tool exposes note mutations deferred from the default catalog", async () => {
    const observation = await runTool("search_tool", { query: "note" }, { cwd });
    const metadata = (observation as ToolObservation & { metadata?: { unmaskTools?: string[] } }).metadata;
    expect(observation.error).toBeUndefined();
    expect(observation.output).toContain('<tool name="note">');
    expect(observation.output).toContain('<tool name="update_note">');
    expect(observation.output).toContain('<tool name="delete_note">');
    expect(metadata?.unmaskTools).toEqual(expect.arrayContaining(["note", "update_note", "delete_note"]));
  });

  it("search_tool falls back to token overlap when no exact substring matches", async () => {
    // "send notification to user" doesn't substring-match "notify" but token
    // "notification" sits in notify's catalog summary — verify the
    // overlap fallback kicks in so loose queries still work.
    const observation = await runTool("search_tool", { query: "send notification user" }, { cwd });
    expect(observation.output).toContain('<tool name="notify">');
    expect((observation as any).metadata?.unmaskTools).toContain("notify");
  });

  it("invoking a deferred tool directly auto-unmasks it for the rest of the session", async () => {
    // Models that already know a tool name should be able to call it without
    // first calling search_tool. The engine auto-unmasks on direct invocation
    // and persists the unmask via a rollout event so reload restores it.
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "plan" });
    await engine.runTurn("exit plan inspect first.");
    // exit_plan_mode is deferred but the deterministic prompt emitted it
    // directly. The engine fallback should have unmasked it (state
    // tracking still works post-Phase 1.3).
    expect(engine.session.activeDeferredTools).toContain("exit_plan_mode");
    // Subsequent requests carry the discovered definition too.
    const names = (await engine.availableTools()).map((t) => t.name);
    expect(names).toContain("exit_plan_mode");
  });

  // MCP tools are listed in the hidden-tools reminder so the model
  // knows what's discoverable even before calling search_tool. They stay
  // per-turn (unlike the static native catalog in the system prompt) because
  // the MCP pool is runtime-dynamic — servers connect and drop mid-session.
  it("buildHiddenToolsReminder lists hidden MCP runtime tools", () => {
    const fakeMcpPool = [
      {
        name: "mcp__github__create_issue" as ChatMessage["role"] extends never ? never : "mcp__github__create_issue",
        description: "[MCP:github] Create a GitHub issue.",
        permission: "execute" as const,
        requiresApproval: true,
        inputSchema: { _def: {} } as never,
      },
      {
        name: "mcp__slack__post_message" as "mcp__slack__post_message",
        description: "[MCP:slack] Post a message to a Slack channel.",
        permission: "execute" as const,
        requiresApproval: true,
        inputSchema: { _def: {} } as never,
      },
    ];
    const reminder = buildHiddenToolsReminder(fakeMcpPool as never);
    expect(reminder).toContain("## Hidden tools");
    // Native deferred names do NOT ride the reminder anymore — the static
    // catalog lives in the cached system prompt (formatDeferredToolsCatalog).
    expect(reminder).not.toMatch(/^ {2}- notify —/m);
    // MCP tools render on a line that calls out the server count.
    expect(reminder).toContain("Hidden MCP tools (2 across 2 servers)");
    expect(reminder).toContain("mcp__github__create_issue");
    expect(reminder).toContain("mcp__slack__post_message");
  });

  it("buildHiddenToolsReminder filters out definitions already present in the tools array", () => {
    // The github definition is visible, so re-advertising it as hidden would
    // be wrong. The slack definition is absent and must remain discoverable.
    const fakeMcpPool = [
      {
        name: "mcp__github__create_issue" as "mcp__github__create_issue",
        description: "[MCP:github] Create a GitHub issue.",
        permission: "execute" as const,
        requiresApproval: true,
        inputSchema: { _def: {} } as never,
      },
      {
        name: "mcp__slack__post_message" as "mcp__slack__post_message",
        description: "[MCP:slack] Post a message to a Slack channel.",
        permission: "execute" as const,
        requiresApproval: true,
        inputSchema: { _def: {} } as never,
      },
    ];
    const reminder = buildHiddenToolsReminder(fakeMcpPool as never, ["mcp__github__create_issue"]);
    expect(reminder).not.toContain("mcp__github__create_issue");
    expect(reminder).toContain("mcp__slack__post_message");
    expect(reminder).toContain("Hidden MCP tools (1 across 1 server)");
  });

  it("loadMcpResidencyPolicy returns empty when no reina.json exists (resident-by-default)", async () => {
    // No reina.json at all → engine should treat every enabled server as
    // resident. Empty set = "promote everything" downstream.
    const policy = await loadMcpResidencyPolicy(cwd);
    expect(policy.deferredServers.size).toBe(0);
  });

  it("loadMcpResidencyPolicy reads deferredServers from the global reina.json", async () => {
    await mkdir(path.join(cwd, "home-config"), { recursive: true });
    await writeFile(
      path.join(cwd, "home-config", "config.json"),
      JSON.stringify({ mcp: { deferredServers: ["chrome-devtools", "playwright"] } }),
      "utf8",
    );
    const policy = await loadMcpResidencyPolicy(cwd);
    expect(policy.deferredServers.has("chrome-devtools")).toBe(true);
    expect(policy.deferredServers.has("playwright")).toBe(true);
    expect(policy.deferredServers.has("codegraph")).toBe(false);
  });

  it("loadMcpResidencyPolicy unions global + workspace deferredServers", async () => {
    // Global config defers one server; workspace overlay defers another.
    // Both should end up in the resulting set so per-workspace overrides
    // can ADD to (not replace) the global policy.
    await mkdir(path.join(cwd, "home-config"), { recursive: true });
    await writeFile(
      path.join(cwd, "home-config", "config.json"),
      JSON.stringify({ mcp: { deferredServers: ["global-only"] } }),
      "utf8",
    );
    await mkdir(path.join(cwd, ".reina"), { recursive: true });
    await writeFile(
      path.join(cwd, ".reina", "config.json"),
      JSON.stringify({ mcp: { deferredServers: ["workspace-only"] } }),
      "utf8",
    );
    const policy = await loadMcpResidencyPolicy(cwd);
    expect(policy.deferredServers.has("global-only")).toBe(true);
    expect(policy.deferredServers.has("workspace-only")).toBe(true);
  });

  it("loadMcpResidencyPolicy survives a malformed reina.json", async () => {
    // Typo in JSON would otherwise crash session start; loader swallows
    // parse errors and returns whatever loaded so far (here: nothing).
    await mkdir(path.join(cwd, "home-config"), { recursive: true });
    await writeFile(path.join(cwd, "home-config", "config.json"), "{ this is not json", "utf8");
    const policy = await loadMcpResidencyPolicy(cwd);
    expect(policy.deferredServers.size).toBe(0);
  });

  it("stores plans and pending questions", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("plan inspect first, then edit");
    const result = await engine.runTurn("question Which file should I inspect?");

    expect(engine.session.plan?.content).toContain("inspect first");
    expect(result.pendingQuestions.some((question) => question.question.includes("Which file"))).toBe(true);
    expect(engine.session.messages.at(-1)?.content).not.toContain("Tool work completed");

    const question = result.pendingQuestions[0]!;
    const resumed = await engine.answerQuestion(question.id, "README.md");
    expect(resumed.pendingQuestions).toHaveLength(0);
    expect(engine.session.pendingQuestions[0]?.answer).toBe("README.md");
  });

  it("approves a plan via exit_plan_mode and exits plan mode", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "plan" });
    const result = await engine.runTurn("exit plan inspect file. then edit.");

    const question = result.pendingQuestions.find((q) => q.intent === "exit_plan_mode");
    expect(question).toBeDefined();
    expect(question?.options?.[0]?.label).toContain("Approve");
    expect(question?.intentPayload).toContain("inspect file");
    expect(engine.session.plan?.status).toBe("draft");
    expect(engine.session.permissionMode).toBe("plan");

    const approveLabel = question!.options![0]!.label;
    const resumed = await engine.answerQuestion(question!.id, approveLabel);

    expect(resumed.pendingQuestions).toHaveLength(0);
    expect(engine.session.plan?.status).toBe("approved");
    expect(engine.session.permissionMode).toBe("default");
    expect(engine.session.trace.some((e) => e.type === "exit_plan_mode.approved")).toBe(true);
  });

  it("escalates with a repeated_failure banner when the model repeats the same failing tool call", async () => {
    // Use a real-but-unreadable file so read_file actually errors (a
    // missing path now returns a recoverable response, not an error).
    await writeFile(path.join(cwd, "blob.zip"), Buffer.from([0, 1, 2, 3]));
    const engine = new AgentEngine({ cwd, agent: "default" });
    // First failed call: no banner yet.
    const r1 = await engine.runTurn("readpath blob.zip");
    const first = r1.session.toolCalls.at(-1);
    expect(first?.name).toBe("read_file");
    expect(first?.error).toContain("cannot read binary file");
    expect(first?.error).not.toContain("repeated_failure");
    // Second identical call: should get the escalation banner.
    const r2 = await engine.runTurn("readpath blob.zip");
    const second = r2.session.toolCalls.at(-1);
    expect(second?.error).toContain("repeated_failure");
    expect(second?.error).toContain("STOP");
    // The original error must still be present below the banner.
    expect(second?.error).toContain("cannot read binary file");
    // Third identical call: the loop-gate refuses to execute it at all —
    // the synthesized error carries no fresh execution output.
    const r3 = await engine.runTurn("readpath blob.zip");
    const third = r3.session.toolCalls.at(-1);
    expect(third?.error).toContain("loop_gate");
    expect(third?.error).toContain("NOT executed");
    expect(third?.error).not.toContain("cannot read binary file");
  });

  it("does not loop-gate a repeated call when a different call broke the streak", async () => {
    await writeFile(path.join(cwd, "blob.zip"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(cwd, "readable.txt"), "hello");
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("readpath blob.zip");
    await engine.runTurn("readpath blob.zip");
    // A different (successful) call resets the consecutive streak…
    await engine.runTurn("readpath readable.txt");
    // …so the third identical attempt still EXECUTES (banner, not gate).
    const r = await engine.runTurn("readpath blob.zip");
    const last = r.session.toolCalls.at(-1);
    expect(last?.error).toContain("cannot read binary file");
    expect(last?.error).not.toContain("loop_gate");
  });

  it("keeps iterating when the user rejects exit_plan_mode", async () => {
    const engine = new AgentEngine({ cwd, agent: "default", permissionMode: "plan" });
    const result = await engine.runTurn("exit plan first draft");

    const question = result.pendingQuestions.find((q) => q.intent === "exit_plan_mode");
    expect(question).toBeDefined();
    const iterateLabel = question!.options![1]!.label;
    const resumed = await engine.answerQuestion(question!.id, iterateLabel);

    expect(resumed.pendingQuestions).toHaveLength(0);
    expect(engine.session.plan?.status).toBe("draft");
    expect(engine.session.permissionMode).toBe("plan");
    expect(engine.session.trace.some((e) => e.type === "exit_plan_mode.iterating")).toBe(true);
  });

  it("compacts model context without deleting transcript history", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 24_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const originalTranscriptLength = engine.session.messages.length;
    const events: ModelStreamEvent[] = [];
    engine.onStream((event) => events.push(event));

    const result = await engine.runTurn("read README");

    expect(result.session.messages.length).toBeGreaterThan(originalTranscriptLength);
    expect(result.session.modelMessages).toBeDefined();
    expect(result.session.modelMessages!.length).toBeLessThan(result.session.messages.length);
    expect(result.session.summary).toContain("old user detail");
    const boundary = result.session.compactBoundaries?.at(-1);
    expect(boundary?.type).toBe("auto");
    expect(boundary?.compactType).toBe("auto");
    expect(boundary?.historyPath).toContain(".reina");
    expect(boundary?.preservedSegment?.preservedMessageIds.length).toBeGreaterThan(0);
    expect(boundary?.reinjectedMessageIds?.length).toBeGreaterThan(0);
    const history = await readFile(path.join(cwd, boundary!.historyPath!), "utf8");
    expect(history).toContain("old user detail 0");
    expect(result.session.providerState).toBeUndefined();
    const compactionEvents = events.filter(
      (event) => event.type === "context-compaction-started" || event.type === "context-compacted",
    );
    expect(compactionEvents.map((event) => event.type)).toEqual(["context-compaction-started", "context-compacted"]);
    expect(compactionEvents[0]).toMatchObject({ compactType: "auto" });
  });

  it("preflight compacts before a follow-up request when pending tool output tips it over the window", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    // A real transcript with a droppable prefix (so an actual compaction can
    // run), while the provider total reports we sit JUST under the threshold.
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const threshold = autoCompactThreshold(engine.session.model);
    engine.session.usage = {
      inputTokens: threshold - 1_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: threshold - 1_000,
      contextTokensSource: "provider",
    };
    const internals = engine as unknown as {
      pendingObservations: ToolObservation[];
      preflightContext(): Promise<void>;
    };

    // Follow-up with NO pending output: history alone is under the line, so the
    // preflight leaves it be (the old guard's behavior for this case).
    internals.pendingObservations = [];
    await internals.preflightContext();
    expect(engine.session.compactBoundaries ?? []).toHaveLength(0);

    // Now a large tool result is queued for the NEXT model request. Even though
    // the user typed nothing, the preflight must compact before issuing it —
    // this is the path the old `pendingObservations.length === 0` guard skipped.
    internals.pendingObservations = [
      { callId: "call_big", name: "read_file", output: COMPACT_FILLER_UNIT.repeat(220) },
    ];
    await internals.preflightContext();
    expect((engine.session.compactBoundaries ?? []).length).toBeGreaterThan(0);
    expect(engine.session.compactBoundaries!.at(-1)?.compactType).toBe("auto");

    // The pending tool result must NOT be dropped by the compaction — its
    // tool_use pairing has to survive so it can still be woven into the request.
    expect(internals.pendingObservations).toHaveLength(1);
    expect(internals.pendingObservations[0].output).toContain("Lorem ipsum");

    await closeEngineRecorder(engine);
  });

  it("resets the codex auto-compaction window after compacting (drops the stale provider peak + baseline)", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const threshold = autoCompactThreshold(engine.session.model);
    // Sit well above the threshold with a baseline from the PRIOR window, as a
    // long stuck session would.
    engine.session.usage = {
      inputTokens: threshold + 5_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: threshold + 5_000,
      contextTokensSource: "provider",
      autoCompactBaseline: threshold - 10_000,
    };

    const boundary = await engine.compactNow("window reset test");
    expect(boundary).toBeDefined();
    // The stale pre-compaction peak is replaced by the post-compaction estimate
    // (source "estimate": sessionContextTokens ignores it and recomputes, while
    // renderers show the drop immediately), and the window baseline is cleared
    // so the next provider total re-seeds it (codex AutoCompactWindow.start_next).
    expect(engine.session.usage?.contextTokens).toBe(boundary!.estimatedTokensAfter);
    expect(engine.session.usage?.contextTokensSource).toBe("estimate");
    expect(engine.session.usage?.autoCompactBaseline).toBeUndefined();

    // Immediately after compaction the trigger must NOT want to re-fire — this
    // is the thrash the body-after-prefix window exists to prevent.
    const internals = engine as unknown as { preflightContext(): Promise<void> };
    expect(shouldAutoCompactSession(engine.session).shouldCompact).toBe(false);
    await internals.preflightContext();
    expect(engine.session.compactBoundaries ?? []).toHaveLength(1);

    await closeEngineRecorder(engine);
  });

  it("no-usage provider: the first post-compaction measure seeds the baseline instead of churning the summarizer", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const threshold = autoCompactThreshold(engine.session.model);
    const boundary = await engine.compactNow("estimate-path churn guard test");
    expect(boundary).toBeDefined();
    expect(engine.session.usage?.autoCompactBaseline).toBeUndefined();

    // The first post-compaction request measures OVER the threshold (the prefix
    // plus whatever compaction keeps verbatim can exceed it on a small window)
    // and the provider reports no usage. The measure must seed the baseline…
    const measuredAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const breakdown = (autocompactEstimate: number, createdAt: string) => ({
      createdAt,
      provider: "deterministic",
      model: "small-context-test",
      messagesCount: 4,
      observationsCount: 0,
      toolsCount: 0,
      systemPromptChars: 0,
      systemPromptTokens: 0,
      messagesChars: 0,
      messagesTokens: 0,
      observationsChars: 0,
      observationsTokens: 0,
      toolsDescriptionChars: 0,
      toolsSchemaChars: 0,
      toolsTokens: 0,
      totalChars: 0,
      estimatedInputTokens: autocompactEstimate,
      toolNames: [],
      categories: { autocompactEstimate },
    });
    const internals = engine as unknown as {
      accumulateUsage(usage: unknown, requestBreakdown?: unknown): void;
    };
    internals.accumulateUsage(undefined, breakdown(threshold + 1_000, measuredAt(1_000)));
    expect(engine.session.usage?.autoCompactBaseline).toBe(threshold + 1_000);
    // …so the fresh-but-unshrinkable footprint does NOT re-fire the trigger.
    expect(shouldAutoCompactSession(engine.session).shouldCompact).toBe(false);

    // Genuine growth past the body budget still fires — and the seed is
    // first-measure-only, never overwritten by later requests.
    const bodyLimit = autoCompactBodyLimit(engine.session.model);
    internals.accumulateUsage(undefined, breakdown(threshold + 1_000 + bodyLimit, measuredAt(2_000)));
    expect(engine.session.usage?.autoCompactBaseline).toBe(threshold + 1_000);
    expect(shouldAutoCompactSession(engine.session).shouldCompact).toBe(true);

    await closeEngineRecorder(engine);
  });

  it("derives autocompact threshold from the model context window", () => {
    expect(autoCompactThreshold({ provider: "anthropic-messages", model: "claude-sonnet-4" })).toBe(167000);
    expect(autoCompactThreshold({ provider: "anthropic-messages", model: "claude-sonnet-4[1m]" })).toBe(930000);
    expect(autoCompactThreshold({ provider: "openai-chat", model: "small", contextWindowTokens: 50_000 })).toBe(17000);
  });

  it("forkToMessage after a compaction carries the summary over instead of replaying raw history", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const boundary = await engine.compactNow("fork reuse test");
    expect(boundary).toBeDefined();
    // A post-compaction turn lands in BOTH views, exactly like appendMessage does live.
    const internals = engine as unknown as { appendMessage(item: ChatMessage): void };
    const afterCompact = testMessage("user", "after compact question");
    internals.appendMessage(afterCompact);
    const droppedAnswer = testMessage("assistant", "after compact answer");
    internals.appendMessage(droppedAnswer);

    // The cut point survives in the compacted model view, so the summary only
    // describes kept history — the branch must reuse it (codex parity: the
    // Compacted checkpoint is part of the kept rollout prefix).
    const forked = await engine.forkToMessage(afterCompact.id);
    expect(forked.summary).toBe(engine.session.summary);
    expect(forked.compactBoundaries).toHaveLength(1);
    expect(forked.modelMessages).toBeDefined();
    expect(forked.modelMessages!.at(-1)!.id).toBe(afterCompact.id);
    expect(forked.modelMessages!.some((item) => item.id === droppedAnswer.id)).toBe(false);
    expect(forked.messages.at(-1)!.id).toBe(afterCompact.id);
    // The branch resumes at the compacted footprint, so its first request must
    // NOT re-trigger auto-compaction (the churn this reuse exists to prevent).
    expect(forked.modelMessages!.length).toBeLessThan(forked.messages.length);
    expect(shouldAutoCompactSession(forked).shouldCompact).toBe(false);
    // Mutating the branch's boundary list must not leak into the source.
    forked.compactBoundaries!.pop();
    expect(engine.session.compactBoundaries).toHaveLength(1);
    await closeEngineRecorder(engine);
  });

  it("forkToMessage into the compacted-away region discards the summary that covers dropped content", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const earliest = engine.session.messages[0]!;
    const boundary = await engine.compactNow("fork discard test");
    expect(boundary).toBeDefined();
    expect(engine.session.modelMessages!.some((item) => item.id === earliest.id)).toBe(false);

    // Rewinding INTO the summarized region: the summary describes messages the
    // branch just dropped, so reusing it would leak the rewound future — the
    // branch must rebuild from raw history instead.
    const forked = await engine.forkToMessage(earliest.id);
    expect(forked.modelMessages).toBeUndefined();
    expect(forked.summary).toBeUndefined();
    expect(forked.compactBoundaries).toBeUndefined();
    await closeEngineRecorder(engine);
  });

  it("rollbackToMessage after a compaction keeps the summary in place (in-place rewind, same rule as fork)", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    for (let index = 0; index < 14; index++) {
      engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      engine.session.messages.push(
        testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const boundary = await engine.compactNow("rollback reuse test");
    expect(boundary).toBeDefined();
    const internals = engine as unknown as { appendMessage(item: ChatMessage): void };
    const afterCompact = testMessage("user", "after compact question");
    internals.appendMessage(afterCompact);

    // 撤回 the post-compaction user message: the cut point survives in the
    // compacted view, so the session must NOT fall back to raw history.
    await engine.rollbackToMessage(afterCompact.id);
    expect(engine.session.summary).toBeDefined();
    expect(engine.session.compactBoundaries).toHaveLength(1);
    expect(engine.session.modelMessages).toBeDefined();
    expect(engine.session.modelMessages!.some((item) => item.id === afterCompact.id)).toBe(false);
    expect(shouldAutoCompactSession(engine.session).shouldCompact).toBe(false);
    await closeEngineRecorder(engine);
  });

  it("fork production path: the branch RELOADED from its rollout still carries the compaction products", async () => {
    // Mirrors agent-host forkSession exactly: forkToMessage persists the branch,
    // then a FRESH engine loadSession()s it from disk. If the session_replace
    // round trip dropped modelMessages/summary, the in-memory fix would be moot.
    const { engine, internals } = await makeCompactedEngine();
    const afterCompact = testMessage("user", "after compact question");
    internals.appendMessage(afterCompact);

    const forked = await engine.forkToMessage(afterCompact.id);
    const reloaded = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    await reloaded.loadSession(forked.id);
    expect(reloaded.session.summary).toBe(engine.session.summary);
    expect(reloaded.session.compactBoundaries).toHaveLength(1);
    expect(reloaded.session.modelMessages).toBeDefined();
    expect(reloaded.session.modelMessages!.at(-1)!.id).toBe(afterCompact.id);
    expect(shouldAutoCompactSession(reloaded.session).shouldCompact).toBe(false);
    // The branch's first preflight must not mint a new boundary.
    const reloadedInternals = reloaded as unknown as { preflightContext(): Promise<void> };
    await reloadedInternals.preflightContext();
    expect(reloaded.session.compactBoundaries).toHaveLength(1);
    await closeEngineRecorder(reloaded);
    await closeEngineRecorder(engine);
  });

  it("fork at a PRESERVED-tail message reuses the summary (id lookup, not timestamps — preserved messages predate the boundary)", async () => {
    const { engine, boundary } = await makeCompactedEngine();
    // Preserved messages were created BEFORE boundary.createdAt: a
    // timestamp-based reuse check would wrongly discard here.
    const preservedId = boundary.preservedMessageIds[0]!;
    const forked = await engine.forkToMessage(preservedId);
    expect(forked.summary).toBeDefined();
    expect(forked.compactBoundaries).toHaveLength(1);
    expect(forked.modelMessages!.at(-1)!.id).toBe(preservedId);
    await closeEngineRecorder(engine);
  });

  it("撤回-style fork (inclusive:false) at the FIRST preserved message keeps just the summary bridge", async () => {
    const { engine, boundary } = await makeCompactedEngine();
    const firstPreservedId = boundary.preservedMessageIds[0]!;
    const forked = await engine.forkToMessage(firstPreservedId, { inclusive: false });
    // Model view collapses to the restored-context message alone — the summary
    // still covers everything before the cut, so it stays.
    expect(forked.modelMessages).toHaveLength(1);
    expect(forked.modelMessages![0]!.id).toBe(boundary.reinjectedMessageIds![0]);
    expect(forked.summary).toBeDefined();
    expect(forked.compactBoundaries).toHaveLength(1);
    await closeEngineRecorder(engine);
  });

  it("fork of a NEVER-compacted session stays on raw history (no phantom compaction state)", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
    });
    const first = testMessage("user", "plain question");
    engine.session.messages.push(first, testMessage("assistant", "plain answer"), testMessage("user", "follow-up"));
    const forked = await engine.forkToMessage(first.id);
    expect(forked.modelMessages).toBeUndefined();
    expect(forked.summary).toBeUndefined();
    expect(forked.compactBoundaries).toBeUndefined();
    expect(forked.messages).toHaveLength(1);
    await closeEngineRecorder(engine);
  });

  it("fork after TWO compactions carries both boundaries and the latest summary", async () => {
    const { engine, internals } = await makeCompactedEngine();
    // Grow the compacted view enough for a second compaction to find a slice.
    for (let index = 0; index < 14; index++) {
      internals.appendMessage(testMessage("user", `second wave user ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
      internals.appendMessage(
        testMessage("assistant", `second wave assistant ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
      );
    }
    const second = await engine.compactNow("second compaction");
    expect(second).toBeDefined();
    const latestSummary = engine.session.summary;
    const afterSecond = testMessage("user", "after second compaction");
    internals.appendMessage(afterSecond);

    const forked = await engine.forkToMessage(afterSecond.id);
    expect(forked.compactBoundaries).toHaveLength(2);
    expect(forked.summary).toBe(latestSummary);
    expect(forked.modelMessages!.at(-1)!.id).toBe(afterSecond.id);
    await closeEngineRecorder(engine);
  });

  it("deleteFromMessage after a compaction keeps the summary (same rule as rollback)", async () => {
    const { engine, internals } = await makeCompactedEngine();
    const afterCompact = testMessage("user", "after compact question");
    internals.appendMessage(afterCompact);
    const answer = testMessage("assistant", "after compact answer");
    internals.appendMessage(answer);

    await engine.deleteFromMessage(answer.id);
    expect(engine.session.summary).toBeDefined();
    expect(engine.session.compactBoundaries).toHaveLength(1);
    expect(engine.session.modelMessages!.some((item) => item.id === answer.id)).toBe(false);
    expect(engine.session.modelMessages!.at(-1)!.id).toBe(afterCompact.id);
    expect(engine.session.messages.at(-1)!.id).toBe(afterCompact.id);
    await closeEngineRecorder(engine);
  });

  it("rollback INTO the compacted-away region discards the stale summary in place", async () => {
    const { engine } = await makeCompactedEngine();
    const earliest = engine.session.messages[0]!;
    expect(engine.session.modelMessages!.some((item) => item.id === earliest.id)).toBe(false);

    await engine.rollbackToMessage(earliest.id);
    expect(engine.session.modelMessages).toBeUndefined();
    expect(engine.session.summary).toBeUndefined();
    expect(engine.session.compactBoundaries).toBeUndefined();
    expect(engine.session.messages).toHaveLength(0);
    await closeEngineRecorder(engine);
  });

  it("hasPendingUserGate reflects pending approvals and unanswered questions", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      pending: Map<string, unknown>;
      hasPendingUserGate(): boolean;
    };
    // Clean: nothing parked on the user.
    expect(internals.hasPendingUserGate()).toBe(false);
    // A tool awaiting approval gates continuation.
    internals.pending.set("call_1", {});
    expect(internals.hasPendingUserGate()).toBe(true);
    internals.pending.clear();
    expect(internals.hasPendingUserGate()).toBe(false);
    // An unanswered question gates continuation; an answered one does not.
    engine.session.pendingQuestions.push({
      id: "q1",
      question: "continue?",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as (typeof engine.session.pendingQuestions)[number]);
    expect(internals.hasPendingUserGate()).toBe(true);
    engine.session.pendingQuestions[0]!.status = "answered";
    expect(internals.hasPendingUserGate()).toBe(false);
    await closeEngineRecorder(engine);
  });

  describe("goal runtime continuation (maybeAdvanceGoalRuntime)", () => {
    async function goalEngine(budgetLimits?: {
      tokenBudget?: number;
      turnBudget?: number;
      wallClockBudgetMs?: number;
    }): Promise<AgentEngine> {
      const engine = await AgentEngine.create({ cwd, agent: "default" });
      engine.executeGoalCommand({
        type: "create",
        objective: "ship the thing",
        ...(budgetLimits ? { budgetLimits } : {}),
      });
      return engine;
    }

    it("fires and bumps the round while the current Goal is active", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      expect(engine.session.goal?.current?.status).toBe("active");
      expect(engine.session.goal?.run?.rounds).toBe(1);
      expect(engine.session.goal?.run?.goalId).toBe(engine.session.goal?.current?.id);
      // A second idle boundary keeps going (round 2).
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      expect(engine.session.goal?.run?.rounds).toBe(2);
      await closeEngineRecorder(engine);
    });

    it("does not fire without a current Goal", async () => {
      const engine = await AgentEngine.create({ cwd, agent: "default" });
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal).toBeUndefined();
      await closeEngineRecorder(engine);
    });

    it("yields to queued user input and to a pending HITL prompt without starting a runtime", async () => {
      const engine = await goalEngine();
      // Queued user input wins the idle slot.
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: true })).toBe(false);
      // An unanswered question parks continuation (reuses hasPendingUserGate).
      engine.session.pendingQuestions.push({
        id: "q1",
        question: "?",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as (typeof engine.session.pendingQuestions)[number]);
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.run?.rounds).toBe(0);
      await closeEngineRecorder(engine);
    });

    it("suspends (without finalizing) when paused or interrupted", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      const goalId = engine.session.goal!.current!.id;
      expect(engine.executeGoalCommand({ type: "pause", goalId })).toMatchObject({ ok: true, changed: true });
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.status).toBe("paused");
      expect(engine.executeGoalCommand({ type: "resume", goalId })).toMatchObject({ ok: true, changed: true });
      engine.session.interrupted = true;
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.status).toBe("active");
      await closeEngineRecorder(engine);
    });

    it("finalizes 'complete' once the goal is resolved", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      const goalId = engine.session.goal!.current!.id;
      executeInternalGoal(engine, { type: "claim_complete", goalId, evidence: "tests passed" }, "model");
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.status).toBe("complete");
      expect(engine.session.goal?.run).toBeNull();
      await closeEngineRecorder(engine);
    });

    it("finalizes 'limit' when the continuation cap is reached", async () => {
      const engine = await goalEngine();
      engine.session.goal!.run!.rounds = 50;
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.status).toBe("blocked");
      expect(engine.session.goal?.current?.terminalReason).toContain("safety limit");
      await closeEngineRecorder(engine);
    });

    it("uses dedicated Goal runtime limits instead of tool-loop or autopilot settings", async () => {
      const engine = await AgentEngine.create({
        cwd,
        agent: "default",
        goal: { maxContinuationRounds: 2, stagnationLimit: 99 },
      });
      engine.executeGoalCommand({ type: "create", objective: "bounded Goal" });
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.terminalReason).toContain("2/2 rounds");
      await closeEngineRecorder(engine);
    });

    it("blocks the Goal when its own token budget is exhausted", async () => {
      const engine = await goalEngine({ tokenBudget: 1_000 });
      engine.session.usage = {
        inputTokens: 800,
        outputTokens: 300,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        turns: 1,
      };
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.current?.status).toBe("blocked");
      expect(engine.session.goal?.current?.terminalReason).toContain("token budget");
      await closeEngineRecorder(engine);
    });

    it("auto-exhausts when consecutive continuations make no progress", async () => {
      const engine = await goalEngine();
      let fired = 0;
      // No tool calls → a constant progress signature → stagnation must stop it
      // (default limit 3) well before the 50-round cap.
      while (await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })) {
        if (++fired > 20) break;
      }
      expect(engine.session.goal?.current?.status).toBe("blocked");
      expect(engine.session.goal?.current?.terminalReason).toContain("without new progress");
      expect(fired).toBeLessThan(10);
      await closeEngineRecorder(engine);
    });

    it("pauses and resumes through the Goal state machine", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      const goalId = engine.session.goal!.current!.id;
      expect(engine.executeGoalCommand({ type: "pause", goalId })).toMatchObject({ ok: true, changed: true });
      expect(engine.session.goal?.current?.status).toBe("paused");
      expect(engine.session.goal?.run).toBeNull();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.executeGoalCommand({ type: "resume", goalId })).toMatchObject({ ok: true, changed: true });
      expect(engine.session.goal?.current?.status).toBe("active");
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      await closeEngineRecorder(engine);
    });

    it("builds a continuation prompt carrying the objective and live budget", async () => {
      const engine = await goalEngine({ tokenBudget: 50_000 });
      engine.session.goal!.run!.rounds = 3;
      engine.session.usage = {
        inputTokens: 1_200,
        outputTokens: 300,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        turns: 3,
      };
      const prompt = engine.goalContinuationPrompt();
      expect(prompt).toContain("<objective>ship the thing</objective>");
      expect(prompt).toContain("Autonomous continuation rounds: 3/50");
      expect(prompt).toContain("Goal tokens: 1500/50000");
      expect(prompt).toContain("update_goal(status=complete)");
      expect(prompt).toContain("Do not call create_goal");
      await closeEngineRecorder(engine);
    });

    it("user-pausing a goal suspends continuation without finalizing; resume re-arms it", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      const goalId = engine.session.goal!.current!.id;
      // External pause (codex ThreadGoal Active → Paused): not terminal.
      expect(engine.executeGoalCommand({ type: "pause", goalId })).toMatchObject({ ok: true, changed: true });
      expect(engine.session.goal?.current?.status).toBe("paused");
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      expect(engine.session.goal?.run).toBeNull();
      // Resume (Paused → Active) re-arms the next idle boundary.
      expect(engine.executeGoalCommand({ type: "resume", goalId })).toMatchObject({ ok: true, changed: true });
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      // Guardrails: unknown id and invalid transitions report errors.
      expect(engine.executeGoalCommand({ type: "pause", goalId: "goal_404" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/No current goal/i),
      });
      executeInternalGoal(engine, { type: "claim_blocked", goalId, reason: "blocked" }, "model");
      expect(engine.executeGoalCommand({ type: "pause", goalId })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/Only an active goal/),
      });
      await closeEngineRecorder(engine);
    });

    it("user can edit a goal's condition externally (picked up by prompt + continuation cue)", async () => {
      const engine = await goalEngine();
      const goalId = engine.session.goal!.current!.id;
      expect(engine.executeGoalCommand({ type: "edit", goalId, objective: "  ship the OTHER thing  " })).toMatchObject({
        ok: true,
        changed: true,
      });
      expect(engine.session.goal?.current?.objective).toBe("ship the OTHER thing");
      expect(engine.goalContinuationPrompt()).toContain("ship the OTHER thing");
      // Validation: empty text, unknown id, resolved goals are immutable.
      expect(engine.executeGoalCommand({ type: "edit", goalId, objective: "   " })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/cannot be empty/i),
      });
      expect(engine.executeGoalCommand({ type: "edit", goalId: "goal_404", objective: "x" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/No current goal/i),
      });
      executeInternalGoal(engine, { type: "claim_complete", goalId, evidence: "done" }, "model");
      await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false });
      expect(engine.executeGoalCommand({ type: "edit", goalId, objective: "x" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/completed goal/i),
      });
      await closeEngineRecorder(engine);
    });

    it("a cleared Goal and its replacement survive save/load through goal events", async () => {
      const engine = await AgentEngine.create({ cwd, agent: "default" });
      engine.executeGoalCommand({ type: "create", objective: "first objective" });
      const firstId = engine.session.goal!.current!.id;
      expect(engine.executeGoalCommand({ type: "clear", goalId: firstId })).toMatchObject({ ok: true, changed: true });
      expect(engine.executeGoalCommand({ type: "clear", goalId: "goal_404" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/No current goal/i),
      });
      engine.executeGoalCommand({ type: "create", objective: "second objective" });
      expect(engine.session.goal?.current?.objective).toBe("second objective");
      await engine.saveSession();
      await closeEngineRecorder(engine);

      const reopened = await AgentEngine.create({ cwd, agent: "default" });
      await reopened.loadSession(engine.session.id);
      expect(reopened.session.goal?.current?.objective).toBe("second objective");
      expect(reopened.session.goal?.history.some((goal) => goal.objective === "first objective")).toBe(true);
      await closeEngineRecorder(reopened);
    });

    it("clearing the Goal retires its runtime without a mode toggle", async () => {
      const engine = await goalEngine();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(true);
      const goalId = engine.session.goal!.current!.id;
      expect(engine.executeGoalCommand({ type: "clear", goalId })).toMatchObject({ ok: true, changed: true });
      expect(engine.session.goal?.current).toBeNull();
      expect(engine.session.goal?.run).toBeNull();
      expect(await engine.maybeAdvanceGoalRuntime({ hasQueuedInput: false })).toBe(false);
      await closeEngineRecorder(engine);
    });
  });

  it("does not expose the compaction tool from a restored deferred-tool list", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.activeDeferredTools = ["compact_conversation"];

    expect((await engine.availableTools()).map((tool) => tool.name)).not.toContain("compact_conversation");
  });

  it("compacts manually through the runtime without adding a user turn or tool call", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("read README");
    for (let index = 0; index < 12; index++) {
      engine.session.messages.push(
        testMessage("user", `manual compact user ${index} ${COMPACT_FILLER_UNIT.repeat(54)}`),
      );
      engine.session.messages.push(
        testMessage("assistant", `manual compact assistant ${index} ${COMPACT_FILLER_UNIT.repeat(54)}`),
      );
    }

    const transcriptLength = engine.session.messages.length;
    const toolCallCount = engine.session.toolCalls.length;
    const boundary = await engine.compactNow("user requested manual compaction");

    expect(boundary).toBeDefined();
    expect(engine.session.messages).toHaveLength(transcriptLength);
    expect(engine.session.toolCalls).toHaveLength(toolCallCount);
    expect(engine.session.compactBoundaries?.at(-1)?.type).toBe("manual");
    expect(engine.session.compactBoundaries?.at(-1)?.historyPath).toBeTruthy();
    expect(engine.session.messages.some((message) => message.content.includes("manual compact user"))).toBe(true);
    // The oldest prefix message is dropped from the model view as a STANDALONE
    // message. Its text may now be quoted inside the folded post-compact summary
    // (the summary rides modelMessages[0] instead of a per-turn reminder), so
    // match the original standalone message by prefix rather than substring.
    expect(engine.session.modelMessages!.some((message) => message.content.startsWith("manual compact user 0"))).toBe(
      false,
    );
    // The summary is folded into the once-injected, cacheable restored-context
    // message at the head of modelMessages — and no longer surfaced via the
    // per-turn volatile reminder.
    expect(engine.session.modelMessages![0]!.content).toContain("Conversation summary:");
    expect(buildVolatileContextReminder(engine.session)).not.toContain("Conversation summary:");
    // Recent files come back as a path list (pi-style), not 20k-char bodies —
    // the old <file> snapshot re-injection was the biggest post-compact floor.
    expect(engine.session.modelMessages!.some((message) => message.content.includes("Recently read files"))).toBe(true);
    expect(engine.session.modelMessages!.some((message) => message.content.includes("README"))).toBe(true);
    expect(engine.session.modelMessages!.some((message) => message.content.includes("<file path="))).toBe(false);
  });

  it("backfills the compaction summary into modelMessages for pre-fold sessions", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as { backfillCompactionSummaryMessage(): void };
    // Old-format compacted session: the rolling summary lives ONLY in the field;
    // modelMessages carries no summary-bearing message (the pre-fold shape).
    engine.session.summary = "Primary Request: PRE_FOLD_SUMMARY_TEXT";
    engine.session.modelMessages = [
      { id: "m1", role: "user", content: "live tail message", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    internals.backfillCompactionSummaryMessage();

    // Summary materialized as the FIRST model message, carrying the field text.
    expect(engine.session.modelMessages![0]!.content).toContain("Post-compact restored context:");
    expect(engine.session.modelMessages![0]!.content).toContain("Conversation summary:");
    expect(engine.session.modelMessages![0]!.content).toContain("PRE_FOLD_SUMMARY_TEXT");
    expect(engine.session.modelMessages!.length).toBe(2);

    // Idempotent: a second pass (summary now in a message) is a no-op.
    internals.backfillCompactionSummaryMessage();
    expect(engine.session.modelMessages!.length).toBe(2);

    await closeEngineRecorder(engine);
  });

  it("does not backfill a summary message for never-compacted sessions", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as { backfillCompactionSummaryMessage(): void };
    // No summary set + no modelMessages view → nothing to heal.
    expect(engine.session.summary).toBeUndefined();
    internals.backfillCompactionSummaryMessage();
    expect(engine.session.modelMessages).toBeUndefined();
    await closeEngineRecorder(engine);
  });

  it("restores compacted model context and offloaded memory chunks after loadSession", async () => {
    const previousFlag = process.env.REINA_COMPACTION_OFFLOAD;
    process.env.REINA_COMPACTION_OFFLOAD = "1";
    const store = SessionStore.open(cwd, { inMemory: true });
    let engine: AgentEngine | undefined;
    let reopened: AgentEngine | undefined;
    try {
      engine = await AgentEngine.create({ cwd, agent: "default", sessionStore: store });
      for (let index = 0; index < 14; index++) {
        engine.session.messages.push(
          testMessage("user", `reload compact user ${index} ${COMPACT_FILLER_UNIT.repeat(54)}`),
        );
        engine.session.messages.push(
          testMessage("assistant", `reload compact assistant ${index} ${COMPACT_FILLER_UNIT.repeat(54)}`),
        );
      }

      const boundary = await engine.compactNow("reload recovery test");
      expect(boundary).toBeDefined();
      expect(engine.session.memoryChunks?.length).toBeGreaterThan(0);
      await engine.saveSession();
      await closeEngineRecorder(engine);

      reopened = await AgentEngine.create({ cwd, agent: "default", sessionStore: store });
      await reopened.loadSession(engine.session.id);

      expect(reopened.session.summary).toContain("reload compact user");
      expect(reopened.session.modelMessages).toBeDefined();
      expect(reopened.session.modelMessages!.length).toBeLessThan(reopened.session.messages.length);
      // The summary is folded into modelMessages (cached, once) and survives
      // reload — model visibility no longer depends on the per-turn reminder.
      expect(reopened.session.modelMessages!.some((m) => m.content.includes("Conversation summary:"))).toBe(true);
      expect(buildVolatileContextReminder(reopened.session)).not.toContain("Conversation summary:");
      expect(reopened.session.memoryChunks?.length).toBeGreaterThan(0);
      expect(reopened.session.activeDeferredTools).toEqual(
        expect.arrayContaining(["recall_memory_chunk", "list_memory_chunks"]),
      );
      expect(buildVolatileContextReminder(reopened.session)).toContain("Offloaded memory");
    } finally {
      if (reopened) await closeEngineRecorder(reopened);
      else if (engine) await closeEngineRecorder(engine);
      store.close();
      if (previousFlag === undefined) delete process.env.REINA_COMPACTION_OFFLOAD;
      else process.env.REINA_COMPACTION_OFFLOAD = previousFlag;
    }
  });

  it("loadSession falls back to the SQLite mirror when no rollout file exists (deferred materialization)", async () => {
    const store = SessionStore.open(cwd, { inMemory: true });
    let engine: AgentEngine | undefined;
    let reopened: AgentEngine | undefined;
    let replayed: AgentEngine | undefined;
    try {
      // An untouched session: created + mirrored to the store, but never
      // appended — deferred materialization leaves NO .jsonl on disk (the
      // path saveSession reports doesn't exist).
      engine = await AgentEngine.create({ cwd, agent: "default", sessionStore: store });
      const reportedPath = await engine.saveSession();
      await expect(stat(reportedPath)).rejects.toBeTruthy();
      await closeEngineRecorder(engine);

      // Cold open (e.g. after an agent-host crash/respawn) must NOT throw
      // "Session not found": with neither .jsonl nor legacy .json on disk,
      // the engine hydrates from the SQLite mirror.
      reopened = await AgentEngine.create({ cwd, agent: "default", sessionStore: store });
      await reopened.loadSession(engine.session.id);
      expect(reopened.session.id).toBe(engine.session.id);
      expect(reopened.session.cwd).toBe(engine.session.cwd);

      // The fallback path re-seeds firstMeta, so the file materialized by the
      // next append starts with session_meta and replays cleanly.
      reopened.setPermissionMode("default");
      await reopened.saveSession();
      const lines = (await readFile(reportedPath, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0]!).type).toBe("session_meta");
      await closeEngineRecorder(reopened);

      replayed = await AgentEngine.create({ cwd, agent: "default", sessionStore: store });
      await replayed.loadSession(engine.session.id);
      expect(replayed.session.id).toBe(engine.session.id);
    } finally {
      if (replayed) await closeEngineRecorder(replayed);
      if (reopened) await closeEngineRecorder(reopened);
      if (engine) await closeEngineRecorder(engine);
      store.close();
    }
  });
});

describe("engine dispose", () => {
  it("dispose() settles background init, closes the recorder, and is idempotent", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    await engine.dispose();
    const internals = engine as unknown as { recorder: unknown };
    expect(internals.recorder).toBeNull();
    await engine.dispose(); // double dispose must not throw
  });

  it("isSubagent input suppresses the constructor's own notes-service boot", () => {
    // Without the input flag the constructor starts a detached init before
    // spawnChildEngine can set session.isSubagent, and the promise overwrite
    // that follows orphans the child's own writers (nothing can await them).
    const child = new AgentEngine({ cwd, agent: "default", isSubagent: true, subagentDepth: 1 });
    const internals = child as unknown as {
      notesService: unknown;
      notesInitPromise: unknown;
      globalNotesService: unknown;
      globalNotesInitPromise: unknown;
    };
    expect(internals.notesService).toBeNull();
    expect(internals.notesInitPromise).toBeNull();
    expect(internals.globalNotesService).toBeNull();
    expect(internals.globalNotesInitPromise).toBeNull();
    expect(child.session.isSubagent).toBe(true);
    expect(child.session.subagentDepth).toBe(1);
  });

  it("spawnChildEngine adds zero NotesService init calls and shares the parent's services", async () => {
    const initSpy = vi.spyOn(NotesService.prototype, "init");
    try {
      const parent = new AgentEngine({ cwd, agent: "default" });
      const parentInitCalls = initSpy.mock.calls.length; // workspace + global
      expect(parentInitCalls).toBeGreaterThan(0);

      const spawn = (
        parent as unknown as { spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine }
      ).spawnChildEngine.bind(parent);
      const child = spawn({ cwd, agent: "default" });

      // The child must not have started its own (immediately-orphaned) init.
      expect(initSpy.mock.calls.length).toBe(parentInitCalls);
      type NotesInternals = {
        notesService: unknown;
        notesInitPromise: unknown;
        globalNotesService: unknown;
        globalNotesInitPromise: unknown;
      };
      const parentInternals = parent as unknown as NotesInternals;
      const childInternals = child as unknown as NotesInternals;
      expect(childInternals.notesService).toBe(parentInternals.notesService);
      expect(childInternals.notesInitPromise).toBe(parentInternals.notesInitPromise);
      expect(childInternals.globalNotesService).toBe(parentInternals.globalNotesService);
      expect(childInternals.globalNotesInitPromise).toBe(parentInternals.globalNotesInitPromise);
      expect(child.session.subagentDepth).toBe(1);
      await parent.dispose();
    } finally {
      initSpy.mockRestore();
    }
  });

  it("loadSession resolves only after the old recorder close and both notes inits settle", async () => {
    const seed = await AgentEngine.create({ cwd, agent: "default" });
    // The recorder defers file creation until the first append — record one
    // config item so the seed session actually exists on disk to load back.
    seed.setPermissionMode("default");
    await seed.saveSession();
    const targetId = seed.session.id;
    await seed.dispose();

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    const internals = reopened as unknown as {
      recorder: { close(): Promise<void> } | null;
      startNotesService(): void;
      notesInitPromise: Promise<void> | null;
      globalNotesInitPromise: Promise<void> | null;
    };
    // Swap in a controlled recorder + controlled notes inits so each await
    // in loadSession is individually observable.
    await internals.recorder?.close();
    let releaseClose: (() => void) | undefined;
    internals.recorder = {
      close: () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    } as never;
    let releaseNotes: (() => void) | undefined;
    let releaseGlobalNotes: (() => void) | undefined;
    internals.startNotesService = function (this: typeof internals) {
      this.notesInitPromise = new Promise<void>((resolve) => {
        releaseNotes = resolve;
      });
      this.globalNotesInitPromise = new Promise<void>((resolve) => {
        releaseGlobalNotes = resolve;
      });
    };

    let loaded = false;
    const loadPromise = reopened.loadSession(targetId).then(() => {
      loaded = true;
    });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(predicate()).toBe(true);
    };

    await waitFor(() => releaseClose !== undefined);
    expect(loaded).toBe(false); // blocked on the old recorder's close
    releaseClose!();
    await waitFor(() => releaseNotes !== undefined);
    expect(loaded).toBe(false); // blocked on the workspace notes init
    releaseNotes!();
    await waitFor(() => releaseGlobalNotes !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loaded).toBe(false); // blocked on the global notes init
    releaseGlobalNotes!();
    await loadPromise;
    expect(loaded).toBe(true);
    await reopened.dispose();
  });
});

describe("restart recovery — stale pending approvals are reaped on load", () => {
  // A pending_approval record that reaches the rollout without a terminal
  // tool_update is unanswerable after a reload: loadSession clears the
  // runtime pending map (and any bubble resolver died with the process), so
  // the dock would show a button whose click no-ops and gets re-populated by
  // the next snapshot forever.

  it("reaps a plain pending approval left by a dead process", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default", permissionMode: "default" });
    const result = await engine.runTurn("run echo zombie");
    expect(result.pendingApprovals).toHaveLength(1);
    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    const record = reopened.session.toolCalls.find((call) => call.name === "run_shell");
    expect(record?.status).toBe("failed");
    expect(record?.error).toMatch(/approval|restart/i);
    expect(record?.allowedDecisions).toBeUndefined();
    await closeEngineRecorder(reopened);
  });

  it("reaps a stale approval even when the session was interrupt()ed before close", async () => {
    // interrupt() clears the runtime map but leaves plain records at
    // pending_approval and stamps the session interrupted — the reap must
    // run BEFORE recoverInterruptedTurn's interrupted early-return.
    const engine = await AgentEngine.create({ cwd, agent: "default", permissionMode: "default" });
    await engine.runTurn("run echo zombie-2");
    engine.interrupt();
    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    const record = reopened.session.toolCalls.find((call) => call.name === "run_shell");
    expect(record?.status).toBe("failed");
    await closeEngineRecorder(reopened);
  });

  it("does not resurrect allowedDecisions on settled records across cold loads", async () => {
    // Wider than the zombie reap: the engine clears allowedDecisions by
    // assigning undefined, JSON.stringify drops the field from the
    // tool_update line, and mergeToolCall's sparse merge would resurrect the
    // original pending line's options on every later replay.
    const engine = await AgentEngine.create({ cwd, agent: "default", permissionMode: "default" });
    const result = await engine.runTurn("run echo decisions");
    const approval = result.pendingApprovals[0]!;
    expect(approval.allowedDecisions?.length).toBeGreaterThan(0);
    await engine.resolveApproval(approval.id, true, {});
    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    const record = reopened.session.toolCalls.find((call) => call.name === "run_shell");
    expect(record?.status).toBe("completed");
    expect(record?.allowedDecisions).toBeUndefined();
    await closeEngineRecorder(reopened);
  });

  it("reaps an unresolved bubbled mirror (process died while a subagent awaited approval)", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const host = (
      engine as unknown as {
        createSubagentHost: () => {
          requestBubbleApproval: (input: { taskId: string; childRecord: ToolCallRecord }) => Promise<unknown>;
        };
      }
    ).createSubagentHost.call(engine) as {
      requestBubbleApproval: (input: { taskId: string; childRecord: ToolCallRecord }) => Promise<unknown>;
    };
    // Mint the mirror and never resolve it — the recorder then closes as if
    // the process died before any terminal update was written.
    void host.requestBubbleApproval({
      taskId: "sub_zombie",
      childRecord: {
        id: "call_zombie",
        name: "write_file" as ToolCallRecord["name"],
        input: { path: "x.txt", content: "z" },
        summary: "write_file",
        permission: "write",
        status: "pending_approval",
        createdAt: nowStamp(),
      } as ToolCallRecord,
    });
    await engine.saveSession();
    await closeEngineRecorder(engine);

    const reopened = await AgentEngine.create({ cwd, agent: "default" });
    await reopened.loadSession(engine.session.id);
    const mirror = reopened.session.toolCalls.find((call) => call.bubbledFromTask?.id === "sub_zombie");
    expect(mirror).toBeDefined();
    expect(mirror?.status).toBe("failed");
    await closeEngineRecorder(reopened);
  });
});

describe("model-call retry budget (transient API failures)", () => {
  const ENV_KEY = "REINA_TURN_MAX_RETRIES";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("defaults to a generous-but-bounded retry budget so a flaky upstream doesn't kill a turn", () => {
    delete process.env[ENV_KEY];
    expect(turnMaxRetries()).toBe(4);
  });

  it("is tunable via REINA_TURN_MAX_RETRIES, including 0 to disable", () => {
    process.env[ENV_KEY] = "7";
    expect(turnMaxRetries()).toBe(7);
    process.env[ENV_KEY] = "0";
    expect(turnMaxRetries()).toBe(0);
  });

  it("ignores a garbage / negative override and falls back to the default", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(turnMaxRetries()).toBe(4);
    process.env[ENV_KEY] = "-3";
    expect(turnMaxRetries()).toBe(4);
  });

  it("backs off exponentially, stays monotonic, and is capped at 30s + jitter", () => {
    // Floor (excluding jitter) doubles each attempt until the 30s cap.
    const floor = (attempt: number) => Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    expect(floor(1)).toBe(1_000);
    expect(floor(2)).toBe(2_000);
    expect(floor(3)).toBe(4_000);
    // Later attempts saturate at the cap.
    expect(floor(10)).toBe(30_000);
    // Actual values include up to 500ms jitter and never exceed cap + jitter.
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ms = turnRetryBackoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(floor(attempt));
      expect(ms).toBeLessThan(floor(attempt) + 500);
      expect(ms).toBeLessThanOrEqual(30_000 + 500);
    }
  });
});

describe("abnormal stream-termination diagnostics", () => {
  const lastAssistant = (engine: AgentEngine) =>
    engine.session.messages.filter((message) => message.role === "assistant").at(-1);

  it("surfaces an abnormal finish_reason (e.g. content_filter) instead of ending the turn silently", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("stop_reason content_filter here is the start of an answer");
    const assistant = lastAssistant(engine);
    // The partial text the model did emit is preserved...
    expect(assistant?.content).toContain("here is the start of an answer");
    // ...and the early termination is explained with the raw provider reason.
    expect(assistant?.content).toContain("content_filter");
    expect(assistant?.content).toContain("⚠️");
    // Reasoning ("Thoughts") still rides along on the same message.
    expect(assistant?.reasoning).toBeTruthy();
    await closeEngineRecorder(engine);
  });

  it("routes a context-overflow finish_reason to recovery and surfaces a window notice, not a moderation one", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    // Some relays report a blown context window as a 200-stream finish_reason
    // (not a thrown error), so it never reaches isContextWindowError. The engine
    // should attempt trim/compact recovery and, when it can't free room, explain
    // the overflow — NOT mislabel it as the generic output-moderation case.
    await engine.runTurn("stop_reason model_context_window_exceeded partial answer");
    const assistant = lastAssistant(engine);
    expect(assistant?.content).toContain("context window");
    expect(assistant?.content).toContain("model_context_window_exceeded");
    expect(assistant?.content).not.toContain("content moderation");
    expect(assistant?.content).toContain("⚠️");
    await closeEngineRecorder(engine);
  });

  it("surfaces a fully empty response (no text, reasoning, or tool calls)", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("stop_reason empty");
    const assistant = lastAssistant(engine);
    expect(assistant?.content).toContain("empty response");
    expect(assistant?.content).toContain("⚠️");
    await closeEngineRecorder(engine);
  });

  it("retries a bounded number of times, then surfaces a reasoning-only response instead of a bare Thoughts block", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    // The deterministic provider returns reasoning + empty content for a bare
    // `stop_reason stop`, so the structural recovery fires (twice, the second
    // with firmer grounding) and — given the same reasoning-only turn back —
    // surfaces the notice rather than looping or ending on a bare Thoughts
    // disclosure.
    await engine.runTurn("stop_reason stop");
    const assistant = lastAssistant(engine);
    expect(assistant?.reasoning).toBeTruthy();
    expect(assistant?.content).toContain("reasoning only");
    expect(assistant?.content).toContain("⚠️");
    const retries = engine.session.trace.filter(
      (event) => event.type === "model.retry" && event.data.reason === "reasoning_only",
    );
    expect(retries).toHaveLength(2);
    await closeEngineRecorder(engine);
  });

  it("stays silent on a normal stop with content (no false-positive warning)", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("stop_reason stop a perfectly normal final answer");
    const assistant = lastAssistant(engine);
    expect(assistant?.content).toContain("a perfectly normal final answer");
    expect(assistant?.content).not.toContain("⚠️");
    await closeEngineRecorder(engine);
  });
});

describe("async subagent tasks", () => {
  /** Helper: drives the engine until every running async task settles. The
   * tests below issue start_async_task via the deterministic provider, then
   * poll the engine's internal map to wait for completion before asserting.
   * Without this the assertions race against the background driver. */
  async function waitForAsyncTasks(engine: AgentEngine, timeoutMs = 5000): Promise<void> {
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    const start = Date.now();
    while (internals.asyncTaskChildren.size > 0) {
      if (Date.now() - start > timeoutMs) throw new Error("async task did not settle within timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("start_async_task returns a task id and records the task as running", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    const tasks = engine.session.asyncTasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toMatch(/^sub_/);
    expect(tasks[0]!.agent).toBe("default");
    expect(tasks[0]!.description).toBe("read README");
    expect(["running", "completed"]).toContain(tasks[0]!.status);
    await waitForAsyncTasks(engine);
  });

  it("the launched child eventually completes and the record carries the result", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    await waitForAsyncTasks(engine);
    const task = engine.session.asyncTasks?.[0];
    expect(task?.status).toBe("completed");
    expect(task?.result).toContain("read_file");
    expect(task?.completedAt).toBeTruthy();
    // The deterministic provider doesn't emit usage, so `turns` stays 0;
    // assert against tool-call counters which we increment from session state.
    expect(task?.toolCalls ?? 0).toBeGreaterThan(0);
  });

  it("two start_async_task calls in one turn run in parallel", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_parallel read README | read package.json");
    expect(engine.session.asyncTasks).toHaveLength(2);
    // Both should reach running/completed state simultaneously — the parent's
    // executeRecord returns immediately for start_async_task, so the second
    // launch happens before the first child finishes.
    const ids = engine.session.asyncTasks!.map((task) => task.id);
    expect(new Set(ids).size).toBe(2);
    await waitForAsyncTasks(engine);
    for (const task of engine.session.asyncTasks ?? []) {
      expect(task.status).toBe("completed");
    }
  });

  it("check_async_task surfaces the current status via tool observation", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    await waitForAsyncTasks(engine);
    const taskId = engine.session.asyncTasks![0]!.id;
    await engine.runTurn(`async_check ${taskId}`);
    const checkCall = engine.session.toolCalls.find((call) => call.name === "check_async_task");
    expect(checkCall?.output).toContain(taskId);
    expect(checkCall?.output).toContain("<status>completed</status>");
  });

  it("list_async_tasks returns every recorded task", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_parallel read README | read package.json");
    await waitForAsyncTasks(engine);
    await engine.runTurn("async_list");
    const listCall = engine.session.toolCalls.find((call) => call.name === "list_async_tasks");
    expect(listCall?.output).toContain('<async_tasks count="2">');
  });

  it("cancel_async_task interrupts a running child and flips status to cancelled", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    // We construct a child manually and stash it in the parent so we can cancel
    // before it finishes. The deterministic provider doesn't give us reliable
    // long-running children, so simulate by directly inserting a record + child.
    const child = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      asyncTaskChildren: Map<string, AgentEngine>;
      upsertAsyncTask(task: unknown): void;
    };
    internals.asyncTaskChildren.set("sub_xxx", child);
    internals.upsertAsyncTask({
      id: "sub_xxx",
      agent: "default",
      description: "long running",
      status: "running",
      startedAt: new Date().toISOString(),
      isolation: "none",
    });

    await engine.runTurn("async_cancel sub_xxx");
    const cancelCall = engine.session.toolCalls.find((call) => call.name === "cancel_async_task");
    expect(cancelCall?.output).toContain("Cancellation requested for sub_xxx");
    expect(child.session.interrupted).toBe(true);
  });

  it("refuses to start a subagent beyond MAX_SUBAGENT_DEPTH", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.subagentDepth = 1; // already at the flat-fan-out cap
    await engine.runTurn("async_start [default] read README");
    const startCall = engine.session.toolCalls.find((call) => call.name === "start_async_task");
    expect(startCall?.status).toBe("failed");
    expect(startCall?.error).toContain("subagent depth limit");
    expect(engine.session.asyncTasks ?? []).toHaveLength(0);
  });

  it("forwards child stream events to the parent's stream as subagent-event envelopes", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const forwarded: Array<{ taskId: string; childSessionId: string; innerType: string }> = [];
    const unsub = engine.onStream((event) => {
      if (event.type === "subagent-event") {
        forwarded.push({ taskId: event.taskId, childSessionId: event.childSessionId, innerType: event.event.type });
      }
    });
    await engine.runTurn("async_start [default] read README");
    await waitForAsyncTasks(engine);
    unsub();
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0]!.taskId).toMatch(/^sub_/);
    expect(forwarded[0]!.childSessionId).toMatch(/^ses_/);
  });

  it("isolate:'worktree' branches a temp worktree and records its path on the task", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    // Promote the test cwd to a fresh git repo with one commit — the
    // worktree helper needs HEAD to exist.
    try {
      await execFileP("git", ["-C", cwd, "init", "-q"]);
      await execFileP("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
      await execFileP("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    } catch {
      // Skip silently if git isn't on PATH — most CI hosts have it.
      return;
    }

    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start_isolated read README");
    await waitForAsyncTasks(engine);
    const task = engine.session.asyncTasks?.[0];
    expect(task?.isolation).toBe("worktree");
    expect(task?.worktreePath).toBeTruthy();
    expect(task?.worktreeBranch).toContain("reina/sub/");
  });

  it("persists async task lifecycle as rollout events on the session", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    await waitForAsyncTasks(engine);
    const traceTypes = engine.session.trace.map((event) => event.type);
    expect(traceTypes).toContain("async_task.started");
    expect(traceTypes).toContain("async_task.completed");
  });

  it("rolls up the child's token usage into the parent's session.usage", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    // Seed the parent so the rollup is additive, not absolute.
    engine.session.usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0, turns: 2 };
    await engine.runTurn("async_start [default] read README");
    await waitForAsyncTasks(engine);

    const task = engine.session.asyncTasks?.[0];
    const childInput = task?.usage?.inputTokens ?? 0;
    const childOutput = task?.usage?.outputTokens ?? 0;
    // Even with the deterministic provider's zero-usage messages, the rollup
    // path must run without throwing and the parent's counters must be at
    // least the seed + the child's reported numbers.
    expect(engine.session.usage!.inputTokens).toBeGreaterThanOrEqual(100 + childInput);
    expect(engine.session.usage!.outputTokens).toBeGreaterThanOrEqual(50 + childOutput);
    // Turns counter is owned by the parent's own model turns — rollup must
    // not bump it (otherwise nested subagents inflate the supervisor's clock).
    // The deterministic provider doesn't emit usage envelopes so the parent's
    // own turns counter stays at the seed; this is the strict no-bump check.
    expect(engine.session.usage!.turns).toBe(2);
  });

  it("refuses to spawn more async subagents than the concurrency cap", async () => {
    process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS = "2";
    try {
      const engine = new AgentEngine({ cwd, agent: "default" });
      const internals = engine as unknown as { asyncTaskChildren: Map<string, AgentEngine> };
      // Fill the in-flight map directly — simpler than racing the deterministic
      // provider against the cap. The check_async_task / cancel_async_task
      // handlers only walk session.asyncTasks, so the map can stay synthetic.
      internals.asyncTaskChildren.set("task_a", new AgentEngine({ cwd, agent: "default" }));
      internals.asyncTaskChildren.set("task_b", new AgentEngine({ cwd, agent: "default" }));
      await engine.runTurn("async_start [default] read README");
      const startCall = engine.session.toolCalls.find((call) => call.name === "start_async_task");
      expect(startCall?.status).toBe("failed");
      expect(startCall?.error).toContain("Too many concurrent");
      expect(engine.session.asyncTasks ?? []).toHaveLength(0);
    } finally {
      delete process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS;
    }
  });

  it("strips delegation/memory/HITL tools from a spawned subagent's toolset", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine;
    };
    const child = internals.spawnChildEngine({ cwd, agent: "default" });
    const names = (await child.availableTools()).map((tool) => tool.name);
    expect(child.session.isSubagent).toBe(true);
    // The whole spawn family is off-limits, as is any HITL tool that would
    // deadlock the child against an unreachable user.
    for (const blocked of [
      "task",
      "get_async_tasks",
      "start_async_task",
      "check_async_task",
      "cancel_async_task",
      "update_async_task",
      "list_async_tasks",
      "gather_async_tasks",
      "question",
      "exit_plan_mode",
    ]) {
      expect(names).not.toContain(blocked);
    }
    // Sanity: it still has the read tools it actually needs to work.
    expect(names).toContain("read_file");
  });

  it("refuses at execution time if a blocked tool slips through to a subagent", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine;
    };
    const child = internals.spawnChildEngine({ cwd, agent: "default" });
    // Directly invoke the engine's executeToolOrEngine for a blocked tool —
    // simulates a stale tool schema that re-emitted `task` despite our strip.
    const childInternals = child as unknown as {
      executeToolOrEngine(record: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        permission: "state";
        status: "running";
        createdAt: string;
      }): Promise<{ error?: string; output?: string }>;
    };
    const obs = await childInternals.executeToolOrEngine({
      id: "call_blocked",
      name: "task",
      input: { description: "should be refused" },
      permission: "state",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    expect(obs.error).toContain("not available to subagents");
    expect(obs.output).toBeUndefined();
  });

  it("surfaces silent side-effect failures through the background-error stream channel", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const events: Array<{ category: string; message: string; context?: Record<string, unknown> }> = [];
    const stop = engine.onStream((event) => {
      if (event.type === "background-error") {
        events.push({ category: event.category, message: event.message, context: event.context });
      }
    });
    const internals = engine as unknown as {
      reportBackgroundError(category: string, error: unknown, context?: Record<string, unknown>): void;
    };
    internals.reportBackgroundError("autotitle", new Error("title model refused"), { provider: "anthropic-messages" });
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]!.category).toBe("autotitle");
    expect(events[0]!.message).toBe("title model refused");
    expect(events[0]!.context).toEqual({ provider: "anthropic-messages" });
    // The same failure also lands in the session trace so debug log replays
    // surface it on session reload — not just live listeners.
    expect(engine.session.trace.at(-1)?.type).toBe("background.error");
  });

  it("does not hard-kill a long-running child on the wall-clock cap", async () => {
    // "Don't kill working children": the wall-clock budget is a foreground
    // detach boundary, not a kill switch. A child that blows past the cap —
    // even one emitting NO stream events (e.g. a long silent tool) — must be
    // left alone; only the stale heartbeat may interrupt.
    process.env.REINA_SUBAGENT_TIMEOUT_MS = "120"; // far below the child's runtime
    try {
      const engine = new AgentEngine({ cwd, agent: "default" });
      const internals = engine as unknown as {
        runChildWithWatchdog(child: AgentEngine, description: string): Promise<{ disposition: string }>;
      };
      const slow = new AgentEngine({ cwd, agent: "default" });
      slow.runTurn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { session: slow.session, pendingApprovals: [], pendingQuestions: [] };
      };
      const { disposition } = await internals.runChildWithWatchdog(slow, "slow but alive");
      expect(disposition).toBe("completed");
      expect(slow.session.interrupted).toBeFalsy();
    } finally {
      delete process.env.REINA_SUBAGENT_TIMEOUT_MS;
    }
  });

  it("conclude-phase override still hard-kills a hung child", async () => {
    // The one caller that keeps the hard timer is the conclude phase
    // (timeoutMsOverride): its single summarize turn must not wander.
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as {
      runChildWithWatchdog(
        child: AgentEngine,
        description: string,
        taskId?: string,
        options?: { timeoutMsOverride?: number },
      ): Promise<{ disposition: string }>;
    };
    const stuck = new AgentEngine({ cwd, agent: "default" });
    stuck.runTurn = async () => {
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          if (stuck.session.interrupted) {
            clearInterval(tick);
            resolve();
          }
        }, 20);
      });
      return { session: stuck.session, pendingApprovals: [], pendingQuestions: [] };
    };
    const { disposition } = await internals.runChildWithWatchdog(stuck, "conclude", undefined, {
      timeoutMsOverride: 120,
    });
    expect(disposition).toBe("timeout");
    expect(stuck.session.interrupted).toBe(true);
  });

  it("refuses start_async_task when the same brief has already failed MAX_BRIEF_RETRIES times", async () => {
    // Stops the supervisor from looping on a structurally-broken brief and
    // burning tokens. The guard reads failedBriefCounts at start time; we
    // pre-load it at the cap so the very next start fires the refusal path.
    const engine = new AgentEngine({ cwd, agent: "default" });
    const internals = engine as unknown as { failedBriefCounts: Map<string, number> };
    // Key is `${agent}::${normalizedBrief}`. normalizeBriefForRetryGuard
    // lowercases + collapses whitespace, so "read README" canonicalizes
    // to "read readme" under agent "default".
    internals.failedBriefCounts.set("default::read readme", 3);

    await engine.runTurn("async_start [default] read README");

    const startCall = engine.session.toolCalls.find((call) => call.name === "start_async_task");
    expect(startCall?.status).toBe("failed");
    expect(startCall?.error).toMatch(/already failed 3 times/);
    expect(engine.session.asyncTasks ?? []).toHaveLength(0);
  });

  it("classifies running async tasks as recoverable when the engine reloads after a process restart", async () => {
    // Simulates state replayed from a previous process: a task that was
    // "running" when the host crashed. Its child engine doesn't exist in
    // this process so it cannot be live-driven — recoverStaleAsyncTasks
    // flips the record to "recoverable" (fresh-child resumable via
    // update_async_task per P1-6) and logs a recovery trace event.
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "task_orphan",
        agent: "default",
        description: "ghost task",
        status: "running",
        startedAt: new Date(Date.now() - 5000).toISOString(),
        isolation: "none",
      },
    ];
    const internals = engine as unknown as { recoverStaleAsyncTasks(): Promise<void> };
    await internals.recoverStaleAsyncTasks();

    const task = engine.session.asyncTasks[0]!;
    expect(task.status).toBe("recoverable");
    expect(task.error).toMatch(/Process restart/);
    expect(task.completedAt).toBeUndefined();
    expect(task.recovery?.status).toBe("recoverable");
    expect(task.recovery?.worktreeStatus).toBe("none");
    const recovery = engine.session.trace.find(
      (event) => event.type === "async_task.recovered" && (event.data as { recovered?: boolean }).recovered === true,
    );
    expect(recovery).toBeTruthy();
    expect((recovery!.data as { recoverable: number }).recoverable).toBe(1);
    expect((recovery!.data as { taskIds: string[] }).taskIds).toContain("task_orphan");
  });

  it("marks isolated async tasks needs_attention when their worktree is missing on recovery", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "task_missing_wt",
        agent: "default",
        description: "ghost worktree task",
        status: "running",
        startedAt: new Date(Date.now() - 5000).toISOString(),
        isolation: "worktree",
        worktreePath: path.join(cwd, ".reina", "worktrees", "missing-task"),
      },
    ];
    const internals = engine as unknown as { recoverStaleAsyncTasks(): Promise<void> };
    await internals.recoverStaleAsyncTasks();

    const task = engine.session.asyncTasks[0]!;
    expect(task.status).toBe("needs_attention");
    expect(task.recovery?.status).toBe("needs_attention");
    expect(task.recovery?.worktreeStatus).toBe("missing");
    expect(task.error).toMatch(/Worktree missing/);
  });

  it("repairs stale rollout async task state from durable event snapshots during recovery", async () => {
    const store = SessionStore.open(cwd, { inMemory: true });
    try {
      const engine = new AgentEngine({ cwd, agent: "default", sessionStore: store });
      store.upsertSession(engine.session);
      const running = {
        id: "task_repair_from_store",
        name: "reviewer",
        agent: "default",
        description: "stale rollout task",
        status: "running" as const,
        startedAt: "2026-05-14T11:00:00.000Z",
        isolation: "none" as const,
        background: true,
      };
      const completed = {
        ...running,
        status: "completed" as const,
        completedAt: "2026-05-14T11:05:00.000Z",
        result: "finished in previous process",
      };
      engine.session.asyncTasks = [running];
      store.appendAsyncTaskEvent(
        engine.session.id,
        completed.id,
        "task.status.completed",
        { status: completed.status, taskSnapshot: completed },
        "2026-05-14T11:05:00.000Z",
      );

      const internals = engine as unknown as { recoverStaleAsyncTasks(): Promise<void> };
      await internals.recoverStaleAsyncTasks();

      const task = engine.session.asyncTasks[0]!;
      expect(task.status).toBe("completed");
      expect(task.result).toBe("finished in previous process");
      expect(task.name).toBe("reviewer");
      expect(task.background).toBe(true);
    } finally {
      store.close();
    }
  });

  it("gather_async_tasks returns each task body + aggregate usage in one observation", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "task_a",
        agent: "default",
        description: "find the auth file",
        status: "completed",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "auth.ts:42",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 500 },
      },
      {
        id: "task_b",
        agent: "default",
        description: "run unit tests",
        status: "failed",
        startedAt: new Date(Date.now() - 2000).toISOString(),
        completedAt: new Date().toISOString(),
        isolation: "none",
        error: "exit 1",
        usage: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 300 },
      },
    ];
    const internals = engine as unknown as {
      gatherAsyncTasks(record: { id: string; name: string; input: unknown }): ToolObservation;
    };
    const obs = internals.gatherAsyncTasks({ id: "call_g", name: "gather_async_tasks", input: {} });
    expect(obs.output).toContain(`count="2"`);
    expect(obs.output).toContain(`completed="1"`);
    expect(obs.output).toContain(`failed="1"`);
    expect(obs.output).toContain('<task id="task_a"');
    expect(obs.output).toContain("auth.ts:42");
    expect(obs.output).toContain('<task id="task_b"');
    expect(obs.output).toContain("exit 1");
    // Aggregate token totals across the batch — 150 in + 25 out = 175.
    expect(obs.output).toContain(`input_tokens="150"`);
    expect(obs.output).toContain(`output_tokens="25"`);
    expect(obs.output).toContain(`total_tokens="175"`);
    // First read of a terminal task counts as the supervisor's
    // acknowledgement → notifiedAt gets stamped so the eviction sweep can
    // later age the record out.
    expect(engine.session.asyncTasks[0]!.notifiedAt).toBeTruthy();
    expect(engine.session.asyncTasks[1]!.notifiedAt).toBeTruthy();
  });

  it("gather_async_tasks filters to requested ids and surfaces unknowns as missing", () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "task_real",
        agent: "default",
        description: "find it",
        status: "completed",
        startedAt: new Date().toISOString(),
        isolation: "none",
        result: "found",
      },
    ];
    const internals = engine as unknown as {
      gatherAsyncTasks(record: { id: string; name: string; input: unknown }): ToolObservation;
    };
    const obs = internals.gatherAsyncTasks({
      id: "call_g",
      name: "gather_async_tasks",
      input: { taskIds: ["task_real", "task_ghost"] },
    });
    expect(obs.output).toContain(`count="2"`);
    expect(obs.output).toContain(`missing="1"`);
    expect(obs.output).toContain('<task id="task_real"');
    expect(obs.output).toContain(`<task id="task_ghost" missing="true" />`);
  });

  it("wait_async_tasks returns immediately when every target is already terminal", async () => {
    // Fast path: no tasks running, the call should short-circuit through
    // gather without subscribing to the stream or arming a timer. We
    // verify by measuring wall-clock — anything > a few ms indicates a
    // spurious wait.
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "sub_alpha",
        agent: "default",
        description: "x",
        status: "completed",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "alpha-result",
      },
      {
        id: "sub_beta",
        agent: "default",
        description: "y",
        status: "completed",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "beta-result",
      },
    ];
    const internals = engine as unknown as {
      waitAsyncTasks(record: { id: string; name: string; input: unknown }): Promise<ToolObservation>;
    };
    const t0 = Date.now();
    const obs = await internals.waitAsyncTasks({
      id: "call_w",
      name: "wait_async_tasks",
      input: { taskIds: ["sub_alpha", "sub_beta"] },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100);
    expect(obs.output).toContain(`count="2"`);
    expect(obs.output).toContain(`completed="2"`);
    expect(obs.output).toContain("alpha-result");
    expect(obs.output).toContain("beta-result");
  });

  it("wait_async_tasks blocks until a running task reaches a terminal status", async () => {
    // We manually insert a running task, then flip it terminal from a
    // setTimeout — the wait should resolve via the async-task-updated
    // stream event, not by polling. The order matters: start the wait
    // first, then schedule the upsert.
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "sub_running",
        agent: "default",
        description: "x",
        status: "running",
        startedAt: new Date().toISOString(),
        isolation: "none",
      },
    ];
    const internals = engine as unknown as {
      waitAsyncTasks(record: { id: string; name: string; input: unknown }): Promise<ToolObservation>;
      upsertAsyncTask(task: unknown): void;
    };
    const waitPromise = internals.waitAsyncTasks({
      id: "call_w",
      name: "wait_async_tasks",
      input: { taskIds: ["sub_running"], timeoutMs: 5000 },
    });
    // Flip the task terminal after a beat. The upsert emits
    // async-task-updated which the wait listener consumes.
    setTimeout(() => {
      internals.upsertAsyncTask({
        id: "sub_running",
        agent: "default",
        description: "x",
        status: "completed",
        startedAt: engine.session.asyncTasks![0]!.startedAt,
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "delayed-result",
      });
    }, 30);
    const t0 = Date.now();
    const obs = await waitPromise;
    const elapsed = Date.now() - t0;
    // Wait should have observed the flip; non-zero elapsed proves it
    // actually blocked (vs. early-returned through the fast path).
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(obs.output).toContain(`completed="1"`);
    expect(obs.output).toContain("delayed-result");
  });

  it("wait_async_tasks honors the timeoutMs cap and returns whatever snapshot exists", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "sub_slow",
        agent: "default",
        description: "x",
        status: "running",
        startedAt: new Date().toISOString(),
        isolation: "none",
      },
    ];
    const internals = engine as unknown as {
      waitAsyncTasks(record: { id: string; name: string; input: unknown }): Promise<ToolObservation>;
    };
    const t0 = Date.now();
    const obs = await internals.waitAsyncTasks({
      id: "call_w",
      name: "wait_async_tasks",
      input: { taskIds: ["sub_slow"], timeoutMs: 1000 },
    });
    const elapsed = Date.now() - t0;
    // Roughly the timeout fired. Allow a generous +/- since CI is slow.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
    // Snapshot still shows the task as running — nothing settled it.
    expect(obs.output).toContain(`running="1"`);
  });

  it("wait_async_tasks with no taskIds waits on every currently-running task", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "sub_done",
        agent: "default",
        description: "done already",
        status: "completed",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "ok",
      },
      {
        id: "sub_live",
        agent: "default",
        description: "still going",
        status: "running",
        startedAt: new Date().toISOString(),
        isolation: "none",
      },
    ];
    const internals = engine as unknown as {
      waitAsyncTasks(record: { id: string; name: string; input: unknown }): Promise<ToolObservation>;
      upsertAsyncTask(task: unknown): void;
    };
    const waitPromise = internals.waitAsyncTasks({
      id: "call_w",
      name: "wait_async_tasks",
      input: { timeoutMs: 5000 },
    });
    setTimeout(() => {
      internals.upsertAsyncTask({
        id: "sub_live",
        agent: "default",
        description: "still going",
        status: "completed",
        startedAt: engine.session.asyncTasks![1]!.startedAt,
        completedAt: new Date().toISOString(),
        isolation: "none",
        result: "wrapped up",
      });
    }, 25);
    const obs = await waitPromise;
    // Default-target gather: every task this session has — both rows.
    expect(obs.output).toContain(`count="2"`);
    expect(obs.output).toContain("wrapped up");
  });

  it("host-backed tools stay hidden when the engine has no hostBridge", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    const hostBacked = ["notify", "schedule_wakeup", "kimi_web_search", "kimi_web_fetch"];
    engine.session.activeDeferredTools = hostBacked;
    engine.session.model.subscriptionTools = ["kimi_web_search", "kimi_web_fetch"];
    const names = (await engine.availableTools()).map((tool) => tool.name);
    for (const name of hostBacked) expect(names).not.toContain(name);
  });

  it("schedule_wakeup is advertised after activation when a hostBridge exists", async () => {
    const engine = new AgentEngine({
      cwd,
      agent: "default",
      hostBridge: async () => ({ wakeupId: "w_test", firesAt: new Date().toISOString() }),
    });
    engine.session.activeDeferredTools = ["schedule_wakeup"];
    const names = (await engine.availableTools()).map((tool) => tool.name);
    expect(names).toContain("schedule_wakeup");
  });

  it("generates async subagent ids with the sub_ prefix, never task_", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    const taskId = engine.session.asyncTasks![0]!.id;
    expect(taskId).toMatch(/^sub_/);
    expect(taskId).not.toMatch(/^task_/);
    // Wait for the child to settle so we don't leak it.
    const start = Date.now();
    while (internals.asyncTaskChildren.size > 0) {
      if (Date.now() - start > 5000) throw new Error("child did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("default start_async_task blocks the turn and returns the child's result inline", async () => {
    // The killer use case for sync default: one dispatch → observation
    // already carries <result>. The supervisor doesn't have to chase the
    // result via check_async_task in a second tool round-trip.
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start [default] read README");
    const startCall = engine.session.toolCalls.find((call) => call.name === "start_async_task");
    expect(startCall?.status).toBe("completed");
    expect(startCall?.output).toContain("<status>completed</status>");
    expect(startCall?.output).toContain("<result>");
    expect(startCall?.output).not.toContain("<status>running</status>");
    // And the AsyncTaskRecord has settled by the time runTurn returns —
    // no leftover children running in the engine.
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    expect(internals.asyncTaskChildren.size).toBe(0);
    expect(engine.session.asyncTasks?.[0]!.status).toBe("completed");
  });

  it("explicit background:true returns immediately without blocking on completion", async () => {
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_start_bg [plan] read README");
    const startCall = engine.session.toolCalls.find((call) => call.name === "start_async_task");
    // Background dispatch: observation reports running + background flag,
    // not the result.
    expect(startCall?.status).toBe("completed");
    expect(startCall?.output).toContain("<status>running</status>");
    expect(startCall?.output).toContain("<background>true</background>");
    expect(startCall?.output).not.toContain("<result>");
    // Settle the child before exiting so we don't leak fs handles.
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    const start = Date.now();
    while (internals.asyncTaskChildren.size > 0) {
      if (Date.now() - start > 5000) throw new Error("background task did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("parallel sync start_async_task calls run concurrently via Promise.all batching", async () => {
    // Two sibling dispatches in the same model response. With
    // concurrencySafe + Promise.all batching, both children run in
    // parallel; both block; both observations come back together with
    // their respective <result> elements. Total wall-clock is roughly
    // max(child_a, child_b), not their sum.
    const engine = new AgentEngine({ cwd, agent: "default" });
    // Distinct briefs — same brief in both slots would now be merged by
    // the same-turn dedup guard (see "merges duplicate dispatches"
    // test) and produce only one child.
    await engine.runTurn("async_parallel read README | read package.json");
    const startCalls = engine.session.toolCalls.filter((call) => call.name === "start_async_task");
    expect(startCalls).toHaveLength(2);
    for (const call of startCalls) {
      expect(call.status).toBe("completed");
      expect(call.output).toContain("<status>completed</status>");
      expect(call.output).toContain("<result>");
    }
    // Both tasks finished; nothing left in the live-children map.
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    expect(internals.asyncTaskChildren.size).toBe(0);
  });

  it("merges duplicate same-brief dispatches in the same turn into one child", async () => {
    // Same (agent, brief) fired twice in one batched assistant response
    // should NOT spawn two children — the second call gets a
    // `<status>merged</status>` observation pointing at the first
    // task's id. This catches the failure mode that produced the
    // "name X is already in use" complaint in the wild: models would
    // try to fan-out the SAME investigation across parallel calls and
    // burn 2x compute on identical work.
    const engine = new AgentEngine({ cwd, agent: "default" });
    await engine.runTurn("async_parallel read README | read README");
    const startCalls = engine.session.toolCalls.filter((call) => call.name === "start_async_task");
    expect(startCalls).toHaveLength(2);
    // Exactly one child task got registered.
    expect(engine.session.asyncTasks).toHaveLength(1);
    const taskId = engine.session.asyncTasks![0]!.id;
    // One observation carries the real result, the other is the merged pointer.
    const merged = startCalls.find((call) => call.output?.includes("<status>merged</status>"));
    const realRun = startCalls.find(
      (call) =>
        call.output?.includes("<status>completed</status>") || call.output?.includes("<status>running</status>"),
    );
    expect(merged, "expected one merged observation").toBeTruthy();
    expect(realRun, "expected one non-merged observation").toBeTruthy();
    expect(merged!.output).toContain(`<merged_with>${taskId}</merged_with>`);
    // Drain.
    const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
    const start = Date.now();
    while (internals.asyncTaskChildren.size > 0) {
      if (Date.now() - start > 5000) throw new Error("dispatched task did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("concurrencySafe + reservation counter still enforces the concurrency cap under racy fan-out", async () => {
    // With concurrencySafe=true, two start_async_task calls run via
    // Promise.all. Without the synchronous reservation counter, both
    // dispatchers would observe asyncTaskChildren.size=0 before either
    // had inserted, slipping past a cap=1. The reservation makes the
    // second dispatcher's cap check see a pending in-flight slot.
    process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS = "1";
    try {
      const engine = new AgentEngine({ cwd, agent: "default" });
      // Use background mode so the first dispatch can finish synchronously
      // up to (and through) the registration of asyncTaskChildren, and the
      // test isn't gated on the child's sync wait completing.
      // Distinct briefs — same brief in both slots would now collapse to
      // one task via the same-turn dedup guard, hiding the cap from us.
      await engine.runTurn("async_parallel_bg read README | read package.json");
      const startCalls = engine.session.toolCalls.filter((call) => call.name === "start_async_task");
      expect(startCalls).toHaveLength(2);
      const succeeded = startCalls.filter((call) => call.status === "completed");
      const refused = startCalls.filter((call) => call.status === "failed");
      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.error).toContain("Too many concurrent");
      // Drain.
      const internals = engine as unknown as { asyncTaskChildren: Map<string, unknown> };
      const start = Date.now();
      while (internals.asyncTaskChildren.size > 0) {
        if (Date.now() - start > 5000) throw new Error("dispatched task did not settle");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      delete process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS;
    }
  });

  it("uses the default subagent timeout when the env override is unset", async () => {
    type Profile = (typeof profiles)[number];
    const internals = AgentEngine as unknown as { subagentTimeoutMs(p?: Profile): number };
    expect(internals.subagentTimeoutMs(profiles.find((p) => p.name === "default"))).toBe(600_000);
    // A profile with an explicit cap wins.
    const profileWithCap = { ...profiles[0]!, subagentTimeoutMs: 900_000 };
    expect(internals.subagentTimeoutMs(profileWithCap)).toBe(900_000);
    // Env override still wins so tests can force a tight cap.
    process.env.REINA_SUBAGENT_TIMEOUT_MS = "100";
    try {
      expect(internals.subagentTimeoutMs(profileWithCap)).toBe(100);
    } finally {
      delete process.env.REINA_SUBAGENT_TIMEOUT_MS;
    }
  });
});

function testMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: `msg_${role}_${content.slice(0, 12)}_${Math.random()}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

/** Engine with a long seeded history that has been compacted exactly once.
 * Shared setup for the fork/rollback × compaction-reuse tests. */
async function makeCompactedEngine(): Promise<{
  engine: AgentEngine;
  boundary: NonNullable<Awaited<ReturnType<AgentEngine["compactNow"]>>>;
  internals: { appendMessage(item: ChatMessage): void };
}> {
  const engine = new AgentEngine({
    cwd,
    agent: "default",
    model: { provider: "deterministic", model: "small-context-test", contextWindowTokens: 50_000 },
  });
  for (let index = 0; index < 14; index++) {
    engine.session.messages.push(testMessage("user", `old user detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`));
    engine.session.messages.push(
      testMessage("assistant", `old assistant detail ${index} ${COMPACT_FILLER_UNIT.repeat(19)}`),
    );
  }
  const boundary = await engine.compactNow("compacted-engine fixture");
  if (!boundary) throw new Error("fixture compaction did not run");
  const internals = engine as unknown as { appendMessage(item: ChatMessage): void };
  return { engine, boundary, internals };
}
