import { z } from "zod";
import { engineHandledExecute } from "../../engine-handled.js";
import type { ToolImplementation } from "../../types.js";
import { description as writeTodosDescription } from "../../prompts/write-todos.js";
import { description as taskDescription } from "../../prompts/task.js";
import { description as recallMemoryChunkDescription } from "../../prompts/recall-memory-chunk.js";
import { description as listMemoryChunksDescription } from "../../prompts/list-memory-chunks.js";
import { description as questionDescription } from "../../prompts/question.js";
import { description as planDescription } from "../../prompts/plan.js";
import { description as startAsyncTaskDescription } from "../../prompts/start-async-task.js";
import { description as checkAsyncTaskDescription } from "../../prompts/check-async-task.js";
import { description as cancelAsyncTaskDescription } from "../../prompts/cancel-async-task.js";
import { description as updateAsyncTaskDescription } from "../../prompts/update-async-task.js";
import { description as listAsyncTasksDescription } from "../../prompts/list-async-tasks.js";
import { description as searchMemoryDescription } from "../../prompts/search-memory.js";
import { description as consolidateMemoryDescription } from "../../prompts/consolidate-memory.js";
import { description as waitAsyncTasksDescription } from "../../prompts/wait-async-tasks.js";
import { description as gatherAsyncTasksDescription } from "../../prompts/gather-async-tasks.js";
import { description as getAsyncTasksDescription } from "../../prompts/get-async-tasks.js";

const subagentTaskInputSchema = z.object({
  description: z.string().min(1).describe("Self-contained brief for the subagent's first turn."),
  agent: z.string().optional().describe("Agent profile name (e.g. default, summary). Defaults to 'default'."),
  isolate: z.enum(["none", "worktree"]).optional().describe("File isolation strategy. Defaults to 'none' (shares parent cwd). Pass 'worktree' to branch a temp git worktree; preserved if the child made changes, auto-removed when clean."),
  background: z.boolean().optional().describe("If true, return immediately with the task id so the supervisor can continue independent work. Defaults to false, which blocks until completion or the foreground budget expires. Independent of fork; both may be true."),
  name: z.string().min(1).max(64).optional().describe("Optional unique handle (1-64 chars, [A-Za-z0-9._-]) accepted by get/update/cancel tools in place of the task id. Do not set one for ordinary fan-out."),
  fork: z.boolean().optional().describe("If true, inherit the supervisor's recent message tail within the fork budget, skills, and deferred-tool set. This does not include the full history or enable background mode. Forks cannot spawn another fork. Defaults to false; keep false for an independent review."),
  skill: z.string().min(1).optional().describe("Skill name whose model/effort frontmatter should override the child session. Unknown names are ignored."),
  subtaskId: z.string().min(1).optional().describe("Team-mode DAG node id. The engine binds it on dispatch and mirrors the worker's terminal outcome back to the node."),
}).passthrough();

const subagentTaskExamples = [
  {
    description: "Focused worker; block and return its result",
    input: { description: "Find every call site of `parseConfig` and list file:line locations." },
  },
  {
    description: "Inherit context for a code review while the supervisor reviews a separate module",
    input: {
      description: "Review packages/providers for tool-schema and message token budgeting, using our agreed context. Preserve cache-prefix stability. Read source and return at most two findings with file:line evidence. Do not edit files, write notes, start services, or commit. I will review packages/core while you work.",
      background: true,
      fork: true,
    },
  },
  {
    description: "Isolated worktree child for a risky refactor",
    input: {
      description: "Refactor the Notes module from class-based to functional composition. Run tests after.",
      isolate: "worktree",
    },
  },
];

export const writeTodosTool: ToolImplementation = {
  descriptor: {
    name: "write_todos",
    description: writeTodosDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().min(1, "content must not be empty").describe("Imperative form describing the task ('Run tests', 'Build the project')."),
            activeForm: z.string().min(1, "activeForm must not be empty (present-continuous form, e.g. 'Running tests')").describe("Present-continuous form shown while the task is in progress ('Running tests', 'Building the project')."),
            status: z.enum(["pending", "in_progress", "completed"]).optional().describe("Defaults to 'pending'. Keep exactly one task as 'in_progress' at a time; mark complete IMMEDIATELY after finishing."),
          }),
        )
        .describe("Ordered todo list. Passing a new list REPLACES the current one — include all items every time, not just the deltas."),
    }),
    examples: [
      {
        description: "Initialize a fresh plan with three steps, the first one in progress",
        input: {
          todos: [
            { content: "Read README.md", activeForm: "Reading README.md", status: "in_progress" },
            { content: "Inspect package.json", activeForm: "Inspecting package.json" },
            { content: "Run npm test", activeForm: "Running npm test" },
          ],
        },
      },
      {
        description: "Update progress: mark step 1 done, advance step 2",
        input: {
          todos: [
            { content: "Read README.md", activeForm: "Reading README.md", status: "completed" },
            { content: "Inspect package.json", activeForm: "Inspecting package.json", status: "in_progress" },
            { content: "Run npm test", activeForm: "Running npm test" },
          ],
        },
      },
    ],
  },
  execute: engineHandledExecute("write_todos"),
};

export const taskTool: ToolImplementation = {
  descriptor: {
    name: "task",
    description: taskDescription,
    permission: "state",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: subagentTaskInputSchema,
    examples: subagentTaskExamples,
  },
  execute: engineHandledExecute("task"),
};

// Phase B compaction offload — `recall_memory_chunk` + `list_memory_chunks`.
// Exposure is "deferred": the engine adds them to the live tool array only
// when REINA_COMPACTION_OFFLOAD=1 AND the session has any chunks. With the
// feature off, these stay out of every model call → zero overhead.
export const recallMemoryChunkTool: ToolImplementation = {
  descriptor: {
    name: "recall_memory_chunk",
    description: recallMemoryChunkDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Recall the full content of one offloaded conversation chunk by id (e.g. c_007).",
    inputSchema: z.object({
      id: z.string().min(1).describe("Chunk id from the 'Offloaded memory' index, e.g. `c_007`."),
    }),
  },
  execute: engineHandledExecute("recall_memory_chunk"),
};

export const listMemoryChunksTool: ToolImplementation = {
  descriptor: {
    name: "list_memory_chunks",
    description: listMemoryChunksDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "List every offloaded-memory chunk in the current session (with topic + token count).",
    inputSchema: z.object({}),
  },
  execute: engineHandledExecute("list_memory_chunks"),
};

export const searchMemoryTool: ToolImplementation = {
  descriptor: {
    name: "search_memory",
    description: searchMemoryDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Keyword-search all sessions' history, offloaded chunks, and note indexes; hits carry recall pointers.",
    inputSchema: z.object({
      query: z.string().min(1).describe("1-3 concrete keywords (identifiers, filenames, error strings). Bare words AND together; \"quoted phrase\" matches exactly."),
      maxResults: z.number().int().min(1).max(30).optional().describe("Per-source hit cap. Defaults to 12."),
    }),
  },
  execute: engineHandledExecute("search_memory"),
};

export const consolidateMemoryTool: ToolImplementation = {
  descriptor: {
    name: "consolidate_memory",
    description: consolidateMemoryDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Fetch briefs of sessions since the last consolidation, to fold durable facts into the global notebook.",
    inputSchema: z.object({}),
  },
  execute: engineHandledExecute("consolidate_memory"),
};

export const questionTool: ToolImplementation = {
  descriptor: {
    name: "question",
    description: questionDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      question: z
        .string()
        .optional()
        .describe(
          "SINGLE-shape form: the question text. End with '?'. Pair with optional `options` for a picker, or omit to get free-text. Use this OR `questions` — not both. When `questions` is also set, this top-level field is ignored.",
        ),
      header: z
        .string()
        .optional()
        .describe(
          "Short chip/tag label rendered above the question (e.g. 'Auth method', 'Library'). Max ~12 chars. Optional.",
        ),
      options: z
        .array(
          z.object({
            label: z.string().describe("Short option text the user sees and selects (1-5 words)."),
            description: z
              .string()
              .optional()
              .describe("One-line explanation of what the option means or what happens if chosen."),
            preview: z
              .string()
              .optional()
              .describe(
                "Monospace block rendered next to the focused option. Use for side-by-side code snippets, ASCII mockups, or diff samples — anything where seeing the artifact helps the user choose.",
              ),
          }),
        )
        .optional()
        .describe(
          "Picker options for the single-shape form. Add 2-4 entries to render a single- or multi-select UI; omit for free-text. The user's answer comes back as the joined `label`(s).",
        ),
      multiSelect: z
        .boolean()
        .optional()
        .describe(
          "When true, the user can pick more than one option; the answer is the labels joined by ', '. Defaults to false (single-select). Only meaningful with `options`.",
        ),
      questions: z
        .array(
          z.object({
            question: z.string().describe("This question's text. End with '?'."),
            header: z.string().optional().describe("Optional short tag/chip above this question."),
            options: z
              .array(
                z.object({
                  label: z.string().describe("Option label (1-5 words)."),
                  description: z.string().optional().describe("One-line option explanation."),
                  preview: z.string().optional().describe("Monospace preview block (for code/mockup/diff)."),
                }),
              )
              .optional()
              .describe("Picker options for THIS question. Omit for free-text."),
            multiSelect: z
              .boolean()
              .optional()
              .describe("Multi-select for this question only. Defaults to false."),
          }),
        )
        .min(1)
        .max(4)
        .optional()
        .describe(
          "BATCH-shape form: 1-4 questions rendered together with a single Submit button and a single round-trip back. Use this OR the top-level single-shape fields — not both. When set, the top-level question/options/multiSelect/header are ignored.",
        ),
    }),
    examples: [
      {
        description: "Single free-text question (no picker)",
        input: { question: "What's the name of the new feature flag you want to add?" },
      },
      {
        description: "Single-select picker with descriptions",
        input: {
          question: "Which auth method should we wire up?",
          header: "Auth method",
          options: [
            { label: "OAuth (Recommended)", description: "Industry standard; works with GitHub/Google out of the box." },
            { label: "Session cookies", description: "Simpler, but requires sticky sessions on the LB." },
            { label: "API tokens", description: "For machine-to-machine only; not for end users." },
          ],
        },
      },
      {
        description: "Multi-select — answer comes back as joined labels",
        input: {
          question: "Which test types should the CI matrix cover?",
          multiSelect: true,
          options: [
            { label: "unit", description: "Vitest packages/**" },
            { label: "integration", description: "Hits real DB + MCP servers" },
            { label: "e2e", description: "Electron + Playwright" },
            { label: "type-check", description: "tsc --noEmit across workspace" },
          ],
        },
      },
      {
        description: "Visual comparison via `preview` — useful when picking between two implementations",
        input: {
          question: "Which retry strategy?",
          options: [
            {
              label: "Exponential backoff",
              description: "100ms, 200ms, 400ms…",
              preview: "delay = base * 2^attempt\nmax 5 retries",
            },
            {
              label: "Fixed interval",
              description: "1s between each retry",
              preview: "delay = 1000\nmax 3 retries",
            },
          ],
        },
      },
      {
        description: "Batch — two related questions in one card",
        input: {
          questions: [
            {
              question: "Where should the new schema live?",
              options: [
                { label: "packages/protocol/src/index.ts" },
                { label: "packages/tools/src/types.ts" },
              ],
            },
            {
              question: "Default test runner?",
              options: [{ label: "vitest" }, { label: "node:test" }],
            },
          ],
        },
      },
    ],
  },
  execute: engineHandledExecute("question"),
};

export const planTool: ToolImplementation = {
  descriptor: {
    name: "plan",
    description: planDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      content: z
        .string()
        .describe("Markdown plan body. Replaces any prior plan content. Spell out the approach the user is meant to approve — file paths, key decisions, risk callouts. Keep it scannable; numbered steps work well."),
      status: z
        .enum(["draft", "approved"])
        .optional()
        .describe("Defaults to 'draft' on first write. Use 'approved' only after the user has explicitly accepted the plan (typically via exit_plan_mode)."),
    }),
    examples: [
      {
        description: "Initial draft for the user to review",
        input: {
          content: "1. Add field-level describes to all tool schemas\n2. Synthesize examples for MCP catalog entries\n3. Run npm test and verify 529/529 green",
        },
      },
      {
        description: "Mark a plan approved after user accepts it",
        input: {
          content: "(same content as before)",
          status: "approved",
        },
      },
    ],
  },
  execute: engineHandledExecute("plan"),
};

// ─── Async subagent (agent team) tools ──────────────────────────────────────
//
// `task` is the canonical dispatch API. The older dispatch/read names below
// remain registered as internal compatibility aliases so persisted rollouts
// and stale model calls can still execute without re-advertising them.

export const startAsyncTaskTool: ToolImplementation = {
  descriptor: {
    name: "start_async_task",
    description: startAsyncTaskDescription,
    permission: "state",
    requiresApproval: false,
    internal: true,
    // Concurrency-safe so the engine batches multiple start_async_task
    // calls in one model response via Promise.all — that's how parallel
    // fan-out works under the default-sync behavior: each call blocks on
    // its own child, but all calls race concurrently inside the batch.
    concurrencySafe: true,
    inputSchema: subagentTaskInputSchema,
    examples: subagentTaskExamples,
  },
  execute: engineHandledExecute("start_async_task"),
};

export const checkAsyncTaskTool: ToolImplementation = {
  descriptor: {
    name: "check_async_task",
    description: checkAsyncTaskDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    internal: true,
    inputSchema: z.object({
      taskId: z.string().min(1).describe("The task_<id> returned by start_async_task, OR the `name` you assigned at start time (e.g. 'auth-reviewer'). Either form works."),
    }),
  },
  execute: engineHandledExecute("check_async_task"),
};

export const cancelAsyncTaskTool: ToolImplementation = {
  descriptor: {
    name: "cancel_async_task",
    description: cancelAsyncTaskDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Stop a running async subagent task (idempotent).",
    inputSchema: z.object({
      taskId: z.string().min(1).describe("The task_<id> or the assigned `name` (either form works)."),
    }),
  },
  execute: engineHandledExecute("cancel_async_task"),
};

export const updateAsyncTaskTool: ToolImplementation = {
  descriptor: {
    name: "update_async_task",
    description: updateAsyncTaskDescription,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Steer a running async subagent, resume a recoverable one, or re-open a settled task with a follow-up question.",
    inputSchema: z.object({
      taskId: z.string().min(1).describe("The sub_<id> returned by task, OR the assigned `name`. Either form works."),
      message: z.string().min(1).describe("Instruction or question for the subagent. Running task: interrupts and re-prompts (course-correction). Settled (completed/failed/cancelled) task still in the roster: re-opens it — a fresh child sees the original brief, the previous outcome, and this message, then auto-reports back."),
    }),
  },
  execute: engineHandledExecute("update_async_task"),
};

export const listAsyncTasksTool: ToolImplementation = {
  descriptor: {
    name: "list_async_tasks",
    description: listAsyncTasksDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    internal: true,
    exposure: "deferred",
    catalogSummary: "Roster headers of all async tasks this session has started (no bodies).",
    inputSchema: z.object({}),
  },
  execute: engineHandledExecute("list_async_tasks"),
};

export const waitAsyncTasksTool: ToolImplementation = {
  descriptor: {
    name: "wait_async_tasks",
    description: waitAsyncTasksDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({
      taskIds: z
        .array(z.string().min(1))
        .optional()
        .describe("Specific task IDs to wait on. Omit to wait on every currently-running or resuming async task in this session."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(1_800_000)
        .optional()
        .describe("Maximum time to block before returning whatever snapshot is current. Defaults to 600000 (10 minutes). Range: 1000..1800000."),
      until: z
        .enum(["terminal", "any", "activity"])
        .optional()
        .describe("\"terminal\" (default): wait for all watched tasks to settle. \"any\": return when any watched task settles. \"activity\": return on a watched task's stream event or status change. Every mode can return early for a pending session task completion or parent interruption; check the returned statuses. Interrupting the wait does not cancel workers."),
    }),
  },
  execute: engineHandledExecute("wait_async_tasks"),
};

export const sendTaskMessageTool: ToolImplementation = {
  descriptor: {
    name: "send_task_message",
    description:
      "Send a message to another LIVE worker task running under the same supervisor (sibling-to-sibling channel, parent-mediated). " +
      "The target's current turn is interrupted and it restarts with your message, attributed to you. " +
      "Only available inside a subagent worker — the supervisor steers workers with update_async_task instead. " +
      "Use for handoffs and blocking coordination (\"I finished the schema, your migration can start\"); for broadcast or non-urgent context, write a directed note instead.",
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Worker→worker: push a message to a sibling task (interrupts it so it reacts now).",
    inputSchema: z.object({
      taskRef: z.string().min(1).describe("The sibling's task_<id> or assigned name (see the roster your supervisor shared, or list_notes)."),
      message: z.string().min(1).describe("What the sibling needs to know or do. Be specific — it arrives as a new instruction in their session."),
    }),
  },
  execute: engineHandledExecute("send_task_message"),
};

export const startTaskBatchTool: ToolImplementation = {
  descriptor: {
    name: "start_task_batch",
    description:
      "Fan out one background worker per item with a bounded concurrency window (batch analog of task({background:true})). " +
      "Items are dispatched maxConcurrent at a time; as workers settle, the next items launch automatically. " +
      "Returns a batch_id + the dispatched task ids immediately. Poll progress with check_task_batch; block with wait_async_tasks({taskIds}); read bodies with get_async_tasks({taskRefs, detail:\"full\"}). " +
      "Use for repetitive per-item work (audit N files, migrate N call sites) — not for heterogeneous tasks that deserve individually-tuned briefs.",
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Fan out one background worker per item (bounded concurrency); returns batch_id.",
    inputSchema: z.object({
      items: z.array(z.string().min(1)).min(1).max(200).describe("One entry per worker (a file path, a call site, a question…). Each becomes {item} in briefTemplate, or the whole brief when briefTemplate is omitted."),
      briefTemplate: z.string().optional().describe("Brief with an {item} placeholder, e.g. \"Audit {item} for injection bugs; report findings as bullet points.\" Omit to use each item verbatim as the brief."),
      agent: z.string().optional().describe("Agent profile for every worker (default: \"default\")."),
      maxConcurrent: z.number().int().min(1).max(8).optional().describe("Concurrency window (default 4). The global async-subagent cap still applies on top."),
      isolate: z.enum(["none", "worktree"]).optional().describe("\"worktree\" gives each worker an isolated git worktree (use when workers WRITE files in parallel). Default \"none\"."),
    }),
  },
  execute: engineHandledExecute("start_task_batch"),
};

export const checkTaskBatchTool: ToolImplementation = {
  descriptor: {
    name: "check_task_batch",
    description:
      "Progress snapshot for a start_task_batch fan-out: per-status counts, still-queued item count, and a one-line outcome per settled worker. " +
      "Batch queue state is in-memory — after an engine restart, already-dispatched workers survive as normal tasks but undispatched items are dropped (the snapshot says so).",
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Batch progress: counts + per-worker outcomes for a start_task_batch id.",
    inputSchema: z.object({
      batchId: z.string().min(1).describe("The batch_<id> returned by start_task_batch."),
    }),
  },
  execute: engineHandledExecute("check_task_batch"),
};

export const gatherAsyncTasksTool: ToolImplementation = {
  descriptor: {
    name: "gather_async_tasks",
    description: gatherAsyncTasksDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    internal: true,
    inputSchema: z.object({
      taskIds: z
        .array(z.string().min(1))
        .optional()
        .describe("Specific task IDs to gather. Omit to gather every task in this session."),
    }),
  },
  execute: engineHandledExecute("gather_async_tasks"),
};

export const getAsyncTasksTool: ToolImplementation = {
  descriptor: {
    name: "get_async_tasks",
    description: getAsyncTasksDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({
      taskRefs: z
        .array(z.string().min(1))
        .optional()
        .describe("Task ids or assigned names. Omit to read the session roster."),
      detail: z
        .enum(["headers", "activity", "full"])
        .describe("`headers`: compact roster; `activity`: live status/activity; `full`: complete results/errors and aggregate usage."),
    }),
    examples: [
      { description: "Recover the current worker roster", input: { detail: "headers" } },
      { description: "Inspect two live workers", input: { taskRefs: ["sub_a1b2c3d4", "reviewer"], detail: "activity" } },
      { description: "Read completed bodies", input: { taskRefs: ["sub_a1b2c3d4"], detail: "full" } },
    ],
  },
  execute: engineHandledExecute("get_async_tasks"),
};
