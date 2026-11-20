import { describe, expect, it } from "vitest";
import { formatSkillDirectives, parseSkillDirectives } from "./skillDirectives";

describe("formatSkillDirectives", () => {
  it("wraps each skill in a tag and appends the draft after a blank line", () => {
    expect(formatSkillDirectives(["gitnexus-refactoring"], "你好")).toBe(
      "<skill-directive>Use the `gitnexus-refactoring` skill.</skill-directive>\n\n你好",
    );
  });

  it("emits one tag per skill", () => {
    const out = formatSkillDirectives(["a", "b"], "msg");
    expect(out).toBe(
      "<skill-directive>Use the `a` skill.</skill-directive>\n" +
        "<skill-directive>Use the `b` skill.</skill-directive>\n\nmsg",
    );
  });

  it("with an empty draft the message is just the tag(s)", () => {
    expect(formatSkillDirectives(["x"], "")).toBe("<skill-directive>Use the `x` skill.</skill-directive>");
  });
});

describe("parseSkillDirectives", () => {
  it("round-trips what format produces", () => {
    const wire = formatSkillDirectives(["gitnexus-refactoring", "verify"], "帮我重构");
    expect(parseSkillDirectives(wire)).toEqual({
      skills: ["gitnexus-refactoring", "verify"],
      rest: "帮我重构",
    });
  });

  it("tag-only message parses to empty rest", () => {
    expect(parseSkillDirectives(formatSkillDirectives(["x"], ""))).toEqual({ skills: ["x"], rest: "" });
  });

  it("plain text passes through untouched", () => {
    expect(parseSkillDirectives("just a normal message")).toEqual({
      skills: [],
      rest: "just a normal message",
    });
  });

  it("a mid-message tag is NOT treated as an invocation (only leading tags are)", () => {
    const content = "look at this: <skill-directive>Use the `x` skill.</skill-directive>";
    expect(parseSkillDirectives(content)).toEqual({ skills: [], rest: content });
  });

  it("falls back to the raw inner text when the directive has no backticked name", () => {
    expect(parseSkillDirectives("<skill-directive>do the thing</skill-directive>\n\nhi")).toEqual({
      skills: ["do the thing"],
      rest: "hi",
    });
  });
});
