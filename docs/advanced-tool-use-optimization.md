# Advanced Tool Use 优化方案

> 日期：2026-05-27  
> 参考来源：[Anthropic, Introducing advanced tool use on the Claude Developer Platform](https://www.anthropic.com/engineering/advanced-tool-use)  
> 范围：本文只基于当前代码实现做优化建议，不把现有设计文档作为事实来源。
>
> **当前状态（2026-08-31 起）**：发现本地或 MCP deferred 工具后，Reina 会在**下一次请求**
> 回填该工具的完整 schema；Chat、Responses 与 Anthropic 路径采用同一语义。首次发现新工具会改变
> tools 前缀并可能造成一次缓存失效，只有在激活集合与实时 MCP 工具池不变时，定义和排序才保持稳定。
> profile allow-list / deny、MCP server 白名单与宿主可用性仍应在回填和执行时生效。本文后续章节保留
> 早期方案与当时的实现快照，供决策追溯，不应再把“解锁后永不回灌、整段会话 tools 字节恒定”视为当前事实。

## 目标

Reina 已经有一套本地实现的 deferred tools 机制。它能减少冷启动 tools 数组，但在工具被解锁后，tools 数组仍会增长；MCP runtime tools 也会被全量加入每轮请求。Anthropic 文章里的核心收益来自三点：

1. Tool Search Tool：工具库大时，只把搜索入口放进上下文。
2. Programmatic Tool Calling：让代码编排多个工具调用，减少模型往返和中间结果占用。
3. Tool Use Examples：用示例提升复杂工具参数填写准确率。

对 Reina 来说，最值得先做的是前两项中的基础部分：让 deferred 工具和 MCP 工具真正保持 tools 数组稳定，再逐步补充示例和程序化编排。

## 当前实现事实

### 本地 deferred tools

工具描述定义在 `packages/protocol/src/index.ts` 的 `ToolDescriptor`：

- `exposure?: "direct" | "deferred"`
- `catalogSummary?: string`
- `inputSchema`
- `inputJsonSchema`

`packages/tools/src/registry.ts` 把公开工具分成两类：

- `directToolDescriptors`：每轮都进入模型 tools 数组。
- `deferredToolDescriptors`：冷启动隐藏。

同一个文件还通过 `setDeferredCatalogProvider()` 把 `deferredToolDescriptors` 的 `name + summary` 提供给 `search_tool`。

### search_tool

`packages/tools/src/tools/agent/search-tool.ts` 实现了搜索：

- 查询源是 deferred catalog。
- 排序是 TF-IDF cosine 0.6 + keyword 0.4。
- ASCII token 支持 camel/snake 拆分和轻量 stem。
- CJK 文本按 unigram + bigram 分词。

`search_tool` 返回匹配列表时，只返回：

- tool name
- one-line summary

同时在 observation metadata 里返回：

```ts
metadata: {
  unmaskTools: matches.map((m) => m.name);
}
```

### 解锁路径

`packages/core/src/engine.ts` 里有两条解锁路径：

1. `recordToolMetadata()` 读取 `metadata.unmaskTools`。
2. `resolveOrUnmaskDescriptor()` 支持模型直接叫出 deferred tool name 时自动解锁。

两条路径都会进入 `unmaskDeferredTool()`，把名字写入：

```ts
session.activeDeferredTools;
```

并记录 rollout：

```ts
{ type: "active_deferred_tools", names: next }
```

### 后续 tools 数组

`resolveTools()` 会调用：

```ts
availableTools(profile, this.session.activeDeferredTools);
```

而 profile 层最终会调用 `resolveExposedTools(activeDeferred)`。当前逻辑是：

```ts
return [...directToolDescriptors, ...extras];
```

因此 deferred 工具被 unmask 后，会在后续轮次作为完整 descriptor 加回 tools 数组。

### MCP runtime tools

`packages/tools/src/mcp-runtime.ts` 的 `loadMcpRuntimeTools(cwd)` 会：

1. 加载启用的 MCP servers。
2. 并发 `listMcpToolDefs()`。
3. 为每个 MCP tool 生成一个 `mcp__server__tool` descriptor。

`packages/core/src/engine.ts` 的 `resolveTools()` 每轮都会：

```ts
const mcp = filterMcpTools(await loadMcpRuntimeTools(this.session.cwd), profile);
const resolved = [...base, ...mcp];
```

所以 MCP runtime tools 当前不走 deferred/search 机制，而是按 server 全量暴露。

### Provider 转换

`packages/providers/src/index.ts` 的 provider adapter 只把工具转成：

- name
- description
- input schema

目前没有 `input_examples`、`allowed_callers`、`defer_loading` 或同类字段。OpenAI 和 Anthropic 都走同一套 `ToolDescriptor` 抽象。

## 和 Anthropic 方案的差距

### 差距 1：deferred 工具解锁后会改变 tools 数组

当前机制省的是冷启动 token，但不是整段会话的稳定 tools prefix。一旦 `search_tool` 解锁某个工具，下一轮 tools 数组就会增长。

影响：

- Anthropic prompt cache 的 tools prefix 会变化。
- 多次解锁会产生多次 cache miss。
- 工具越多，后续轮次 tools token 越高。

优化方向：

- 搜索只让模型知道工具存在和如何调用。
- 真正调用时走稳定的代理工具。
- 被搜索到的 deferred 工具不再加回 provider tools 数组。

### 差距 2：MCP runtime tools 全量暴露

MCP 是最容易膨胀的工具来源。当前每个启用 server 的每个 tool 都会进入每轮 tools 数组。

影响：

- MCP server 越多，冷启动 token 越高。
- MCP server 连接状态和工具列表变化会影响工具前缀稳定性。
- profile whitelist 只能缩小 server 范围，不能解决单个 server 工具很多的问题。

优化方向：

- 把 MCP runtime tools 纳入 deferred catalog。
- 搜索结果返回 MCP tool 的 name、server、summary、schema 摘要。
- 调用时通过同一个代理工具分发到 `runMcpRuntimeTool()`。

### 差距 3：search_tool 结果不足以独立调用

当前 `search_tool` 只返回 `name + summary`。它依赖“下一轮把完整 descriptor 加回 tools 数组”来让模型看到 schema。

如果改成稳定代理执行，搜索结果必须提供更多调用信息：

- target tool name
- description 或 catalog summary
- input schema 摘要
- 必要时提供 examples
- 权限和审批提示

否则模型知道有工具，但不知道参数怎么填。

### 差距 4：没有工具调用示例字段

复杂工具只靠 schema 和 description。对这些工具不够：

- `schedule_wakeup`
- `start_async_task`
- MCP tools with raw JSON schema
- 未来的代理执行工具

优化方向：

- 在 Reina 自己的 `ToolDescriptor` 上加 provider-neutral 的 examples。
- 默认不把 examples 放进所有常驻 tool descriptions。
- 只在搜索结果详情、按需帮助、或 provider 支持时注入。

### 差距 5：没有程序化工具编排

当前 engine 支持 `concurrencySafe` 批量并行执行多个模型发出的 tool calls，但模型仍需要逐个发起工具调用，且每个 observation 都回到对话上下文。

Anthropic 的 Programmatic Tool Calling 更激进：模型写代码，代码在沙箱里调用工具，只把最终 stdout 或摘要回传给模型。

Reina 不应直接照搬 provider beta，但可以做本地、受限、可审计的版本。

## 推荐路线

### Phase 0：建立可验证基线

先补测量，不改行为。

目标：

- 清楚知道每轮 request 里 direct tools、active deferred tools、MCP tools 各占多少 token。
- 能测试 tools 数组是否 byte-stable。
- 能测试搜索前后 hidden tools reminder 改变时，不污染稳定 system prompt。

建议改动：

- 扩展 `measureModelRequest()` 输出，把工具拆成：
  - direct local tools
  - active deferred local tools
  - MCP runtime tools
  - deferred catalog reminder
- 加回归测试：
  - cold-start 不包含 deferred local tools。
  - search 后当前实现会加入 deferred tool，作为后续改造前的 snapshot。
  - MCP server 工具数量增加时，request tools token 会增加。

验收：

- `npm run check`
- `npx vitest run packages/core/src/prompt-size.test.ts`
- `npx vitest run packages/core/src/engine.test.ts`

### Phase 1：稳定代理执行本地 deferred tools

新增一个常驻 direct 工具，建议命名：

```ts
execute_tool;
```

输入：

```ts
{
  "name": "notify",
  "input": { "...": "..." }
}
```

设计约束：

- `execute_tool` 只是稳定入口，不代表权限。
- 权限、审批、profile allow/deny、subagent blocked tools、concurrencySafe 都必须按目标工具计算。
- 禁止调用自身，避免递归。
- 禁止调用 internal tool，除非 engine 显式允许。
- 输出 observation 可以用 `execute_tool` 的 call id，但正文必须明确真实目标工具。

建议实现方式：

1. 在 registry 增加 `execute_tool` descriptor，保持 direct。
2. 在 engine 的 `executeToolOrEngine()` 里把 `execute_tool` 当 engine-native pseudo-tool 处理。
3. 解析 `record.input.name` 和 `record.input.input`。
4. 查找目标 descriptor：
   - local direct tool
   - local deferred tool
   - 后续 Phase 2 的 MCP runtime tool
5. 生成目标 `ToolCallRecord` 或 equivalent execution context。
6. 复用现有 `needsApproval()`、`permissionVerdict()`、`blockedToolsForSession()` 和 `runTool()`。

同时修改 deferred 逻辑：

- `search_tool` 仍可记录“已发现”工具，但不再让 `resolveExposedTools()` 把 deferred descriptor 加回 tools 数组。
- `session.activeDeferredTools` 可以保留字段名以减少迁移，也可以后续改名为 `discoveredDeferredTools`。
- `buildHiddenToolsReminder()` 仍用这个集合过滤已经搜索到的工具名。

`search_tool` 需要增强输出：

- 返回 input schema 摘要。
- 返回调用提示：`execute_tool({ name: "...", input: ... })`。
- 可选返回 examples。

验收：

- 搜索 `notify` 后，下一轮 provider tools 里仍不包含 `notify`。
- 搜索结果能让模型用 `execute_tool` 调用 `notify`。
- 调用 deferred write/execute 权限工具时，审批行为和直呼目标工具一致。
- profile deny 目标工具时，即使通过 `execute_tool` 也会被拒绝。
- subagent blocked 目标工具时，即使通过 `execute_tool` 也会被拒绝。

### Phase 2：把 MCP runtime tools 纳入 deferred catalog

目标：

- MCP runtime tools 默认不进入 provider tools 数组。
- `search_tool` 可以搜索 MCP tools。
- `execute_tool` 可以调用 MCP tools。
- profile `mcpServers` whitelist 仍然生效。

建议改动：

1. 扩展 `ToolRuntimeOptions`，让 `search_tool.execute(input, options)` 能拿到当前 engine 构造的 catalog，而不是只读静态 global provider。

   示例：

   ```ts
   type ToolRuntimeOptions = {
     cwd: string;
     deferredCatalog?: DeferredCatalogEntry[];
   };
   ```

2. 在 engine 的 `resolveTools()` 或临近路径里构造 dynamic catalog：
   - local deferred descriptors
   - profile 允许的 MCP runtime descriptors
   - 排除 blocked tools
   - 排除已发现工具

3. `search_tool` 对 dynamic catalog 排序。

4. MCP catalog entry 至少包含：

   ```ts
   {
     name: "mcp__github__create_issue",
     summary: "[MCP:github] Create a GitHub issue",
     inputJsonSchema: { ... },
     permission: "network" | "execute" | "read",
     requiresApproval: true
   }
   ```

5. `execute_tool` 分发时：
   - `name.startsWith("mcp__")` 走 `runMcpRuntimeTool()`
   - 否则走 `runTool()`

6. 给小配置保留 escape hatch：
   - MCP tools 总数低于阈值时可继续 direct 暴露。
   - 超过阈值自动 deferred。
   - 阈值先用配置项，不要写死策略。

验收：

- 配置多个 MCP tools 时，cold-start provider tools 不随 MCP tool 数量线性增长。
- `search_tool({ query: "github issue" })` 能找到 `mcp__github__create_issue`。
- `execute_tool` 调 MCP tool 时保留 MCP annotations 推导出的 permission 和 approval。
- profile `mcpServers: ["github"]` 时，搜索不到 `slack` server 的 tools。
- MCP server unavailable 时，搜索或执行返回可诊断错误，而不是静默消失。

### Phase 3：增加 Tool Use Examples

目标：

- 提升复杂工具的参数正确率。
- 不把大量 examples 常驻塞进 tools 数组。

建议扩展 `ToolDescriptor`：

```ts
type ToolUseExample = {
  title?: string;
  input: unknown;
  note?: string;
};

type ToolDescriptor = {
  ...
  examples?: ToolUseExample[];
};
```

使用策略：

- direct 高频工具：最多 1 个极短 example，只有必要时进入 description 或 provider-specific field。
- deferred 工具：examples 不进冷启动 tools 数组，只在搜索结果详情里返回。
- MCP tools：除非 MCP schema 自带 examples，否则不自动生成复杂示例。

首批适合加 examples 的工具：

- `schedule_wakeup`
- `start_async_task`
- `monitor`
- `question`
- `execute_tool`

验收：

- schema validation error 数量下降。
- 复杂工具 tests 增加典型输入样例。
- prompt-size test 确认 cold-start tokens 没有明显增长。

### Phase 4：本地 Programmatic Tool Calling

这是后置项，不建议在 Phase 1/2 前做。

建议方向：

- 新增受限工具：`run_tool_script`。
- 沙箱语言优先 JavaScript 或 TypeScript，因为项目本身是 TS。
- 脚本只能调用 allowlisted tool facade。
- 默认只允许 read/concurrencySafe 工具。
- write/execute/network 必须显式审批，并且审批按真实目标工具计算。
- 中间结果默认不进入模型上下文，只返回最终摘要、统计和必要 artifact references。

适合场景：

- 多个 MCP read-only 查询后聚合。
- 批量读取文件并输出摘要。
- 大量日志过滤、排序、计数。
- 多 API fan-out 后只返回 Top N。

不适合场景：

- 需要模型逐步判断每一步下一步动作的任务。
- 高风险写操作。
- 用户希望看到完整中间过程的任务。

验收：

- 脚本执行有超时、输出截断、权限审计。
- 工具调用日志仍进入 session timeline。
- 失败时能定位到脚本行号和目标工具错误。

## 推荐实施顺序

1. Phase 0：补测量和 snapshot tests。
2. Phase 1：实现 `execute_tool`，让 local deferred tools 不再回灌 tools 数组。
3. Phase 2：MCP runtime tools 进入 dynamic deferred catalog。
4. Phase 3：给复杂工具补 examples。
5. Phase 4：评估本地 programmatic tool calling。

不要先做 Phase 4。当前最大收益不是让模型写脚本，而是先解决 tools 数组稳定性和 MCP 工具膨胀。

## 关键风险

### 权限绕过

`execute_tool` 不能拥有自己的宽权限后直接代替目标工具执行。它必须把目标工具作为权限主体。

必须覆盖：

- profile deny
- permission rules
- approval prompt
- session permission mode
- subagent blocked tools
- MCP annotations

### Provider 兼容

不要依赖 Anthropic beta 字段作为核心机制。Reina 当前 provider 抽象同时支持 OpenAI 和 Anthropic，核心路径应保持 provider-neutral。

可以在 provider 层 opportunistic 地支持某些字段，但本地 engine 语义不能依赖它们。

### 搜索结果过大

如果 `search_tool` 直接返回完整 JSON schema 和多个 examples，可能把省下的工具 token 又花回搜索结果里。

建议：

- 默认返回 schema 摘要。
- 只对 Top 1 到 Top 3 返回详细 schema。
- examples 数量默认限制为 1。
- 提供 `detail: "summary" | "schema" | "examples"`，让模型按需获取。

### MCP 状态变化

MCP tools 是动态的，不能把完整 MCP catalog 放进稳定 system prompt。

建议：

- catalog 在 per-turn runtime 生成。
- hidden tools reminder 只放概要或数量。
- 搜索结果按需返回具体 MCP tool details。

## 最小可交付版本

最小版本只做 Phase 1：

1. 新增 `execute_tool` direct tool。
2. `search_tool` 返回 `execute_tool` 调用提示和目标 schema 摘要。
3. deferred local tools 搜索后不再加入下一轮 tools 数组。
4. 所有目标权限和审批行为保持一致。
5. 加测试证明 provider tools 数组在搜索前后稳定。

这个版本不碰 MCP，不做程序化脚本，风险较小，且能验证架构是否成立。

## 成功标准

短期成功：

- cold-start tools 数组不变。
- 搜索 local deferred tool 后，下一轮 tools 数组仍 byte-stable。
- deferred 工具仍可通过 `execute_tool` 正确调用。
- 权限、审批、profile、subagent 限制没有回归。

中期成功：

- MCP tools 数量增加时，provider tools token 不线性增长。
- 搜索和调用 MCP tool 的体验可用。
- prompt cache hit rate 因 tools prefix 稳定而改善。

长期成功：

- 复杂工具参数错误率下降。
- 多工具聚合任务减少模型往返次数。
- 工具库增长不会显著拖慢普通会话。
