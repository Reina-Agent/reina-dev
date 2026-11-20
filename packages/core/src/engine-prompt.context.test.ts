import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, buildVolatileContextSections, formatUserRulesPrompt } from "./engine-prompt.js";

function session(cwd = process.cwd()): any {
  return {
    id: "t",
    title: "t",
    agent: "default",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    cwd,
    model: { provider: "deterministic", model: "x" },
    permissionMode: "default",
    messages: [],
    toolCalls: [],
    trace: [],
    approvals: [],
    questions: [],
    skills: [],
    asyncTasks: [],
    subagentDepth: 0,
  };
}

describe("system prompt environment block", () => {
  it("injects today's date as a temporal anchor", () => {
    const sp = buildSystemPrompt(session());
    expect(sp).toContain("Today's date:");
    expect(sp).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });
});

describe("plan-mode volatile context", () => {
  it("instructs the model to investigate read-only and exit through approval", () => {
    const active = session();
    active.permissionMode = "plan";
    const section = buildVolatileContextSections(active).find((entry) => entry.id === "plan_mode");
    expect(section?.content).toContain("read-only tools only");
    expect(section?.content).toContain("`exit_plan_mode`");
  });

  it("clears the instruction outside plan mode", () => {
    const section = buildVolatileContextSections(session()).find((entry) => entry.id === "plan_mode");
    expect(section?.content).toBe("");
    expect(section?.cleared).toContain("no longer active");
  });
});

describe("formatUserRulesPrompt ancestor AGENTS.md walk", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("inherits an ancestor AGENTS.md and orders the nearest one last (wins)", () => {
    const root = mkdtempSync(join(tmpdir(), "reina-rules-"));
    tmpDirs.push(root);
    const deep = join(root, "packages", "sub");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT_AGENTS_MARKER");
    writeFileSync(join(deep, "AGENTS.md"), "LEAF_AGENTS_MARKER");

    const out = formatUserRulesPrompt(deep);
    expect(out).toContain("ROOT_AGENTS_MARKER");
    expect(out).toContain("LEAF_AGENTS_MARKER");
    // Root-first ordering: the nearest (deepest) file is appended last so it
    // takes precedence on conflict.
    expect(out.indexOf("ROOT_AGENTS_MARKER")).toBeLessThan(out.indexOf("LEAF_AGENTS_MARKER"));
  });

  it("still surfaces a lone workspace-root AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "reina-rules-"));
    tmpDirs.push(root);
    writeFileSync(join(root, "AGENTS.md"), "SOLO_MARKER");
    expect(formatUserRulesPrompt(root)).toContain("SOLO_MARKER");
  });
});
