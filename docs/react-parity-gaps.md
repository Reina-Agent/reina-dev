# React 渲染器 vs Legacy — Parity 差距清单

> 审计日期 2026-06-14。Legacy 渲染器(`apps/desktop/src/renderer/`,命令式 JS)为
> 真相源;React 渲染器(`apps/desktop/src/renderer-react/`)为移植目标。
> 本文档只记录**差距**,不含已忠实移植的部分。未改动任何代码。
>
> 完成度评估:**chat 主窗口 ~55–65%**;HITL dock + workspace 标签页 ~85%。
> 核心问题不是"复刻的命令式块坏了"(那些大多接好了),而是**大量行为/事件接线
> 根本没移植** —— React 把 legacy ~25 个 model_stream 子类型 + ~10 条 IPC 通道压到了
> 一小撮,并丢掉了整个 per-session 后台缓存。

---

## CRITICAL —— 直接导致"功能像坏了"

1. **Slash 命令整体失效** —— `runSlashCommand` 在 React 端**不存在**。`/goal` `/team`
   `/verify` `/cancel` `/compact` `/clear` `/agent` `/use` `/skill <name>` 全部作为纯文本
   发给模型。弹窗外观/过滤都一致,但发送后什么都不做。
   - Legacy: `actions/prompt.js:431-441, 726-862`(`sendPrompt` 拦截 `startsWith("/")`)
   - React: `Composer.tsx:210-268` doSend 无 slash 分支;`sessionStore.ts:302-326` 原样发送。
     `slashCommands.ts:21` / `SlashPopover.tsx:27,155` 注释都引用了一个不存在的函数。

2. **工具卡片从不分组** —— 每个工具调用各自独立卡片。legacy 会把相邻 2+ 工具折叠成
   `.tool-group`("Gathered context · N calls")。一轮取数爆成一墙独立方块。
   - Legacy: `conversation.js:1140-1204, 1271-1291, 1335-1356`
   - React: `Timeline.tsx:102-108` 每个 part 独立 `<ToolCard>`;多 detail 未处理(`ToolCard.tsx:118,485`)

3. **文件路径不可点击** —— legacy 把正文里的 `apps/foo.ts:42` 转成可点 `.entry-path-link`
   跳转到文件。React 完全没有 linkifier。
   - Legacy: `conversation.js:779-861`(regex 776-777)
   - React: `Markdown.tsx:113-208` 只处理代码块,handleClick 无 path 分支。

4. **错误条目/重试提示不进时间线** —— 轮次失败、provider/401/网络错误在时间线里静默。
   legacy 有 `entry.error-entry` + 可操作 hint("Open Models settings")。
   - Legacy: `conversation.js:863-939`(`errorHintFor`)
   - React: `sessionStore.ts:733` 存了 `error` 字符串,但**没有任何组件渲染它**;MainApp 零引用。

5. **上下文压缩完全静默** —— `/compact` / 自动压缩有数秒冻结、零反馈,历史无声变短=像丢消息。
   - Legacy: `agent-events.js:468-490`(started/compacted/failed 三态 + 脉冲分隔符)
   - React: `handleModelStream`(`sessionStore.ts:800-855`)无任何 compaction 分支;`"compacting"`
     状态枚举从不被设置。

6. **无 per-session 后台缓存** —— 切到另一个运行中会话再切回,丢失流式文本、待批准/提问、
   spinner 计时锚点。多会话使用体验直接崩。
   - Legacy: `agent-events.js:78-181` + `session-store.js`(整文件:applyBackgroundEvent / 缓存 / 恢复)
   - React: `sessionStore.ts:643-647` 非当前会话事件只在 snapshot/turn_completed 触发刷新,其余丢弃。

7. **stream-reset / user-message 处理降级** —— steer/排队消息不再变成用户气泡,队列项不被移除。
   - Legacy: `agent-events.js:296-319`(user-message 物化为气泡)、`320-339`(stream-reset 重写 DOM)
   - React: `sessionStore.ts:848-851` 两者都只 `set({ overlay: EMPTY_OVERLAY })`。

8. **提示历史 ↑/↓ 召回丢失** —— 按 ↑ 召回上一条 prompt 无任何反应;发送过的 prompt 不被记忆。
   - Legacy: `actions/prompt.js:28-98`、`keymap.js:73-80`
   - React: `Composer.tsx:305-314` keydown 只处理 Enter/Shift+Enter。

9. **Notes 标签页无实时更新** —— store 已经收到 `notes-updated`(`workspaceEngineStore.ts:500-502`),
   但 NotesTab 从不订阅,只在切换标签时冷加载一次。会话中笔记本是陈旧的。
   - Legacy: `notes.js:101-109`(wired at `agent-events.js:427-432`)
   - React: `NotesTab.tsx` / `WorkspaceApp.tsx:639-643` 仅 refresh-on-activate。

---

## HIGH

10. **子代理活动面板丢失** —— 主窗口发起 subagent/async-task 时,嵌套活动在 chat 里不可见。
    - Legacy: `conversation.js:1002-1090`(`renderSubagentActivity`)、`agent-events.js:409-418`
    - React: 主窗口无 `subagent-event` 分支。

11. **运行中工具无 elapsed 计时器** —— 长 shell/read 看起来像卡死。legacy 每 500ms 更新 "· 1.3s"。
    - Legacy: `conversation.js:1530-1555`(`manageTicker`)
    - React: `ToolCard.tsx:75-81,177-178` meta 仅由 `completedAt-createdAt` 算,运行中为空。

12. **工具 meta/徽章降级** —— "N calls"、`12 KB · 340 lines`、`bg <taskId>`、detail 摘要全丢,只剩时长。
    - Legacy: `conversation.js:1572-1644`
    - React: `ToolCard.tsx:177-178`

13. **~30 个工具标题退化为原始工具名** —— apply_patch 无 target;schedule_wakeup/task/git_status 等显示裸名。
    - Legacy: `conversation.js:1711-1893`(覆盖 ~40 工具)
    - React: `ToolCard.tsx:132-173` switch 仅覆盖 ~12,其余落 `default: title = toolName`。

14. **会话"需关注"徽章丢失** —— 后台会话完成/需批准/有提问无任何视觉提示。
    - Legacy: `agent-events.js` + `session-store.js:70`(`needsAttention` + `refreshSessionBadges`)
    - React: SessionRow 注释提到 `is-attention`/`is-running` class 但从不设置。

15. **后台会话 OS 通知丢失** —— 无"Reina 完成 / 需批准(后台会话)"通知;前台完成通知也无。
    - Legacy: `agent-events.js:119,136,147,165`(`notifyIfUnfocused`)
    - React: 主窗口无 `notifyIfUnfocused`。

16. **状态 pill / status 文本 / elapsed 计时器丢失** —— 顶栏的 working/waiting/error/idle 动画状态条没了。
    - Legacy: `renderer.js:219-285`(`setStatus`/`deriveStatusState`)
    - React: `status` 在 store 里但 MainApp.tsx 不渲染任何 status 元素。

17. **窗口最大化图标不更新** —— 最大化后按钮仍是 maximize 图标,无 restore。
    - Legacy: `renderer.js:1350-1366`(`window-state` + `windowIsMaximized`)
    - React: MainApp 内联窗口控件无 `window-state` 订阅(可用的 handler 只在未使用的 TitleBar.tsx)。

18. **可拆分的 session-sidebar 浮窗 + 跨窗同步丢失**
    - Legacy: `renderer.js:612-636, 1239-1285`
    - React: `MainApp.tsx:77` toggle 纯 CSS class 翻转,无独立侧栏窗口。

19. **`@`-mention 文件选择器 / Ctrl+P 文件搜索退化为死胡同**
    - Legacy: `command-palette.js:39-56`、`commands.js`
    - React: `CommandPalette.tsx:353-355` 任何 `@` query 直接短路成 "No files";Ctrl+P 开空面板。

20. **命令面板动态分组缺失** —— 每个 prompt 模板 `/<promptId>`、每个 agent `/agent-<name>` 切换项没了。
    - Legacy: `commands.js:286-323`
    - React: `CommandPalette.tsx:115-328` / `slashCommands.ts:54-148` 全静态。

21. **空闲但有运行中子代理时的排队逻辑缺失** —— 主轮空闲但后台任务运行时,新 prompt 应入队而非直发。
    - Legacy: `actions/prompt.js:457-464, 571-574, 635-639`
    - React: `Composer.tsx:213-221` 仅 `working` 为真时入队;无 `hasRunningAsyncTasks` 检查。

22. **Backspace 弹出最后一个 skill tag 丢失**
    - Legacy: `keymap.js:62-72`
    - React: Composer keydown 无 Backspace 分支。

23. **Notes "导出审计报告" 丢失** —— 安全研究核心流程:把确认的笔记导成 markdown 报告到剪贴板。
    - Legacy: `notes.js:345-394`(bound 404)
    - React: NotesTab 无导出。

24. **async-task-updated 不合并** —— 后台任务完成可能漏掉;Agent Team roster 只在轮末更新。
    - Legacy: `agent-events.js:419-426`(`mergeAsyncTaskUpdate`)
    - React: `handleModelStream` 无该分支。

---

## MEDIUM

25. **turn-folding 只对已提交 parts 生效,进行中的轮次不折叠** —— `Timeline.tsx:117-203` vs `conversation.js:612-733`
26. **read_file 输出 envelope 未拆封** —— Read 显示原始 `<path>/<type>/<content>` 而非纯内容。`ToolCard.tsx:186-188` vs `conversation.js:1566-1570`
27. **工具错误体未清洗** —— 显示原始 `<tool_error>` XML 而非人类可读消息。`ToolCard.tsx:464-471` vs `format.js:35-88`
28. **图片 lightbox 降级为空白窗口** —— 无缩放/拖拽/旋转。`ChatEntry.tsx:170-181` vs `conversation.js:288-448`
29. **用户消息 "Skills" chips 丢失** —— `ChatEntry.tsx:283-343` vs `conversation.js:450-465`
30. **Java gadget 体噪声未抑制** —— 安全研究会话里 gadget 查询工具把数百行 JSON 灌进时间线。`ToolCard.tsx:509-513` vs `conversation.js:1460-1464`
31. **host-exit 崩溃横幅未接线** —— `#host-crash-banner` DOM 在 `MainApp.tsx:195-201` 但无 `host-exit`/`init-step` 订阅,Restart 按钮无 handler。
32. **host-stderr / menu-command IPC 未处理** —— `renderer.js:1210-1213,1238`
33. **侧栏折叠动画 + 窄视口自动折叠丢失** —— 瞬切无滑动;<760px 不自动折叠。`MainApp.tsx:77,84-88` vs `renderer.js:464-636`
34. **sessionCollapsed/workspaceCollapsed 折叠状态不持久** —— 每次启动重置。`sessionStore.ts:110` vs `renderer.js:815-834`
35. **boot 不走完整 workspace 自动恢复** —— 无 "Starting agent host…" 进度,缺 resume-latest。`sessionStore.ts:184-197` vs `renderer.js:1146-1179`
36. **附件/上下文文件摄入错误被静默吞掉;文本文件→context 路径缺失** —— 拖入 .ts/.md 什么都不发生。`Composer.tsx:322-324` vs `actions/prompt.js:289-348`
37. **context bar 退化为仅 @-token** —— 无法把文件/选区固定为持久 prompt context。`Composer.tsx:564-580` vs `composer.js:36-50`
38. **`enableSlashCommands` / `enterToSend` config 被忽略;无 Ctrl/Cmd+Enter 发送** —— `Composer.tsx:307-312` vs `keymap.js:81-88`
39. **task pane 不在首批 live todos 时自动打开** —— `taskStore.ts:102-104` vs `task-panel.js:67-73`
40. **conversation agent 过滤从 "set" 变成 "toggle"** —— `ConversationTab.tsx:313` vs `conversation.js:268-274`
41. **Notes 侧栏折叠 toggle 缺失** —— `NotesTab.tsx` vs `notes.js:338-343`
42. **HITL 渲染后不刷新 command buttons** —— `HitlDock.tsx` useEffect vs `actions/hitl.js:32`(`refreshCommandButtons`)
43. **select-popup.js 样式化 `<select>` 未移植**(主要影响 settings 侧)

---

## LOW

- 工具状态 running→failed 时不自动展开(`ToolCard.tsx:502-507`)
- 空白 assistant part 兜底依赖 host 预过滤(`Timeline.tsx`)
- background-error 不再 `console.warn`(`agent-events.js:123-127`)
- 子代理 question-request 无 OS 通知(`sessionStore.ts:835-847`)
- save_session 不在轮次边界显式调用(依赖 host autosave)
- topbar 右键菜单(open-with/折叠)缺失(`renderer.js:1420-1448`)
- custom-models-changed / subscriptions-changed 跨窗刷新待验证(`renderer.js:1184-1209`)
- workspace 标签页不再按数据有无 隐藏(单轮会话显示空 DAG/Team chrome)
- AgentTeam 汇总 chips 硬编码 4 状态,recovery 态无计数(`AgentTeamTab.tsx:265`)
- open-with 启动失败静默(只 console.error)(`OpenWith.tsx:196+`)
- Notes markdown 降级为手写正则渲染器(`NotesTab.tsx:119-142`)
- restoreDraft 不剥离 "Context files:" 包裹(`Composer.tsx:196-206`)
- 错误 action 拒绝只写入 `state.error`,若无渲染则静默(`sessionStore.ts:569-571`)

---

## 已澄清:不是差距(避免误修)

- **taskStore 的 autopilot-updated / session-goal-set/-resolved 路由正常** —— taskStore 独立订阅原始
  `agent` 通道并完整 unwrap model_stream(`taskStore.ts:160-167,186`)。一个子审计误报为 CRITICAL,已核实推翻。
- **Conversation / DAG / Terminal 标签页接近满 parity**,事件订阅正确。
- **HITL dock 是移植最强的部分** —— `legacy/hitl.js` 与原 `hitl.js` `diff -q` 完全一致;
  HitlDock 生命周期健全(refs 稳定、mount-once、无 stale closure)。只丢了 refreshCommandButtons +
  可见错误上报两个接线点。
- **ComposerPickers / SlashPopover / CommandPalette rows / SessionContextMenu 等"命令式复刻"块本身接好了**
  (mount 绑 ref、useEffect cleanup 卸载、singleton 置空),不是坏的;问题在它们背后的行为没接。

---

## 根因(用户"差很多"的真实来源)

1. **Slash 命令是装饰品** —— 看起来全接好了,实际 `runSlashCommand` 整个 dispatch 没移植,
   所有命令降级为发给模型的纯文本。这是最大的单点回归。
2. **时间线"连接组织 + 实时反馈"被整体丢弃** —— 工具不分组(一墙方块)、路径不可点、
   运行中工具无计时、错误与压缩静默。单卡片/单消息是忠实的,但把它们连成"活的对话"的那层没了。
3. **多会话/后台状态崩了** —— 无 per-session 缓存,切换运行中会话丢流式文本/待批准/徽章;
   无 OS 通知、无状态 pill。即便单会话也"更不灵、信息更少"。
4. **Notes 工作流退化** —— 标签页不实时更新(数据已到 store)、导出报告 + 侧栏折叠没了 ——
   对做安全研究的本用户是核心流程缺失。

---

## 实现进度(React 迁移 — 持续推进中)

> 目标:完整、无 bug 的 React 迁移。下面记录已落地的修复,便于跨上下文恢复。
> 全部改动均 typecheck + build 通过;**尚未真机验证**。

### 已完成(15 项)

**阶段 1 — CRITICAL(全部 + /compact):**
- #1 Slash dispatch — `runSlashCommand.ts` + `Composer.doSend` 拦截 `/`;`sendMessage` 加 `intent:"steer"`;`systemNotices`/`appendSystemNotice`;`CommandPalette.runSlashByToken`;`/compact`→`compactSession`
- #2 工具分组 — `ToolCard` 的 `ToolGroup`(多 detail → `.tool-group` 子卡片)
- #3 路径 linkify — `Markdown.tsx` `linkifyFilePaths` + `.entry-path-link`→`openPath`
- #4 错误条目 — `ErrorEntry.tsx`(errorHintFor 四类),`Timeline` 渲染 `state.error`
- #5 压缩反馈 — `handleModelStream` 三态 + `compaction` state + `.compact-divider`
- #7 stream-reset/user-message — `steerBubbles` 气泡

**阶段 2:**
- #6 后台缓存 — `sessionCache` Map + `applyBackgroundEvent` + capture/restore
- #14 侧栏徽章 — `sessionBadges` + SessionRow `is-running`/`is-attention`
- #15 后台通知 — `notifyIfUnfocused`
- #11 工具实时计时 — `ToolCard.useTickingNow`
- #13 ~40 工具标题 — `toolVerb` + `toolTargetFromInput`
- #9 Notes 实时 — `workspaceEngineStore.notesVersion` + WorkspaceApp 监听
- #23 Notes 导出 — `NotesTab.exportReport`
- #41 Notes 折叠 — `NotesTab.sidebarCollapsed`
- #17 最大化图标 — `MainApp` maximized + `window-state` 订阅

**阶段 3(进行中):**
- #26 read_file envelope 拆封 + #27 工具错误清洗 — `ToolCard` `displayToolOutput` / `cleanToolErrorForDisplay`
- #22 Backspace 弹 skill — `Composer.handleKeyDown`
- #8 prompt 历史 ↑/↓ — `Composer` `promptHistory`(per-workspace localStorage)+ keydown 召回
- #31 host-exit 崩溃横幅 — `MainApp` 订阅 `host-exit`/`init-step` + Restart→`relaunch`
- #10 子代理面板 — `SubagentPanel` + `applySubagentEvent`(主窗口轻量内联版)

**追加 2(侧栏审计,均审计漏报 + 已修 + CDP 实测):**
- **归档功能整体静默失效** — 后端 index 存 `archivedAt`(ISO 串,`desktop-state.ts:49`),但 React `SessionListItem` 声明 `archived?:boolean`、过滤/toggle 全读 `item.archived`(永 undefined)。后果:归档会话不离开普通列表 + "Archived"组永不出现 + `!item.archived` 永 true ⇒ 永远无法取消归档。修:`protocol.ts` 改 `archivedAt?:string`;`SessionList.tsx`/`SessionContextMenu.tsx`/`WorkspaceSwitcher.tsx` 全部读 `archivedAt`(`setSessionFlags` 入参 key `archived:` 保留)。CDP 实测:归档顶层会话后 Archived 组出现。注:归档过滤仅作用顶层项,嵌套 fork 跟随父节点显示——与 legacy 一致。
- **删除当前会话且无同级时悬空** — `SessionContextMenu.deleteSession` 找不到同级时无 else 兜底(注释承诺 "or a draft" 未实现),删完留在已删会话的陈旧 transcript/sessionId 上。修:`else await newDraftSession(item.cwd)`(对照 legacy `finishSessionRemoval`)。

**核实非 bug(不修):** 变更操作错误**可见**(Timeline `{error && !working}` 渲染 ErrorEntry,变更时 working=false 正好显示)——Agent 误报。`notes-updated`/`async-task-updated` 主 store 未接但 workspace 窗口已覆盖(parity #9/#24);`background-error` 仅调试 console.warn,低价值。

**追加(实测发现,审计漏报):**
- **session_created 漏 recordSession** — legacy `agent-events.js:220` 每次 `session_created`→`persistSession`→`recordSession` 登记进侧栏;React handler 只切 `state.sessionId`+`parts`,从不登记。后果:**"创建分支"/撤回到分支** 实际建了会话也切过去了,但新会话永不进侧栏列表 + fork 同段对话视图无变化 ⇒ 用户看不到反馈,以为"用不了"。修:`sessionStore.ts` session_created handler 补 `recordSession`+`setActiveSession`+`await refreshDesktopState`(CDP 实测 90→91,侧栏现"(分支)"条目)。
- **实时 loop 顺序倒置 + 进行中不折叠(#25)** — overlay 累加全部文本→渲染在所有 liveTools 之上,最终总结跑到工具卡上面。修:`liveText`(工具到达即 flush 当前文本回合)+ 渲染按 createdAt 归并,overlay 仅作流式尾部。
- **thinking spinner 非常驻 + 无动词轮换** — `working && !hasOverlayText` 一有文本就隐藏(叠加 liveText 后变闪烁);硬编码静态 "Thinking..."。修:`working && !stopping` 常驻 + 端口 legacy 的 Claude Code SPINNER_VERBS 打字机轮换。
- **发送无乐观用户气泡** — host 仅轮末提交快照,用户消息答完才显示。修:`sendMessage` 复用 `steerBubbles` 即时物化(steer 跳过避免重复)。

### 审计误报 / 与用户需求冲突(核实,无需做)
- #16 状态 pill(legacy 无 `#status`,空跑);#24 async-task(workspace 已覆盖)
- #30 java 噪声抑制 — 会隐藏用户做安全研究需要的完整输出,与"security research needs full detail"冲突,**故意不做**
- 实际真 gap 数明显少于审计的 43 项

### 剩余
- #10 子代理面板 — ✅ 已完成(`SubagentPanel` + `applySubagentEvent`,主窗口轻量内联版;完整版在 workspace AgentTeamTab)
- #19/#20 命令面板动态分组 + 文件搜索 — **需 main 进程 IPC**(list_prompts / 文件搜索,当前 main 不存在;React chat 窗口设计上无文件 pane);切换 agent 已由 `/agent <name>` slash 覆盖。跨进程扩展,留阶段 4 评估
- 阶段 3:#28 图片 lightbox、#29 skills chips(需 host 投影带 skills)、#8 prompt 历史 ↑/↓、#36 文本→context、#38 enterToSend/Ctrl+Enter、#25 live turn-folding、#31 host-exit 横幅、#32 host-stderr/menu-command、#33 折叠动画、#34 折叠状态持久、#35 boot workspace 恢复 + LOW 段
- 阶段 4:删 `apps/desktop/src/renderer/` + HitlDock 从 `legacy/hitl.js` 真重构为 React + 更新 CLAUDE.md/MEMORY.md
