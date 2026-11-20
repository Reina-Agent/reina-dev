export interface AddMenuSkill {
  name: string;
  description?: string;
  scope?: "workspace" | "global";
  context?: "inline" | "fork";
  userInvocable?: boolean;
}

/** Preserve a normal draft when entering Goal mode, but migrate the old
 * command-prefixed draft so `/goal` never leaks into the dedicated editor. */
export function prepareGoalDraft(draft: string): string {
  const content = draft.trim();
  const legacyGoal = /^\/goal(?:\s+([\s\S]*))?$/i.exec(content);
  return legacyGoal ? (legacyGoal[1] ?? "") : draft;
}

export function visibleAddMenuSkills(skills: AddMenuSkill[]): AddMenuSkill[] {
  return skills.filter((skill) => skill.userInvocable !== false && Boolean(skill.name));
}
