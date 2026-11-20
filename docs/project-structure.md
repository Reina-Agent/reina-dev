# 项目结构

Reina 是一个本地优先的 Electron 桌面端 AI 编码 Agent。整个仓库是 TypeScript monorepo（npm workspaces + tsc project references），按"渲染进程 ↔ Electron main ↔ agent-host 子进程"三段拆分。没有 HTTP server，也没有 CLI 入口；所有对话和工具都跑在用户机器上。

```text
Reina/
  apps/
    desktop/                          Electron 应用（唯一发布产物）
      scripts/                        rebuild-native 等构建辅助脚本
      src/main.ts                     Electron main 入口
      src/main/                       window/menu/IPC/agent-host 控制 + 本地能力
      src/preload.ts                  contextBridge 入口（编译为 preload.cjs）
      src/renderer/                   纯 ES Module 前端（无 React、无 bundler）
        main.html                     主聊天窗口
        workspace.html                右侧工作区窗口（git/files/terminal/notes/agent-team）
        settings.html                 设置窗口
        renderer.js                   ESM 入口，三个窗口共用；按需 import 其他模块
        actions/                      面向 UI 行为的子模块
        styles/                       分模块 CSS
        vendor/                       打包好的 xterm / marked / hljs / dompurify

  packages/
    protocol/                         共享 zod schema + 枚举（wire 唯一真值）
    desktop-protocol/                 renderer ↔ main ↔ host 的请求/事件 schema
    providers/                        模型适配（OpenAI / Anthropic / 兼容端点）
    tools/                            工具运行时（按 domain 分目录）
    core/                             AgentEngine + 正交策略模块 + SQLite store
    agent-host/                       Long-running Node 子进程 + AgentHost 类

  docs/
    project-structure.md              当前文件
    agent-design.md                   Agent 设计
    audit-agent-team-design.md        Team / DAG / Lead 设计
    context-compaction.md             上下文压缩说明
    prompt-budget.md                  Prompt 预算与计量

  CLAUDE.md                           工作约定（gitignored 但保留）
  AGENTS.md                           工作目录注入到 system prompt 的项目 brief
  README.md                           对外首页（公开仓已改纯发行仓，源码不再同步）
  参考/                                只读外部参考材料（已 gitignore，不入库），勿改
```

## 总体数据流

```
Renderer (vanilla ESM)
  │  preload.cjs 通过 contextBridge 暴露受控 API
  │  ── reina:invoke (request)  ──► main
  │  ◄── reina:event:agent (event) ──
Electron main (apps/desktop/src/main/*)
  │  ── newline-delimited JSON ──► agent-host (Node child)
  │  ◄── newline-delimited JSON ──
@reina/agent-host
  └─ AgentHost 路由 desktop-protocol → 多个 AgentEngine 实例
      └─ AgentEngine（packages/core/src/engine.ts）= model+tool 状态机
```

主进程同时通过 `host_request` / `host_response` 桥接给 agent-host 提供"必须在 Electron 里完成"的能力（窗口截图、系统通知、定时唤醒），见下方"宿主桥"。

## apps/desktop

### main 进程（apps/desktop/src/main/）

| 文件 | 职责 |
| --- | --- |
| `agent-host-controller.ts` | 启动 / 重启 / 关闭 agent-host 子进程；转发事件给 renderer |
| `host-handlers.ts` | 宿主桥的 dispatcher（notify / schedule_wakeup），自身只保留 notify 实现 |
| `wakeup-scheduler.ts` | `schedule_wakeup` 的实现：内存计时器 + 落盘镜像 + 启动时 rehydrate |
| `wakeup-store.ts` | `$REINA_HOME/wakeups.json` 的原子读写（tmp + rename，串行写队列） |
| `ipc.ts` | 注册 `reina:invoke` 通道 + 收到 renderer 请求后转给 host / 直接处理本地能力 |
| `windows.ts` | 主窗口和应用菜单 |
| `terminal.ts` | node-pty 桥接（renderer 的 xterm.js 在这里收发数据） |
| `apps.ts` | "Open with" / 外部应用列表 |
| `desktop-config.ts` | 桌面端设置（外观、热键、shell）持久化到 `$REINA_HOME` |
| `desktop-state.ts` | 工作区索引 / 启动时清理失效 session |
| `store.ts` | electron-store 的薄封装 |
| `logging.ts` | 每次启动写一份 `.logs/reina-app-<stamp>.log`（最多保留 10 份） |
| `timeline-parts.ts` | 把 trace 事件折叠成可显示的 timeline 卡片（与渲染端配套） |

### preload（apps/desktop/src/preload.ts）

唯一允许 renderer 调用的 API 来源。由 tsup 编译为 `dist/apps/desktop/preload.cjs`（必须 CJS，Electron 限制）。共享的 IPC / 启动握手类型定义在 `main/types.ts`。

### renderer（apps/desktop/src/renderer/）

纯 vanilla JS，**不经过任何 bundler**。三个窗口（main / workspace / settings）各自的 HTML 文件分别声明该窗口需要的 DOM 结构，但都加载同一个 `renderer.js`（type="module"）——`renderer.js` 通过 `URLSearchParams.get("window")` 区分自己在哪个窗口里，按需启用对应模块。所有 vendor 脚本（xterm / addon-fit 等）和 ESM 子模块都由各 HTML 显式加载或经 `import` 链被拉进来。

布局上分两层：

- **顶层模块**：`renderer.js`（入口）、`state.js`（中央状态）、`conversation.js`（对话区，~1.2k 行）、`workspace.js`（右侧工作区面板）、`composer.js`（输入区）、`hitl.js`、`settings.js`、`session-store.js`、`format.js`、`markdown.js`、`tool-blocks.js`、`icons.js`、`layout.js`、`dom.js`、`i18n.js`、`command-palette.js`、`context-menu.js`、`select-popup.js`、`config.js`、`file-icons.js`。
- **`actions/`**：面向用户操作的子模块——`session.js`、`agent-team.js`、`dag-view.js`、`agent-config.js`、`agent-events.js`、`commands.js`、`hitl.js`、`keymap.js`、`local-settings.js`、`notes.js`、`open-with.js`、`prompt.js`、`rules.js`、`settings-config.js`、`skills.js`、`subagents.js`、`terminal.js`、`timeline.js`、`workspace-switcher.js`、`workspace.js`。

主要面板：项目侧栏 / 会话列表（含右键菜单、内联重命名、跨工作区搜索）、聊天面板（drift banner、empty state、错误诊断、HITL 卡片）、Composer（提示、注解、附件）、右侧 Workspace 面板（git changes、files tree、terminal、diff viewer、Agent Team 面板、DAG view）、Settings 面板的多个 tab、命令面板（⌘K）。

CSS 也是分模块加载：`base / topbar / resize / sidebar / chat / composer / hitl / workspace / palette / responsive`，外加 `vendor/hljs-theme.css`、`vendor/xterm.css`、根级 `settings.css`。

## packages/protocol

wire 定义的唯一真值。包含：

- `Provider` 枚举：`deterministic` / `openai-responses` / `openai-chat` / `anthropic-messages`。
- `PermissionMode`、`ToolName` 闭合枚举。
- 会话 / 消息 / 工具描述 / 观察结果 schema。
- `TraceEvent` 闭合 union（`session.config.updated` / `tool.preview` / `model.stream` / `autopilot.*` 等等）。
- skill metadata、agent profile、hook 类型。
- token usage（含 cached / reasoning）。

任何要新增的工具名 / trace 事件 / provider，都先在这里登记。

## packages/desktop-protocol

`renderer ↔ main ↔ host` 通道的版本化协议。`desktopRequestSchema` 是一个 zod `discriminatedUnion("type", [...])`，覆盖以下 request：

```
create_session  send_message  update_session_config  approve_tool
answer_question  answer_question_group  interrupt  rollback_session
cancel_async_task_external
save_session  list_sessions  load_session  close_session
list_workspaces  open_workspace  close_workspace  remove_workspace
list_workspace_sessions  search_workspace_messages
delete_workspace_session  rename_workspace_session
list_mcp_status  shutdown  host_response
```

事件流（host → main → renderer）包括 `host_ready`、`session_created`、`session_snapshot`、`turn_started/completed/failed/interrupted`、`model_stream`、`permission_request`、`question_request`、`host_request`（宿主桥）等。

## packages/providers

模型适配层。

- 把 Reina 的 `ModelRequest` 转换成各服务商的请求体。
- 解析模型文本和 tool call。
- 抹平 OpenAI / Anthropic / OpenAI-compatible 的差异（`tool-compat.ts`）。
- 注入 reasoning effort（Anthropic thinking、OpenAI reasoning_effort）。
- 提取 token usage（含 cached / reasoning tokens）。

当前实现：`deterministic`（fixture，开发用）、`openai-responses`、`openai-chat`（KIMI / DeepSeek / 大部分 OpenAI 兼容端点）、`anthropic-messages`。

API key 保存在 `~/.reina/models.json` 的 `apiKey` 字段，随 `create_session` 由 main 注入到 agent-host —— renderer 不持有 API key。

## packages/tools

本地工具运行时。组织上按 domain 分目录，目前有 38+ 个内置工具：

```
tools/
  registry.ts              工具注册表 + 直/延迟暴露分流
  runtime.ts               previewTool / runTool 入口
  types.ts                 ToolImplementation 接口
  utils.ts                 workspace 路径校验、截断、通用 helper
  mcp-config.ts            读 MCP server 配置
  mcp-client.ts            stdio MCP client
  mcp-runtime.ts           把 MCP server 的工具暴露成 ToolDescriptor

  tools/
    files/        read_file write_file edit_file multi_edit apply_patch
    execution/    run_shell（含 PTY 路径）background-shell（监督式）
                  task_output kill_shell monitor
    agent/        write_todos plan exit_plan_mode question task
                  start_async_task / check_async_task / cancel_async_task /
                  update_async_task / list_async_tasks / gather_async_tasks /
                  wait_async_tasks
                  notify schedule_wakeup
                  search_tool（延迟工具目录解锁）
                  team.ts: create_subtask update_subtask get_dag set_phase
                           send_to_worker  ← coordinator profile / 团队模式专用
    notes/        note read_note list_notes declare_audit_done
    knowledge/    list_skills read_skill builtin-skills（progressive disclosure）
    network/      web_fetch
    mcp/          mcp_list_resources mcp_read_resource mcp_status
```

工具一律限制在 session workspace 目录内。文件搜索默认忽略 `参考/`、`node_modules/`、`dist/`、`target/`、`.git/`。

工具暴露分两档：
- **direct**：默认在 model 的 tool array 里。
- **deferred**：默认隐藏，model 通过 `search_tool` 找到名字后再被解锁、加入下一轮的 tool array。`registry.resolveExposedTools()` 把两档拼起来。

## packages/core

Agent runtime 的心脏。`engine.ts` 是 ~4150 行的 `AgentEngine` 类（CLAUDE.md 明确写了"intentionally one large file. Don't pre-emptively split it"）。其它文件是和它正交的策略模块：

| 文件 | 职责 |
| --- | --- |
| `engine.ts` | AgentEngine：运行 model+tool loop、管理 session、approval、HITL question、async task 调度（含 watchdog + 两阶段 timeout 抢救）、autopilot 循环、token 计量 |
| `engine-prompt.ts` | system prompt 组装（profile + skills + AGENTS.md + tool catalog） |
| `engine-config.ts` | `~/.reina/` 下 reina.json / mcp.json 的 ensure / 读取 |
| `agent-guidance.ts` | base prompt + supervisor/worker 角色注入 + 可调度 profile 列表 |
| `profiles.ts` | 内建 profile（`default` / `coordinator` / `summary`）+ `~/.reina/agents.json` 自定义 |
| `skills.ts` | workspace `.reina/skills/` + 内建 skill 加载（progressive disclosure） |
| `notes.ts` | `.reina/notes/` 共享审计笔记本（NotesService，AGENTS.md 风格的 frontmatter + 正文） |
| `subtasks.ts` | 子任务 DAG 存储（coordinator profile / 团队模式 + Agent Team 面板用） |
| `permissions.ts` | 工具执行的 ask/allow/deny 决策 |
| `shell-approval.ts` | run_shell 的命令解析 + 危险命令拦截 |
| `loop-budget.ts` | tool-loop 预算 / 反复同名失败检测 / 停滞检测 |
| `compaction.ts` | 上下文超阈值时召唤 summary subagent 做压缩 |
| `hooks.ts` | preToolUse / postToolUse / userPromptSubmit / onStop 跨平台 hook runner |
| `trace.ts` | 写 trace 事件 + 敏感字段脱敏 |
| `rollout.ts` | session 的 append-only `.jsonl` 事件日志，loadSession 回放它 |
| `store/session-store.ts` | workspace 级 SQLite (`.reina/reina.db`) 索引 + 全文搜索 |
| `store/migrate-jsonl.ts` | 旧 JSONL session → SQLite 后台迁移 |
| `store/schema.ts` `store/migrations.ts` | DB schema + 演进 |

`packages/core/src/index.ts` 只 re-export 给外部用的少量入口（`AgentEngine`、`SessionStore`、`profiles` 等）；其它内部文件按需直接 import。

### 内置 agent profile

`packages/core/src/profiles.ts` 出厂三个：

- `default` —— 通用主 Agent，`toolPermissions: {}`（**无 deny**）。`create_subtask`/`set_phase` 等 DAG 工具只是 deferred、不在其冷启动工具集；识别到 DAG 形状任务时 `read_skill("team-coordination")` 自主升级到团队模式。
- `coordinator` —— 团队/DAG 协调 profile（`primary`）：把 DAG 型大任务拆成可独立调度的 subtask、按依赖用 `start_async_task` 派 worker 并行、用 `set_phase` 推进 plan→exec→verify→fix→complete。**但它本身是完整 agent**——能 read_file / run_shell / edit_file / write_file，默认自己干；worker 是 escalation（并行 / 大噪音低 SNR / 专门化 / 真长跑 / 风险隔离），不是每个 subtask 的归宿。
- `summary` —— 用于上下文压缩的子 Agent，只读（实际 tools:[] 在 compaction 调用点强制，profile 的 deny 表只是意图文档）。

用户可以在 `$REINA_HOME/agents.json` 加自定义 profile（比如 `reviewer` / `explorer` / `tester`）。**任何对 profile 的判断都走 `listAllProfiles()`**，不要假设只有那三个内建项。

## packages/agent-host

Long-running Node 子进程，由 main 启动。

- `stdio.ts` —— child 进程入口，readline 拼好行后调 `AgentHost.handle()`。
- `index.ts` —— `AgentHost` 类。一个 host 持有：
  - `Map<sessionId, HostSession>` —— 多个并存的 `AgentEngine` 实例。
  - `Map<workspaceCwd, SessionStore>` —— 每个 workspace 一个 SQLite 连接，多个 session 共享。
  - `bridgePending` —— `host_request` 桥的 pending Promise 表。
- 把 model stream / tool progress / turn 事件 / session snapshot 通过 stdio 回传 main。
- 提供 `triggerWakeup(sessionId, message)` —— 给 main 的 wakeup 计时器用，把合成的用户消息打回原 engine。

## 宿主桥（host_request / host_response）

agent-host 内的某些工具需要"只能在 Electron 主进程做"的能力（窗口截图、系统通知、定时唤醒）。流程：

1. Engine 调用 `hostBridge(kind, params)`（构造时由 AgentHost 注入），AgentHost 发出 `host_request` 事件，main 的 `agent-host-controller` 收到后路由到 `host-handlers.handleHostRequest`。
2. main 完成本地动作后回写一个 `host_response` request 给 host。
3. AgentHost 用 `bridgePending` 表把它兑现为对应的 Promise。

`schedule_wakeup` 的特殊点：除了完成动作还要落到 `wakeups.json`，并设置 `setTimeout`；定时器 fire 时通过 `sendHostRequest({ type: "send_message", ... })` 把"合成用户消息"打回 host —— 借用现有 send_message 链路，不需要新协议。

## Autopilot / 子任务 DAG / 异步 task

三种"自动驱动"机制并存，目标场景互不相同：

- **Autopilot**（`engine.startAutopilot` / `pauseAutopilot`）—— 单 Agent 反复跑 turn，直到自己调 `declare_audit_done` 或者撞上 wallclock / round / token / 停滞 / tool-loop 边界。给"无人值守审计 / 持续探索"用。
- **coordinator profile + 子任务 DAG**（`subtasks.ts` + `team.ts` + Agent Team 面板）—— 由 coordinator Agent 把目标拆成可独立调度的节点，用 `start_async_task` 派 worker 子代并行执行。
- **同步 `task` 工具**（aka `runSubagent`）—— 单次阻塞调用一个子代，结果回填当前轮。简单一次性委派用。

三者都共享 `runChildWithWatchdog` + 两阶段 timeout（execute 后被 kill 的子代会再跑一次"自报家门"的 conclude 阶段，把残留信息抢救出来），见 `engine.ts`。

## 运行时数据布局

每个 workspace 在自己根目录下维护 `.reina/`（默认 gitignore）：

```
.reina/sessions/      session 的 append-only .jsonl rollout（loadSession 回放它）
.reina/tasks/         异步子代每个 task 的 stream.jsonl
.reina/tool-output/   run_shell 的溢出 stdout/stderr
.reina/reina.db      workspace SQLite 索引（含 -shm / -wal）
.reina/skills/        progressive-disclosure skill markdown
.reina/notes/         共享 audit 笔记本
.reina/worktrees/     subagent 的隔离 git worktree
```

全局配置在 `$REINA_HOME`（默认 `~/.reina/`）：

```
~/.reina/reina.json    全局设置 + 模型 / 权限 / hook
~/.reina/models.json    模型 + apiKey
~/.reina/agents.json    自定义 agent profile
~/.reina/mcp.json       MCP server 配置
~/.reina/wakeups.json   schedule_wakeup 持久化（跨重启存活）
```

## 参考目录

`参考/` 只读、勿改。当前用于：

- `opencode/` —— session、事件模型、MCP、PTY、LSP 的结构。
- `claude-code/` —— 编码 Agent 体验。
- `agent-patterns/` —— middleware、permissions、backends、skills、subagents 结构。
- `Cairn/` —— Fact / Intent / Hint blackboard、Docker dispatcher、cytoscape DAG 可视化。
