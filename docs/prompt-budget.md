# 工具渐进披露

## 常驻工具

默认 profile 冷启动时就出现在 tools 数组里、模型随时可调的公开工具。`registry.ts` 先用 `isDeferredByDefault()` 分桶：显式 `exposure: "deferred"` **或**列在 `defaultDeferredToolNames` 中的工具进入 deferred，其余公开工具进入 `directToolDescriptors`。profile、session mode、后台任务状态和订阅模型仍可在此基础上增减工具，因此不能只看 `exposure` 字段判断某次请求的最终数组。

目前 15 个常驻工具：
`read_file` / `write_file` / `edit_file` / `multi_edit` / `grep` / `glob` / `run_shell` / `write_todos` / `question` / `plan` / `list_skills` / `read_skill` / `search_tool` / `list_notes` / `read_note`

## 冷启动工具

由 `isDeferredByDefault()` 判定、**冷启动不进 tools 数组**的公开工具。新工具优先在 descriptor 上显式写 `exposure: "deferred"`；`defaultDeferredToolNames` 保留现有集中分桶项。最终来源是 `deferredToolDescriptors`，不是只含显式标记者。

目前 40 个冷启动工具：

| 类别                            | 工具                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team coordination（5）          | `create_subtask` / `update_subtask` / `get_dag` / `set_phase` / `send_to_worker`                                                                            |
| Async workers（8）              | `task` / `get_async_tasks` / `cancel_async_task` / `update_async_task` / `wait_async_tasks` / `send_task_message` / `start_task_batch` / `check_task_batch` |
| Goal（3）                       | `get_goal` / `create_goal` / `update_goal`                                                                                                                  |
| Audit / handoff（1）            | `declare_audit_done`                                                                                                                                        |
| Memory（4）                     | `recall_memory_chunk` / `list_memory_chunks` / `search_memory` / `consolidate_memory`                                                                      |
| Background shell（4）           | `task_output` / `kill_shell` / `monitor` / `write_stdin`                                                                                                    |
| File editing（1）               | `apply_patch`                                                                                                                                               |
| MCP resources（3）              | `mcp_list_resources` / `mcp_read_resource` / `mcp_status`                                                                                                   |
| Network（3）                    | `web_fetch` / `kimi_web_search` / `kimi_web_fetch`                                                                                                          |
| Notifications & scheduling（2） | `notify` / `schedule_wakeup`                                                                                                                                |
| Plan mode（1）                  | `exit_plan_mode`                                                                                                                                            |
| Security（2）                   | `search_java_gadgets` / `find_java_chains`                                                                                                                  |
| Notes（3）                      | `note` / `update_note` / `delete_note`                                                                                                                      |

声明位置：新 deferred 工具应在自己的 `descriptor` 里加 `exposure: "deferred"` + `catalogSummary: "..."`（一行简介）；现有集中分桶项见 `registry.ts` 的 `defaultDeferredToolNames`。

## 激活方式

两条路径：搜索发现或直接调用。激活后，所有 provider 的**下一次请求都会携带已发现工具的完整定义**，并继续遵守当前 profile、权限和宿主可用性限制。冷启动仍只发送常驻工具，不会一次加入整个目录。激活集通过 rollout 事件 `{ type: "active_deferred_tools", names: [...] }` 持久化，跨重启恢复。

这是普通工具定义回填，不依赖 provider 原生 deferred 协议。首次发现新工具时 tools 前缀可能发生一次缓存失效；激活集合与实时 MCP 工具池不变时，排序和定义保持稳定。静态 system prompt 不随激活状态变化。新增定义计入实际请求 token，移出隐藏工具预留桶，避免重复计数。

### 方式 A：主动搜索

模型调用 `search_tool({ query: "<关键词>" })`：

```
模型 → search_tool({ query: "notify" })
       │
       ▼
search_tool 匹配 deferred catalog（TF-IDF + keyword 混合排序）
       │
       ▼
返回 { output: 匹配列表, metadata: { unmaskTools: ["notify"] } }
       │
       ▼
engine.recordToolMetadata 读 metadata.unmaskTools
       │
       ▼
unmaskDeferredTool("notify")
  ├─ session.activeDeferredTools.add("notify")   ← 保存已发现集合
  └─ record({ type: "active_deferred_tools", names: [...] })
       │
       ▼
下一请求附带 notify 的完整定义，模型正常调用 notify(...)
```

### 方式 B：直接调用（自动 unmask）

模型如果"知道"工具名（从训练数据或 catalog 看到），可以直接调用，不必先搜索：

```
模型 → notify({ title: "...", body: "..." })   ← 没先搜
       │
       ▼
continueLoop 工具查找：
  tools.find("notify") = undefined
       │
       ▼
fallback：deferredToolDescriptors.find("notify")
  → 命中 deferred 分桶
       │
       ▼
unmaskDeferredTool("notify")   ← 自动激活
tools.push(descriptor)         ← 当轮也能用
       │
       ▼
正常执行 + 持久化；后续请求也携带该工具定义
```

## Agent 如何知道有冷启动工具

**内置** deferred 工具目录（`formatDeferredToolsCatalog`）编进**缓存的 system prompt**：它是编译期 deferred 集合的静态分类索引，不随激活状态变化。具体工具名、参数和示例由 `search_tool` 按需返回，不在每轮重复整个目录：

```
## Deferred tools (on demand)
NN additional native tools start hidden to keep requests small; discovered tools join subsequent requests when allowed by the active profile. Capability groups:
...
```

**MCP** 未激活工具走 per-turn reminder（`buildHiddenToolsReminder`），已常驻或已激活并发送定义的工具不重复列出。每轮按当前 cwd 重新解析 MCP 池，并检查 profile 白名单；服务器移除后，不会仅凭历史激活记录重新发送旧定义。fork 或恢复会话继承激活名称，但仍按当前权限和可用性解析。

模型遇到需求时：

- 在目录里看到关键词 → 调 `search_tool` 或直接 `<tool>(...)` 激活
- 目录里**没看到**关键词 → 凭训练知识猜测/或直接告诉用户该能力不存在

## 加新工具指南

### Step 1 — 决定常驻还是冷启动

| 问"这个工具会被几乎每个会话用到吗"       | 决定                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| 是（read/write/shell 这类）              | **常驻**（不加 `exposure` 字段，或显式 `exposure: "direct"`） |
| 否（特殊场景、和用户偏好相关、补充能力） | **冷启动**（`exposure: "deferred"`）                          |

经验阈值：如果新工具的 description 长度 ≥ 400 字符**且**只在 < 30% 的会话里用到，倾向冷启动。

### Step 2 — 写工具实现

在合适的子目录（`packages/tools/src/tools/<category>/`）新建一个 `.ts` 文件，导出 `ToolImplementation`：

```typescript
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";

const schema = z.object({
  // 用 .describe(...) 注释每个字段，模型会看到
  foo: z.string().describe("..."),
});

export const myNewTool: ToolImplementation = {
  descriptor: {
    name: "my_new_tool",
    description: "一行或多行说明，描述它做什么、何时用",
    permission: "read" | "write" | "execute" | "network" | "state",
    requiresApproval: false, // true 则用户调用前要批准
    concurrencySafe: true, // true 则可与其他 concurrencySafe 工具批量并行
    // ↓ 如果决定做冷启动工具，加这两个：
    exposure: "deferred",
    catalogSummary: "一行用途，~60 字符，由 search_tool 在命中时返回",
    inputSchema: schema,
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    // 实际逻辑
    return "结果文本";
    // 或返回 { output: "...", metadata: { ... } }
  },
};
```

### Step 3 — 注册

[packages/protocol/src/index.ts](../packages/protocol/src/index.ts) 的 `toolNames` 数组加新名字：

```typescript
export const toolNames = [
  // ...
  "my_new_tool",
] as const;
```

[packages/tools/src/registry.ts](../packages/tools/src/registry.ts) 顶部 import，并把工具实例加进 `toolImplementations` 数组：

```typescript
import { myNewTool } from "./tools/<category>/my-new-tool.js";
// ...
export const toolImplementations: ToolImplementation[] = [
  // ...
  myNewTool,
];
```

如果**是常驻工具**，到这里就够了。如果**是冷启动工具**，下面两步会自动生效（无需额外代码）：

- `deferredToolDescriptors` filter 自动包含它
- `search_tool` 的 catalog provider 自动 expose 它
- system prompt 的 `formatDeferredToolsCatalog` 自动把它计入对应能力类别（新类别需要进 `HIDDEN_TOOL_CATEGORIES`，否则计入 Misc）；具体名字仍由 `search_tool` 返回

### Step 4 — 写测试

[packages/core/src/engine.test.ts](../packages/core/src/engine.test.ts) 或对应的工具测试文件加：

- 工具能跑通（execute 返回符合预期）
- **冷启动工具**额外加：cold-start 不在 tools 数组里；搜索发现或模型直接调用后，`session.activeDeferredTools` 收到名字，下一请求携带完整定义；权限/可用性过滤仍生效

### Step 5 — 验证

```powershell
npm run check                                       # 类型检查
npx vitest run packages/core                        # 单测
npx vitest run packages/core/src/prompt-size.test.ts # 看 token 量化变化
```

### 常见陷阱

- **新工具加教学/案例**：常驻工具的 description/schema 每次请求都付；deferred 工具则从被激活并回填定义后开始付。如果是高频常驻工具且教学超过 200 字符，考虑把教学迁到一个内置 skill（参考 [packages/tools/src/tools/knowledge/builtin-skills.ts](../packages/tools/src/tools/knowledge/builtin-skills.ts) 里 `subagent-delegation` 的模式），工具描述里留一行指针 `See read_skill("<name>")`。
- **描述里写"和 X 工具的差异"**：如果 X 也是新加的，两边互相引用容易冗余。优先做一个内置 skill 统一讲选择规则。
- **冷启动工具忘记写 `catalogSummary`**：会 fallback 到 description 第一行，可能过长。手动写一行 ~60 字符的更稳。
- **修改一个已有冷启动工具的 `catalogSummary`**：模型行为会变，记得同时检查现有测试断言里是否用到这条 summary 字符串。
