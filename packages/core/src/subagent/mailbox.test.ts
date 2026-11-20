import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord } from "@reina/protocol";
import {
  BROADCAST_RECIPIENT,
  COORDINATOR_RECIPIENT,
  formatIdleNotification,
  isBroadcastRecipient,
  normalizeRecipient,
} from "./mailbox.js";

describe("normalizeRecipient", () => {
  it("returns undefined for empty / whitespace input", () => {
    expect(normalizeRecipient(undefined)).toBeUndefined();
    expect(normalizeRecipient("")).toBeUndefined();
    expect(normalizeRecipient("   ")).toBeUndefined();
  });

  it("maps `*` to the broadcast pseudo-channel", () => {
    expect(normalizeRecipient("*")).toBe(BROADCAST_RECIPIENT);
  });

  it("trims and passes through regular recipient names", () => {
    expect(normalizeRecipient("auth-reviewer")).toBe("auth-reviewer");
    expect(normalizeRecipient("  worker_1  ")).toBe("worker_1");
    expect(normalizeRecipient(COORDINATOR_RECIPIENT)).toBe(COORDINATOR_RECIPIENT);
  });
});

describe("isBroadcastRecipient", () => {
  it("is true only for the canonical broadcast string", () => {
    expect(isBroadcastRecipient(BROADCAST_RECIPIENT)).toBe(true);
    expect(isBroadcastRecipient("*")).toBe(false);
    expect(isBroadcastRecipient("team-lead")).toBe(false);
    expect(isBroadcastRecipient(undefined)).toBe(false);
  });
});

describe("formatIdleNotification", () => {
  const baseTask: AsyncTaskRecord = {
    id: "sub_aaaa",
    agent: "default",
    description: "summarize the diff",
    status: "completed",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    completedAt: new Date().toISOString(),
    isolation: "none",
    result: "diff summary text here",
  };

  it("includes the task id, agent, status and brief", () => {
    const { title, body, tags } = formatIdleNotification(baseTask);
    expect(title).toContain("sub_aaaa");
    expect(body).toContain("sub_aaaa");
    expect(body).toContain("completed");
    expect(body).toContain("default");
    expect(body).toContain("summarize the diff");
    expect(body).toContain("diff summary text here");
    expect(tags).toContain("mailbox");
    expect(tags).toContain("idle");
    expect(tags).toContain("worker:default");
  });

  it("decorates the handle with the human name when present", () => {
    const { title, body } = formatIdleNotification({ ...baseTask, name: "scout" });
    expect(title).toContain("scout");
    expect(body).toContain("scout");
  });

  it("includes the error envelope on failed tasks", () => {
    const { body } = formatIdleNotification({ ...baseTask, status: "failed", error: "exit 1", result: undefined });
    expect(body).toContain("Error:");
    expect(body).toContain("exit 1");
  });

  it("truncates very long briefs / results to keep the notification compact", () => {
    const long = "x".repeat(2000);
    const { body } = formatIdleNotification({ ...baseTask, description: long, result: long });
    expect(body.length).toBeLessThan(long.length * 2 + 500);
  });
});
