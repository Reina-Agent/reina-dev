# 模型接入兼容配置

本轮更新 OpenAI SDK 至 `7.8.0`、Anthropic SDK 至 `0.122.0`。保留 Reina 的直接调用方式，不依赖 cc-switch 或 CLIProxyAPI 服务。

## 地址与认证

模型探测和正式调用共用地址解析、认证及输出 token 参数兼容处理。

- 支持 API 根地址、带版本的 base URL、完整 `/chat/completions`、`/responses` 或 `/messages` 地址。
- 完整 endpoint 不再追加版本或操作路径；查询参数保留。
- 不带版本的 base 优先尝试 `/v1`，仅在 404/405 时尝试同站点的无版本路径。需要明确禁止补版本时，可以填写完整 endpoint，或沿用末尾 `#` 的 base 标记。
- `authMode: "api-key"` 是 Anthropic 默认的 `x-api-key`；`"bearer"` 使用普通 Bearer；`"oauth"` 保留 Claude 订阅专用流程。
- `headers` 在默认请求头之后应用，拒绝换行、非法名称和大小写重复字段。当前认证模式对应的 `Authorization` / `x-api-key` 可以替代 `apiKey`；不要把密钥写进 URL。
- Chat 接口明确拒绝 `max_tokens` / `max_completion_tokens` 时，保留完整请求体并尝试替代字段一次。参数范围错误、认证失败不会触发这项转换。

“测试模型”会检查实际 JSON 或 SSE 结果：HTTP 200 中的错误、失败状态或未正常结束的流也会显示失败。连接可达性测试与模型测试仍是两个不同入口；正常的 token 上限截断可以证明模型可用，但不等于完整回答。

Chat 模型测试使用与正式调用一致的流式请求，以支持 Qwen 等只允许流式思考的模型。模型列表发现及其分页、路径回退共用 30 秒超时预算，避免测试按钮一直等待。

测试模型会产生真实 API 请求和可能的费用。很小的输出上限不一定限制思考 token（例如部分 [Qwen 模型](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)）；测试超时只表示未在 30 秒内收到有效终止，不能单凭超时认定模型不兼容。

## 思考能力

这些字段可在现有 `models.json` 条目中设置，并会保留到主模型、标题模型、压缩模型以及会话配置：

| 字段                | 含义                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `reasoningLevels`   | 完整可选集合，支持 `off/low/medium/high/xhigh/max`；非空，所有明确选择都校验。 |
| `supportedEfforts`  | 旧配置字段，仍只限制 `xhigh/max`；不会被重新解释成完整白名单。                 |
| `reasoningDialect`  | Chat 方言：`openai/deepseek/kimi/qwen/openrouter`。未知代理建议明确指定。      |
| `offEffort: "none"` | OpenAI 兼容接口用显式 `none` 表示关闭；完整集合声明 `off` 时也采用这个表示。   |
| `thinkingMode`      | Anthropic 的 `adaptive` 或 `budget` 模式。                                     |

例如，使用 DeepSeek 方言的自定义代理可以配置如下。域名、模型 ID 和密钥都需要替换：

```json
[
  {
    "id": "custom-reasoning",
    "label": "Custom reasoning model",
    "provider": "openai-chat",
    "model": "your-model-id",
    "baseUrl": "https://gateway.example/v1",
    "apiKey": "YOUR_API_KEY",
    "reasoningDialect": "deepseek",
    "reasoningLevels": ["off", "low", "high", "max"]
  }
]
```

未设置思考档位与明确关闭分开处理。当前档位不在完整集合时，界面标记 unsupported，并要求选择有效档位；不会偷偷把关闭改成开启。模型目录预填只补缺失字段，不覆盖用户设置，也不将已有旧档位配置自动收窄成新白名单。

只对确切官方 endpoint 自动识别 Chat 方言，不按模型名猜测任意代理。Kimi 的 Chat 与 Anthropic-compatible 订阅端点分别处理；具体映射按 [Kimi 参数文档](https://platform.kimi.ai/docs/api/chat)、[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) 核对，不直接复制参考代理的转换。

## 账号与流式处理

Codex 本地账号 ID、用户身份和 workspace 独立处理。同 workspace 的不同用户不会再自动合并；同用户在同 workspace 重连会保留本地设置。无法从已有 token 确认身份的旧记录保守保留，不凭邮箱猜测。历史上已经覆盖的凭据无法自动恢复，需要重新连接相关账号。

刷新锁覆盖同进程同账号，并防止旧刷新结果覆盖新的登录。没有实现多个 CLI 或进程共享同一 refresh token 的协调；不要让多套程序同时负责它的刷新。

流式调用按 [OpenAI Responses 事件约定](https://developers.openai.com/api/reference/resources/responses/streaming-events) 区分明确失败、成功终止和意外断流。明确失败保留错误类型；不能确认身份的工具分片会拒绝，不会拼错名称与参数。

验收使用假凭据、原 SDK 和本地 HTTP/SSE 夹具，包含错误响应、工具分片、取消、URL 和认证一致性；未自动使用个人账号调用真实模型。
