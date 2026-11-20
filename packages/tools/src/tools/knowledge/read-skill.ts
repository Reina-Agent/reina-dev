import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { truncateToolOutput } from "../../utils.js";
import { getBuiltinSkillBody } from "./builtin-skills.js";
import { readSkillsDir, skillRoots } from "./list-skills.js";
import { description } from "../../prompts/read-skill.js";

const schema = z.object({
  name: z
    .string()
    .describe(
      "Skill name (kebab-case, no path or extension). Looked up in `<workspace>/.claude/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, then the built-in catalog. Use list_skills to discover what's available.",
    ),
});

type ResolvedSkill = { kind: "file"; file: string } | { kind: "builtin"; body: string };
const skillFileName = "SKILL.md";

export const readSkillTool: ToolImplementation = {
  descriptor: {
    name: "read_skill",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: schema,
    examples: [
      {
        description: "Load a specific skill's SKILL.md by name",
        input: { name: "commit" },
      },
      {
        description: "Workspace-local skill lookup (same call shape)",
        input: { name: "deploy-checklist" },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(parsed.name)) {
      throw new Error(
        `invalid skill name: "${parsed.name}". Skill names are kebab-case (letters, digits, hyphens), no path or extension. Run list_skills to see what's available.`,
      );
    }
    const skill = await resolveSkill(parsed.name, options.cwd);
    if (!skill) {
      throw new Error(
        `skill not found: "${parsed.name}". Looked in <workspace>/.claude/skills/, ~/.claude/skills/, ~/.agents/skills/, and the built-in catalog. Run list_skills to see available skills.`,
      );
    }
    if (skill.kind === "builtin") {
      return (await truncateToolOutput(options.cwd, skill.body)).content;
    }

    const info = await fs.stat(skill.file);
    return {
      output: (await truncateToolOutput(options.cwd, await fs.readFile(skill.file, "utf8"))).content,
      metadata: { readFiles: [{ path: skill.file, mtimeMs: info.mtimeMs }] },
    };
  },
};

async function resolveSkill(name: string, cwd: string): Promise<ResolvedSkill | undefined> {
  const roots = skillRoots(cwd);
  // Resolve one source at a time so a higher-priority frontmatter-name match
  // cannot be shadowed by a lower-priority skill. When frontmatter omits name,
  // the shared parser falls back to the directory name.
  for (const root of [roots.workspace, roots.global, roots.shared]) {
    // Preserve the legacy directory-name alias when frontmatter advertises a
    // different invocation name.
    const direct = path.join(root, name, skillFileName);
    if (await isRegularFile(direct)) return { kind: "file", file: direct };
    const match = (await readSkillsDir(root)).find((skill) => skill.name === name);
    if (match) return { kind: "file", file: match.file };
  }

  const builtin = getBuiltinSkillBody(name);
  return builtin ? { kind: "builtin", body: builtin } : undefined;
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
