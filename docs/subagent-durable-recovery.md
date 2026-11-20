# Subagent Durable Recovery Design

## Status

Implemented baseline. Schema v4 now stores durable recovery metadata, task
events, attempts, subagent edges, and a DB-backed `update_async_task` queue.

This document defines the mature recovery model for Reina subagents when the
desktop window is closed, the renderer reconnects, the agent host exits, or the
whole application restarts.

## Implementation Snapshot

Current implementation is intentionally Reina-native rather than a copy of
Codex's Rust `state_db`:

- `async_tasks` remains the live query projection used by the sidebar and tool
  responses. Schema v5 also stores `snapshot_json` so full task metadata can be
  rebuilt, not just the query columns.
- `async_task_events` records append-only lifecycle evidence.
- `async_task_attempts` records each fresh child session attempt for the same
  durable task.
- `subagent_edges` records parent task to child session links, including
  superseded attempts.
- `async_task_updates` persists `update_async_task` messages as FIFO rows with
  leases, so queued supervisor updates survive host boundaries when SQLite is
  available.
- `SubagentReconciler` merges rollout/session state with the DB projection,
  rebuilds projection from event snapshots, and classifies stale process-local
  attempts without pretending a lost child is still live.
- In-memory child engines are still process-local. A process restart creates a
  fresh child attempt only after recovery classification and lease acquisition.

Not implemented by design: serialization of active JavaScript promises, model
streams, or a running child engine. Those are not safely resumable state.

## Problem

Reina supports background subagents through async task tools. A user can close
the window while subagents are running and later expect the task to continue.
There are two different cases:

1. The UI window closed, but the agent host process is still alive.
2. The agent host process died or the app restarted.

Only the first case can be reattached to the original in-memory child engine.
The second case cannot resume the old process. It must reconstruct the task
from durable state and start a fresh child attempt.

The recovery system must make that distinction explicit. It must never pretend
that a lost child engine is still running.

## Principle

A subagent is not a persistent process. A subagent is a durable task. Each live
child engine is only one attempt to execute that task.

```text
durable task
  -> attempt 1: child engine in process A
  -> attempt 2: fresh child engine after restart
  -> attempt 3: manual retry after worktree repair
```

The durable task owns identity, lifecycle, audit history, worktree ownership,
and recovery policy. A process-local child engine owns only the currently active
execution attempt.

## Source Of Truth

Use layered authority. Do not give every storage path equal weight.

1. `async_task_events`: append-only task ledger. This is the authoritative task
   lifecycle record.
2. `rollout JSONL`: model-visible conversation and task history. This is the
   authoritative source for reconstructing prompts.
3. Worktree and filesystem: authoritative source for code and file changes.
4. `stream.jsonl`: UI activity replay. Useful for user visibility, not a
   critical decision source.
5. In-memory `children` registry: only proves that a child engine is alive in
   the current process.

`state_db` should store the ledger, projections, leases, and indexes. It should
not try to serialize a child engine, JavaScript promises, active streams, or
model internal state.

## Non-Goals

- Do not checkpoint and restore a running JavaScript or model process.
- Do not infer task completion from an orphaned task.
- Do not automatically keep writing code after restart unless safety gates pass.
- Do not treat `stream.jsonl` as the authoritative lifecycle record.
- Do not delete subagent worktrees as part of recovery classification.

## Durable State Model

### Task Projection

`async_tasks` is the current projection used by sidebars, filters, and fast
status checks.

Recommended fields:

```text
id                  text primary key
parent_session_id   text not null
child_session_id    text
agent               text not null
description         text not null
status              text not null
recovery_status     text
attempt_count       integer not null default 0
resume_count        integer not null default 0
worktree_path       text
worktree_branch     text
worktree_head       text
rollout_path        text
stream_path         text
last_heartbeat_at   text
lease_owner         text
lease_expires_at    text
last_error          text
created_at          text not null
updated_at          text not null
snapshot_json       text
```

The projection can be rebuilt from `async_task_events`. If projection and event
ledger disagree, reconciliation should repair the projection from the ledger.

### Event Ledger

`async_task_events` is append-only.

Recommended fields:

```text
id            text primary key
task_id       text not null
type          text not null
payload_json  text not null
created_at    text not null
```

Important event types:

```text
task.created
task.started
task.heartbeat
task.stream_observed
task.updated_by_parent
task.interrupted
task.timeout
task.stale
task.orphaned
task.recovery_checked
task.recoverable
task.needs_attention
task.resume_started
task.resume_attached
task.completed
task.failed
task.cancelled
task.abandoned
task.archived
```

### Attempts

Each fresh child engine run is an attempt. Attempts make retries auditable and
prevent a resumed child from overwriting the old run's identity.

Recommended `async_task_attempts` fields:

```text
id                text primary key
task_id           text not null
child_session_id  text
worker_id         text not null
status            text not null
started_at        text not null
heartbeat_at      text
completed_at      text
error             text
```

## State Machine

```text
queued
  -> running

running
  -> completed
  -> failed
  -> cancelled
  -> stale
  -> timed_out
  -> orphaned

orphaned
  -> recovering

recovering
  -> recoverable
  -> needs_attention
  -> failed_unrecoverable

recoverable
  -> resuming
  -> abandoned
  -> archived

needs_attention
  -> recoverable
  -> abandoned
  -> archived

resuming
  -> running
  -> needs_attention
  -> failed

completed, failed, cancelled, failed_unrecoverable, abandoned, archived
  -> terminal
```

State meanings:

| State | Meaning |
| --- | --- |
| `running` | A live child engine exists in this process, or a valid external lease exists. |
| `orphaned` | Durable state said running, but no live child engine can be found. |
| `recovering` | The reconciler is classifying the orphaned task. |
| `recoverable` | Required recovery material exists and the task can be resumed safely. |
| `needs_attention` | Recovery may be possible, but user or supervisor input is required. |
| `resuming` | A worker acquired the lease and is starting a fresh child attempt. |
| `failed_unrecoverable` | Required recovery material is missing or invalid. |

## Reconciliation

Run reconciliation at these boundaries:

- App start.
- Workspace open.
- Session load.
- Renderer reconnect.
- Before auto-resume.
- Before archive or cleanup.

Algorithm:

```text
1. Rebuild task projection from async_task_events.
2. Merge legacy session.asyncTasks records into the projection if needed.
3. For every task in running or resuming:
   a. If children registry has a live child, mark reattached.
   b. Otherwise append task.orphaned and set status=orphaned.
4. For every orphaned task:
   a. Check parent session exists and is not archived.
   b. Check rollout_path exists and can be parsed.
   c. Check worktree_path if present.
   d. Check profile still exists.
   e. Check tool permissions and approval state.
   f. Check retry and stale limits.
5. Classify:
   a. recoverable
   b. needs_attention
   c. failed_unrecoverable
6. Emit stream events so UI updates from the same durable state.
```

Reconciliation must be idempotent. Running it twice should not create duplicate
child attempts or duplicate terminal outcomes.

## Lease And Duplicate Prevention

Only one process may transition a task from `recoverable` to `resuming`.

Use compare-and-swap semantics:

```sql
UPDATE async_tasks
SET status = 'resuming',
    lease_owner = ?,
    lease_expires_at = ?,
    updated_at = ?
WHERE id = ?
  AND status = 'recoverable'
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at < ?
  );
```

Only the caller that observes `rowsAffected = 1` may start a fresh child engine.

The fresh child attempt must heartbeat. If the process dies, the lease expires
and reconciliation can classify the task again.

Lease rules:

- `lease_owner` should include process id plus a random boot id.
- `lease_expires_at` should be short enough to recover from crashes.
- Heartbeat writes should append `task.heartbeat` only when there is meaningful
  progress or enough time has passed.
- Terminal states must clear the lease.

## Recovery Safety Gates

Do not auto-resume writing work unless all gates pass.

Required gates:

1. Parent session exists and is not archived.
2. Task is `recoverable`.
3. Lease acquisition succeeds.
4. Worktree exists when the task used worktree isolation.
5. Worktree is a valid git worktree.
6. Worktree branch and HEAD match the recorded task metadata, or mismatch is
   classified as `needs_attention`.
7. No pending approval is unresolved.
8. No pending question is unresolved.
9. Agent profile exists.
10. Effective tool permissions are not unexpectedly broader than before.
11. The task has not exceeded resume count or repeated stale/timeout limits.
12. The task is not already terminal according to the event ledger.

If any gate fails, set `needs_attention` or `failed_unrecoverable` with a
specific reason. Do not silently continue.

## Recovery Prompt Contract

Fresh child attempts must receive a recovery prompt that prevents hidden-state
assumptions.

Required sections:

```text
[RECOVERY]
Your previous child engine is gone. You are a fresh child attempt for the same
durable task. Do not assume any hidden memory from the previous attempt.

[ORIGINAL BRIEF]
...

[SUPERVISOR MESSAGE]
...

[RECOVERY MATERIAL]
- parent session id
- task id
- previous attempt count
- rollout summary or relevant history
- worktree path and health
- last known activity summary
- last known error or interruption reason

[FIRST ACTIONS]
1. Inspect the worktree.
2. Inspect git status and diff.
3. Compare visible evidence to the original brief.
4. Continue only from evidence that exists on disk or in durable history.

[RULES]
- Do not claim completion without concrete evidence.
- Do not overwrite unrelated work.
- If required context is missing, report the gap instead of guessing.
```

If fork context cannot be rebuilt, include:

```text
[FORK CONTEXT LOST]
This task was originally launched with inherited parent context. That context
cannot be reconstructed. You are running as a standalone subagent. Ask for
missing specifics instead of assuming them.
```

## UI Behavior

The Agent Team UI should expose the true lifecycle.

Recommended labels:

| UI Label | Backing State |
| --- | --- |
| Running | `running` with live child |
| Reattached | `running` after renderer reconnect |
| Disconnected | checking live child / lease |
| Recoverable | `recoverable` |
| Needs attention | `needs_attention` |
| Resuming | `resuming` |
| Unrecoverable | `failed_unrecoverable` |

Recoverable task actions:

```text
Continue
Continue with instruction
View activity
View worktree diff
Abandon
Archive
```

Needs-attention task actions depend on reason:

```text
Resolve approval
Answer pending question
Open worktree
Repair path
Continue anyway
Abandon
Archive
```

The UI should never display an orphaned task as simply running. If the live
child is gone, show the recoverability status.

## Window Close Versus Process Restart

### Renderer Window Close

If only the renderer window closes:

1. Keep the child engine running in the agent host.
2. Continue writing task events, rollout records, and stream records.
3. On renderer reconnect:
   - load session snapshot
   - replay `stream.jsonl`
   - subscribe to live stream
   - mark UI as reattached

No resume prompt is needed because the original child engine is still alive.

### Agent Host Restart

If the agent host exits:

1. Child engines are lost.
2. On next load, reconciliation marks stale `running` tasks as `orphaned`.
3. Recovery checks classify them.
4. The task becomes `recoverable`, `needs_attention`, or
   `failed_unrecoverable`.
5. A user or supervisor can start a fresh child attempt.

This path must not pretend the original child continued.

## Cleanup Policy

Worktree cleanup must be explicit and conservative.

Rules:

- Do not delete worktrees during orphan classification.
- Do not delete recoverable worktrees automatically.
- Allow cleanup only for terminal tasks after a retention period.
- Require stronger retention for tasks with uncommitted changes.
- Log cleanup as `task.worktree_cleaned`.
- Provide a UI path to archive or abandon before cleanup.

## Migration Plan

The current system already has `session.asyncTasks`, `recoverStaleOnLoad`, and
subagent stream replay. Migration preserves compatibility by writing new
durable state in parallel with the existing rollout/session task projection.

Implemented: phases 1 through 3, projection rebuild from event snapshots, the
durable parent-update queue, and load-time reconciliation. Phase 4 is partially
implemented for status display. Phase 5 remains deliberately opt-in future
work.

Phase 1: Ledger introduction

- Add `async_task_events`.
- Write events in parallel with existing `session.asyncTasks`.
- Add projection rebuild tests.

Phase 2: Reconciler

- Add a `SubagentReconciler`.
- Rebuild projection on session load.
- Classify orphaned tasks without auto-resume.

Phase 3: Lease and attempts

- Add `async_task_attempts`.
- Add compare-and-swap lease acquisition.
- Convert resume path to create a fresh attempt.

Phase 4: UI

- Surface `recoverable`, `needs_attention`, and `resuming`.
- Add activity replay and worktree diff actions.

Phase 5: Controlled auto-resume

- Add opt-in auto-resume policy.
- Enforce safety gates.
- Add telemetry and failure counters.

## Test Matrix

Core tests:

- Renderer closes and reopens while the agent host stays alive.
- Activity replay reconstructs visible subagent output after reconnect.
- Agent host is killed while a child is running.
- Restart classifies the task as `orphaned`, then `recoverable`.
- Resume creates a fresh child attempt and reuses the worktree.
- Resume prompt includes original brief, interruption reason, and worktree
  health.
- Worktree missing becomes `needs_attention` or `failed_unrecoverable`.
- Invalid worktree branch becomes `needs_attention`.
- Pending approval blocks auto-resume.
- Pending question blocks auto-resume.
- Fork context loss is surfaced in prompt and UI.
- Lease prevents two processes from resuming the same task.
- Lease expiry allows recovery after a second crash.
- Repeated stale or timeout does not loop forever.
- Terminal tasks are never resumed automatically.
- DB projection corruption can be repaired from the event ledger.
- Archive parent session handles descendant tasks deterministically.
- Worktree cleanup never removes uncommitted recoverable work without explicit
  abandonment or retention policy.

## Success Criteria

The implementation is mature when these statements are true:

- Closing and reopening the window never loses visible subagent activity.
- Restarting the app never misrepresents a lost child engine as still running.
- Recoverable work is preserved and clearly resumable.
- Unrecoverable work explains exactly what is missing.
- Duplicate fresh child attempts cannot be started by races.
- The model cannot claim recovered work is complete without evidence.
- Worktrees with partial work are protected from accidental cleanup.
- The task ledger can explain every lifecycle transition after the fact.
