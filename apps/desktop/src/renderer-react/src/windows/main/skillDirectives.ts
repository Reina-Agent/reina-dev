// Wire format for staged-skill invocation (claude-code's <command-name>
// pattern): the directive sentence the model reads is unchanged — it is only
// WRAPPED in a <skill-directive> tag so the transcript can render a compact
// skill chip instead of showing the scaffolding as if the user typed it.
// Producers: Composer send/queue folds + runSlashCommand `/skill <name>`.
// Consumer: ChatEntry's user branch (parse → chips + remaining text).

const OPEN = "<skill-directive>";
const CLOSE = "</skill-directive>";

/** Build the outgoing user-message text for staged skills + the typed draft.
 * With an empty draft the message is just the directive tag(s). */
export function formatSkillDirectives(names: string[], msg: string): string {
  const tags = names.map((name) => `${OPEN}Use the \`${name}\` skill.${CLOSE}`).join("\n");
  return msg ? `${tags}\n\n${msg}` : tags;
}

/** Split leading skill-directive tags off a user message. Returns the skill
 * names (for chip rendering) and the user-authored remainder. Content without
 * leading tags passes through untouched (skills = [], rest = content). */
export function parseSkillDirectives(content: string): { skills: string[]; rest: string } {
  const skills: string[] = [];
  let rest = content;
  for (;;) {
    const match = rest.match(/^\s*<skill-directive>([\s\S]*?)<\/skill-directive>[ \t]*\r?\n?/);
    if (!match) break;
    const inner = match[1] ?? "";
    // Chip label: the backticked name inside the directive; fall back to the
    // raw inner text so an unexpected directive still renders something.
    skills.push(inner.match(/`([^`]+)`/)?.[1] ?? inner.trim());
    rest = rest.slice(match[0].length);
  }
  if (skills.length === 0) return { skills, rest: content };
  return { skills, rest: rest.trimStart() };
}
