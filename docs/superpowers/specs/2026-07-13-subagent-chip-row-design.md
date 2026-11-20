# Subagent 芯片行（AgentChipRow）设计

日期：2026-07-13
状态：已实现（方案 A，codex 式并行芯片行）。实现与本规格有两处偏差，
见文末"实现偏差记录"。

## 背景与问题

聊天时间线里 subagent 调用目前有两套互不相干的渲染：

- 同步 `task` 工具：普通 ToolCard（标题 "Task" + 截断 prompt），settled 后被
  `toolRunGroups.ts` 折进 "Ran N agents" 折叠组——并行跑了什么、各自进展如何
  完全不可见。
- 异步 `start_async_task`：运行中由 `SubagentPanel.tsx` 渲染一行式活动摘要，
  点开跳 Workspace 的 Agent Team 标签页；settled 后同样退化成普通 ToolCard。

参考 codex 的展示：每个并行 agent 一个彩色圆点芯片，芯片文本是任务名，
后缀状态文字，一行横排——并行度一目了然。用户确认两套统一为芯片行。

## 决策记录

- 覆盖范围：同步 `task` + 异步 `start_async_task` 统一（用户确认）。
- 点击交互：芯片就地展开详情，不强制跳窗口（用户确认）。
- 方案：A（并行芯片行）；B（每 agent 富卡片）因纵向占用大被否，
  C（ToolCard 换皮）因不解决并行一览被否。

## 1. 组件与视觉

新组件 `AgentChipRow.tsx`（`apps/desktop/src/renderer-react/src/windows/main/`）。
连续的 `task` / `start_async_task` 工具调用聚成一行 flex-wrap 芯片：

```
● Recheck dispose lifecycle · 运行中 read_file src/…   ● Recheck session approvals ✓ 1m 12s   ● Recheck rollout ✗
└──────── 点击任一芯片，行下方就地展开该 agent 详情（一次只展开一个）────────┘
```

- 芯片 = 彩色圆点 + 任务名 + 状态尾注。任务名取 `input.description`
  （缺省取 prompt 首行截断），不显示工具名。
- 圆点颜色按 taskId 哈希映射到约 6 个 base46 主题色 token（跟随主题切换，
  不硬编码 hex）。运行中圆点呼吸动画——无条件写，不加 reduced-motion 门
  （项目约定）。
- 状态尾注：
  - 运行中：最新一步活动 `工具名 · 目标`（来自 `subagentActivity`；无活动流
    时只显示"运行中"）。
  - 完成：✓ + 耗时。
  - 失败/取消：✗ + 简短原因。
- 展开区内容：任务 brief、agent profile 名、活动步骤列表（运行中实时增长）、
  最终结果 markdown（settled 后，即工具 output）、错误文本、
  "在 Agent Team 中查看 →" 链接（沿用 `openWorkspaceWindow({ tab: "agentTeam" })`）。
- CSS：`renderer-react/chat-styles/subagent-chips.css` 平 CSS（chat 窗口不用
  Tailwind），构建时随 `copy-legacy-chat-assets.cjs` 拷贝。

## 2. 数据流与关联（唯一的 core 触点）

- **持久形态**：芯片行渲染自 committed tool parts（`task` /
  `start_async_task`）。状态、耗时、结果都在 part 里——重载/回放后芯片仍在，
  只是没有实时尾巴。
- **实时形态**：live 阶段 running 的 task 族工具（`liveTools`）渲染为运行中
  芯片；实时活动尾巴复用现成的 `subagentActivity[taskId]`（同步与异步子代理
  都走 `bridgeChildStream`，已验证：同步 dispatch 在 manager.ts:483 桥接，
  且插入 `sync: true` 的 AsyncTaskRecord）。
- **toolCallId ↔ taskId 关联**：渲染层拿到的工具事件只有 tool-call id +
  input，`subagent-event` 只有 taskId，现状对不上。core 在 dispatch 处
  （同步与异步各一处）emit 一个小事件：

  ```ts
  { type: "subagent-dispatched", taskId, toolCallId: record.id }
  ```

  渲染层据此维护 toolCallId→taskId 映射，把 `subagentActivity[taskId]` 挂到
  对应芯片。这是唯一的引擎改动；改完需 `build:desktop` 重建（agent-host 是
  打包产物，直接跑旧 bundle 会静默拿不到新事件）。
- 同 brief 去重（`findLiveDuplicateDispatch`）保证 live 期间 (agent, brief)
  唯一，映射不会撞。dedup 命中时不 spawn 新子代理、无 subagent-dispatched
  事件，该次调用退化为无实时尾巴的普通芯片（settled 后有 output）。

## 3. 分组规则改动

- `toolRunGroups.ts`：
  - `task` / `start_async_task` 不再加入 run：从 `CATEGORY_BY_TOOL` 的 agent
    类别移除，`FRAGMENTS` 删除 "ran N agents" 措辞。
  - 遇到 task 族调用时断开当前 run，相邻的 task 族调用（含中间的
    reasoning-only 轮）聚成一个 chip-row 项，`ToolRunItem` 增加
    `{ kind: "chips", id, parts }` 变体。
- `Timeline.tsx`：`renderRunItems` 遇到 `kind: "chips"` 渲染 `AgentChipRow`；
  live 流里 running 的 task 族工具也走芯片（不再是 live ToolCard）。
- `pending_approval` 状态的 task 族调用不进芯片行：维持现有 live 审批卡片
  渲染，审批流（含 Bubbled 子代理审批）零改动；获批转 running 后再进芯片。
- `check_async_task` / `cancel_async_task` / `list_async_tasks` / `task_output`
  维持普通 ToolCard 不变。
- `SubagentPanel.tsx` 删除；`Timeline.tsx` 中对应渲染点（subagentActivity
  遍历）移除——异步任务的实时呈现统一由芯片行承担。

## 4. 错误处理

- 工具 part `status === "failed"`：芯片 ✗ 红色，展开区显示清洗后的错误文本
  （沿用 `cleanToolErrorForDisplay`）。
- `subagent-dispatched` 缺失（旧 bundle、dedup 命中、事件丢失）：芯片正常
  渲染，只是运行中没有实时尾巴——功能降级不报错。
- taskId 对应的 `subagentActivity` 在 turn 边界被清空：settled 芯片一律从
  part 读数据，不依赖 activity 存活。

## 5. 测试与验证

- `toolRunGroups.test.ts` 更新：task 族不进 run、相邻聚合成 chips 项、
  reasoning-only 轮不打断聚合、单个 task 也成 chips 项（单芯片行）。
- 新增纯函数层测试：芯片状态推导（running/completed/failed/cancelled +
  尾注文本）、taskId 哈希取色稳定性、toolCallId→taskId 映射。
- core 侧：`subagent-dispatched` 事件在同步/异步 dispatch 都发出（现有
  manager 测试文件旁新增断言）。
- 真机验证：`./start-desktop.cmd` + CDP 9333，跑一个并行双 subagent 会话，
  确认三个形态：运行中芯片实时尾巴、完成态（✓/✗ + 耗时）、重载回放。

## 实现偏差记录（2026-07-13 实现时确定）

1. **引擎零改动，`subagent-dispatched` 事件没有必要**。实现时核验发现
   `SubagentManager.upsertAsyncTask` 在记录创建时必发 `async-task-updated`
   （完整 AsyncTaskRecord：taskId + description + agent + status + sync），
   且同步 `task` dispatch 先插记录再跑子代理——渲染层直接消费该已有事件
   即可完成关联（brief 精确匹配，dedup 保证 live 期间唯一；settled 撞名
   取 startedAt 最接近者）。第 2 节设想的新事件与 agent-host 重建均不需要。
   关联逻辑在 `agentChips.ts`（`resolveChipTask`），roster 状态在
   sessionStore 的 `asyncTaskIndex`（async-task-updated / -injected /
   -evicted-batch 上插 + snapshot 合并，跨 turn 存活，会话切换重置）。
2. **reasoning-only 轮打断芯片行（而非折入）**。并行批次的 dispatch 在
   转录里天然相邻；跨 reasoning 轮的两次 dispatch 是时间上先后发生的两批,
   拆成两行芯片比合并进一行更诚实。规格第 3 节"含中间的 reasoning-only 轮
   聚成一个"未按原文实现。

## 范围外

- Workspace 的 Agent Team 标签页不动（仍是完整活动的家）。
- check/cancel/list 等 task 族外围工具的渲染不动。
- 引擎除 `subagent-dispatched` 事件外零改动；IPC 契约不动
  （事件走现有 model_stream 信封）。
