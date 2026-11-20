import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSkillsPrompt, loadSkills, type SkillFileCache } from "./skills.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-skills-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeSkill(name: string, frontmatter: string, body = "body content"): Promise<void> {
  const dir = path.join(cwd, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

async function writeSkillAt(root: string, name: string, frontmatter: string, body = "body content"): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

describe("skill roots and precedence", () => {
  it("reuses unchanged files and invalidates edits, additions, and removals", async () => {
    const cache: SkillFileCache = new Map();
    await writeSkill("cached", "name: cached\ndescription: original");
    const first = (await loadSkills(cwd, cache)).find((skill) => skill.name === "cached");
    const unchanged = (await loadSkills(cwd, cache)).find((skill) => skill.name === "cached");
    expect(unchanged).toBe(first);

    await writeSkill("cached", "name: cached\ndescription: updated instructions\ndisable-model-invocation: true");
    await writeSkill("added", "name: added\ndescription: newly installed");
    const updated = await loadSkills(cwd, cache);
    expect(updated.find((skill) => skill.name === "cached")).toMatchObject({
      description: "updated instructions",
      disableModelInvocation: true,
    });
    expect(updated.find((skill) => skill.name === "cached")).not.toBe(first);
    expect(updated.some((skill) => skill.name === "added")).toBe(true);

    const deletedFile = path.join(cwd, ".claude", "skills", "cached", "SKILL.md");
    await rm(deletedFile);
    expect((await loadSkills(cwd, cache)).some((skill) => skill.name === "cached")).toBe(false);
    expect(cache.has(deletedFile)).toBe(false);
  });

  it("discovers shared ~/.agents skills while preserving workspace precedence", async () => {
    const fakeHome = path.join(cwd, "home");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      await writeSkillAt(
        path.join(fakeHome, ".agents", "skills"),
        "shared-only",
        "name: shared-only\ndescription: shared agent skill",
      );
      await writeSkillAt(
        path.join(fakeHome, ".agents", "skills"),
        "lower-priority",
        "name: reviewer\ndescription: shared version",
      );
      await writeSkill("workspace-alias", "name: reviewer\ndescription: workspace version");

      const skills = await loadSkills(cwd);
      expect(skills.find((skill) => skill.name === "shared-only")?.description).toBe("shared agent skill");
      expect(skills.filter((skill) => skill.name === "reviewer")).toHaveLength(1);
      expect(skills.find((skill) => skill.name === "reviewer")?.description).toBe("workspace version");
    } finally {
      homedir.mockRestore();
    }
  });
});

describe("skill frontmatter `context` (P2-9)", () => {
  it("defaults to undefined when frontmatter omits context", async () => {
    await writeSkill("plain", "name: plain\ndescription: nothing special");
    const skills = await loadSkills(cwd);
    const plain = skills.find((s) => s.name === "plain");
    expect(plain?.context).toBeUndefined();
  });

  it("recognizes `context: fork`", async () => {
    await writeSkill("audit", "name: audit\ndescription: deep audit\ncontext: fork");
    const skills = await loadSkills(cwd);
    const audit = skills.find((s) => s.name === "audit");
    expect(audit?.context).toBe("fork");
  });

  it("recognizes `context: inline` (explicit default)", async () => {
    await writeSkill("inline-skill", "name: inline-skill\ndescription: x\ncontext: inline");
    const skills = await loadSkills(cwd);
    const inlineSkill = skills.find((s) => s.name === "inline-skill");
    expect(inlineSkill?.context).toBe("inline");
  });

  it("is case-insensitive on the value", async () => {
    await writeSkill("audit2", "name: audit2\ndescription: x\ncontext: FORK");
    const skills = await loadSkills(cwd);
    expect(skills.find((s) => s.name === "audit2")?.context).toBe("fork");
  });

  it("drops unknown context values silently", async () => {
    await writeSkill("audit3", "name: audit3\ndescription: x\ncontext: weird");
    const skills = await loadSkills(cwd);
    expect(skills.find((s) => s.name === "audit3")?.context).toBeUndefined();
  });
});

describe("formatSkillsPrompt fork-mode badge", () => {
  it("exposes an absolute file location and explains Pi-style relative references", async () => {
    await writeSkill("review", "name: review\ndescription: deep review");
    const skills = await loadSkills(cwd);
    const review = skills.find((skill) => skill.name === "review")!;
    const prompt = formatSkillsPrompt(skills);

    expect(path.isAbsolute(review.path)).toBe(true);
    expect(prompt).toContain(`<location>${review.path}</location>`);
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("resolve it relative to the directory containing that SKILL.md");
  });

  it("appends the fork-mode hint for context:fork skills", async () => {
    await writeSkill("review", "name: review\ndescription: deep review\ncontext: fork");
    const skills = await loadSkills(cwd);
    const prompt = formatSkillsPrompt(skills);
    expect(prompt).toMatch(/review.*\[fork-mode/);
    expect(prompt).toContain("task({fork: true");
  });

  it("does not add the badge for inline skills", async () => {
    await writeSkill("plain", "name: plain\ndescription: ordinary");
    const skills = await loadSkills(cwd);
    const prompt = formatSkillsPrompt(skills);
    expect(prompt).not.toMatch(/plain.*\[fork-mode/);
  });

  it("fork-mode hint carries the skill name for dispatch-time overrides", async () => {
    await writeSkill("review", "name: review\ndescription: deep review\ncontext: fork");
    const skills = await loadSkills(cwd);
    expect(formatSkillsPrompt(skills)).toContain('skill: "review"');
  });
});

describe("skill frontmatter model/effort overrides", () => {
  it("parses model and a valid effort tier", async () => {
    await writeSkill("heavy", "name: heavy\ndescription: x\nmodel: claude-fable-5\neffort: high");
    const skills = await loadSkills(cwd);
    const heavy = skills.find((s) => s.name === "heavy");
    expect(heavy?.model).toBe("claude-fable-5");
    expect(heavy?.effort).toBe("high");
  });

  it("drops an unknown effort tier but keeps the model", async () => {
    await writeSkill("odd", "name: odd\ndescription: x\nmodel: m1\neffort: turbo");
    const skills = await loadSkills(cwd);
    const odd = skills.find((s) => s.name === "odd");
    expect(odd?.model).toBe("m1");
    expect(odd?.effort).toBeUndefined();
  });

  it("leaves both undefined when absent", async () => {
    await writeSkill("plain", "name: plain\ndescription: x");
    const skills = await loadSkills(cwd);
    const plain = skills.find((s) => s.name === "plain");
    expect(plain?.model).toBeUndefined();
    expect(plain?.effort).toBeUndefined();
  });
});

describe("two-axis invocation gating (user-invocable / disable-model-invocation)", () => {
  it("parses user-invocable: false; absent means invocable", async () => {
    await writeSkill("model-only", "name: model-only\ndescription: x\nuser-invocable: false");
    await writeSkill("normal", "name: normal\ndescription: x");
    const skills = await loadSkills(cwd);
    expect(skills.find((s) => s.name === "model-only")?.userInvocable).toBe(false);
    expect(skills.find((s) => s.name === "normal")?.userInvocable).toBeUndefined();
  });

  it("parses disable-model-invocation: true; absent means model-visible", async () => {
    await writeSkill("user-only", "name: user-only\ndescription: x\ndisable-model-invocation: true");
    await writeSkill("normal", "name: normal\ndescription: x");
    const skills = await loadSkills(cwd);
    expect(skills.find((s) => s.name === "user-only")?.disableModelInvocation).toBe(true);
    expect(skills.find((s) => s.name === "normal")?.disableModelInvocation).toBeUndefined();
  });

  it("keeps disable-model-invocation skills out of the model prompt roster", async () => {
    await writeSkill("user-only", "name: user-only\ndescription: secret workflow\ndisable-model-invocation: true");
    await writeSkill("normal", "name: normal\ndescription: everyday helper");
    const skills = await loadSkills(cwd);
    const prompt = formatSkillsPrompt(skills);
    expect(prompt).toContain("normal");
    expect(prompt).not.toContain("user-only");
  });

  it("falls back to the empty-state prompt when every skill is model-hidden", async () => {
    // Only meaningful when builtins are absent from the roster — filter to
    // just the workspace skill so the assertion isn't diluted by builtins.
    await writeSkill("user-only", "name: user-only\ndescription: x\ndisable-model-invocation: true");
    const skills = (await loadSkills(cwd)).filter((s) => s.name === "user-only");
    expect(formatSkillsPrompt(skills)).toContain("No skills are installed yet");
  });
});
