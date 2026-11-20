import { describe, expect, it } from "vitest";
import type { TimelineToolPart, ToolCallStatus } from "./protocol";
import type { AsyncTaskLite, SubagentActivity } from "./sessionStore";
import {
  CHIP_COLOR_COUNT,
  chipActivityTail,
  chipColorIndex,
  chipDurationMs,
  chipFromPart,
  chipStatus,
  formatChipDuration,
  resolveChipTask,
} from "./agentChips";

function part(
  id: string,
  input: Record<string, unknown>,
  status: ToolCallStatus = "completed",
  extra: Partial<TimelineToolPart["detail"][number]> = {},
): TimelineToolPart {
  return {
    id,
    type: "tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "running" ? undefined : "2026-01-01T00:01:30.000Z",
    name: "task",
    status,
    title: "Task",
    summary: "",
    count: 1,
    callIds: [id],
    detail: [
      {
        id,
        name: "task",
        status,
        summary: "",
        input,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: status === "running" ? undefined : "2026-01-01T00:01:30.000Z",
        ...extra,
      },
    ],
  };
}

function task(id: string, description: string, status: string, extra: Partial<AsyncTaskLite> = {}): AsyncTaskLite {
  return { id, description, status, ...extra };
}

describe("chipFromPart", () => {
  it("labels the chip with the brief's first line, truncated", () => {
    const chip = chipFromPart(part("a", { description: "Recheck dispose lifecycle\n详细说明…" }));
    expect(chip.label).toBe("Recheck dispose lifecycle");
    expect(chip.description).toBe("Recheck dispose lifecycle\n详细说明…");
    const long = chipFromPart(part("b", { description: "x".repeat(120) }));
    expect(long.label.length).toBeLessThanOrEqual(60);
    expect(long.label.endsWith("…")).toBe(true);
  });

  it("falls back to prompt, then the part title, and reads the agent field", () => {
    expect(chipFromPart(part("a", { prompt: "audit the store" })).label).toBe("audit the store");
    expect(chipFromPart(part("a", {})).label).toBe("Task");
    expect(chipFromPart(part("a", { description: "x", subagentType: "explore" })).agent).toBe("explore");
  });
});

describe("resolveChipTask", () => {
  it("matches by exact brief", () => {
    const index = {
      t1: task("t1", "audit A", "running"),
      t2: task("t2", "audit B", "running"),
    };
    const chip = chipFromPart(part("a", { description: "audit B" }));
    expect(resolveChipTask(chip, index)?.id).toBe("t2");
  });

  it("prefers the live record among same-brief candidates", () => {
    const index = {
      old: task("old", "audit A", "completed", { startedAt: "2025-12-31T00:00:00.000Z" }),
      live: task("live", "audit A", "running", { startedAt: "2026-01-01T00:00:01.000Z" }),
    };
    const chip = chipFromPart(part("a", { description: "audit A" }));
    expect(resolveChipTask(chip, index)?.id).toBe("live");
  });

  it("falls back to the closest startedAt for settled duplicates", () => {
    const index = {
      far: task("far", "audit A", "completed", { startedAt: "2025-12-01T00:00:00.000Z" }),
      near: task("near", "audit A", "completed", { startedAt: "2026-01-01T00:00:02.000Z" }),
    };
    const chip = chipFromPart(part("a", { description: "audit A" }));
    expect(resolveChipTask(chip, index)?.id).toBe("near");
  });

  it("respects an agent mismatch and an empty brief", () => {
    const index = { t1: task("t1", "audit A", "running", { agent: "explore" }) };
    const chip = chipFromPart(part("a", { description: "audit A", subagentType: "plan" }));
    expect(resolveChipTask(chip, index)).toBeUndefined();
    expect(resolveChipTask(chipFromPart(part("b", {})), index)).toBeUndefined();
  });
});

describe("chipStatus", () => {
  it("part failure always wins", () => {
    const chip = chipFromPart(part("a", { description: "x" }, "failed"));
    expect(chipStatus(chip, task("t", "x", "completed"))).toBe("failed");
  });

  it("a settled dispatch with a live child shows running (async)", () => {
    const chip = chipFromPart(part("a", { description: "x" }, "completed"));
    expect(chipStatus(chip, task("t", "x", "running"))).toBe("running");
    expect(chipStatus(chip, task("t", "x", "resuming"))).toBe("running");
  });

  it("a settled dispatch whose child failed shows failed", () => {
    const chip = chipFromPart(part("a", { description: "x" }, "completed"));
    expect(chipStatus(chip, task("t", "x", "cancelled"))).toBe("failed");
  });

  it("falls back to the part status without a record", () => {
    expect(chipStatus(chipFromPart(part("a", { description: "x" }, "running")))).toBe("running");
    expect(chipStatus(chipFromPart(part("a", { description: "x" }, "completed")))).toBe("completed");
  });
});

describe("chipDurationMs / formatChipDuration", () => {
  it("prefers the record's lifetime over the tool part's", () => {
    const chip = chipFromPart(part("a", { description: "x" }));
    const t = task("t", "x", "completed", {
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(chipDurationMs(chip, t)).toBe(300_000);
    expect(chipDurationMs(chip)).toBe(90_000);
  });

  it("formats compactly", () => {
    expect(formatChipDuration(400)).toBe("<1s");
    expect(formatChipDuration(42_000)).toBe("42s");
    expect(formatChipDuration(90_000)).toBe("1m 30s");
    expect(formatChipDuration(3_900_000)).toBe("1h 5m");
  });
});

describe("chipColorIndex", () => {
  it("is stable and in range", () => {
    const a = chipColorIndex("sub_abc123");
    expect(a).toBe(chipColorIndex("sub_abc123"));
    for (const key of ["a", "b", "sub_x", "call-9"]) {
      const i = chipColorIndex(key);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(CHIP_COLOR_COUNT);
    }
  });
});

describe("chipActivityTail", () => {
  const base: SubagentActivity = { text: "", reasoning: "", tools: [], misc: [], count: 0 };
  it("prefers the latest tool step, then text, then reasoning", () => {
    expect(
      chipActivityTail({
        ...base,
        tools: [
          { key: "1", name: "grep", target: "a.ts", status: "completed" },
          { key: "2", name: "read_file", target: "src/x.ts", status: "running" },
        ],
      }),
    ).toBe("read_file · src/x.ts");
    expect(chipActivityTail({ ...base, text: "looking…" })).toBe("looking…");
    expect(chipActivityTail({ ...base, reasoning: "hmm" })).toBe("hmm");
    expect(chipActivityTail(undefined)).toBe("");
  });
});
