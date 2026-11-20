import type { ChatMessage, SessionState, SkillMetadata } from "@reina/protocol";
import { estimateTextTokens } from "../compaction.js";

/** Fork mode: a child subagent that shares its parent's recent message
 * tail + skills snapshot + active deferred tools. The first model call
 * on the child reuses the parent's prompt-cache prefix, so a fan-out of
 * forks billed at "supervisor's prefix + small delta per worker"
 * instead of N cold starts × full system prompt.
 *
 * The directive is wrapped in a `<fork-directive>` tag (assembled by
 * the manager and passed to runTurn) so the child can distinguish "the
 * task the supervisor handed me" from the surrounding tail (which is
 * the supervisor's own conversation history). */

/** Hard upper bound on message count regardless of token budget — defense
 * in depth so a session with thousands of tiny messages doesn't pull a
 * pathological tail. */
export const FORK_TAIL_MESSAGES = 24;

/** Default token budget for the inherited tail. Anthropic's prompt cache
 * keys on the EXACT prefix bytes, so we pick a budget that comfortably
 * matches typical cached prefixes (system + a handful of recent turns)
 * without blowing the cost of fan-out spawns. Overridable via
 * REINA_FORK_TAIL_TOKENS. */
export const DEFAULT_FORK_TAIL_TOKEN_BUDGET = 8_000;

export function forkTailTokenBudget(): number {
  const raw = process.env.REINA_FORK_TAIL_TOKENS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_FORK_TAIL_TOKEN_BUDGET;
}

/** Best-effort token estimate for a ChatMessage. Mirrors the heuristic
 * used by the compaction trigger (cl100k_base on text content) so the
 * fork tail and the compactor agree on "how big" a message is. Non-
 * string content (multipart, tool blocks) is approximated by JSON
 * length — those messages are uncommon in the fork tail anyway. */
function messageTokens(m: ChatMessage): number {
  const c = m.content as unknown;
  if (typeof c === "string") return estimateTextTokens(c);
  try {
    return estimateTextTokens(JSON.stringify(c));
  } catch {
    return 0;
  }
}

/** Resolve fork-mode activation. Source of truth is the global
 * ReinaConfig (`subagent.forkEnabled`), surfaced via the SubagentHost
 * snapshot — set once at engine creation time. Default is enabled;
 * only an explicit `false` disables fork dispatch.
 *
 * Historical note: this used to be env-gated (`REINA_FEATURE_FORK_SUBAGENT`)
 * during the P1-4 rollout. The flag now lives in the desktop Settings UI
 * (Agents → Parallel subagents); the env var has been removed. */
export function isForkEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

/** Compose the child's pre-runTurn context for fork mode.
 *
 * Returns:
 *   - `inheritedMessages` — deep-copied tail of parent.messages selected
 *     by a TOKEN budget (not just message count). Walks from newest to
 *     oldest, accumulating message tokens until the budget is hit, then
 *     stops at the message boundary so the prompt-cache prefix still
 *     aligns with what the parent will send next. Also capped by
 *     FORK_TAIL_MESSAGES so pathological cases (thousands of tiny
 *     messages) don't pull an inflated tail.
 *   - `inheritedSkills` — deep-copied snapshot so the child can't
 *     mutate parent state.
 *   - `activeDeferredTools` — inherited so the fork doesn't have to
 *     re-discover capabilities the supervisor already searched for.
 *   - `forkContext` — serializable pointers (message ids, skill names,
 *     deferred tool names) so the manager can persist them on the
 *     AsyncTaskRecord and (best-effort) reconstruct the fork on resume
 *     after a process restart. See resume.ts for the rebuild path. */
export function buildForkContext(
  parent: Pick<SessionState, "messages" | "skills" | "activeDeferredTools">,
): {
  inheritedMessages: ChatMessage[];
  inheritedSkills: SkillMetadata[];
  activeDeferredTools: string[];
  forkContext: {
    messageIds: string[];
    skillNames: string[];
    activeDeferredTools: string[];
  };
} {
  const budget = forkTailTokenBudget();
  const reversed: ChatMessage[] = [];
  let usedTokens = 0;
  // Walk from newest backwards; stop when adding the next message would
  // exceed the budget OR we've already collected FORK_TAIL_MESSAGES.
  for (let i = parent.messages.length - 1; i >= 0; i--) {
    if (reversed.length >= FORK_TAIL_MESSAGES) break;
    const m = parent.messages[i]!;
    const tokens = messageTokens(m);
    // Always include at least one message even if it overshoots (a
    // single oversized message is rare; refusing to inherit ANY tail
    // would degrade the fork into a cold start).
    if (reversed.length > 0 && usedTokens + tokens > budget) break;
    reversed.push(m);
    usedTokens += tokens;
  }
  const tail = reversed.reverse().map((m) => ({ ...m }));
  const skills = parent.skills.map((skill) => ({ ...skill }));
  const activeDeferredTools = [...(parent.activeDeferredTools ?? [])];
  return {
    inheritedMessages: tail,
    inheritedSkills: skills,
    activeDeferredTools,
    forkContext: {
      messageIds: tail.map((m) => m.id),
      skillNames: skills.map((s) => s.name),
      activeDeferredTools: [...activeDeferredTools],
    },
  };
}

/** Wrap the supervisor's brief in the `<fork-directive>` tag the
 * model uses to distinguish fork tasks from regular continuation
 * messages. Lifted to a helper so the test suite can assert the exact
 * shape. */
export function wrapForkDirective(description: string): string {
  return `<fork-directive>${escapeForkContent(description)}</fork-directive>`;
}

/** P2-9: compose the dispatch directive for a fork-mode skill. The
 * supervisor reads SKILL.md from the skill roster's location, then passes the body
 * here to get a directive that:
 *   1. names the skill so the worker can self-attribute,
 *   2. embeds the full skill body verbatim so the worker doesn't have
 *      to re-fetch it,
 *   3. tacks on the supervisor's optional task brief so the worker
 *      knows what to apply the skill TO.
 *
 * The resulting string is suitable to pass as the `description`
 * argument to start_async_task({fork: true, description: ...}). */
export function buildForkSkillDirective(
  skillName: string,
  skillBody: string,
  taskBrief?: string,
): string {
  const lines = [
    `[Skill dispatch: "${skillName}" — apply the following SKILL.md instructions to the supervisor's task.]`,
    "",
    "SKILL.md:",
    skillBody.trim(),
  ];
  const trimmedBrief = taskBrief?.trim();
  if (trimmedBrief) {
    lines.push("", "Task brief:", trimmedBrief);
  }
  return lines.join("\n");
}

/** Light XML-text escape — same shape as escapeXml in format.ts, but
 * kept local so this module doesn't introduce a cross-file import for
 * a 3-line helper. */
function escapeForkContent(value: string): string {
  return value.replace(/[<>&]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;"));
}
