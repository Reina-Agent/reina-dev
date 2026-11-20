import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileP, worktreePathFor } from "./git.js";

/** Probe whether a worktree directory already exists on disk and, if so,
 * read its current HEAD SHA cheaply (no subprocess fork) by following the
 * `.git` pointer file that `git worktree add` writes.
 *
 * Claude Code's worktree-isolation doc cites this optimization: skipping
 * fetch + `git worktree add` when the directory is already there cuts
 * "resume" latency from seconds to milliseconds on large repos.
 *
 * Returns:
 *   - `null` when the worktree directory doesn't exist, or the HEAD ref
 *     can't be resolved cheaply (in which case the caller should fall
 *     back to a full `git worktree add` path).
 *   - `{ path, headSha }` when the worktree is ready to reuse.
 *
 * Note: the SHA returned is the worktree's CURRENT HEAD, which may have
 * advanced past the original baseSha if the previous run committed work.
 * For determining whether the worktree is dirty vs. clean, pair this
 * with `worktree/changes.ts`. */
export async function tryFastResumeWorktree(
  parentCwd: string,
  taskId: string,
): Promise<{ path: string; headSha: string } | null> {
  const dir = worktreePathFor(parentCwd, taskId);
  // Probe directory existence first — open/read on a missing path is
  // slower than stat because it has to walk lookup errors.
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return null;

  // git worktree's .git is a pointer FILE (not a dir) of the form:
  //   gitdir: /path/to/parent/.git/worktrees/<taskId>
  // Resolve it to find the actual HEAD ref, then read the SHA from there.
  const head = await readWorktreeHead(dir);
  if (!head) {
    // Fall back to git subprocess if pointer-file resolution failed — the
    // worktree might still be valid even if our cheap path didn't work.
    const sub = await execFileP("git", ["-C", dir, "rev-parse", "HEAD"]).catch(() => null);
    if (!sub) return null;
    return { path: dir, headSha: sub.stdout.trim() };
  }
  return { path: dir, headSha: head };
}

/** Read the HEAD SHA by following the worktree's `.git` pointer file
 * down to the worktree-specific gitdir and reading the `HEAD` ref. Pure
 * file I/O, no subprocess. Returns null on any unexpected shape. */
async function readWorktreeHead(worktreeDir: string): Promise<string | null> {
  try {
    const pointer = await readFile(path.join(worktreeDir, ".git"), "utf8");
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    const gitdir = match[1]!;
    const headRef = await readFile(path.join(gitdir, "HEAD"), "utf8");
    const trimmed = headRef.trim();
    if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed;
    // Symbolic ref ("ref: refs/heads/...") — resolve one level by
    // reading the named ref file.
    const refMatch = trimmed.match(/^ref:\s*(.+)$/);
    if (!refMatch) return null;
    const refPath = path.join(gitdir, "..", "..", refMatch[1]!);
    const refContent = await readFile(refPath, "utf8");
    const sha = refContent.trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}
