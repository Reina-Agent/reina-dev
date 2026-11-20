import { describe, expect, it } from "vitest";
import { projectTimelineParts } from "./timelineProjection";

// Fixed, ordered ISO timestamps so the projection's createdAt sort is
// deterministic without touching the clock.
function iso(n: number): string {
  return `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
}

function grep(id: string, pattern: string, t: number, glob?: string) {
  return {
    id,
    name: "grep",
    status: "completed" as const,
    summary: "",
    input: glob ? { pattern, glob } : { pattern },
    createdAt: iso(t),
    completedAt: iso(t),
  };
}

function readFile(id: string, path: string, t: number) {
  return {
    id,
    name: "read_file",
    status: "completed" as const,
    summary: "",
    input: { path },
    output: `content:${path}`,
    createdAt: iso(t),
    completedAt: iso(t),
  };
}

function assistantText(id: string, content: string, t: number) {
  return { id, role: "assistant" as const, content, createdAt: iso(t) };
}

function toolParts(parts: ReturnType<typeof projectTimelineParts>) {
  return parts.filter((p) => p.type === "tool");
}

describe("projectTimelineParts — history replay", () => {
  it("keeps messages in order and preserves grouped read results", () => {
    const parts = projectTimelineParts({
      messages: [
        { id: "user", role: "user", content: "inspect files", createdAt: iso(0) },
        assistantText("assistant", "done", 4),
      ],
      toolCalls: [readFile("r1", "a.ts", 1), readFile("r2", "b.ts", 2), readFile("r3", "c.ts", 3)],
    });

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", role: "user", content: "inspect files" });
    expect(parts[1]).toMatchObject({
      type: "tool",
      title: "Read 3 files",
      count: 3,
      callIds: ["r1", "r2", "r3"],
      detail: [
        { id: "r1", output: "content:a.ts" },
        { id: "r2", output: "content:b.ts" },
        { id: "r3", output: "content:c.ts" },
      ],
    });
    expect(parts[2]).toMatchObject({ type: "text", role: "assistant", content: "done" });
  });

  it("hides ephemeral goal-continuation messages", () => {
    const parts = projectTimelineParts({
      messages: [
        { id: "user", role: "user", content: "do the thing", createdAt: iso(0) },
        { id: "continuation", role: "user", content: "Continue pursuing the active goal.", ephemeral: true, createdAt: iso(1) },
        assistantText("assistant", "working", 2),
      ],
      toolCalls: [],
    });

    expect(parts.map((part) => part.id)).toEqual(["user:text", "assistant:text"]);
    expect(JSON.stringify(parts)).not.toContain("Continue pursuing");
  });

  it("keeps failed read details outside a read group", () => {
    const parts = projectTimelineParts({
      messages: [],
      toolCalls: [
        readFile("ok", "a.ts", 1),
        { ...readFile("failed", "missing.ts", 2), status: "failed", error: "ENOENT" },
      ],
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ title: "Read file completed", count: 1 });
    expect(parts[1]).toMatchObject({
      title: "Read file failed",
      count: 1,
      detail: [{ id: "failed", status: "failed", error: "ENOENT" }],
    });
  });
});

describe("projectTimelineParts — search-tool grouping", () => {
  it("folds a consecutive run of grep into one 'Searched ×N' group", () => {
    const session = {
      messages: [assistantText("m1", "running searches", 0)],
      toolCalls: [
        grep("g1", "checkAutoType", 1),
        grep("g2", "readObject|readExternal|defaultReadObject", 2, "*.java"),
        grep("g3", "checkAutoType", 3),
        grep("g4", "readObject|readExternal|defaultReadObject", 4, "*.java"),
        grep("g5", "@JSONType", 5, "*.java"),
        grep("g6", "expectClass|expectClassFlag", 6),
      ],
    };

    const tools = toolParts(projectTimelineParts(session));
    expect(tools).toHaveLength(1);
    const group = tools[0] as unknown as Record<string, unknown>;
    expect(group.name).toBe("tool_group");
    expect(group.count).toBe(6);
    expect(group.title).toBe("Searched ×6");
    expect(group.summary).toBe("6 tool calls");
    expect(group.callIds).toEqual(["g1", "g2", "g3", "g4", "g5", "g6"]);
  });

  it("does not surface patterns for non-search groups (read_file keeps a count)", () => {
    const session = {
      messages: [],
      toolCalls: [readFile("r1", "a.java", 1), readFile("r2", "b.java", 2), readFile("r3", "c.java", 3)],
    };
    const tools = toolParts(projectTimelineParts(session));
    expect(tools).toHaveLength(1);
    const group = tools[0] as unknown as Record<string, unknown>;
    expect(group.title).toBe("Read 3 files");
    expect(group.summary).toBe("3 tool calls");
  });

  it("a visible assistant message between runs breaks the group in two", () => {
    const session = {
      messages: [assistantText("m1", "narration that splits the run", 3)],
      toolCalls: [grep("g1", "alpha", 1), grep("g2", "beta", 2), grep("g3", "gamma", 4), grep("g4", "delta", 5)],
    };
    const tools = toolParts(projectTimelineParts(session));
    expect(tools).toHaveLength(2);
    expect((tools[0] as unknown as Record<string, unknown>).count).toBe(2);
    expect((tools[1] as unknown as Record<string, unknown>).count).toBe(2);
  });

  it("grep and glob stay distinct groups even though both label as 'Searched'", () => {
    const session = {
      messages: [],
      toolCalls: [
        grep("g1", "checkAutoType", 1),
        grep("g2", "readObject", 2),
        { id: "gl1", name: "glob", status: "completed" as const, summary: "", input: { pattern: "**/*.java" }, createdAt: iso(3) },
        { id: "gl2", name: "glob", status: "completed" as const, summary: "", input: { pattern: "**/*.xml" }, createdAt: iso(4) },
      ],
    };
    const tools = toolParts(projectTimelineParts(session));
    expect(tools).toHaveLength(2);
    expect((tools[0] as unknown as Record<string, unknown>).title).toBe("Searched ×2");
    expect((tools[0] as unknown as Record<string, unknown>).summary).toBe("2 tool calls");
    expect((tools[1] as unknown as Record<string, unknown>).summary).toBe("2 tool calls");
  });

  it("carries a non-completed status into the group title while running", () => {
    const running = { ...grep("g2", "beta", 2), status: "running" as const, completedAt: undefined };
    const session = { messages: [], toolCalls: [grep("g1", "alpha", 1), running] };
    const group = toolParts(projectTimelineParts(session))[0] as unknown as Record<string, unknown>;
    expect(group.status).toBe("running");
    expect(group.title).toBe("Searched ×2 running");
  });
});
