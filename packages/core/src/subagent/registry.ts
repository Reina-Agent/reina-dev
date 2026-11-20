import type { AsyncTaskRecord, SessionState } from "@reina/protocol";

/** Name-handle resolution for async subagent tasks.
 *
 * The supervisor may attach a human-readable `name` to a task at
 * start_async_task time. Subsequent check / update / cancel calls
 * accept either the raw `task_<id>` handle or the name. This module
 * holds the bidirectional resolution logic in one place so the manager
 * doesn't sprinkle "is it an id or a name" branches throughout.
 *
 * Names are stored on AsyncTaskRecord.name and therefore persist across
 * the rollout log, so a supervisor can still address a worker by name
 * after compaction removed the original dispatch tool call. */

/** Reserved prefix used by minted task ids. Names starting with this
 * would be ambiguous with raw ids, so we forbid them. */
const TASK_ID_PREFIX = "sub_";

export type NameValidationResult = { ok: true } | { ok: false; error: string };

/** Validate a candidate name. Constraints:
 *   - non-empty after trim
 *   - 1..64 chars
 *   - ASCII letters, digits, dash, underscore, dot
 *   - must NOT start with `sub_` (ambiguous with raw ids)
 *   - must NOT already be in use by another active/recoverable task in
 *     the session (caller passes session.asyncTasks for the check).
 *     Terminal tasks (completed / failed / cancelled /
 *     failed_unrecoverable, plus legacy evicted) DO NOT reserve their
 *     name; long sessions accumulate finished work and locking those
 *     names forever forces awkward suffix-bumping that triggered model
 *     loops in real usage. `resolveTaskRef` still finds terminal tasks
 *     by name, so `check_async_task("auth-reviewer")` after settlement
 *     keeps working until the sweep evicts the record. */
export function validateName(
  candidate: string,
  existing: ReadonlyArray<AsyncTaskRecord>,
): NameValidationResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { ok: false, error: "name must not be empty" };
  if (trimmed.length > 64) return { ok: false, error: "name must be 64 chars or fewer" };
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return { ok: false, error: "name may only contain letters, digits, dot, dash, underscore" };
  }
  if (trimmed.startsWith(TASK_ID_PREFIX)) {
    return { ok: false, error: `name must not start with "${TASK_ID_PREFIX}" (collides with raw task ids)` };
  }
  if (existing.some((task) => task.name === trimmed && ["running", "resuming", "recoverable", "needs_attention", "orphaned"].includes(task.status))) {
    return {
      ok: false,
      error: `name "${trimmed}" is already in use by another active task in this session`,
    };
  }
  return { ok: true };
}

/** Resolve a supervisor-supplied reference to the actual task id. The
 * supervisor may pass either the raw `task_<short>` id or the name they
 * assigned at start time. Returns undefined when neither matches.
 *
 * Resolution order: exact id match first (cheaper, more common), then
 * name. This matters when a name happens to look id-like — though
 * validateName forbids `sub_` prefixes precisely to keep this
 * unambiguous. */
export function resolveTaskRef(
  ref: string,
  session: Pick<SessionState, "asyncTasks">,
): AsyncTaskRecord | undefined {
  const tasks = session.asyncTasks ?? [];
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const byId = tasks.find((task) => task.id === trimmed);
  if (byId) return byId;
  return tasks.find((task) => task.name === trimmed);
}
