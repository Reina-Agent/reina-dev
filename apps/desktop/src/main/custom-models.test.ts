import { describe, expect, it } from "vitest";
import { modelConfigSchema, sanitizeModelHeaders } from "@reina/protocol";
import { parseCustomModels, sanitizeModel } from "./custom-models.js";

// parseCustomModels is both the read path AND the write sanitizer
// (writeCustomModels re-parses the payload before persisting), so a field
// missing here is silently ERASED from the user's models.json on the next
// settings save. contextWindowTokens shipped with that gap, supportedEfforts
// and maxOutputTokens regressed into it — this round-trip pins every
// ModelConfig capability field so the next one can't.
describe("models.json capability-field round-trip", () => {
  const entry = {
    id: "proxy-codex",
    label: "Codex Max",
    provider: "openai-codex-responses",
    model: "gpt-5.1-codex-max",
    apiKey: "k",
    baseUrl: "https://proxy.example/v1",
    description: "proxy account",
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
    thinkingMode: "adaptive",
    supportedEfforts: ["xhigh", "max"],
    reasoningLevels: ["off", "low", "high", "max"],
    reasoningDialect: "openai",
    offEffort: "none",
    authMode: "bearer",
    headers: { "X-Proxy-Route": "test-route" },
  };

  it("every capability field survives read → serialize → write-sanitize", () => {
    const read = parseCustomModels(JSON.stringify([entry]));
    expect(read).toHaveLength(1);
    const wrote = parseCustomModels(JSON.stringify(read));
    expect(wrote[0]).toEqual(read[0]);
    for (const field of ["contextWindowTokens", "maxOutputTokens", "thinkingMode", "supportedEfforts", "reasoningLevels", "reasoningDialect", "offEffort", "authMode", "headers"] as const) {
      expect(wrote[0][field]).toEqual(entry[field]);
    }
  });

  it("catalog capability fields parse into valid ModelConfig values (schema cross-check)", () => {
    const read = parseCustomModels(
      JSON.stringify([
        {
          id: "m",
          provider: "anthropic-messages",
          model: "claude-proxy",
          supportedEfforts: ["extra-high", "bogus", "max"],
          thinkingMode: "budget",
          maxOutputTokens: 9000.7,
        },
      ]),
    );
    expect(read).toHaveLength(1);
    const { id: _id, label: _label, description: _description, ...modelFields } = read[0];
    const parsed = modelConfigSchema.parse(modelFields);
    // Legacy alias migrated, unknown tier dropped, fractional tokens floored.
    expect(parsed.supportedEfforts).toEqual(["xhigh", "max"]);
    expect(parsed.thinkingMode).toBe("budget");
    expect(parsed.maxOutputTokens).toBe(9000);
  });

  it("drops invalid capability values without dropping the entry", () => {
    const read = parseCustomModels(
      JSON.stringify([
        { id: "m", provider: "openai-chat", model: "x", thinkingMode: "always", supportedEfforts: "xhigh", maxOutputTokens: -5 },
      ]),
    );
    expect(read).toHaveLength(1);
    expect(read[0].thinkingMode).toBeUndefined();
    expect(read[0].supportedEfforts).toBeUndefined();
    expect(read[0].maxOutputTokens).toBeUndefined();
  });

  it.each([[], ["unknown"], "high"])("rejects an invalid complete reasoning set %j without widening it", (reasoningLevels) => {
    expect(() => parseCustomModels(JSON.stringify([{ ...entry, reasoningLevels }]))).toThrow();
  });

  it("rejects invalid auth configuration instead of dropping it on save", () => {
    expect(() => parseCustomModels(JSON.stringify([{ ...entry, authMode: "basic" }]))).toThrow();
    expect(() => parseCustomModels(JSON.stringify([{ ...entry, headers: { Authorization: "Bearer test\r\nX-Other: value" } }]))).toThrow();
  });
});

describe("custom model headers", () => {
  it("preserves valid header values and permits absent headers", () => {
    expect(sanitizeModelHeaders(undefined)).toBeUndefined();
    expect(sanitizeModelHeaders({ Authorization: "Bearer fixture", "X-Route": "tenant-a" })).toEqual({ Authorization: "Bearer fixture", "X-Route": "tenant-a" });
  });

  it.each([{ "X Bad": "x" }, { "X-Test": "a\nb" }, { Authorization: "a", authorization: "b" }, { "X-Test": 42 }, []])("rejects malformed/ambiguous headers %j", (headers) => {
    expect(() => sanitizeModelHeaders(headers)).toThrow();
    expect(modelConfigSchema.safeParse({ provider: "openai-chat", model: "fixture", headers }).success).toBe(false);
  });
});

describe("engine model override sanitization", () => {
  it("round-trips reasoning, authentication and connection overrides", () => {
    const input = {
      provider: "openai-chat", model: "fixture", apiKey: "fixture", baseUrl: "https://proxy.example/v1",
      reasoningEffort: "off", reasoningLevels: ["off", "low", "high"], supportedEfforts: ["xhigh", "max"],
      reasoningDialect: "deepseek", offEffort: "none", authMode: "bearer", headers: { "X-Route": "fixture" },
      contextWindowTokens: 32000, maxOutputTokens: 8000, subscriptionId: "fixture-account", accountId: "fixture-workspace",
    };
    expect(sanitizeModel(input)).toEqual(input);
    expect(sanitizeModel(JSON.parse(JSON.stringify(sanitizeModel(input))))).toEqual(input);
  });

  it("keeps legacy key/effort aliases and positive-token normalization", () => {
    expect(sanitizeModel({ apiKeyEnv: " fixture ", reasoningEffort: "extra-high", maxOutputTokens: 4096.9, contextWindowTokens: -1 })).toEqual({
      apiKey: "fixture", reasoningEffort: "xhigh", maxOutputTokens: 4096,
    });
  });

  it.each([{ reasoningLevels: [] }, { reasoningEffort: "maybe" }, { reasoningDialect: "guess" }, { authMode: "basic" }, { headers: { "X-Test": "a\r\nb" } }])("rejects invalid explicit compatibility overrides %j", (input) => {
    expect(() => sanitizeModel(input)).toThrow();
  });
});
