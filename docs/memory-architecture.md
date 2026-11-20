# Memory Architecture

> Status: **已落地**（2026-07-17，随 grok-dream 式后台固化重做一起交付）。
> 本文是现状描述 + 决策记录，不是提案。横向调研对照见 §6。

## 0. 一句话

Reina 的长期记忆 = **模型 inline 随手记（主通道） + 检索命中历史时提示升级（需求驱动） +
后台 dream 固化兜底（按项目批量结账） + 固化时顺手修剪（只出不烂）**，
全程没有一次"专门为记忆而生的高频模型调用"。

## 1. 记忆表面（存哪些、在哪）

| 表面 | 位置 | 内容 | 读取方式 |
|---|---|---|---|
| 全局笔记本 | `$REINA_HOME/notes/`（`g_*` id） | 跨项目持久事实：偏好、决策、通用技巧 | 索引注入 system prompt（[engine-prompt.ts:529](../packages/core/src/engine-prompt.ts#L529)，上限 40 行），正文 `read_note(id, scope:"global")` 懒加载 |
| 工作区笔记本 | `<cwd>/.reina/notes/`（`n_*` id） | 项目内发现、审计线索 | 同上，workspace scope |
| 会话历史 | `<cwd>/.reina/reina.db`（FTS5 + CJK LIKE 回退） | 所有会话的原始消息 | `search_memory` 关键词检索 |
| offload chunks | 同上 SQLite | compaction 压掉的完整原文 | `recall_memory_chunk` / `search_memory`（需 `REINA_COMPACTION_OFFLOAD=1`） |

分工：**搜索层负责"能找回一切"**（历史 + chunks 是无损的），**笔记层负责"高价值事实
常驻上下文"**。固化的职责因此不是归档（搜索已覆盖），而是策展——决定什么值得进那个
每次开新会话都注入的小索引。

## 2. 写入的三条通道

按成本从零到低排列，全部由需求驱动，没有定时抽取：

1. **Inline 随手记（主通道）**：system prompt 常驻指引（[engine-prompt.ts:557](../packages/core/src/engine-prompt.ts#L557)），
   模型学到跨项目事实时当场 `note(scope:"global")`，优先 `update_note` 合并而非追加近重复。
2. **检索即信号（Reina 原创，各参考实现均无）**：`search_memory`
   （[memory.ts:80](../packages/core/src/controllers/memory.ts#L80)）命中**历史会话**的消息/chunk 时，
   输出尾部附一行提示——"这个知识被需要第二次了，若持久就当场折进全局笔记本"。
   被迫重新查找 = 该事实持久价值的最强证据；写入时机由真实需求驱动，零额外调用。
3. **后台 dream 固化（兜底，见 §3）**：攒够一批闲置会话后，后台批量把漏网的持久事实折进笔记本。

## 3. 后台固化（dream）机制

骨架抄 grok 的 memory dream（材料在 `参考/grok-build/.../memory_dream.rs`），
执行复用 Reina 现成的 self-evolve 子引擎基建。

### 3.1 触发与门槛

每个顶层 turn 结束后（[engine.ts:1575](../packages/core/src/engine.ts#L1575)）做一次纯 SQLite
检查（[memory.ts:215](../packages/core/src/controllers/memory.ts#L215)，零 token），三关全过才跑：

| 门槛 | 默认 | env |
|---|---|---|
| 总开关 | 开 | `REINA_MEMORY_DREAM=0` 关（不影响手动 `consolidate_memory` 工具） |
| 冷却 | 72h / 工作区 | `REINA_MEMORY_COOLDOWN_HOURS` |
| 会话积累 | ≥10 个新会话 | `REINA_MEMORY_MIN_SESSIONS` |
| 闲置过滤 | 会话需闲置 ≥6h 才计入 | `REINA_MEMORY_IDLE_HOURS` |

要点：

- **按工作区批量结账**，不是每 session 一次。每个项目独立时钟 + 计数；不活跃的项目永远不触发。
- **闲置过滤（codex 式）同时作用于后台门槛计数和后台材料**（[memory.ts](../packages/core/src/controllers/memory.ts)
  的 `consolidationDue` / `beginConsolidation`，SQL 上界在
  [session-store.ts](../packages/core/src/store/session-store.ts) 的 `untilIso` 参数）——
  两处必须同一截止线，否则门开了材料却被滤空。永不总结进行到一半的工作；当前会话天然被排除。
  **手动 `consolidate_memory` 刻意不走 idle 门**：用户明说"现在折"，刚收尾的会话正是对象。
- **双时间戳**：`memory_consolidated_at`（run clock，=now，只管冷却）与
  `memory_consolidation_cursor`（材料高水位，=idle 截止线，只管下界）分开。后台跑完 cursor 停在
  截止线上，闲置窗口内刚安静下来的会话留在 cursor 前方、下个周期照常入料——若像初版那样把
  now 当游标，这批会话会被 `updated_at > since` 永久跳过。旧工作区无 cursor 时回退读 run clock。
- 子代理会话、归档会话不计入。子引擎自身不触发（`isSubagent` 短路）。

### 3.2 执行

[engine.ts:1586](../packages/core/src/engine.ts#L1586) `maybeConsolidateMemory` →
[engine.ts:1605](../packages/core/src/engine.ts#L1605) `runMemoryConsolidation`：

1. `beginConsolidation()`（[memory.ts](../packages/core/src/controllers/memory.ts)）构建材料并
   **先打时间戳再执行**（grok 的 DreamLock 语义：戳即锁，防同工作区并发双跑；单进程 + 每工作区
   共享同步 SessionStore + check→stamp 无 await 间隙，锁语义在产品架构下成立）。
   **失败不回滚也不重试该批**：戳已落、cursor 已前移，挂掉的那批不会再被供料——原始会话仍可被
   `search_memory` 无损找回，损失只是笔记本少了那次折叠。
2. `spawnChildEngine` 起 `memory-consolidate` profile
   （[builtin.ts:173](../packages/core/src/profiles/builtin.ts#L173)）的分离子引擎：
   `permissionMode: "bypass"` + **工具白名单只有 note 系列（含 delete_note）**——bypass 下白名单
   就是全部安全故事；maxSteps 12。
3. 材料 = 自上次固化以来 ≤15 个闲置会话的简报（标题 + 摘要截断 600 字符）+ 折叠指令
   （合并去重、矛盾以新会话为准、相对日期转绝对、一次性噪音丢弃）。
   注意 `session.summary` 只有 compaction 会写——短会话简报只有标题，这是当前材料质量上限（蓝图 §7①）。
4. 收尾：`rollupChildUsage` 归账、刷新 `session.globalNotes`、
   trace 记 `memory.consolidated`。用户全程无感（不进聊天流）。

### 3.3 遗忘（修剪出口）

固化指令含修剪职责（[memory.ts §buildConsolidationDirective](../packages/core/src/controllers/memory.ts#L185)）：
被新会话推翻/取代的旧全局笔记 `delete_note` 删掉——**能自我瘦身的记忆才敢自动生长**。
轻量版（无使用追踪字段）；若实际膨胀再升级 `lastRecalledAt`（蓝图 §7④）。

### 3.4 防漂移（召回侧）

全局笔记注入段末尾一句（claude-code 的教训）：笔记反映写入时的状态，引用其中的文件/
flag/命令前先核实仍存在，不对就修笔记。"记忆说 X 存在" ≠ "X 现在存在"。

## 4. 手动入口

`consolidate_memory` 工具（[memory.ts](../packages/core/src/controllers/memory.ts)）：同一个
材料构建器，但把材料直接交给**调用方模型**当场折叠（agent-native，等价 grok 的 `/dream`），
且**不套 idle 过滤**——显式调用就是"现在折"，刚收尾的会话照收。
`REINA_MEMORY_DREAM=0`（及 `false`/`off`；空值视为未设，回退配置）只关后台门，不关此工具。

## 5. 时机决策记录

- **选 turn 结束后检查**：Electron 常驻窗口没有干净的"session 结束"信号（grok 是 CLI/ACP
  才玩得起 session-end）；turn 边界 + 重门槛 ≈ "隔几天一次"的实际频率。
- **否决 compaction 时机（hermes on_pre_compress）**：其动机是有损压缩前抢救洞见，Reina 的
  offload chunks 已无损保留；且压缩次数与"攒了多少待折叠会话"无关（短会话永不压缩 → 饿死），
  压缩瞬间还是会话最重的时刻。
- **否决每 turn 抽取（claude-code extractMemories）**：成本最高档，需要 inline 互斥 + 节流两道
  额外机制；Reina 的检索即信号以零成本覆盖同一需求的高价值子集。
- **否决额度 gate（codex rate_limits_ok）**：BYOK 无后端额度概念。

## 6. 横向调研对照（2026-07-17，全部核验过源码）

| 实现 | 自动记忆 | 触发 | 写入方 | 存储 | 可借鉴点（已采纳标 ✔） |
|---|---|---|---|---|---|
| grok | 有 | session 结束 dream | 后台模型调用 | 文件 | ✔ 骨架：gate→戳锁→后台跑 |
| codex | 有（最重） | 启动时扫历史 rollout，两阶段 | 后台独立模型 ×2 | SQLite + md + git 仓库 | ✔ idle 过滤；未采纳：git-diff 遗忘、额度 gate |
| claude-code | 有（最全） | 每 turn 抽取 + 24h/5会话 dream + 每 turn 相关性召回 | 后台 fork 子代理 | 一事一 md + MEMORY.md 索引 | ✔ 防漂移句、修剪/小而准；未采纳：每 turn 抽取、Sonnet 召回 |
| hermes | 有（钩子最多） | 每轮前后/会话结束/压缩前 | 可插拔 provider（mem0 等） | md + 外部 | 无（钩子矩阵过重） |
| cherry-studio / deepagents / Kun | 半自动 | 模型 inline 判断 | 主模型工具 | FACT.md / AGENTS.md / JSON | 无新增（Reina inline 通道已等价） |
| maka-agent | 反自动化 | 仅用户确认 | 契约门控 | JSON，embedding 硬禁 | 隐私门思路（未需要） |
| opencode / kimi-code / pi / openagent | 无 | — | — | — | — |
| memmy-agent（MemTensor/MemOS，外置层） | 有（第三种架构） | 守护进程扫外部 agent 的 transcript 目录，后台抽取 | 自带管线（BYOK embedding + 处理模型） | 本地 Fastify + SQLite（`~/.memmy/`），local-first | 观察名单，见下 |

kimi-code 于 2026-07-17 pull 至 0.27.0（含 agent-core-v2）复核：`contextMemory` 是会话内消息
状态管理，`consolidate` 技能是 skill 目录整理，均非长期记忆。

**memmy-agent 单独说明**（2026-07-17 评估，当天刚发 v1.0.1 / 41 star）：跨工具统一记忆中枢，
证明了"不 hook 引擎、外扫 transcript"的外置架构成立——时机问题绕得开，但引擎侧的活
（索引每轮注入 prompt、notes UI、修剪、trace）它仍做不了，注入靠给 agent 装 Skill 引导模型
主动调本地 API（回到 inline 档）。不认识 Reina 的会话格式（支持 Cursor/CC/Codex/OpenCode/
Hermes），接入需自写导出器。**结论：不替代自建（引擎肌肉外面长不出来）；其独有价值是
跨工具共享记忆（Reina↔Claude Code 的记忆孤岛只有外置层能解）。触发条件：项目存活 3 个月+
且支持列表扩大后，经 skill 机制零改动试水。**

## 7. 蓝图（评估过、暂不做）

按当时的方案阶梯编号，触发条件写明，避免将来重新论证：

- **① 材料下钻**：给 memory-consolidate profile 加会话检索工具，让固化代理对高价值 session
  自己钻取（简报降级为目录）。触发：发现固化产物质量明显受限于"短会话只有标题"。
- **③ 抽取搭便车**：compaction summary 调用顺手输出 ≤3 条持久事实候选进 SQLite 候选池。
  触发：①仍不够，且长会话占比高。
- **④ 使用追踪**：notes 加 `lastRecalledAt`（read_note / 搜索命中时戳），固化按"30 天未用"
  归档。触发：修剪轻量版压不住笔记本膨胀。
- **⑤ 工作区切换触发**：切走项目的瞬间该项目会话天然全闲置，语义比 turn 边界准。
  触发：turn 边界检查被证明错过明显的固化窗口。
- **⑦ 索引策展上限**：给全局笔记索引设硬行数上限（claude-code MEMORY.md 200 行式），
  上限本身是质量强制函数。触发：注入段膨胀接近 CAP=40。

## 8. 关键文件

- [packages/core/src/controllers/memory.ts](../packages/core/src/controllers/memory.ts) —— 门槛/材料/检索/固化的全部策略
- [packages/core/src/engine.ts](../packages/core/src/engine.ts#L1586) —— `maybeConsolidateMemory` / `runMemoryConsolidation`（子引擎编排）
- [packages/core/src/profiles/builtin.ts](../packages/core/src/profiles/builtin.ts#L173) —— `memory-consolidate` profile（bypass + note 白名单）
- [packages/core/src/engine-prompt.ts](../packages/core/src/engine-prompt.ts#L529) —— 全局笔记注入 + inline 指引 + 防漂移句
- [packages/core/src/store/session-store.ts](../packages/core/src/store/session-store.ts) —— `listRecentSessionBriefs` / `countSessionsUpdatedSince`（idle 上界）
- [packages/core/src/controllers/memory.test.ts](../packages/core/src/controllers/memory.test.ts) —— 门槛/材料/信号的全部行为测试
