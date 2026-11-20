import { access } from "node:fs/promises";
import path from "node:path";
import type { AsyncTaskRecord, ChatMessage, SessionState, SkillMetadata } from "@reina/protocol";

/** Cross-restart recovery for async subagent tasks.
 *
 * When the engine process dies while children are still running, the
 * AsyncTaskRecord rows survive in durable state but the in-memory
 * child engines do not. On reload, `recoverStaleOnLoad` classifies
 * those rows as `recoverable` or `needs_attention`.
 *
 * `update_async_task` against a recoverable task acquires a lease,
 * spawns a fresh child, and drives it with a resume prompt that pairs
 * the original brief with the supervisor's new message. Full child
 * conversation replay is intentionally out of scope: per-task streams
 * are observability snapshots, not authoritative state. */

/** Compose the user message handed to a freshly spawned child when
 * resuming a recoverable task. The wrapper lets the model distinguish
 * "I am continuing durable work" from "I still have hidden memory".
 *
 * When `forkContextLost` is set, the resumed task was originally a
 * fork but the manager couldn't reconstruct the inherited tail. The
 * worker runs as a plain subagent. The prompt prepends a warning so
 * the model knows the supervisor's recent context is NOT visible and
 * it should ask for any specifics it needs. */
export function buildResumePrompt(
  originalDescription: string,
  newMessage: string,
  options?: {
    forkContextLost?: boolean;
    worktreeStatus?: "preserved" | "missing" | "none";
    recoveryReason?: string;
    taskId?: string;
    attemptCount?: number;
  },
): string {
  const lines: string[] = [
    "[RESUME - your previous run was lost when the engine process restarted. The original brief is preserved below; the supervisor's new instruction follows. Re-orient first, then act.]",
  ];
  lines.unshift(
    "[RECOVERY]",
    "Your previous child engine is gone. You are a fresh child attempt for the same durable task. Do not assume hidden memory from the previous attempt.",
    "",
  );
  if (options?.taskId || typeof options?.attemptCount === "number") {
    lines.push(
      "",
      "[RECOVERY METADATA]",
      options.taskId ? `Task id: ${options.taskId}` : "",
      typeof options.attemptCount === "number" ? `Attempt: ${options.attemptCount}` : "",
    );
  }
  if (options?.recoveryReason) {
    lines.push("", "[INTERRUPTION REASON]", options.recoveryReason);
  }
  if (options?.forkContextLost) {
    lines.push(
      "",
      "[FORK CONTEXT LOST - this task was originally dispatched as a fork, meaning you used to inherit the supervisor's recent message tail. That context is no longer reachable. You are running as a standalone subagent; if you need supervisor history you must ask for it explicitly.]",
    );
  }
  if (options?.worktreeStatus === "missing") {
    lines.push(
      "",
      "[WORKTREE MISSING - the isolated git worktree from the previous run is no longer on disk. Treat the cwd as the supervisor's main checkout; do not assume in-progress work from the previous run is recoverable.]",
    );
  } else if (options?.worktreeStatus === "preserved") {
    lines.push(
      "",
      "[WORKTREE PRESERVED - the isolated git worktree from the previous run is still on disk at your cwd. Inspect it first (git status, git diff) before continuing.]",
    );
  }
  lines.push(
    "",
    "Original brief:",
    originalDescription,
    "",
    "Supervisor's new message:",
    newMessage,
    "",
    "[FIRST ACTIONS]",
    "1. Inspect the current worktree and relevant files.",
    "2. Inspect git status and git diff before editing.",
    "3. Compare visible evidence to the original brief.",
    "4. Continue only from evidence that exists on disk or in durable history.",
    "",
    "[RULES]",
    "- Do not claim completion without concrete evidence.",
    "- Do not overwrite unrelated work.",
    "- If required context is missing, report the gap instead of guessing.",
  );
  return lines.join("\n");
}

/** Compose the user message for a follow-up on a SETTLED task
 * (update_async_task against completed/failed/cancelled). Unlike the
 * recovery resume, the prior run finished cleanly and its outcome is
 * known — so the prompt pairs the original brief with that outcome and
 * the supervisor's follow-up question. The child is still a fresh engine
 * with no hidden memory of the previous run. */
export function buildFollowUpPrompt(
  prior: { description: string; status: string; result?: string; error?: string },
  newMessage: string,
  options?: { taskId?: string; attemptCount?: number },
): string {
  const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max) + "\n…[truncated]");
  const lines: string[] = [
    "[FOLLOW-UP — you are a fresh child continuing a task whose previous attempt already settled. The original brief, the previous outcome, and the supervisor's follow-up are below. You have NO hidden memory of the previous run — trust only what is written here and what you can verify on disk.]",
  ];
  if (options?.taskId) lines.push("", `Task id: ${options.taskId}`);
  if (typeof options?.attemptCount === "number") lines.push(`Attempt: ${options.attemptCount}`);
  lines.push("", "Original brief:", prior.description, "", `Previous attempt settled as: ${prior.status}`);
  if (prior.result) lines.push("", "Previous result:", clip(prior.result, 4_000));
  if (prior.error) lines.push("", "Previous error:", clip(prior.error, 1_000));
  lines.push(
    "",
    "Supervisor's follow-up:",
    newMessage,
    "",
    "Answer the follow-up. Re-verify against the working tree where the previous result matters; do not re-do work that already completed unless the follow-up asks for it.",
  );
  return lines.join("\n");
}

/** Worktree health classifier used by the resume path. `none` means
 * the original task didn't use worktree isolation. `preserved` means
 * the path exists and is accessible. `missing` means the worktree was
 * removed since the original run (manual cleanup, orphan sweep, disk
 * loss). Resume must fall back to the parent's cwd and warn the
 * model. */
export type WorktreeHealth = "none" | "preserved" | "missing";

export async function checkWorktreeHealth(worktreePath?: string): Promise<WorktreeHealth> {
  if (!worktreePath) return "none";
  try {
    await access(worktreePath);
    // Existence is the minimum bar. Verifying it's actually a worktree
    // (has .git file pointing to common dir) is a deeper check we skip:
    // a directory at this path with a stale .git pointer would still
    // let the engine spawn and the child's own git commands will fail
    // loudly. We don't want a single `git worktree list` here to gate
    // every resume.
    return "preserved";
  } catch {
    return "missing";
  }
}

/** Attempt to rebuild fork inheritance pointers from a saved
 * `forkContext` snapshot. Returns null when the snapshot is missing or
 * its referenced messages / skills are no longer present on the parent
 * (which is expected on long-lived supervisor sessions whose tail has
 * drifted). Caller treats null as "fork context lost" and degrades
 * the resume to a plain subagent run.
 *
 * Lookups are by stable id (messages) / name (skills). Neither uses
 * order, since the parent may have reordered or inserted items in the
 * intervening turns. */
export function rebuildForkContext(
  parent: Pick<SessionState, "messages" | "skills" | "activeDeferredTools">,
  saved?: AsyncTaskRecord["forkContext"],
): {
  inheritedMessages: ChatMessage[];
  inheritedSkills: SkillMetadata[];
  activeDeferredTools: string[];
} | null {
  if (!saved) return null;
  if (saved.messageIds.length === 0) return null;
  const byId = new Map(parent.messages.map((m) => [m.id, m] as const));
  const messages: ChatMessage[] = [];
  for (const id of saved.messageIds) {
    const m = byId.get(id);
    if (!m) return null;
    messages.push({ ...m });
  }
  const bySkill = new Map(parent.skills.map((s) => [s.name, s] as const));
  const skills: SkillMetadata[] = [];
  for (const name of saved.skillNames) {
    const s = bySkill.get(name);
    if (!s) continue;
    skills.push({ ...s });
  }
  // activeDeferredTools is best-effort: take the saved list intersected with what
  // parent currently has, so the child doesn't try to use a tool the
  // parent has since dropped.
  const parentDeferred = new Set(parent.activeDeferredTools ?? []);
  const activeDeferredTools = saved.activeDeferredTools.filter((t: string) => parentDeferred.has(t));
  return { inheritedMessages: messages, inheritedSkills: skills, activeDeferredTools };
}

/** Normalize a worktree path string for the health checker. Accepts
 * paths that may be absolute or relative to the supervisor's cwd. */
export function normalizeWorktreePath(supervisorCwd: string, worktreePath?: string): string | undefined {
  if (!worktreePath) return undefined;
  return path.isAbsolute(worktreePath) ? worktreePath : path.resolve(supervisorCwd, worktreePath);
}

/** True when a task is in a state that can be resumed via
 * update_async_task. `evicted` remains accepted for legacy sessions;
 * new recovery uses `recoverable`. Terminal outcomes require a fresh
 * task because their result was already returned to the
 * supervisor. */
export function isResumable(task: AsyncTaskRecord): boolean {
  return task.status === "recoverable" || task.status === "evicted";
}

/** Error message shown when the supervisor tries to update a task in a
 * state that accepts neither steering, recovery-resume, nor settled
 * follow-up (e.g. needs_attention, failed_unrecoverable, resuming).
 * Factored out so the manager and the engine's external cancel path can
 * share the wording. */
export function resumeRefusalMessage(task: AsyncTaskRecord): string {
  return `Task ${task.id} is ${task.status} - update_async_task accepts running (steer), recoverable (resume), or settled completed/failed/cancelled (follow-up) tasks. Use task to fire a fresh dispatch.`;
}
