import http from "node:http";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelConfig, ModelRequest, ModelStreamEvent } from "@reina/protocol";
import { isAuthError, nextModelTurnStream } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

const request: ModelRequest = {
  messages: [{ id: "fixture", role: "user", content: "test", createdAt: "2026-08-31T00:00:00Z" }],
  observations: [],
  systemPrompt: "Local protocol fixture; do not execute tools.",
  tools: (["read_file", "run_shell"] as const).map((name) => ({
    name,
    description: name,
    permission: "read",
    requiresApproval: false,
    inputSchema: z.object({}).passthrough(),
  })),
};

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function chatDelta(toolCalls: unknown[], finishReason?: string): string {
  return sse({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finishReason ?? null }] });
}

function tool(id: string, name: string, args: string, index?: number): unknown {
  return { ...(index === undefined ? {} : { index }), id, type: "function", function: { name, arguments: args } };
}

const completed = {
  type: "response.completed",
  response: {
    id: "resp_fixture",
    status: "completed",
    output: [],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  },
};

async function withStream(
  frames: string | ((attempt: number) => string),
  run: (baseUrl: string, requests: () => number) => Promise<void>,
): Promise<void> {
  let attempts = 0;
  const server = http.createServer(async (incoming, outgoing) => {
    for await (const _chunk of incoming) {
      /* Consume the request without retaining credentials. */
    }
    attempts += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(typeof frames === "function" ? frames(attempts) : frames);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await run(`http://127.0.0.1:${address.port}/v1`, () => attempts);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function config(baseUrl: string, provider: ModelConfig["provider"] = "openai-chat"): ModelConfig {
  return { provider, model: "fixture-model", baseUrl, apiKey: "fixture-not-a-real-key" };
}

describe("chat tool stream identities", () => {
  it("preserves standard indexed parallel fragments", async () => {
    const frames =
      chatDelta([tool("call_read", "read_file", '{"path":', 0), tool("call_shell", "run_shell", '{"command":', 1)]) +
      chatDelta(
        [
          { index: 1, function: { arguments: '"echo fixture"}' } },
          { index: 0, function: { arguments: '"fixture.txt"}' } },
        ],
        "tool_calls",
      ) +
      "data: [DONE]\n\n";
    await withStream(frames, async (baseUrl, requests) => {
      const turn = await nextModelTurnStream(config(baseUrl), request);
      expect(turn.toolCalls).toMatchObject([
        { id: "call_read", name: "read_file", input: { path: "fixture.txt" } },
        { id: "call_shell", name: "run_shell", input: { command: "echo fixture" } },
      ]);
      expect(requests()).toBe(1);
    });
  });

  it("keeps parallel tools separate when a gateway omits index", async () => {
    await withStream(
      chatDelta(
        [
          tool("call_read", "read_file", '{"path":"fixture.txt"}'),
          tool("call_shell", "run_shell", '{"command":"echo fixture"}'),
        ],
        "tool_calls",
      ),
      async (baseUrl) => {
        const turn = await nextModelTurnStream(config(baseUrl), request);
        expect(turn.toolCalls).toMatchObject([
          { id: "call_read", name: "read_file", input: { path: "fixture.txt" } },
          { id: "call_shell", name: "run_shell", input: { command: "echo fixture" } },
        ]);
      },
    );
  });

  it("associates reordered indexless fragments using their stable IDs", async () => {
    const frames =
      chatDelta([tool("call_read", "read_file", '{"path":'), tool("call_shell", "run_shell", '{"command":')]) +
      chatDelta(
        [
          { id: "call_shell", function: { arguments: '"echo fixture"}' } },
          { id: "call_read", function: { arguments: '"fixture.txt"}' } },
        ],
        "tool_calls",
      );
    await withStream(frames, async (baseUrl) => {
      const turn = await nextModelTurnStream(config(baseUrl), request);
      expect(turn.toolCalls.map((call) => call.input)).toEqual([{ path: "fixture.txt" }, { command: "echo fixture" }]);
    });
  });

  it("accepts an anonymous continuation only for a single known tool", async () => {
    const frames =
      chatDelta([tool("call_read", "read_file", '{"path":')]) +
      chatDelta([{ function: { arguments: '"fixture.txt"}' } }], "tool_calls");
    await withStream(frames, async (baseUrl) => {
      const turn = await nextModelTurnStream(config(baseUrl), request);
      expect(turn.toolCalls).toMatchObject([{ id: "call_read", input: { path: "fixture.txt" } }]);
    });
  });

  it("keeps an indexless tool's stable identity when its explicit index arrives later", async () => {
    const frames =
      chatDelta([tool("call_read", "read_file", '{"path":')]) +
      chatDelta([{ index: 4, id: "call_read", function: { arguments: '"fixture.txt"}' } }], "tool_calls");
    await withStream(frames, async (baseUrl) => {
      const turn = await nextModelTurnStream(config(baseUrl), request);
      expect(turn.toolCalls).toMatchObject([{ id: "call_read", name: "read_file", input: { path: "fixture.txt" } }]);
      expect(turn.toolCalls).toHaveLength(1);
    });
  });

  it.each([
    [
      "ambiguous anonymous parallel continuation",
      chatDelta([tool("call_read", "read_file", '{"path":'), tool("call_shell", "run_shell", '{"command":')]) +
        chatDelta([{ function: { arguments: '"fixture.txt"}' } }], "tool_calls"),
    ],
    [
      "conflicting ID for an existing index",
      chatDelta([tool("call_read", "read_file", "{}", 0)]) +
        chatDelta([tool("call_shell", "run_shell", "{}", 0)], "tool_calls"),
    ],
    ["missing final tool identity", chatDelta([{ index: 0, function: { arguments: "{}" } }], "tool_calls")],
  ])("rejects %s without emitting a completed tool or retrying", async (_label, frames) => {
    await withStream(frames, async (baseUrl, requests) => {
      await expect(nextModelTurnStream(config(baseUrl), request)).rejects.toMatchObject({
        code: "ambiguous_tool_call",
        type: "invalid_response_error",
        status: 400,
      });
      expect(requests()).toBe(1);
    });
  });

  it("keeps late usage and ignores errors arriving after finish_reason", async () => {
    const frames =
      sse({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }) +
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
      sse({ error: { code: "internal_error", message: "late failure" } });
    await withStream(frames, async (baseUrl, requests) => {
      const turn = await nextModelTurnStream(config(baseUrl), request);
      expect(turn.content).toBe("done");
      expect(turn.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
      expect(requests()).toBe(1);
    });
  });
});

describe("Responses stream terminal errors", () => {
  it.each([
    [
      "quota failure",
      sse({
        type: "response.failed",
        response: {
          status: "failed",
          error: { message: "Budget exhausted", code: "insufficient_quota", type: "rate_limit_error" },
        },
      }),
      429,
      "insufficient_quota",
      "rate_limit_error",
      "Budget exhausted",
    ],
    [
      "named top-level error",
      sse({ type: "error", message: "Token rejected", code: "invalid_api_key", status: 401 }, "error"),
      401,
      "invalid_api_key",
      "error",
      "Token rejected",
    ],
    [
      "data-only error",
      sse({ type: "error", message: "Bad input", code: "invalid_request", status_code: 422 }),
      422,
      "invalid_request",
      "error",
      "Bad input",
    ],
    [
      "unknown explicit error",
      sse({
        type: "response.failed",
        response: { error: { message: "Turn rejected", code: "unsupported_feature", type: "provider_error" } },
      }),
      undefined,
      "unsupported_feature",
      "provider_error",
      "Turn rejected",
    ],
  ])(
    "preserves %s without treating it as a retryable disconnect",
    async (_label, frame, status, code, type, message) => {
      await withStream(frame, async (baseUrl, requests) => {
        let caught: unknown;
        try {
          await nextModelTurnStream(config(baseUrl, "openai-responses"), request);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OpenAI.APIError);
        expect(caught).toMatchObject({ status, code, type, error: { message } });
        expect((caught as Error).message).toContain(message);
        expect((caught as Error).message).not.toContain("stream closed before");
        expect(isAuthError(caught)).toBe(status === 401);
        expect(requests()).toBe(1);
      });
    },
  );

  it("stops at completion so late errors cannot reverse success", async () => {
    const frames =
      sse({ type: "response.output_text.delta", delta: "done" }) +
      sse(completed) +
      sse({ type: "response.failed", response: { error: { code: "internal_error", message: "too late" } } });
    await withStream(frames, async (baseUrl, requests) => {
      const turn = await nextModelTurnStream(config(baseUrl, "openai-responses"), request);
      expect(turn.content).toBe("done");
      expect(requests()).toBe(1);
    });
  });

  it("does not retry request errors just because their message mentions a timeout", async () => {
    const frame = sse({
      type: "response.failed",
      response: { error: { code: "invalid_request_error", message: "Invalid timeout parameter", status: 400 } },
    });
    await withStream(frame, async (baseUrl, requests) => {
      await expect(nextModelTurnStream(config(baseUrl, "openai-responses"), request)).rejects.toMatchObject({
        status: 400,
        code: "invalid_request_error",
      });
      expect(requests()).toBe(1);
    });
  });

  it("honors a quota error type even when a gateway supplies a different code", async () => {
    const frame = sse({
      type: "response.failed",
      response: { error: { code: "gateway_error", type: "usage_limit_reached", message: "Turn rejected" } },
    });
    await withStream(frame, async (baseUrl, requests) => {
      await expect(nextModelTurnStream(config(baseUrl, "openai-responses"), request)).rejects.toMatchObject({
        status: 429,
        code: "gateway_error",
        type: "usage_limit_reached",
      });
      expect(requests()).toBe(1);
    });
  });

  it("retries a classified transient failure and clears the partial attempt", async () => {
    vi.stubEnv("REINA_STREAM_MAX_RETRIES", "1");
    const events: ModelStreamEvent[] = [];
    await withStream(
      (attempt) =>
        attempt === 1
          ? sse({ type: "response.output_text.delta", delta: "discarded" }) +
            sse({
              type: "response.failed",
              response: { error: { code: "server_error", type: "server_error", message: "Temporarily busy" } },
            })
          : sse({ type: "response.output_text.delta", delta: "done" }) + sse(completed),
      async (baseUrl, requests) => {
        const turn = await nextModelTurnStream(config(baseUrl, "openai-responses"), request, (event) =>
          events.push(event),
        );
        expect(turn.content).toBe("done");
        expect(events.filter((event) => event.type === "stream-reset")).toHaveLength(1);
        expect(requests()).toBe(2);
      },
    );
  });

  it("continues to recover real premature EOFs", async () => {
    vi.stubEnv("REINA_STREAM_MAX_RETRIES", "1");
    await withStream(
      (attempt) =>
        sse({ type: "response.output_text.delta", delta: attempt === 1 ? "partial" : "done" }) +
        (attempt === 1 ? "" : sse(completed)),
      async (baseUrl, requests) => {
        const turn = await nextModelTurnStream(config(baseUrl, "openai-responses"), request);
        expect(turn.content).toBe("done");
        expect(requests()).toBe(2);
      },
    );
  });
});
