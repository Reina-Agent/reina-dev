import { describe, expect, it } from "vitest";
import {
  foldSubagentActivityEvent,
  foldSubagentActivityRecords,
  mergeSubagentActivityRecords,
  settlePendingActivityWaits,
  type ActivityEntry,
  type ActivitySourceRecord,
} from "./subagentActivity";

function fold(
  buffer: ActivityEntry[],
  event: { type: string; [key: string]: unknown },
  timestamp = "2026-08-30T10:00:00.000Z",
): ActivityEntry[] {
  return foldSubagentActivityEvent(buffer, event, timestamp) ?? buffer;
}

describe("foldSubagentActivityEvent", () => {
  it("preserves human and supervisor messages once when live history is replayed", () => {
    const createdAt = "2026-09-09T10:00:00.000Z";
    const message = {
      type: "task-message",
      id: "update-1",
      text: "Keep the database unchanged",
      sender: "user",
      createdAt,
    };
    const disk: ActivitySourceRecord[] = [{ event: message, timestamp: createdAt }];
    const live: ActivitySourceRecord[] = [
      { event: message, timestamp: createdAt, persisted: true },
      {
        event: { ...message, id: "update-2", sender: "supervisor", text: "Focus on the UI" },
        timestamp: createdAt,
        persisted: true,
      },
    ];
    let buffer = foldSubagentActivityRecords(mergeSubagentActivityRecords(disk, live));
    buffer = fold(buffer, message);

    expect(buffer).toHaveLength(2);
    expect(buffer.map((entry) => [entry.sender, entry.text])).toEqual([
      ["user", "Keep the database unchanged"],
      ["supervisor", "Focus on the UI"],
    ]);
    expect(buffer[0]).toMatchObject({ messageId: "update-1", name: "You", ts: createdAt });
  });

  it("keeps replies separate across a steering boundary and retains final-only answers", () => {
    let buffer = fold([], { type: "task-turn-started", id: "turn-1" });
    buffer = fold(buffer, { type: "text-delta", text: "Previous answer" });
    buffer = fold(buffer, { type: "task-turn-completed", id: "turn-1", text: "Previous answer" });
    buffer = fold(buffer, { type: "task-message", id: "update-1", sender: "user", text: "Continue" });
    buffer = fold(buffer, { type: "task-turn-started", id: "turn-2" });
    buffer = fold(buffer, { type: "text-delta", text: "Checking the details" });
    buffer = fold(buffer, { type: "task-turn-completed", id: "turn-2", text: "Final structured answer" });
    buffer = fold(buffer, { type: "task-turn-completed", id: "turn-2", text: "Final structured answer" });

    expect(buffer.filter((entry) => entry.kind === "text").map((entry) => entry.text)).toEqual([
      "Previous answer",
      "Checking the details",
      "Final structured answer",
    ]);
    expect(buffer.filter((entry) => entry.kind === "message")).toHaveLength(1);
  });

  it("does not treat an accepted update as an answered approval", () => {
    let buffer = fold([], { type: "permission-request", toolCall: { id: "approval-1", status: "pending_approval" } });
    buffer = fold(buffer, { type: "task-message", id: "update-1", sender: "user", text: "Use another approach" });
    expect(buffer[0]?.status).toBe("pending_approval");
    buffer = fold(buffer, { type: "task-turn-started", id: "turn-2" });
    expect(buffer[0]?.status).toBe("interrupted");
  });

  it("retains conversation history through a tool-heavy turn and disk replay", () => {
    const events = [
      { type: "task-turn-started", id: "first" },
      { type: "task-turn-completed", id: "first", text: "Previous final answer" },
      { type: "task-message", id: "human", sender: "user", text: "Check all files" },
      { type: "task-message", id: "main", sender: "supervisor", text: "Preserve the existing API" },
      { type: "task-turn-started", id: "second" },
      ...Array.from({ length: 250 }, (_, index) => ({
        type: "tool-progress",
        id: `read-${index}`,
        name: "read_file",
        status: "completed",
      })),
      { type: "task-turn-completed", id: "second", text: "All files checked" },
    ];
    const records = events.map((event) => ({ event, timestamp: "2026-09-09T10:00:00.000Z" }));
    const replayed = foldSubagentActivityRecords(records);
    const live = events.reduce(
      (buffer, event) => fold(buffer, event, "2026-09-09T10:00:00.000Z"),
      [] as ActivityEntry[],
    );
    expect(replayed).toEqual(live);
    expect(replayed.filter((entry) => entry.kind === "tool")).toHaveLength(200);
    expect(
      replayed.filter((entry) => entry.kind === "message" || entry.kind === "text").map((entry) => entry.text),
    ).toEqual(["Previous final answer", "Check all files", "Preserve the existing API", "All files checked"]);
  });

  it("keeps one tool row and fills in its final details", () => {
    const running = fold([], {
      type: "tool-progress",
      id: "call-1",
      name: "run_shell",
      status: "running",
      input: { command: "npm test" },
    });
    const completed = fold(
      running,
      {
        type: "tool-progress",
        id: "call-1",
        name: "run_shell",
        status: "completed",
        output: "18 passed",
        elapsedMs: 1_250,
        totalLines: 18,
      },
      "2026-08-30T10:00:01.250Z",
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      key: "tool-call-1",
      name: "run_shell",
      status: "completed",
      input: { command: "npm test" },
      output: "18 passed",
      elapsedMs: 1_250,
      totalLines: 18,
      updatedAt: "2026-08-30T10:00:01.250Z",
    });
  });

  it("preserves reasoning order across intervening tool calls", () => {
    let buffer = fold([], { type: "reasoning-delta", text: "plan" });
    buffer = fold(buffer, {
      type: "tool-progress",
      id: "call-1",
      name: "read_file",
      status: "completed",
    });
    buffer = fold(buffer, { type: "reasoning-delta", text: "verify" });

    expect(buffer.map((entry) => entry.kind)).toEqual(["reasoning", "tool", "reasoning"]);
    expect(buffer.map((entry) => entry.text).filter(Boolean)).toEqual(["plan", "verify"]);
  });

  it("coalesces only adjacent streamed text", () => {
    let buffer = fold([], { type: "text-delta", text: "first " });
    buffer = fold(buffer, { type: "text-delta", text: "round" });
    buffer = fold(buffer, { type: "user-message", text: "check Windows too" });
    buffer = fold(buffer, { type: "text-delta", text: "second round" });

    expect(buffer).toHaveLength(3);
    expect(buffer[0]?.text).toBe("first round");
    expect(buffer[1]).toMatchObject({ kind: "message", name: "Supervisor update" });
    expect(buffer[2]?.text).toBe("second round");
  });

  it("maps questions, approvals and runtime events into inspectable rows", () => {
    let buffer = fold([], {
      type: "question-request",
      question: { id: "q-1", header: "Scope", question: "Include recovery?", status: "pending" },
    });
    buffer = fold(buffer, {
      type: "permission-request",
      toolCall: {
        id: "call-2",
        name: "write_file",
        status: "pending_approval",
        summary: "Write the generated snapshot",
        input: { path: "snapshot.json" },
      },
    });
    buffer = fold(buffer, {
      type: "usage-updated",
      usage: { inputTokens: 1_200, outputTokens: 300 },
    });

    expect(buffer).toHaveLength(3);
    expect(buffer[0]).toMatchObject({ kind: "wait", key: "question-q-1", name: "Scope" });
    expect(buffer[1]).toMatchObject({ kind: "wait", key: "approval-call-2", name: "Approval · write_file" });
    expect(buffer[2]).toMatchObject({
      kind: "system",
      name: "Usage updated",
      payload: { inputTokens: 1_200, outputTokens: 300 },
    });
  });

  it("dedupes replayed gates and keeps only the latest usage checkpoint", () => {
    let buffer = fold([], {
      type: "question-request",
      question: { id: "q-1", question: "First wording", status: "pending" },
    });
    buffer = fold(buffer, {
      type: "question-request",
      question: { id: "q-1", question: "Updated wording", status: "pending" },
    });
    buffer = fold(buffer, { type: "usage-updated", usage: { inputTokens: 100 } });
    buffer = fold(buffer, { type: "usage-updated", usage: { inputTokens: 250 } });

    expect(buffer).toHaveLength(2);
    expect(buffer[0]?.text).toBe("Updated wording");
    expect(buffer[1]?.payload).toEqual({ inputTokens: 250 });
  });

  it("drops the abandoned streaming round before recording a retry", () => {
    let buffer = fold([], { type: "text-delta", text: "partial answer" });
    buffer = fold(buffer, { type: "reasoning-delta", text: "partial reasoning" });
    buffer = fold(buffer, { type: "stream-reset" });

    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toMatchObject({ kind: "system", eventType: "stream-reset", name: "Stream retry" });
  });

  it("surfaces watchdog warnings with their idle duration", () => {
    const buffer = fold([], {
      type: "async-task-warning",
      taskId: "task-1",
      reason: "stale-in-tool",
      idleMs: 54_200,
      remainingMs: 45_800,
    });

    expect(buffer[0]).toMatchObject({
      kind: "warning",
      eventType: "async-task-warning",
      name: "Worker idle warning",
      text: "stale-in-tool · no activity for 54s",
    });
  });

  it("retains new stream deltas after compacting a long activity row", () => {
    let buffer = fold([], { type: "reasoning-delta", text: "a".repeat(24_100) });
    buffer = fold(buffer, { type: "reasoning-delta", text: "LATEST" });

    expect(buffer).toHaveLength(1);
    expect(buffer[0]?.text).toHaveLength(24_000);
    expect(buffer[0]?.text?.endsWith("LATEST")).toBe(true);
    expect(buffer[0]?.text).toContain("\n…\n");
  });

  it("settles pending gates when the worker resumes or the task ends", () => {
    let buffer = fold([], {
      type: "permission-request",
      toolCall: { id: "call-2", name: "write_file", status: "pending_approval" },
    });
    buffer = fold(buffer, {
      type: "tool-progress",
      id: "call-2",
      name: "write_file",
      status: "running",
    });

    expect(buffer.find((entry) => entry.eventType === "permission-request")).toMatchObject({
      status: "resolved",
      text: "Decision received",
    });

    const waiting = fold([], {
      type: "question-request",
      question: { id: "q-1", question: "Continue?", status: "pending" },
    });
    expect(settlePendingActivityWaits(waiting, "2026-08-30T10:01:00.000Z")?.[0]).toMatchObject({
      status: "resolved",
      text: "Answer received",
    });
    expect(settlePendingActivityWaits(waiting, "2026-08-30T10:01:00.000Z", "interrupted")?.[0]).toMatchObject({
      status: "interrupted",
      text: "Worker interrupted before a response",
    });
  });

  it("merges a durable prefix with the unflushed live tail without collapsing repeated events", () => {
    const record = (text: string, timestamp: string): ActivitySourceRecord => ({
      event: { type: "text-delta", text },
      timestamp,
    });
    const disk = [record("same", "2026-08-30T10:00:00.000Z")];
    const live = [
      record("same", "2026-08-30T10:00:00.010Z"),
      record("same", "2026-08-30T10:00:00.020Z"),
      record("tail", "2026-08-30T10:00:00.030Z"),
    ];

    expect(mergeSubagentActivityRecords(disk, live)).toEqual([disk[0], live[1], live[2]]);
  });

  it("keeps parent-only activity in chronological order while deduping persisted child events", () => {
    const disk: ActivitySourceRecord[] = [
      { event: { type: "reasoning-delta", text: "before" }, timestamp: "2026-08-30T10:00:00.005Z" },
      { event: { type: "text-delta", text: "after" }, timestamp: "2026-08-30T10:00:00.030Z" },
    ];
    const live: ActivitySourceRecord[] = [
      { event: disk[0]!.event, timestamp: "2026-08-30T10:00:00.010Z", persisted: true },
      {
        event: { type: "async-task-warning", reason: "stale-idle" },
        timestamp: "2026-08-30T10:00:00.020Z",
        persisted: false,
      },
      { event: disk[1]!.event, timestamp: "2026-08-30T10:00:00.040Z", persisted: true },
    ];

    expect(mergeSubagentActivityRecords(disk, live).map((record) => record.event.type)).toEqual([
      "reasoning-delta",
      "async-task-warning",
      "text-delta",
    ]);
  });
});
