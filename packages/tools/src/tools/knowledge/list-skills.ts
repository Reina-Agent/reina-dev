import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseSkillFrontmatter, type ParsedSkillMetadata } from "@reina/protocol";
import type { ToolImplementation } from "../../types.js";
import { resolveWorkspacePath } from "../../utils.js";
import { builtinSkillMetadata } from "./builtin-skills.js";
import { description } from "../../prompts/list-skills.js";

const maxSkillBytes = 1024 * 1024;

/** Load and parse every SKILL.md under a skills root. Shared by list_skills
 * (roster listing) and read_skill (frontmatter-name fallback resolution). */
export async function readSkillsDir(root: string): Promise<Array<ParsedSkillMetadata & { file: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Array<ParsedSkillMetadata & { file: string }> = [];
  for (const entry of entries) {
    // Symlinked skill directories report isDirectory() === false on the
    // Dirent — let the SKILL.md read decide whether the target resolves.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    const content = await fs.readFile(file, "utf8").catch(() => undefined);
    if (!content || Buffer.byteLength(content, "utf8") > maxSkillBytes) continue;
    out.push({ ...parseSkillFrontmatter(content, entry.name), file });
  }
  return out;
}

export function skillRoots(cwd: string): { workspace: string; global: string; shared: string } {
  return {
    workspace: resolveWorkspacePath(cwd, path.join(".claude", "skills")),
    global: path.join(os.homedir(), ".claude", "skills"),
    shared: path.join(os.homedir(), ".agents", "skills"),
  };
}

export const listSkillsTool: ToolImplementation = {
  descriptor: {
    name: "list_skills",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({}),
  },
  async execute(_input, options) {
    const roots = skillRoots(options.cwd);
    // Same precedence as the system-prompt roster (core loadSkills): built-in
    // → shared agent skills → Reina-global → workspace, later wins on
    // frontmatter `name`. Listing the frontmatter name (not the directory
    // name) keeps this output in the same name space the roster advertises and
    // read_skill resolves.
    const byName = new Map<string, ParsedSkillMetadata>();
    for (const builtin of builtinSkillMetadata) byName.set(builtin.name, builtin);
    for (const skill of await readSkillsDir(roots.shared)) byName.set(skill.name, skill);
    for (const skill of await readSkillsDir(roots.global)) byName.set(skill.name, skill);
    for (const skill of await readSkillsDir(roots.workspace)) byName.set(skill.name, skill);
    // `disable-model-invocation` skills are user-triggered only: keeping them
    // out of this listing (like the roster) is what "the model never
    // discovers them" means.
    const names = [...byName.values()]
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => skill.name)
      .sort((a, b) => a.localeCompare(b));
    return JSON.stringify(names, null, 2);
  },
};
