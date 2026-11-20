import type { ToolDescriptor } from "@reina/protocol";
import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  clearSchemaSummaryCache,
  formatParamLine,
  summarizeToolSchema,
  synthesizeExampleFromJsonSchema,
} from "./schema-summary.js";

function makeDescriptor(name: string, schema: z.ZodTypeAny, inputJsonSchema?: Record<string, unknown>): ToolDescriptor {
  return {
    name: name as ToolDescriptor["name"],
    description: "",
    permission: "state",
    requiresApproval: false,
    inputSchema: schema,
    ...(inputJsonSchema ? { inputJsonSchema } : {}),
  };
}

beforeEach(() => clearSchemaSummaryCache());

describe("summarizeToolSchema — zod walker", () => {
  it("extracts name/type/required/description from a flat ZodObject", () => {
    const schema = z.object({
      title: z.string().min(1).describe("Title shown in bold."),
      body: z.string().describe("Body text."),
      silent: z.boolean().optional().describe("Suppress system sound."),
    });
    const params = summarizeToolSchema(makeDescriptor("notify", schema));
    expect(params).toEqual([
      { name: "title", type: "string", required: true, description: "Title shown in bold." },
      { name: "body", type: "string", required: true, description: "Body text." },
      { name: "silent", type: "boolean", required: false, description: "Suppress system sound." },
    ]);
  });

  it("treats ZodDefault and ZodNullable as optional and unwraps to inner type", () => {
    const schema = z.object({
      limit: z.number().int().default(8),
      cursor: z.string().nullable().optional(),
    });
    const params = summarizeToolSchema(makeDescriptor("paged", schema));
    expect(params).toEqual([
      { name: "limit", type: "number", required: false, description: undefined },
      { name: "cursor", type: "string", required: false, description: undefined },
    ]);
  });

  it("renders arrays and enums with element/option details", () => {
    const schema = z.object({
      tags: z.array(z.string()).describe("Tag list."),
      level: z.enum(["info", "warn", "error"]),
    });
    const params = summarizeToolSchema(makeDescriptor("log", schema));
    expect(params[0]).toEqual({ name: "tags", type: "string[]", required: true, description: "Tag list." });
    expect(params[1]).toEqual({ name: "level", type: 'enum("info"|"warn"|"error")', required: true, description: undefined });
  });

  it("falls back to the inner schema's description when wrapped", () => {
    const schema = z.object({
      foo: z.string().describe("Inner description.").optional(),
    });
    const params = summarizeToolSchema(makeDescriptor("inner-desc", schema));
    expect(params[0]?.description).toBe("Inner description.");
  });

  it("truncates long descriptions to keep the search output bounded", () => {
    const long = "x".repeat(500);
    const schema = z.object({ note: z.string().describe(long) });
    const params = summarizeToolSchema(makeDescriptor("long-desc", schema));
    expect(params[0]?.description?.length).toBeLessThanOrEqual(200);
    expect(params[0]?.description?.endsWith("…")).toBe(true);
  });

  it("returns an empty list for non-object root schemas (no parameters to show)", () => {
    expect(summarizeToolSchema(makeDescriptor("any-root", z.unknown()))).toEqual([]);
    expect(summarizeToolSchema(makeDescriptor("string-root", z.string()))).toEqual([]);
  });

  it("walks through ZodEffects (refine/transform) to reach the inner object", () => {
    const schema = z
      .object({ x: z.number() })
      .refine((v) => v.x > 0, "must be positive");
    const params = summarizeToolSchema(makeDescriptor("refined", schema));
    expect(params).toEqual([{ name: "x", type: "number", required: true, description: undefined }]);
  });

  it("memoises by descriptor identity", () => {
    const schema = z.object({ a: z.string() });
    const desc = makeDescriptor("memo", schema);
    const first = summarizeToolSchema(desc);
    const second = summarizeToolSchema(desc);
    expect(second).toBe(first);
  });
});

describe("summarizeToolSchema — JSON schema walker (MCP path)", () => {
  it("prefers inputJsonSchema when present, even if zod is a generic passthrough", () => {
    const desc = makeDescriptor(
      "mcp__example__do",
      z.object({}).passthrough(),
      {
        type: "object",
        properties: {
          owner: { type: "string", description: "GitHub owner." },
          stars: { type: "number" },
        },
        required: ["owner"],
      },
    );
    const params = summarizeToolSchema(desc);
    expect(params).toEqual([
      { name: "owner", type: "string", required: true, description: "GitHub owner." },
      { name: "stars", type: "number", required: false, description: undefined },
    ]);
  });

  it("handles array items, enums, and anyOf in JSON schema", () => {
    const desc = makeDescriptor(
      "mcp__example__filter",
      z.object({}).passthrough(),
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          mode: { enum: ["a", "b"] },
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["tags"],
      },
    );
    const params = summarizeToolSchema(desc);
    expect(params[0]?.type).toBe("string[]");
    expect(params[1]?.type).toBe('enum("a"|"b")');
    expect(params[2]?.type).toBe("string|number");
  });

  it("ignores inputJsonSchema when it has no usable properties (falls back to zod)", () => {
    const desc = makeDescriptor(
      "weird-mcp",
      z.object({ fallback: z.string() }),
      { type: "object" }, // no properties — looks like a placeholder schema
    );
    const params = summarizeToolSchema(desc);
    expect(params).toEqual([
      { name: "fallback", type: "string", required: true, description: undefined },
    ]);
  });
});

describe("integration with the real registry", () => {
  // Defends Phase 1.2's main promise: EVERY deferred tool the model can
  // unmask via search_tool is now summarised, so the enriched output isn't
  // a silently-empty rollout for some subset of tools.
  it("every deferred tool produces a defined params summary", async () => {
    const { deferredToolDescriptors } = await import("./registry.js");
    expect(deferredToolDescriptors.length).toBeGreaterThan(0);
    const missingSummary: string[] = [];
    const emptySummary: string[] = [];
    for (const tool of deferredToolDescriptors) {
      const params = summarizeToolSchema(tool);
      if (!Array.isArray(params)) {
        missingSummary.push(tool.name);
        continue;
      }
      if (params.length === 0) emptySummary.push(tool.name);
    }
    expect(missingSummary).toEqual([]);
    // Tools that genuinely take no parameters legitimately produce `[]` —
    // surface them as a list so a future regression (e.g. the walker
    // silently dropping a real schema) shows up as a diff, not a pass.
    expect(emptySummary.sort()).toMatchInlineSnapshot(`
      [
        "consolidate_memory",
        "get_goal",
        "list_memory_chunks",
        "mcp_status",
      ]
    `);
  });
});

describe("schema completeness audit — agent-friendliness baseline", () => {
  // Surface the two failure modes the Anthropic tool-design article calls
  // out as dominant: tools without `examples` (the "right tool, wrong args"
  // round-trip), and tools whose params have no `.describe()` text (the model
  // sees only `name (type, required/optional)` in the search_tool output and
  // has to guess intent / bounds / valid enum values). Captured as inline
  // snapshots so this list MUST shrink — adding a tool without docs will
  // diff the snapshot and fail the build until the author fills the gap.

  it("lists every public tool that ships no canonical `examples`", async () => {
    const { publicToolDescriptors } = await import("./registry.js");
    const noExamples = publicToolDescriptors
      .filter((tool) => !tool.examples || tool.examples.length === 0)
      .map((tool) => tool.name)
      .sort();
    expect(noExamples).toMatchInlineSnapshot(`
      [
        "cancel_async_task",
        "check_task_batch",
        "consolidate_memory",
        "create_goal",
        "create_subtask",
        "declare_audit_done",
        "delete_note",
        "exit_plan_mode",
        "get_dag",
        "get_goal",
        "list_memory_chunks",
        "list_notes",
        "list_skills",
        "mcp_list_resources",
        "mcp_read_resource",
        "mcp_status",
        "read_note",
        "recall_memory_chunk",
        "search_memory",
        "send_task_message",
        "send_to_worker",
        "set_phase",
        "start_task_batch",
        "update_async_task",
        "update_goal",
        "update_note",
        "update_subtask",
        "wait_async_tasks",
      ]
    `);
  });

  it("lists every required param without a `.describe()` string", async () => {
    const { publicToolDescriptors } = await import("./registry.js");
    const gaps: string[] = [];
    for (const tool of publicToolDescriptors) {
      const params = summarizeToolSchema(tool);
      for (const param of params) {
        if (!param.required) continue;
        if (!param.description || param.description.trim() === "") {
          gaps.push(`${tool.name}.${param.name}`);
        }
      }
    }
    expect(gaps.sort()).toMatchInlineSnapshot(`
      [
        "create_subtask.description",
        "create_subtask.title",
        "declare_audit_done.status",
        "declare_audit_done.summary",
        "note.body",
        "note.title",
        "send_to_worker.body",
        "send_to_worker.recipient",
        "send_to_worker.subject",
      ]
    `);
  });

  it("lists every optional param without a `.describe()` string", async () => {
    const { publicToolDescriptors } = await import("./registry.js");
    const gaps: string[] = [];
    for (const tool of publicToolDescriptors) {
      const params = summarizeToolSchema(tool);
      for (const param of params) {
        if (param.required) continue;
        if (!param.description || param.description.trim() === "") {
          gaps.push(`${tool.name}.${param.name}`);
        }
      }
    }
    expect(gaps.sort()).toMatchInlineSnapshot(`
      [
        "create_subtask.blockedBy",
        "create_subtask.owner",
        "create_subtask.phase",
        "create_subtask.tags",
        "get_dag.owner",
        "list_notes.includeDirected",
        "list_notes.limit",
        "list_notes.recipient",
        "list_notes.refs_any",
        "list_notes.since",
        "list_notes.status",
        "list_notes.tags",
        "note.refs",
        "note.status",
        "note.tags",
        "send_to_worker.subtaskId",
        "set_phase.phase",
        "update_note.body",
        "update_note.refs",
        "update_note.status",
        "update_note.tags",
        "update_note.title",
        "update_subtask.addBlockedBy",
        "update_subtask.bindAsyncTaskId",
        "update_subtask.description",
        "update_subtask.owner",
        "update_subtask.phase",
        "update_subtask.removeBlockedBy",
        "update_subtask.resultSummary",
        "update_subtask.status",
        "update_subtask.tags",
        "update_subtask.title",
      ]
    `);
  });
});

describe("tool-use examples — regression coverage", () => {
  // Phase 3: every example we hand-write for a deferred tool MUST validate
  // against that tool's zod schema. If a tool author tweaks the schema and
  // forgets to update the examples, the search_tool output would feed the
  // model an invalid argument shape — exactly the failure mode examples are
  // supposed to prevent. This test catches it at PR time.
  it("every tool's `examples[].input` parses against its own inputSchema", async () => {
    const { deferredToolDescriptors } = await import("./registry.js");
    const failures: Array<{ tool: string; index: number; error: string }> = [];
    let totalExamples = 0;
    for (const tool of deferredToolDescriptors) {
      if (!tool.examples || tool.examples.length === 0) continue;
      tool.examples.forEach((example, index) => {
        totalExamples += 1;
        const result = (tool.inputSchema as z.ZodTypeAny).safeParse(example.input);
        if (!result.success) {
          failures.push({
            tool: tool.name,
            index,
            error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          });
        }
      });
    }
    expect(totalExamples).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});

describe("synthesizeExampleFromJsonSchema", () => {
  // Closes the "right tool, wrong args" gap for MCP entries: search_tool now
  // ships a required-only placeholder example so the model has a concrete
  // JSON shape to imitate instead of guessing from the params list.
  it("synthesises a required-only shape with type-appropriate placeholders", () => {
    const example = synthesizeExampleFromJsonSchema({
      type: "object",
      properties: {
        repo: { type: "string", description: "Target repository name." },
        count: { type: "integer" },
        dryRun: { type: "boolean" },
        optionalIgnored: { type: "string" },
      },
      required: ["repo", "count", "dryRun"],
    });
    expect(example).toEqual({
      repo: "<target-repository-name.>",
      count: 0,
      dryRun: false,
    });
  });

  it("uses the first enum value when an enum is present", () => {
    const example = synthesizeExampleFromJsonSchema({
      type: "object",
      properties: { mode: { enum: ["fast", "thorough"] } },
      required: ["mode"],
    });
    expect(example).toEqual({ mode: "fast" });
  });

  it("walks arrays into their element type", () => {
    const example = synthesizeExampleFromJsonSchema({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    });
    expect(example).toEqual({ tags: ["<string>"] });
  });

  it("recurses into nested objects' required fields", () => {
    const example = synthesizeExampleFromJsonSchema({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { id: { type: "string" }, count: { type: "integer" } },
          required: ["id"],
        },
      },
      required: ["payload"],
    });
    expect(example).toEqual({ payload: { id: "<string>" } });
  });

  it("returns undefined when the schema has no required fields", () => {
    expect(
      synthesizeExampleFromJsonSchema({
        type: "object",
        properties: { optionalField: { type: "string" } },
      }),
    ).toBeUndefined();
    expect(synthesizeExampleFromJsonSchema({ type: "object" })).toBeUndefined();
  });

  it("picks the first anyOf branch as the placeholder", () => {
    const example = synthesizeExampleFromJsonSchema({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
      required: ["value"],
    });
    expect(example).toEqual({ value: "<string>" });
  });
});

describe("formatParamLine", () => {
  it("includes type + required/optional flag", () => {
    expect(formatParamLine({ name: "x", type: "string", required: true })).toBe("x (string, required)");
    expect(formatParamLine({ name: "y", type: "number", required: false })).toBe("y (number, optional)");
  });

  it("appends description with em-dash separator", () => {
    expect(formatParamLine({ name: "x", type: "string", required: true, description: "doc" })).toBe(
      "x (string, required) — doc",
    );
  });
});
