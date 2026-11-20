import type { ToolName } from "@reina/protocol";
import { toolNames } from "@reina/protocol";

const toolAliases: Record<string, ToolName> = {
  read: "read_file",
  readfile: "read_file",
  read_file: "read_file",
  write: "write_file",
  writefile: "write_file",
  write_file: "write_file",
  edit: "edit_file",
  editfile: "edit_file",
  edit_file: "edit_file",
  multiedit: "multi_edit",
  multi_edit: "multi_edit",
  applypatch: "apply_patch",
  apply_patch: "apply_patch",
  bash: "run_shell",
  shell: "run_shell",
  terminal: "run_shell",
  run: "run_shell",
  runcommand: "run_shell",
  run_command: "run_shell",
  runshell: "run_shell",
  run_shell: "run_shell",
  taskoutput: "task_output",
  task_output: "task_output",
  killshell: "kill_shell",
  kill_shell: "kill_shell",
  todos: "write_todos",
  writetodos: "write_todos",
  write_todos: "write_todos",
  todo_write: "write_todos",
  ask: "question",
  ask_question: "question",
  question: "question",
  plan: "plan",
  task: "task",
  listskills: "list_skills",
  list_skills: "list_skills",
  readskill: "read_skill",
  read_skill: "read_skill",
  fetch: "web_fetch",
  webfetch: "web_fetch",
  web_fetch: "web_fetch",
  mcp_list_resources: "mcp_list_resources",
  mcp_read_resource: "mcp_read_resource",
};

/** Tracks objects that `parseToolJson` produced via the raw-fallback path
 * (both JSON.parse AND repairTruncatedJson failed). Providers check this
 * to mark `ModelToolCall.parseFailed`, so the engine can short-circuit
 * with a clear "your JSON was unparseable" observation instead of letting
 * the tool fail downstream with a confusing "missing required field". */
const parseFallbackObjects = new WeakSet<object>();

export function parseToolJson(value: string): unknown {
  const clean = stripJsonFence(value || "{}").trim();
  try {
    return JSON.parse(clean || "{}");
  } catch {
    const repaired = repairTruncatedJson(clean);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired);
      } catch {
        // fall through to embedded extraction
      }
    }
    // Some models wrap the tool JSON in prose ("Sure, I'll read it: {…}") or
    // append commentary after it ("{…} done"). stripJsonFence only handles a
    // fully-fenced payload and repairTruncatedJson only handles truncation, so
    // try to pull the first balanced JSON object out of the surrounding text.
    const embedded = extractEmbeddedObject(clean);
    if (embedded !== null) return embedded;
    const fallback = { raw: value };
    parseFallbackObjects.add(fallback);
    return fallback;
  }
}

/** Pulls the first balanced, parseable JSON object out of arbitrary text by
 * scanning each `{` and matching braces with string/escape awareness. Accepts
 * only fully-closed objects (truncation is the top-level repair's job), so a
 * stray `{` in prose can never masquerade as an empty object. Returns null when
 * no `{`-rooted slice parses to an object. */
function extractEmbeddedObject(text: string): Record<string, unknown> | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchBalancedEnd(text, i);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end));
      if (isRecord(parsed)) return parsed;
    } catch {
      // not valid JSON at this `{`; keep scanning
    }
  }
  return null;
}

/** Returns the index just past the `{`...`}` (or `[`...`]`) that opens at
 * `start`, honoring nested structures and quoted strings, or -1 if the
 * structure never closes within `text`. */
function matchBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function wasJsonParseFallback(value: unknown): boolean {
  return typeof value === "object" && value !== null && parseFallbackObjects.has(value);
}

/** Deterministic best-effort repair of truncated tool-call JSON: closes
 * dangling strings, fills empty values with null, balances open braces/brackets
 * in reverse order. Returns null when the result still isn't valid JSON, so
 * the caller can fall back to `{ raw: value }`. */
export function repairTruncatedJson(input: string): string | null {
  if (!input) return null;
  const stack: ("{" | "[" | '"')[] = [];
  let escaped = false;
  let inString = false;
  let lastSignificant = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (!/\s/.test(c)) lastSignificant = i;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        stack.pop();
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      stack.push('"');
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  if (lastSignificant < 0) return null;
  let s = input.slice(0, lastSignificant + 1);
  if (/,$/.test(s)) s = s.replace(/,$/, "");
  if (/"\s*:\s*$/.test(s)) s += " null";
  if (inString) {
    s += '"';
    stack.pop();
  }
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === "{") s += "}";
    else if (top === "[") s += "]";
    else if (top === '"') s += '"';
  }
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

export function normalizeToolName(value: string): ToolName {
  if (value.startsWith("mcp__")) return value as ToolName;
  if ((toolNames as readonly string[]).includes(value)) return value as ToolName;
  const alias = toolAliases[canonicalName(value)];
  if (alias) return alias;
  throw new Error(`unknown tool from model: ${value}`);
}

export function normalizeToolInput(name: ToolName, input: unknown): unknown {
  if (typeof input === "string") return normalizeStringInput(name, input);
  if (!isRecord(input)) return input;
  switch (name) {
    case "run_shell":
      return pickFields(input, {
        command: ["command", "cmd", "shellCommand", "shell_command", "commandLine", "command_line", "raw"],
        workdir: ["workdir", "workingDirectory", "working_directory", "cwd", "directory", "dir"],
        timeoutMs: ["timeoutMs", "timeout_ms", "timeout"],
        runInBackground: ["runInBackground", "run_in_background", "background"],
      });
    case "read_file":
      return pickFields(input, {
        path: ["path", "file", "filePath", "file_path", "filename", "name", "raw"],
        offset: ["offset", "start", "startLine", "start_line", "line"],
        limit: ["limit", "maxLines", "max_lines", "lines", "count"],
      });
    case "write_file":
      return pickFields(input, {
        path: ["path", "file", "filePath", "file_path", "filename", "name"],
        content: ["content", "text", "body", "data", "raw"],
      });
    case "edit_file":
      return pickFields(input, {
        path: ["path", "file", "filePath", "file_path", "filename", "name"],
        oldText: ["oldText", "old_text", "oldString", "old_string", "old", "target"],
        newText: ["newText", "new_text", "newString", "new_string", "new", "replacement"],
        replaceAll: ["replaceAll", "replace_all", "global"],
      });
    case "multi_edit":
      return normalizeMultiEditInput(input);
    case "task_output":
      return pickFields(input, {
        taskId: ["taskId", "task_id", "id"],
        block: ["block", "wait"],
        timeoutMs: ["timeoutMs", "timeout_ms", "timeout"],
      });
    case "kill_shell":
      return pickFields(input, { taskId: ["taskId", "task_id", "id"] });
    case "apply_patch":
      return pickFields(input, { patch: ["patch", "diff", "content", "raw"] });
    case "question":
      return pickFields(input, {
        question: ["question", "prompt", "message", "content", "raw"],
        options: ["options", "choices"],
      });
    case "plan":
      return pickFields(input, {
        content: ["content", "plan", "message", "raw"],
        status: ["status"],
      });
    case "task":
      return pickFields(input, {
        description: ["description", "prompt", "task", "content", "raw"],
        agent: ["agent", "subagentType", "subagent_type", "agentType", "agent_type"],
        isolate: ["isolate", "isolation"],
        background: ["background", "runInBackground", "run_in_background"],
        name: ["name", "taskName", "task_name"],
        fork: ["fork"],
        skill: ["skill", "skillName", "skill_name"],
        subtaskId: ["subtaskId", "subtask_id"],
      });
    case "get_async_tasks": {
      const normalized = pickFields(input, {
        taskRefs: ["taskRefs", "task_refs", "taskIds", "task_ids", "taskId", "task_id"],
        detail: ["detail", "mode", "view"],
      });
      if (typeof normalized.taskRefs === "string") normalized.taskRefs = [normalized.taskRefs];
      return normalized;
    }
    case "web_fetch":
      return pickFields(input, {
        url: ["url", "uri", "href", "raw"],
        timeoutMs: ["timeoutMs", "timeout_ms", "timeout"],
      });
    default:
      return input;
  }
}

function normalizeStringInput(name: ToolName, input: string): unknown {
  switch (name) {
    case "run_shell":
      return { command: input };
    case "read_file":
      return { path: input };
    case "web_fetch":
      return { url: input };
    case "apply_patch":
      return { patch: input };
    case "question":
      return { question: input };
    case "plan":
      return { content: input };
    case "task":
      return { description: input };
    default:
      return input;
  }
}

function normalizeMultiEditInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = pickFields(input, {
    path: ["path", "file", "filePath", "file_path", "filename", "name"],
    edits: ["edits", "replacements", "changes"],
  });
  if (Array.isArray(normalized.edits)) {
    normalized.edits = normalized.edits.map((edit) =>
      isRecord(edit)
        ? pickFields(edit, {
            oldText: ["oldText", "old_text", "oldString", "old_string", "old", "target"],
            newText: ["newText", "new_text", "newString", "new_string", "new", "replacement"],
            replaceAll: ["replaceAll", "replace_all", "global"],
          })
        : edit,
    );
  }
  return normalized;
}

function pickFields(input: Record<string, unknown>, fields: Record<string, string[]>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [target, aliases] of Object.entries(fields)) {
    const value = firstDefined(input, aliases);
    if (value !== undefined) normalized[target] = normalizeValue(target, value);
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in normalized)) normalized[key] = value;
  }
  return normalized;
}

function firstDefined(input: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (input[alias] !== undefined) return input[alias];
  }
  return undefined;
}

function normalizeValue(key: string, value: unknown): unknown {
  if (["timeoutMs", "offset", "limit"].includes(key) && typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  if (["runInBackground", "replaceAll", "block"].includes(key) && typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return value;
}

function stripJsonFence(value: string): string {
  const match = value.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  return match ? match[1]! : value;
}

function canonicalName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s.]/g, "_").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
