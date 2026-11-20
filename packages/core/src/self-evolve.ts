import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCallRecord } from "@reina/protocol";
import { reinaConfigHome } from "@reina/tools";

/** Hermes-style background self-improvement review.
 *
 * After every N top-level turns the engine forks a restricted child (the
 * `self-review` profile — only note + file/skill tools) that reads a tail of
 * the conversation and folds durable learnings into the GLOBAL notebook
 * (`note(scope:"global")`) and skills. This module owns the two editable /
 * derived pieces of that loop: the review directive (a user-editable file) and
 * the summary of what a review actually wrote (for the notify log). The fork
 * plumbing lives in engine.ts. */

/** Default review directive, seeded once to `<REINA_HOME>/self-evolve.md`. It
 * is prose the review fork reads as its task — the user owns the file after
 * seeding and can rewrite it to change what the loop captures. Adapted from
 * Hermes' combined memory+skill review prompt, mapped onto Reina's global
 * notebook + `.claude/skills` procedural memory. */
export const SELF_EVOLVE_DIRECTIVE_SEED = `# 自进化复盘

复盘上面这段对话，把「跨会话仍然成立」的学习沉淀下来。**要主动** —— 大多数
会话都至少值得写一条。什么都不做通常是漏掉了学习机会，而不是中性结果。真的没有
可沉淀的（对话很顺、没有纠正、没有新方法）才说「无可沉淀」并停止。

你只能调用 note / update_note / read_note / list_notes 和文件工具（读写
SKILL.md）。其它工具在运行时会被拒绝，不要尝试。

## 两条落点

**全局记忆本（\`note(scope:"global")\`）—— 记「用户是谁 / 通用事实」：**
- \`kind:preference\` 用户怎么工作：语气、审查深度、反复出现的纠正、明确说的「记住」。
  这是最高价值的一层，让你每次都更贴合用户。
- \`kind:technique\` 一次可复用的小方法 / 排错路径 / 工具用法（成体系的完整流程优先写成技能）。
- \`kind:concept\` / \`kind:entity\` 值得记住的通用机制 / 反复遇到的工具或环境怪癖。
- 已有相近的 note 就 \`update_note\` 合并、翻新，别追加近似重复；用 \`refs\` 连接相关 note。

**技能（\`.claude/skills/<name>/SKILL.md\`）—— 记「这类任务怎么做」：**
- 用户纠正了你的风格 / 格式 / 流程 / 步骤 —— 把教训写进管这类任务的技能里，下次开局就已修正。
  用户的不满（「别再 X」「太啰嗦」「直接给答案」）是**一等**技能信号，不只是记忆信号。
- 冒出了非平凡的技巧 / 修复 / workaround —— 抓下来。
- 这次加载或参考过的某个技能被证明是错的 / 缺步骤 / 过时了 —— 现在就补它。
- 优先级：先改这次用到的技能 → 再改已有的同类技能 → 都没有再新建。
  新技能名必须是**类级**的，不能是某个 PR 号 / 报错串 / 今天任务的代号。
- 写全局技能放 \`~/.claude/skills/<name>/\`（每个项目都可用），项目专属放 \`.claude/skills/<name>/\`。

## 不要沉淀（这些会变成日后反咬自己的自设枷锁）

- 环境依赖的失败：缺二进制、没装的包、没配的凭据、\`command not found\`。用户能修，不是持久规则。
- 对工具的负面断言（「X 工具用不了」「浏览器工具不行」）—— 会硬化成几个月后仍在自我引用的拒绝。
- 会话内已经解决的临时报错。重试成功了，教训是「重试」，不是原始失败。
- 一次性任务叙事（「总结今天的市场」「分析这个 PR」）不构成一类值得写技能的工作。

工具因环境状态失败时，把**修复办法**（安装命令 / 配置步骤 / 要设的环境变量）记到相应的
排错技能里，而不是「这工具用不了」这种孤立断言。

项目专属的发现留在工作区记忆本（\`note\` 默认 scope），不要塞进全局。
`;

/** Path to the editable review directive. */
export function selfEvolveDirectivePath(): string {
  return path.join(reinaConfigHome(), "self-evolve.md");
}

/** Load the review directive, seeding the default on first use so the user has
 * a file to edit. Read fresh every review, so edits take effect without a
 * restart. Never throws — falls back to the in-memory seed if disk is
 * unavailable (a review must never be blocked by a missing file). */
export async function loadSelfEvolveDirective(): Promise<string> {
  const file = selfEvolveDirectivePath();
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, SELF_EVOLVE_DIRECTIVE_SEED, "utf-8");
    } catch {
      // best-effort seed — the review still runs off the in-memory default
    }
    return SELF_EVOLVE_DIRECTIVE_SEED;
  }
}

/** One-line summary of what a review wrote, for the notify log. Scans the
 * fork's completed tool calls for global-note writes and skill-file writes.
 * Returns "" when the review changed nothing (the common, quiet case). */
export function summarizeSelfReview(toolCalls: readonly ToolCallRecord[]): string {
  const created: string[] = [];
  let updated = 0;
  const skills = new Set<string>();
  for (const call of toolCalls) {
    if (call.status !== "completed") continue;
    const input = (call.input ?? {}) as { scope?: string; title?: string; id?: string; path?: string };
    if (call.name === "note" && input.scope === "global") {
      created.push(input.title?.trim() || "note");
    } else if (call.name === "update_note" && input.scope === "global") {
      updated += 1;
    } else if (
      (call.name === "write_file" || call.name === "edit_file") &&
      typeof input.path === "string" &&
      // A skill file: any path segment named `skills` followed by more path
      // (…/skills/<name>/SKILL.md, workspace or ~/.claude). Slash-agnostic.
      /(^|[\\/])skills[\\/]/.test(input.path)
    ) {
      skills.add(input.path);
    }
  }
  const parts: string[] = [];
  if (created.length) {
    const preview = created.slice(0, 3).join("、");
    parts.push(`记忆 +${created.length}（${preview}${created.length > 3 ? "…" : ""}）`);
  }
  if (updated) parts.push(`记忆 ✎${updated}`);
  if (skills.size) {
    const names = [...skills].map(skillName).slice(0, 3).join("、");
    parts.push(`技能 ${skills.size}（${names}${skills.size > 3 ? "…" : ""}）`);
  }
  return parts.join(" · ");
}

/** `.../skills/foo/SKILL.md` → `foo`. Falls back to the basename. */
function skillName(p: string): string {
  const m = p.match(/skills[\\/]([^\\/]+)/);
  return m ? m[1]! : p.split(/[\\/]/).pop() || p;
}
