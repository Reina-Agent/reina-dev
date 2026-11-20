export const description = [
  "Snapshot the subtask DAG. Returns every node as JSON plus a derived `ready` list (subtasks whose blockedBy is fully resolved and still pending), and — when present — a `stalled` list: in_progress nodes whose bound worker task is no longer live (e.g. lost to a process restart).",
  "",
  "Use before spawning: dispatch each ready node with `task({ subtaskId })` — the engine marks it in_progress, binds the worker, and mirrors the worker's terminal status back onto the node automatically (no manual `update_subtask` bind/close needed).",
  "Handle `stalled` nodes the same turn you see them: resume via `update_async_task`, re-dispatch via `task` with the subtaskId (re-binds), or settle the node via `update_subtask`.",
].join("\n");
