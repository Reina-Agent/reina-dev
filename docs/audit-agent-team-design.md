# 审计场景下的 Agent Team 重设计

> 起点:把 Reina 现有的 Agent Team(为"对话式编码助手"设计)改造为**适合代码审计 / 漏洞挖掘**的协作范式。
> 状态:设计草案。尚未实现。

---

## TL;DR — 实际要做的(v1)

**目标用户**:代码审计员、开发、安全攻防人员。
**两种使用模式**:交互式(用户实时面板)+ Autopilot(挂机审计,无人长跑)。

### 数据层(交互/Autopilot 共用)

3 个工具,1 个状态字段:

```
note(title, body, tags?, refs?, status?)
   // status: "open" | "confirmed" | "dead" | "todo"  默认 "open"
   // refs:   关联其它 note 的 id 列表
   // body:   markdown

list_notes({tags?, status?, refs_any?, since?, limit?})
   // 默认返回索引行(id+title+tags),不返回 body

read_note(id)
   // 拿单条全文
```

**存储**:`.reina/notes/n_001.md`,一文件一笔记,YAML frontmatter + Markdown body。

**Subagent prompt 自动注入**:启动时附加最近 30 条索引行,避免每个 subagent 起手浪费一个 turn 调 `list_notes`。

### Autopilot 模式(新加,引擎侧)

启动:用户给 goal + 限额(默认 4h / 100k token)。
循环体:父代理 turn 自然结束时,引擎在 autopilot mode 下自动给父再来一个 turn,继续 list_notes / 综合 / 派 subagent / 写综合 note。
停止:限额到 / 父代理调 `declare_audit_done(summary, status)` / 用户手动停。

加一个工具:
```
declare_audit_done(summary, status: "complete" | "exhausted" | "blocked")
```

### UI 改动(零模型负担)

- Notes 面板:按 status 分三栏(open / confirmed / dead),`sev:high` 类 tag 自动着色
- "挂机审计"按钮:输入 goal + 限额,启动 autopilot
- 进度面板:当前轮、产 note 数、累计耗时
- "生成报告" 按钮:打包所有 `status: "confirmed"` 笔记为 markdown
- (可选,note > 20 后)Refs 图视图

### 对现有架构的改动

- 新增 Notes 服务(packages/core)+ 4 个工具 + autopilot loop driver
- 渲染端加 Notes 面板 + 挂机控制面板
- **不改** `start_async_task` / `update_async_task` / `task` / `AsyncTaskRecord` / agent profile / worktree 逻辑

### 工程量估算

约 960 行,3-4 天。

### 仍然不要的复杂度

| 不要 | 理由 |
|---|---|
| Finding / Lead / Tip 三种 kind | status + tags 等价表达 |
| 单独的 Weaver subagent 角色 | 父代理在 autopilot 里就是 Weaver |
| Lead claim / heartbeat 机制 | 单进程内父代理顺序决策无 race |
| 冷压缩 / cluster summary | 默认索引返回 500 条 ~15k token,够用 |
| Stateless Scout / Stateful Dive 分离 | 沿用现有 spawn |
| Profile gating | autopilot 是 session 级开关 |
| Severity 作为 schema 字段 | tag 约定(`sev:high`)即可 |
| 多项目并发 / 容器隔离 / 服务化 | 单机单项目不需要 |

### 何时再加复杂度

| 现象 | 触发的下一步 |
|---|---|
| Notes 数稳定超 500,索引行也压垮 context | 加冷压缩(cluster summary) |
| Autopilot 长跑频繁需要崩溃恢复 | 加 checkpoint 持久化 |
| 多人协作共享 audit project | 服务化 / 多租户 |
| 攻防需要严格审计任务调度 | 引入 Cairn 式 dispatcher |
| Tag 命名约定混乱无法统一 | 此时再考虑引入 schema |

**不预测,不预先建模**。

---

## 以下为决策过程的完整分析(背景资料,非实现路线)

下面的内容是探索性分析,**不是要全部实现**。保留是为了让未来回头审视时知道为什么 v1 设计成这样、哪些路被走过又被放弃。

---

## 1. 问题陈述

当前 Reina 的 Agent Team(`start_async_task` / `update_async_task` / `task` 等工具,见 [packages/tools/src/tools/agent/agent-state.ts](../packages/tools/src/tools/agent/agent-state.ts))是为**单父-多子的对话式 fan-out**设计的。在编码任务下它工作得很好,但**搬到代码审计场景会暴露三个结构性问题**:

1. **子代理之间互相看不见** — 父代理是唯一的拼接节点,所有跨子的关联必须经父 turn 中转
2. **发现困在私会话** — 子代理的对话历史不持久化,任务终态后即 GC,跨 session 没有任何累积资产
3. **stateful 模式只在一处生效** — 唯一真正利用 child 持久状态的入口是 `update_async_task`(在 child 还没结束时插嘴);其它所有路径本质都是 single-dispatch + fresh state

> **代码审计 ≠ 编码。审计是搜索问题,组合漏洞挖掘的关键是片段的 cross-pollination,而不是单 agent 深度思考。**

---

## 2. 关键观察:当前的 "stateful" 是空头支票

引用 [engine.ts:1766](../packages/core/src/engine.ts#L1766) → [engine.ts:1956](../packages/core/src/engine.ts#L1956) 的生命周期:

```
spawnChildEngine → asyncTaskChildren.set
  └─ driveAsyncChild 跑 (1 或多 turn,后者仅 update_async_task 触发)
     └─ finally: asyncTaskChildren.delete  ← child 一终态就 GC
```

| 期望中的 stateful 用法 | 实际情况 |
|---|---|
| 一个 child 跨多次父 turn 持续存在 | ❌ |
| `start_async_task` 完成后再"继续聊" | ❌(必须重新 spawn) |
| 父代理把"研究员 A"养着反复用 | ❌ |
| Session 重载后恢复 child engine | ❌(只持久化 `AsyncTaskRecord` 的 meta + result 字符串) |

**结论**:当前的 stateful 本质等价于"同一次 dispatch 内允许中途插嘴"。这个能力**值得保留为可选项**,但**不应该作为默认行为**,更不应该让架构为它支付复杂性。

---

## 3. 架构方向

**默认走无状态(stateless) + 共享知识层。少数纵深任务显式走 stateful(Dive)。**

### 为什么无状态在审计场景下结构性更优(场景验证)

| 场景 | 占比估计 | 谁赢 |
|---|---|---|
| 大规模 sink 筛查(100 个 `exec` 调用分类) | 40% | 无状态压倒性赢 — fan-out 是它的舒适区 |
| 单点纵深 taint flow(7 层调用链) | 20% | stateful 略优,但牺牲资产化 |
| 组合漏洞拼接(跨服务 IDOR 等) | 25% | **无状态压倒性赢** — Dossier 是天然拼接节点 |
| 跨 session 续审(昨天审到一半) | 15% | 无状态完胜 — 当前架构对话历史不持久化 |

加权下,无状态是**审计场景的结构性更优默认**。

### 反直觉点
> 场景 2(纵深 taint flow)看起来 stateful 快 30-50%,但 stateful 跑完什么都不留下;无状态写下的 Finding 是**第二天审同类代码时几乎零成本复用的资产**。
> **审计是马拉松,资产积累比单次速度重要。**

---

## 4. 概念与术语

不沿用 Cairn 的命名(Fact / Intent / Hint / Blackboard / Worker)。基于审计/调查领域的隐喻重命名:

| 概念 | 名字 | 含义 |
|---|---|---|
| 共享知识层 | **Dossier**(卷宗) | session 级共享的知识库,所有 subagent 读写 |
| 已确认的原子 | **Finding**(发现) | 客观、结构化、可引用的信息片段 |
| 待追的方向 | **Lead**(线索) | 已声明但未执行的探索方向,可由 Scout 认领 |
| 用户随时注入的判断 | **Tip**(提示) | 不需要等回合,直接进 Dossier,下一个 Scout 读到 |
| 无状态执行单元 | **Scout**(斥候) | fresh child,读 Dossier → 做事 → 写 Finding → 解散 |
| 有状态执行单元 | **Dive**(深潜) | 持久 child,带对话历史的长追;当前 stateful 路径降级到这里 |
| 综合 Finding 产新 Lead 的角色 | **Weaver**(织线人) | Scout 的一种 prompt 模板,只读 Dossier 不读代码,产出 Lead |

> **总隐喻**:一个调查局有一份卷宗(Dossier)。卷宗里有发现(Finding)、待追线索(Lead)、用户提示(Tip)。斥候(Scout)被派出去追线索回填发现,织线人(Weaver)翻卷宗找发现之间的关联写新线索,需要在一个点上磨很久就派深潜员(Dive)。所有人都对卷宗负责,不对彼此负责。

---

## 5. 工具表面(草案)

### 写 Dossier
```
file_finding(title, body, tags?, refs_to_findings?, refs_to_files?)
file_lead(hypothesis, from_findings, next_actions?, priority?)
close_lead(lead_id, resolution: "confirmed" | "rejected" | "stale", finding_id?)
```

### 读 Dossier
```
read_dossier(filter?: {kind, tags, since}, limit?)
read_finding(id)                       // 按需取 body
search_dossier(query, filter?, limit?) // 关键词搜
```

### 派遣
```
dispatch_scout(brief, lead_id?, role?: "scout" | "weaver")
   // 无状态,默认。fresh child,跑完即焚。
   // 若提供 lead_id,引擎自动 claim + 心跳;Scout 死则 release。

dispatch_dive(brief)
   // 有状态,显式调用。等价于当前的 task / start_async_task,但:
   // - 结束时强制 file_finding(否则它的发现就消失了)
   // - 不支持 update_async_task(养着 child 的隐喻不要)
```

### 用户侧(渲染端 → IPC)
```
post_tip(content)   // 任意时刻塞 Tip,不阻塞,下一个 read_dossier 会看到
```

---

## 6. 场景 3 完整 trace(组合 IDOR,验证工具表面)

> 任务:审 service-a 和 service-b,找跨服务权限传递问题。

```
T0  Parent
    post_tip("重点查 service-a ↔ service-b 之间的权限传递,特别是 admin token")
    dispatch_scout("枚举 service-a 鉴权端点,每个产一个 Finding")  → scout_run_001
    dispatch_scout("枚举 service-b 出向调用,每个产一个 Finding")  → scout_run_002

T1  Scout A
    read_dossier({kind:"tip"})
    glob / grep / read_file ...
    file_finding(title="a:/internal/user/<id> 仅校验源 IP",
                 refs_to_files=["auth/middleware.go:42-67"])  → finding_001
    file_finding(title="a:/admin/* 系列依赖 X-Admin-Token", ...) → finding_002

T2  Scout B(可能与 A 并发或稍后)
    read_dossier({kind:"finding", tags:["service-a"]})   ← 关键:能看到 A 的发现
    grep + read_file ...
    file_finding(title="b:POST /forward 透传外部 body 到 a:/internal/user",
                 refs_to_findings=["finding_001"])  → finding_003

T3  Parent 看到累积,显式派 Weaver
    dispatch_scout(brief="综合 Dossier 找跨服务攻击链", role="weaver")

T4  Weaver
    read_dossier({})  全量
    file_lead(hypothesis="外部 POST b:/forward 可读 a 上任意用户(IDOR via cross-service trust)",
              from_findings=["finding_001","finding_003"],
              next_actions=["确认 b:/forward 公网可达", "查 user_id ACL", "构造 PoC"],
              priority="high")  → lead_001

T5  Parent
    dispatch_scout("Pursue lead_001,验证可达性,产一条 Finding 表态",
                   lead_id="lead_001")  → scout_run_004

T6  Scout C
    引擎自动 claim_lead(lead_001) + 注入 lead 详情 + 关联 findings 全文
    read_file / grep ...
    file_finding(title="[CONFIRMED] 外部可通过 b:/forward 读 a 任意用户",
                 refs_to_findings=["finding_001","finding_003"], tags=["confirmed","idor"])
                 → finding_004
    close_lead("lead_001", resolution="confirmed", finding_id="finding_004")
```

**关键设计胜利**:
- Scout B 在 T2 **天然看到 Scout A 的发现**,无需父代理中转
- `refs_to_findings` 把组合洞的关联显式编码,Dossier 可视化能直接画图
- Weaver 是**独立的拼接节点**,context 只装 Dossier 摘要,不被代码细节污染
- 整个流程跨多次父 turn,**所有发现都持久化**,跨 session 仍可用

---

## 7. 这次 trace 暴露的设计 gap(已决策)

| # | 问题 | 决策 |
|---|---|---|
| 1 | Scout 完成判定 | 自然 turn 结束 + 静默心跳兜底;不强制 `exit_scout` 工具 |
| 2 | severity 谁评 | Scout 只描述事实,不评级。`severity_guess` 字段从 `file_finding` 删除 |
| 3 | Scout 间 race(B 先于 A 跑完) | 容忍。Weaver 是后置拼接节点,不引入 `wait_for_findings` |
| 4 | Weaver 触发时机 | 父代理显式 + 引擎在"N 条 unsynthesized finding"时广播 system message 提示父 |
| 5 | Lead 粒度 | 一个 Lead 一个假设;`next_actions` 是 hint 不是子任务,不自动展开 |
| 6 | refs schema | 拆为 `refs_to_findings`(id 列表)+ `refs_to_files`(带 line range) |
| 7 | Lead claim 原子性 | `dispatch_scout(lead_id=...)` 时引擎自动 claim + 心跳;Scout 死则 release |
| 8 | Dossier 并发写 | append-only jsonl + 进程内 mutex(session 单 process,跨进程不需要) |

---

## 8. Dossier 查询与注入策略

### 8.1 注入三层(Push) + Pull 兜底

```
Layer 0  Tips 全量(上限 100 条,超了 + 老 Tips 摘要)
Layer 1  Anchor:
  - dispatch_scout(lead_id=L)  → Lead L 全文 + L 的 cited findings 全文
  - 否则 → 父代理本 turn 内 file 的 Finding(传球)
Layer 2  Index(只 id+title+tags,每条 ~30 token):
  - 最近 N 条 Finding(N=50-100,可调)
  - 所有 open Lead 的 hypothesis 摘要
  - 所有 pinned Finding
Layer 3  Cold Summary:
  - Dossier > 200 条 Finding 时由 system-spawned Weaver 按 tag 聚类成 cluster summary
  - 原 Finding 标 cold=true,从 Layer 2 索引淡出,search_dossier 仍可命中
```

**默认 prompt 预算分配(Scout 总 30k token)**:Layer 0=2k / Layer 1=8k / Layer 2=15k / Layer 3=5k。

### 8.2 Pull 工具

```
read_finding(id)
read_findings(ids[])              // Weaver 批量
search_dossier({
  query?, tags?, refs_any?,
  refs_to_files?, since?, status?, limit?
})
list_leads({status?})
read_dossier(filter?)              // 默认返回索引行,?full=true 才返回 body
```

**v1 不实现**:embedding/语义搜索,跨 session 联邦查询。

### 8.3 关键决策

| # | 决策 | 取值 |
|---|---|---|
| 1 | Tips 注入上限 | 100 |
| 2 | Layer 2 索引条数 | 50-100(profile 可配) |
| 3 | Recency 模式 Anchor 取自 | "本 turn 父代理 file 的"(传球语义) |
| 4 | 冷压缩触发阈值 | Dossier > 200 Finding |
| 5 | `read_dossier` 默认返回 | 索引行,显式 `full:true` 才返回 body |
| 6 | search v1 检索方式 | substring + tag + refs 图,**不要** embedding |
| 7 | Dive 注入策略 | 与 Scout 同,但 Layer 1 更宽(同 tag 最近 10 条) |
| 8 | Pinned Finding 来源 | UI 手动 pin + 父代理调 `pin_finding(id)` |

### 8.4 UI 视图

| 视图 | 内容 | 用途 |
|---|---|---|
| Timeline | Findings + Leads + Tips 按时间流 | 跟随进展,看 agent 在发现什么 |
| Graph | Finding 用 refs 连边,Lead 是虚线节点 | 看组合关系,人肉发现 cluster |

Tip 输入:Cmd-K 全局快捷,不需要进面板就能塞。

---

## 9. Dive 的回收规则

### 9.1 同时上限:1

Scout 上限 8(沿用现有 `REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS`),**Dive 同时只 1 个 in-flight**。
理由:Dive 是例外不是规则;并发 Dive 在审计场景几乎找不到合理用例;应该拆成 Leads 给 Scout 排队。

### 9.2 强制产出(三种终态路径)

```
(a) Dive 调 file_finding(...)         → status=completed,正常路径
(b) Dive 调 dive_no_finding(reason)   → status=completed,允许诚实的"无发现"
(c) 引擎在超时/cancel 时自动 file_finding(kind="dive_aborted",
    body=最后 assistant message 摘要) → status=failed,进展不蒸发
```

为什么允许 (b):Dive 跑完得出"这块没问题"是有价值的负面结论,强制造假 Finding 会污染 Dossier。

### 9.3 控制面

- 无 `update_async_task` 风格中途插嘴。纠偏 = `cancel_run` + 新 dispatch。
- Wall-clock 上限 30 min(Scout 10 min),无 turn 上限。
- Stale watchdog 沿用现有逻辑。

---

## 10. 工具迁移

### 10.1 策略:**通过 agent profile 共存,不大爆炸**

新工具仅在审计相关 profile(如 `audit` / `vuln-research` / `pentest`)下可见。
旧 profile(`plan` / `code` / 通用)继续走老路径,无影响。

### 10.2 旧→新映射

| 旧 | 新 | 处置 |
|---|---|---|
| `start_async_task`(sync default) | `dispatch_scout` | 默认无状态,产物去 Dossier |
| `start_async_task`(background) | `dispatch_scout` | 不需要 background 参数,本就异步 |
| `task` 同步深度 | `dispatch_dive` | 同步语义改为父可选 wait |
| `update_async_task` | **删除** | Cancel + 新 dispatch |
| `check_async_task` | `read_dossier` + `list_runs` | Scout 状态看 list_runs,产物看 Dossier |
| `wait_async_tasks` | `wait_scouts(ids?, timeoutMs?)` | 主要给 Weaver 触发前用 |
| `gather_async_tasks` | **删除** | 产物在 Dossier 里 |
| `list_async_tasks` | `list_runs(status?)` | |
| `cancel_async_task` | `cancel_run(id)` | |

### 10.3 引擎内部改动

- 新增 `Dossier` 服务(packages/core):append-only jsonl + in-memory index + IPC 事件广播
- 新增 prompt injector(三层注入)
- `startAsyncTask` 拆为 `dispatchScout` / `dispatchDive`
- 删除 `asyncTaskChildren` 表、`pendingTaskUpdates` 队列、`driveAsyncChild` while loop
- 复用:`spawnChildEngine` / `runChildWithWatchdog` / `bridgeChildStream`

预计**净代码量减少**(update_async_task 支撑代码不少)。

---

## 11. AsyncTaskRecord 拆分

```ts
interface ScoutRun {
  id: string;                  // run_scout_xxx
  brief: string;
  leadId?: string;
  role: "scout" | "weaver";
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  findingsProduced: string[];  // 产物 id 列表
  leadsProduced: string[];
  turns: number;
  toolCalls: number;
  usage?: {...};
  error?: string;
  // 无 result 字段(产物在 Dossier);无 worktree
}

interface DiveSession {
  id: string;                  // run_dive_xxx
  brief: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  findingId?: string;          // 最终 Finding
  noFindingReason?: string;    // dive_no_finding 的 reason
  turns: number;
  toolCalls: number;
  usage?: {...};
  error?: string;
  isolation: "none" | "scratch" | "worktree";
  scratchDir?: string;
  worktreeBranch?: string;
}
```

`session.asyncTasks` → 拆为 `session.scoutRuns` + `session.diveSessions`。

---

## 12. Worktree / 文件隔离的最终位置

| 单元 | 默认 | 可选 |
|---|---|---|
| Scout | 无隔离,共享 cwd + `.reina/runs/<scout_id>/scratch/` | 无可选 |
| Dive | scratch dir(`.reina/dives/<dive_id>/scratch/`) | `isolate:"worktree"` 显式申请 |

**audit 场景 99% 不会开 worktree**。worktree 降级为"想 commit 到 branch 时才开"的边缘选项。

---

## 13. UI 端的位置

**当前 Agent Team 面板** 在审计 profile 下**降级为 Dossier 面板的一个子视图**。
理由:审计模式下 runs 只是 Dossier 演化的副作用,Dossier 本身才是主语。

通用 profile 不变,继续显示原 Agent Team 面板。

---

## 14. 仍未决定的小问题

- Dossier 持久化粒度:每个 cwd 一份(倾向)vs 每个 session 一份
- Finding 可变性:append-only + `superseded_by` 引用(倾向)vs 允许编辑
- Open Lead 自然失效:超过 X turn 没 claim 自动 `status:"stale"`,X 待定
- Scout 误写 false finding 的纠正:用 `tags:["correction"]` + `refs_to_findings:[bad]`(倾向)

---

## 9. 决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-05-15 | 不沿用 Cairn 术语,用 Dossier/Finding/Lead/Tip/Scout/Dive/Weaver | 与审计领域语义对齐;避免和 Cairn 强绑定 |
| 2026-05-15 | 默认无状态,Dive 为显式逃生口 | 场景模拟显示无状态在审计加权占优;且当前 stateful 是空头支票 |
| 2026-05-15 | 不要 `update_async_task` 风格的"中途插嘴" | 同一目的可用 cancel + 新 dispatch 表达;丢弃的中间 context 多半是噪音 |
| 2026-05-15 | Weaver 是 Scout 的 prompt 模板,不是独立 spawn 类型 | 运行机制完全相同,只是 prompt 不同;避免类型爆炸 |
| 2026-05-15 | severity 不在 Scout 阶段评 | Scout 评级会被诱导写假阳性;留给 Weaver 或 Dive 综合判断 |
| 2026-05-15 | 注入策略:Push 三层 + Pull 兜底 | 覆盖 Dossier 三种规模,索引行让大库仍可全 surface |
| 2026-05-15 | 默认 `read_dossier` 返回索引行 | 误调一次全量就 OOM context,默认必须安全 |
| 2026-05-15 | v1 不要 embedding 搜索 | 关键词 + tag + refs 图够用;embedding 是大基建,后置 |
| 2026-05-15 | Dive 同时 ≤ 1 in-flight | 例外不是规则;并发 Dive 找不到合理审计用例 |
| 2026-05-15 | Dive 允许 `dive_no_finding(reason)` 表态空产 | 强制造 Finding 会污染 Dossier;负面结论也有价值 |
| 2026-05-15 | Dive 超时/cancel 引擎自动写 `dive_aborted` Finding | 进展不蒸发,可复盘 |
| 2026-05-15 | 无 `update_async_task`,纠偏走 cancel + 新 dispatch | 中间 context 多半是噪音;丢掉 + 简化心智 |
| 2026-05-15 | 旧工具不删,审计 profile 隐藏新增 | 通用编码 profile 不被打扰,平滑过渡 |
| 2026-05-15 | Scout 不开 worktree;Dive 默认 scratch dir | 审计 99% 是只读探索,worktree 是杀鸡用牛刀 |
| 2026-05-15 | 审计 profile 下 Agent Team 面板 → Dossier 子视图 | 主语是 Dossier,runs 只是副作用 |
| 2026-05-15 | **MVP 推翻前述大部分设计**:只做 `note` + `read_notes` 两个工具 + `.reina/notes.jsonl` | 用户反馈担心过度设计拖累模型。回到场景驱动的最小需求:子笔记隔离已成立,只缺共享黑板。其它都是衍生需求,不预测先加。 |
| 2026-05-15 | 目标用户扩为审计员 + 开发 + 攻防,加 `status` 字段、`refs` 字段、改用 Markdown 文件 | 三类用户公约数:共享 + refs + tags + 持久化 + 人类可读。`status` 是唯一进 schema 的生命周期信息,其它(severity 等)用 tag 兜底。 |
| 2026-05-15 | 纳入 Autopilot 模式,加 `declare_audit_done` + loop driver | 攻防场景"挂机跑一晚"需求真实存在;数据层不变,只加执行模式,~150 行实现。 |
| 2026-05-15 | 未来扩展方向:云电脑 / 远程执行 | 用户提出后续会加云电脑等远程能力。当前 v1 保持单机本地;数据层(Markdown 文件 + refs + status)的格式与执行环境解耦,届时只需替换执行底层,不改数据格式。 |
