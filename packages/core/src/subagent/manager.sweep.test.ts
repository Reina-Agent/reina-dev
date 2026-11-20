import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AsyncTaskRecord, ModelStreamEvent, SessionState } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import type { SubagentHost } from "./types.js";
import { SubagentManager } from "./manager.js";
import { testHost as mockHost, testSession as mockSession } from "./test-helpers.js";

/** SubagentManager has been refactored to (a) cap the live asyncTasks
 * roster and overflow into asyncTasksArchived, (b) debounce sweep so
 * hot upsert paths don't pay O(n) for each call, and (c) skip the
 * live-stream emit on metadata-only updates. This file targets those
 * three guarantees through the public upsertAsyncTask entry. */

function rec(over: Partial<AsyncTaskRecord> & Pick<AsyncTaskRecord, "id">): AsyncTaskRecord {
  return {
    agent: "default",
    description: "x",
    status: "completed",
    startedAt: nowIso(),
    isolation: "none",
    ...over,
  };
}

describe("SubagentManager.upsertAsyncTask — substantive-diff gating", () => {
  let session: SessionState;
  let host: SubagentHost;
  let emitted: ModelStreamEvent[];
  let mgr: SubagentManager;
  beforeEach(() => {
    session = mockSession();
    const h = mockHost(session);
    host = h.host;
    emitted = h.emitted;
    mgr = new SubagentManager(host);
  });

  it("emits async-task-updated on the initial insert", () => {
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "running" }));
    expect(emitted.filter((e) => e.type === "async-task-updated")).toHaveLength(1);
  });

  it("emits when status changes (running -> completed)", () => {
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "running" }));
    emitted.length = 0;
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "completed", result: "ok" }));
    expect(emitted.filter((e) => e.type === "async-task-updated")).toHaveLength(1);
  });

  it("SKIPS emit when only notifiedAt changes (metadata-only)", () => {
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "completed", result: "ok" }));
    emitted.length = 0;
    mgr.upsertAsyncTask(
      rec({ id: "sub_a", status: "completed", result: "ok", notifiedAt: nowIso() }),
    );
    expect(emitted.filter((e) => e.type === "async-task-updated")).toHaveLength(0);
  });

  it("SKIPS emit when only injectedAt changes", () => {
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "completed", result: "ok" }));
    emitted.length = 0;
    mgr.upsertAsyncTask(
      rec({ id: "sub_a", status: "completed", result: "ok", injectedAt: nowIso() }),
    );
    expect(emitted.filter((e) => e.type === "async-task-updated")).toHaveLength(0);
  });

  it("emits when usage tokens change", () => {
    mgr.upsertAsyncTask(rec({ id: "sub_a", status: "completed", result: "r" }));
    emitted.length = 0;
    mgr.upsertAsyncTask(
      rec({
        id: "sub_a",
        status: "completed",
        result: "r",
        usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 1 },
      }),
    );
    expect(emitted.filter((e) => e.type === "async-task-updated")).toHaveLength(1);
  });
});

describe("SubagentManager.sweepEvictable — overflow archive", () => {
  let prevCap: string | undefined;
  beforeEach(() => {
    prevCap = process.env.REINA_MAX_LIVE_ASYNC_TASKS;
    process.env.REINA_MAX_LIVE_ASYNC_TASKS = "3";
  });
  afterEach(() => {
    if (prevCap === undefined) delete process.env.REINA_MAX_LIVE_ASYNC_TASKS;
    else process.env.REINA_MAX_LIVE_ASYNC_TASKS = prevCap;
  });

  it("archives oldest notifiedAt entries once over cap", () => {
    const session = mockSession();
    const { host } = mockHost(session);
    const mgr = new SubagentManager(host);

    // Insert 4 completed+notified tasks, oldest first.
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      mgr.upsertAsyncTask(
        rec({
          id: `sub_${i}`,
          status: "completed",
          result: `r${i}`,
          notifiedAt: new Date(base + i * 1000).toISOString(),
        }),
      );
    }
    // Live array should be capped at 3; one (oldest = sub_0) archived.
    expect(session.asyncTasks?.map((t) => t.id)).toEqual(["sub_1", "sub_2", "sub_3"]);
    expect(session.asyncTasksArchived?.map((t) => t.id)).toEqual(["sub_0"]);
    expect(session.asyncTasksArchived?.[0]!.archived).toBe(true);
  });

  it("never archives running tasks even when over cap", () => {
    const session = mockSession();
    const { host } = mockHost(session);
    const mgr = new SubagentManager(host);

    mgr.upsertAsyncTask(rec({ id: "sub_run1", status: "running" }));
    mgr.upsertAsyncTask(rec({ id: "sub_run2", status: "running" }));
    mgr.upsertAsyncTask(rec({ id: "sub_run3", status: "running" }));
    mgr.upsertAsyncTask(rec({ id: "sub_run4", status: "running" }));
    // No archivable candidates (no notifiedAt), live array stays at 4.
    expect(session.asyncTasks).toHaveLength(4);
    expect(session.asyncTasksArchived).toBeUndefined();
  });

  it("never archives unread (terminal but not notified) entries", () => {
    const session = mockSession();
    const { host } = mockHost(session);
    const mgr = new SubagentManager(host);

    // 4 completed but not notified — supervisor hasn't read them, mustn't archive.
    for (let i = 0; i < 4; i++) {
      mgr.upsertAsyncTask(rec({ id: `sub_${i}`, status: "completed", result: `r${i}` }));
    }
    expect(session.asyncTasks).toHaveLength(4);
    expect(session.asyncTasksArchived).toBeUndefined();
  });
});

describe("SubagentManager.maybeSweep — debounce", () => {
  let prevCap: string | undefined;
  beforeEach(() => {
    // Force a low cap so we have an over-cap path to exercise too.
    prevCap = process.env.REINA_MAX_LIVE_ASYNC_TASKS;
    process.env.REINA_MAX_LIVE_ASYNC_TASKS = "5";
  });
  afterEach(() => {
    if (prevCap === undefined) delete process.env.REINA_MAX_LIVE_ASYNC_TASKS;
    else process.env.REINA_MAX_LIVE_ASYNC_TASKS = prevCap;
  });

  it("under-cap rapid upserts on existing records do not push extra sweep traces", () => {
    const session = mockSession();
    const { host } = mockHost(session);
    const mgr = new SubagentManager(host);

    // Insert 3 NOT-yet-notified completed tasks (no archive eligible) —
    // each insert may or may not push a sweep trace depending on timing,
    // but they're all under the cap of 5.
    for (let i = 0; i < 3; i++) {
      mgr.upsertAsyncTask(rec({ id: `sub_${i}`, status: "completed" }));
    }
    const tracesBefore = session.trace.filter((t) => t.type === "async_task.completed").length;
    // Many rapid REPEATED upserts on the same ids: notifiedAt timestamps
    // are metadata-only (no archive triggers) and the debounce window
    // is 30s, so sweep should NOT re-run.
    for (let j = 0; j < 10; j++) {
      mgr.upsertAsyncTask(rec({ id: `sub_${j % 3}`, status: "completed", notifiedAt: nowIso() }));
    }
    const tracesAfter = session.trace.filter((t) => t.type === "async_task.completed").length;
    expect(tracesAfter).toBe(tracesBefore);
  });

  it("over-cap upserts BYPASS the debounce gate (forces immediate sweep)", () => {
    const session = mockSession();
    const { host } = mockHost(session);
    const mgr = new SubagentManager(host);

    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      mgr.upsertAsyncTask(
        rec({
          id: `sub_${i}`,
          status: "completed",
          result: `r${i}`,
          notifiedAt: new Date(base + i * 1000).toISOString(),
        }),
      );
    }
    // Under cap (5), no archive needed.
    expect(session.asyncTasksArchived).toBeUndefined();
    // 5th insert puts us at the cap; 6th will trigger an immediate sweep
    // because over-cap bypasses the 30s debounce.
    mgr.upsertAsyncTask(
      rec({ id: "sub_5", status: "completed", result: "r5", notifiedAt: new Date(base + 5000).toISOString() }),
    );
    mgr.upsertAsyncTask(
      rec({ id: "sub_6", status: "completed", result: "r6", notifiedAt: new Date(base + 6000).toISOString() }),
    );
    // Cap is 5; we inserted 6 entries (sub_0..sub_6 minus dedup). Oldest
    // notifiedAt (sub_0, sub_1) should now live in the archive.
    expect(session.asyncTasks?.length ?? 0).toBeLessThanOrEqual(5);
    expect(session.asyncTasksArchived?.length ?? 0).toBeGreaterThan(0);
  });
});
