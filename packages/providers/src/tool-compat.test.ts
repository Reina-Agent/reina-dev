import { describe, expect, it } from "vitest";
import { normalizeToolInput, normalizeToolName, parseToolJson, repairTruncatedJson, wasJsonParseFallback } from "./tool-compat.js";

describe("normalizeToolName", () => {
  it.each(["compact", "compactconversation", "compact_conversation"])("rejects the retired compaction tool name %s", (name) => {
    expect(() => normalizeToolName(name)).toThrow(`unknown tool from model: ${name}`);
  });
});

describe("repairTruncatedJson", () => {
  it("closes a dangling string and missing brace", () => {
    const out = repairTruncatedJson('{"path": "/foo/bar');
    expect(out).toBe('{"path": "/foo/bar"}');
    expect(JSON.parse(out!)).toEqual({ path: "/foo/bar" });
  });

  it("fills a dangling key with null", () => {
    const out = repairTruncatedJson('{"path": "/x", "limit":');
    expect(out).toBe('{"path": "/x", "limit": null}');
  });

  it("trims a trailing comma before closing", () => {
    const out = repairTruncatedJson('{"a": 1,');
    expect(JSON.parse(out!)).toEqual({ a: 1 });
  });

  it("closes nested arrays and objects in reverse order", () => {
    const out = repairTruncatedJson('{"edits": [{"oldText": "x", "newText": "y"');
    expect(JSON.parse(out!)).toEqual({ edits: [{ oldText: "x", newText: "y" }] });
  });

  it("returns null when the input has no recoverable structure", () => {
    expect(repairTruncatedJson("not json at all")).toBe(null);
  });

  it("returns null for empty input", () => {
    expect(repairTruncatedJson("")).toBe(null);
  });
});

describe("parseToolJson", () => {
  it("parses valid JSON directly", () => {
    expect(parseToolJson('{"path":"/a"}')).toEqual({ path: "/a" });
  });

  it("repairs truncated JSON before falling back to raw", () => {
    expect(parseToolJson('{"command": "ls -la')).toEqual({ command: "ls -la" });
  });

  it("falls back to { raw } when repair fails", () => {
    expect(parseToolJson("garbage")).toEqual({ raw: "garbage" });
  });

  it("strips a markdown JSON fence", () => {
    expect(parseToolJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  it("returns {} for empty input", () => {
    expect(parseToolJson("")).toEqual({});
  });

  it("repairs a fenced truncated JSON block", () => {
    expect(parseToolJson('```json\n{"path": "/x"\n```')).toEqual({ path: "/x" });
  });

  it("extracts a JSON object wrapped in leading prose", () => {
    expect(parseToolJson('Sure, I will read it: {"path":"/a"}')).toEqual({ path: "/a" });
  });

  it("extracts a JSON object with trailing commentary", () => {
    expect(parseToolJson('{"command":"ls -la"} done')).toEqual({ command: "ls -la" });
  });

  it("extracts a JSON object from a mid-text markdown fence", () => {
    expect(parseToolJson('Here:\n```json\n{"x":1}\n```\nthanks')).toEqual({ x: 1 });
  });

  it("skips a stray prose brace and finds the real object", () => {
    expect(parseToolJson('if (x) { return {"ok":true} }')).toEqual({ ok: true });
  });

  it("ignores braces inside JSON strings when matching", () => {
    expect(parseToolJson('note: {"msg":"a } b { c"}')).toEqual({ msg: "a } b { c" });
  });

  it("still falls back to { raw } for a truncated object buried in prose", () => {
    const result = parseToolJson('reading file {"path":"/foo');
    expect(result).toEqual({ raw: 'reading file {"path":"/foo' });
    expect(wasJsonParseFallback(result)).toBe(true);
  });
});

describe("wasJsonParseFallback", () => {
  it("marks the raw-fallback object so providers can flag parseFailed", () => {
    const result = parseToolJson("definitely-not-json{");
    expect(result).toEqual({ raw: "definitely-not-json{" });
    expect(wasJsonParseFallback(result)).toBe(true);
  });

  it("does NOT mark successfully parsed objects", () => {
    expect(wasJsonParseFallback(parseToolJson('{"path":"/x"}'))).toBe(false);
  });

  it("does NOT mark repaired-then-parsed objects", () => {
    const result = parseToolJson('{"path": "/x"');
    expect(result).toEqual({ path: "/x" });
    expect(wasJsonParseFallback(result)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(wasJsonParseFallback(null)).toBe(false);
    expect(wasJsonParseFallback("string")).toBe(false);
    expect(wasJsonParseFallback(undefined)).toBe(false);
  });
});

describe("normalizeToolInput", () => {
  it("preserves every canonical task orchestration field", () => {
    expect(normalizeToolInput("task", {
      description: "audit auth",
      agent: "reviewer",
      isolate: "worktree",
      background: true,
      name: "auth-review",
      fork: true,
      skill: "security-audit",
      subtaskId: "sub_auth",
      ignored: "drop me",
    })).toMatchObject({
      description: "audit auth",
      agent: "reviewer",
      isolate: "worktree",
      background: true,
      name: "auth-review",
      fork: true,
      skill: "security-audit",
      subtaskId: "sub_auth",
    });
  });

  it("maps legacy task aliases onto the canonical fields", () => {
    expect(normalizeToolInput("task", {
      prompt: "audit auth",
      subagent_type: "reviewer",
      isolation: "worktree",
      run_in_background: true,
      task_name: "auth-review",
      skill_name: "security-audit",
      subtask_id: "sub_auth",
    })).toMatchObject({
      description: "audit auth",
      agent: "reviewer",
      isolate: "worktree",
      background: true,
      name: "auth-review",
      skill: "security-audit",
      subtaskId: "sub_auth",
    });
  });
});
