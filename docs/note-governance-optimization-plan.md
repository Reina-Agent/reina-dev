# Note 规范与黑板优化计划

## 背景

Reina 已经有共享 Notes、Subtask DAG 和 AsyncTaskRecord。subagent 也能写入同一个 NotesService，所以当前问题不是“没有黑板”，而是黑板内容质量主要靠 prompt 约定。

Cairn 的优势在于每个探索结果都被强制写入结构化 Fact/Intent 图。Reina 不应该照搬 Cairn 的模型，但应该补上同类约束：重要结论必须可验证、可引用、可复盘。

## 目标

1. 让每条重要 note 都有稳定结构，方便模型、人和 UI 读取。
2. 让 subagent、Autopilot 产出的知识自动进入同一套规范。
3. 让长期任务可以从 Notes 恢复，而不是依赖旧对话和 AsyncTask result。
4. 保持实现轻量，优先使用现有 `status`、`tags`、`refs` 字段。

## 非目标

1. 不把 Reina 全量改成 Cairn 的 `Fact / Intent / Hint` 命名。
2. 不引入图数据库。
3. 不要求所有普通随手 note 都严格结构化。
4. 不在第一阶段阻断用户手写的非标准 note。

## 当前问题

### 1. note 可以写，但不保证有用

subagent 共享父 session 的 NotesService，能写 `.reina/notes`。但 runtime 不强制检查 note 是否包含证据、下一步、引用关系。

风险：长跑任务后留下大量自然语言流水账，后续模型很难从中继续推进。

### 2. 关键结果可能只留在 AsyncTaskRecord

subagent 完成后，结果会进入 `AsyncTaskRecord.result`。如果 subagent 没主动写 note，这个结果在后续压缩、重启、Autopilot 下一轮中不一定作为可靠知识层存在。

风险：一次子任务做了有效发现，但没有进入共享黑板。

### 3. refs 没有形成稳定因果链

Notes 支持 `refs`，但目前没有统一规则要求 decision、confirmed finding、dead-end 必须引用支撑它们的上游 note。

风险：复盘时只能看到结论，看不出结论从哪里来。

### 4. Autopilot 缺少可消费的 lead 队列

Autopilot prompt 会提醒读取 notebook 和写 note，但尚未把 `kind:lead` 视为明确待处理队列。

风险：长跑时可能凭模型下一轮自觉推进，稳定性弱于图驱动探索。

## Note 契约

### 元数据字段

沿用现有字段，不新增重 schema：

```yaml
title: string
status: open | confirmed | dead | todo
tags:
  - kind:<type>
  - component:<name>
  - file:<path>
  - sev:high | sev:med | sev:low
refs:
  - n_001
author: string
recipient?: string
```

### kind 标签

每条结构化 note 必须且只建议一个主 `kind:*`：

| kind | 用途 | 推荐 status |
| --- | --- | --- |
| `kind:finding` | 已观察到的事实或代码行为 | `confirmed` 或 `open` |
| `kind:lead` | 待探索线索 | `open` 或 `todo` |
| `kind:hypothesis` | 尚未验证的组合推测 | `open` |
| `kind:decision` | 已采纳的方案、判断、取舍 | `confirmed` |
| `kind:dead-end` | 已排除方向 | `dead` |
| `kind:artifact` | 报告、命令摘要、补充材料 | `open` 或 `confirmed` |

### 正文模板

结构化 note 正文统一使用四段：

```md
## Claim

一句话结论。必须具体，可被验证。

## Evidence

- 文件、函数、命令、日志、截图、复现步骤或相关 note id。
- 只放能支撑 Claim 的证据。

## Reasoning

为什么 Evidence 支持 Claim。写关键推理链，不写长篇思考过程。

## Next

下一步动作。若无需后续动作，写 `None`。
```

### 状态规则

| status | 要求 |
| --- | --- |
| `open` | 必须说明为什么还没确认，以及下一步怎么验证 |
| `confirmed` | 必须有 Evidence；若基于其他 note，必须有 `refs` |
| `dead` | 必须说明排除原因；若排除某条 lead/hypothesis，必须引用它 |
| `todo` | 必须有可执行的 Next |

### 质量红线

以下内容不应作为结构化 note 保存：

1. 只有“感觉可能有问题”，没有证据。
2. 只写过程，不写结论。
3. 只贴大段原始输出，没有摘要和引用。
4. `confirmed` 但没有 Evidence。
5. `decision` 但没有 refs 或理由。

## 工具行为优化

### 阶段 1: Prompt 规范

改动位置：

- `packages/tools/src/prompts/note.ts`
- `packages/tools/src/prompts/update-note.ts`
- `packages/core/src/engine-prompt.ts`
- `packages/core/src/agent-guidance.ts`

改动内容：

1. 在 `note` 工具说明中加入 Note 契约。
2. 在 subagent guidance 中明确：重要发现、线索、排除结论必须写结构化 note。
3. 在 Autopilot prompt 中明确：每轮优先处理 `kind:lead` 和 `kind:hypothesis`。

验证标准：

1. 子 agent 在审计任务中自然写出符合模板的 note。
2. `list_notes` 返回的标题、tags、status 足以判断下一步。
3. 不改 runtime 行为，风险低。

### 阶段 2: 软校验

改动位置：

- `packages/core/src/controllers/notes.ts`
- 新增 `packages/core/src/note-policy.ts`
- `packages/core/src/notes.test.ts` 或新增 `note-policy.test.ts`

新增能力：

1. `validateStructuredNote(input)` 返回 warnings，不直接拒绝。
2. 当 note 有 `kind:*` 时执行结构化检查。
3. 工具 observation 中返回 warnings，提醒模型修正。
4. UI 可选展示 warnings，但不阻断用户。

软校验规则：

1. 缺少 `kind:*`，提示补充。
2. `confirmed` 缺 Evidence，提示降级为 `open` 或补证据。
3. `decision` 缺 refs，提示引用支撑 note。
4. `dead` 缺排除原因，提示补充。
5. `lead/hypothesis` 缺 Next，提示补充验证步骤。

验证标准：

1. 非结构化普通 note 仍能写入。
2. 结构化 note 会得到稳定 warnings。
3. 测试覆盖每种 status/kind 的关键分支。

### 阶段 3: 子任务产物闭环

改动位置：

- `packages/core/src/subagent/manager.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/subagent/*.test.ts`

新增能力：

1. 记录 subagent 启动前的 note index。
2. subagent 结束后计算新增 note ids。
3. 把新增 note ids 写入 `AsyncTaskRecord` 或 `Subtask.resultSummary`。
4. 如果子任务没有新增 note，但结果非空，给父 agent 注入明确提醒。

建议先不要自动写兜底 note，先提醒父 agent：

```text
Worker task_x completed but produced no structured notes. Its result is only in AsyncTaskRecord. Promote any reusable finding, lead, dead-end, or decision into note(...).
```

验证标准：

1. 写了 note 的 subagent 不被重复提醒。
2. 没写 note 的 subagent 会触发提醒。
3. 父 agent 下一轮能看到“需要沉淀”的明确信号。

### 阶段 4: ~~Convene refs 修正~~（已取消）

> convene 功能已从代码库移除（commit 1759043），本阶段作废；相关 decision/turn note refs 契约不再适用。

### 阶段 5: Autopilot lead queue

改动位置：

- `packages/core/src/engine.ts`
- `packages/core/src/engine-prompt.ts`
- `packages/core/src/controllers/notes.ts`

行为设计：

1. `status=open` 且 `kind:lead` 或 `kind:hypothesis` 的 note 视为待处理项。
2. Autopilot 每轮提醒优先选择一个待处理项。
3. 处理后必须产生以下之一：
   - `confirmed` finding
   - `dead` dead-end
   - 更新原 lead 的 status
   - 新的更具体 lead
4. 没有 open lead、没有 running task、没有 active goal 时，才建议 `declare_audit_done(exhausted)`。

验证标准：

1. open lead 数量随轮次下降或被拆成更具体 lead。
2. Autopilot 不会连续多轮只做泛泛总结。
3. 上下文压缩后仍能继续消费 lead。

### 阶段 6: UI 与图视图

改动位置：

- `apps/desktop/src/renderer/actions/notes.js`
- `apps/desktop/src/renderer/actions/dag-view.js`
- `apps/desktop/src/renderer/styles/*.css`

UI 优化：

1. Notes 面板按 `status` 和 `kind` 分组。
2. 显示 soft validation warnings。
3. 对 `refs` 增加反向引用入口。
4. 只读图视图展示：
   - note refs 边
   - subtask blockedBy 边
   - async task produced note 边

验证标准：

1. 用户能从一个 decision 追到支撑它的 finding/turn。
2. 用户能快速看到剩余 open lead。
3. 图视图不改变数据，只做可视化。

## 最小可交付版本

第一版只做两个改动：

1. 更新 note 工具 prompt，引入正文模板和 kind/status 规则。
2. subagent 完成后提示“本次没有新增结构化 note”。

这两项能先解决“写什么”“没写怎么办”，风险最低。

## 成功指标

一次 10 到 20 分钟的审计任务应满足：

1. `list_notes` 能列出清晰的 open leads、confirmed findings、dead ends。
2. 至少 80% 的结构化 note 有 `kind:*`。
3. `confirmed` 和 `decision` note 至少 80% 有 Evidence 或 refs。
4. subagent 重要结果不会只存在于 `AsyncTaskRecord.result`。
5. 压缩上下文或重启后，agent 能基于 Notes 继续推进。

## 示例

### 好的 finding

```md
---
title: "settings IPC path accepts only known commands"
status: "confirmed"
tags: ["kind:finding", "component:desktop", "file:apps/desktop/src/main/ipc.ts"]
refs: []
author: "worker-a"
---

## Claim

The desktop IPC handler rejects unknown command names before dispatch.

## Evidence

- `apps/desktop/src/main/ipc.ts` validates incoming command names against the registered handler map.
- Unknown commands return an error instead of reaching command execution.

## Reasoning

Because dispatch is gated by the handler registry, an arbitrary renderer message cannot directly invoke an unregistered main-process operation.

## Next

None.
```

### 好的 lead

```md
---
title: "verify whether note update can break refs integrity"
status: "open"
tags: ["kind:lead", "component:notes"]
refs: ["n_012"]
author: "worker-b"
---

## Claim

Note update may allow refs to point at deleted or non-existent notes.

## Evidence

- `n_012` confirmed refs are used as causal links.
- Need to inspect update validation before confirming.

## Reasoning

If update accepts arbitrary refs without existence checks, graph traversal and future UI backrefs may become misleading.

## Next

Inspect `NotesController.update` and `NotesService.update`; confirm whether refs are validated.
```

### 坏的 note

```md
I looked around and notes probably need improvement. Maybe add validation later.
```

问题：

1. 没有 kind/status。
2. 没有 Claim。
3. 没有 Evidence。
4. 没有可执行 Next。

## 待定问题

1. 是否允许一个 note 同时有多个 `kind:*`。当前建议只允许一个主 kind。
2. 是否把 warnings 写入 note 文件。当前建议不写，避免污染知识层。
3. 是否对 Autopilot 模式启用严格拒绝。当前建议先 soft warning，观察效果后再收紧。
4. 是否需要 `confidence:*` 标签。当前不建议，避免模型用低置信度替代证据。
