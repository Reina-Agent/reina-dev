# Goal Runtime — Codex / Kimi Code Alignment

本文记录 Goal v2 已落地的结构。它不是待办计划；代码与本文不一致时，以
`packages/core/src/goal/` 的状态机和测试为准。

## 旧结构为什么会重复注册

旧实现同时把 Goal 当成三种东西：

1. `SessionMode`：`/goal` 先打开 mode；
2. 模型工具契约：prompt 要求模型再次注册目标；
3. autopilot 的结束 gate：`activeGoals`、`sessionModes.goal`、
   `autopilot.activeGoalId` 相互镜像。

宿主已经知道用户输入的目标，却仍要求模型“再注册一次”。后续 continuation 又会
看到相同规则，于是模型继续注册；controller、mode 和 autopilot 各自
判断“已存在”的时机不同，最终表现为重复调用与错误循环。

## 对齐原则

从 Codex 风格的任务运行边界保留：

- Goal 是 thread/session 的宿主状态，不是一段 prompt；
- 用户命令先改变状态，再开始模型 turn；
- continuation 只发生在 idle turn boundary；
- create 是幂等的，replace 是显式的；
- completion claim 与最终完成分离，由 verifier 决定终态。

从 Kimi Code 风格的交互边界保留：

- system/tools 缓存前缀尽量稳定，动态 Goal 放 volatile context；
- 普通 model stop 不等于自动重启，只有 Goal runtime 可以在 gate 通过时续跑；
- queued user input 和 steer 优先于自动 continuation；
- Stop 是明确的用户暂停，不允许 idle wake 偷偷复活任务。

Reina 没有照搬任何外部对象模型，而是把这些边界收敛到一个小状态机。

## 当前所有权

```text
用户 /goal、Goal 面板、Stop
        │
        ▼
desktop goal_command
        │
        ▼
AgentHost ── UserGoalCommand ──► AgentEngine
                                      │
模型 get/create/update_goal ──────────┤
                                      ▼
                                 GoalService
                                      │
                                      ▼
                                transitionGoal()
                                      │
                       goal_event + stream + persist

turn boundary ──► GoalRuntime ──► runtime/verifier commands
                                      │
                                      └── 同一个 GoalService / 状态机
```

只有 `GoalService.execute()` 可以把新的 `GoalState` 写回 session。UI、模型工具、
runtime 和 verifier 都只提交 command；它们不能直接改字段。

## 状态模型

`GoalState` 只有一份权威快照：

```ts
type GoalState = {
  current: GoalRecord | null;
  history: GoalRecord[];
  run: GoalRun | null;
  completionClaim?: GoalCompletionClaim;
  revision: number;
};
```

状态迁移是纯函数 `transitionGoal(state, command, actor, context)`。Actor 权限在状态机
边界执行：

- user：create/replace/edit/pause/resume/clear；
- model：create、claim_complete、claim_blocked；
- runtime：advance_run、budget_reached；
- verifier：verification_passed、verification_rejected；
- system：迁移与恢复。

`expectedRevision` 防止旧 UI 或旧模型快照覆盖新状态。重复同义 create 是成功 no-op；
不同 unfinished Goal 返回 `GOAL_EXISTS`，用户必须明确 replace。

## 一条命令链

`/goal <objective>` 的顺序固定为：

1. renderer 调用 `goal_command(create)`；
2. host 同步执行状态机并持久化；
3. renderer 收到 `goal-state-changed`；
4. 只有 `changed:true` 才启动 `goal_initial` turn；
5. 首个模型请求看到已经存在的 Goal，只暴露 `get_goal/update_goal`。

`/goal --replace <objective>` 是唯一快捷替换入口。再次提交同义 `/goal` 返回
`changed:false`，renderer 撤销 optimistic working/bubble，不会卡在“正在运行”。

## 动态工具策略

- 无 current Goal：`create_goal` 保持 deferred，只在用户明确要求时发现；
- active Goal：直接暴露 `get_goal`、`update_goal`，机械过滤 `create_goal`；
- paused/blocked/complete：只直接暴露 `get_goal`；
- Goal v1 工具适配器已经移除；旧 provider schema 或历史 rollout 中遗留的工具调用
  不再进入当前分发链。

## Runtime 与完成

`GoalRuntime` 只在 host 的 idle 边界运行，负责：

- 用户/HITL/interrupt gate；
- per-goal token、turn、wall-clock accounting；
- continuation round 和 no-progress 上限；
- completion claim 的独立校验；
- verifier 拒绝后的反馈续跑。

模型不能直接把 Goal 写成 complete。`update_goal(status=complete)` 先产生 claim；
verifier 通过后才进入 complete。Pause/edit/replace 会清除 claim，迟到 verdict 被状态
机拒绝。

## 兼容边界

以下字段只读兼容，不再是运行时写路径：

- `SessionState.activeGoals`；
- `session_goal` rollout item；
- `sessionModes.goal`；
- `autopilot.activeGoalId`；
- `ReinaConfig.autopilot.verify`（只作为旧配置读取 fallback）。

加载旧 session 时一次性迁移为 GoalState，并写入 `goal_event(kind=migrated)`。新设置
统一写 `ReinaConfig.goal`；legacy autopilot 仍可独立使用 `declare_audit_done`，但不再
参与 Goal v2 生命周期。

## 验证门禁

提交前至少运行：

```text
npm run check
npm test
npm run lint
npm run build --workspace=@reina/agent-host
```

真实协议验收应启动构建后的 `dist/packages/agent-host/stdio.cjs`，验证：

- `goal-state-changed` 早于首个模型请求；
- active Goal 的 tools 中无 `create_goal`；
- 同义重复 create 返回 `changed:false`；
- Stop 后状态为 paused，且没有新的 continuation；
- shutdown 能正常等待 turn 和持久化完成。
