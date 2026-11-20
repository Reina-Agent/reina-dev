import type { ChatMessage, SessionState, SkillMetadata } from "@reina/protocol";

/** Side chat ("/btw") — an ephemeral child agent forked from the live session
 * so the user can ask side questions while the main turn keeps running.
 *
 * Design synthesis of the two reference implementations:
 *   - kimi-code: in-session child agent, FULL context copy (byte-identical
 *     prefix → prompt-cache hit), tool definitions stay in the request for
 *     cache stability, enforcement happens at the execution layer.
 *   - codex: a "side conversation boundary" prompt that demotes the inherited
 *     history to reference material, plus read-only exploration allowed.
 *
 * Reina takes kimi's skeleton (in-process child + hard execution-layer veto)
 * with codex's semantics (boundary prompt + read-only tools allowed). The
 * veto itself lives in tool-dispatch.ts (`isSideChat` → only `read`-level
 * tools run); this module owns the prompts and the context seed. */

/** Injected as the last inherited message so the model treats everything
 * above it as reference material, not an active task. Adapted from codex's
 * SIDE_BOUNDARY_PROMPT, trimmed to Reina's toolset (read-only tools are
 * mechanically enforced here, so the prompt states the policy rather than
 * begging for compliance). */
export const SIDE_CHAT_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the main conversation. It is reference context only — it is NOT your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, or edits from before this boundary. Only messages after this boundary are active instructions.

You are a side-conversation assistant, separate from the main agent (which continues independently — do not reference being interrupted). Answer the user's side questions directly and concisely, using what you already know from the inherited context first.

You may use read-only tools (read files, search, list) for lightweight lookups. All mutating tools (shell, write, edit, network, delegation) are disabled and will be rejected — do not attempt them; if an answer would require one, say so instead.`;

/** Denial text returned by the tool dispatcher for non-read tools. Mirrors
 * kimi's TOOL_CALL_DISABLED_MESSAGE but names the read-only carve-out. */
export const SIDE_CHAT_TOOL_DENIED =
  "This tool is disabled in the side conversation (read-only tools only). Answer from context, use a read-only tool, or tell the user the main agent would need to do it.";

/** Deep-enough copy of the parent's full message history for the side-chat
 * seed. Unlike buildForkContext (token-budgeted tail for fan-out workers),
 * a side chat wants the ENTIRE history: the whole point is answering
 * questions about anything that happened, and an exact prefix maximizes
 * the prompt-cache hit on the first call (kimi copies everything for the
 * same reason). Messages are shallow-copied per entry — engine code treats
 * ChatMessage entries as immutable once appended, matching fork.ts. */
export function buildSideChatSeed(parent: Pick<SessionState, "messages" | "skills" | "activeDeferredTools">): {
  inheritedMessages: ChatMessage[];
  inheritedSkills: SkillMetadata[];
  activeDeferredTools: string[];
} {
  return {
    inheritedMessages: parent.messages.map((m) => ({ ...m })),
    inheritedSkills: parent.skills.map((s) => ({ ...s })),
    activeDeferredTools: [...(parent.activeDeferredTools ?? [])],
  };
}
