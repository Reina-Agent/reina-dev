import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord } from "@reina/protocol";
import { resolveTaskRef, validateName } from "./registry.js";

function task(over: Partial<AsyncTaskRecord> & Pick<AsyncTaskRecord, "id">): AsyncTaskRecord {
  return {
    agent: "default",
    description: "x",
    status: "running",
    startedAt: new Date().toISOString(),
    isolation: "none",
    ...over,
  };
}

describe("validateName", () => {
  it("accepts plain ASCII identifiers", () => {
    expect(validateName("auth-reviewer", []).ok).toBe(true);
    expect(validateName("worker_1", []).ok).toBe(true);
    expect(validateName("a.b.c", []).ok).toBe(true);
  });

  it("rejects empty / whitespace-only names", () => {
    expect(validateName("", []).ok).toBe(false);
    expect(validateName("   ", []).ok).toBe(false);
  });

  it("rejects names longer than 64 chars", () => {
    expect(validateName("a".repeat(65), []).ok).toBe(false);
    expect(validateName("a".repeat(64), []).ok).toBe(true);
  });

  it("rejects characters outside the allowed set", () => {
    expect(validateName("has space", []).ok).toBe(false);
    expect(validateName("emoji-🔥", []).ok).toBe(false);
    expect(validateName("path/segment", []).ok).toBe(false);
  });

  it("rejects names that would shadow a raw task id", () => {
    expect(validateName("sub_abc123", []).ok).toBe(false);
  });

  it("rejects duplicates against a running task with the same name", () => {
    const existing = [task({ id: "sub_aa", name: "scout" })]; // factory defaults status to "running"
    expect(validateName("scout", existing).ok).toBe(false);
    expect(validateName("scout-2", existing).ok).toBe(true);
  });

  it("allows reusing a name once the prior task is terminal", () => {
    // Long sessions otherwise accumulate forever-locked names that
    // force awkward suffix bumps (which models reliably mishandle,
    // looping on retries).
    for (const status of ["completed", "failed", "cancelled", "failed_unrecoverable", "evicted"] as const) {
      const existing = [task({ id: "sub_aa", name: "scout", status })];
      const result = validateName("scout", existing);
      expect(result.ok, `status=${status} should not reserve name`).toBe(true);
    }
  });

  it("reserves names while tasks are active or recoverable", () => {
    for (const status of ["running", "resuming", "recoverable", "needs_attention", "orphaned"] as const) {
      const existing = [task({ id: "sub_aa", name: "scout", status })];
      const result = validateName("scout", existing);
      expect(result.ok, `status=${status} should reserve name`).toBe(false);
    }
  });

  it("still rejects when at least ONE same-named task is running, even if others are terminal", () => {
    const existing = [
      task({ id: "sub_old", name: "scout", status: "completed" }),
      task({ id: "sub_live", name: "scout", status: "running" }),
    ];
    expect(validateName("scout", existing).ok).toBe(false);
  });
});

describe("resolveTaskRef", () => {
  const existing = [
    task({ id: "sub_aaaa", name: "scout" }),
    task({ id: "sub_bbbb" }),
    task({ id: "sub_cccc", name: "auth-reviewer", status: "completed" }),
  ];

  it("resolves a raw id", () => {
    const found = resolveTaskRef("sub_bbbb", { asyncTasks: existing });
    expect(found?.id).toBe("sub_bbbb");
  });

  it("resolves an assigned name", () => {
    const found = resolveTaskRef("scout", { asyncTasks: existing });
    expect(found?.id).toBe("sub_aaaa");
  });

  it("resolves names of terminal tasks too (so check_async_task after completion still works)", () => {
    const found = resolveTaskRef("auth-reviewer", { asyncTasks: existing });
    expect(found?.id).toBe("sub_cccc");
    expect(found?.status).toBe("completed");
  });

  it("returns undefined when neither id nor name matches", () => {
    expect(resolveTaskRef("unknown", { asyncTasks: existing })).toBeUndefined();
  });

  it("returns undefined for empty / whitespace refs", () => {
    expect(resolveTaskRef("", { asyncTasks: existing })).toBeUndefined();
    expect(resolveTaskRef("  ", { asyncTasks: existing })).toBeUndefined();
  });

  it("prefers id match when a name happens to look like an id-like string", () => {
    // validateName would forbid this combination at start time, but if it
    // ever got through (legacy data?), the id resolution wins.
    const ambiguous = [
      task({ id: "sub_xyz", name: "other" }),
      task({ id: "sub_other" }),
    ];
    const found = resolveTaskRef("sub_other", { asyncTasks: ambiguous });
    expect(found?.id).toBe("sub_other");
  });

  it("tolerates an undefined asyncTasks (fresh session)", () => {
    expect(resolveTaskRef("scout", {})).toBeUndefined();
  });
});
