import { execFileP } from "./git.js";

/** Detailed change counts for a worktree.
 *
 * Returned by `countWorktreeChanges`. `null` represents "I couldn't
 * determine cleanly" — the safer choice in any teardown decision is
 * then to preserve the worktree (fail-closed).
 *
 * - `uncommitted` — count of porcelain lines from `git status`.
 * - `newCommits` — number of commits on HEAD that aren't reachable from
 *   `baseSha` (the SHA captured at worktree creation). When the caller
 *   has no baseSha, this is 0. */
export interface WorktreeChangeCounts {
  uncommitted: number;
  newCommits: number;
}

/** Structured change counter. Use this when the caller wants to log
 * exactly how many files / commits are at stake (e.g. ExitWorktree's
 * "discard_changes required: 3 files, 2 commits" message). For a
 * boolean "is dirty?" check, `worktreeHasChanges` is the simpler call.
 *
 * Returns `null` on any subprocess failure — the caller MUST treat
 * that as "unknown, assume dirty" rather than silently treating it
 * as clean. Claude Code's exit path follows the same fail-closed rule
 * and is the reference for this contract. */
export async function countWorktreeChanges(
  worktreePath: string,
  baseSha: string | undefined,
): Promise<WorktreeChangeCounts | null> {
  let uncommitted = 0;
  let newCommits = 0;
  try {
    const status = await execFileP("git", ["-C", worktreePath, "status", "--porcelain"]);
    uncommitted = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return null;
  }
  if (baseSha) {
    try {
      const counted = await execFileP("git", ["-C", worktreePath, "rev-list", "--count", `${baseSha}..HEAD`]);
      const n = Number.parseInt(counted.stdout.trim(), 10);
      newCommits = Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return null;
    }
  }
  return { uncommitted, newCommits };
}

/** Boolean shorthand built on top of `countWorktreeChanges`. Preserves
 * the original `worktreeHasChanges` semantics: returns true on any
 * uncommitted file OR new commit, and ALSO returns true on any
 * subprocess failure (fail-closed → preserve work). */
export async function worktreeHasChanges(worktreePath: string, baseSha: string | undefined): Promise<boolean> {
  const counts = await countWorktreeChanges(worktreePath, baseSha);
  if (counts === null) return true;
  return counts.uncommitted > 0 || counts.newCommits > 0;
}
