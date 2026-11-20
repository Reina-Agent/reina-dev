import { describe, expect, it } from "vitest";
import { fromObsidianTag, fromWikiRef, normalizeProvider, parseSkillFrontmatter, toObsidianTag, toWikiRef } from "./index.js";

describe("normalizeProvider", () => {
  it("accepts OpenAI and Claude aliases", () => {
    expect(normalizeProvider("openai")).toBe("openai-chat");
    expect(normalizeProvider("claude")).toBe("anthropic-messages");
  });
});

describe("Obsidian on-disk interop", () => {
  it("round-trips namespaced tags, restoring only the first separator", () => {
    expect(fromObsidianTag(toObsidianTag("kind:finding"))).toBe("kind:finding");
    expect(fromObsidianTag(toObsidianTag("file:apps/desktop/x.ts"))).toBe("file:apps/desktop/x.ts");
    // Legacy pre-Obsidian file: already-native tag passes through untouched.
    expect(fromObsidianTag("file:a/b.ts")).toBe("file:a/b.ts");
  });

  it("unwraps wikilink refs, tolerating a human-added alias", () => {
    expect(fromWikiRef(toWikiRef("n_001"))).toBe("n_001");
    expect(fromWikiRef("[[n_001|Some display title]]")).toBe("n_001");
    // Not a wikilink → pass through (legacy plain-id refs).
    expect(fromWikiRef("n_007")).toBe("n_007");
  });
});

describe("parseSkillFrontmatter", () => {
  it("strips a UTF-8 BOM before matching the frontmatter fence", () => {
    const parsed = parseSkillFrontmatter("\uFEFF---\nname: bom-skill\ndescription: proper description\n---\nBody.", "dir");
    expect(parsed.name).toBe("bom-skill");
    expect(parsed.description).toBe("proper description");
  });

  it("reads folded and literal YAML block scalars", () => {
    const folded = parseSkillFrontmatter("---\nname: x\ndescription: >\n  first part\n  second part\n---\nBody.", "dir");
    expect(folded.description).toBe("first part second part");
    const literal = parseSkillFrontmatter("---\nname: x\ndescription: |\n  line one\n  line two\n---\nBody.", "dir");
    expect(literal.description).toBe("line one\nline two");
  });

  it("splits allowed-tools on commas and whitespace alike", () => {
    const parsed = parseSkillFrontmatter("---\nname: x\ndescription: d\nallowed-tools: Read, Grep, Bash\n---\nBody.", "dir");
    expect(parsed.allowedTools).toEqual(["Read", "Grep", "Bash"]);
    const spaced = parseSkillFrontmatter("---\nname: x\ndescription: d\nallowed-tools: Read Grep\n---\nBody.", "dir");
    expect(spaced.allowedTools).toEqual(["Read", "Grep"]);
  });

  it("strips only paired wrapping quotes", () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "quoted"\n---\nBody.', "dir").description).toBe("quoted");
    // A lone edge quote is content, not wrapping.
    expect(parseSkillFrontmatter('---\nname: x\ndescription: 5" floppy\n---\nBody.', "dir").description).toBe('5" floppy');
  });

  it("keeps invocation gating, context, and validated effort", () => {
    const parsed = parseSkillFrontmatter(
      "---\nname: x\ndescription: d\ncontext: fork\nmodel: claude-fable-5\neffort: high\nuser-invocable: false\ndisable-model-invocation: true\n---\nBody.",
      "dir",
    );
    expect(parsed).toMatchObject({ context: "fork", model: "claude-fable-5", effort: "high", userInvocable: false, disableModelInvocation: true });
    // Unknown effort tiers are dropped, not passed through.
    expect(parseSkillFrontmatter("---\nname: x\ndescription: d\neffort: turbo\n---\nBody.", "dir").effort).toBeUndefined();
  });

  it("falls back to the directory name and first paragraph without frontmatter", () => {
    const parsed = parseSkillFrontmatter("# Title\n\nFirst real paragraph here.", "dir-name");
    expect(parsed.name).toBe("dir-name");
    expect(parsed.description).toBe("Title");
  });
});
