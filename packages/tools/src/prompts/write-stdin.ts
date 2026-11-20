export const description = [
  "Write text to the stdin of a BACKGROUND SHELL task (taskId `shell_<uuid>` from run_shell). Use this to answer interactive prompts (y/n, a password, a REPL expression) or to feed data to a process that reads from stdin.",
  "",
  "A trailing newline is appended by default — most prompts need it to submit; set `appendNewline: false` for raw bytes. Set `closeStdin: true` to send EOF when the process reads until end-of-input.",
  "",
  "Only RUNNING tasks accept input. After writing, read what the process emitted with `task_output`, or wait for a specific line with `monitor`.",
].join("\n");
