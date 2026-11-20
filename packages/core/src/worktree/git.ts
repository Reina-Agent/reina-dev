import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);

/** Branch-name convention for subagent worktrees. Keeping `reina/sub/`
 * as the prefix lets workspace tooling (graphs, prune jobs, code review
 * filters) recognize these as engine-managed and treat them differently
 * from human-created branches. */
export function worktreeBranchFor(taskId: string): string {
  return `reina/sub/${taskId}`;
}

/** Filesystem location of a worktree under `<parent>/.reina/worktrees/`. */
export function worktreePathFor(parentCwd: string, taskId: string): string {
  return path.join(parentCwd, ".reina", "worktrees", taskId);
}

/** Tear down a previously-created worktree. Uses --force so an unclean
 * working tree doesn't block cleanup; we don't preserve in-progress edits
 * past task settlement (the agent's writes are already serialized into the
 * branch's commits or the task result text). */
export async function removeWorktree(parentCwd: string, worktreePath: string): Promise<void> {
  await execFileP("git", ["-C", parentCwd, "worktree", "remove", "--force", worktreePath]);
}
