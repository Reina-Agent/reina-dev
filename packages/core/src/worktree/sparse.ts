import { execFileP } from "./git.js";

/** Sparse-checkout helper for monorepo worktrees.
 *
 * Large monorepos (200k+ files) make full-tree worktree creation slow
 * even with the fast-resume optimization, because `git worktree add`
 * still materializes every tracked file. Sparse checkout lets a
 * subagent's worktree see only a subset of the tree — typically the
 * service or package directory the supervisor briefed it on.
 *
 * Usage:
 *   await createWorktree(...);
 *   await applySparseCheckout(wt.path, ["apps/desktop/", "packages/core/"]);
 *
 * Pass an empty / undefined path list and this is a no-op (full
 * checkout stays in place). The function is best-effort — failures
 * surface as a returned `false` so the caller can degrade to a full
 * checkout rather than aborting the dispatch. */
export async function applySparseCheckout(
  worktreePath: string,
  sparsePaths: ReadonlyArray<string> | undefined,
): Promise<boolean> {
  if (!sparsePaths || sparsePaths.length === 0) return true;
  const normalized = sparsePaths.map((p) => p.trim()).filter((p) => p.length > 0);
  if (normalized.length === 0) return true;
  try {
    // `git sparse-checkout init --cone` enables cone mode (the
    // performant variant that matches whole directories). Cone mode
    // is the right default — `--no-cone` is only needed for negative
    // pattern matching that subagent worktrees don't use.
    await execFileP("git", ["-C", worktreePath, "sparse-checkout", "init", "--cone"]);
    await execFileP("git", ["-C", worktreePath, "sparse-checkout", "set", ...normalized]);
    return true;
  } catch {
    return false;
  }
}
