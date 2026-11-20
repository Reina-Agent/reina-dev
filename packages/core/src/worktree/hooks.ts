/** Worktree create/remove hook protocol (P2-7 scaffold).
 *
 * Claude Code's worktree-isolation design lets users override
 * `git worktree add` / `git worktree remove` with shell commands
 * declared in settings.json. The intent is to support non-git VCS
 * (Pijul, Mercurial via Vendi, Sapling) without baking each one into
 * the engine.
 *
 * This module declares the hook config shape and the runtime-friendly
 * accessors. Wiring it through `createWorktree` is deferred to a
 * follow-up commit so this PR stays focused on extracting the worktree
 * directory + landing the fast-resume / structured-changes / sparse
 * primitives. Until then, the engine continues to invoke `git`
 * subprocesses directly. */

/** Shape of a single worktree hook entry in settings.json.
 *
 * Example (settings.json):
 *   "hooks": {
 *     "worktreeCreate": {
 *       "command": "/usr/local/bin/pijul-worktree-add",
 *       "args": ["${TASK_ID}", "${BASE_REV}"]
 *     },
 *     "worktreeRemove": {
 *       "command": "/usr/local/bin/pijul-worktree-rm",
 *       "args": ["${WORKTREE_PATH}"]
 *     }
 *   }
 *
 * The runtime substitutes `${TASK_ID}`, `${BASE_REV}`, `${WORKTREE_PATH}`
 * before exec'ing. STDOUT line 1 is expected to be the new worktree
 * absolute path (for `worktreeCreate`); non-zero exit aborts dispatch. */
export interface WorktreeHookConfig {
  command: string;
  args?: ReadonlyArray<string>;
  /** Environment overlay passed to the hook subprocess. Useful for
   * pointing the VCS shim at workspace-specific credentials. */
  env?: Readonly<Record<string, string>>;
  /** Wall-clock cap. Defaults to 30s; long hooks should run async out
   * of band rather than blocking dispatch. */
  timeoutMs?: number;
}

export interface WorktreeHooksConfig {
  worktreeCreate?: WorktreeHookConfig;
  worktreeRemove?: WorktreeHookConfig;
}

/** Cheap accessor: do we have a create hook configured? Returns false
 * when config is undefined / empty. Currently consulted nowhere — the
 * wiring through createWorktree is queued for a follow-up commit. */
export function hasWorktreeCreateHook(config: WorktreeHooksConfig | undefined): boolean {
  return !!config?.worktreeCreate?.command;
}

export function hasWorktreeRemoveHook(config: WorktreeHooksConfig | undefined): boolean {
  return !!config?.worktreeRemove?.command;
}

/** Substitute the supported placeholders in an arg template. Pulled
 * out as a pure function so the test suite can pin the substitution
 * contract without invoking a real subprocess. */
export function expandHookArg(
  template: string,
  vars: { taskId?: string; baseRev?: string; worktreePath?: string },
): string {
  return template
    .replace(/\$\{TASK_ID\}/g, vars.taskId ?? "")
    .replace(/\$\{BASE_REV\}/g, vars.baseRev ?? "")
    .replace(/\$\{WORKTREE_PATH\}/g, vars.worktreePath ?? "");
}
