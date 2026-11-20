import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord } from "@reina/protocol";
import type { AsyncTaskActivitySnapshot } from "./types.js";
import { formatAsyncTaskSnapshotLine, formatAsyncTaskStatus, formatDurationMs } from "./format.js";

/** Rendering of the liveness fields (lastEventAgoMs / activeToolRunningMs)
 * the supervisor uses to tell "long-running but alive" from "stuck". */

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id: "sub_1",
    agent: "default",
    status: "running",
    isolation: "shared",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  } as AsyncTaskRecord;
}

function snapshot(overrides: Partial<AsyncTaskActivitySnapshot> = {}): AsyncTaskActivitySnapshot {
  return {
    activity: "tool:run_shell",
    recentToolCalls: [],
    errors: [],
    ...overrides,
  };
}

describe("formatDurationMs", () => {
  it("renders seconds / minutes / hours compactly", () => {
    expect(formatDurationMs(15_000)).toBe("15s");
    expect(formatDurationMs(492_000)).toBe("8m12s");
    expect(formatDurationMs(3_780_000)).toBe("1h3m");
    expect(formatDurationMs(-5)).toBe("0s");
  });
});

describe("formatAsyncTaskStatus liveness", () => {
  it("attaches last_event_ago and tool_running_for to the activity element", () => {
    const out = formatAsyncTaskStatus(task(), snapshot({ lastEventAgoMs: 15_000, activeToolRunningMs: 480_000 }));
    expect(out).toContain(`<activity last_event_ago="15s" tool_running_for="8m0s">tool:run_shell</activity>`);
  });

  it("omits the attributes when the snapshot carries no timestamps", () => {
    const out = formatAsyncTaskStatus(task(), snapshot());
    expect(out).toContain(`<activity>tool:run_shell</activity>`);
  });

  it("keeps the normal running hint while events are fresh", () => {
    const out = formatAsyncTaskStatus(task(), snapshot({ lastEventAgoMs: 15_000 }));
    expect(out).toContain("Task is still running.");
    expect(out).not.toContain("No stream events for");
  });

  it("swaps in the silence hint after 2 minutes without events", () => {
    const out = formatAsyncTaskStatus(task(), snapshot({ lastEventAgoMs: 300_000 }));
    expect(out).toContain("No stream events for 5m0s");
    expect(out).toContain("update_async_task");
    expect(out).not.toContain("Task is still running.");
  });
});

describe("formatAsyncTaskSnapshotLine liveness", () => {
  it("appends last_event and tool_running to the one-line summary", () => {
    const line = formatAsyncTaskSnapshotLine(task(), snapshot({ lastEventAgoMs: 15_000, activeToolRunningMs: 480_000 }));
    expect(line).toContain("activity=tool:run_shell");
    expect(line).toContain("last_event=15s_ago");
    expect(line).toContain("tool_running=8m0s");
  });

  it("stays unchanged when the snapshot has no timestamps", () => {
    const line = formatAsyncTaskSnapshotLine(task(), snapshot());
    expect(line).not.toContain("last_event=");
    expect(line).not.toContain("tool_running=");
  });
});
