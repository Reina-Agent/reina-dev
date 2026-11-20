import type { AgentProfile, SkillMetadata } from "@reina/protocol";

/** When a profile declares `skills`, filter the workspace-loaded skill
 * catalog down to just those names. The engine calls this after
 * `loadSkills(cwd)` for primary profiles, and after the parent's skills
 * snapshot is copied to a child in `spawnChildEngine`.
 *
 * Behavior:
 *   - `profile.skills` undefined / empty → return `skills` unchanged
 *   - `profile.skills` present → keep entries whose `name` matches
 *     (order: profile.skills order, not the alphabetic load order)
 *   - Names with no matching skill are silently dropped (mis-typed
 *     entries don't crash the engine; the renderer can show the
 *     mismatch via a future warning if useful)
 *
 * No I/O happens here — this is a pure filter over the already-loaded
 * SkillMetadata array. */
export function filterSkillsByProfile(
  skills: SkillMetadata[],
  profile: AgentProfile,
): SkillMetadata[] {
  const wanted = profile.skills;
  if (!wanted || wanted.length === 0) return skills;
  const byName = new Map<string, SkillMetadata>();
  for (const skill of skills) byName.set(skill.name, skill);
  const out: SkillMetadata[] = [];
  for (const name of wanted) {
    const skill = byName.get(name);
    if (skill) out.push(skill);
  }
  return out;
}
