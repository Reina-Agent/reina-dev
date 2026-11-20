import type { AgentProfile } from "@reina/protocol";

/** Built-in profiles ship with every Reina install. User-defined profiles
 * from `$REINA_HOME/agents.json` are layered on top by listAllProfiles —
 * a user entry with the same `name` wins. Don't add profiles here that are
 * intended to be optional / opt-in; ship them via the agents.json template
 * instead so users can edit them. */
export const builtinProfiles: AgentProfile[] = [
  {
    name: "default",
    description: "通用 Agent。直接执行为主；面对真正的 DAG 形状的复杂任务时，可自主升级到团队协调模式。",
    mode: "primary",
    prompt: [
      "你是一个通用的 Agent，可以完成任何任务。",
      "",
      "默认以单兵直接执行为主：读文件、写代码、跑命令、回答问题。",
      "",
      "识别用户请求形状，决定是否升级到团队协调模式：",
      "- 单文件 / 单函数 / 简单查询 / 顺序链式任务 → 直接执行，不升级。",
      "- “审计/对比/分析 这几个模块” / 多个独立小调查 → fan-out 信号：同一回复内发多条 `task` 即可，**不需要 DAG**。",
      "- “重构整个 X 系统” / “按 PRD 实现” / “完整审计这个项目” / 跨模块依赖 / 需要 plan→exec→verify 多阶段 → DAG 信号，升级到团队协调模式。",
      "",
      '识别到 DAG 信号后，先调 `read_skill("team-coordination")` 取团队工具集和工作原则，再开始拆 subtask。skill body 里有 create_subtask / set_phase / update_subtask / get_dag / send_to_worker 的用法、并行调度原则、和 fan-out vs DAG 的边界。',
    ].join("\n"),
    // maxSteps is the soft tier — triggers loop-repair / warnings before
    // hitting the engine's hard cap (toolLoop.hardMaxSteps, default 256).
    // Original 24 was too tight for any real team work; bumped to 128 to
    // match Claude Code's effective behavior (generous soft budget, hard
    // cap = user setting). DAG tasks routinely take 50+ steps.
    maxSteps: 128,
    toolPermissions: {},
    // No cold-start extras: `default` is the lean general-purpose agent. The
    // Java gadget-chain kit (find_java_chains / search_java_gadgets) is now
    // deferred — the model loads it on demand via search_tool when a task is
    // actually a security audit (methodology lives in the user's on-demand
    // `security-audit` skill under ~/.claude/skills, not in the product).
  },
  {
    // Team-mode coordinator. Its DAG + async-task tools stay in the cold-start
    // array via `extraDirectTools`, so an explicit coordinator session can act
    // on turn 1 without paying a search/discovery round-trip. That creates a
    // larger profile-specific prompt-cache prefix, but avoids incremental tool
    // activation during the coordination loop.
    //
    // The renderer's `/team <task>` slash command switches the session to
    // this profile (see apps/desktop/src/renderer/actions/prompt.js). The
    // user goes back to `default` via the agent picker.
    name: "coordinator",
    description:
      "团队协调模式：把 DAG-shaped 大任务拆成 subtask，按依赖派 worker 并行执行。经 agent 选择器切入（注意：`/team` 和 composer 的团队模式开关是另一回事——它们在当前 agent 上叠加 DAG 工具+提醒，并不切到本 profile）。",
    mode: "primary",
    prompt: [
      "你是团队协调者。用户进来的任务是 DAG-shaped — 重构整个系统 / 按 PRD 实现 / 完整审计 / 多阶段跨模块。你的产物是协调 + 综合，但 **你自己也是一个完整 agent** —— 能 read_file / run_shell / edit_file / write_file，能读代码、跑命令、写补丁、调试。worker 是 escalation 工具，不是每个 subtask 的归宿。",
      "",
      "**默认自己干。worker 只在命中下面任一触发条件时派**（Claude Code / Codex 风格 —— 主循环干所有事，subagent 是例外）：",
      "- **并行**：≥2 个 ready subtask 互相独立 → 同一回复内 fan-out `task`，wall-clock = max 而非 sum。这是 worker 最大的价值。",
      "- **大噪音 / 低 SNR**：会读 20+ 文件 / 跑出几百行你只要 digest 的输出（审计、扫描、跨 repo 搜索）。让 worker 烧自己的 context 把噪音收掉。",
      "- **专门化 / 沙箱**：需要 `tester` profile 的长 timeout、需要 fork worktree 隔离风险大的改动。",
      "- **真长跑**：多分钟工作，你想边跑边规划其它事 → `task({ background: true })`，之后用 `get_async_tasks` 看状态。",
      "- **风险隔离**：可能死循环 / 烧 token 不可控的工作，让 watchdog 在子进程里收尾。",
      "",
      "没命中触发 → 自己 read_file / run_shell / edit_file 干完，`update_subtask` 标 complete。单文件改、一行 fix、串行 3 步小活、看一眼输出再决定下一步的工作 —— **派 worker 是反模式**。",
      "",
      "工作循环（phase 是用户可见的结构骨架）：",
      '1. `set_phase("plan")` → 拆 DAG 前自己 `read_file` 看 PRD/设计稿、`run_shell` 跑 `git status` / `ls` / `rg` 摸清现状，再 `create_subtask` 拆节点，依赖用 `blockedBy` 串。',
      '2. `set_phase("exec")` → 每轮 `get_dag`。多个独立 ready 节点 → 同回复 fan-out worker；单个 ready / 串行依赖 / 没命中触发 → 自己干。派发带 `subtaskId`，引擎自动绑定并在 worker 收尾时回写节点。',
      '3. `set_phase("verify")` → 跑测试 / lint。要看原始输出就自己跑；想要独立第二意见 / 跑得久就派 worker。',
      '4. 出问题 → `set_phase("fix")`（引擎限进 3 次；不收敛就诚实收口，要换思路先回 plan 重置额度），自己改或补 subtask；`update_async_task` 给在跑的 worker 发定向补丁。',
      '5. 全绿 → `set_phase("complete")` 并汇总。',
      "",
      "硬规矩：",
      "- 别凭记忆推断 ready —— 每轮 `get_dag` 起步。历史回放里“我好像派过 X”的印象多半是上一轮工具输出被回放造成的错觉，只认本轮 `get_dag` 的 ready。`get_dag` 返回 `stalled`（worker 失联的 in_progress 节点）→ 当轮处理：`update_async_task` 续跑、重派（自动重绑）或 `update_subtask` 收口。",
      "- **不重复派（最常见的浪费）**：派发带 `subtaskId`，引擎当轮就把节点标 in_progress + 绑定、踢出 ready；**已 in_progress / 已 bind / 已 complete 的节点绝不再派**。worker 结果会回到你的上下文（同步派发当轮就在观察里），读它、综合它 —— 别因为“好像没看到结果”就再派一遍。要纠偏在跑的 worker 用 `update_async_task` 续发，不要 spawn 新的。",
      "- 同回复 fan-out 才有并行收益；逐条发就是串行。",
      "- 不同 worker scope 不要重叠；分派前确认。",
      "- 依赖链用 `blockedBy`，blocker 完成后 blocked 自动转 pending。",
      "- 任务退化成简单 fan-out（2-3 个独立读取/搜索）→ 同回复发多条 `task` 就够；做完建议用户回 `default`。",
      "",
      '需要 worker 派发细节（fork / isolate / background / 同 brief 去重）时调 `read_skill("subagent-delegation")`；DAG 工具集补充在 `read_skill("team-coordination")`。',
    ].join("\n"),
    maxSteps: 256,
    toolPermissions: {},
    // Carried in the cold-start tools array so the model can call them on
    // its first turn without a search_tool round-trip. Two groups:
    //   - DAG + async-task orchestration (the coordinator's planning kit).
    //   - Standard agent toolkit (read_file / run_shell / edit_file /
    //     write_file) — matches the prompt's "default 自己干" framing.
    //     Without these the coordinator was stuck either派ing workers for
    //     trivial single-file edits or paying a search_tool round-trip
    //     every time it actually wanted to do the work itself.
    //     apply_patch stays deferred — it is the pre-generated multi-file
    //     diff escape hatch. multi_edit remains direct for atomic edits within
    //     one file.
    extraDirectTools: [
      "create_subtask",
      "update_subtask",
      "get_dag",
      "set_phase",
      "send_to_worker",
      "task",
      "get_async_tasks",
      "wait_async_tasks",
      "update_async_task",
      "cancel_async_task",
      "read_file",
      "run_shell",
      "edit_file",
      "write_file",
    ],
    color: "#7c5cff",
  },
  {
    // Background self-improvement review fork (Hermes-style learning loop).
    // Spawned by the engine every `selfEvolve.everyTurns` top-level turns (see
    // engine.runSelfEvolveReview). Two layers restrict what the review can
    // touch: (1) the `tools` allow-list — note + file/skill tools only, NO
    // shell/network; (2) an engine-side path guard (search "self-review may
    // only write skill files" in engine.ts) that confines write_file/edit_file
    // to `skills/` paths. Both matter because the review runs detached in
    // `permissionMode: "bypass"` (no user to approve): the allow-list alone
    // would still let bypass-mode write_file overwrite arbitrary product code,
    // so the path guard is what makes bypass safe for the file tools.
    // The review's task text is the editable `<REINA_HOME>/self-evolve.md`;
    // this `prompt` is only the role preamble. Users can override the whole
    // profile via `$REINA_HOME/agents.json` (listAllProfiles wins by name).
    name: "self-review",
    description:
      "后台自进化复盘 fork：只读会话、写全局记忆本和技能，其它工具全禁。由引擎按 selfEvolve.everyTurns 自动触发，非用户直选。",
    mode: "subagent",
    prompt:
      '你是 Reina 的自进化复盘 agent。唯一职责：读上面这段对话，把跨会话仍成立的学习沉淀进全局记忆本（note scope:"global"）和技能（.claude/skills/*/SKILL.md）。你只有 note 系列工具和文件读写工具，不要尝试别的工具。具体怎么复盘见随后的任务说明。',
    maxSteps: 16,
    toolPermissions: {},
    // Allow-list: only these survive availableTools' filter. Also carried as
    // extraDirectTools so they're in the cold-start tools array (promoted from
    // deferred if needed) and the review can call them on turn 1.
    tools: [
      "note",
      "update_note",
      "read_note",
      "list_notes",
      "read_file",
      "write_file",
      "edit_file",
      "list_skills",
      "read_skill",
    ],
    extraDirectTools: [
      "note",
      "update_note",
      "read_note",
      "list_notes",
      "read_file",
      "write_file",
      "edit_file",
      "list_skills",
      "read_skill",
    ],
  },
  {
    // Background memory-consolidation fork (grok's "dream" equivalent).
    // Spawned by the engine AFTER a turn settles, when the workspace gate
    // opens (engine.maybeConsolidateMemory) — it never rides the user's own
    // turn, which is the whole point vs the old in-turn nudge. Runs detached
    // in `permissionMode: "bypass"`, so the notes-only allow-list below is
    // the entire safety story: no shell, no network, no file writes.
    name: "memory-consolidate",
    description:
      "后台记忆固化 fork：把近期会话简报中的持久事实合并进全局记忆本，只有 note 系列工具。由引擎在回合结束后按工作区门槛自动触发，非用户直选。",
    mode: "subagent",
    // Engine-internal: keep it out of the supervisor's delegation roster —
    // a coordinator task-spawning this profile would prune the global
    // notebook (delete_note) outside the idle/cooldown/min-session gates.
    hidden: true,
    prompt:
      '你是 Reina 的记忆固化 agent。任务说明会附上本工作区近期会话的简报材料：把其中跨会话仍然成立的持久事实（决策、偏好、项目事实）合并写进全局记忆本（note scope:"global" / update_note），并顺手删除已被推翻或取代的旧全局笔记（delete_note）——记忆本要保持小而准。你只有 note 系列工具，不要尝试别的工具。',
    maxSteps: 12,
    toolPermissions: {},
    tools: ["note", "update_note", "read_note", "list_notes", "delete_note"],
    extraDirectTools: ["note", "update_note", "read_note", "list_notes", "delete_note"],
  },
  {
    // Used by compactSessionContext() in compaction.ts. `prompt` is injected
    // as the role preamble of the summary model call's systemPrompt; editing
    // it changes real compaction behavior.
    //
    // Note: `toolPermissions` below is intent documentation only — the
    // compaction call goes through `nextModelTurnStream` directly with
    // `tools: []`, NOT through the engine's profile-aware tool resolution
    // path. The empty tools list + NO_TOOLS prompt preamble do the real
    // enforcement. Keep these denials in sync with that reality if the
    // compaction call ever gets routed through a child engine.
    name: "summary",
    description: "总结 Agent，用于会话压缩时的摘要生成。",
    mode: "subagent",
    prompt:
      "You are Reina's context compaction agent. Your sole job is to produce a faithful, structured summary of the prior conversation so a coding agent can continue the same task without losing context. Preserve file paths, commands, error messages, and direct user quotes literally. Never call tools.",
    maxSteps: 1,
    toolPermissions: {
      write_file: "deny",
      edit_file: "deny",
      multi_edit: "deny",
      apply_patch: "deny",
      run_shell: "deny",
      kill_shell: "deny",
      web_fetch: "deny",
      create_subtask: "deny",
      update_subtask: "deny",
      get_dag: "deny",
      set_phase: "deny",
      send_to_worker: "deny",
    },
  },
];
