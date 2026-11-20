import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelStreamEvent } from "@reina/protocol";
import { ActivityTracker } from "./activity.js";

/** Activity tracker is the in-memory cache that makes check_async_task
 * O(1) — see manager.ts:readActivity. Verifies the snapshot is
 * built correctly from observed stream events without ever touching
 * disk. */

function textDelta(text: string): ModelStreamEvent {
  return { type: "text-delta", text } as unknown as ModelStreamEvent;
}
function toolProgress(name: string, status: string, id = `c_${name}`): ModelStreamEvent {
  return { type: "tool-progress", name, status, id } as unknown as ModelStreamEvent;
}
function toolFailed(name: string, message: string, id = `c_${name}`): ModelStreamEvent {
  return { type: "tool-progress", name, status: "failed", id, message } as unknown as ModelStreamEvent;
}

describe("ActivityTracker", () => {
  it("returns undefined for an unknown task", () => {
    const t = new ActivityTracker();
    expect(t.get("sub_unknown")).toBeUndefined();
  });

  it("stays at 'starting' for unrelated event types until meaningful progress shows up", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", { type: "something-else" } as unknown as ModelStreamEvent);
    // Mirrors the on-disk reader: non-text / non-tool / non-error
    // events don't move the activity needle, so the supervisor sees
    // 'starting' until a real progress signal arrives.
    expect(t.get("sub_a")?.activity).toBe("starting");
  });

  it("reports 'streaming' when the last event is a text delta", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", textDelta("hello "));
    t.observe("sub_a", textDelta("world"));
    const snap = t.get("sub_a");
    expect(snap?.activity).toBe("streaming");
    expect(snap?.lastAssistantText).toBe("hello world");
  });

  it("reports 'tool:NAME' while a tool is running", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("read", "running"));
    expect(t.get("sub_a")?.activity).toBe("tool:read");
  });

  it("clears the active tool once it completes", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("read", "running"));
    t.observe("sub_a", toolProgress("read", "completed"));
    expect(t.get("sub_a")?.activity).toBe("idle");
  });

  it("captures the last few errors", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", toolFailed("write", "permission denied", "c1"));
    t.observe("sub_a", toolFailed("git", "no such ref", "c2"));
    t.observe("sub_a", toolFailed("read", "no such file", "c3"));
    t.observe("sub_a", toolFailed("net", "timed out", "c4"));
    const snap = t.get("sub_a");
    expect(snap?.errors).toHaveLength(3);
    expect(snap?.errors[0]).toContain("git");
    expect(snap?.errors[2]).toContain("net");
  });

  it("recent text never exceeds the 400-char tail", () => {
    const t = new ActivityTracker();
    for (let i = 0; i < 200; i++) t.observe("sub_a", textDelta("x"));
    const snap = t.get("sub_a");
    expect(snap?.lastAssistantText?.length).toBeLessThanOrEqual(400);
  });

  it("recentToolCalls returns the last 3 distinct calls", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("a", "completed", "c1"));
    t.observe("sub_a", toolProgress("b", "completed", "c2"));
    t.observe("sub_a", toolProgress("c", "completed", "c3"));
    t.observe("sub_a", toolProgress("d", "completed", "c4"));
    const snap = t.get("sub_a");
    expect(snap?.recentToolCalls.map((c) => c.name)).toEqual(["b", "c", "d"]);
  });

  it("drop() removes the cache entry", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", textDelta("hi"));
    expect(t.size()).toBe(1);
    t.drop("sub_a");
    expect(t.size()).toBe(0);
    expect(t.get("sub_a")).toBeUndefined();
  });

  it("tracks multiple tasks independently", () => {
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("read", "running"));
    t.observe("sub_b", textDelta("hi"));
    expect(t.get("sub_a")?.activity).toBe("tool:read");
    expect(t.get("sub_b")?.activity).toBe("streaming");
  });
});

/** The silence clock is what lets the supervisor tell "long-running but
 * alive" (fresh events) from "actually stuck" (sustained silence) — the
 * evidence behind the check → steer → cancel escalation. */
describe("ActivityTracker timestamps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports lastEventAgoMs as the silence since the last observed event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = new ActivityTracker();
    t.observe("sub_a", textDelta("hi"));
    vi.setSystemTime(1_030_000);
    expect(t.get("sub_a")?.lastEventAgoMs).toBe(30_000);
  });

  it("even ignored event types reset the silence clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = new ActivityTracker();
    t.observe("sub_a", textDelta("hi"));
    vi.setSystemTime(1_060_000);
    t.observe("sub_a", { type: "something-else" } as unknown as ModelStreamEvent);
    vi.setSystemTime(1_070_000);
    expect(t.get("sub_a")?.lastEventAgoMs).toBe(10_000);
  });

  it("measures activeToolRunningMs from the FIRST running tick; repeats don't reset it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("run_shell", "running"));
    vi.setSystemTime(1_060_000);
    t.observe("sub_a", toolProgress("run_shell", "running"));
    vi.setSystemTime(1_090_000);
    const snap = t.get("sub_a");
    expect(snap?.activity).toBe("tool:run_shell");
    expect(snap?.activeToolRunningMs).toBe(90_000);
    expect(snap?.lastEventAgoMs).toBe(30_000);
  });

  it("clears activeToolRunningMs once the tool settles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("read", "running"));
    t.observe("sub_a", toolProgress("read", "completed"));
    expect(t.get("sub_a")?.activeToolRunningMs).toBeUndefined();
    expect(t.get("sub_a")?.lastEventAgoMs).toBe(0);
  });

  it("a back-to-back second call of the same tool restarts the runtime clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = new ActivityTracker();
    t.observe("sub_a", toolProgress("read", "running", "c1"));
    t.observe("sub_a", toolProgress("read", "completed", "c1"));
    vi.setSystemTime(1_060_000);
    t.observe("sub_a", toolProgress("read", "running", "c2"));
    vi.setSystemTime(1_070_000);
    expect(t.get("sub_a")?.activeToolRunningMs).toBe(10_000);
  });
});
