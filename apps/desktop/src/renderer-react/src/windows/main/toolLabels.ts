// Single source of truth for humanized tool names. BOTH the committed-transcript
// projection (timelineProjection.toolLabel) and the live ToolCard (toolVerb) read
// this map, so a tool can't read nicely in one path and as its raw id ("task_output",
// "Call update_subtask") in the other. Add a tool here once, not in two places.
//
// Note: a handful of core tools (run_shell, read_file, edit_file, write_file,
// patch, grep/glob) are special-cased EARLIER in both callers with context-
// specific phrasing, so they never reach this map — that's why this favors the
// long tail (coordination / subagent / bookkeeping tools).
export const TOOL_LABELS: Record<string, string> = {
  run_shell: "Ran",
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  multi_edit: "Edited",
  apply_patch: "Patched",
  list_files: "Listed",
  glob: "Searched",
  grep: "Searched",
  code_search: "Searched",
  git_status: "git status",
  git_diff: "git diff",
  repo_overview: "Repo overview",
  task: "Task",
  task_output: "Task output",
  kill_shell: "Kill shell",
  monitor: "Monitor",
  write_todos: "Todos",
  plan: "Plan",
  exit_plan_mode: "Submit plan",
  question: "Question",
  compact_conversation: "Compact",
  list_skills: "List skills",
  read_skill: "Read skill",
  web_fetch: "Web fetch",
  mcp_list_resources: "MCP resources",
  mcp_read_resource: "MCP read",
  notify: "Notify",
  schedule_wakeup: "Schedule wakeup",
  start_async_task: "Launch subagent",
  get_async_tasks: "Inspect subagents",
  check_async_task: "Check subagent",
  cancel_async_task: "Cancel subagent",
  list_async_tasks: "List subagents",
  update_subtask: "Update subtask",
  add_subtask: "Add subtask",
  get_subtask: "Get subtask",
  list_subtasks: "Subtasks",
  get_dag: "Team DAG",
  set_phase: "Set phase",
  note: "Note",
  search_java_gadgets: "Java gadgets",
  find_java_chains: "Java chains",
  tool_group: "Tools",
};

/** Humanized label for a tool id, falling back to the raw id when unknown. */
export function humanToolName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
