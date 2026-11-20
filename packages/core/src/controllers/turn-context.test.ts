import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../engine.js";
import { rolloutPathFor } from "../rollout.js";
import type { AsyncTaskRecord } from "@reina/protocol";

/** Characterization tests for the start-of-turn context weave (stale-read
 * notice, async-task delta snapshot, completion-notification injection).
 * These behaviors were previously unpinned end-to-end — the formatting
 * units have their own tests (subagent/injector.test.ts, format.ts), but
 * nothing asserted the engine actually weaves them into runTurn. Written
 * against the PUBLIC API (runTurn + session state) so they pin behavior
 * across the extraction into controllers/turn-context.ts. */

const nowStamp = (): string => new Date().toISOString();

let cwd: string;
let oldConfigHome: string | undefined;

async function closeEngineRecorder(engine: AgentEngine): Promise<void> {
  // Full quiesce, not just the recorder: dispose also settles the detached
  // notes-service inits so the afterEach rm doesn't race their writes
  // (EBUSY/ENOTEMPTY on Windows under full-suite load).
  await engine.dispose();
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
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-turnctx-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello reina", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

describe("turn-context injection", () => {
  it("injects a stale-read notice before the user prompt, syncs the mtime, and records a read_file item", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const watched = path.join(cwd, "watched.txt");
    await writeFile(watched, "v1", "utf8");
    const st = await stat(watched);
    // Pretend the file was read 10s before its current mtime — i.e. it
    // changed on disk since the agent last read it.
    const staleMtime = st.mtimeMs - 10_000;
    engine.session.readFileTimestamps = { [watched]: staleMtime };

    await engine.runTurn("hi");

    const messages = engine.session.messages;
    const noticeIdx = messages.findIndex((m) => m.content.includes("These files changed on disk since you last read them"));
    const promptIdx = messages.findIndex((m) => m.role === "user" && m.content === "hi");
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    // The notice is a user-role system note injected BEFORE the prompt so
    // the prompt stays the last user message (deterministic provider
    // matches on it).
    expect(messages[noticeIdx]!.role).toBe("user");
    expect(noticeIdx).toBeLessThan(promptIdx);
    expect(messages[noticeIdx]!.content).toContain("watched.txt");
    // Typed provenance so the renderer hides it without prefix sniffing.
    expect(messages[noticeIdx]!.origin).toBe("stale-read");
    // Mtime synced so the same change is not re-warned next turn.
    expect(engine.session.readFileTimestamps![watched]).toBeGreaterThan(staleMtime + 1);
    // Trace event recorded.
    expect(engine.session.trace.some((e) => e.type === "stale_reads")).toBe(true);

    await closeEngineRecorder(engine);
    // The synced mtime is persisted as a read_file rollout item so replay
    // reconstructs readFileTimestamps.
    const rollout = await readFile(rolloutPathFor(cwd, engine.session.id), "utf8");
    const readFileLine = rollout.split("\n").find((line) => line.includes("\"type\":\"read_file\""));
    expect(readFileLine).toBeDefined();
    expect(readFileLine).toContain("watched.txt");

    // A second turn with no further change stays quiet.
    await engine.runTurn("hi");
    const notices = engine.session.messages.filter((m) => m.content.includes("These files changed on disk since you last read them"));
    expect(notices.length).toBe(1);
  });

  it("injects an async-task delta snapshot and updates the baseline after the diff", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const flipped: AsyncTaskRecord = {
      id: "task_flip",
      agent: "default",
      description: "background work",
      status: "completed",
      startedAt: nowStamp(),
      isolation: "none",
      completedAt: nowStamp(),
    };
    const quiet: AsyncTaskRecord = {
      id: "task_quiet",
      agent: "default",
      description: "still going",
      status: "running",
      startedAt: nowStamp(),
      isolation: "none",
    };
    engine.session.asyncTasks = [flipped, quiet];
    // Previous turn saw both as running: only task_flip changed.
    engine.session.lastTurnTaskStatuses = { task_flip: "running", task_quiet: "running" };

    await engine.runTurn("hi");

    const note = engine.session.messages.find((m) => m.content.includes("Subagent task state changes since last turn"));
    expect(note).toBeDefined();
    expect(note!.role).toBe("user");
    expect(note!.origin).toBe("task-delta");
    expect(note!.content).toContain("task_flip");
    expect(note!.content).toContain("(running → completed)");
    // Quiet tasks (no state change) stay out of the prompt.
    expect(note!.content).not.toContain("task_quiet");
    // Baseline updated AFTER the diff so the next turn compares against
    // THIS turn's state.
    expect(engine.session.lastTurnTaskStatuses).toEqual({ task_flip: "completed", task_quiet: "running" });
    expect(engine.session.trace.some((e) => e.type === "stale_reads" && (e.data as { kind?: string }).kind === "async_tasks_delta")).toBe(true);

    // No changes since the snapshot → the next turn injects nothing.
    await engine.runTurn("hi");
    const notes = engine.session.messages.filter((m) => m.content.includes("Subagent task state changes since last turn"));
    expect(notes.length).toBe(1);

    await closeEngineRecorder(engine);
  });

  it("marks a task never seen before as (new) in the delta snapshot", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    engine.session.asyncTasks = [
      {
        id: "task_fresh",
        agent: "default",
        description: "just dispatched",
        status: "completed",
        startedAt: nowStamp(),
        isolation: "none",
        completedAt: nowStamp(),
      },
    ];
    engine.session.lastTurnTaskStatuses = {};

    await engine.runTurn("hi");

    const note = engine.session.messages.find((m) => m.content.includes("Subagent task state changes since last turn"));
    expect(note).toBeDefined();
    expect(note!.content).toContain("task_fresh");
    expect(note!.content).toContain("(new)");

    await closeEngineRecorder(engine);
  });

  it("drains settled completion notifications into a user-role <task-notifications> message", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    const internals = engine as unknown as {
      subagent: { injector: { enqueue(task: AsyncTaskRecord): void } };
    };
    const settled: AsyncTaskRecord = {
      id: "task_note",
      agent: "default",
      description: "background job",
      status: "completed",
      startedAt: nowStamp(),
      isolation: "none",
      completedAt: nowStamp(),
      result: "job done",
    };
    internals.subagent.injector.enqueue(settled);
    expect(engine.hasPendingCompletionNotifications()).toBe(true);

    await engine.runTurn("hi");

    const note = engine.session.messages.find((m) => m.content.includes("<task-notifications"));
    expect(note).toBeDefined();
    expect(note!.role).toBe("user");
    expect(note!.origin).toBe("task-notify");
    expect(note!.content).toContain("<task_id>task_note</task_id>");
    expect(note!.content).toContain("job done");
    // Drained at the turn boundary — nothing left pending.
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
    expect(engine.session.trace.some((e) => e.type === "async_task.injected")).toBe(true);

    await closeEngineRecorder(engine);
  });

  it("refreshes workspace skills from disk at the start of every turn", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    expect(engine.session.skills.find((s) => s.name === "lint-fix")).toBeUndefined();
    // Skill added AFTER engine creation — picked up by the per-turn refresh.
    const skillDir = path.join(cwd, ".claude", "skills", "lint-fix");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: lint-fix\ndescription: Fix lint errors\n---\nRun the linter.\n",
      "utf8",
    );

    await engine.runTurn("hi");

    expect(engine.session.skills.find((s) => s.name === "lint-fix")).toBeDefined();
    await closeEngineRecorder(engine);
  });
});
