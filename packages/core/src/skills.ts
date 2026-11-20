import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SkillMetadata } from "@reina/protocol";
import { parseSkillFrontmatter } from "@reina/protocol";
import { builtinSkillMetadata, isBuiltinSkillPath } from "@reina/tools";

const maxSkillBytes = 1024 * 1024;

export type SkillFileCache = Map<string, { version: string; metadata: SkillMetadata }>;

export async function loadSkills(cwd: string, cache: SkillFileCache = new Map()): Promise<SkillMetadata[]> {
  const skills = new Map<string, SkillMetadata>();
  const seen = new Set<string>();
  const roots = await Promise.all(
    [sharedSkillsDir(), globalSkillsDir(), workspaceSkillsDir(cwd)].map((root) => loadSkillsFromDir(root, cache, seen)),
  );
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);

  for (const builtin of builtinSkillMetadata) skills.set(builtin.name, builtin);
  for (const root of roots) for (const skill of root) skills.set(skill.name, skill);

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSkillsFromDir(root: string, cache: SkillFileCache, seen: Set<string>): Promise<SkillMetadata[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries.map(async (entry): Promise<SkillMetadata | undefined> => {
    // Symlinked skill directories (some skill managers install via ln -s)
    // report isDirectory() === false on the Dirent; let the SKILL.md read
    // itself decide whether the target actually resolves.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    seen.add(skillFile);
    const info = await stat(skillFile).catch(() => undefined);
    if (!info?.isFile() || info.size > maxSkillBytes) {
      cache.delete(skillFile);
      return;
    }
    const version = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const previous = cache.get(skillFile);
    if (previous?.version === version) return previous.metadata;
    const content = await readFile(skillFile, "utf8").catch(() => undefined);
    if (!content || Buffer.byteLength(content, "utf8") > maxSkillBytes) {
      cache.delete(skillFile);
      return;
    }

    const metadata = parseSkill(content, skillFile, entry.name);
    if (metadata) cache.set(skillFile, { version, metadata });
    return metadata;
  }));
  return skills.filter((skill): skill is SkillMetadata => skill !== undefined);
}

function workspaceSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "skills");
}

function globalSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function sharedSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function formatSkillsPrompt(skills: SkillMetadata[]): string {
  // `disable-model-invocation` skills are user-triggered only (via /skill):
  // keeping them out of this list is what "the model never auto-invokes"
  // means — the prompt roster is the model's only discovery surface.
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) {
    return [
      "Skills system:",
      "No skills are installed yet. Skills are your procedural memory: after you work out a reusable way to do something, write it as `.claude/skills/<name>/SKILL.md` (workspace-local) or `~/.claude/skills/<name>/SKILL.md` (global, available in every project) — it is discovered before the next model request.",
    ].join("\n");
  }

  return [
    "Skills system:",
    "Use skills with progressive disclosure. The list below tells you what exists; load a file-backed SKILL.md with read_file at its absolute <location> only when the task matches the description.",
    "When a skill references a relative path (for example scripts/run.py or references/checklist.md), resolve it relative to the directory containing that SKILL.md, then use the resulting absolute path in tool calls.",
    "Locations beginning with builtin: have no file on disk; load those with read_skill by name.",
    "Skills are your procedural memory and they compound: when you work out a reusable procedure worth invoking again, save it as a new SKILL.md (`.claude/skills/<name>/` for this project, `~/.claude/skills/<name>/` for every project). If following a skill led you wrong or it's out of date, edit its SKILL.md to fix it. (Durable facts/preferences go in the global notebook via `note(scope:\"global\")`; reusable procedures go here.)",
    ...visible.map((skill) => {
      const tools = skill.allowedTools?.length ? ` Allowed tools: ${skill.allowedTools.join(", ")}.` : "";
      // P2-9 hint: surface fork-mode skills so the supervisor knows to
      // dispatch via task({fork: true}) after reading the
      // body, rather than applying it inline. Passing `skill` lets the
      // engine apply the skill's model/effort override to the child.
      const ctx = skill.context === "fork" ? ` [fork-mode: dispatch via task({fork: true, skill: "${skill.name}"}) with the skill body as the directive]` : "";
      const loader = isBuiltinSkillPath(skill.path)
        ? ` Call read_skill("${skill.name}") for full instructions.`
        : ` <location>${skill.path}</location>`;
      return `- ${skill.name}: ${skill.description}${loader}${tools}${ctx}`;
    }),
  ].join("\n");
}

function parseSkill(content: string, skillFile: string, directoryName: string): SkillMetadata | undefined {
  return {
    // Frontmatter semantics (P2-9 context, per-skill model/effort overrides,
    // grok-style two-axis invocation gating) live in the shared parser so the
    // tools-side name resolution and the desktop skill listing can't drift.
    ...parseSkillFrontmatter(content, directoryName),
    // Absolute path: the path-revealing consumer is the "Reveal in folder"
    // button, which passes it straight to Electron's shell.showItemInFolder —
    // a process.cwd()-relative path resolves against the wrong base (host cwd
    // != main-process cwd != workspace cwd) and breaks Reveal for any
    // workspace other than the repo root. The model-facing skill roster also
    // exposes this absolute location so read_file can follow Pi-style skill
    // references outside the workspace.
    path: skillFile,
  };
}
