import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AsyncTaskRecord } from "@reina/protocol";
import {
  CompletionInjector,
  DEFAULT_INJECTOR_CAP,
  DEFAULT_RESULT_INLINE_CAP,
  formatCompletionInjection,
} from "./injector.js";

function task(over: Partial<AsyncTaskRecord> & Pick<AsyncTaskRecord, "id">): AsyncTaskRecord {
  return {
    agent: "default",
    description: "x",
    status: "completed",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    isolation: "none",
    result: "ok",
    background: true,
    ...over,
  };
}

describe("CompletionInjector", () => {
  it("enqueues a settled task and drains it once", () => {
    const inj = new CompletionInjector();
    const t = task({ id: "sub_aaaa" });
    inj.enqueue(t);
    expect(inj.size()).toBe(1);
    const drained = inj.drainAtSafeBoundary();
    expect(drained.map((r) => r.id)).toEqual(["sub_aaaa"]);
    // Stamping injectedAt blocks re-injection.
    expect(t.injectedAt).toBeTruthy();
    inj.enqueue(t);
    expect(inj.size()).toBe(0);
  });

  it("dedupes within a single batch (same id enqueued twice)", () => {
    const inj = new CompletionInjector();
    const t = task({ id: "sub_dup" });
    inj.enqueue(t);
    inj.enqueue(t);
    expect(inj.size()).toBe(1);
  });

  it("preserves enqueue order across multiple tasks", () => {
    const inj = new CompletionInjector();
    inj.enqueue(task({ id: "sub_a" }));
    inj.enqueue(task({ id: "sub_b" }));
    inj.enqueue(task({ id: "sub_c" }));
    expect(inj.drainAtSafeBoundary().map((r) => r.id)).toEqual(["sub_a", "sub_b", "sub_c"]);
  });

  it("remove() drops a queued task without affecting siblings", () => {
    const inj = new CompletionInjector();
    inj.enqueue(task({ id: "sub_a" }));
    inj.enqueue(task({ id: "sub_b" }));
    expect(inj.remove("sub_a")).toBe(true);
    expect(inj.remove("sub_unknown")).toBe(false);
    expect(inj.drainAtSafeBoundary().map((r) => r.id)).toEqual(["sub_b"]);
  });

  it("draining an empty queue is a no-op", () => {
    const inj = new CompletionInjector();
    expect(inj.drainAtSafeBoundary()).toEqual([]);
    expect(inj.size()).toBe(0);
  });
});

describe("formatCompletionInjection", () => {
  it("returns empty string when the batch is empty", () => {
    expect(formatCompletionInjection([])).toBe("");
  });

  it("renders one notification with all surfaceable fields", () => {
    const out = formatCompletionInjection([
      task({
        id: "sub_xyz",
        name: "auth-reviewer",
        result: "found null deref in src/auth.ts:42",
        turns: 3,
        toolCalls: 5,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 1234 },
      }),
    ]);
    expect(out).toContain(`<task-notifications count="1">`);
    expect(out).toContain(`<task_id>sub_xyz</task_id>`);
    expect(out).toContain(`<name>auth-reviewer</name>`);
    expect(out).toContain(`<status>completed</status>`);
    expect(out).toContain(`<result>found null deref in src/auth.ts:42</result>`);
    expect(out).toContain(`<duration_ms>1234</duration_ms>`);
    expect(out).toContain(`<turns>3</turns>`);
    expect(out).toContain(`<tool_calls>5</tool_calls>`);
    expect(out).toContain(`</task-notifications>`);
  });

  it("renders an error envelope for failed tasks", () => {
    const out = formatCompletionInjection([
      task({ id: "sub_fail", status: "failed", error: "exit 1", result: undefined }),
    ]);
    expect(out).toContain(`<status>failed</status>`);
    expect(out).toContain(`<error>exit 1</error>`);
    expect(out).not.toContain(`<result>`);
  });

  it("escapes XML metacharacters in name / result / error", () => {
    const out = formatCompletionInjection([
      task({ id: "sub_esc", name: "a<b>", result: "5 < 6 && 7 > 6", error: "<x>" }),
    ]);
    expect(out).toContain(`<name>a&lt;b&gt;</name>`);
    expect(out).toContain(`<result>5 &lt; 6 &amp;&amp; 7 &gt; 6</result>`);
  });
});

describe("CompletionInjector backpressure cap", () => {
  let prevCap: string | undefined;
  beforeEach(() => {
    prevCap = process.env.REINA_COMPLETION_INJECTOR_CAP;
    // Use a small cap so tests don't have to enqueue 9 records.
    process.env.REINA_COMPLETION_INJECTOR_CAP = "3";
  });
  afterEach(() => {
    if (prevCap === undefined) delete process.env.REINA_COMPLETION_INJECTOR_CAP;
    else process.env.REINA_COMPLETION_INJECTOR_CAP = prevCap;
  });

  it("evicts oldest when over cap and tracks dropped count + ids (FIFO)", () => {
    const inj = new CompletionInjector();
    inj.enqueue(task({ id: "sub_a" }));
    inj.enqueue(task({ id: "sub_b" }));
    inj.enqueue(task({ id: "sub_c" }));
    inj.enqueue(task({ id: "sub_d" })); // evicts sub_a
    inj.enqueue(task({ id: "sub_e" })); // evicts sub_b
    expect(inj.size()).toBe(3);
    const drained = inj.drainAtSafeBoundary().map((r) => r.id);
    expect(drained).toEqual(["sub_c", "sub_d", "sub_e"]);
    const dropped = inj.drainDropped();
    expect(dropped.count).toBe(2);
    expect(dropped.ids).toEqual(["sub_a", "sub_b"]);
  });

  it("dedupes evicted records but acknowledges them only when the summary is drained", () => {
    const inj = new CompletionInjector();
    const a = task({ id: "sub_a" });
    inj.enqueue(a);
    for (let i = 0; i < 5; i++) inj.enqueue(task({ id: `sub_${i}` }));
    expect(a.injectedAt).toBeUndefined();
    inj.enqueue(a);
    // No double-add (still capped at 3).
    expect(inj.size()).toBe(3);
    inj.drainDropped();
    expect(a.injectedAt).toBeTruthy();
  });

  it("uses default cap when env var is unset", () => {
    delete process.env.REINA_COMPLETION_INJECTOR_CAP;
    expect(DEFAULT_INJECTOR_CAP).toBe(8);
    const inj = new CompletionInjector();
    for (let i = 0; i < 12; i++) inj.enqueue(task({ id: `sub_${i}` }));
    expect(inj.size()).toBe(DEFAULT_INJECTOR_CAP);
  });

  it("drainDropped returns zero counters when nothing was evicted", () => {
    const inj = new CompletionInjector();
    inj.enqueue(task({ id: "sub_one" }));
    inj.drainAtSafeBoundary();
    expect(inj.drainDropped()).toEqual({ count: 0, ids: [] });
  });

  it("drainAtSafeBoundary stays a no-op when both pending and dropped are empty", () => {
    const inj = new CompletionInjector();
    expect(inj.drainAtSafeBoundary()).toEqual([]);
  });
});

describe("formatCompletionInjection result truncation", () => {
  let prevCap: string | undefined;
  beforeEach(() => {
    prevCap = process.env.REINA_COMPLETION_RESULT_CAP;
    process.env.REINA_COMPLETION_RESULT_CAP = "20";
  });
  afterEach(() => {
    if (prevCap === undefined) delete process.env.REINA_COMPLETION_RESULT_CAP;
    else process.env.REINA_COMPLETION_RESULT_CAP = prevCap;
  });

  it("truncates long results and marks the envelope", () => {
    const long = "x".repeat(200);
    const out = formatCompletionInjection([task({ id: "sub_t", result: long })]);
    expect(out).toContain(`truncated="true"`);
    expect(out).toContain(`full_length="200"`);
    expect(out).toContain("get_async_tasks");
    // Inline body should be the first 20 chars only + ellipsis.
    expect(out).toContain(`${"x".repeat(20)}…`);
  });

  it("leaves short results untouched (no truncated attr)", () => {
    const out = formatCompletionInjection([task({ id: "sub_s", result: "tiny" })]);
    expect(out).not.toContain("truncated=");
    expect(out).toContain("<result>tiny</result>");
  });

  it("DEFAULT_RESULT_INLINE_CAP is 1024", () => {
    expect(DEFAULT_RESULT_INLINE_CAP).toBe(1024);
  });
});

describe("formatCompletionInjection dropped summary", () => {
  it("appends a <dropped> envelope when count > 0", () => {
    const out = formatCompletionInjection(
      [task({ id: "sub_live" })],
      { count: 2, ids: ["sub_old1", "sub_old2"] },
    );
    expect(out).toContain(`<dropped count="2" ids="sub_old1,sub_old2"`);
    expect(out).toContain("backpressure");
  });

  it("returns content even when batch is empty but dropped > 0", () => {
    const out = formatCompletionInjection([], { count: 1, ids: ["sub_x"] });
    expect(out).toContain(`count="0"`);
    expect(out).toContain(`<dropped count="1"`);
  });

  it("returns empty string when both batch and dropped are empty", () => {
    expect(formatCompletionInjection([], { count: 0, ids: [] })).toBe("");
    expect(formatCompletionInjection([])).toBe("");
  });
});
