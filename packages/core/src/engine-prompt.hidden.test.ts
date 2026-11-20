import { describe, expect, it } from "vitest";
import { buildHiddenToolsReminder, formatDeferredToolsCatalog } from "./engine-prompt.js";

// The native deferred catalog lives in the cached system prompt, but only as
// compact capability groups. Exact names, schemas, and examples belong to
// search_tool; repeating one summary row per hidden tool was fixed overhead.
// The per-turn reminder carries only the runtime-dynamic MCP pool.

describe("formatDeferredToolsCatalog — static native catalog (system prompt)", () => {
  it("renders compact capability counts and points detailed discovery to search_tool", () => {
    const text = formatDeferredToolsCatalog();
    expect(text).toContain("## Deferred tools (on demand)");
    expect(text).toContain("40 additional native tools");
    expect(text).toContain("- Memory (4)");
    expect(text).toContain("- Async workers (8)");
    expect(text).toContain("- Team coordination (5)");
    expect(text).toContain("- Goal (3)");
    expect(text).toContain("- Notifications & scheduling (2)");
    expect(text).toContain("- Notes (3)");
    expect(text).toContain("- File editing (1)");
    expect(text).not.toContain("- Misc");
    expect(text).toContain('search_tool({ query:');
    expect(text).toContain("exact tool names, parameter shapes, and examples");
  });

  it("is byte-stable — identical output across calls (it lives in the cached prefix)", () => {
    expect(formatDeferredToolsCatalog()).toBe(formatDeferredToolsCatalog());
  });

  it("does not embed individual deferred names or summaries", () => {
    const text = formatDeferredToolsCatalog();
    expect(text).not.toContain("start_async_task");
    expect(text).not.toContain("schedule_wakeup");
    expect(text).not.toContain("update_note");
    expect(text).not.toMatch(/^ {2}- /m);
  });
});

describe("buildHiddenToolsReminder — per-turn MCP-only roster", () => {
  it("returns empty when there is no MCP pool (native catalog lives in the system prompt)", () => {
    expect(buildHiddenToolsReminder()).toBe("");
    expect(buildHiddenToolsReminder(undefined, ["task", "notify"])).toBe("");
    expect(buildHiddenToolsReminder([])).toBe("");
  });
  // MCP listing + resident-vs-unmasked filtering is covered in engine.test.ts
  // ("buildHiddenToolsReminder lists MCP runtime tools…" / "filters out
  // resident MCP tools…").
});
