import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord, ChatMessage, SessionState, SkillMetadata } from "@reina/protocol";
import {
  buildResumePrompt,
  checkWorktreeHealth,
  isResumable,
  normalizeWorktreePath,
  rebuildForkContext,
  resumeRefusalMessage,
} from "./resume.js";

function task(over: Partial<AsyncTaskRecord> & Pick<AsyncTaskRecord, "id" | "status">): AsyncTaskRecord {
  return {
    agent: "default",
    description: "x",
    startedAt: new Date().toISOString(),
    isolation: "none",
    ...over,
  };
}

describe("buildResumePrompt", () => {
  it("includes both the original brief and the supervisor's new message", () => {
    const out = buildResumePrompt("audit auth.ts", "now also check session.ts");
    expect(out).toContain("RECOVERY");
    expect(out).toContain("audit auth.ts");
    expect(out).toContain("now also check session.ts");
    expect(out).toContain("Do not assume hidden memory");
  });

  it("keeps the original brief and new message in distinct labeled sections", () => {
    const out = buildResumePrompt("brief", "more");
    const briefIdx = out.indexOf("Original brief:");
    const newIdx = out.indexOf("Supervisor's new message:");
    expect(briefIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(briefIdx);
  });
});

describe("isResumable", () => {
  it("treats recoverable and legacy evicted tasks as resumable", () => {
    expect(isResumable(task({ id: "a", status: "recoverable" }))).toBe(true);
    expect(isResumable(task({ id: "a", status: "evicted" }))).toBe(true);
    expect(isResumable(task({ id: "a", status: "running" }))).toBe(false);
    expect(isResumable(task({ id: "a", status: "needs_attention" }))).toBe(false);
    expect(isResumable(task({ id: "a", status: "completed" }))).toBe(false);
    expect(isResumable(task({ id: "a", status: "failed" }))).toBe(false);
    expect(isResumable(task({ id: "a", status: "cancelled" }))).toBe(false);
  });
});

describe("resumeRefusalMessage", () => {
  it("names the actual task status in the error", () => {
    const msg = resumeRefusalMessage(task({ id: "sub_x", status: "completed" }));
    expect(msg).toContain("sub_x");
    expect(msg).toContain("completed");
    expect(msg).toContain("Use task to fire a fresh dispatch");
  });
});

describe("buildResumePrompt — degradation warnings", () => {
  it("prepends a FORK CONTEXT LOST banner when the option is set", () => {
    const out = buildResumePrompt("brief", "new", { forkContextLost: true });
    expect(out).toContain("FORK CONTEXT LOST");
    expect(out).toContain("standalone subagent");
    expect(out).toContain("Original brief:");
  });

  it("prepends a WORKTREE MISSING banner when the worktree was lost", () => {
    const out = buildResumePrompt("brief", "new", { worktreeStatus: "missing" });
    expect(out).toContain("WORKTREE MISSING");
  });

  it("prepends a WORKTREE PRESERVED hint when the worktree is still on disk", () => {
    const out = buildResumePrompt("brief", "new", { worktreeStatus: "preserved" });
    expect(out).toContain("WORKTREE PRESERVED");
    expect(out).toContain("git status");
  });

  it("emits no degradation banners when no options are set", () => {
    const out = buildResumePrompt("brief", "new");
    expect(out).not.toContain("FORK CONTEXT LOST");
    expect(out).not.toContain("WORKTREE");
  });
});

describe("checkWorktreeHealth", () => {
  it("returns 'none' when no path is supplied", async () => {
    expect(await checkWorktreeHealth(undefined)).toBe("none");
  });

  it("returns 'preserved' when the path exists on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "reina-wt-health-"));
    try {
      expect(await checkWorktreeHealth(dir)).toBe("preserved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 'missing' when the path was removed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "reina-wt-gone-"));
    await rm(dir, { recursive: true, force: true });
    expect(await checkWorktreeHealth(dir)).toBe("missing");
  });
});

describe("rebuildForkContext", () => {
  const skillA: SkillMetadata = { name: "scout", description: "s", path: "/x/scout" };
  const skillB: SkillMetadata = { name: "audit", description: "a", path: "/x/audit" };
  function chatMsg(id: string): ChatMessage {
    return { id, role: "user", content: `hi ${id}`, createdAt: new Date().toISOString() };
  }
  function parent(
    over: Partial<Pick<SessionState, "messages" | "skills" | "activeDeferredTools">> = {},
  ): Pick<SessionState, "messages" | "skills" | "activeDeferredTools"> {
    return {
      messages: over.messages ?? [chatMsg("m1"), chatMsg("m2"), chatMsg("m3")],
      skills: over.skills ?? [skillA, skillB],
      activeDeferredTools: over.activeDeferredTools ?? ["recall_memory_chunk", "ToolSearch"],
    };
  }

  it("returns null when no saved context", () => {
    expect(rebuildForkContext(parent(), undefined)).toBeNull();
  });

  it("returns null when saved messageIds is empty", () => {
    const out = rebuildForkContext(parent(), {
      messageIds: [],
      skillNames: [],
      activeDeferredTools: [],
    });
    expect(out).toBeNull();
  });

  it("rebuilds inherited messages by id, in saved order", () => {
    const out = rebuildForkContext(parent(), {
      messageIds: ["m1", "m3"],
      skillNames: ["scout"],
      activeDeferredTools: ["ToolSearch"],
    });
    expect(out).not.toBeNull();
    expect(out!.inheritedMessages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(out!.inheritedSkills.map((s) => s.name)).toEqual(["scout"]);
    expect(out!.activeDeferredTools).toEqual(["ToolSearch"]);
  });

  it("returns null when any saved messageId is missing on the parent now (tail drifted)", () => {
    const out = rebuildForkContext(parent(), {
      messageIds: ["m1", "m_gone"],
      skillNames: [],
      activeDeferredTools: [],
    });
    expect(out).toBeNull();
  });

  it("silently drops skills that no longer exist on the parent", () => {
    const out = rebuildForkContext(parent(), {
      messageIds: ["m2"],
      skillNames: ["scout", "skill_gone"],
      activeDeferredTools: [],
    });
    expect(out!.inheritedSkills.map((s) => s.name)).toEqual(["scout"]);
  });

  it("intersects activeDeferredTools with parent's current set", () => {
    const out = rebuildForkContext(parent({ activeDeferredTools: ["ToolSearch"] }), {
      messageIds: ["m1"],
      skillNames: [],
      activeDeferredTools: ["recall_memory_chunk", "ToolSearch"],
    });
    expect(out!.activeDeferredTools).toEqual(["ToolSearch"]);
  });

  it("returns deep-copied messages (mutation does not bleed)", () => {
    const p = parent();
    const out = rebuildForkContext(p, {
      messageIds: ["m1"],
      skillNames: [],
      activeDeferredTools: [],
    });
    out!.inheritedMessages[0]!.content = "mutated";
    expect(p.messages[0]!.content).toBe("hi m1");
  });
});

describe("normalizeWorktreePath", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeWorktreePath("/cwd", undefined)).toBeUndefined();
  });

  it("returns absolute paths unchanged", () => {
    const abs = path.resolve("/tmp/wt-x");
    expect(normalizeWorktreePath("/cwd", abs)).toBe(abs);
  });

  it("resolves relative paths against the supervisor cwd", () => {
    const cwd = path.resolve("/cwd");
    expect(normalizeWorktreePath(cwd, "sub/path")).toBe(path.resolve(cwd, "sub/path"));
  });
});
