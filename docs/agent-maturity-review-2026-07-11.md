# Reina Agent 成熟度独立复核备忘录

> 状态：待独立复核  
> 评估日期：2026-07-11  
> 仓库分支：`main`  
> 评估基线：`77f3f38eea8ece9f1377cdb301c166327fa2931c`

## 1. 复核目标

本文用于让另一名 Agent 独立判断 Reina 当前是否已达到可稳定使用的成熟度，并验证下列初步判断是否成立。

本文不是整改方案，也不授权修改代码。复核者应先检查证据、尝试证伪，再给出自己的成熟度结论。若发现问题，只记录问题、影响、证据和建议验证方式。

建议分别回答三个问题：

1. Reina 是否适合个人开发者日常使用？
2. Reina 是否适合长时间、有人监督的自主任务？
3. Reina 是否适合无人值守或企业级生产环境？

## 2. 复核范围

本次范围聚焦 Agent 本身，不以桌面 UI 的视觉完成度或市场定位作为主要判断依据。

重点检查：

- Agent 主循环与停止条件
- 模型调用、重试和上下文恢复
- 工具发现、工具执行和权限审批
- 子 Agent、异步任务、工作树隔离和恢复
- 会话持久化、异常恢复和可观测性
- 系统提示词和工具描述的上下文成本
- 测试、构建、行为评测和质量门禁
- 代码结构是否便于继续演进

不在本次范围：

- 对所有工具逐项进行安全审计
- 对第三方模型服务进行真实付费压测
- 安装包签名、发布渠道和商业运营成熟度
- 直接修改、重构或提交代码

## 3. 当前验证基线

以下命令已在上述基线提交上执行。复核者应重新运行，不应直接采信本文结果。

| 检查            | 当前结果                       | 复核命令                     |
| --------------- | ------------------------------ | ---------------------------- |
| TypeScript 检查 | 通过                           | `npm run check`              |
| 测试            | 80 个测试文件、1084 项测试通过 | `npm test -- --reporter=dot` |
| Lint            | 0 error、177 warning           | `npm run lint`               |
| 桌面构建        | 通过                           | `npm run build:desktop`      |
| 工作树          | 验证后保持干净                 | `git status --short`         |

测试通过只能证明已编码的不变量当前成立，不能单独证明 Agent 在真实任务中的行为质量。

## 4. 已确认的实现能力

以下内容可以直接从实现和测试中确认，但仍请复核者检查是否存在被遗漏的反例。

### 4.1 主循环不是演示级实现

核心入口为 `packages/core/src/engine.ts:1368` 的 `runTurn`，工具循环位于 `packages/core/src/engine.ts:2535` 的 `continueLoop`。

当前实现包括：

- 流式模型调用和中断
- 可重试错误的指数退避
- OAuth 订阅令牌刷新后单次重试
- 上下文溢出的观察裁剪与自动压缩恢复
- 异常 `finish_reason` 和空响应修复
- 附件请求体预算
- 工具结果持久化与截断后重新读取指针
- 一次性提醒、持久模式提醒和动态上下文提醒

### 4.2 有执行层防死循环机制

`packages/core/src/loop-budget.ts:21` 的 `ToolLoopBudget` 实现了：

- soft step budget 和 hard step limit
- 无进展轮次检测
- 相同动作重复检测
- 连续错误检测
- 有进展时动态扩展预算

`packages/core/src/engine.ts:3310` 还会阻断连续重复的相同失败调用。`packages/core/src/storm-breaker.ts` 对高频重复、特别是修改性动作提供另一层保护。

### 4.3 权限不只依赖提示词

工具调用在执行前经过描述符解析、持久权限规则、会话权限模式、预览和审批。相关主分支位于 `packages/core/src/engine.ts:3039` 至 `packages/core/src/engine.ts:3181`。

已实现的模式包括：

- `plan`
- `default`
- `accept-edits`
- `bypass`
- `bubble`

`packages/core/src/tool-dispatch.ts:118` 还会在执行时再次拒绝子 Agent 禁用工具，避免只在工具列表层过滤。

### 4.4 子 Agent 生命周期较完整

`packages/core/src/subagent/manager.ts` 包含同步和异步派发、任务去重、watchdog、心跳、恢复、取消、结果汇总和工作树清理。

异步 fork 子 Agent 会：

- 继承父级的必要上下文
- 将需审批动作 bubble 到父级
- 将问题升级到父级与用户
- 记录子任务状态和 token 用量
- 在隔离模式下创建、清理或保留工作树

### 4.5 持久化和恢复有明确设计

会话事件持续写入 JSONL，轮次边界再写 SQLite 快照。测试覆盖了破损 JSONL 尾行、会话重放、异步任务状态、SQLite 查询和部分崩溃恢复场景。

这比只在正常结束时保存整份会话更可靠，但仍需要桌面进程级故障注入验证。

## 5. 待独立复核的发现

本节不是最终结论。每项均标明当前证据状态，复核者应优先尝试证伪。

### F-01：默认全局提示词可能诱导过度执行

- 初步严重度：高
- 当前状态：已确认提示词存在；实际行为影响尚需评测
- 置信度：高

`packages/core/src/engine-prompt.ts:27` 的 `buildSystemPrompt` 会向每个 Agent 注入 `geniusPrompt`。其内容位于 `packages/core/src/agent-guidance.ts:46`，包括：

- “永远做得比要求的更多”
- “要求 5 个方案，给出 7 个以上”
- “不交出第一个想法”
- “给出方案后再推向更大的可复用问题”

同一文件的 supervisor/worker 指导又要求直接执行、保持范围和避免不必要委派。两组指令在分析任务上可能互补，但在编码、修复和严格格式任务上可能冲突。

复核方法：

1. 设计 10 个明确限制范围的任务，例如“只改一行”“只给 3 项”“不要扩展功能”。
2. 对比启用和移除 `geniusPrompt` 时的工具调用数、改动行数和格式遵守率。
3. 检查是否出现无关建议、超量输出或任务范围外修改。

应避免仅凭提示词措辞直接判定真实行为失败。

### F-02：默认冷启动上下文成本偏高

- 初步严重度：高
- 当前状态：已由仓库测试输出确认
- 置信度：高

`packages/core/src/prompt-size.test.ts` 当前输出约为：

- 系统提示：约 4820 tokens
- 21 个直接工具描述：约 5716 tokens
- 用户消息和历史加入前合计：约 10536 tokens

默认 profile 还通过 `packages/core/src/profiles/builtin.ts` 的 `extraDirectTools` 固定携带 Java 反序列化工具。它们对通用编码任务并非始终相关。

可能影响：

- 首轮请求成本和延迟增加
- 前缀缓存失效时重复付费
- 小上下文模型的有效任务空间被压缩
- 无关工具描述影响模型工具选择

复核方法：

1. 运行 `npx vitest run packages/core/src/prompt-size.test.ts`。
2. 分别统计通用工具、笔记工具和 Java 安全工具的描述成本。
3. 将 Java 安全工具改为 deferred 后做同任务 A/B，比较成功率、首 token 延迟和总输入 tokens。

### F-03：同步 `task` 可能没有完整的审批桥接

- 初步严重度：高
- 当前状态：代码路径差异已确认；用户可见故障尚未端到端复现
- 置信度：中

同步派发位于 `packages/core/src/subagent/manager.ts:378`。它默认使用父级工作目录，并通过 `spawnChild` 创建子 Agent。

异步 fork 路径在 `packages/core/src/subagent/manager.ts:704` 显式执行：

- `child.session.permissionMode = "bubble"`
- `child.setBubbleApprovalHandler(...)`

同步 `runSync` 路径未看到同样的 bubble handler 安装。子 Agent 默认继承父级权限模式，见 `packages/core/src/engine.ts:3533`。如果同步子 Agent 在 `default` 模式调用需要审批的写入或执行工具，它可能在自己的 `pending_approval` 上结束当前轮次，而父级没有可操作的镜像审批。

复核方法：

1. 使用 deterministic provider 增加一个同步 `task` 场景。
2. 让子 Agent 首轮调用 `write_file` 或需要审批的 `run_shell`。
3. 断言父会话是否出现可审批记录，以及批准后子 Agent 是否继续。
4. 同时验证拒绝、修改输入、中断和共享工作目录场景。

在端到端复现前，应将其记录为高风险缺口，不应表述成已确认生产故障。

### F-04：缺少 Agent 行为评测门禁

- 初步严重度：高
- 当前状态：未发现独立 eval 脚本或场景评测套件
- 置信度：高

根目录 `package.json` 提供类型检查、单元/集成测试、lint、格式检查和构建，但没有独立的 Agent 行为评测命令。

1084 项测试主要验证实现逻辑与协议不变量，无法回答：

- Agent 是否真的完成用户任务
- 是否进行了不必要的工具调用
- 是否遵守“不修改”“只输出 N 项”等限制
- 是否正确请求审批
- 是否重复委派或浪费 token
- 不同模型上的行为是否稳定

复核者应确认仓库其他位置是否存在未接入 `package.json` 的 eval 工具。如果没有，应将行为评测视为生产成熟度的主要缺口。

### F-05：`AgentEngine` 仍是高集中度核心

- 初步严重度：中
- 当前状态：已确认
- 置信度：高

`packages/core/src/engine.ts` 当前约 4726 行。虽然工具分发、controller、subagent manager 和多个子系统已经拆出，核心类仍同时协调：

- 模型循环和流事件
- 权限审批
- 会话与 rollout
- 上下文、压缩和 token 统计
- 子 Agent host adapter
- hooks、后台任务和自进化

大量 getter-backed host 设计说明团队已经意识到 session/abortController 被替换时的陈旧引用风险。这些防护是优点，也说明状态组合复杂度较高。

复核者应关注修改 `continueLoop`、`loadSession`、`rollbackToMessage`、`interrupt` 时的回归半径，而不是只以文件行数判断设计优劣。

### F-06：Lint 目前不是严格质量门禁

- 初步严重度：中低
- 当前状态：已确认
- 置信度：高

`npm run lint` 当前为 0 error、177 warning。警告主要来自测试中的显式 `any` 和 console，也包括生产代码中的未使用变量、无效 eslint-disable 和 `prefer-const`。

这不是运行时故障，但长期允许 warning 无上限增长，会降低新警告的可见性。

复核者应区分：

- 生产代码 warning
- 测试辅助代码 warning
- 构建/发布脚本 warning
- 网站静态脚本 warning

不要把 177 个 warning 等同于 177 个 Agent 缺陷。

### F-07：缺少桌面进程级 E2E 证据

- 初步严重度：中
- 当前状态：未发现常见 Electron E2E 测试入口
- 置信度：中高

仓库已有 renderer、IPC、agent-host 和 engine 测试，但未发现 Playwright、Spectron、WebDriver 或等价的 Electron 启动级 E2E 套件。

因此以下跨进程行为主要依赖分层测试：

- 工具审批弹窗到 Agent 继续执行
- 子 Agent bubble 审批和问题升级
- 正在运行时点击停止
- 进程退出后的会话恢复
- 模型设置和权限设置实时应用

复核者应确认是否存在外部 CI 或未按常见名称组织的桌面 smoke 测试。

### F-08：自进化功能需要持续关注持久化污染风险

- 初步严重度：中
- 当前状态：功能默认关闭，已有工具 allow-list 和路径保护
- 置信度：中

`selfEvolve.enabled` 默认值为 false。启用后，后台 `self-review` 子 Agent 会以受限工具集和 `bypass` 权限运行，将学习写入全局笔记和技能。

当前已有两层保护：profile 工具 allow-list，以及对技能写入路径的引擎限制。这降低了直接修改产品代码的风险。

仍需复核长期记忆污染问题：对话中的提示注入、错误结论或敏感信息是否可能被固化为跨项目规则。该问题不应被描述为默认开启的漏洞，但在启用自进化前应有内容来源、审计、回滚和敏感信息过滤策略。

## 6. 建议的独立复核顺序

复核者建议按以下顺序执行，避免先读结论后寻找支持材料：

1. 阅读 `CLAUDE.md` 和 `docs/file-navigation.md`。
2. 确认 Git 基线和工作树状态。
3. 使用 CodeGraph 追踪 `runTurn -> continueLoop -> executeRecord -> toolDispatch.run`。
4. 独立列出主循环已有的可靠性和安全机制。
5. 运行类型检查、测试、lint 和桌面构建。
6. 运行 prompt size 测试，记录实际 token 估算。
7. 尝试复现同步 `task` 的审批问题。
8. 搜索行为 eval 和桌面 E2E，确认是否确实缺失。
9. 最后再阅读本文第 7 节的初步成熟度假设。

建议命令：

```powershell
git rev-parse HEAD
git status --short
npm run check
npm test -- --reporter=dot
npm run lint
npm run build:desktop
npx vitest run packages/core/src/prompt-size.test.ts
rg --files | rg -i "(eval|benchmark|e2e|playwright|spectron|webdriver|smoke)"
```

## 7. 初步成熟度假设

本节故意放在证据和复核步骤之后。

当前初步判断为：Reina 已超过演示原型，属于可实际使用的 Beta+ Agent，但尚未达到无人值守或企业级生产成熟度。

参考分级：

| 使用场景                   | 初步判断         |
| -------------------------- | ---------------- |
| 个人开发者日常使用         | 基本成熟，可用   |
| 长时间、有人监督的自主任务 | 可用，但仍需监督 |
| 无人值守或企业级生产       | 暂不建议         |

初步综合评分约为 `7/10`。评分不应作为复核者的默认答案；如复核证据支持不同结论，应明确给出不同分数和原因。

## 8. 复核输出模板

复核 Agent 应使用以下格式提交结果：

```markdown
# Reina Agent 成熟度复核结论

## 总结

- 综合评分：X/10
- 个人使用：成熟 / 有条件成熟 / 不成熟
- 有人监督长任务：成熟 / 有条件成熟 / 不成熟
- 无人值守生产：成熟 / 有条件成熟 / 不成熟

## 已复现问题

### R-01：标题

- 严重度：高 / 中 / 低
- 复现步骤：
- 实际结果：
- 预期结果：
- 证据位置：

## 未复现但成立的风险

- 风险：
- 支持证据：
- 尚缺证据：

## 不成立或被夸大的原发现

- 对应发现编号：F-XX
- 反证：

## 遗漏的新问题

- 问题：
- 影响：
- 证据：

## 建议优先级

1. P0：
2. P1：
3. P2：

## 验证记录

- HEAD：
- 类型检查：
- 测试：
- Lint：
- 构建：
- 额外命令：
```

## 9. 复核纪律

- 不因测试全部通过就判定 Agent 行为成熟。
- 不因文件很长或 warning 很多就直接判定架构失败。
- 明确区分事实、推断、复现结果和个人偏好。
- 对高严重度问题提供可重复证据。
- 不修改代码来“顺手修复”发现的问题。
- 如果复核基线不是本文记录的提交，必须注明新提交并重新运行验证。
