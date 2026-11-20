export const description = [
  "Wait for all targeted async tasks to settle, then return their current results. Omit `taskIds` to watch every running or resuming task. Use `until: any` for the first target settlement or `until: activity` for target activity. Pending session task completions and parent interruption can end any wait early; inspect the returned statuses. Interrupting the wait leaves workers running.",
  "Use `get_async_tasks` when you want a non-blocking headers/activity/full snapshot. NEVER use `task_output` or `schedule_wakeup` for subagent waits — those are for background SHELL / autonomous loops.",
].join("\n");
