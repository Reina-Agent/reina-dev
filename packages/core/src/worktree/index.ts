import { utimes } from "node:fs/promises";
import { execFileP, worktreeBranchFor, worktreePathFor } from "./git.js";
import { tryFastResumeWorktree } from "./fast-resume.js";

/** Spawn a temporary git worktree branched from the parent cwd's HEAD,
 * OR resume an existing one on disk (fast-resume path — skips fetch +
 * worktree-add when the directory is already there from a previous run).
 *
 * The worktree lives under `<parent>/.reina/worktrees/<taskId>/` and is
 * paired with a fresh branch `reina/sub/<taskId>` so its history is
 * clearly attributable. Throws if the parent cwd isn't a git repo. */
export async function createWorktree(parentCwd: string, taskId: string): Promise<{ path: string; branch: string; baseSha: string; reused?: boolean }> {
  const branch = worktreeBranchFor(taskId);
  // Fast-resume: if the worktree directory already exists on disk
  // (cross-restart resume path from P1-6), just return its current
  // HEAD without re-running `git worktree add` — that command would
  // fail on the existing branch anyway.
  const resumed = await tryFastResumeWorktree(parentCwd, taskId);
  if (resumed) {
    // Refresh the worktree dir's mtime: we are actively resuming it for a live
    // child. The cross-session orphan sweep reaps worktrees by a 24h-age
    // heuristic, and fast-resume is otherwise pure reads — without this touch a
    // >24h-old worktree being resumed here still looks abandoned to a concurrent
    // sibling session's sweep and could be `rm -rf`'d under the running child.
    const now = new Date();
    await utimes(resumed.path, now, now).catch(() => undefined);
    return { path: resumed.path, branch, baseSha: resumed.headSha, reused: true };
  }
  const dir = worktreePathFor(parentCwd, taskId);
  await execFileP("git", ["-C", parentCwd, "worktree", "add", "-b", branch, dir, "HEAD"]);
  // Capture the SHA the branch was created at so teardown can detect
  // whether the child added commits beyond this point.
  const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "HEAD"]);
  return { path: dir, branch, baseSha: stdout.trim() };
}

export { removeWorktree, worktreeBranchFor, worktreePathFor } from "./git.js";
export { countWorktreeChanges, worktreeHasChanges } from "./changes.js";
export type { WorktreeChangeCounts } from "./changes.js";
export { tryFastResumeWorktree } from "./fast-resume.js";
export { applySparseCheckout } from "./sparse.js";
export {
  expandHookArg,
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  type WorktreeHookConfig,
  type WorktreeHooksConfig,
} from "./hooks.js";
