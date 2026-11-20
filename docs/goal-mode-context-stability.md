# Goal Runtime Context Stability

本文记录 Goal v2 的上下文边界。Goal 已不再是 `SessionMode`，也不再通过
`activeGoals` 或 autopilot 镜像驱动；它是宿主拥有的持久状态，由独立 runtime
在 turn 边界续跑。

## 基本边界

一次 provider 请求开始后，本轮可见上下文已经固定。流式输出期间更新
`SessionState` 不会改变正在生成的内容。因此上下文安全必须发生在每次模型请求
之前，而不是等输出结束后补救。

这条规则覆盖：

- 用户发起的首轮请求；
- 工具结果回流后的 follow-up；
- Goal runtime 的自动 continuation；
- 异步任务结果注入后的唤醒；
- context-too-long 的恢复重试。

`continueLoop()` 在每次 `nextModelTurnStream()` 之前执行 request-aware preflight。
估算对象是将要发送的真实请求，包括 system prompt、volatile context、tools
schema、model messages、pending observations 和输出预留；接近窗口时先 compact，
必要时再 trim oversized observations，而不是依赖 provider 报错。

## Goal 上下文如何注入

Goal 的当前状态由 `GoalState` 持久化：

- `current`：唯一当前 Goal；
- `history`：已替换或结束的 Goal；
- `run`：本次 active span 的基线、轮数、停滞计数和 verifier 反馈；
- `completionClaim`：等待独立校验的完成声明；
- `revision`：状态机乐观并发版本。

Objective、状态、usage、round 和 revision 都会变化，因此它们不进入缓存 system
prompt，而是作为可 diff 的 volatile context 注入。这样每轮状态更新不会无条件
击穿稳定的 system/tools 前缀。

Continuation 使用 `ephemeral` user anchor，只进入模型上下文，不显示为普通用户
气泡。每轮只保留一个有边界的模型请求；不存在无限流式输出或宿主 while-loop。

## Idle continuation gate

一轮结束后，agent host 才会询问 `GoalRuntime.maybeAdvance()`。以下条件全部满足才
会启动下一轮：

- 当前 Goal 为 `active` 且存在 `run`；
- session 未 interrupt；
- 没有 queued user input 或 steer；
- 没有 pending approval / question；
- 没有另一条 Goal advance 正在执行；
- token、turn、wall-clock、continuation-round 预算均未耗尽；
- 连续无进展轮数未达到停滞上限。

用户输入总是优先于自动 continuation。Stop 会先通过状态机把 active Goal 写成
`paused`，再中断当前 turn，因此 idle 边界不会把它重新唤醒；恢复必须是显式用户
操作。

## Usage 与预算

Goal usage 使用 session usage 的基线差值计量，而不是把创建 Goal 之前的消耗算入
预算。Pause 会结算当前 span，Resume 建立新基线：

- `tokenBudget`：input + output tokens；
- `turnBudget`：Goal span 内的 turns；
- `wallClockBudgetMs`：active spans 的累计时间；
- `maxContinuationRounds`：宿主自动续跑安全上限，默认 50；
- `stagnationLimit`：连续无新 progress key 的上限，默认 3。

达到任一上限会通过状态机写成 `blocked`，并记录明确的 terminal reason，不再靠
autopilot 的 `doneStatus` 镜像推断。

## 完成校验

模型调用 `update_goal(status=complete, evidence=...)` 只会创建 completion claim，
不会直接关闭 Goal。独立 verifier 审阅压缩执行轨迹后：

- 通过：`verification_passed` 将 Goal 写成 `complete`；
- 拒绝：`verification_rejected` 清除 claim，把反馈写入 run，并继续下一轮；
- 用户在校验期间 pause/edit/replace：claim 失效，迟到 verdict 以 `STALE_CLAIM`
  拒绝。

## 持久化与恢复

每个被接受的 Goal command 都生成包含完整 `GoalState` 的 `goal_event`，同时：

- 追加 rollout JSONL；
- 发出 `goal-state-changed` 给 renderer；
- 立即刷新 SessionStore 投影。

runtime/verifier 可能在普通 turn 已结束后改变状态，因此不能只依赖下一次 turn
boundary 持久化。历史 `session_goal`、`activeGoals`、`sessionModes.goal` 和
Goal-backed `autopilot.activeGoalId` 仅在 replay/load 时迁移，Goal v2 不再写入它们。

## 验收场景

- `/goal` 在首个模型请求前已经产生一个 current Goal；
- 同义重复 create 返回 `changed:false`，不增 revision、不追加 history；
- 不同 unfinished Goal 必须显式 `/goal --replace`；
- active Goal 的模型工具只有 `get_goal` / `update_goal`，`create_goal` 被机械过滤；
- pending question、approval、queued input 和 interrupt 都阻止续跑；
- Stop 后 Goal 为 `paused`，idle wake 不会重启；
- compaction 前后 Goal 状态保持，但 system/tools 缓存前缀稳定；
- verifier claim 在通过前保持 active，迟到 verdict 不能覆盖新状态；
- rollout replay 和 SQLite snapshot 得到同一 GoalState。

## 结论

Goal 长跑的稳定性来自四个结构边界：宿主拥有状态、turn-boundary continuation、
每次模型请求前 preflight、以及独立 completion verifier。Prompt 只负责让模型理解
当前状态，不再负责创建或同步状态。
