import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, SessionState, SkillMetadata } from "@reina/protocol";
import {
  DEFAULT_FORK_TAIL_TOKEN_BUDGET,
  FORK_TAIL_MESSAGES,
  buildForkContext,
  buildForkSkillDirective,
  forkTailTokenBudget,
  isForkEnabled,
  wrapForkDirective,
} from "./fork.js";

function msg(role: ChatMessage["role"], content: string, idx: number): ChatMessage {
  return {
    id: `msg_${idx}`,
    role,
    content,
    createdAt: new Date(Date.now() - (1000 - idx)).toISOString(),
  };
}

const skill: SkillMetadata = { name: "review", description: "code review", path: "/x/review" };

function parent(
  messages: ChatMessage[],
  over: Partial<SessionState> = {},
): Pick<SessionState, "messages" | "skills" | "activeDeferredTools"> {
  return {
    messages,
    skills: [skill],
    activeDeferredTools: ["recall_memory_chunk"],
    ...over,
  };
}

describe("isForkEnabled", () => {
  it("defaults to enabled when the flag is undefined", () => {
    expect(isForkEnabled(undefined)).toBe(true);
  });

  it("returns true when the flag is explicitly true", () => {
    expect(isForkEnabled(true)).toBe(true);
  });

  it("returns false only when the flag is explicitly false", () => {
    expect(isForkEnabled(false)).toBe(false);
  });
});

describe("buildForkContext", () => {
  it("returns a deep-copied tail of the parent's recent messages", () => {
    const parentMsgs = Array.from({ length: 5 }, (_, i) => msg("user", `hi ${i}`, i));
    const ctx = buildForkContext(parent(parentMsgs));
    expect(ctx.inheritedMessages).toHaveLength(5);
    expect(ctx.inheritedMessages.map((m) => m.id)).toEqual(parentMsgs.map((m) => m.id));
    // Mutation of returned tail must not bleed into the parent's array.
    ctx.inheritedMessages[0]!.content = "mutated";
    expect(parentMsgs[0]!.content).toBe("hi 0");
  });

  it("caps the tail at FORK_TAIL_MESSAGES", () => {
    const big = Array.from({ length: FORK_TAIL_MESSAGES + 10 }, (_, i) => msg("user", `m${i}`, i));
    const ctx = buildForkContext(parent(big));
    expect(ctx.inheritedMessages).toHaveLength(FORK_TAIL_MESSAGES);
    // It's the TAIL, so the first kept message is the (N+10 - N) = 10th overall.
    expect(ctx.inheritedMessages[0]!.id).toBe(`msg_${10}`);
  });

  it("deep-copies skills so the child cannot mutate parent state", () => {
    const ctx = buildForkContext(parent([]));
    expect(ctx.inheritedSkills).toEqual([skill]);
    ctx.inheritedSkills[0]!.description = "mutated";
    expect(skill.description).toBe("code review");
  });

  it("copies activeDeferredTools (or defaults to []) without sharing reference", () => {
    const ctx = buildForkContext(parent([]));
    expect(ctx.activeDeferredTools).toEqual(["recall_memory_chunk"]);
    ctx.activeDeferredTools.push("invasive");
    // Parent's array unchanged.
    const fresh = buildForkContext(parent([]));
    expect(fresh.activeDeferredTools).toEqual(["recall_memory_chunk"]);
  });

  it("treats a parent with no activeDeferredTools as empty []", () => {
    const ctx = buildForkContext({ messages: [], skills: [] });
    expect(ctx.activeDeferredTools).toEqual([]);
  });

  it("returns a serializable forkContext snapshot (ids + names)", () => {
    const parentMsgs = Array.from({ length: 3 }, (_, i) => msg("user", `hi ${i}`, i));
    const ctx = buildForkContext(parent(parentMsgs));
    expect(ctx.forkContext.messageIds).toEqual(parentMsgs.map((m) => m.id));
    expect(ctx.forkContext.skillNames).toEqual([skill.name]);
    expect(ctx.forkContext.activeDeferredTools).toEqual(["recall_memory_chunk"]);
    // forkContext arrays must be detached copies (no shared reference).
    ctx.forkContext.messageIds.push("invasive");
    const fresh = buildForkContext(parent(parentMsgs));
    expect(fresh.forkContext.messageIds).toEqual(parentMsgs.map((m) => m.id));
  });
});

describe("buildForkContext token budget", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.REINA_FORK_TAIL_TOKENS;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.REINA_FORK_TAIL_TOKENS;
    else process.env.REINA_FORK_TAIL_TOKENS = prev;
  });

  it("forkTailTokenBudget honors REINA_FORK_TAIL_TOKENS", () => {
    process.env.REINA_FORK_TAIL_TOKENS = "1234";
    expect(forkTailTokenBudget()).toBe(1234);
    delete process.env.REINA_FORK_TAIL_TOKENS;
    expect(forkTailTokenBudget()).toBe(DEFAULT_FORK_TAIL_TOKEN_BUDGET);
  });

  it("stops adding messages once the token budget would be exceeded", () => {
    // ~50 tokens of repeated text per message; budget = 120 → expect ~2 msgs.
    process.env.REINA_FORK_TAIL_TOKENS = "120";
    const big = Array.from({ length: 10 }, (_, i) =>
      msg("user", "lorem ipsum dolor sit amet ".repeat(20), i),
    );
    const ctx = buildForkContext(parent(big));
    expect(ctx.inheritedMessages.length).toBeLessThan(10);
    // Should be the most-recent messages.
    const lastIds = ctx.inheritedMessages.map((m) => m.id);
    const expectedTail = big.slice(-lastIds.length).map((m) => m.id);
    expect(lastIds).toEqual(expectedTail);
  });

  it("always keeps at least one message even if it overshoots the budget", () => {
    process.env.REINA_FORK_TAIL_TOKENS = "5";
    const big = [msg("user", "x ".repeat(500), 0)];
    const ctx = buildForkContext(parent(big));
    expect(ctx.inheritedMessages).toHaveLength(1);
    expect(ctx.inheritedMessages[0]!.id).toBe("msg_0");
  });

  it("respects FORK_TAIL_MESSAGES even with infinite token budget", () => {
    process.env.REINA_FORK_TAIL_TOKENS = "1000000";
    const tiny = Array.from({ length: FORK_TAIL_MESSAGES + 5 }, (_, i) =>
      msg("user", "x", i),
    );
    const ctx = buildForkContext(parent(tiny));
    expect(ctx.inheritedMessages).toHaveLength(FORK_TAIL_MESSAGES);
  });
});

describe("wrapForkDirective", () => {
  it("wraps the description in the directive tag", () => {
    expect(wrapForkDirective("audit auth.ts")).toBe("<fork-directive>audit auth.ts</fork-directive>");
  });

  it("XML-escapes metacharacters in the description", () => {
    expect(wrapForkDirective("a < b && c > d")).toBe("<fork-directive>a &lt; b &amp;&amp; c &gt; d</fork-directive>");
  });
});

describe("buildForkSkillDirective (P2-9)", () => {
  it("includes the skill name, body, and the supervisor's task brief", () => {
    const out = buildForkSkillDirective(
      "security-review",
      "# Steps\n1. Scan auth\n2. Check secrets",
      "focus on the new oauth flow",
    );
    expect(out).toContain("security-review");
    expect(out).toContain("Scan auth");
    expect(out).toContain("Check secrets");
    expect(out).toContain("focus on the new oauth flow");
    expect(out).toContain("SKILL.md:");
    expect(out).toContain("Task brief:");
  });

  it("omits the Task brief section when no brief is provided", () => {
    const out = buildForkSkillDirective("init", "do init");
    expect(out).toContain("init");
    expect(out).toContain("SKILL.md:");
    expect(out).not.toContain("Task brief:");
  });

  it("omits the Task brief section when the brief is whitespace-only", () => {
    const out = buildForkSkillDirective("init", "do init", "   ");
    expect(out).not.toContain("Task brief:");
  });

  it("trims the skill body so leading/trailing whitespace doesn't bloat the prompt", () => {
    const out = buildForkSkillDirective("x", "\n\n  body  \n\n");
    expect(out).toContain("body");
    expect(out).not.toMatch(/SKILL\.md:\n\n\n\n/);
  });
});
