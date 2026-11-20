import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatMessage, ToolDescriptor } from "@reina/protocol";
import { enrichCodexLimitError, isAuthError, isContextWindowError, isRetryableStreamError, nextModelTurn, nextModelTurnStream, toolInputJsonSchema } from "./index.js";

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("deterministic provider", () => {
  it("plans a read_file tool call for README prompts", async () => {
    const turn = await nextModelTurn(
      { provider: "deterministic", model: "test" },
      {
        messages: [{ id: "msg", role: "user", content: "read README", createdAt: new Date().toISOString() }],
        observations: [],
        tools: [],
        systemPrompt: "test",
      },
    );

    expect(turn.toolCalls[0]?.name).toBe("read_file");
  });

  it("uses canonical read/shell tools for deterministic list and grep prompts", async () => {
    const listTurn = await nextModelTurn(
      { provider: "deterministic", model: "test" },
      {
        messages: [{ id: "msg", role: "user", content: "list files", createdAt: new Date().toISOString() }],
        observations: [],
        tools: [],
        systemPrompt: "test",
      },
    );
    const grepTurn = await nextModelTurn(
      { provider: "deterministic", model: "test" },
      {
        messages: [{ id: "msg", role: "user", content: "grep hello", createdAt: new Date().toISOString() }],
        observations: [],
        tools: [],
        systemPrompt: "test",
      },
    );

    expect(listTurn.toolCalls[0]).toMatchObject({ name: "read_file", input: { path: "." } });
    expect(grepTurn.toolCalls[0]).toMatchObject({ name: "run_shell", input: { command: "rg -n \"hello\"" } });
  });

  it("keeps deterministic project overview cross-platform", async () => {
    const turn = await nextModelTurn(
      { provider: "deterministic", model: "test" },
      {
        messages: [{ id: "msg", role: "user", content: "project overview", createdAt: new Date().toISOString() }],
        observations: [],
        tools: [],
        systemPrompt: "test",
      },
    );

    expect(turn.toolCalls[0]).toMatchObject({ name: "read_file", input: { path: "." } });
  });

  it("prefers direct apiKey over environment variables", async () => {
    const current = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        nextModelTurn(
          {
            provider: "openai-chat",
            model: "test-model",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "direct-key",
          },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
      ).rejects.not.toThrow(/Environment variable OPENAI_API_KEY is not set/);
    } finally {
      if (current === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = current;
    }
  });

  it("sends non-string tool parameter schemas to OpenAI chat", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        const tools: ToolDescriptor[] = [
          {
            name: "run_shell",
            description: "Run shell",
            permission: "execute",
            requiresApproval: true,
            inputSchema: z.object({
              command: z.string(),
              runInBackground: z.boolean().optional(),
              tags: z.array(z.string()).optional(),
            }),
          },
        ];

        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools,
            systemPrompt: "test",
          },
        );
      },
    );

    const parameters = requestBody?.tools?.[0]?.function?.parameters;
    expect(parameters?.properties?.command?.type).toBe("string");
    expect(parameters?.properties?.runInBackground?.type).toBe("boolean");
    expect(parameters?.properties?.tags?.type).toBe("array");
    expect(parameters?.required).toContain("command");
    expect(requestBody?.tool_choice).toBe("auto");
  });

  it("emits numeric exclusive minima in model-facing tool schemas", () => {
    const schema = toolInputJsonSchema({
      name: "create_goal",
      description: "Create a goal",
      permission: "state",
      requiresApproval: false,
      inputSchema: z.object({
        tokenBudget: z.number().int().positive().optional(),
        turnBudget: z.number().int().positive().optional(),
        wallClockBudgetMs: z.number().int().positive().optional(),
      }),
    });
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    for (const field of ["tokenBudget", "turnBudget", "wallClockBudgetMs"]) {
      expect(properties[field]?.exclusiveMinimum).toBe(0);
      expect(properties[field]?.minimum).toBeUndefined();
    }
  });

  it("marks finish_reason length as truncated without auto-continuing (Codex model)", async () => {
    const requests: Array<Record<string, any>> = [];
    const turn = await withOpenAIChatServer(
      async (body, res) => {
        requests.push(body);
        // Model stops at its output cap mid-answer.
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "partial answer" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    // No stitching, no extra request — just the partial flagged as truncated.
    expect(turn.content).toBe("partial answer");
    expect(turn.truncated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("re-issues the whole request when the stream drops mid-flight, replacing the partial", async () => {
    const requests: Array<Record<string, any>> = [];
    await withOpenAIChatServer(
      async (body, res) => {
        requests.push(body);
        if (requests.length === 1) {
          // Stream a partial delta, then an in-band error chunk — the SDK throws
          // mid-stream (a dropped/failed stream), which the driver re-issues.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ error: { message: "upstream dropped", type: "server_error" } })}\n\n`);
          res.end();
        } else {
          // Retry regenerates the whole answer (stateless re-issue, like Codex).
          writeChatStream(res, [
            { choices: [{ index: 0, delta: { content: "Hello world" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      },
      async (baseUrl) => {
        const events: Array<{ type: string; text?: string }> = [];
        const turn = await nextModelTurnStream(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
          (event) => events.push(event),
        );

        // Final content is the retry's full output — NOT stitched with "Hel".
        expect(turn.content).toBe("Hello world");
        expect(turn.truncated).toBeFalsy();
        // A reset tells the renderer to discard the dropped partial, and the
        // retry's text streams after it.
        const resetIdx = events.findIndex((e) => e.type === "stream-reset");
        expect(resetIdx).toBeGreaterThanOrEqual(0);
        const textAfterReset = events
          .slice(resetIdx)
          .filter((e) => e.type === "text-delta")
          .map((e) => e.text)
          .join("");
        expect(textAfterReset).toBe("Hello world");
      },
    );

    expect(requests).toHaveLength(2);
  });

  it("re-issues when the stream closes cleanly without ever sending a finish_reason", async () => {
    // An OpenAI-compat bridge that EOFs the SSE connection after partial text
    // but never emits a finish_reason. Without a guard this returns a silent
    // half-finished turn; like Codex/pi we treat the missing terminal signal as
    // a drop and re-issue the whole request.
    const requests: Array<Record<string, any>> = [];
    await withOpenAIChatServer(
      async (body, res) => {
        requests.push(body);
        if (requests.length === 1) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { content: "let me test the rogue server:" } }] })}\n\n`,
          );
          // Clean EOF — no finish_reason chunk ever sent.
          res.end("data: [DONE]\n\n");
        } else {
          writeChatStream(res, [
            { choices: [{ index: 0, delta: { content: "complete answer" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      },
      async (baseUrl) => {
        const events: Array<{ type: string; text?: string }> = [];
        const turn = await nextModelTurnStream(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
          (event) => events.push(event),
        );

        // The retry's complete output wins; the partial is discarded.
        expect(turn.content).toBe("complete answer");
        expect(turn.stopReason).toBe("stop");
        expect(events.some((e) => e.type === "stream-reset")).toBe(true);
      },
    );

    expect(requests).toHaveLength(2);
  });

  it("sends max_tokens when maxOutputTokens is configured", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", maxOutputTokens: 8192 },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        );
      },
    );
    expect(requestBody?.max_tokens).toBe(8192);
  });

  it("prefers raw JSON schemas for MCP-like tools", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        const tools: ToolDescriptor[] = [
          {
            name: "mcp__tavily-mcp__tavily-search",
            description: "Search with Tavily",
            permission: "network",
            requiresApproval: true,
            inputSchema: z.object({}).passthrough(),
            inputJsonSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          },
        ];

        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools,
            systemPrompt: "test",
          },
        );
      },
    );

    const parameters = requestBody?.tools?.[0]?.function?.parameters;
    expect(parameters?.properties?.query?.type).toBe("string");
    expect(parameters?.required).toContain("query");
  });

  it("does not replay OpenAI chat tool calls without matching observations", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "next prompt", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "run_shell:1",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"calc\"}" },
                    },
                  ],
                },
              },
            },
          },
        );
      },
    );

    expect(requestBody?.messages).not.toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: expect.any(Array),
      }),
    );
  });

  it("replays OpenAI chat tool calls when matching observations are present", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "done" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "run_shell:1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "run_shell:1",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"calc\"}" },
                    },
                  ],
                },
              },
            },
          },
        );
      },
    );

    const messages = requestBody?.messages ?? [];
    const assistantIndex = messages.findIndex((message: Record<string, any>) => message.role === "assistant" && message.tool_calls);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(messages[assistantIndex + 1]).toMatchObject({
      role: "tool",
      tool_call_id: "run_shell:1",
      content: "ok",
    });
  });

  it("does not replay OpenAI chat tool calls when an unmatched observation is present", async () => {
    // Repro for the backgrounded-shell 400: after `run_shell` auto-backgrounds
    // (e.g. `calc`), the engine injects a `task_output` follow-up whose callId
    // is NOT one of the assistant message's tool_calls. Replaying natively
    // would emit an orphan role:"tool" message → provider 400 ("must be a
    // response to a preceding message with 'tool_calls'"). The gate must fall
    // back to text instead.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [
              { callId: "run_shell:1", name: "run_shell", output: "{\"taskId\":\"shell_x\",\"background\":\"requested\"}" },
              { callId: "call_autofollow", name: "task_output", output: "background output" },
            ],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "run_shell:1",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"calc\",\"runInBackground\":true}" },
                    },
                  ],
                },
              },
            },
          },
        );
      },
    );

    // Per-pair repair: the real call keeps its native pairing (assistant
    // tool_calls replayed + role:"tool" result), only the orphan follow-up
    // degrades to text — nothing is lost and nothing is orphaned.
    expect(requestBody?.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
    expect(requestBody?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "run_shell:1" }));
    const serialized = JSON.stringify(requestBody?.messages);
    expect(serialized).not.toContain("Tool run_shell (run_shell:1) result");
    expect(serialized).toContain("Tool task_output (call_autofollow) result");
  });

  it("synthesizes a chat tool message for a tool_call whose observation went missing", async () => {
    // The reverse 400 direction ("an assistant message with 'tool_calls' must
    // be followed by tool messages responding to each 'tool_call_id'"): a
    // call whose result was trimmed/lost gets a placeholder tool message so
    // the native replay stays well-formed.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "run_shell:1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "run_shell:1", type: "function", function: { name: "run_shell", arguments: "{}" } },
                    { id: "run_shell:2", type: "function", function: { name: "run_shell", arguments: "{}" } },
                  ],
                },
              },
            },
          },
        );
      },
    );

    expect(requestBody?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "run_shell:1", content: "ok" }));
    const synthetic = (requestBody?.messages ?? []).find((m: Record<string, any>) => m.role === "tool" && m.tool_call_id === "run_shell:2");
    expect(synthetic).toBeDefined();
    expect(synthetic.content).toContain("no tool result recorded");
  });

  it("renders structured toolResult history as native tool_calls/tool message pairs", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "run it", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool run_shell (call_hist) result:\nok",
                ephemeral: true,
                toolResult: { callId: "call_hist", name: "run_shell", input: { command: "ls" }, output: "ok" },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        );
      },
    );

    const messages = requestBody?.messages ?? [];
    const callIndex = messages.findIndex((m: Record<string, any>) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(callIndex).toBeGreaterThan(-1);
    expect(messages[callIndex].tool_calls[0]).toMatchObject({
      id: "call_hist",
      function: { name: "run_shell", arguments: JSON.stringify({ command: "ls" }) },
    });
    expect(messages[callIndex + 1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_hist",
      content: "ok",
    });
  });

  it("reassembles a persisted multi-tool round with its historical reasoning", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "inspect", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "assistant",
                content: "",
                reasoning: "check both files",
                reasoningTrace: {
                  provider: "openai-chat",
                  model: "test-model",
                  blocks: { reasoningContent: "check both files", reasoningKey: "reasoning_content" },
                },
                createdAt: new Date().toISOString(),
              },
              {
                id: "m3",
                role: "user",
                content: "Tool read_file (call_1) result:\none",
                ephemeral: true,
                toolResult: { callId: "call_1", name: "read_file", input: { path: "a" }, output: "one" },
                createdAt: new Date().toISOString(),
              },
              {
                id: "m4",
                role: "user",
                content: "Tool read_file (call_2) result:\ntwo",
                ephemeral: true,
                toolResult: { callId: "call_2", name: "read_file", input: { path: "b" }, output: "two" },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        );
      },
    );

    const messages = requestBody?.messages ?? [];
    const assistant = messages.find((message: Record<string, any>) => message.role === "assistant" && message.tool_calls);
    expect(assistant).toMatchObject({
      content: null,
      reasoning_content: "check both files",
      tool_calls: [
        { id: "call_1", function: { name: "read_file", arguments: JSON.stringify({ path: "a" }) } },
        { id: "call_2", function: { name: "read_file", arguments: JSON.stringify({ path: "b" }) } },
      ],
    });
    const assistantIndex = messages.indexOf(assistant);
    expect(messages.slice(assistantIndex + 1, assistantIndex + 3)).toMatchObject([
      { role: "tool", tool_call_id: "call_1", content: "one" },
      { role: "tool", tool_call_id: "call_2", content: "two" },
    ]);
    expect(requestBody?.reasoning_effort).toBe("medium");
  });

  it("falls back to text observations when OpenAI chat rejects native tool replay", async () => {
    const requestBodies: Array<Record<string, any>> = [];
    await withOpenAIChatServer(
      async (body, res) => {
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                message:
                  "an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'",
              },
            }),
          );
          return;
        }
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "recovered" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        const turn = await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "run_shell:1", name: "run_shell", error: "exit 1" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "run_shell:1",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"pnpm test\"}" },
                    },
                  ],
                },
              },
            },
          },
        );
        expect(turn.content).toBe("recovered");
      },
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
    expect(requestBodies[1]?.messages).not.toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
    expect(JSON.stringify(requestBodies[1]?.messages)).toContain("Tool run_shell (run_shell:1) result");
  });

  it("retries on the DeepSeek/Qwen tool-pairing 400 phrasing (no 'tool_call_id')", async () => {
    // The provider that surfaced the original bug phrases the rejection as
    // "Messages with role 'tool' must be a response to a preceding message
    // with 'tool_calls'" — note it never says "tool_call_id". The retry net
    // must still recognize it and fall back to text observations.
    const requestBodies: Array<Record<string, any>> = [];
    await withOpenAIChatServer(
      async (body, res) => {
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
              },
            }),
          );
          return;
        }
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "recovered" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        const turn = await nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "run_shell:1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "run_shell:1",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"calc\"}" },
                    },
                  ],
                },
              },
            },
          },
        );
        expect(turn.content).toBe("recovered");
      },
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]?.messages).not.toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
    expect(JSON.stringify(requestBodies[1]?.messages)).toContain("Tool run_shell (run_shell:1) result");
  });

  it("accepts protocol tool names returned by OpenAI chat", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_shell",
                      type: "function",
                      function: { name: "run_shell", arguments: "{\"command\":\"echo hello\"}" },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "clone repo", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "run_shell",
                description: "Run command",
                permission: "execute",
                requiresApproval: true,
                inputSchema: z.object({ command: z.string() }),
              },
            ],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.toolCalls[0]).toMatchObject({
      id: "call_shell",
      name: "run_shell",
      input: { command: "echo hello" },
    });
  });

  it("normalizes common OpenAI chat tool aliases and input aliases", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_shell",
                      type: "function",
                      function: {
                        name: "runCommand",
                        arguments: "```json\n{\"cmd\":\"pnpm test\",\"timeout_ms\":\"3000\",\"run_in_background\":\"false\"}\n```",
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "run tests", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "run_shell",
                description: "Run command",
                permission: "execute",
                requiresApproval: true,
                inputSchema: z.object({ command: z.string() }),
              },
            ],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.toolCalls[0]).toMatchObject({
      id: "call_shell",
      name: "run_shell",
      input: { command: "pnpm test", timeoutMs: 3000, runInBackground: false },
    });
  });

  it("normalizes string inputs for simple tool aliases", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read",
                      type: "function",
                      function: { name: "readFile", arguments: "\"README.md\"" },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "read readme", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "read_file",
                description: "Read file",
                permission: "read",
                requiresApproval: false,
                inputSchema: z.object({ path: z.string() }),
              },
            ],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.toolCalls[0]).toMatchObject({
      id: "call_read",
      name: "read_file",
      input: { path: "README.md" },
    });
  });

  it("attaches a stable prompt_cache_key on OpenAI Chat requests", async () => {
    const requestBodies: Array<Record<string, any>> = [];
    const fire = async (baseUrl: string) =>
      nextModelTurn(
        { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
        {
          messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
          observations: [],
          tools: [],
          systemPrompt: "system prompt",
        },
      );
    await withOpenAIChatServer(
      async (body, res) => {
        requestBodies.push(body);
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        await fire(baseUrl);
        await fire(baseUrl);
      },
    );

    expect(requestBodies).toHaveLength(2);
    expect(typeof requestBodies[0]?.prompt_cache_key).toBe("string");
    expect(requestBodies[0]?.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    // Same system prompt across calls -> identical cache key (routing
    // hint stays stable so prefix-cache stays warm).
    expect(requestBodies[0]?.prompt_cache_key).toBe(requestBodies[1]?.prompt_cache_key);
  });

  it("pins OpenAI Chat prompt_cache_key to the engine session uuid — stable even as the system prompt changes", async () => {
    const requestBodies: Array<Record<string, any>> = [];
    const fire = async (baseUrl: string, systemPrompt: string) =>
      nextModelTurn(
        { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
        {
          messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
          observations: [],
          tools: [],
          systemPrompt,
          sessionId: "ses_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21",
        },
      );
    await withOpenAIChatServer(
      async (body, res) => {
        requestBodies.push(body);
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) => {
        // Different system prompts across turns (date/goals churn) must NOT
        // change the routing key — a multi-account relay (sub2api) would
        // otherwise re-route every turn and never warm the upstream cache.
        await fire(baseUrl, "system prompt A");
        await fire(baseUrl, "system prompt B");
      },
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.prompt_cache_key).toBe("3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21");
    expect(requestBodies[1]?.prompt_cache_key).toBe(requestBodies[0]?.prompt_cache_key);
  });

  it("captures total_tokens from OpenAI chat usage payload", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
    // Canonical convention: OpenAI's prompt_tokens already includes the cached
    // subset, so cachedInputTokens ⊆ inputTokens (4 ≤ 12), never additive.
    expect((turn.usage?.cachedInputTokens ?? 0)).toBeLessThanOrEqual(turn.usage?.inputTokens ?? 0);
  });

  it("uses OpenAI-compatible total_tokens when prompt_tokens is zero", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 8,
              total_tokens: 108,
            },
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "compatible-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 8,
      totalTokens: 108,
    });
  });

  it("does not report an exact context total from output-only OpenAI usage", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [], usage: { completion_tokens: 8 } },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "compatible-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 8,
    });
    expect(turn.usage?.totalTokens).toBeUndefined();
  });

  it("does not synthesize an exact context total from input-only OpenAI usage", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [], usage: { prompt_tokens: 99 } },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "compatible-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.usage).toMatchObject({
      inputTokens: 99,
      outputTokens: 0,
    });
    expect(turn.usage?.totalTokens).toBeUndefined();
  });

  it("marks Anthropic system prompt and tool definitions as cacheable", async () => {
    let requestBody: Record<string, any> | undefined;
    const turn = await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "read_file",
                description: "Read file",
                permission: "read",
                requiresApproval: false,
                inputSchema: z.object({ path: z.string() }),
              },
            ],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(turn.content).toBe("ok");
    expect(requestBody?.system).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
    expect(requestBody?.tools?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("skips Anthropic prompt cache by default for custom compatible endpoints", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "read_file",
                description: "Read file",
                permission: "read",
                requiresApproval: false,
                inputSchema: z.object({ path: z.string() }),
              },
            ],
            systemPrompt: "system prompt",
          },
        ),
      undefined,
    );

    expect(requestBody?.system).toEqual([{ type: "text", text: "system prompt" }]);
    expect(requestBody?.tools?.[0]?.cache_control).toBeUndefined();
    const lastMessage = requestBody?.messages?.[requestBody.messages.length - 1];
    expect(typeof lastMessage?.content).toBe("string");
  });

  it("renders structured toolResult history as native tool_use/tool_result pairs", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "run it", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool run_shell (toolu_hist) result:\nok",
                ephemeral: true,
                toolResult: { callId: "toolu_hist", name: "run_shell", input: { command: "ls" } },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
      undefined,
    );

    const messages = requestBody?.messages ?? [];
    const callIndex = messages.findIndex(
      (m: Record<string, any>) => m.role === "assistant" && Array.isArray(m.content) && m.content[0]?.type === "tool_use",
    );
    expect(callIndex).toBeGreaterThan(-1);
    expect(messages[callIndex].content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_hist",
      name: "run_shell",
      input: { command: "ls" },
    });
    // The tool_result must sit in the IMMEDIATELY following user message —
    // the adjacency Anthropic enforces.
    expect(messages[callIndex + 1].role).toBe("user");
    expect(messages[callIndex + 1].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_hist",
      content: "Tool run_shell (toolu_hist) result:\nok",
    });
  });

  it("renders an image-bearing toolResult as inline image + text blocks", async () => {
    // read_file on an image persists its bytes on toolResult.attachments. On
    // replay the Anthropic tool_result content must become an ARRAY (image
    // block + text note), not a bare string — that is how the model SEES it.
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "look", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool read_file (toolu_img) result:\nRead image shot.png",
                ephemeral: true,
                toolResult: {
                  callId: "toolu_img",
                  name: "read_file",
                  input: { path: "shot.png" },
                  attachments: [{ kind: "image", mime: "image/png", dataBase64: "QUJD", name: "shot.png" }],
                },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
      undefined,
    );

    const messages = requestBody?.messages ?? [];
    const callIndex = messages.findIndex(
      (m: Record<string, any>) => m.role === "assistant" && Array.isArray(m.content) && m.content[0]?.type === "tool_use",
    );
    expect(callIndex).toBeGreaterThan(-1);
    const result = messages[callIndex + 1].content[0];
    expect(result.type).toBe("tool_result");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
    expect(result.content[1]).toMatchObject({ type: "text" });
  });

  it("renders a PDF-bearing toolResult as an inline document + text block", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "read it", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool read_file (toolu_pdf) result:\nRead PDF report.pdf",
                ephemeral: true,
                toolResult: {
                  callId: "toolu_pdf",
                  name: "read_file",
                  input: { path: "report.pdf" },
                  attachments: [{ kind: "pdf", mime: "application/pdf", dataBase64: "JVBE", name: "report.pdf" }],
                },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
      undefined,
    );

    const messages = requestBody?.messages ?? [];
    const callIndex = messages.findIndex(
      (m: Record<string, any>) => m.role === "assistant" && Array.isArray(m.content) && m.content[0]?.type === "tool_use",
    );
    expect(callIndex).toBeGreaterThan(-1);
    const result = messages[callIndex + 1].content[0];
    expect(result.type).toBe("tool_result");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBE" },
      title: "report.pdf",
    });
    expect(result.content[1]).toMatchObject({ type: "text" });
  });

  it("renders a live image observation as inline image + text blocks", async () => {
    // The same path for a FRESH turn: observation.attachments must surface as
    // an image block in the live tool_result content.
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "m1", role: "user", content: "look", createdAt: new Date().toISOString() }],
            observations: [
              {
                callId: "toolu_live",
                name: "read_file",
                output: "Read image shot.png",
                attachments: [{ kind: "image", mime: "image/png", dataBase64: "QUJD", name: "shot.png" }],
              },
            ],
            tools: [],
            systemPrompt: "system prompt",
            providerState: {
              provider: "anthropic-messages",
              data: {
                assistantContent: [{ type: "tool_use", id: "toolu_live", name: "read_file", input: { path: "shot.png" } }],
              },
            },
          },
        ),
      undefined,
    );

    const messages = requestBody?.messages ?? [];
    const resultMsg = messages.find(
      (m: Record<string, any>) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
    );
    expect(resultMsg).toBeDefined();
    expect(Array.isArray(resultMsg.content[0].content)).toBe(true);
    expect(resultMsg.content[0].content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });

  it("attaches a rolling cache breakpoint to the last Anthropic message so history is cached", async () => {
    // Long-conversation optimization: without this, every new turn re-reads
    // the entire (growing) messages array at full input price; only
    // [tools + system] would be cached. The breakpoint advances each turn
    // so the cumulative cache covers the rolling history window.
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "u1", role: "user", content: "first turn", createdAt: new Date().toISOString() },
              { id: "a1", role: "assistant", content: "reply", createdAt: new Date().toISOString() },
              { id: "u2", role: "user", content: "second turn", createdAt: new Date().toISOString() },
            ],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    const lastMessage = requestBody?.messages?.[requestBody.messages.length - 1];
    const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
    const lastBlock = blocks[blocks.length - 1];
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("captures cache_creation_input_tokens from Anthropic usage payload", async () => {
    // Without this the renderer can't distinguish "cold cache write" (next
    // turn will hit) from "no cache support" (next turn won't hit either) —
    // both show cachedInputTokens=0. Cache creation > 0 means the cold
    // write happened; subsequent turns should report cache reads.
    const turn = await withAnthropicServer(
      async (_body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        writeSse(res, "message_start", {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 1200,
            },
          },
        });
        writeSse(res, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        });
        writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        writeSse(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        writeSse(res, "message_stop", { type: "message_stop" });
        res.end();
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(turn.usage?.cachedInputTokens).toBe(1200);
    expect(turn.usage?.cacheCreationInputTokens).toBe(5000);
    // Canonical convention: inputTokens folds the separately-reported cache
    // fields in (non-cached 10 + read 1200 + creation 5000 = 6210), so cache is
    // a subset of inputTokens, not additive on top of it.
    expect(turn.usage?.inputTokens).toBe(6210);
    // Invariant: inputTokens + outputTokens === totalTokens (6210 + 1).
    expect(turn.usage?.totalTokens).toBe(6211);
    expect((turn.usage?.cachedInputTokens ?? 0)).toBeLessThanOrEqual(turn.usage?.inputTokens ?? 0);
  });

  it("threads systemReminders into the last Anthropic user message, leaving system prompt untouched", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "stable system prompt",
            systemReminders: ["## Hidden tools\nnotify, schedule_wakeup"],
          },
        ),
    );

    // System prompt must stay byte-identical to what the caller passed in —
    // reminder content lives in messages, not system, so the cached prefix
    // does not bust when the roster changes.
    expect(requestBody?.system).toEqual([
      { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
    const lastMessage = requestBody?.messages?.[requestBody.messages.length - 1];
    expect(lastMessage?.role).toBe("user");
    const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
    const reminderBlock = blocks.find((b: any) => b.type === "text" && String(b.text).includes("<system-reminder>"));
    expect(reminderBlock?.text).toContain("## Hidden tools");
    expect(reminderBlock?.text).toContain("notify, schedule_wakeup");
    // The user's original "hello" must survive alongside the reminder.
    const helloBlock = blocks.find((b: any) => b.type === "text" && b.text === "hello");
    expect(helloBlock).toBeTruthy();
  });

  it("threads systemReminders into a trailing user message on OpenAI Chat", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      async (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "stable system prompt",
            systemReminders: ["## Hidden tools\nnotify"],
          },
        ),
    );

    const systemMessages = (requestBody?.messages ?? []).filter((m: any) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toBe("stable system prompt");
    const lastMessage = requestBody?.messages?.[requestBody.messages.length - 1];
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content).toContain("<system-reminder>");
    expect(lastMessage?.content).toContain("## Hidden tools");
  });

  it("retries Anthropic requests without prompt cache when a compatible provider rejects it", async () => {
    const requestBodies: Array<Record<string, any>> = [];
    const turn = await withAnthropicServer(
      async (body, res) => {
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "unknown field cache_control" } }));
          return;
        }
        writeAnthropicStream(res, "recovered");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(turn.content).toBe("recovered");
    expect(requestBodies).toHaveLength(2);
    expect(Array.isArray(requestBodies[0]?.system)).toBe(true);
    // Retry drops cache_control but keeps the block form — some relays only
    // accept []ClaudeContent for `system` and 400 on a bare string.
    expect(requestBodies[1]?.system).toEqual([{ type: "text", text: "system prompt" }]);
  });

  it("marks an Anthropic stop_reason max_tokens as truncated without auto-continuing", async () => {
    const requests: Array<Record<string, any>> = [];
    const turn = await withAnthropicServer(
      async (body, res) => {
        requests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        writeSse(res, "message_start", {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        });
        writeSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        writeSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } });
        writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        writeSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 1 } });
        writeSse(res, "message_stop", { type: "message_stop" });
        res.end();
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    // No stitching, no extra request — just the partial flagged as truncated.
    expect(turn.content).toBe("partial answer");
    expect(turn.truncated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("sends configured maxOutputTokens as the Anthropic max_tokens", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key", maxOutputTokens: 5000 },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );
    expect(requestBody?.max_tokens).toBe(5000);
  });

  it("marks a Responses incomplete (max_output_tokens) as truncated without continuing", async () => {
    const requests: Array<Record<string, any>> = [];
    const turn = await withOpenAIChatServer(
      async (body, res) => {
        requests.push(body);
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "partial answer" },
          {
            type: "response.incomplete",
            response: {
              id: "resp_1",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
              usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
            },
          },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.content).toBe("partial answer");
    expect(turn.truncated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("sends max_output_tokens to the Responses API when configured", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key", maxOutputTokens: 7000 },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );
    expect(requestBody?.max_output_tokens).toBe(7000);
  });

  it("re-issues a Responses request that drops mid-stream, replacing the partial", async () => {
    const requests: Array<Record<string, any>> = [];
    await withOpenAIChatServer(
      async (body, res) => {
        requests.push(body);
        if (requests.length === 1) {
          // Partial delta then an in-band error -> SDK throws mid-stream.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`);
          res.write(`data: ${JSON.stringify({ error: { message: "upstream dropped", type: "server_error" } })}\n\n`);
          res.end();
        } else {
          writeResponsesStream(res, [
            { type: "response.output_text.delta", delta: "Hello world" },
            { type: "response.completed", response: { id: "resp_2", status: "completed", output: [], usage: {} } },
          ]);
        }
      },
      async (baseUrl) => {
        const events: Array<{ type: string; text?: string }> = [];
        const turn = await nextModelTurnStream(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
          (event) => events.push(event),
        );

        expect(turn.content).toBe("Hello world");
        const resetIdx = events.findIndex((e) => e.type === "stream-reset");
        expect(resetIdx).toBeGreaterThanOrEqual(0);
        const textAfterReset = events
          .slice(resetIdx)
          .filter((e) => e.type === "text-delta")
          .map((e) => e.text)
          .join("");
        expect(textAfterReset).toBe("Hello world");
      },
    );

    expect(requests).toHaveLength(2);
  });

  it("sends image and PDF attachments as Chat Completions content parts", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              {
                id: "msg",
                role: "user",
                content: "describe these",
                attachments: [
                  { kind: "image", mime: "image/png", dataBase64: "AAAA" },
                  { kind: "pdf", mime: "application/pdf", dataBase64: "BBBB", name: "spec.pdf" },
                ],
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    // System message stays a plain string; the user turn is now content parts.
    const userMessage = requestBody?.messages?.find((m: any) => m.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage.content as Array<Record<string, any>>;
    // Attachments come first (image, pdf), then the text — same ordering as
    // the Anthropic path.
    expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    expect(parts[1]).toEqual({ type: "file", file: { file_data: "data:application/pdf;base64,BBBB", filename: "spec.pdf" } });
    expect(parts[2]).toEqual({ type: "text", text: "describe these" });
  });

  it("sends image and PDF attachments as Responses input content parts", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              {
                id: "msg",
                role: "user",
                content: "describe these",
                attachments: [
                  { kind: "image", mime: "image/jpeg", dataBase64: "CCCC" },
                  { kind: "pdf", mime: "application/pdf", dataBase64: "DDDD", name: "report.pdf" },
                ],
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    const userInput = requestBody?.input?.find((item: any) => item.role === "user");
    expect(Array.isArray(userInput?.content)).toBe(true);
    const parts = userInput.content as Array<Record<string, any>>;
    expect(parts[0]).toEqual({ type: "input_image", image_url: "data:image/jpeg;base64,CCCC", detail: "high" });
    expect(parts[1]).toEqual({ type: "input_file", file_data: "data:application/pdf;base64,DDDD", filename: "report.pdf" });
    expect(parts[2]).toEqual({ type: "input_text", text: "describe these" });
  });

  it("Chat: a tool result's image rides as a follow-up user message (OpenAI tool channel is text-only)", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "look", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool read_file (call_img) result:\nRead image shot.png",
                ephemeral: true,
                toolResult: {
                  callId: "call_img",
                  name: "read_file",
                  input: { path: "shot.png" },
                  attachments: [{ kind: "image", mime: "image/png", dataBase64: "QUJD", name: "shot.png" }],
                },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    const messages = requestBody?.messages as Array<Record<string, any>>;
    const toolIdx = messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "call_img");
    expect(toolIdx).toBeGreaterThan(-1);
    // The text tool result, then a user message carrying the actual image.
    const media = messages[toolIdx + 1];
    expect(media.role).toBe("user");
    expect(Array.isArray(media.content)).toBe(true);
    expect(media.content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  });

  it("Responses: a tool result's PDF is NOT injected as a file (relay-unsafe); text carries it", async () => {
    // PDF input support is spotty across OpenAI-compatible relays (a 400 would
    // kill the turn), so PDFs are NOT re-surfaced as input_file on this path —
    // the extracted text in the tool output is what the model reads. Only the
    // Anthropic path renders a native PDF document block.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "read it", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool read_file (call_pdf) result:\nRead PDF report.pdf, 1 page(s). Extracted text below. Hello Reina",
                ephemeral: true,
                toolResult: {
                  callId: "call_pdf",
                  name: "read_file",
                  input: { path: "report.pdf" },
                  attachments: [{ kind: "pdf", mime: "application/pdf", dataBase64: "JVBE", name: "report.pdf" }],
                },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );

    const input = requestBody?.input as Array<Record<string, any>>;
    const outIdx = input.findIndex((it) => it.type === "function_call_output" && it.call_id === "call_pdf");
    expect(outIdx).toBeGreaterThan(-1);
    // The function_call_output text carries the PDF content...
    expect(input[outIdx].output).toContain("Hello Reina");
    // ...and there is NO input_file item injected anywhere.
    const hasFile = input.some(
      (it) => Array.isArray(it.content) && it.content.some((p: any) => p?.type === "input_file"),
    );
    expect(hasFile).toBe(false);
  });
});

describe("reasoning trace capture (Stage 2)", () => {
  it("captures Anthropic thinking blocks with signature into reasoningTrace", async () => {
    const turn = await withAnthropicServer(
      async (_body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        writeSse(res, "message_start", {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          },
        });
        writeSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        writeSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weigh options" } });
        writeSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-xyz" } });
        writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        writeSse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        writeSse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } });
        writeSse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
        writeSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
        writeSse(res, "message_stop", { type: "message_stop" });
        res.end();
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "msg", role: "user", content: "decide", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(turn.reasoning).toBe("weigh options");
    expect(turn.reasoningTrace?.provider).toBe("anthropic-messages");
    expect(turn.reasoningTrace?.model).toBe("test-model");
    const blocks = turn.reasoningTrace?.blocks as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("thinking");
    expect(blocks[0]?.signature).toBe("sig-xyz");
  });

  it("requests include:reasoning.encrypted_content and captures Responses reasoning + message items", async () => {
    let requestBody: Record<string, any> | undefined;
    const turn = await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "answer" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [
                { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-abc" },
                { type: "message", id: "m_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] },
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            },
          },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "msg", role: "user", content: "decide", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(requestBody?.include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBody?.reasoning?.effort).toBe("high");
    expect(turn.reasoningTrace?.provider).toBe("openai-responses");
    // The trace carries the whole assistant item stream — reasoning items AND
    // the message item with its original id — so replay can re-emit it
    // verbatim (pi-style) instead of anchoring to a flattened role message.
    const blocks = turn.reasoningTrace?.blocks as Array<Record<string, any>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("reasoning");
    expect(blocks[0]?.encrypted_content).toBe("enc-abc");
    expect(blocks[1]?.type).toBe("message");
    expect(blocks[1]?.id).toBe("m_1");
  });

  it("does not replay Responses function calls when an unmatched observation is present", async () => {
    // Mirror of the chat-path pairing gate: an observation whose callId has no
    // matching stashed function_call (replay state lost mid-turn, or an
    // engine-injected follow-up like the auto task_output after a backgrounded
    // run_shell) must NOT be sent as function_call_output — the backend 400s
    // ("No tool call found for function call output with call_id ...").
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [
              { callId: "call_1", name: "run_shell", output: "ok" },
              { callId: "call_autofollow", name: "task_output", output: "background output" },
            ],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-responses",
              data: {
                assistantItems: [{ type: "function_call", call_id: "call_1", name: "run_shell", arguments: "{}" }],
              },
            },
          },
        );
      },
    );

    // Per-pair repair: call_1 keeps its native pairing; only the orphan
    // follow-up degrades to text.
    const input = requestBody?.input ?? [];
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1" }));
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "ok" }));
    expect(input).not.toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_autofollow" }));
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("Tool run_shell (call_1) result");
    expect(serialized).toContain("Tool task_output (call_autofollow) result");
  });

  it("renders structured toolResult history messages as native function_call/output pairs", async () => {
    // pi-style structured transcript: an in-band tool-result message carrying
    // ChatMessage.toolResult must become a native function_call +
    // function_call_output pair in the request input — not a flattened text
    // user message. Messages without the field keep the text path.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k" },
          {
            messages: [
              { id: "m1", role: "user", content: "run it", createdAt: new Date().toISOString() },
              {
                id: "m2",
                role: "user",
                content: "Tool run_shell (call_hist) result:\nok",
                ephemeral: true,
                toolResult: { callId: "call_hist", name: "run_shell", input: { command: "ls" }, output: "ok" },
                createdAt: new Date().toISOString(),
              },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        );
      },
    );

    const input = requestBody?.input ?? [];
    const callIndex = input.findIndex((item: Record<string, any>) => item.type === "function_call" && item.call_id === "call_hist");
    expect(callIndex).toBeGreaterThan(-1);
    expect(input[callIndex].name).toBe("run_shell");
    expect(input[callIndex].arguments).toBe(JSON.stringify({ command: "ls" }));
    expect(input[callIndex + 1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_hist",
      output: "ok",
    });
    // The structured message must NOT also appear as a flattened user message.
    expect(input).not.toContainEqual(expect.objectContaining({ role: "user", content: "Tool run_shell (call_hist) result:\nok" }));
  });

  it("synthesizes a Responses output for a function_call whose observation went missing", async () => {
    // The reverse 400 direction ("No tool output found for function call"):
    // a call whose result was trimmed/lost gets a placeholder output so the
    // replayed function_call is never left dangling.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "call_1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-responses",
              data: {
                assistantItems: [
                  { type: "function_call", call_id: "call_1", name: "run_shell", arguments: "{}" },
                  { type: "function_call", call_id: "call_2", name: "run_shell", arguments: "{}" },
                ],
              },
            },
          },
        );
      },
    );

    const input = requestBody?.input ?? [];
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "ok" }));
    const synthetic = input.find((item: Record<string, any>) => item.type === "function_call_output" && item.call_id === "call_2");
    expect(synthetic).toBeDefined();
    expect(synthetic.output).toContain("no tool result recorded");
  });

  it("replays Responses function calls natively when observations pair exactly", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      async (baseUrl) => {
        await nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k" },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "call_1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-responses",
              data: {
                assistantItems: [{ type: "function_call", call_id: "call_1", name: "run_shell", arguments: "{}" }],
              },
            },
          },
        );
      },
    );

    const input = requestBody?.input ?? [];
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1" }));
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "ok" }));
  });

  it("assembles tool calls + trace from output_item.done when response.completed carries no output (codex slim completed)", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeResponsesStream(res, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "run_shell", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":"ls"}' },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-slim" },
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "run_shell", arguments: '{"command":"ls"}' },
          },
          // Slim completed: no `output` array — everything above must still land.
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          {
            messages: [{ id: "msg", role: "user", content: "run ls", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "run_shell",
                description: "Run command",
                permission: "execute",
                requiresApproval: true,
                inputSchema: z.object({ command: z.string() }),
              },
            ],
            systemPrompt: "test",
          },
        ),
    );

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({ id: "call_1", name: "run_shell", input: { command: "ls" } });
    const blocks = turn.reasoningTrace?.blocks as Array<Record<string, any>>;
    expect(blocks?.[0]?.encrypted_content).toBe("enc-slim");
  });

  it("captures OpenAI Chat reasoning_content into reasoningTrace", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { reasoning_content: "step one" } }] },
          { choices: [{ index: 0, delta: { content: "answer" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "msg", role: "user", content: "decide", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    expect(turn.reasoning).toBe("step one");
    expect(turn.reasoningTrace?.provider).toBe("openai-chat");
    expect((turn.reasoningTrace?.blocks as { reasoningContent?: string })?.reasoningContent).toBe("step one");
  });
});

describe("reasoning replay (Stage 3)", () => {
  it("Responses re-emits prior reasoning + function_call before function_call_output (within-turn)", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "done" },
          { type: "response.completed", response: { id: "r2", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [
              { id: "u1", role: "user", content: "do it", createdAt: new Date().toISOString() },
              { id: "a1", role: "assistant", content: "", reasoning: "thinking", createdAt: new Date().toISOString() },
            ],
            observations: [{ callId: "call_1", name: "read_file" as any, output: "file contents" }],
            tools: [],
            systemPrompt: "sys",
            providerState: {
              provider: "openai-responses",
              data: {
                assistantItems: [
                  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
                  { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{}" },
                ],
              },
            },
          },
        ),
    );
    const input = body?.input as Array<Record<string, any>>;
    const reasoningIdx = input.findIndex((i) => i.type === "reasoning");
    const fcIdx = input.findIndex((i) => i.type === "function_call");
    const outIdx = input.findIndex((i) => i.type === "function_call_output");
    // Order matters: reasoning precedes its function_call, which precedes the output.
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(fcIdx).toBeGreaterThan(reasoningIdx);
    expect(outIdx).toBeGreaterThan(fcIdx);
    expect(input[reasoningIdx]?.encrypted_content).toBe("enc-1");
    expect(input[fcIdx]?.call_id).toBe("call_1");
    expect(input[outIdx]?.call_id).toBe("call_1");
  });

  it("Responses does not replay assistant items on a fresh turn (no observations)", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "hi" },
          { type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "u1", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "sys",
            providerState: {
              provider: "openai-responses",
              data: { assistantItems: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" }] },
            },
          },
        ),
    );
    const input = body?.input as Array<Record<string, any>>;
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
  });

  const priorThinkingTurn = (model: string) => ({
    messages: [
      { id: "u1", role: "user" as const, content: "q1", createdAt: new Date().toISOString() },
      {
        id: "a1",
        role: "assistant" as const,
        content: "answer1",
        reasoningTrace: { provider: "anthropic-messages" as const, model, blocks: [{ type: "thinking", thinking: "t1", signature: "s1" }] },
        createdAt: new Date().toISOString(),
      },
      { id: "u2", role: "user" as const, content: "q2", createdAt: new Date().toISOString() },
    ],
    observations: [],
    tools: [],
    systemPrompt: "sys",
  });
  const anthropicThinkingMsg = (body: Record<string, any> | undefined) =>
    (body?.messages as Array<Record<string, any>>)?.find(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking"),
    );

  it("Anthropic replays a prior turn's signed thinking block before the answer text (same model)", async () => {
    let body: Record<string, any> | undefined;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          priorThinkingTurn("claude-x"),
        ),
    );
    const a1 = anthropicThinkingMsg(body);
    expect(a1).toBeTruthy();
    expect(a1!.content[0]).toMatchObject({ type: "thinking", signature: "s1" });
    expect(a1!.content[1]).toEqual({ type: "text", text: "answer1" });
  });

  it("Anthropic does NOT replay a trace produced by a different model (stale signature)", async () => {
    let body: Record<string, any> | undefined;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          priorThinkingTurn("claude-OLD"),
        ),
    );
    expect(anthropicThinkingMsg(body)).toBeUndefined();
  });

  it("Anthropic does NOT replay reasoning when thinking is disabled this turn", async () => {
    let body: Record<string, any> | undefined;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-x", baseUrl, apiKey: "k" }, // no reasoningEffort
          priorThinkingTurn("claude-x"),
        ),
    );
    expect(anthropicThinkingMsg(body)).toBeUndefined();
  });

  it("Responses replays a prior turn's reasoning item immediately before its assistant message", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          {
            messages: [
              { id: "u1", role: "user", content: "q1", createdAt: new Date().toISOString() },
              {
                id: "a1",
                role: "assistant",
                content: "answer1",
                reasoningTrace: { provider: "openai-responses", model: "gpt-x", blocks: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" }] },
                createdAt: new Date().toISOString(),
              },
              { id: "u2", role: "user", content: "q2", createdAt: new Date().toISOString() },
            ],
            observations: [],
            tools: [],
            systemPrompt: "sys",
          },
        ),
    );
    const input = body?.input as Array<Record<string, any>>;
    const reasoningIdx = input.findIndex((i) => i.type === "reasoning" && i.encrypted_content === "enc-1");
    const a1Idx = input.findIndex((i) => i.role === "assistant" && i.content === "answer1");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(a1Idx).toBe(reasoningIdx + 1); // reasoning sits immediately before its message
  });

  it("Responses replays a trace that carries the message item verbatim, skipping the flattened role message", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          {
            messages: [
              { id: "u1", role: "user", content: "q1", createdAt: new Date().toISOString() },
              {
                id: "a1",
                role: "assistant",
                content: "answer1",
                reasoningTrace: {
                  provider: "openai-responses",
                  model: "gpt-x",
                  blocks: [
                    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
                    {
                      type: "message",
                      id: "m_1",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: "answer1", annotations: [] }],
                    },
                  ],
                },
                createdAt: new Date().toISOString(),
              },
              { id: "u2", role: "user", content: "q2", createdAt: new Date().toISOString() },
            ],
            observations: [],
            tools: [],
            systemPrompt: "sys",
          },
        ),
    );
    const input = body?.input as Array<Record<string, any>>;
    const reasoningIdx = input.findIndex((i) => i.type === "reasoning" && i.encrypted_content === "enc-1");
    const msgItemIdx = input.findIndex((i) => i.type === "message" && i.id === "m_1");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(msgItemIdx).toBe(reasoningIdx + 1); // original item stream, in order
    // No duplicated flattened role message for the same turn.
    expect(input.some((i) => !i.type && i.role === "assistant" && i.content === "answer1")).toBe(false);
  });

  // Mid-session model switch: the prior model's trace can't replay natively
  // (signature/encrypted content is model-scoped), but its plain reasoning
  // text downgrades into the assistant message so continuity survives.
  const switchedModelTurn = () => ({
    messages: [
      { id: "u1", role: "user" as const, content: "q1", createdAt: new Date().toISOString() },
      {
        id: "a1",
        role: "assistant" as const,
        content: "answer1",
        reasoning: "old chain of thought",
        reasoningTrace: {
          provider: "anthropic-messages" as const,
          model: "claude-OLD",
          blocks: [{ type: "thinking", thinking: "old chain of thought", signature: "s1" }],
        },
        createdAt: new Date().toISOString(),
      },
      { id: "u2", role: "user" as const, content: "q2", createdAt: new Date().toISOString() },
    ],
    observations: [],
    tools: [],
    systemPrompt: "sys",
  });

  it("Anthropic downgrades a switched-model trace's reasoning to plain text (even with thinking off)", async () => {
    let body: Record<string, any> | undefined;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-x", baseUrl, apiKey: "k" }, // no reasoningEffort
          switchedModelTurn(),
        ),
    );
    expect(anthropicThinkingMsg(body)).toBeUndefined(); // no native thinking block
    const a1 = (body?.messages as Array<Record<string, any>>)?.find((m) => Array.isArray(m.content));
    expect(a1?.content[0]).toEqual({ type: "text", text: "old chain of thought" });
    expect(a1?.content[1]).toEqual({ type: "text", text: "answer1" });
  });

  it("Responses downgrades a switched-model trace's reasoning into the assistant text", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "gpt-x", baseUrl, apiKey: "k", reasoningEffort: "high" },
          switchedModelTurn(),
        ),
    );
    const input = body?.input as Array<Record<string, any>>;
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
    const a1 = input.find((i) => i.role === "assistant");
    expect(a1?.content).toBe("old chain of thought\n\nanswer1");
  });

  it("Chat downgrades a switched-model trace's reasoning into the assistant text", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "deepseek-x", baseUrl, apiKey: "k" },
          switchedModelTurn(),
        ),
    );
    const a1 = (body?.messages as Array<Record<string, any>>)?.find((m) => m.role === "assistant");
    expect(a1?.content).toBe("old chain of thought\n\nanswer1");
  });

  it("does NOT downgrade reasoning without a trace (reasoning-only dead turn)", async () => {
    let body: Record<string, any> | undefined;
    const turn = switchedModelTurn();
    delete (turn.messages[1] as Record<string, unknown>).reasoningTrace;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn({ provider: "anthropic-messages", model: "claude-x", baseUrl, apiKey: "k", reasoningEffort: "high" }, turn),
    );
    const a1 = (body?.messages as Array<Record<string, any>>)?.find((m) => m.role === "assistant");
    expect(a1?.content).toBe("answer1"); // plain string — dead-turn reasoning stays out of context
  });
});

describe("subscription request fingerprint", () => {
  // Record the inbound request's headers + body, then stream a minimal valid
  // completion so the turn resolves. Headers aren't exposed by the shared
  // withAnthropicServer/withOpenAIChatServer helpers, so capture them here.
  async function captureRequest(
    kind: "anthropic" | "codex",
    config: Parameters<typeof nextModelTurn>[0],
    requestExtra: Record<string, unknown> = {},
  ): Promise<{ headers: http.IncomingHttpHeaders; body: Record<string, any> }> {
    let captured: { headers: http.IncomingHttpHeaders; body: Record<string, any> } | undefined;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
      if (kind === "anthropic") {
        writeAnthropicStream(res, "ok");
      } else {
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              id: "r",
              status: "completed",
              output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}${kind === "codex" ? "/v1" : ""}`;
    try {
      await nextModelTurn(
        { ...config, baseUrl },
        {
          messages: [{ id: "m", role: "user", content: "hi", createdAt: new Date().toISOString() }],
          observations: [],
          tools: [],
          systemPrompt: "system prompt",
          ...requestExtra,
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    if (!captured) throw new Error("no request captured");
    return captured;
  }

  it("Anthropic OAuth path forges the full Claude Code beta set + identity + metadata.user_id", async () => {
    const { headers, body } = await captureRequest("anthropic", {
      provider: "anthropic-messages",
      model: "claude-opus-4-8",
      apiKey: "tok",
      authMode: "oauth",
      subscriptionId: "sub-123",
    });
    const beta = String(headers["anthropic-beta"] ?? "");
    for (const flag of [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "prompt-caching-scope-2026-01-05",
      "effort-2025-11-24",
      "context-management-2025-06-27",
      "extended-cache-ttl-2025-04-11",
      "context-1m-2025-08-07", // opus-4 also advertises 1M context
    ]) {
      expect(beta).toContain(flag);
    }
    // Claude Code identity must be the first system block.
    expect(body.system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    // metadata.user_id: the impersonated UA (claude-cli/2.1.161 ≥ 2.1.78) → the
    // real CLI's JSON shape {device_id,account_uuid,session_id}, not the legacy string.
    const uid = JSON.parse(String(body.metadata?.user_id));
    expect(uid.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(uid.account_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(uid.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("non-OAuth Anthropic path sends no Claude Code betas and no metadata.user_id", async () => {
    const { headers, body } = await captureRequest("anthropic", {
      provider: "anthropic-messages",
      model: "claude-haiku-4-5",
      apiKey: "key",
    });
    expect(String(headers["anthropic-beta"] ?? "")).not.toContain("claude-code-20250219");
    expect(body.metadata).toBeUndefined();
  });

  it("API-key Anthropic through a proxy pins metadata.user_id session to the engine session — for relay sticky routing", async () => {
    const cfg = { provider: "anthropic-messages", model: "claude-haiku-4-5", apiKey: "key" } as any;
    const extra = { sessionId: "ses_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21" };
    const one = await captureRequest("anthropic", cfg, extra);
    const two = await captureRequest("anthropic", cfg, extra);
    // captureRequest always routes through a local (custom-baseUrl) server, so
    // this is the proxy/relay case: metadata.user_id is sent even on an API key.
    expect(one.body.metadata?.user_id).toBeTruthy();
    const sessionOf = (raw: string) => {
      const json = raw.startsWith("{") ? JSON.parse(raw) : null;
      return json ? json.session_id : raw.split("_session_")[1];
    };
    // session segment is the stable conversation uuid, identical across turns
    // (sub2api's #1-priority sticky key — a fresh uuid per turn would re-route).
    expect(sessionOf(String(one.body.metadata.user_id))).toBe("3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21");
    expect(two.body.metadata.user_id).toBe(one.body.metadata.user_id);
  });

  it("Codex path forges the codex_cli_rs originator + User-Agent and pairs session/conversation ids", async () => {
    const { headers } = await captureRequest("codex", {
      provider: "openai-codex-responses",
      model: "gpt-5",
      apiKey: "tok",
      accountId: "acct-1",
    });
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(String(headers["user-agent"])).toMatch(/^codex_cli_rs\/\d+\.\d+\.\d+ \(/);
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    expect(headers["session_id"]).toBeTruthy();
    expect(headers["conversation_id"]).toBe(headers["session_id"]);
  });

  it("codex pins session_id/conversation_id to the engine session uuid — stable across turns", async () => {
    const cfg = { provider: "openai-codex-responses", model: "gpt-5", apiKey: "t", accountId: "a" } as any;
    const extra = { sessionId: "ses_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21" };
    const one = await captureRequest("codex", cfg, extra);
    const two = await captureRequest("codex", cfg, extra);
    // Same conversation → same id on every request (a per-turn fresh uuid
    // would reset the backend's sticky routing and prompt-cache affinity).
    expect(one.headers["session_id"]).toBe("3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21");
    expect(two.headers["session_id"]).toBe(one.headers["session_id"]);
    expect(one.headers["conversation_id"]).toBe(one.headers["session_id"]);
    // Codex parity: prompt_cache_key is the conversation id, not a prompt hash.
    expect(one.body.prompt_cache_key).toBe("3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21");
    expect(two.body.prompt_cache_key).toBe(one.body.prompt_cache_key);
  });

  it("OAuth metadata.user_id pins its session segment to the engine session (JSON shape on a modern UA)", async () => {
    const cfg = { provider: "anthropic-messages", model: "claude-opus-4-8", apiKey: "t", authMode: "oauth", subscriptionId: "s" } as any;
    const { body } = await captureRequest("anthropic", cfg, { sessionId: "ses_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21" });
    // Fallback UA (claude-cli/2.1.161 ≥ 2.1.78) → JSON metadata.user_id.
    expect(JSON.parse(String(body.metadata?.user_id)).session_id).toBe("3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21");
  });

  it("OAuth metadata.user_id uses the legacy string shape for a pre-2.1.78 impersonated UA", async () => {
    const cfg = {
      provider: "anthropic-messages", model: "claude-opus-4-8", apiKey: "t", authMode: "oauth",
      subscriptionId: "s", subscriptionUserAgent: "claude-cli/2.0.5 (external, cli)",
    } as any;
    const { body } = await captureRequest("anthropic", cfg, { sessionId: "ses_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21" });
    expect(String(body.metadata?.user_id)).toMatch(/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_3f2c9a14-7b6e-4d2a-9c1f-8e5b0a6d4c21$/);
  });

  it("API-key path advertises extended-cache-ttl only when opted into the 1h cache tier", async () => {
    // Default tier is 5m (cheaper 1.25x write) → no beta, 5m ttl on the wire.
    const def = await withEnv("REINA_ANTHROPIC_PROMPT_CACHE", "1", () =>
      captureRequest("anthropic", { provider: "anthropic-messages", model: "claude-fable-5", apiKey: "k" }),
    );
    expect(String(def.headers["anthropic-beta"] ?? "")).not.toContain("extended-cache-ttl");
    expect(JSON.stringify(def.body)).toContain('"ttl":"5m"');

    // Opt into 1h → the beta MUST ride along, or the endpoint 400s the ttl
    // field and the cache retry strips caching (double request, zero cache).
    const oneHour = await withEnv("REINA_ANTHROPIC_PROMPT_CACHE", "1", () =>
      withEnv("REINA_ANTHROPIC_CACHE_TTL", "1h", () =>
        captureRequest("anthropic", { provider: "anthropic-messages", model: "claude-fable-5", apiKey: "k" }),
      ),
    );
    expect(String(oneHour.headers["anthropic-beta"] ?? "")).toContain("extended-cache-ttl-2025-04-11");
    expect(JSON.stringify(oneHour.body)).toContain('"ttl":"1h"');

    // Cache off → no beta regardless of tier.
    const off = await captureRequest("anthropic", { provider: "anthropic-messages", model: "claude-fable-5", apiKey: "k" });
    expect(String(off.headers["anthropic-beta"] ?? "")).not.toContain("extended-cache-ttl");
  });

  it("codex hashes a non-uuid session id into a stable uuid-v4 shape", async () => {
    const cfg = { provider: "openai-codex-responses", model: "gpt-5", apiKey: "t", accountId: "a" } as any;
    const one = await captureRequest("codex", cfg, { sessionId: "weird-legacy-id" });
    const two = await captureRequest("codex", cfg, { sessionId: "weird-legacy-id" });
    expect(one.headers["session_id"]).toBe(two.headers["session_id"]);
    expect(String(one.headers["session_id"])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("REINA_CODEX_USER_AGENT overrides the Codex User-Agent", async () => {
    const custom = "codex_cli_rs/9.9.9 (macOS 15.0; arm64) ghostty";
    const { headers } = await withEnv("REINA_CODEX_USER_AGENT", custom, () =>
      captureRequest("codex", { provider: "openai-codex-responses", model: "gpt-5", apiKey: "tok", accountId: "a" }),
    );
    expect(headers["user-agent"]).toBe(custom);
  });

  it("contextWindowTokens config overrides the 1M-context family heuristic (both directions)", async () => {
    // Declared 200k window on a family-matched model → beta forced OFF.
    const capped = await captureRequest("anthropic", {
      provider: "anthropic-messages",
      model: "claude-opus-4-8",
      apiKey: "k",
      contextWindowTokens: 200_000,
    });
    expect(String(capped.headers["anthropic-beta"] ?? "")).not.toContain("context-1m-2025-08-07");
    // Declared 1M window on a proxy alias the regex can't know → beta ON.
    const proxy = await captureRequest("anthropic", {
      provider: "anthropic-messages",
      model: "my-proxy-claude",
      apiKey: "k",
      contextWindowTokens: 1_000_000,
    });
    expect(String(proxy.headers["anthropic-beta"] ?? "")).toContain("context-1m-2025-08-07");
  });

  it("uses the live subscriptionUserAgent injected by main on both paths", async () => {
    const codex = await captureRequest("codex", {
      provider: "openai-codex-responses",
      model: "gpt-5",
      apiKey: "t",
      accountId: "a",
      subscriptionUserAgent: "codex_cli_rs/1.2.3 (Ubuntu 22.4.0; x86_64) xterm-256color",
    });
    expect(codex.headers["user-agent"]).toBe("codex_cli_rs/1.2.3 (Ubuntu 22.4.0; x86_64) xterm-256color");

    const claude = await captureRequest("anthropic", {
      provider: "anthropic-messages",
      model: "claude-opus-4-8",
      apiKey: "t",
      authMode: "oauth",
      subscriptionId: "s",
      subscriptionUserAgent: "claude-cli/9.9.9 (external, cli)",
    });
    expect(claude.headers["user-agent"]).toBe("claude-cli/9.9.9 (external, cli)");
  });
});

async function withOpenAIChatServer<T>(
  handler: (body: Record<string, any>, res: http.ServerResponse) => Promise<void> | void,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
    await handler(body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
  try {
    return await fn(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function writeChatStream(res: http.ServerResponse, chunks: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: "test-model", ...chunk })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

// Responses API SSE: the SDK yields the parsed `data` object (which carries
// `type`) when there's no `event:` line, so plain `data:` framing is enough.
function writeResponsesStream(res: http.ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

describe("Anthropic adaptive thinking (xhigh) vs budget", () => {
  // Capture the outgoing request body for a single turn against the fake server.
  const requestBodyFor = async (config: Record<string, any>): Promise<Record<string, any> | undefined> => {
    let body: Record<string, any> | undefined;
    await withAnthropicServer(
      async (b, res) => {
        body = b;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn({ provider: "anthropic-messages", baseUrl, apiKey: "k", ...config } as any, {
          messages: [{ id: "u1", role: "user", content: "hi", createdAt: new Date().toISOString() }],
          observations: [],
          tools: [],
          systemPrompt: "sys",
        }),
    );
    return body;
  };

  it("Fable 5 + xhigh → adaptive thinking with output_config.effort=xhigh", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "xhigh" });
    expect(body?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body?.output_config).toEqual({ effort: "xhigh" });
  });

  it("Fable 5 + max → output_config.effort=max", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "max" });
    expect(body?.output_config).toEqual({ effort: "max" });
  });

  it("keeps adaptive (and lower effort passes through) on a suffixed Fable 5 id", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5-20260601", reasoningEffort: "high" });
    expect(body?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body?.output_config).toEqual({ effort: "high" });
  });

  it("Opus 4.8: xhigh→xhigh, max→max", async () => {
    expect((await requestBodyFor({ model: "claude-opus-4-8", reasoningEffort: "xhigh" }))?.output_config).toEqual({ effort: "xhigh" });
    expect((await requestBodyFor({ model: "claude-opus-4-8", reasoningEffort: "max" }))?.output_config).toEqual({ effort: "max" });
  });

  it("Sonnet 4.6 has no xhigh (caps to high) but supports max", async () => {
    expect((await requestBodyFor({ model: "claude-sonnet-4-6", reasoningEffort: "xhigh" }))?.output_config).toEqual({ effort: "high" });
    expect((await requestBodyFor({ model: "claude-sonnet-4-6", reasoningEffort: "max" }))?.output_config).toEqual({ effort: "max" });
  });

  it("off → explicit disabled thinking and no output_config", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "off" });
    expect(body?.thinking).toEqual({ type: "disabled" });
    expect(body?.output_config).toBeUndefined();
  });

  it("raw legacy 'extra-high' (resumed session, no zod parse) is normalized at the boundary", async () => {
    // Budget path: must hit the xhigh budget, not silently disable thinking.
    const budget = await requestBodyFor({ model: "claude-sonnet-4-5", reasoningEffort: "extra-high" });
    expect(budget?.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    // Adaptive path: must map to xhigh, not ship "extra-high" on the wire.
    const adaptive = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "extra-high" });
    expect(adaptive?.output_config).toEqual({ effort: "xhigh" });
  });

  it("older Sonnet 4.5 stays budget-based: xhigh→32768, max→49152", async () => {
    expect((await requestBodyFor({ model: "claude-sonnet-4-5", reasoningEffort: "xhigh" }))?.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    const maxBody = await requestBodyFor({ model: "claude-sonnet-4-5", reasoningEffort: "max" });
    expect(maxBody?.thinking).toEqual({ type: "enabled", budget_tokens: 49152 });
    expect(maxBody?.output_config).toBeUndefined();
  });

  it("thinkingMode:'budget' forces the budget path even on Fable 5", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "high", thinkingMode: "budget" });
    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(body?.output_config).toBeUndefined();
  });

  it("thinkingMode:'adaptive' forces adaptive on an unmatched model (xhigh caps to high)", async () => {
    const body = await requestBodyFor({ model: "some-proxy-model", reasoningEffort: "xhigh", thinkingMode: "adaptive" });
    expect(body?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body?.output_config).toEqual({ effort: "high" });
  });

  it("supportedEfforts config overrides the model-id heuristic (proxy model keeps xhigh)", async () => {
    const body = await requestBodyFor({
      model: "some-proxy-model",
      reasoningEffort: "xhigh",
      thinkingMode: "adaptive",
      supportedEfforts: ["xhigh", "max"],
    });
    expect(body?.output_config).toEqual({ effort: "xhigh" });
  });

  it("supportedEfforts config caps below the heuristic (Fable 5 max → high)", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "max", supportedEfforts: ["low", "medium", "high"] });
    expect(body?.output_config).toEqual({ effort: "high" });
  });

  it("max folds DOWN to xhigh (not high) when the config lists xhigh only", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5", reasoningEffort: "max", supportedEfforts: ["xhigh"] });
    expect(body?.output_config).toEqual({ effort: "xhigh" });
  });

  it("no reasoningEffort → no thinking config at all", async () => {
    const body = await requestBodyFor({ model: "claude-fable-5" });
    expect(body?.thinking).toBeUndefined();
    expect(body?.output_config).toBeUndefined();
  });

  const userTurn = () => ({
    messages: [{ id: "u1", role: "user" as const, content: "hi", createdAt: new Date().toISOString() }],
    observations: [],
    tools: [],
    systemPrompt: "sys",
  });

  it("auto-downgrades adaptive→budget when the model rejects the adaptive shape, then succeeds", async () => {
    const bodies: Array<Record<string, any>> = [];
    const turn = await withAnthropicServer(
      async (b, res) => {
        bodies.push(b);
        if (bodies.length === 1) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "output_config.effort is not supported for this model" } }));
          return;
        }
        writeAnthropicStream(res, "recovered");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-fable-5", baseUrl, apiKey: "k", reasoningEffort: "xhigh" } as any,
          userTurn(),
        ),
    );
    expect(turn.content).toBe("recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[0].output_config).toEqual({ effort: "xhigh" });
    expect(bodies[1].thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(bodies[1].output_config).toBeUndefined();
  });

  it("recovers when the endpoint rejects cache_control AND the adaptive shape (sequentially)", async () => {
    // Regression: the cache-unsupported retry used to discard streamOnce's
    // outcome, so an adaptive 400 on the cacheless attempt was swallowed and
    // the turn came back empty with nothing learned.
    const bodies: Array<Record<string, any>> = [];
    const turn = await withAnthropicServer(
      async (b, res) => {
        bodies.push(b);
        if (JSON.stringify(b).includes("cache_control")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "cache_control is not supported" } }));
          return;
        }
        if (b.thinking?.type === "adaptive") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "output_config.effort is not supported for this model" } }));
          return;
        }
        writeAnthropicStream(res, "recovered");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "claude-fable-5", baseUrl, apiKey: "k", reasoningEffort: "xhigh" } as any,
          userTurn(),
        ),
    );
    expect(turn.content).toBe("recovered");
    expect(bodies).toHaveLength(3);
    expect(bodies[0].output_config).toEqual({ effort: "xhigh" }); // cache + adaptive
    expect(JSON.stringify(bodies[1])).not.toContain("cache_control"); // cache dropped, still adaptive
    expect(bodies[1].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[2].thinking).toEqual({ type: "enabled", budget_tokens: 32768 }); // adaptive learned-off
    expect(bodies[2].output_config).toBeUndefined();
  });

  it("remembers the downgrade so a later turn (same endpoint) skips adaptive entirely", async () => {
    const bodies: Array<Record<string, any>> = [];
    await withAnthropicServer(
      async (b, res) => {
        bodies.push(b);
        if (b.thinking?.type === "adaptive") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "adaptive thinking is not supported" } }));
          return;
        }
        writeAnthropicStream(res, "ok");
      },
      async (baseUrl) => {
        const cfg = { provider: "anthropic-messages", model: "claude-fable-5", baseUrl, apiKey: "k", reasoningEffort: "high" } as any;
        await nextModelTurn(cfg, userTurn()); // adaptive (400) → budget (200): 2 requests
        await nextModelTurn(cfg, userTurn()); // remembered: straight to budget: 1 request
      },
    );
    // Only the very first request probed adaptive; the rest are budget.
    expect(bodies.filter((b) => b.thinking?.type === "adaptive")).toHaveLength(1);
    expect(bodies.filter((b) => b.thinking?.type === "enabled")).toHaveLength(2);
  });

  it("does NOT auto-downgrade when thinkingMode is pinned to 'adaptive' (no retry)", async () => {
    let calls = 0;
    try {
      await withAnthropicServer(
        async (_b, res) => {
          calls += 1;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "output_config not supported" } }));
        },
        (baseUrl) =>
          nextModelTurn(
            { provider: "anthropic-messages", model: "claude-fable-5", baseUrl, apiKey: "k", reasoningEffort: "high", thinkingMode: "adaptive" } as any,
            userTurn(),
          ),
      );
    } catch {
      // A pinned mode lets the error surface — that's the point; ignore it here.
    }
    expect(calls).toBe(1);
  });
});

describe("OpenAI-path reasoning effort (config-driven caps)", () => {
  const userTurn = () => ({
    messages: [{ id: "u1", role: "user" as const, content: "hi", createdAt: new Date().toISOString() }],
    observations: [],
    tools: [],
    systemPrompt: "sys",
  });

  const chatBodyFor = async (config: Record<string, any>): Promise<Record<string, any> | undefined> => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      (b, res) => {
        body = b;
        writeChatStream(res, [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
      },
      (baseUrl) => nextModelTurn({ provider: "openai-chat", baseUrl, apiKey: "k", ...config } as any, userTurn()),
    );
    return body;
  };

  it("folds the top tiers to high when supportedEfforts is unset (conservative default)", async () => {
    expect((await chatBodyFor({ model: "gpt-5", reasoningEffort: "xhigh" }))?.reasoning_effort).toBe("high");
    expect((await chatBodyFor({ model: "gpt-5", reasoningEffort: "max" }))?.reasoning_effort).toBe("high");
  });

  it("sends xhigh on the wire when models.json declares it (codex-max style)", async () => {
    const body = await chatBodyFor({ model: "gpt-5.1-codex-max", reasoningEffort: "xhigh", supportedEfforts: ["xhigh"] });
    expect(body?.reasoning_effort).toBe("xhigh");
  });

  it("raw legacy 'extra-high' folds to high, never reaching the wire verbatim", async () => {
    const body = await chatBodyFor({ model: "gpt-5", reasoningEffort: "extra-high" });
    expect(body?.reasoning_effort).toBe("high");
  });

  it("max folds DOWN to the nearest declared tier, never up", async () => {
    expect((await chatBodyFor({ model: "m", reasoningEffort: "max", supportedEfforts: ["xhigh"] }))?.reasoning_effort).toBe("xhigh");
    expect((await chatBodyFor({ model: "m", reasoningEffort: "max", supportedEfforts: ["xhigh", "max"] }))?.reasoning_effort).toBe("max");
  });

  it("the Responses path honours supportedEfforts too", async () => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      (b, res) => {
        body = b;
        writeResponsesStream(res, [
          {
            type: "response.completed",
            response: {
              id: "r",
              status: "completed",
              output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "gpt-5.1-codex-max", baseUrl, apiKey: "k", reasoningEffort: "xhigh", supportedEfforts: ["xhigh"] } as any,
          userTurn(),
        ),
    );
    expect(body?.reasoning?.effort).toBe("xhigh");
  });
});

async function withAnthropicServer<T>(
  handler: (body: Record<string, any>, res: http.ServerResponse) => Promise<void> | void,
  fn: (baseUrl: string) => Promise<T>,
  promptCacheEnv?: string,
): Promise<T> {
  const effectivePromptCacheEnv = arguments.length >= 3 ? promptCacheEnv : "1";
  return withEnv("REINA_ANTHROPIC_PROMPT_CACHE", effectivePromptCacheEnv, async () => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
      await handler(body, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

function writeAnthropicStream(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    },
  });
  writeSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  writeSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeSse(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

describe("isRetryableStreamError", () => {
  it("retries transient rate-limit 429s and 5xx, but not 4xx", () => {
    const rateLimit = new OpenAI.APIError(429, { code: "rate_limit_exceeded" }, "Rate limit reached", undefined);
    const serverError = new OpenAI.APIError(503, undefined, "Service unavailable", undefined);
    const badRequest = new OpenAI.APIError(400, undefined, "Bad request", undefined);

    expect(isRetryableStreamError(rateLimit)).toBe(true);
    expect(isRetryableStreamError(serverError)).toBe(true);
    expect(isRetryableStreamError(badRequest)).toBe(false);
  });

  it("does not retry quota/billing exhaustion even on a 429", () => {
    const openaiQuota = new OpenAI.APIError(429, { code: "insufficient_quota" }, "You exceeded your current quota", undefined);
    const anthropicCredit = new Error("Your credit balance is too low to access the Anthropic API");

    expect(isRetryableStreamError(openaiQuota)).toBe(false);
    expect(isRetryableStreamError(anthropicCredit)).toBe(false);
  });

  it("does not retry a Codex usage-limit 429 but still retries a transient codex rate_limit_exceeded", () => {
    const usageLimit = new OpenAI.APIError(429, { code: "usage_limit_reached", plan_type: "Pro" }, "limit", undefined);
    const transient = new OpenAI.APIError(429, { code: "rate_limit_exceeded" }, "slow down", undefined);

    expect(isRetryableStreamError(usageLimit)).toBe(false);
    expect(isRetryableStreamError(transient)).toBe(true);
  });
});

describe("enrichCodexLimitError", () => {
  it("rewrites a Codex usage-limit 429 into a readable message with plan + ETA, preserving the error type", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 42 * 60;
    const err = new OpenAI.APIError(429, { code: "usage_limit_reached", plan_type: "Pro", resets_at: resetsAt }, "raw", undefined);

    const enriched = enrichCodexLimitError(err, true);
    expect(enriched).toBe(err); // same object — type/status/code intact for classification
    expect((enriched as Error).message).toMatch(/usage limit/i);
    expect((enriched as Error).message).toMatch(/pro plan/i);
    expect((enriched as Error).message).toMatch(/~4\d min/);
  });

  it("is a no-op off the codex path or for a non-limit error", () => {
    const limit = new OpenAI.APIError(429, { code: "usage_limit_reached" }, "raw", undefined);
    const limitMsg = limit.message;
    expect((enrichCodexLimitError(limit, false) as Error).message).toBe(limitMsg); // not codex → untouched

    const badRequest = new OpenAI.APIError(400, { code: "invalid_request" }, "bad", undefined);
    const badMsg = badRequest.message;
    expect((enrichCodexLimitError(badRequest, true) as Error).message).toBe(badMsg); // not a limit → untouched
  });

  it("retries connection/timeout errors that carry no HTTP status", () => {
    expect(isRetryableStreamError(new Error("socket hang up"))).toBe(true);
  });
});

describe("isAuthError", () => {
  it("flags a 401 from either provider (expired OAuth/access token)", () => {
    const openai401 = new OpenAI.APIError(401, { code: "invalid_api_key" }, "Unauthorized", undefined);
    const anthropic401 = new Anthropic.APIError(401, { type: "authentication_error" }, "invalid x-api-key", undefined);

    expect(isAuthError(openai401)).toBe(true);
    expect(isAuthError(anthropic401)).toBe(true);
  });

  it("does not flag non-401 statuses (so it never competes with the retry/quota paths)", () => {
    expect(isAuthError(new OpenAI.APIError(429, { code: "rate_limit_exceeded" }, "Rate limited", undefined))).toBe(false);
    expect(isAuthError(new OpenAI.APIError(400, undefined, "Bad request", undefined))).toBe(false);
    expect(isAuthError(new OpenAI.APIError(503, undefined, "Service unavailable", undefined))).toBe(false);
    expect(isAuthError(new Anthropic.APIError(403, { type: "permission_error" }, "Forbidden", undefined))).toBe(false);
  });

  it("ignores plain network/unknown errors", () => {
    expect(isAuthError(new Error("socket hang up"))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("isContextWindowError", () => {
  it("recognizes common provider context-window failures", () => {
    expect(isContextWindowError(new Error("context_length_exceeded: maximum context length exceeded"))).toBe(true);
    expect(isContextWindowError(new Error("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextWindowError(new Error("This model's maximum context length is 128000 tokens."))).toBe(true);
  });

  it("does not confuse rate limits or quota exhaustion with context overflow", () => {
    expect(isContextWindowError(new Error("Rate limit reached for tokens per minute"))).toBe(false);
    expect(isContextWindowError(new Error("insufficient_quota: credit balance is too low"))).toBe(false);
  });
});

describe("streaming abort", () => {
  it("cancels an in-flight stream when the signal fires, without re-issuing the request", async () => {
    const controller = new AbortController();
    let requests = 0;
    await withOpenAIChatServer(
      (_body, res) => {
        requests += 1;
        // Send one delta, then hold the stream open forever. Only an abort —
        // not a normal `[DONE]` — can unblock the client here.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_test",
            object: "chat.completion.chunk",
            created: 0,
            model: "test-model",
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          })}\n\n`,
        );
      },
      async (baseUrl) => {
        const promise = nextModelTurnStream(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "m", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
          (event) => {
            // Interrupt mid-stream, the moment the first delta lands.
            if (event.type === "text-delta") controller.abort();
          },
          controller.signal,
        );
        // The server never ends the stream, so this only settles because the
        // abort cancelled the in-flight request. The SDK may surface that as a
        // clean stop (partial content) or a throw — both are fine; what matters
        // is that it doesn't hang.
        await promise.catch(() => undefined);
        // And the aborted request must NOT be re-issued by driveStreamingTurn.
        expect(requests).toBe(1);
      },
    );
  });
});

describe("vacuous assistant messages", () => {
  // A thinking-only round persists {role:"assistant", content:""} in history;
  // serialized bare, strict providers 400 on it forever ("must not be empty").
  // Every wire must drop it at serialization time — the transcript keeps it.
  const history: ChatMessage[] = [
    { id: "m1", role: "user", content: "hello", createdAt: new Date().toISOString() },
    { id: "m2", role: "assistant", content: "", reasoning: "silent thinking", createdAt: new Date().toISOString() },
    { id: "m3", role: "user", content: "continue", createdAt: new Date().toISOString() },
  ];

  it("drops empty assistant messages from Anthropic history", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          { messages: history, observations: [], tools: [], systemPrompt: "test" },
        ),
    );
    const assistants = (requestBody?.messages ?? []).filter((m: Record<string, any>) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    // Dropping the vacuous assistant leaves consecutive user turns, which the
    // roles-must-alternate merge then collapses into one.
    expect(requestBody?.messages).toHaveLength(1);
  });

  it("drops empty assistant messages from OpenAI chat history", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          { messages: history, observations: [], tools: [], systemPrompt: "test" },
        ),
    );
    const assistants = (requestBody?.messages ?? []).filter((m: Record<string, any>) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("drops empty assistant messages from Responses input", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeResponsesStream(res, [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-responses", model: "test-model", baseUrl, apiKey: "test-key" },
          { messages: history, observations: [], tools: [], systemPrompt: "test" },
        ),
    );
    const assistants = (requestBody?.input ?? []).filter((m: Record<string, any>) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("keeps whitespace-only trimmed but non-empty assistant messages intact", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "m1", role: "user", content: "hello", createdAt: new Date().toISOString() },
              { id: "m2", role: "assistant", content: "real answer", createdAt: new Date().toISOString() },
              { id: "m3", role: "user", content: "continue", createdAt: new Date().toISOString() },
            ],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );
    const assistants = (requestBody?.messages ?? []).filter((m: Record<string, any>) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });
});

describe("reasoning dialect detection (openai-chat)", () => {
  it("captures vLLM-style `reasoning` deltas and echoes the tool-round replay under the same key", async () => {
    // Turn 1: backend streams reasoning under `reasoning` (current vLLM) plus a tool call.
    const turn1 = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { reasoning_content: null, reasoning: "vllm thought" } }] },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{}" } }] },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "u1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "sys",
          },
        ),
    );
    expect(turn1.reasoning).toBe("vllm thought");
    expect((turn1.providerState?.data as Record<string, any>)?.reasoningKey).toBe("reasoning");

    // Turn 2 (same turn's tool round): the replayed assistant message must echo
    // the reasoning under the DETECTED key, not hardcoded reasoning_content.
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "done" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "u1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [{ callId: "call_1", name: "read_file" as any, output: "data" }],
            tools: [],
            systemPrompt: "sys",
            providerState: turn1.providerState,
          },
        ),
    );
    const replayed = (requestBody?.messages ?? []).find((m: Record<string, any>) => m.role === "assistant" && m.tool_calls);
    expect(replayed?.reasoning).toBe("vllm thought");
    expect(replayed?.reasoning_content).toBeUndefined();
  });

  it("keeps the reasoning_content default when no dialect was detected", async () => {
    const turn1 = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { reasoning_content: "classic thought" } }] },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{}" } }] },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "u1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "sys",
          },
        ),
    );
    expect(turn1.reasoning).toBe("classic thought");
    expect((turn1.providerState?.data as Record<string, any>)?.reasoningKey).toBe("reasoning_content");

    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "done" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "high" },
          {
            messages: [{ id: "u1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [{ callId: "call_1", name: "read_file" as any, output: "data" }],
            tools: [],
            systemPrompt: "sys",
            providerState: turn1.providerState,
          },
        ),
    );
    const replayed = (requestBody?.messages ?? []).find((m: Record<string, any>) => m.role === "assistant" && m.tool_calls);
    expect(replayed?.reasoning_content).toBe("classic thought");
    expect(replayed?.reasoning).toBeUndefined();
  });
});

describe("connect-time retry ownership (SDK maxRetries = 0)", () => {
  it("retries a connect-time 500 in driveStreamingTurn and succeeds", async () => {
    let requests = 0;
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        requests += 1;
        if (requests === 1) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "internal server error", type: "server_error" } }));
          return;
        }
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "recovered" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );
    expect(turn.content).toBe("recovered");
    // Exactly two requests: the failed connect + ONE driver retry — proof the
    // SDK's own (non-abortable) retry layer stayed off.
    expect(requests).toBe(2);
  });

  it("does not retry a connect-time 400", async () => {
    let requests = 0;
    await expect(
      withOpenAIChatServer(
        async (_body, res) => {
          requests += 1;
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }));
        },
        (baseUrl) =>
          nextModelTurn(
            { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
            {
              messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
              observations: [],
              tools: [],
              systemPrompt: "test",
            },
          ),
      ),
    ).rejects.toThrow();
    expect(requests).toBe(1);
  });
});

describe("promptCache:'none' (one-shot side requests)", () => {
  it("suppresses every Anthropic cache_control breakpoint", async () => {
    let requestBody: Record<string, any> | undefined;
    await withAnthropicServer(
      async (body, res) => {
        requestBody = body;
        writeAnthropicStream(res, "ok");
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [
              {
                name: "read_file",
                description: "Read file",
                permission: "read",
                requiresApproval: false,
                inputSchema: z.object({ path: z.string() }),
              },
            ],
            systemPrompt: "system prompt",
            promptCache: "none",
          },
        ),
    );
    // Cache env forced ON by the harness — promptCache:"none" must still win.
    expect(JSON.stringify(requestBody)).not.toContain("cache_control");
  });
});

describe("offEffort (explicit thinking-off encoding)", () => {
  it("sends reasoning_effort:'none' when effort is off and offEffort is configured", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "off", offEffort: "none" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );
    expect(requestBody?.reasoning_effort).toBe("none");
  });

  it("still omits reasoning_effort for off without offEffort", async () => {
    let requestBody: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (body, res) => {
        requestBody = body;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", reasoningEffort: "off" },
          {
            messages: [{ id: "msg", role: "user", content: "hi", createdAt: new Date().toISOString() }],
            observations: [],
            tools: [],
            systemPrompt: "test",
          },
        ),
    );
    expect(requestBody?.reasoning_effort).toBeUndefined();
  });
});


describe("OpenAI cached-token dialects", () => {
  const fireTurn = (baseUrl: string) =>
    nextModelTurn(
      { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key" },
      {
        messages: [{ id: "msg", role: "user", content: "hello", createdAt: new Date().toISOString() }],
        observations: [],
        tools: [],
        systemPrompt: "test",
      },
    );

  it("reads Moonshot-style top-level cached_tokens", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cached_tokens: 8 } },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      fireTurn,
    );
    expect(turn.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 8 });
  });

  it("reads DeepSeek-style top-level prompt_cache_hit_tokens", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 6 } },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      fireTurn,
    );
    expect(turn.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 6 });
  });

  it("prefers prompt_tokens_details.cached_tokens over the top-level dialects", async () => {
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 4 },
              cached_tokens: 9,
            },
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      fireTurn,
    );
    expect(turn.usage?.cachedInputTokens).toBe(4);
  });

  it("falls back to choices[i].usage when the chunk has no top-level usage", async () => {
    // Moonshot hangs stream usage on the CHOICE, not the chunk (pi has the
    // same fallback in openai-completions).
    const turn = await withOpenAIChatServer(
      async (_body, res) => {
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          {
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
                usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, cached_tokens: 11 },
              },
            ],
          },
        ]);
      },
      fireTurn,
    );
    expect(turn.usage).toMatchObject({ inputTokens: 30, outputTokens: 7, cachedInputTokens: 11 });
  });
});

describe("Anthropic consecutive user turns", () => {
  const okStream = async (body: Record<string, any>, res: http.ServerResponse, box: { body?: Record<string, any> }) => {
    box.body = body;
    writeAnthropicStream(res, "ok");
  };

  it("merges orphan observation text into the tool_result user envelope (pairing branch)", async () => {
    const box: { body?: Record<string, any> } = {};
    await withAnthropicServer(
      (body, res) => okStream(body, res, box),
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "m1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [
              { callId: "toolu_1", name: "run_shell", output: "ok" },
              { callId: "call_orphan", name: "task_output", output: "background output" },
            ],
            tools: [],
            systemPrompt: "system prompt",
            providerState: {
              provider: "anthropic-messages",
              data: {
                assistantContent: [{ type: "tool_use", id: "toolu_1", name: "run_shell", input: { command: "calc" } }],
              },
            },
          },
        ),
    );

    const messages = (box.body?.messages ?? []) as Array<Record<string, any>>;
    // No consecutive user turns anywhere in the outgoing list.
    for (let i = 1; i < messages.length; i++) {
      expect(!(messages[i - 1]?.role === "user" && messages[i]?.role === "user")).toBe(true);
    }
    const envelope = messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");
    expect(envelope).toBeDefined();
    // tool_result block first, orphan observation text folded in after it.
    expect(envelope!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    const textBlock = envelope!.content.find((b: Record<string, any>) => b.type === "text");
    expect(textBlock?.text).toContain("Tool task_output (call_orphan) result");
  });

  it("merges multiple observations into ONE user envelope (non-pairing branch)", async () => {
    const box: { body?: Record<string, any> } = {};
    await withAnthropicServer(
      (body, res) => okStream(body, res, box),
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [{ id: "m1", role: "user", content: "go", createdAt: new Date().toISOString() }],
            observations: [
              { callId: "c1", name: "read_file", output: "one" },
              { callId: "c2", name: "run_shell", output: "two" },
            ],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    const messages = (box.body?.messages ?? []) as Array<Record<string, any>>;
    // The observation envelope also merges with the trailing history user
    // turn (roles-must-alternate), leaving ONE user message carrying both
    // observations.
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    const serialized = JSON.stringify(messages[0]?.content);
    expect(serialized).toContain("Tool read_file (c1) result:\\none");
    expect(serialized).toContain("Tool run_shell (c2) result:\\ntwo");
  });

  it("merges consecutive user history messages before the cache breakpoint", async () => {
    // Compaction's [user prompt, user summary] shape would 400 strict relays
    // ("roles must alternate"); the merge must run before the breakpoint so
    // cache_control still lands on the true last block.
    const box: { body?: Record<string, any> } = {};
    await withAnthropicServer(
      (body, res) => okStream(body, res, box),
      (baseUrl) =>
        nextModelTurn(
          { provider: "anthropic-messages", model: "test-model", baseUrl, apiKey: "test-key" },
          {
            messages: [
              { id: "u1", role: "user", content: "q1", createdAt: new Date().toISOString() },
              { id: "a1", role: "assistant", content: "a1", createdAt: new Date().toISOString() },
              { id: "u2", role: "user", content: "kept prompt", createdAt: new Date().toISOString() },
              { id: "u3", role: "user", content: "compaction summary", createdAt: new Date().toISOString() },
            ],
            observations: [],
            tools: [],
            systemPrompt: "system prompt",
          },
        ),
    );

    const messages = (box.body?.messages ?? []) as Array<Record<string, any>>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const merged = messages[2]!;
    expect(JSON.stringify(merged.content)).toContain("kept prompt");
    expect(JSON.stringify(merged.content)).toContain("compaction summary");
    // Breakpoint survived the merge: still on the LAST block of the LAST message.
    const lastBlock = merged.content[merged.content.length - 1];
    expect(lastBlock.cache_control).toBeDefined();
  });
});

describe("OpenAI auto reasoning_effort on reasoning_content replay", () => {
  const replayBody = async (config: Record<string, any>, reasoningContent?: string): Promise<Record<string, any> | undefined> => {
    let body: Record<string, any> | undefined;
    await withOpenAIChatServer(
      async (b, res) => {
        body = b;
        writeChatStream(res, [
          { choices: [{ index: 0, delta: { content: "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
      (baseUrl) =>
        nextModelTurn(
          { provider: "openai-chat", model: "test-model", baseUrl, apiKey: "test-key", ...config },
          {
            messages: [{ id: "msg", role: "user", content: "continue", createdAt: new Date().toISOString() }],
            observations: [{ callId: "run_shell:1", name: "run_shell", output: "ok" }],
            tools: [],
            systemPrompt: "test",
            providerState: {
              provider: "openai-chat",
              data: {
                assistantMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "run_shell:1", type: "function", function: { name: "run_shell", arguments: "{}" } }],
                },
                ...(reasoningContent ? { reasoningContent } : {}),
              },
            },
          },
        ),
    );
    return body;
  };

  it("pins reasoning_effort:'medium' when replaying reasoning_content without a configured effort", async () => {
    // One API / New API gateways 400 on reasoning_content without
    // reasoning_effort (kimi-code#1616) — the replay must auto-pin one.
    const body = await replayBody({}, "thinking about it");
    expect(body?.reasoning_effort).toBe("medium");
    const replayed = (body?.messages as Array<Record<string, any>>).find((m) => m.role === "assistant" && m.tool_calls);
    expect(replayed?.reasoning_content).toBe("thinking about it");
  });

  it("does not overwrite an explicitly configured effort", async () => {
    const body = await replayBody({ reasoningEffort: "low" }, "thinking about it");
    expect(body?.reasoning_effort).toBe("low");
  });

  it("does not auto-pin when effort is explicitly off", async () => {
    const body = await replayBody({ reasoningEffort: "off" }, "thinking about it");
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort when the replay carries no reasoning content", async () => {
    const body = await replayBody({});
    expect(body?.reasoning_effort).toBeUndefined();
  });
});
