import http from "node:http";
import type { ModelConfig, ModelProvider, ModelRequest } from "@reina/protocol";
import { nextModelTurn } from "@reina/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteModels, probeModel, probeRemoteConnection } from "./remote-models.js";

type CapturedRequest = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
const turnRequest: ModelRequest = {
  messages: [{ id: "m", role: "user", content: "hello", createdAt: "2026-08-31T00:00:00Z" }],
  systemPrompt: "test",
  tools: [],
  observations: [],
};

function reply(res: http.ServerResponse, provider: ModelProvider, stream: boolean): void {
  if (!stream) {
    res.setHeader("Content-Type", "application/json");
    const payload =
      provider === "anthropic-messages"
        ? {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }
        : provider === "openai-responses"
          ? {
              id: "resp",
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            }
          : {
              id: "test",
              model: "test-model",
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            };
    res.end(JSON.stringify(payload));
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  if (provider === "anthropic-messages") {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } else if (provider === "openai-responses") {
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
    );
  } else {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

async function withServer(
  handler: (request: CapturedRequest, res: http.ServerResponse) => void,
  run: (origin: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const request = {
      path: req.url ?? "",
      headers: req.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    requests.push(request);
    handler(request, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

beforeEach(() => {
  vi.stubEnv("REINA_PROVIDER_MAX_RETRIES", "0");
  vi.stubEnv("REINA_STREAM_MAX_RETRIES", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("model probe and SDK runtime use the same connection", () => {
  it.each([
    ["openai-chat", "/root", "/root/v1/chat/completions"],
    ["openai-chat", "/full/v1/chat/completions", "/full/v1/chat/completions"],
    ["openai-chat", "/plain/chat/completions", "/plain/chat/completions"],
    ["openai-chat", "/versionless", "/versionless/chat/completions"],
    ["openai-responses", "/root", "/root/v1/responses"],
    ["openai-responses", "/full/v1/responses", "/full/v1/responses"],
    ["anthropic-messages", "/anth/v1", "/anth/v1/messages"],
    ["anthropic-messages", "/full/v1/messages", "/full/v1/messages"],
    ["anthropic-messages", "/plain/messages", "/plain/messages"],
    ["anthropic-messages", "/versionless", "/versionless/messages"],
  ] as const)("%s: %s reaches %s in both paths", async (provider, base, target) => {
    await withServer(
      (req, res) => {
        if (req.path !== target) {
          res.statusCode = 404;
          res.end("wrong path");
          return;
        }
        reply(res, provider, req.body.stream === true);
      },
      async (origin, requests) => {
        const config: ModelConfig = {
          provider,
          model: "test-model",
          apiKey: "dummy",
          baseUrl: `${origin}${base}`,
          maxOutputTokens: 32,
        };
        expect((await probeModel(config)).ok).toBe(true);
        expect((await nextModelTurn(config, turnRequest)).content).toBe("ok");
        const accepted = requests.filter((request) => request.path === target);
        expect(accepted).toHaveLength(2);
        const authHeader = provider === "anthropic-messages" ? "x-api-key" : "authorization";
        expect(accepted[0]?.headers[authHeader]).toBe(accepted[1]?.headers[authHeader]);
      },
    );
  });

  it("carries Bearer mode, custom headers and explicit thinking off through discovery, probe and runtime", async () => {
    await withServer(
      (req, res) => {
        if (req.path === "/anth/v1/models?limit=1000") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
        } else if (req.path === "/anth/v1/messages") reply(res, "anthropic-messages", req.body.stream === true);
        else {
          res.statusCode = 404;
          res.end();
        }
      },
      async (origin, requests) => {
        const config: ModelConfig = {
          provider: "anthropic-messages",
          model: "test-model",
          apiKey: "dummy",
          baseUrl: `${origin}/anth/v1`,
          authMode: "bearer",
          headers: { "X-Gateway": "tenant" },
          reasoningEffort: "off",
          maxOutputTokens: 32,
        };
        expect((await fetchRemoteModels(config)).models).toEqual([{ id: "test-model", created: undefined }]);
        expect((await probeModel(config)).ok).toBe(true);
        expect((await nextModelTurn(config, turnRequest)).content).toBe("ok");
        expect(requests).toHaveLength(3);
        for (const request of requests) {
          expect(request.headers.authorization).toBe("Bearer dummy");
          expect(request.headers["x-api-key"]).toBeUndefined();
          expect(request.headers["x-gateway"]).toBe("tenant");
        }
        expect(requests.slice(1).map((request) => request.body.thinking)).toEqual([
          { type: "disabled" },
          { type: "disabled" },
        ]);
      },
    );
  });

  it("uses the token parameter fallback in both paths without dropping reasoning", async () => {
    await withServer(
      (req, res) => {
        if (Object.hasOwn(req.body, "max_tokens")) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: { message: "Unsupported parameter: max_tokens. Use max_completion_tokens instead." },
            }),
          );
        } else reply(res, "openai-chat", req.body.stream === true);
      },
      async (origin, requests) => {
        const config: ModelConfig = {
          provider: "openai-chat",
          model: "test-model",
          baseUrl: `${origin}/v1`,
          apiKey: "dummy",
          maxOutputTokens: 32,
          reasoningDialect: "deepseek",
          reasoningEffort: "high",
        };
        expect((await probeModel(config)).ok).toBe(true);
        expect((await nextModelTurn(config, turnRequest)).content).toBe("ok");
        expect(requests).toHaveLength(4);
        expect(requests[1]?.body.max_completion_tokens).toBe(1);
        expect(requests[3]?.body.max_completion_tokens).toBe(32);
        for (const request of requests) {
          expect(request.body.thinking).toEqual({ type: "enabled" });
          expect(request.body.reasoning_effort).toBe("high");
        }
      },
    );
  });

  it("rejects unsupported complete effort levels before either path sends a request", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 500;
        res.end();
      },
      async (origin, requests) => {
        const config: ModelConfig = {
          provider: "openai-chat",
          model: "test-model",
          apiKey: "dummy",
          baseUrl: `${origin}/v1`,
          reasoningLevels: ["low", "high"],
          reasoningEffort: "medium",
        };
        await expect(probeModel(config)).rejects.toThrow(/not supported/);
        await expect(nextModelTurn(config, turnRequest)).rejects.toThrow(/not supported/);
        expect(requests).toHaveLength(0);
      },
    );
  });
});

describe("model probe validates successful HTTP response bodies", () => {
  it("requests streaming for Qwen thinking without turning thinking off", async () => {
    await withServer(
      (request, res) => {
        expect(request.body.stream).toBe(true);
        expect(request.body.enable_thinking).toBe(true);
        reply(res, "openai-chat", true);
      },
      async (origin) => {
        expect(
          (
            await probeModel({
              provider: "openai-chat",
              model: "qwen-fixture",
              apiKey: "dummy",
              baseUrl: `${origin}/v1`,
              reasoningDialect: "qwen",
              reasoningEffort: "high",
            })
          ).ok,
        ).toBe(true);
      },
    );
  });

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "accepts a genuine %s JSON reply",
    async (provider) => {
      await withServer(
        (_request, res) => reply(res, provider, false),
        async (origin) => {
          expect(
            (await probeModel({ provider, model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` })).ok,
          ).toBe(true);
        },
      );
    },
  );

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "rejects %s HTTP 200 errors",
    async (provider) => {
      await withServer(
        (_request, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: { type: "rate_limit_error", code: "insufficient_quota", message: "Fixture quota exhausted" },
            }),
          );
        },
        async (origin) => {
          await expect(
            probeModel({ provider, model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` }),
          ).rejects.toThrow("Fixture quota exhausted");
        },
      );
    },
  );

  it("rejects a Responses HTTP 200 failed response", async () => {
    await withServer(
      (_request, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "resp",
            status: "failed",
            error: { code: "insufficient_quota", message: "Fixture response failed" },
            output: [],
          }),
        );
      },
      async (origin) => {
        await expect(
          probeModel({ provider: "openai-responses", model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` }),
        ).rejects.toThrow("Fixture response failed");
      },
    );
  });

  it.each([false, true])("accepts normal Responses token truncation (stream=%s)", async (stream) => {
    await withServer(
      (_request, res) => {
        const response = {
          id: "resp",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        };
        res.setHeader("Content-Type", stream ? "text/event-stream" : "application/json");
        res.end(
          stream ? `data: ${JSON.stringify({ type: "response.incomplete", response })}\n\n` : JSON.stringify(response),
        );
      },
      async (origin) => {
        expect(
          (
            await probeModel({
              provider: "openai-responses",
              model: "test-model",
              apiKey: "dummy",
              baseUrl: `${origin}/v1`,
            })
          ).ok,
        ).toBe(true);
      },
    );
  });

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "accepts a gateway forcing %s SSE",
    async (provider) => {
      await withServer(
        (_request, res) => reply(res, provider, true),
        async (origin) => {
          expect(
            (await probeModel({ provider, model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` })).ok,
          ).toBe(true);
        },
      );
    },
  );

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "rejects %s SSE error events",
    async (provider) => {
      await withServer(
        (_request, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          const event =
            provider === "openai-responses"
              ? { type: "response.failed", response: { status: "failed", error: { message: "Fixture SSE failure" } } }
              : { type: "error", error: { message: "Fixture SSE failure" } };
          res.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        async (origin) => {
          await expect(
            probeModel({ provider, model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` }),
          ).rejects.toThrow("Fixture SSE failure");
        },
      );
    },
  );

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "rejects %s SSE EOF without a terminal event",
    async (provider) => {
      await withServer(
        (_request, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          const event =
            provider === "openai-chat"
              ? { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }
              : provider === "anthropic-messages"
                ? { type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [] } }
                : { type: "response.output_text.delta", delta: "partial" };
          res.end(`data: ${JSON.stringify(event)}\n\n`);
        },
        async (origin) => {
          await expect(
            probeModel({ provider, model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` }),
          ).rejects.toThrow("closed before a terminal event");
        },
      );
    },
  );

  it("closes an open SSE connection as soon as a terminal response is validated", async () => {
    let closed = false;
    await withServer(
      (_request, res) => {
        res.on("close", () => {
          closed = true;
        });
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp", status: "completed", output: [] } })}\n\n`,
        );
        // Deliberately keep the socket open: the probe owns cancellation after terminal success.
      },
      async (origin) => {
        expect(
          (
            await probeModel({
              provider: "openai-responses",
              model: "test-model",
              apiKey: "dummy",
              baseUrl: `${origin}/v1`,
            })
          ).ok,
        ).toBe(true);
        await vi.waitFor(() => expect(closed).toBe(true));
      },
    );
  });

  it("rejects unrelated HTTP 200 JSON instead of treating a health response as a model answer", async () => {
    await withServer(
      (_request, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      },
      async (origin) => {
        await expect(
          probeModel({ provider: "openai-chat", model: "test-model", apiKey: "dummy", baseUrl: `${origin}/v1` }),
        ).rejects.toThrow("did not return a completed response");
      },
    );
  });
});

describe("model discovery shares a bounded cancellation budget", () => {
  const params = { provider: "anthropic-messages", baseUrl: "https://fixture.test/custom", apiKey: "dummy" };

  function timeoutSignal() {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    return { controller, timeout };
  }

  function abortWhileReading(controller: AbortController): Response {
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"data":['));
          controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
          queueMicrotask(() => controller.abort(new DOMException("Fixture discovery deadline", "TimeoutError")));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  it("uses the same 30-second signal across a version fallback and all Anthropic pages", async () => {
    const { controller, timeout } = timeoutSignal();
    const captured: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.push(init?.signal);
      if (captured.length === 1) return new Response("missing versioned route", { status: 404 });
      return Response.json(
        captured.length === 2
          ? { data: [{ id: "first" }], has_more: true, last_id: "first" }
          : { data: [{ id: "second" }], has_more: false },
      );
    });
    expect((await fetchRemoteModels(params)).models.map((model) => model.id)).toEqual(["first", "second"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(captured).toEqual([controller.signal, controller.signal, controller.signal]);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it.each(["discovery", "connection probe"])("does not continue URL fallback after a %s timeout", async (operation) => {
    const { controller, timeout } = timeoutSignal();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new DOMException("Fixture discovery deadline", "TimeoutError"));
      throw controller.signal.reason;
    });
    const input = { ...params, provider: "openai-chat" };
    const result = operation === "discovery" ? fetchRemoteModels(input) : probeRemoteConnection(input);
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("also limits reading the first successful response body", async () => {
    const { controller } = timeoutSignal();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return abortWhileReading(controller);
    });
    await expect(fetchRemoteModels(params)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps completed pages when the shared signal aborts a later page body", async () => {
    const { controller, timeout } = timeoutSignal();
    let attempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      attempts += 1;
      return attempts === 1
        ? Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" })
        : abortWhileReading(controller);
    });
    expect((await fetchRemoteModels(params)).models).toEqual([{ id: "first", created: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
});
