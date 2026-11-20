# Reasoning 上下文回填：Reina vs Codex / Claude Code / pi

研究日期：2026-06-02

> Status: **已实现**（方案 B，分 4 阶段落地）。下文"改造方案"为原始计划；末尾"实现记录"为实际落地与对计划的偏差。
> 选定方向：**方案 B（跨轮持久化 + 回放 reasoning）**，对齐 codex / pi / claude-code。

## 结论（TL;DR）

"think / reasoning 内容算不算进上下文" 在 Reina 里取决于 provider 路径，而且三条路径不一致：

- **Anthropic（`anthropic-messages`）**：工具循环内带 signature 重放 ✅；跨轮丢弃。
- **OpenAI-Chat（`openai-chat`）**：工具循环内在带 `tool_calls` 时回填 `reasoning_content` ✅；跨轮丢弃。
- **OpenAI-Responses（`openai-responses`）**：**连工具循环内部都不回填 reasoning** ❌。最破的一条，而它恰是 o 系列 / gpt-5 走的路（[`packages/providers/src/index.ts`](../packages/providers/src/index.ts) 第 101-110 行 dispatch）。

根因还有一层架构问题：Reina 在 `ChatMessage` 上把 reasoning 压成了一个**纯展示字符串**（`reasoning?: string`，见 [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) 第 122-132 行），落地时丢掉了 signature / encrypted_content 结构。即便想跨轮回放也回放不了。

### 三个参考都是方案 B（核实结论）

| 参考 | 方案 | 证据 |
|---|---|---|
| **Codex** | **B** | `for_prompt`（"返回准备发给模型的历史"）的发送过滤器 `is_api_message` **把 reasoning 算进去**（[`参考/codex/codex-rs/core/src/context_manager/history.rs`](../参考/codex/codex-rs/core/src/context_manager/history.rs) 第 481-487 行）；`normalize_history` 只丢孤立 call/output 与图片，**不丢 reasoning**（第 366-375 行）；并有跨轮 reasoning 的 token 估算（第 279-332 行）。 |
| **pi** | **B** | Responses 路径 `include: ["reasoning.encrypted_content"]`（[`参考/pi/packages/ai/src/providers/azure-openai-responses.ts`](../参考/pi/packages/ai/src/providers/azure-openai-responses.ts) 第 282 行）；Anthropic 路径 `thinkingDisplay: "omitted"` 文档原话——"encrypted signature still travels back for **multi-turn continuity**"（[`参考/pi/packages/ai/src/providers/anthropic.ts`](../参考/pi/packages/ai/src/providers/anthropic.ts) 第 212-217 行）。 |
| **Claude Code** | **B** | 行为观察：thinking 块留在历史 content 跨轮发回（打 cache_control 时跳过 thinking 块；带 orphan filter 防 signature mismatch 400）。 |

**没有任何参考停在"只轮内回填、跨轮丢弃"这一档**——那一档恰好是 Reina 现在 Anthropic/Chat 两条路径的现状。要"对齐其他 agent"，目标就是 B。

## Reina 现状

provider 分发：[`packages/providers/src/index.ts`](../packages/providers/src/index.ts) 第 101-110 行，按 `config.provider` 显式路由到三个 turn 函数。

### 历史消息转换器——三个都丢弃 reasoning

历史 `request.messages` 转成各家 API 形态时，只输出 `role` + `content`（+ 附件），`ChatMessage.reasoning` 字段全部被丢：`toOpenAIChatMessages`（第 1141-1149 行）、`toAnthropicMessages`（第 1201-1211 行）、Responses 路径 message map（第 603-609 行）。

### 轮内回填靠 `providerState`（不跨轮）

`providerState` 是工具循环的续接状态，在轮边界即清空（`commitProviderState`，[`packages/core/src/engine.ts`](../packages/core/src/engine.ts) 第 423-431 行；清空时机：换 agent 924 / 换 model 941 / steer 2264 / 循环上限 2462）。三条路径轮内行为：Anthropic 重放 `state.assistantContent`（含 `thinking`+`signature`，第 766-768 行）；OpenAI-Chat 在带 tool_calls 时回填 `reasoning_content`（第 443-444 行）；Responses 完全不回填（第 601-616 行）。

### 持久化现状

`messages` 表的 `reasoning` 是**纯 TEXT 列**（[`packages/core/src/store/schema.ts`](../packages/core/src/store/schema.ts) 第 139 行），只存展示字符串。读写路径：`session-store.ts` 第 478/487、947/958（写）、1007/1025（读）。**没有**结构化 reasoning（signature / encrypted_content）的落地位置。

## 关键设计约束（决定 B 的形态）

**reasoning 块不可跨 provider / 跨模型移植。** Anthropic thinking 块的 `signature` 只对同一 Anthropic 模型有效；OpenAI Responses 的 `encrypted_content` 只对同族模型有效；DeepSeek/Qwen 的 `reasoning_content` 是明文。签名/密文对不上 → 400。

因此 B 必须遵守：

1. **按 provider + model 打标存储**结构化 reasoning，而非通用块。
2. **replay 前做匹配门控**：只回放与当前请求 `provider` + `model` 一致的块；用户中途换模型/换 provider → 丢弃 reasoning 块，**降级为只发 content**（绝不把陈旧签名发出去）。
3. **孤儿/不匹配过滤**：对齐 CC 的 `filterOrphanedThinkingOnlyMessages` 与"剥离末尾 thinking"，避免连续 assistant 消息签名错配导致 400。

这也是 Reina 当初"压成展示字符串"的合理之处——B 等于主动接下这块复杂度，收益集中在**同模型多轮会话**（常见场景），并在换模型时优雅降级。

## 改造方案（方案 B，分阶段）

每个阶段独立可测、可单独提交。

### Stage 1 — 协议 + 存储地基（无行为变化）

- `ChatMessage` 新增可选字段，例如 `reasoningParts?: ReasoningPart[]`，`ReasoningPart` 携带 `{ provider, model, kind: "thinking"|"encrypted"|"text", text?, signature?, encrypted? }`。保留现有 `reasoning?: string` 仅作 UI 展示。**纯增量，向后兼容**（codegraph 显示 `ChatMessage` 有 14+ 引用点，但加可选字段不破坏现有调用方）。
- `ModelTurn`（protocol）新增对应的结构化 reasoning 输出（块数组 + provider/model 标记），与现有 `reasoning: string` 并存。
- session-store：迁移加一列 `reasoning_parts TEXT`（JSON），更新 `appendMessage`/批量插入/加载三处读写（schema.ts:139 区、session-store.ts 478/947/1007）。走现有 `migrate(db)` 机制。
- 验证：存取 round-trip 单测；旧库（无新列）能正常加载。

### Stage 2 — provider capture（产出结构化 reasoning）

让三个 turn 函数在返回 `ModelTurn` 时带上结构化 reasoning：

- **Anthropic**：已有 `finalMessage.content` 里的 `thinking` 块（含 signature），直接收进 `reasoningParts`（providerState 的 `assistantContent` 已经在用，复用即可）。
- **OpenAI-Responses**：请求加 `include: ["reasoning.encrypted_content"]`（与第 644 行 `reasoning:{effort,summary}` 同处）；从 `finalResponse.output` 收集 `type:"reasoning"` item（含 `encrypted_content`）。SDK 4.104 类型可能不全，按第 647-650 行 `prompt_cache_key` 的窄 cast 先例处理。
- **OpenAI-Chat**：把 `reasoning_content` 收成 text 型 part。
- 验证：mock 各家流，断言 `ModelTurn.reasoningParts` 带正确 provider/model 标记。

### Stage 3 — 转换器回放（核心，带门控）

改三个转换器，把历史消息里 provider+model 匹配的 `reasoningParts` 重新组装进 API 形态：

- **Anthropic**：assistant 消息 content 前置 `thinking` 块（带 signature）。
- **OpenAI-Responses**：在 input 里按 **`reasoning item → function_call → function_call_output`** 的 call_id 顺序插入。⚠️ 当前 `baseInput`（第 601-616 行）**连历史 `function_call` item 都没重建**，只塞了 `function_call_output`——所以这步要顺带补上工具调用项的结构化重建。
- **OpenAI-Chat**：assistant 消息回填 `reasoning_content`。
- 门控：provider/model 不匹配 → 跳过该消息的 reasoning（只发 content）；加 orphan/末尾 thinking 过滤。
- 验证：换模型场景断言 reasoning 被丢弃；同模型多步工具循环断言 call_id 对齐、顺序正确、无 400。

### Stage 4 — token 计量 + 压缩

- reasoning 现在进上下文，要计入：更新 `measureModelRequest`（engine:3598）让 reasoning 块计入 token 估算，对齐 Codex 的"避免重复计数"（服务端已计费的本轮 reasoning 不二次估算，参见 `get_total_token_usage`）。
- 压缩：`modelMessages`/`modelMessagesWithToolOutputs`（engine:3478/3494）经压缩切片后，确保不产生孤立 thinking 消息（复用 Stage 3 的过滤）。
- 验证：压缩前后 reasoning 一致性；token 计量回归。

## 风险与回归面

- **签名/密文错配 400**（最高）：换模型、压缩切片、rollback（engine:1557）都可能制造孤立或陈旧 reasoning。Stage 3 的门控 + 过滤是关键，必须有换模型与压缩的针对性单测。
- **call_id 对齐**（Responses）：历史 function_call item 重建顺序/字段不对会 400。
- **SDK 类型**：`include` / reasoning item / encrypted_content 在 SDK 4.104 可能类型不全，需窄 cast。
- **跨 provider-compat 后端**：部分 OpenAI-compat 后端不支持 `include: ["reasoning.encrypted_content"]`，需"400 则去掉重试"降级（参考 Anthropic cache 的降级路径）。
- **上下文膨胀 / 成本**：跨轮保留 reasoning 会增加 input token。需确认与现有 prompt cache、压缩阈值的相互作用（见 [`docs/cache-hit-improvement-plan.md`](./cache-hit-improvement-plan.md)、[`docs/context-compaction.md`](./context-compaction.md)）。

## 验证

- 单测优先覆盖：(a) 同模型多步工具循环 reasoning 回放且 call_id 对齐；(b) 换模型/换 provider 时 reasoning 被丢弃只发 content；(c) 压缩/rollback 后无孤立 thinking；(d) store round-trip + 旧库兼容。
- `codegraph affected packages/protocol/src/index.ts packages/providers/src/index.ts packages/core/src/store/session-store.ts packages/core/src/engine.ts` 选出受影响测试后运行。
- 真机：`openai-responses` reasoning 模型 + Anthropic 模型各跑一遍多轮工具任务，确认推理在轮间不再"断片"，且换模型不报 400。

## 实现记录（Implemented 2026-06-02）

落地与原计划基本一致，关键偏差与决策如下。

### 实际改动

- **Stage 1 — 协议 + 存储**：`ReasoningTrace = { provider, model, blocks: unknown }`（与 `ProviderState` 同构，blocks 对 protocol/engine 不透明，各 provider 自解释）；`ChatMessage.reasoningTrace?` + `ModelTurn.reasoningTrace?`（[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)）。schema 迁移 v6 加 `messages.reasoning_trace TEXT`（[`migrations.ts`](../packages/core/src/store/migrations.ts)、`CURRENT_SCHEMA_VERSION=6`），session-store 三处读写 JSON 序列化。engine 在创建 assistant 消息处写入 `turn.reasoningTrace`。
- **Stage 2 — capture**：Anthropic 收 `thinking`/`redacted_thinking` 块（带 signature）；Responses 请求加 `include: ["reasoning.encrypted_content"]` 并收 `reasoning` item；Chat 收 `reasoning_content`。三者都打 provider+model 标记（[`packages/providers/src/index.ts`](../packages/providers/src/index.ts)）。
- **Stage 3a — Responses 轮内回放**：新增 `OpenAIResponsesState` providerState，存该轮 `reasoning + function_call` 有序 item，下一请求在 `function_call_output` 前重放（call_id 对齐）。这是对原"硬伤"的核心修复，做法与 Anthropic 的 `assistantContent` 重放对称。Responses 是 item 列表（非交替角色），故可安全在历史消息后追加这些 item。
- **Stage 3b — 跨轮回放**：`toAnthropicMessages` 把签名 thinking 块前置到历史 assistant 消息（thinking 在前 + text）；Responses 把加密 reasoning item 紧贴其 assistant 消息之前。门控 `replayableTrace`：reasoning 本轮开启 + provider/model 完全匹配 + 非当前工具轮（providerState 已管）+ `message.content` 非空（避免孤立 thinking 的 400）。
- **Stage 4 — token 计量**：`measureModelRequest` 按同一门控把回放的 reasoning 块序列化长度计入 messages token，避免自动压缩触发过晚（encrypted_content 远大于可见 summary）。

### 对计划的偏差

1. **Chat 路径不做跨轮回放**。DeepSeek/Qwen 明确拒绝在历史 assistant 轮回传 `reasoning_content`，强行回放会报错。其轮内 echo（唯一被这些后端接受的场景）本就由 `providerState` 处理，保持不变。故 3b 只覆盖 Anthropic + Responses。
2. **跨轮回放无条件默认开启，对齐 codex/pi/claude-code**（它们都无条件把 reasoning 留在历史里发回，没有开关）。安全完全靠逐条 `replayableTrace` 的 provider+model+reasoning-on 门控（换模型/关推理即自动丢弃陈旧签名），不需要额外的 env 开关。
3. **跨轮 Responses 用"reasoning-before-message"而非重建 function_call**。已完成（出文本答案）的历史轮没有 function_call 可锚，直接把加密 reasoning 紧贴其 assistant 消息之前即可；带工具调用、被拍平成空内容的历史轮跳过（其连续性由 3a 的 providerState 覆盖）。这避免了原计划担心的"跨轮 function_call 重建"。

### 测试 / 验证状态

- 新增/通过单测：store v5→v6 迁移 + round-trip（33）；provider capture ×3（Stage 2）；replay（Stage 3a 轮内顺序+linkage、fresh-turn 不回放；3b Anthropic 同模型回放、跨模型不回放、reasoning 关时不回放、Responses reasoning-before-message）。core+providers+protocol 全量通过，`tsc -b` 干净。
- **Live 验证（2026-06-02）**：跨轮回放已对真实 Anthropic-compat 端点验证通过——`glm-5.1` / `glm-5-turbo`（bigmodel.cn）、`deepseek-v4-pro`（deepseek.com/anthropic）、`kimi-for-coding`（kimi.com/coding）四个模型，turn 1 都产出带 signature 的 thinking 块,turn 2 回放后端**均接受、无 400**。测法:临时 vitest 集成测试调真实 `nextModelTurn` 跑两轮(已删除)。
- **未覆盖**：Stage 4 的 token 计量无独立单测（measureModelRequest 私有 + 需 mock 真实 provider，scaffolding 成本不成比例；逻辑是已测回放门控的镜像）。**`openai-responses` 路径(encrypted reasoning)未经 live 验证**——当前 models.json 无该 provider 模型;若以后接入 o 系列/gpt-5,需单独跑一遍确认 encrypted reasoning item 的顺序被接受。轮内工具循环回放(3a Responses / Anthropic)未单独跑多工具实测,但 Anthropic 轮内是线上既有模式。
