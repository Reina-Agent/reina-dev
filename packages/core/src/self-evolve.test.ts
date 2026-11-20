import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCallRecord } from "@reina/protocol";
import { loadSelfEvolveDirective, selfEvolveDirectivePath, summarizeSelfReview, SELF_EVOLVE_DIRECTIVE_SEED } from "./self-evolve.js";

function call(name: string, input: unknown, status: ToolCallRecord["status"] = "completed"): ToolCallRecord {
  return { id: name + Math.random(), name: name as ToolCallRecord["name"], input, summary: "", permission: "state", status, createdAt: "" };
}

describe("summarizeSelfReview", () => {
  it("counts global-note creates/updates and skill-file writes, ignores workspace + failed", () => {
    const summary = summarizeSelfReview([
      call("note", { scope: "global", title: "用户偏好中文回复" }),
      call("note", { scope: "global", title: "喜欢直接结论" }),
      call("note", { scope: "workspace", title: "本项目发现" }), // workspace → ignored
      call("update_note", { scope: "global", id: "g_003" }),
      call("write_file", { path: "/home/u/.claude/skills/debug-electron/SKILL.md" }),
      call("write_file", { path: "src/main.ts" }), // not a skill → ignored
      call("note", { scope: "global", title: "半途失败" }, "failed"), // not completed → ignored
    ]);
    expect(summary).toContain("记忆 +2");
    expect(summary).toContain("用户偏好中文回复");
    expect(summary).toContain("记忆 ✎1");
    expect(summary).toContain("技能 1");
    expect(summary).toContain("debug-electron"); // skill name, not full path
    expect(summary).not.toContain("本项目发现");
    expect(summary).not.toContain("半途失败");
  });

  it("returns empty string when a review changed nothing (the quiet case)", () => {
    expect(summarizeSelfReview([call("read_note", { id: "g_001" }), call("list_notes", {})])).toBe("");
    expect(summarizeSelfReview([])).toBe("");
  });
});

describe("loadSelfEvolveDirective", () => {
  it("seeds the default on first use, then reads the user's edits verbatim", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "reina-se-"));
    const prev = process.env.REINA_CONFIG_HOME;
    process.env.REINA_CONFIG_HOME = home;
    try {
      // First call: file absent → seeded with the default.
      const first = await loadSelfEvolveDirective();
      expect(first).toBe(SELF_EVOLVE_DIRECTIVE_SEED);
      const onDisk = await fs.readFile(selfEvolveDirectivePath(), "utf-8");
      expect(onDisk).toBe(SELF_EVOLVE_DIRECTIVE_SEED);

      // User edits the file → next load reflects it (no re-seed / overwrite).
      await fs.writeFile(selfEvolveDirectivePath(), "# 我的复盘规则\n只记偏好。\n", "utf-8");
      expect(await loadSelfEvolveDirective()).toBe("# 我的复盘规则\n只记偏好。\n");
    } finally {
      if (prev === undefined) delete process.env.REINA_CONFIG_HOME;
      else process.env.REINA_CONFIG_HOME = prev;
    }
  });
});
