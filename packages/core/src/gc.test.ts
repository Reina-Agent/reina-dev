import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "./engine.js";
import { sweepOrphanWorktrees, sweepStaleTaskDirs } from "./gc.js";

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

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true).catch(() => false);

/** Backdate a file/dir so it falls on the stale side of a sweep cutoff. */
async function backdate(p: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  await utimes(p, then, then);
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedTaskDir(root: string, id: string, opts: { streamFile: boolean; ageMs?: number }): Promise<string> {
  const dir = path.join(root, ".reina", "tasks", id);
  await mkdir(dir, { recursive: true });
  if (opts.streamFile) {
    const stream = path.join(dir, "stream.jsonl");
    await writeFile(stream, "{}\n", "utf8");
    if (opts.ageMs) await backdate(stream, opts.ageMs);
  } else if (opts.ageMs) {
    await backdate(dir, opts.ageMs);
  }
  return dir;
}

async function seedWorktreeDir(root: string, id: string, ageMs?: number): Promise<string> {
  const dir = path.join(root, ".reina", "worktrees", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "placeholder.txt"), "wt", "utf8");
  // Backdate AFTER writing contents — creating the file bumps the dir mtime.
  if (ageMs) await backdate(dir, ageMs);
  return dir;
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-gc-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

describe("workspace GC sweeps", () => {
  it("sweepStaleTaskDirs reaps stale task dirs, keeps fresh ones, and skips running tasks", async () => {
    const stale = await seedTaskDir(cwd, "task_stale", { streamFile: true, ageMs: 8 * DAY_MS });
    const fresh = await seedTaskDir(cwd, "task_fresh", { streamFile: true });
    const active = await seedTaskDir(cwd, "task_active", { streamFile: true, ageMs: 8 * DAY_MS });
    const done = await seedTaskDir(cwd, "task_done", { streamFile: true, ageMs: 8 * DAY_MS });
    const emptyOld = await seedTaskDir(cwd, "task_empty_old", { streamFile: false, ageMs: 8 * DAY_MS });
    const emptyFresh = await seedTaskDir(cwd, "task_empty_fresh", { streamFile: false });
    const reported: string[] = [];

    // Only "running" ids belong in the active set — mirrors the engine's
    // wiring closure filtering session.asyncTasks by status === "running"
    // (a completed task like task_done gets no protection).
    await sweepStaleTaskDirs(
      () => cwd,
      () => new Set(["task_active"]),
      (category) => reported.push(category),
    );

    // Older than the 7d cutoff and not running: reaped.
    expect(await exists(stale)).toBe(false);
    // Completed tasks get no active-skip protection — age alone decides.
    expect(await exists(done)).toBe(false);
    // No stream.jsonl + old dir: reaped; no stream.jsonl + young dir: kept.
    expect(await exists(emptyOld)).toBe(false);
    expect(await exists(emptyFresh)).toBe(true);
    // Fresh stream file: kept.
    expect(await exists(fresh)).toBe(true);
    // Still flagged running in this session: kept even though stale.
    expect(await exists(active)).toBe(true);
    // Happy path: nothing hit the per-entry error reporter.
    expect(reported).toEqual([]);
  });

  it("sweepOrphanWorktrees reaps >24h orphan worktrees, keeps young ones, and skips running tasks", async () => {
    const orphan = await seedWorktreeDir(cwd, "wt_orphan", 25 * 60 * 60 * 1000);
    const young = await seedWorktreeDir(cwd, "wt_young");
    const active = await seedWorktreeDir(cwd, "wt_active", 25 * 60 * 60 * 1000);
    const reported: string[] = [];

    await sweepOrphanWorktrees(
      () => cwd,
      () => new Set(["wt_active"]),
      (category) => reported.push(category),
    );

    // Past the 24h orphan cutoff: reaped (cwd is not a git repo, so this also
    // exercises the removeWorktree -> plain rm fallback).
    expect(await exists(orphan)).toBe(false);
    // Younger than the cutoff: never touched (could be a live sibling's).
    expect(await exists(young)).toBe(true);
    // Running in this session: kept regardless of age.
    expect(await exists(active)).toBe(true);
    expect(reported).toEqual([]);
  });

  it("missing roots are a silent no-op", async () => {
    // Fresh workspace with no .reina/tasks or .reina/worktrees at all: both
    // sweeps must return without reporting anything.
    const reported: string[] = [];
    const report = (category: string): void => {
      reported.push(category);
    };
    await sweepStaleTaskDirs(() => cwd, () => new Set(), report);
    await sweepOrphanWorktrees(() => cwd, () => new Set(), report);
    expect(reported).toEqual([]);
  });

  it("engine construction fires both sweeps in the background", async () => {
    // Public-API pin: seed BEFORE construction, then just build an engine and
    // wait for the constructor's fire-and-forget sweeps to reap the stale
    // entries. No private access — this must survive any internal refactor.
    const staleTask = await seedTaskDir(cwd, "task_ctor_stale", { streamFile: true, ageMs: 8 * DAY_MS });
    const freshTask = await seedTaskDir(cwd, "task_ctor_fresh", { streamFile: true });
    const orphanWt = await seedWorktreeDir(cwd, "wt_ctor_orphan", 25 * 60 * 60 * 1000);
    const youngWt = await seedWorktreeDir(cwd, "wt_ctor_young");

    const engine = await AgentEngine.create({ cwd, agent: "default" });
    await vi.waitFor(
      async () => {
        expect(await exists(staleTask)).toBe(false);
        expect(await exists(orphanWt)).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(await exists(freshTask)).toBe(true);
    expect(await exists(youngWt)).toBe(true);
    await closeEngineRecorder(engine);
  });
});
