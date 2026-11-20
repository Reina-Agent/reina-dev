# Reina Context Compaction vs Codex

研究日期：2026-05-31

本文记录 Reina 当前上下文压缩实现与本仓库 `参考/codex` 中 Codex 实现的对比。本文只描述研究结论，不代表已经修改实现。

## 结论

Reina 当前实现已经从“让模型自己调用压缩工具”转向“宿主直接触发压缩操作”。桌面端发送 `compact_session`，`agent-host` 调用 `engine.compactNow()`，然后通过 `context-compacted` 事件更新 UI。这一点已经接近 Codex 的 `Op::Compact` / `thread/compact/start` 思路，比旧的合成 prompt 路径更可靠。

主要缺口不在“能不能压缩”，而在压缩生命周期、恢复后的记忆可用性、失败重试、自动压缩窗口基线，以及是否需要接入 Codex 风格的 provider-native remote compaction。

## Reina 当前链路

相关文件：

- [`packages/core/src/compaction.ts`](../packages/core/src/compaction.ts)
- [`packages/core/src/engine.ts`](../packages/core/src/engine.ts)
- [`packages/agent-host/src/index.ts`](../packages/agent-host/src/index.ts)
- [`packages/desktop-protocol/src/index.ts`](../packages/desktop-protocol/src/index.ts)
- [`apps/desktop/src/renderer/actions/prompt.js`](../apps/desktop/src/renderer/actions/prompt.js)
- [`apps/desktop/src/renderer/actions/agent-events.js`](../apps/desktop/src/renderer/actions/agent-events.js)

当前行为：

- `compact_session` 是桌面到 agent host 的直接控制请求。
- `agent-host` 找到对应 session 后调用 `session.engine.compactNow("user requested manual compaction")`。
- `compactNow()` 调用 `compactSessionContext()`，压缩完成后记录 compaction boundary 并发送 `context-compacted` 事件。
- 自动压缩通过 `shouldAutoCompactSession()` 判断上下文是否超过阈值。
- `session.messages` 保留完整可见 transcript，`session.modelMessages` 是压缩后的模型上下文视图。
- 压缩前的旧消息会写入 `.reina/conversation_history/<session-id>.md`。
- 压缩后会注入一个 model-only restored context message，包含 history path、最近文件片段、skills、memory files 等恢复信息。
- 桌面端手动压缩时会先显示一个 compacting divider，收到 `context-compacted` 后改成完成状态。

这套设计已经避免了旧问题：手动 `/compact` 不再需要靠模型决定是否调用内部工具。

## Codex 参考实现

相关文件：

- [`参考/codex/codex-rs/core/src/compact.rs`](../参考/codex/codex-rs/core/src/compact.rs)
- [`参考/codex/codex-rs/core/src/tasks/compact.rs`](../参考/codex/codex-rs/core/src/tasks/compact.rs)
- [`参考/codex/codex-rs/core/src/compact_remote.rs`](../参考/codex/codex-rs/core/src/compact_remote.rs)
- [`参考/codex/codex-rs/core/src/compact_remote_v2.rs`](../参考/codex/codex-rs/core/src/compact_remote_v2.rs)
- [`参考/codex/codex-rs/core/src/session/turn.rs`](../参考/codex/codex-rs/core/src/session/turn.rs)
- [`参考/codex/codex-rs/core/src/state/auto_compact_window.rs`](../参考/codex/codex-rs/core/src/state/auto_compact_window.rs)
- [`参考/codex/codex-rs/app-server/README.md`](../参考/codex/codex-rs/app-server/README.md)

Codex 有三类压缩路径：

- local compact：把 compact prompt 作为合成用户消息交给模型，总结完成后替换 history。
- remote compact：调用 provider 的 conversation history compaction 能力。
- remote v2 compact：向 Responses API 输入中追加 `CompactionTrigger`，期望服务端返回一个专门的 `Compaction` item。

Codex 的压缩是第一类 session 操作，不是普通聊天内容：

- 手动压缩通过 `Op::Compact` 或 app-server 的 `thread/compact/start` 触发。
- 客户端通过 item lifecycle 看到 `contextCompaction` started/completed。
- 压缩完成后 `replace_compacted_history()` 替换历史，并写入 rollout。
- 自动压缩可在 turn 前执行。
- 切换到更小上下文模型时，Codex 可以先用旧模型压缩，避免新模型直接超窗。

Codex 自动压缩还有一个重要机制：`AutoCompactWindow`。它记录压缩后的窗口 ordinal 和 prefill baseline，因此可以按 “BodyAfterPrefix” 范围触发压缩，而不是只看完整上下文 token。

## 主要差异

### 1. Provider-native compaction

Codex 支持 remote compact 和 remote v2 compact。Reina 当前只有本地 summary model call 和 extractive fallback。

影响：

- 如果目标是兼容通用 provider，Reina 当前方案更可控。
- 如果目标是贴近 Codex/OpenAI 官方后端能力，Reina 还缺 remote compaction 路径。

### 2. 历史替换语义

Codex local compaction 会保留最近真实 user messages，并把 summary 作为特殊 user-facing history item 放回上下文。remote v2 会保留 system/developer/user 等 prompt input 中的一部分消息，并追加服务端返回的 `Compaction` item。

Reina 会保留最近完整消息片段，包括 user/assistant/tool 相关上下文，并额外注入 restored context message。

影响：

- Reina 对本地代码任务可能更实用，因为最近工具输出和文件上下文能保留。
- Codex 更贴近其服务端协议和训练语义，尤其是 remote v2 的 `Compaction` item。

### 3. 自动压缩触发

Codex 使用 provider/server token usage，并通过 `AutoCompactWindow` 支持 total 和 body-after-prefix 两种范围。

Reina 使用 provider authoritative `usage.contextTokens` 或本地 tokenizer 估算，再对比 context window、buffer、trigger percent。

影响：

- Reina 实现更简单。
- ~~Reina 没有 prefix baseline，稳定系统提示、工具定义、恢复上下文等固定前缀可能影响触发判断。~~

更新（2026-06-04）：已实现 codex 风格的 body-after-prefix 窗口。`usage.autoCompactBaseline`
记录每次压缩后第一条 provider total（= 固定前缀大小），`shouldAutoCompactSession`
现在要求 `总量 ≥ 硬阈值` **且** `(总量 − baseline) ≥ body 预算`（默认 = 安全 buffer 的一半，
`REINA_COMPACTION_BODY_GROWTH_TOKENS` 可覆盖）才触发。压缩成功时引擎清掉 stale 的
`contextTokens` 和 `autoCompactBaseline`，下一条响应重新播种基线（对应 codex
`AutoCompactWindow::start_next`）。这修掉了 GLM 等弱模型上"压完基线仍在阈值之上、
每轮重复压缩只啃几条消息"的空转。注意：Reina 仍刻意保留 `modelMessagesWithToolOutputs`
的工具输出回放（弱模型需要），与 codex"压缩时丢弃工具输出"不同；body-after-prefix
让这些回放计入 baseline 而非反复触发，从而两者兼得。

显示口径对齐：上下文面板的「Estimate now」（`categories.autocompactEstimate`）此前用
`estimateSessionContextTokens`（仅裸 modelMessages+summary，对回放工具输出是盲的），
在重工具会话上比真实少 3-4 倍（如显示 ~20k 而 provider 真实 ~90k）。现已改为
`measureModelRequest` 已算出的 `activeTotal`（system+tools+reminders+pending+织入工具输出的
messages），与触发器真正比较的总量口径一致，面板不再误导。

### 4. 模型降级保护

Codex 在切换到上下文更小的模型时，会检测当前 token 是否超过新模型窗口或自动压缩阈值，并可用旧模型先压缩。

Reina 当前未看到显式的 model downshift compact guard。

### 5. 压缩生命周期事件

Codex 有 started/completed 级别的 context compaction item。

Reina 当前已补齐 `context-compaction-started` / `context-compacted` / `context-compaction-failed`。手动和自动压缩都走 engine lifecycle event，desktop 端会显示自动压缩进行中；timeline 的 compacting divider 也做了幂等处理，避免手动 `/compact` 和 engine started event 产生重复占位。

### 6. 失败重试

Codex local compact 遇到 context window exceeded 会裁掉最旧 history item 并重试。remote compact 也会先裁剪 function-call history 以适配窗口。

Reina 当前已补主模型请求的 context-too-long recovery：先裁剪 pending tool observations 的模型可见内容，再尝试 emergency auto-compaction，并且不会把 context-window 错误当普通 transient retry 无限重发。summary model call 仍主要依赖输入截断和 extractive fallback；Codex remote compact 那种 function-call history 专项裁剪还未实现。

### 7. 持久化与回放

Codex 会把 compacted replacement history 写进 rollout，便于重建会话状态。

Reina 当前记录 compact boundary、summary、modelMessages，并在 compaction 后写 `session_replace` 和 flush SessionStore；memory chunk metadata 也会在 loadSession 时从 SQLite 重新 hydrate。这已经覆盖本地 session 恢复，但仍不是 Codex remote compaction 的完整 replacement-history 协议。

### 8. Memory chunks

Reina 有 Codex 没有的实验方向：把被压缩消息切成 SQLite memory chunks，并暴露 `recall_memory_chunk` / `list_memory_chunks`。

相关文件：

- [`packages/core/src/chunks.ts`](../packages/core/src/chunks.ts)
- [`packages/core/src/controllers/memory.ts`](../packages/core/src/controllers/memory.ts)
- [`packages/core/src/engine-prompt.ts`](../packages/core/src/engine-prompt.ts)
- [`packages/core/src/store/session-store.ts`](../packages/core/src/store/session-store.ts)

这是 Reina 的潜在优势。研究时发现它还没完全闭环：

- `persistMemoryChunks()` 会写入 SQLite，并把 recall/list 工具加入 `session.activeDeferredTools`。
- 研究时没有看到 session load 时重新填充 `session.memoryChunks`。
- 研究时也没有看到这里通过 `unmaskDeferredTool()` 记录工具解锁状态。
- 因此重启或恢复会话后，memory index 和 recall 工具可见性可能丢失。

更新：本轮优化已补齐这个恢复闭环。`loadSession` 会从 SQLite 重新填充 memory chunk index，压缩写入会走正常工具解锁持久化路径，并新增了 reload 回归测试。

## 还差什么

### P0：补齐 memory chunks 恢复链路

状态：已在本轮优化中处理。

建议先验证并修复：

- 压缩后写入的 chunks，reload session 后仍能被 `engine-prompt` 放进上下文 index。
- `recall_memory_chunk` / `list_memory_chunks` 在 reload 后仍可用。
- `activeDeferredTools` 的变更要么写进 rollout，要么在 session load 时根据已有 chunks 自动重建。

建议测试：

- 开启 `REINA_COMPACTION_OFFLOAD=1`。
- 触发压缩并产生 memory chunks。
- 重新 load session。
- 断言 memory chunks index 仍出现在 prompt context 中。
- 断言 recall/list 工具可用。

### P1：增加 engine/host 级 compaction started 事件

状态：已在本轮优化中处理。

手动 UI placeholder 不应该是唯一的 “正在压缩” 状态来源。建议增加统一事件：

- `context-compaction-started`
- `context-compacted`
- `context-compaction-failed`

这样手动压缩和自动压缩都能使用同一套 UI 生命周期。

### P1：补失败策略

状态：已补主模型请求的 context-too-long emergency trim/retry；summary model call 仍依赖输入截断和 extractive fallback。

建议明确三类失败策略：

- summary model call 超窗：裁剪旧消息后重试，或直接 extractive fallback。
- compact 后下一次模型请求仍超窗：执行一次 emergency trim/retry。
- 连续压缩收益过低：短路，避免反复压缩空转。

你已经加了最小可压缩 token 门槛，这是正确方向，但还不是完整失败策略。

### P1：补 reload / rollout 回归测试

建议覆盖：

- compact boundary 恢复。
- `session.summary` 恢复。
- `session.modelMessages` 恢复。
- `conversation_history` 路径存在。
- offload chunks 恢复。
- deferred tools 恢复。

### P2：考虑 AutoCompactWindow

状态：已实现 body-after-prefix 部分（见上方"### 3. 自动压缩触发"的 2026-06-04 更新）。

- ~~记录 provider/server prefill token baseline。~~ 已做：`usage.autoCompactBaseline`。
- ~~自动压缩时可以选择 total 或 body-after-prefix scope。~~ 已做：两者同时为条件
  （硬阈值守住总量上限，body 预算守住"压缩后新增"）。
- 未做：显式的 window ordinal（codex 用它做遥测/调试,Reina 暂不需要）。

### P2：补模型降级保护

当用户从大上下文模型切到小上下文模型时，建议在下一 turn 前检查：

- 当前 active context 是否超过新模型 context window。
- 是否超过新模型 auto compact threshold。
- 如果超过，优先用旧模型执行压缩。

这部分是 Codex 明确处理的场景。

### P2：决定是否做 remote compaction

remote compaction 不是必须项。

建议按目标决定：

- 如果 Reina 要支持多 provider，本地 summary + extractive fallback 更通用。
- 如果 Reina 要贴近 Codex/OpenAI 后端能力，可以增加 provider capability 分支。
- remote v2 需要协议层支持 `CompactionTrigger` / `Compaction` item，不只是换一个 prompt。

### P2：补历史 compaction divider 渲染

当前 live event 会显示压缩分割线，但需要确认加载历史会话时是否能从 `compactBoundaries` 渲染历史分割线。

如果不能，建议补上。否则用户重开会话后看不到哪里发生过压缩。

### P3：更新文档

[`docs/context-compaction.md`](context-compaction.md) 仍描述 manual compact 主要通过 `compact_conversation` internal tool。现在桌面端已经走 `compact_session` 控制通道，文档需要同步。

[`docs/compaction-design.md`](compaction-design.md) 中 Phase B-C 描述了更完整的 weighted memory index、embeddings、reranking、manual pin 等能力。当前代码只实现了较基础的 chunk/offload/recall 雏形，文档和实现状态需要区分。

## 建议实现顺序

1. 已完成 memory chunks reload 和 deferred tools 恢复。
2. 已完成 compaction started/failed 事件，统一手动和自动压缩 UI 生命周期。
3. 已补 reload/rollout 测试，锁住压缩后的 session 可恢复性。
4. 已补主模型请求的 context-too-long retry / emergency trim。
5. 下一步优先做 request-aware preflight：按真实请求估算 system reminders、tools、observations、woven tool outputs 和 output reserve。
6. 再考虑 AutoCompactWindow、model downshift guard 和 remote compaction。

## 待确认问题

- Reina 的目标是通用多 provider agent，还是优先贴近 Codex/OpenAI 协议？
- 压缩后的 restored context message 是否应该参与下一次压缩，还是应该有独立生命周期？
- `memoryChunks` 应该作为 session blob 持久化，还是每次从 SQLite 按 session id 查询并构建？
- recall/list memory tools 是只在 offload 后显式解锁，还是只要 session 存在 chunks 就自动可用？
- 历史会话 UI 是否应该显示所有 compaction boundaries？

## 本次未做

- 未实现 request-aware preflight compaction。
- 未实现 Codex remote/function-call history 专项裁剪。
- 未验证 UI 视觉效果。
