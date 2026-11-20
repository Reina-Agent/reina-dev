import http from "node:http";
import type { ModelConfig, ModelRequest } from "@reina/protocol";
import { nextModelTurn } from "@reina/providers";
import { describe, expect, it } from "vitest";
import { probeModel } from "./remote-models.js";

const request: ModelRequest = { systemPrompt: "test", messages: [], observations: [], tools: [] };

describe("custom authentication headers reach probes and SDKs", () => {
  it.each([
    ["openai-chat", undefined, { Authorization: "Bearer custom-token" }],
    ["openai-responses", undefined, { Authorization: "Bearer custom-token" }],
    ["anthropic-messages", "bearer", { Authorization: "Bearer custom-token" }],
    ["anthropic-messages", "api-key", { "x-api-key": "custom-key" }],
  ] as const)("%s %s accepts a header-only credential", async (provider, authMode, headers) => {
    const captured: http.IncomingHttpHeaders[] = [];
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Consume the SDK/probe JSON body. */
      }
      captured.push(req.headers);
      // A non-retryable fixture rejection proves both paths actually sent the
      // request, without needing a separate completion implementation here.
      res.writeHead(418, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture rejection" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config: ModelConfig = {
        provider,
        model: "test-model",
        authMode,
        headers,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      };
      await expect(probeModel(config)).rejects.toThrow(/HTTP 418/);
      await expect(nextModelTurn(config, request)).rejects.toMatchObject({ status: 418 });
      expect(captured).toHaveLength(2);
      for (const actual of captured) {
        if ("Authorization" in headers) {
          expect(actual.authorization).toBe(headers.Authorization);
          expect(actual["x-api-key"]).toBeUndefined();
        } else {
          expect(actual["x-api-key"]).toBe(headers["x-api-key"]);
          expect(actual.authorization).toBeUndefined();
        }
        expect(JSON.stringify(actual)).not.toContain("custom-header-auth");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects missing credentials consistently before connecting", async () => {
    const config: ModelConfig = { provider: "openai-chat", model: "test-model", baseUrl: "http://127.0.0.1:1/v1" };
    await expect(probeModel(config)).rejects.toThrow(/API key is missing/);
    await expect(nextModelTurn(config, request)).rejects.toThrow(/API key is missing/);
  });
});
