import { describe, expect, it, vi } from "vitest";
import { createProviderFetch, fetchModelOperation, modelOperationUrls, modelRequestHeaders } from "./connection.js";

describe("shared model endpoint resolution", () => {
  it.each([
    ["openai-chat", "https://gateway.test", ["/v1/chat/completions", "/chat/completions"]],
    ["openai-chat", "https://gateway.test/v1/", ["/v1/chat/completions"]],
    ["openai-chat", "https://gateway.test/custom/chat/completions", ["/custom/chat/completions"]],
    ["openai-chat", "https://gateway.test/custom#", ["/custom/chat/completions"]],
    ["openai-responses", "https://gateway.test/custom/v1/responses", ["/custom/v1/responses"]],
    ["anthropic-messages", "https://gateway.test/v1", ["/v1/messages"]],
    ["anthropic-messages", "https://gateway.test/anthropic/messages", ["/anthropic/messages"]],
    ["anthropic-messages", "https://gateway.test/anthropic", ["/anthropic/v1/messages", "/anthropic/messages"]],
    ["openai-chat", "https://ark.cn-beijing.volces.com", ["/api/v3/chat/completions", "/chat/completions"]],
    ["openai-chat", "https://notvolces.com", ["/v1/chat/completions", "/chat/completions"]],
    ["openai-codex-responses", "https://gateway.test/backend-api/codex", ["/backend-api/codex/responses"]],
  ])("%s accepts %s without duplicate operation/version", (provider, baseUrl, paths) => {
    expect(modelOperationUrls({ provider, baseUrl }).map((value) => new URL(value).pathname)).toEqual(paths);
  });

  it("keeps configured query parameters and uses the same base for discovery", () => {
    const config = { provider: "openai-responses", baseUrl: "https://gateway.test/api/v3/responses?api-version=2026" };
    expect(modelOperationUrls(config)).toEqual(["https://gateway.test/api/v3/responses?api-version=2026"]);
    expect(modelOperationUrls(config, "models")).toEqual(["https://gateway.test/api/v3/models?api-version=2026"]);
  });

  it.each(["file:///tmp/private", "https://user:password@gateway.test"])("rejects unsafe endpoint %s", (baseUrl) => {
    expect(() => modelOperationUrls({ provider: "openai-chat", baseUrl })).toThrow(/HTTP\(S\)/);
  });
});

describe("shared model authentication", () => {
  it("uses plain Bearer for Anthropic-compatible endpoints without x-api-key", () => {
    const headers = modelRequestHeaders(
      { provider: "anthropic-messages", authMode: "bearer", headers: { "X-Gateway": "tenant" } },
      "dummy",
    );
    expect(headers).toMatchObject({
      authorization: "Bearer dummy",
      "anthropic-version": "2023-06-01",
      "x-gateway": "tenant",
    });
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("applies validated custom headers case-insensitively after defaults", () => {
    expect(
      modelRequestHeaders({ provider: "openai-chat", headers: { Authorization: "Bearer override" } }, "dummy"),
    ).toEqual({ authorization: "Bearer override" });
    expect(() => modelRequestHeaders({ provider: "openai-chat", headers: { "X-Test": "a\r\nb" } }, "dummy")).toThrow();
  });
});

describe("bounded model transport compatibility", () => {
  const config = { provider: "openai-chat", baseUrl: "https://gateway.test/v1" };

  it("renames only an explicitly rejected token field and preserves the payload", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1
        ? new Response(
            JSON.stringify({ error: { message: "Unsupported parameter: max_tokens; use max_completion_tokens" } }),
            { status: 400 },
          )
        : new Response("ok");
    };
    const body = {
      model: "model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function" }],
      thinking: { type: "enabled" },
    };
    expect((await fetchModelOperation(config, { method: "POST", body: JSON.stringify(body) }, transport)).status).toBe(
      200,
    );
    expect(bodies).toHaveLength(2);
    const { max_tokens: cap, ...rest } = body;
    expect(bodies[1]).toEqual({ ...rest, max_completion_tokens: cap });
  });

  it("does not reinterpret a token range error as a renamed parameter", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("max_tokens must be at least 16", { status: 400 }));
    expect((await fetchModelOperation(config, { method: "POST", body: '{"max_tokens":1}' }, transport)).status).toBe(
      400,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("tries the versionless path only for 404/405, not authentication failures", async () => {
    const urls: string[] = [];
    const transport: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response("", { status: urls.length === 1 ? 404 : 200 });
    };
    await fetchModelOperation(
      { provider: "openai-chat", baseUrl: "https://gateway.test/custom" },
      { method: "POST", body: "{}" },
      transport,
    );
    expect(urls).toEqual([
      "https://gateway.test/custom/v1/chat/completions",
      "https://gateway.test/custom/chat/completions",
    ]);
    const unauthorized = vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 }));
    await fetchModelOperation(
      { provider: "openai-chat", baseUrl: "https://gateway.test" },
      { method: "POST" },
      unauthorized,
    );
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("retains SDK query parameters, headers and cancellation on the final URL", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const wrapped = createProviderFetch(
      { provider: "anthropic-messages", baseUrl: "https://gateway.test/messages?tenant=one" },
      transport,
    );
    await wrapped("https://gateway.test/v1/messages?beta=true", {
      method: "POST",
      headers: { "X-SDK": "keep" },
      body: "{}",
      signal: controller.signal,
    });
    expect(String(transport.mock.calls[0]?.[0])).toBe("https://gateway.test/messages?tenant=one&beta=true");
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("x-sdk")).toBe("keep");
    controller.abort();
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
