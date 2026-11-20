export const description = [
  "Read accumulated stdout/stderr from a BACKGROUND SHELL task started by run_shell with `runInBackground: true` (or auto-backgrounded). The taskId is `shell_<uuid>` returned by run_shell.",
  "",
  "SHELL namespace only — async subagent IDs (`sub_<...>`) do NOT belong here; use `get_async_tasks` / `wait_async_tasks` for those.",
  "",
  "Returns immediately (polling). To block until the process exits, set `block: true` + `timeoutMs` (default 30000). For \"wait until a specific line appears\" use `monitor` — push-based and cheaper.",
  "A blocking wait also returns early when a related task event arrives. Check `<wake_reason>` and `<status>`: `task_event` means process the notification, and does not mean the command you were waiting on has finished. A wait timeout does not kill the command.",
  "",
  "Output: `<status>` (+ `<exit_code>` once it exits), then `<stdout>` / `<stderr>` — only the streams that have content. Buffers cap at ~256KB; older bytes drop silently.",
].join("\n");
