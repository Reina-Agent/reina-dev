# kimi-code 复核 & Reina 臃肿度评估（2026-07-26）

> 面向其他 agent 的交接文档。结论先行，附硬数据与可执行落点。
> 权威背景见记忆 `kimi-code-reference-learnings`；本文是它的**收敛快照**：
> 哪些已落地（别重推）、哪些还值得做、哪些已判死。

## TL;DR

1. **Reina 不臃肿，反而克制**——是 kimi-code 的约 1/5 体量，且只有一套引擎。
   臃肿的是 kimi（agent-core + agent-core-v2 两套 14 万行并行迁移）。
2. kimi/pi 的价值已被系统性榨干。当前工作区未提交的一批改动，就是上一轮
   调研结论的落地过程（见「已落地」）。
3. **剩余真正值得做的只有 3 个 consider 项**，其中 `subagent secondary-model`
   优先级最高。
4. **唯一的结构技术债是 `engine.ts` 5108 行**，与功能多少无关；拆它的现成图纸
   正是 kimi v2 的 loop-泵架构。

---

## 一、体量对比（"臃肿吗"的证据）

| 维度 | Reina | kimi-code |
|---|---|---|
| 源码 | **297 文件 / 71.8k 行** | 2293 文件 / 349k 行 |
| 测试 | 90 文件 / 21.6k 行 | — |
| 核心引擎包 | core 66 文件 19.5k + tools 93 文件 7.7k | agent-core 356 文件 60k **+ agent-core-v2 673 文件 83k（两套并存）** |
| 冷启动 system prompt | **18129 字 ≈ 4532 token** | system.md 20.6k 字 + promptService 37.5k |

复现命令：本仓 `npx vitest run packages/core/src/prompt-size.test.ts`（现成诊断）。

### 冷启动 prompt 已经很省

`prompt-size.test.ts` 实测（default profile 冷启动）：

- **direct tools 仅 19 个 ≈ 4254 token**（note / run_shell / grep / read_file / glob …）
- **39 个 deferred tool ≈ 7265 token 全被挡在冷启动之外**（子代理、goal、memory、
  java-gadget、mcp 资源等，按需 `search_tool` unmask）

deferred-tool 架构是对的，别回退。system prompt 里最大的块是 Skills system
(6481 字) 和 Deferred tools 目录 (4795 字)，都已是必要开销。

### 真正的臃肿点是「单文件」，不是整体

| 文件 | 行数 | 备注 |
|---|---|---|
| `packages/core/src/engine.ts` | **5108** | 唯一值得排期的结构债，CLAUDE.md 自己标注要拆 |
| `packages/core/src/subagent/manager.ts` | 2318 | |
| `packages/providers/src/index.ts` | 2315 | |
| `apps/desktop/src/main/ipc.ts` | 2095 | |
| `apps/desktop/src/renderer-react/src/windows/main/sessionStore.ts` | 2039 | |
| `packages/protocol/src/index.ts` | 2013 | |

这是巨石文件问题，与"功能太多"无关。

---

## 二、已落地 —— 别重复推荐

上一轮调研（记忆 07-26 增量）的 2 port + MCP boot 缓存 + pi 收敛，**正在当前
工作区落地**（逐一核对未提交改动）：

| 改动文件 | 对应来源 |
|---|---|
| `packages/tools/src/mcp-runtime.ts` (+ test) | kimi MCP boot-failed 服务器空缓存永不失效的 fix |
| `packages/providers/src/index.ts` (+ test) | kimi #2104 reasoning 三方言（reasoning_content / reasoning_details / reasoning）|
| `packages/core/src/compaction.ts` / `engine.ts` / `compaction.retry.test.ts` | 空 assistant 消息永久卡死 port（kimi 71bcfba54）|
| `apps/desktop/src/main/models-dev.ts` (+ test) | kimi #2110 + pi 收敛的 models.dev 预填（脏基线，只填空缺不覆写）|
| `packages/core/src/side-usage.ts` | pi #6671 侧请求（compaction/title/verifier）token usage 计入账单 |

早前已落地、也别再提：overflow 自动压缩重试、错误分类（isRetryableStreamError）、
micro 压缩（CompactBoundary micro）、kill_shell Windows 进程树杀灭、工具输出落盘 +
read_file 指针、能力进 models.json、agents.json profiles、pipe 模式非交互 shell env。

---

## 三、剩余值得做的（3 个 consider，按优先级）

### 1. Subagent secondary-model 全局旋钮 —— ✅ 已落地（2026-07-26）
- **实现**：`reina.json` `subagent.secondaryModel`（Partial\<ModelConfig\>，titleModel
  同款契约）→ 引擎快照 → SubagentManager 在 4 个 spawn 点（sync task / async /
  follow-up / resume）merge 进子引擎 `session.model`；fork 一律跳过（缓存命名空间）；
  profile.model / per-skill override 在请求时仍然覆盖它（engine.ts effectiveModel
  合并顺序天然保证）。ipc sanitizeEngineConfig 白名单已扩。测试
  `manager.secondary-model.test.ts`。
- **来源**：kimi #2064。
- **痛点**：Reina 现在无法表达"子代理全走便宜模型、主会话不动"。
  在 default profile 钉 `model` 会漏进主聊天。
- **落点**：`reina.json` 加 `subagent.secondaryModel`，作为**最低优先级**默认
  （profile / 显式指定都能覆盖）。
- **坑**：`fork:true` 派发**不能套用**此旋钮——换模型 = 换 prompt-cache 命名空间，
  会击穿 fork 复用缓存的收益。只作用于独立子代理实例。

### 2. 长会话性能 —— medium（第一步 ✅ 已落地 2026-07-26）
- **痛点**：每 turn 端全量快照两次 O(history) JSON + 全量投影挂载。
- **第一步（已做）**：Timeline `CommittedTranscript` 只挂载最后 30 turn
  （`VISIBLE_COMMITTED_TURNS`）+ "Show N earlier turns" 展开器（按 sessionId
  keyed，换会话自动收起）；隐藏窗口内的 anchored notices 一并折叠。
- **顺带（已做）**：`ChatMessage.origin`（"task-delta" | "stale-read" |
  "task-notify"）在 turn-context.ts 三个注入点打标，渲染层投影优先读
  origin，`INJECTED_NOTICE_PREFIXES` 只作旧会话回退、禁止再扩。
- **深水区**：`in_flight_turn` 快照 + 键控 session 状态容器（kimi #2192
  per-scope keyed state），**与 engine.ts 拆分同期做**，见下节。

### 3. 项目级 agent 文件 —— medium，价值一般
- **来源**：`.reina/agents/*.md`，兼容读 `.claude/agents/*.md`。
- **成本**：`listAllProfiles` 全链 cwd 盲，要穿 session cwd。
- **约束**：与安装信任模型交叉——项目 agent 不得静默 allow-all。

---

## 四、已判死 —— 别再看（核实过）

- **deferred tools（kimi #2119）**：Reina 直呼即 unmask 更省；kimi 靠 Moonshot
  专有 `messages[].tools` wire 注入 schema，是它的私有方案。
- **steer-during-goal（kimi #2153）**：kimi 在修它自己"单 turn 锁死 goal 循环"
  的自伤；Reina 逐 turn 续跑 + `queuedAfterInterrupt` 永不丢，本就没这病。
- **loop env 覆盖（#2065 系列）**：Reina 是超集，kimi 反而缺 stagnation /
  repeated-action / error 三限的 env。
- **DeepSeek-Reasonix 四 Pillar / headroom 依赖**：另有记忆判死，此处不重复。

---

## 五、唯一的结构技术债：engine.ts 拆分

`engine.ts` 5108 行是整个仓库最大的单文件，CLAUDE.md 要求"保持 turn 循环
coherent"但允许把外围搬出。

**kimi v2 提供了现成图纸（架构学，DI 容器本身不学）**：

1. **loop 泵只管"跑一步 + 分发错误"**；重试退避 / 溢出压缩作为**注册的错误
   处理器**自行 enqueue 续跑。→ "泵留在文件里，策略搬走"，不违反 CLAUDE.md
   的连贯性约束。
2. **键控 session 状态容器**（`defineState` + 纯数据/资源二分 + JSON-safe
   snapshot）= `in_flight_turn` 快照的地基。engine.ts 的 ~47 私有字段里约 30
   个是纯数据，可迁入。
3. **工具声明元数据 + `when(accessor)` 谓词**：构造前按 profile 过滤，status
   变化重跑激活。

> 注意：CLAUDE.md 原引用的 `docs/engine-refactor.md` 不存在，已改为指向本文
> 本节（2026-07-26）。本文可作为拆分排期的入口。

---

## 六、全量收官清单（2026-07-26 晚，穷尽扫描后不再有下一轮）

对 kimi-code 全部 14 个包 + apps 做了逐目录穷尽扫描（此前调研只覆盖 agent-core
核心区）。以下为**最终**判定，此后不应再有"再看看 kimi"的调研轮：

### 已落地（当日）
- ✅ 压缩丢 origin 注入消息（kimi handoff.ts `compactionUserMessageDisposition`
  同款）：`toSummarySourceMessages` / extractive 回退 / `lastRealUserMessageIndex`
  三处过滤 `ChatMessage.origin`——摘要不浪费预算在每 turn 重建的簿记上，tail
  锚不会锚在注入通知上（hermes #10896 变体）。测试已加。

### 排期项 —— ✅ 全部落地（2026-07-26 晚，同日收口）
1. ✅ **粘贴/拖拽附件降采样**：`downsampleOversizedImageAttachment`（tools
   read-file.ts 导出，复用既有 jimp 阶梯：>5MiB → 1568px 边 + JPEG 质量梯）
   在 agent-host `send_message` 单一入口归一（覆盖 fresh/steer/queued 三路）；
   GIF/解码失败原样放行，永不阻断发送。测试进 tools/index.test.ts。
2. ✅ **CJK uni+bigram 分词**：`store/search-terms.ts`（kimi minidb tokenize
   移植）+ SQL 函数 `reina_search_terms`（SessionStore.open 注册，UDF 特性
   探测，无 UDF 运行时迁移 no-op 留 LIKE 回退）+ 迁移 v7（contentless FTS5
   `messages_fts_terms`/`memory_chunks_fts` + 触发器同步 + 回填）。查询侧
   bigram AND + 拉丁前缀 `term*`，零命中回退 LIKE。**跨词中文查询（"记忆
   调研"非连续子串）从此可命中**，chunk 搜索 LIKE 无界扫退役（grok-build
   review 遗留同时收口）。测试 store/search-terms.test.ts（含 v6→v7 回填）。
3. ✅ **同批重复工具调用去重**：engine 工具循环 batchSeen
   （serializeForCompare 键）；twin 短指针镜像原调用（不重复字节）、trace
   `tool.deduplicated`、peel-off 并发批防同批双执行；**调度族豁免**
   （task/start_async_task/start_task_batch —— SubagentManager 的
   `<merged_with>` 领域级合并语义更富）。deterministic provider 加 `dup_read`
   测试指令，测试 engine.tool-dedup.test.ts。

### 仍留待（可选/深水，非排期）
- （可选）blobref：附件 base64 进 rollout/SQLite/快照的重复携带；降采样落地
  后单附件有界（≤5MiB），紧迫性低。
- （可选）递进提醒文案：kimi streak 3/5/8/12 梯子文案比 autoRepair 精细，可抄词。
- （深水区，与 engine 拆分同期）压缩用户消息 head(2k)+tail 原文保真+elision
  标记（handoff.ts 全形态）；transcript 包 turn 游标分页 + off/turn/block/delta
  订阅粒度 = O(history) 快照的现成蓝图。

### 本轮核实"已等价，别再提"
CRLF 保持（edit-file.ts detect+convert+BOM，有测试）；read_file 图片降采样；
tool-result 落盘+指针（= kimi tool-result-budget）；wakeup 重启补发
（rehydrateWakeups pastDue）；completion budget（= maxOutputTokens）；
tools-diff 注入（Reina hidden-tools volatile reminder 方案不同但目的等价且
缓存稳定）；模型目录刷新（models.dev 预填已落地）；goal 预算（autopilot 上限
+ loop 三限）。

### 判死（最终，含理由）
- kap-server / klient / node-sdk / acp-adapter：违反"无产品 HTTP server/无
  CLI/无外部协议面"约束。
- telemetry 包 + v2 telemetry：本地自用无诉求。
- pi-tui：Reina 是 Electron。
- minidb 本体（WAL/skiplist/shards）：node:sqlite 够用；只取 tokenize。
- kimi-inspect / kimi-web / vis / vscode apps：产品面不同。
- datasource 金融源（#2029）：产品专属。
- display schemas（协议级工具展示 hints）：Reina 手写卡片已达意。
- import-from-cc-codex builtin skill：内置 skill 已被用户两次否决，且自用无
  迁移需求。
- recurring cron 工具（CronCreate/jitter/coalesce）：Reina schedule_wakeup
  一次性语义 + 重启补发已覆盖自用需求；要循环任务时再回头抄 coalescedCount
  设计。
- wire/records 版本化迁移表：rollout 格式目前只增不破坏；真要 break 时再学。
- v2 scoped services（#2196）/ DI 容器：维持"架构学、容器不学"。

## 附：可复现的量化脚本

```powershell
# 冷启动 prompt / 工具 token 分解
npx vitest run packages/core/src/prompt-size.test.ts --reporter=basic

# Reina 源码 / 测试行数
Get-ChildItem packages,apps -Recurse -Include *.ts,*.tsx -File |
  Where-Object { $_.FullName -notmatch 'node_modules|dist|\.test\.' } |
  Get-Content | Measure-Object -Line
```
