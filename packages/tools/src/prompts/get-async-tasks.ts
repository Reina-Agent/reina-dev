export const description = [
  "Read async-subagent state without blocking. Choose `detail`: `headers` for a compact roster, `activity` for live status/activity, or `full` for complete results/errors plus aggregate usage.",
  "Pass `taskRefs` to target task ids or assigned names; omit it to read the session roster. To block until workers settle, use `wait_async_tasks` instead.",
].join("\n");
