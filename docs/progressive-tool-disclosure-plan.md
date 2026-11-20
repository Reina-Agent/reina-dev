# 渐进式工具披露方案（对标 Codex / Claude Code）

> 当前状态（2026-08-31 起）：本地与 MCP deferred 工具被发现后，会在**下一次请求**回填完整
> schema；首次加入会改变 tools 前缀并可能造成一次缓存失效，激活集合与实时 MCP 工具池不变后才保持
> 定义和排序稳定。resident MCP 仍从第 1 轮常驻，deferred MCP 仅在当前 cwd 的实时工具池中存在且通过
> profile 门控时回填。这个实现取代了 2026-07-11 的“解锁后永不回灌、整段会话 tools 字节恒定”结论。
> 下文“现状/差距/路线图”保留提案时点的旧方案，作历史参考，不应当作当前实现说明。
> 关联文档：[`cache-hit-improvement-plan.md`](./cache-hit-improvement-plan.md) 管 **system prompt 前缀**
> 稳定性；本文专攻 **tools 维度**（工具披露、deferred MCP、检索、tools 数组稳定）。两者互补，不重叠。

## 1. 背景与目标

目标是**防范于未然**：当前 MCP 与本地工具数量都还小，渐进披露不是燃眉之急；但工具/MCP 一旦变多，
工具定义会同时吃掉 **上下文预算** 和 **prompt cache 命中率**。本文把对标 Codex / Claude Code 的调研
固化成主线决策 + 分阶段路线，等触发条件到了直接照做。

触发条件（满足任一即推进对应阶段）：

- 默认工具 + 启用的 MCP 工具总数显著超过冷启动可接受的 token 预算（经验阈值见阶段 1）。
- 观测到 `tools_changed` 类型的 cache miss 占比上升（用 Cache Diagnostics 量，见"延伸"）。
- 接入第三方 MCP 市场 / 多服务器，工具命名空间膨胀。

## 2. 关键约束：Anthropic 没有服务端 defer（必须先讲清楚）

"对标 Codex" 有一半机制**搬不过来**，原因是 provider 不同：

- **Codex 走 OpenAI Responses API**。澄清一个常见误解:Codex 的**初始/广播 tools 数组同样是恒定的**
  ——deferred 工具**在客户端就被省略**,不进初始 model-visible specs。证据:[`tool_executor.rs`](../参考/codex/codex-rs/tools/src/tool_executor.rs)
  对 `ToolExposure::Deferred` 的注释原文是 _"Register this tool for later discovery, but **omit it from the
  initial model-visible tool list**"_;[`spec_plan.rs`](../参考/codex/codex-rs/core/src/tools/spec_plan.rs)
  的 `build_model_visible_specs_and_registry` 只把 `exposure.is_direct()` 的工具推进数组——**这是 Rust
  客户端过滤,不是"服务端/模型侧决定"**。`defer_loading: true` 也不是"上来全量发",它只出现在 `tool_search`
  **返回结果里**的 `LoadableToolSpec` 命名空间上(`tool_search.rs` 的 `coalesce_loadable_tool_specs`)。
- **真正搬不过来的是"发现后怎么变可调用"。** Codex 让模型**直呼**命名空间工具名(`mcp__server__tool`),
  靠服务端 **`namespace_tools` 能力** + `defer_loading` 标志在服务端按需加载,因此数组**不增长**。
- **Reina 走 Anthropic**(`packages/providers/src/index.ts` 的 `anthropicMessagesTurn`)。Anthropic
  **没有** `namespace_tools` / 服务端 defer 能力——早年私有的 `defer_loading`、`tool_reference` 连
  Claude Code 自己都为了 provider 中立而**弃用**了。

**结论**：在 Anthropic 上，披露逻辑只能放在**客户端**——即 Claude Code 那条路（发现的工具**永不回灌**
广播 tools 数组，调用走代理/注册表）。因此：

> Reina 的"对标 Codex" = **Codex 的外观/能力**（deferred MCP、`search_tool`、namespace 分组、好检索）
>
> - **Claude Code 的缓存安全机制**（tools 数组全程恒定 + 代理执行）。

## 3. Reina 现状（已有骨架 + 两个真实差距）

Reina **已经有**渐进披露的半成品，不是从零开始：

| 已有能力                                                               | 位置                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 工具可标 `exposure: "deferred"`，加默认 defer 白名单                   | `packages/tools/src/registry.ts:110` `isDeferredByDefault`                |
| `deferredToolDescriptors` / `directToolDescriptors` 分桶               | `registry.ts:118` / `:125`                                                |
| `search_tool` 按 query 检索 deferred 目录，返回 `metadata.unmaskTools` | `packages/tools/src/tools/agent/search-tool.ts:42`                        |
| 解蔽集合 `activeDeferredTools` 持久化、可跨 reload / 传给子 agent      | `engine.ts:2058` `unmaskDeferredTool`、`:2136` 子 agent 继承              |
| 每轮按 `activeDeferredTools` 重建 tools 数组                           | `engine.ts:3086` `resolveTools` → `registry.ts:150` `resolveExposedTools` |
| 直呼未解蔽工具时自动解蔽（免强制 search 往返）                         | `engine.ts:1505` `resolveOrUnmaskDescriptor`                              |

**差距 1 — tools 数组随解蔽增长 → 撞缓存。**
每次解蔽都会把工具加进 `activeDeferredTools`（`engine.ts:2070`），**下一轮** `resolveTools()`
（`engine.ts:3086`）就产出更大的 tools 数组。Anthropic 缓存 `tools → system → messages` 的精确前缀，
tools 块一变就是 `tools_changed` miss。`engine.ts:1511` 的局部 `tools.push` 只是当轮可见，真正的代价
在**下一轮的数组增长**。代价是有界的（每次解蔽一次 miss，之后重新稳定，多发生在会话早期），但工具越多、
解蔽越频繁，损耗越大。这正是 Codex 与 Claude Code 都刻意规避的。

**差距 2 — MCP 工具完全没 defer，每轮全量加载。**
`engine.ts:3092` 每轮调用 `loadMcpRuntimeTools(cwd)`
（[`packages/tools/src/mcp-runtime.ts:19`](../packages/tools/src/mcp-runtime.ts)），它把**所有启用服务器**的
**所有工具**列出来全部塞进 tools 数组。当前只有 3 个 MCP **元工具**（`mcp_list_resources` 等，
`tools/mcp/mcp.ts`）是 deferred；真正的 `mcp__server__tool` 运行时工具**一个都没 defer**。
MCP 一多，这是冷启动 token 与缓存的主要膨胀源。

## 4. 对标对象拆解

| 维度             | Codex                                                                                                   | Claude Code                                                      | Reina 现状                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| deferred 标记    | 每工具 `defer_loading` 标志                                                                             | `CORE_TOOLS` 白名单，其余 deferred                               | `exposure:"deferred"` + 默认白名单 ✅                     |
| **披露执行机制** | 初始数组**省略 deferred**(客户端 `is_direct` 过滤);发现后靠服务端 `namespace_tools` **直呼**,数组不增长 | **代理执行**：发现的工具永不回灌数组，经 `ExecuteExtraTool` 调用 | 解蔽后**回灌数组**（差距 1）❌                            |
| 检索             | **BM25** SearchEngine                                                                                   | 自建 **TF-IDF + 关键词**混合（0.4/0.6）                          | 子串 + 词重叠兜底（`search-tool.ts:58`），无 CJK、无 BM25 |
| MCP 处理         | `mcp_tools`/`deferred_mcp_tools` 拆分 + namespace 合并（`mcp__server__`）                               | 同走 deferred 路径                                               | 全量加载，未 defer（差距 2）❌                            |
| 门控             | per-tool 标志                                                                                           | 阈值门控 `auto:N`（约 10%，工具少时不 defer）                    | 无阈值，按 exposure 静态决定                              |
| 缓存安全         | 初始数组省略 deferred(客户端) → 天然稳定;靠 `namespace_tools` 避免增长                                  | 数组永不变，客户端自管                                           | 数组会增长（差距 1）❌                                    |

来源：Codex `tool_search.rs`（BM25）、`spec_plan.rs`（`is_direct` 过滤、`add_mcp_runtime_tools`）、
`dynamic_tools.rs`（`defer_loading`）；Claude Code `tool-search-design-guide.md`（CORE_TOOLS、
ExecuteExtraTool、§3.5 v3 数组恒定、`auto:N`）。

## 5. 主线决策

1. **机制抄 Claude Code**：tools 数组全程字节恒定，解蔽的工具**不进**广播数组，改由稳定的代理工具调用。
   provider 中立，惠及**所有** deferred 工具（不止 MCP），是缓存安全的唯一可行路（见约束 §2）。
2. **外观/能力抄 Codex**：deferred MCP 拆分、namespace 分组、BM25 级检索、按需披露的 UX。
3. **门控抄 Claude Code 的 `auto:N`**：工具总数低于阈值时**不 defer**，保留零延迟直呼；超过才进入披露模式。
   契合"现在不多就别上"的判断。
4. **复用 Reina 现有骨架**：`exposure:"deferred"`、`deferredToolDescriptors`、`search_tool`、
   `activeDeferredTools` 全部保留，阶段 0 只改"解蔽后如何执行"。

## 6. 路线图

### 阶段 0 — tools 数组恒定 / 代理执行（地基，绕不开）

无论后续怎么对标，第一步都是消除差距 1。

- 解蔽**不再**把工具加进广播数组：`resolveOrUnmaskDescriptor`（`engine.ts:1505`）与
  `search_tool` 的 `unmaskTools` 路径，改为只把 schema 通过 **search 结果文本**交给模型，而**不**改变
  下一轮 `resolveTools()` 产出的数组。
- **search 结果须返回完整 `inputSchema`(不再只是 name + summary)。** 现在 `search-tool.ts:85` 只回
  `name: summary`,靠工具解蔽进数组、下一轮自带 schema。一旦不再回灌数组,模型只能从搜索结果文本拿到
  完整 schema 才能经代理调用(对标 Codex 的 `LoadableToolSpec`)。代价是搜索结果 token 变大,故按需返回。
- 新增稳定的代理执行工具（命名待定，如 `run_tool({name, input})`），始终在 direct 数组里；模型用它调用
  任何已检索到的 deferred 工具。引擎按 `name` 派发到现有 `runTool` / `runMcpRuntimeTool`。
- **代理须继承目标工具的权限元数据。** `buildPendingToolCallRecord`（`engine.ts:1519`）现在取
  `descriptor.permission`;走 `run_tool` 后,`permission` / `requiresApproval` / `concurrencySafe` 都要解析
  **目标工具**的,而非代理本身的(对标 CC `ExecuteExtraTool.checkPermissions()` 的 passthrough)。
- 验收 1：一次会话内，**无论解蔽多少工具，发给 Anthropic 的 tools 块字节恒定**（新增断言测试，
  仿照 `engine-prompt.mcp.test.ts` 的"byte-identical"风格）。
- 验收 2：经 `run_tool` 调用 deferred 工具时,审批/权限/并发行为与该工具**直呼时完全一致**(回归测试)。
- 影响面：动 `engine.ts` 工具循环核心 + `resolveTools`，**编辑前必须 `codegraph_impact`**（预计 HIGH）。
- "直呼即用"只有一条自洽路径:让代理工具**接受真实工具名**(模型调 `run_tool({name:"notify",...})`)。
  **不要**保留"自动解蔽但不回灌数组"——工具不在数组里,模型根本无法用该名字发起 tool_use,这条路不成立。
  CC v3 也正是彻底删掉了 "discover then include",全量走代理。

### 阶段 1 — defer MCP + 阈值门控（"MCP 变多"时触发）

- 让 `mcp__server__tool` 运行时工具走与本地 deferred 工具**同一条** search/代理路径，
  默认不进冷启动数组；`runMcpRuntimeTool` 已可作为执行后端（`mcp-runtime.ts:52`）。
- 阈值门控 `auto:N`：工具总数 ≤ N 时全部 direct（零延迟），> N 时把低频/MCP 工具转 deferred。
- search 目录纳入 MCP 工具（`name + [MCP:server] description`）。
- **硬约束:deferred 目录绝不能进缓存前缀。** 现在引擎用 `deferredToolDescriptors`(全量、静态)渲染系统
  提示词里的 "Discoverable tools" 目录(见 `registry.ts:114-117`),静态时无害。但 MCP 工具一旦变 deferred,
  该目录会随服务器**连接/断开而变化** → **系统提示词前缀失效**,等于把差距 1 从 tools 数组挪到了 system
  prompt。必须把 deferred 目录(尤其含 MCP 后)移出被缓存的前缀,改用 CC §6 的 **delta / append-only
  attachment** 注入(首次注入全量、后续只注入增量)。这条与 `cache-hit-improvement-plan.md`(管前缀稳定)
  直接交叉,实现阶段 1 前必须先和该文档对齐 deferred 目录的落点。
- 验收：小型 MCP 配置行为不变（不 defer）；大型配置冷启动 token 显著下降，缓存稳定;**MCP 服务器
  连接/断开不导致系统提示词前缀缓存失效**。

### 阶段 2 — 检索升级（BM25/TF-IDF + CJK）✅ 已落地（核心）

- ✅ 已把 `search-tool.ts` 的"子串 + 词重叠"换成**混合排序器**:TF-IDF 余弦(0.6)+ 关键词分(0.4),
  字段加权(name 3× / summary 1×),轻量词干;子串命中仍作最强信号 + 兜底,召回不退化。
- ✅ 已加 **CJK 分词**:中/日/韩按字 unigram + bigram(对标但**超过** Codex——Codex 用 `bm25` crate
  的 `Language::English` + `deunicode` 音译,中文走拼音化 ASCII,有损;我们走真字符,中文精度更高)。
- 测试:`search-tool.test.ts`(分词/排序/MCP 名/CJK/limit/无匹配),既有 engine `search_tool` 测试仍过。
- ⏳ 未做(留待阶段 1):MCP namespace 合并展示(`mcp__server__` 分组),对标 `coalesce_loadable_tool_specs`。

**决策记录 — 跨语言(中文 query → 英文工具)不上向量检索。** 词法检索(BM25/TF-IDF/n-gram)无法跨语言,
这是本质限制,Codex/CC 同样越不过去且至今都未上向量。但对 agent 而言这是**伪需求**:模型在系统提示里看到的
就是**英文**的 "Discoverable tools" 目录(`registry.ts:114-117`),自然会用英文搜或直呼工具名。因此采用
**最小根因方案**:在 `search_tool` 描述与 `query` 字段里明确"目录是英文,用英文能力词搜"(已落地),
并去掉会误导的中文示例。本地 embedding(transformers.js/onnxruntime,模型权重 80–470MB + 原生 rebuild)
对几十条短字符串属杀鸡用牛刀;远程 embedding 破坏本地优先。仅当未来出现"大量非英文 MCP 工具 + 面向**人**的
工具搜索 UI"时再重启评估,且届时 embedding 只作 base 词法之上的 re-rank,不替换。

### 阶段 3 — 预取（cold-start 免一轮往返）

- 依据用户首条消息预测性解蔽高概率工具，减少首个工具调用前的 `search_tool` 往返。
- 对标 Claude Code 的冷启动 prompt 最小化思路；与阶段 0 的数组恒定**不冲突**（预取走同一代理路径）。

### 延伸（reach beyond）— Cache Diagnostics 闭环

- 用 Anthropic Cache Diagnostics beta（`cache-diagnosis-2026-04-07` + `diagnostics.previous_message_id`，
  详见 `cache-hit-improvement-plan.md` 与参考文章）在遥测里识别 `tools_changed` miss，
  自动校准 defer 阈值、回归报警。这是超越 Codex/CC 的点：把披露策略做成数据驱动的闭环。

## 7. 与 `cache-hit-improvement-plan.md` 的分工

| 关注点                                                          | 归属文档                      |
| --------------------------------------------------------------- | ----------------------------- |
| system prompt 分块、cache_control 断点、OpenAI `promptCacheKey` | cache-hit-improvement-plan.md |
| fork / resume / compaction 的 baseline                          | cache-hit-improvement-plan.md |
| **tools 数组稳定、deferred MCP、工具检索、代理执行**            | 本文                          |
| Cache Diagnostics 遥测（共用）                                  | 两者交叉引用                  |

## 8. 风险

- 阶段 0 动的是工具循环核心（`engine.ts`），HIGH 风险，必须 `codegraph_impact` + 聚焦测试。
- 代理执行会改变模型调用工具的"形状"——需确保权限校验、审批、并发批处理路径都经过代理后仍正确。
- 检索换引擎若召回变差，会让模型找不到工具；阶段 2 需保留旧的子串兜底作为 fallback。
- 阈值门控的 N 取值需用真实工具数标定，避免小配置被无谓 defer 拖慢。
