export const description = [
  "Run a shell command. The working directory defaults to the workspace and may be set to a relative or absolute path. Requires user approval per call (configurable).",
  "",
  "Prefer dedicated file/search tools when they fit.",
  "",
  "Set `runInBackground: true` for servers, watchers, and GUI apps. Long-running commands may detach automatically. A detached command returns a `taskId`; use task_output, monitor, write_stdin, or kill_shell to manage it.",
  "Commands have no implicit hard timeout. Set `timeoutMs` when the process should be killed after a deadline; that deadline also applies after backgrounding. Background completion is delivered to the owning session when task notifications are available.",
  "",
  "Commands default to a POSIX shell; pass `shell` for PowerShell, cmd, bash, or sh explicitly.",
  "",
  "Set `pty: true` only for programs that require a real terminal (for example ssh, sudo, password prompts, or TUIs). PTY implies background mode and returns a `taskId`.",
  "",
  "Success returns combined stdout/stderr. Non-zero exits and timeouts include an exit marker and recovery hint.",
].join("\n");
