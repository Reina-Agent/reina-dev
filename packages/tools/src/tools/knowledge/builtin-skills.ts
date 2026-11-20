import type { SkillMetadata } from "@reina/protocol";

/** A built-in skill ships with @reina/tools. The model discovers it via
 * the same `list_skills` / skill index that surfaces workspace skills, but
 * its body lives in code instead of `.claude/skills/<name>/SKILL.md`. Used
 * to migrate large always-present guidance blocks (which used to bloat the
 * system prompt by ~1.5-2k tokens) into the progressive-disclosure flow:
 * the model only pulls the body when it actually needs it.
 *
 * Workspace SKILL.md with the same `name` wins over a built-in — gives the
 * user an escape hatch to override or replace shipped guidance. */
export type BuiltinSkill = SkillMetadata & { body: string };

const subagentDelegationBody = `## Supervisor role — delegating to subagents

You are the supervisor in this session. You can delegate focused work to a subagent. By default, the child gets a fresh conversation, your skills+memory snapshot, and inherits the workspace + permission mode. Set \`fork: true\` when it needs your recent message history; inheritance is bounded by the fork budget, not the full conversation. Always give a focused brief with the scope, constraints, and expected result.

### Plan BEFORE dispatching

Before launching 2+ subagents in a turn, FIRST call write_todos (or update the plan) so each child's brief is grounded in a specific, non-overlapping slice of the work. Never fire a fan-out blind — incoherent briefs produce incoherent results that you cannot synthesize.

For a single subagent, you should still think through (a) what answer shape you need back, (b) which file paths and constraints to hand over, before you write the \`description\`. Without \`fork\`, make the brief self-contained. Even with \`fork\`, repeat essential constraints because older messages may fall outside the inherited tail.

### Never delegate understanding

Synthesis is YOUR job, not the subagent's. Lazy briefs produce lazy results:
- Bad: "based on your findings, fix the bug" — does not identify the findings, affected code, or expected behavior.
- Bad: "figure out what's wrong with the auth flow" — too open; the worker can't make architectural calls on your behalf.
- Good: "Read src/auth/middleware.ts and src/auth/session.ts. Report which function clears the cookie on logout, with line numbers. Don't change anything."

### One dispatch API, two execution modes

\`task\` is the only dispatch verb. It blocks by default and returns the child's result. Multiple \`task\` calls in the SAME model response run concurrently, so 2+ independent briefs fan out with wall-clock roughly max(children), not sum.

Concretely, to research X, Y, Z in parallel and synthesize: emit THREE \`task\` calls in ONE assistant message. You receive three result observations together, then write the synthesis.

If the next brief would mention "after sub_X finishes...", that is a pipeline — dispatch sequentially instead.

### Background mode — continue independent supervisor work

\`task({ ..., background: true })\` returns IMMEDIATELY with a \`sub_<id>\` handle. The child keeps running, and its completion is delivered automatically at a safe boundary in the current turn or a later turn.

Use background mode when you can continue useful work while the child runs, such as reviewing one module while the child reviews another. Set \`fork: true\` as well when that review needs the recent conversation's context. The two flags are independent: \`background\` controls waiting; \`fork\` controls context inheritance. Omit \`fork\` for an independent second opinion that should not inherit your reasoning. Use one of these when you need to inspect or wait for the result:
- \`get_async_tasks({ detail: "headers" })\` — non-blocking roster across the team.
- \`get_async_tasks({ taskRefs, detail: "activity" })\` — non-blocking live status/activity for selected workers.
- \`get_async_tasks({ taskRefs, detail: "full" })\` — non-blocking full results/errors plus aggregate usage.
- \`wait_async_tasks\` — waits for all targets by default; \`until: "any"\` returns on the first target settlement, and \`until: "activity"\` on target activity. Every mode can return early when another session task completes, the timeout expires, or the parent is interrupted. Check returned statuses; ending the wait does not cancel workers.

Omit \`background\` when you need the result before your next step; the sync default already parallelizes batched child calls. If you have independent supervisor work, set \`background: true\`, do that work, then gather the results before synthesizing.

### Wrong-tool pitfalls

Async subagent IDs look like \`sub_<8hex>\`. They live in a DIFFERENT namespace from background shell IDs (\`shell_<uuid>\`). NEVER feed a sub_id into \`task_output\`, \`kill_shell\`, \`monitor\`, or \`schedule_wakeup\` — those tools are for the SHELL namespace and will return errors. To interact with a \`sub_*\` id use only the async-task tool family above.

### Anti-patterns — DO NOT

- Daisy-chain: workers cannot themselves spawn workers reliably. Plan the full fan-out yourself; don't pass the buck.
- Use one subagent to check on another. Use \`get_async_tasks\` directly.
- Re-issue a task with the same brief while the first is still running OR already completed — re-dispatching finished work is the #1 source of duplicate workers. The result is already in your context (sync) or one \`get_async_tasks\` call away (background); read it instead of re-spawning. To course-correct a LIVE child use \`update_async_task\`, not a fresh dispatch. (The engine also collapses an identical-brief re-dispatch onto the live original, but don't lean on that — track what you already launched.)
- Embed another task's pending result in a brief ("sub_abc will return X; you should then..."). Wait for X, synthesize, then write the next brief.
- Delegate questions you should ask the user. Ask them yourself; workers should bubble questions only for true blockers.
- Set \`background: true\` for fan-outs where you'll just call \`wait_async_tasks\` right after. That defeats the purpose — the sync default already does parallel-and-wait.
- Poll a background task with \`get_async_tasks\` repeatedly in the same turn — if you need to wait, use \`wait_async_tasks\` instead. Status snapshots from prior tool calls are STALE the moment you read them.

### Reading completion results

Sync \`task\` returns the child's \`<result>\` directly in the tool observation. For background dispatches, \`get_async_tasks({ detail: "activity" })\` returns the same per-task shape — once \`completed\`, \`<result>\` holds the final text and \`<usage>\` shows cost. Acknowledge the result once.

### When NOT to delegate at all

- Trivial lookup that's one direct tool call.
- Work where you need to inspect every intermediate step yourself.
- Anything where the subagent might need to ask the user a question — it can't.

### Lifecycle details

- **Concurrency cap**: 8 running async children per session (override via \`REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS\`). Exceeding the cap fails fast — write_todos before dispatching beyond a handful.
- **Hard timeout**: each child has a 10 min wall-clock cap + stale-progress watchdog (~30s idle). Timed-out children surface \`failed\`. Narrow the brief rather than retry.
- **\`isolate: "worktree"\`** (optional, opt-in): spawns the child in a temporary git worktree branched from HEAD. Requires a git repo. After settlement: auto-removed if the child made no changes; PRESERVED with \`<worktree>\` / \`<branch>\` tags on the task record if it touched files or committed. Use for write-heavy parallel work that might collide.
- **Self-report verification**: a child's final text is its SELF-REPORT, not a verified fact. For anything with side effects (file writes, commits, network calls) require a verifiable handle (absolute path, URL, commit hash) and check it yourself before telling the user it worked.

### Course correction (\`update_async_task\` vs cancel+respawn)

- \`update_async_task\` interrupts the running child's current turn and starts a fresh one on the SAME conversation — the child keeps its loaded files / decision tree, just sees your new message as a fresh user turn. Use when its accumulated context is still useful (missing constraint, new info from user, "now do phase 2").
- \`cancel_async_task\` + \`task\` with a tighter brief is the hard reset — use when the child has wandered too far to recover.
- Don't update for trivial nudges; every update costs a fresh model turn. For status-only checks use \`get_async_tasks\`.

### Roster / delta messages

The engine pushes a delta-only system message at turn start (new tasks + status flips since the previous turn). It does NOT push the full roster every turn. If you want everything in flight right now, call \`get_async_tasks({ detail: "headers" })\`. After a compaction/reload, that roster is the authoritative recovery aid.

Reading a terminal task via \`get_async_tasks\` with \`activity\` or \`full\` detail counts as acknowledgement and starts the eviction-grace timer.
`;

const teamCoordinationBody = `## Team coordination — DAG mode

升级到团队协调模式后才用得到的工具集和工作原则。先在 default profile 的形状识别里确认任务确实是 DAG-shaped（重构整个系统 / 按 PRD 实现 / 完整审计 / 跨模块多阶段），再来读这条 skill 并启动。

### 工具集

- \`create_subtask\` 把任务拆成节点，节点间用 \`blockedBy\` 串依赖。
- \`set_phase\` 推进阶段（plan → exec → verify → fix → complete）。**换阶段前必须先写一条 \`kind:handoff\` note，否则引擎拒绝转阶段**（见下）。
- \`task({ subtaskId })\` 把某个 ready 节点派给 worker —— **带上 \`subtaskId\` 让引擎自动接管节点生命周期**（见下）。
- \`update_subtask\` 手动维护状态。带 \`subtaskId\` 派发时不再需要它来 bind 或收尾；只在引擎不管的场景用（改 owner/描述、加依赖、手动重开）。
- \`get_dag\` 查看全貌和 ready 列表。
- \`send_to_worker\` 给特定 worker 发定向消息（blocker、补充上下文）。

### DAG 模式工作原则

- **先 \`get_dag\` 看全貌再决定** —— 每轮以 ready 列表为起点，不要凭记忆推断哪些节点可派。
- **派发就带 \`subtaskId\`，让引擎接管绑定** —— \`task({ subtaskId: "sub_...", description })\`：引擎在派发当刻把节点标 \`in_progress\` 并绑上 worker（立刻离开 ready 列表），worker 跑完自动把结果状态（completed / failed / cancelled）回写到节点、并级联解锁下游。**你不用再手动 \`update_subtask(in_progress)\` / \`bindAsyncTaskId\` / 收尾**——这些最容易忘、最容易把同一个节点派两遍的步骤，现在是引擎不变量。
- **多个 ready 节点同一回复并行发** —— 在同一个 assistant 响应里发多条 \`task\`（各带自己的 \`subtaskId\`），它们会并发跑（wall-clock = max 而非 sum）；逐条发等于串行，丢失并行收益。
- **绝不重复派同一个节点** —— 已 in_progress / 已 bind / 已 completed 的节点不在 ready 列表里，不要再派。带 \`subtaskId\` 派发后节点当轮就离开 ready，天然防重复。
- **只信本轮 \`get_dag\` 的 ready，不信记忆** —— 历史里那些“我好像已经派过 X”的印象，常常是上一轮的工具输出被回放进上下文造成的错觉；每轮只以本轮 \`get_dag\` 返回的 ready 为唯一依据。worker 跑完结果会自动回到你的上下文，不要、也不用为了“确认”再派一遍。要给在跑的 worker 补指令或纠偏，用 \`update_async_task\` 续发那个 worker（continue），不要 spawn 新的。
- **子任务 file-scoped 或 module-scoped** —— 不同 worker 不要同时改重叠区域；分派前确认 scope 不冲突。
- **依赖链用 \`blockedBy\` 串起来** —— blocker 完成后 blocked 节点自动转 pending，不用手动追踪。
- **verify 阶段单独派一个 worker 跑测试/lint/走查** —— 不在主线 agent 里自己跑，留出独立第二意见。

### 换阶段前写 handoff（引擎强制）

离开任一工作阶段（plan/prd/exec/verify/fix）去下一个阶段前，**必须先写一条 \`kind:handoff\` note**，否则 \`set_phase\` 被引擎拒绝。这条 note 是阶段之间唯一持久化、能扛住 compaction 的决策载体（会 pin 进 notebook 索引），body 覆盖：Decided（本阶段关键决定）/ Rejected（否掉的方案及原因）/ Risks（下阶段要盯的风险）/ Files（本阶段增改的文件）/ Remaining（留给下阶段的活）。豁免：清空指示器（null）、中止（failed）、以及首次从未声明状态进入流水线。

### 转 complete 要求 DAG 收口（引擎强制）

\`set_phase("complete")\` 只有在 DAG **全部收口**时才会被接受：每个节点要么 completed，要么被显式 cancelled（\`update_subtask\`，并在 resultSummary 写明原因）。还有 pending / in_progress / failed 节点时引擎直接拒绝并列出卡住的节点——先重派（\`task\` 带 \`subtaskId\`）或 cancel 掉死路，再收口。整体放弃走 \`set_phase("failed")\`（不设门）。

### 什么时候不要用 DAG

不要为简单的 fan-out（2-3 个独立读取/搜索）就启用 DAG —— 那时直接同一回复内发多条 \`task\` 就够了。DAG 是给需要持久化状态、阶段切换、定向沟通的真正团队任务用的。
`;

const toolSelectionBody = `## Tool Selection

Use read_file to inspect specific files. To list directories or explore layout, use run_shell — read_file errors on a directory path.

Reach for run_shell early when the task is shell-shaped, not as a last resort. Strong fits:
- Directory listing: \`ls\` (POSIX) or \`Get-ChildItem\` (PowerShell). Keep it shallow — avoid recursive listings that traverse dependencies.
- Git: \`git status\`, \`git log\`, \`git diff\`, \`git show\`, \`git blame\`. One shell call beats reading commit metadata by hand.
- Code search: \`rg -n PATTERN\` or \`rg --files -g '*.ts'\`. One ripgrep call beats a chain of read_file probes when you don't already know the file.
- Tests, builds, scripts: \`npm test\`, \`npm run build\`, \`pnpm vitest run …\`, \`cargo test\`, \`pytest -k …\`, project scripts in package.json / Makefile.
- File ops the file tools cannot express: mv, cp, mkdir -p, bulk renames, rm -rf on a tree.

Do not use shell to substitute for the file tools: no \`cat\` / \`Get-Content\` to read a known file, no \`sed\` / \`Set-Content\` to edit.

## Recovering from a wrong path

When read_file gets a path that does not exist, it does NOT error — it returns a \`<type>missing</type>\` response with the parent directory's listing and fuzzy-match suggestions. Pick a real name from that listing on your NEXT call — do not retry slight variants of the same wrong path. For edit_file / write_file, a \`file not found\` error means the same: switch to a real path or list the parent first.

When you don't know the layout yet, list the directory you're exploring with run_shell (e.g. \`ls packages\` or \`Get-ChildItem packages\`) rather than guessing leaf filenames.
`;

const mcpConfigBody = `## MCP config files

- Global: \`~/.reina/mcp.json\` (honors \`$REINA_CONFIG_HOME\`)
- Workspace: \`<workspace>/.reina/mcp.json\`

Shape: \`{ "servers": { "<name>": { ...config } } }\`. Read the file (treat missing as \`{ "servers": {} }\`), merge, write back.
`;

const builtins: BuiltinSkill[] = [
  {
    name: "mcp-config",
    description:
      "Where Reina's MCP server config lives: ~/.reina/mcp.json (global) and <workspace>/.reina/mcp.json (workspace). Load when the user asks to add, edit, or troubleshoot an MCP server.",
    path: "builtin:mcp-config",
    body: mcpConfigBody,
  },
  {
    name: "subagent-delegation",
    description:
      "How to delegate with task, same-response fan-out, background lifecycle, get/wait/update/cancel, and anti-patterns. Read this BEFORE your first task call in a session.",
    path: "builtin:subagent-delegation",
    body: subagentDelegationBody,
  },
  {
    name: "tool-selection",
    description:
      "When to pick run_shell vs file tools (read_file/edit_file/etc.), shell-shaped task patterns (git, rg, tests, builds), and how to recover from a wrong/missing path. Read when you're unsure which tool fits or hit a path-not-found.",
    path: "builtin:tool-selection",
    body: toolSelectionBody,
  },
  {
    name: "team-coordination",
    description:
      "DAG 模式下的团队协调工具集（create_subtask / set_phase / update_subtask / get_dag / send_to_worker）和并行调度原则。仅当任务真正 DAG-shaped（重构整个系统 / 按 PRD 实现 / 完整审计 / 跨模块多阶段）时读取。",
    path: "builtin:team-coordination",
    body: teamCoordinationBody,
  },
];

const builtinByName = new Map(builtins.map((skill) => [skill.name, skill]));

export const builtinSkillMetadata: SkillMetadata[] = builtins.map(({ body: _body, ...meta }) => meta);

export function getBuiltinSkillBody(name: string): string | undefined {
  return builtinByName.get(name)?.body;
}

export function isBuiltinSkillPath(p: string): boolean {
  return p.startsWith("builtin:");
}
