# Compaction Design

> Status: **Phase A 提案就绪 / Phase B-C 待 prototype**。现状描述见 [context-compaction.md](./context-compaction.md)。
>
> 本文档分两半：
> - **Phase A**（§2-3）—— 基线改进，~1.5 工作日，无论将来走哪条路都不亏，**优先做**。
> - **Phase B-C**（§4-7）—— 加权 offload 范式替代方案，需要 prototype 数据决定是否上线。Phase B 是 prototype（3-5 天），Phase C 是量化对比（1 周）。**不是 Phase A 的扩展，是替换**——若 Phase C 验证失败，长期就停在 Phase A。

## 1. 现状一句话

骨架是好的：[非破坏 rollout](../packages/core/src/rollout.ts) + [boundary 审计](../packages/core/src/compaction.ts#L73) + [extractive fallback](../packages/core/src/compaction.ts#L211) + [summary 注入 system prompt](../packages/core/src/engine-prompt.ts#L20)。**问题在提示词太弱（3 行字）、token 估算太糙（`char/4`）、续接首轮模型常常 acknowledge 浪费一轮。**

---

# Phase A — 基线改进（必做）

## 2. 四件事

### 2.1 9 段摘要 prompt

替换 [compaction.ts:186-216](../packages/core/src/compaction.ts#L186-L216) 的 3 行提示词。新 prompt = 首部 + 核心 + 尾部 + 后处理。

**首部 — NO_TOOLS_PREAMBLE**：

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use read_file, run_shell, search_files, edit_file, or ANY other tool.
- You already have all the context you need in the conversation segment below.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

为什么需要：当前靠 `tools: []` 在 schema 层禁用，但 OpenAI-compat 端点（KIMI / DeepSeek）会忽略空数组、强行调工具。提示词首尾各夹一次比 schema 鲁棒。

**核心 — BASE_COMPACT_PROMPT**（直接抄 Claude Code 9 段结构）：

```
Your task is to create a detailed summary of the conversation so far, paying close
attention to the user's explicit requests and your previous actions. Be thorough
in capturing technical details, code patterns, and decisions essential for
continuing development without losing context.

Before your final summary, wrap your analysis in <analysis> tags:
1. Chronologically analyze each section. For each: user's explicit requests,
   your approach, key decisions, file names, full code snippets, function
   signatures, errors and fixes, user feedback.
2. Double-check technical accuracy and completeness.

Your summary must include these sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (full snippets + why important)
4. Errors and Fixes (含 user feedback)
5. Problem Solving
6. All user messages (列出所有非 tool-result 的 user message)
7. Pending Tasks
8. Current Work (压缩前最后一刻在干什么 / 精确到文件和片段)
9. Optional Next Step — include direct verbatim quotes from the most recent
   user message. Do not paraphrase user words.

Preserve all file paths, commands, error messages, and direct user quotes
literally. Never rewrite a user's words. If a previous summary exists, copy
still-relevant parts verbatim rather than rephrasing.

Format:
<analysis>...</analysis>
<summary>
1. Primary Request and Intent: ...
...
</summary>
```

**尾部 — NO_TOOLS_TRAILER**：

```
REMINDER: Do NOT call any tools. Respond with plain text only —
an <analysis> block followed by a <summary> block.
```

**后处理** —— 在 [`buildCompactSummary`](../packages/core/src/compaction.ts#L186) 拿到返回后剥 `<analysis>`：

```ts
function formatCompactSummary(raw: string): string {
  return raw
    .replace(/<analysis>[\s\S]*?<\/analysis>/, '')
    .replace(/<summary>([\s\S]*?)<\/summary>/, 'Summary:\n$1')
    .replace(/\n\n+/g, '\n\n')
    .trim();
}
```

`<analysis>` 仅供模型打草稿，不进 `session.summary`。

### 2.2 Resume message 加 "Do not acknowledge"

修改 [`buildPostCompactContextMessage`](../packages/core/src/compaction.ts#L153) 末尾，追加：

```
Continue the conversation from where it left off. Do not acknowledge this
summary, do not recap what was happening, do not preface with "I'll continue"
or similar. Resume directly — pick up the last task as if the break never
happened.
```

省去 85% 的"好的，我已经查看了之前的上下文..."废话首轮。

### 2.3 真实 tokenizer 替换 `char/4`

只装一个依赖：`js-tiktoken`。所有 provider 都用 cl100k 编码——对 Claude 误差 5-8%、对 OpenAI/KIMI/DeepSeek 精确，比当前 `char/4`（CJK 误差 2 倍以上）好一个数量级。

修改 [compaction.ts:241](../packages/core/src/compaction.ts#L241)：

```ts
import { encodingForModel } from "js-tiktoken";
const enc = encodingForModel("cl100k_base");

function estimateTextTokens(text: string): number {
  return enc.encode(text).length;
}
```

不按 provider 分发。等真有人反馈"某 provider 误差 30%"再说。

### 2.4 补 `compaction.test.ts`

当前零单测。最少覆盖：

- `compactSplitIndex`：边界（messages.length = 8 / 9 / 200）
- `shouldAutoCompactSession`：threshold 命中/未命中
- `formatCompactSummary`：剥 `<analysis>`、保留 `<summary>` 内容
- `extractiveSummary` fallback：模型调用失败时不抛错
- rollout replay：`compacted` event 后 `compactBoundaries[]` 正确还原

## 3. 接通已有但未用的 `summary` profile

[profiles.ts:24-44](../packages/core/src/profiles.ts#L24-L44) 定义了沙箱化的 `summary` profile（read-only、maxSteps=4），但 [compaction.ts:201](../packages/core/src/compaction.ts#L201) 没用它，直接调裸模型。

推荐：用上 profile（多一层 NO_TOOLS 防御）。10 分钟。

## Phase A 接受标准

- [ ] 摘要按 9 段结构输出，`<analysis>` 被剥离
- [ ] 压缩续接首轮 95%+ 不出现 "好的，我已经..."（人工抽样 20 次）
- [ ] tokenizer 在 CJK + 代码混合样本上误差 <15%
- [ ] `summary` profile 实际接入
- [ ] `compaction.test.ts` 至少覆盖 5 个核心场景

---

# Phase B-C — 加权 Offload 替代方案（实验性）

## 4. 核心思想

借鉴 deepagents（filesystem-as-memory）+ MemGPT（hierarchical memory）+ RAG 检索范式：

- **不 lossy 摘要**，把每个完整 task arc（一段 user→assistant→tools 对话块）切成可寻址 chunk，原文存 SQLite
- 主上下文只保留**最近 K turn 原文 + Phase A 的短 summary 作兜底 + 一段 weighted index**（每条 chunk 一行摘要 + 权重）
- 新工具 `recall_memory(ids)` 让模型按需召回 chunk 原文

权重 ≈ "注意力残差"的外部近似：cheap embedding 预算一遍每个 chunk 对当前任务的相关度，把"如果模型能 attend 所有过去会得到的高权重内容"显式列在 prompt 里。

**关键判断**：Phase A 的短 summary **不丢**，是 hybrid 的兜底——retrieval miss 时模型仍有粗粒度任务锚点。这避免了纯 retrieval 范式"自信地基于残缺信息行动"的最大失败模式。

## 5. 数据结构

SQLite 新表（`.reina/reina.db`，已存在）：

```sql
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  message_ids TEXT NOT NULL,        -- JSON array
  topic_line TEXT NOT NULL,         -- <=80 字
  content TEXT NOT NULL,            -- lossless 原文
  embedding BLOB NOT NULL,          -- float32[384], all-MiniLM-L6-v2
  token_count INTEGER NOT NULL,
  file_paths TEXT,                  -- JSON array
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_chunks_session ON memory_chunks(session_id);
```

## 6. 管线

### 6.1 Chunk 切分（替换当前的 summary-only 路径）

```ts
function splitIntoChunks(messages: ChatMessage[]): Chunk[] {
  // 一个 chunk = 从某个 user message 开始，到下一个 user message 之前
  // 含中间所有 assistant + tool_call + tool_observation
  // 单 chunk 上限 8k token，超了再按工具/段落细切
}
```

切完每个 chunk：
1. `topicLine` = 第一条 user message 前 80 字 + 主要工具名
2. `embedding` = 本地 embedder
3. `filePaths` = 正则提取
4. 写 SQLite，原 `modelMessages` 移除这部分

### 6.2 短兜底摘要（继承 Phase A）

仍生成一个 ≤500 字 summary，但只用 Phase A prompt 的 §1-2-7-8 四段（Intent + Concepts + Pending + Current）。`session.summary` 字段复用，语义从"完整摘要"变成"高层任务状态"。

### 6.3 每轮 model call 前的 index 注入

```ts
function buildMemoryIndex(session: SessionState, currentUserMsg: string): string {
  const chunks = loadChunks(session.id);
  if (chunks.length === 0) return "";

  const queryEmbed = embedder.encode(currentUserMsg + recentToolCalls.join(" "));
  const activePaths = new Set(session.recentFiles.map(f => f.path));

  const scored = chunks.map(c => ({
    chunk: c,
    score:
      0.3 * recencyScore(c.created_at) +
      0.6 * cosine(queryEmbed, c.embedding) +
      0.1 * (c.file_paths.some(p => activePaths.has(p)) ? 1 : 0)
  }));

  const topK = scored.sort((a, b) => b.score - a.score).slice(0, 8);

  return [
    "<memory_index>",
    "Offloaded memory chunks (weighted by relevance):",
    ...topK.map(s => `- ${s.chunk.id} (w=${s.score.toFixed(2)}): ${s.chunk.topic_line}`),
    "Use `recall_memory(ids)` to fetch full content of chunks you need.",
    "</memory_index>"
  ].join("\n");
}
```

注入位置：最后一条 user message **之前**——把每轮会变的部分集中在 prompt 末尾，便于 §6.4 cache 策略。

### 6.4 Cache 友好性（最大风险点）

每轮重排 `<memory_index>` 破坏 provider prompt cache 的稳定 prefix。对策：

| Provider | 策略 |
|---|---|
| **Anthropic** | 在 system prompt + skills 段尾设置 `cache_control: {type:"ephemeral"}` breakpoint；memory_index 放在 breakpoint 之后，前段 cache 仍命中 |
| **OpenAI / OpenAI-compat** | 无手动 breakpoint，cache 是隐式后缀匹配。memory_index 进入后 cache hit rate 必降，预期成本上涨 30-60% |
| **Deterministic** | 不影响 |

**这是 Phase C 决策门槛的关键变量。**

### 6.5 新工具 recall_memory

注册到 [tools registry](../packages/tools/src/registry.ts)：

```ts
{
  name: "recall_memory",
  description: "Fetch full content of offloaded memory chunks by id. Use when the memory_index suggests a relevant chunk and you need its details.",
  parameters: { ids: { type: "array", items: { type: "string" } } },
  requiresApproval: false,
}
```

返回拼接原文，**不**再次写入 `modelMessages`（当前 turn 用完即弃）。

### 6.6 Embedder

`@xenova/transformers` + `Xenova/all-MiniLM-L6-v2`（384 维，~25MB，CPU ~20ms/chunk）。

理由：本地零额外 API、符合 Reina 本地优先；体积可接受；万条 chunk SQLite 约 15MB 可控。

**不**走 OpenAI / Voyage embedding API：引入额外 provider 信任面，离线场景废。

## 7. Phase C 验证计划

跑 **3 个真实长会话**（每个 ≥30 轮、≥150k token），Phase A 基线 vs Phase B offload 各跑一遍，记录：

| 指标 | 基线目标 | Offload 目标 |
|---|---|---|
| 完成主任务成功率 | baseline | ≥ baseline |
| 平均每轮 input token | baseline | ≤ 1.3× baseline（含 recall 调用） |
| Anthropic cache hit rate | baseline | ≥ 70% × baseline |
| 模型主动 recall 次数 / 总轮数 | n/a | 0.3-0.7 |
| Retrieval miss（人工标注） | n/a | < 10% |
| 用户主观满意度（盲测） | baseline | strictly better |

**决策门槛**：成功率 / retrieval miss 不达标 → 弃用 offload，长期停在 Phase A。仅当 token 成本上涨 < 1.3× 且其余全达标，才上线 offload。

## 8. Offload 方案接受标准（如最终上线）

- [ ] §7 全部 6 项指标达标
- [ ] cache hit rate 降幅在 Anthropic 路径上 < 30%
- [ ] 失败自动 fallback 到 Phase A：embedder 加载失败 / SQLite 不可用 / provider 不支持工具调用
- [ ] UI 可见当前 memory_index 内容 + 手动 pin 某 chunk 不被换出
- [ ] 补 `memory-offload.test.ts`：切分、检索、recall_memory、fallback

---

# 9. 明确推迟（无论哪条路）

下面这些评估过、但**当前没有真实痛点**：

| 推迟项 | 触发条件 |
|--------|---------|
| 三级/四级阈值 + warning event | 用户反馈"想提前知道快满了" |
| PTL retry + truncateHead | 生产 PTL 失败率 >1% |
| 连续失败 circuit breaker | 出现单 session 反复失败 |
| Split 按 turn 切（基线方案） | 出现切断 tool_call/tool_observation 导致 provider 报错 |
| Attachment / 长 message 预截断 | PTL 失败率追溯到大 observation |
| `compaction.json` 配置文件 | 出现"我想调 X 但改不了" |
| profile 级 compaction 覆盖 | 同上 |
| History 文件 rotation | 单 session 真写出大文件 |
| `PARTIAL_FROM` / `PARTIAL_UP_TO` prompt | 引入 cache-sharing fork 或保留头部场景 |
| Manual `/compact` UI 入口 | 用户报"想手动清场但只能等自动" |
| Chunk 跨 session 共享 | 用户提"上周做过的事这周想召回" |
| 训练自定义 reranker | embedding 直检索精度证伪 |
| Chunk graph / 关联关系 | 当前 RAG 风格够用 |

手动 `/compact` 已通过桌面 `compact_session` 控制通道调用 `AgentEngine.compactNow`，与自动压缩共用内核，不依赖模型调用工具。

# 10. References

- 现状：[docs/context-compaction.md](./context-compaction.md)
- 实现：[compaction.ts](../packages/core/src/compaction.ts)、[engine.ts:1219](../packages/core/src/engine.ts#L1219)、[engine-prompt.ts:20](../packages/core/src/engine-prompt.ts#L20)
- profile：[profiles.ts:24-44](../packages/core/src/profiles.ts#L24-L44)
- rollout reducer：[rollout.ts:287-294](../packages/core/src/rollout.ts#L287-L294)
- 数据层：[store/session-store.ts](../packages/core/src/store/session-store.ts)
- 工具系统：[packages/tools/src/registry.ts](../packages/tools/src/registry.ts)
- 文献：
  - MemGPT (Packer et al. 2023, arxiv:2310.08560)
  - deepagents pattern (LangChain / Anthropic 2024)
  - HippoRAG (Gutiérrez et al. 2024, arxiv:2405.14831)
