import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@reina/protocol";
import { resolveChatReasoning, resolveOpenAIReasoningEffort, validatedReasoningEffort } from "./reasoning.js";

const model: ModelConfig = { provider: "openai-chat", model: "test-model" };

describe("reasoning capability compatibility", () => {
  it("keeps legacy supportedEfforts top-only semantics", () => {
    expect(resolveOpenAIReasoningEffort({ ...model, supportedEfforts: ["xhigh", "max"], reasoningEffort: "low" })).toBe(
      "low",
    );
    expect(resolveOpenAIReasoningEffort({ ...model, supportedEfforts: ["xhigh"], reasoningEffort: "max" })).toBe(
      "xhigh",
    );
  });

  it("validates every explicitly configured complete level, including off", () => {
    const config = { ...model, reasoningLevels: ["low", "high"] as const };
    for (const reasoningEffort of ["medium", "max", "off"] as const) {
      expect(() =>
        resolveChatReasoning({ ...config, reasoningLevels: [...config.reasoningLevels], reasoningEffort }),
      ).toThrow("not supported");
    }
    expect(resolveOpenAIReasoningEffort({ ...model, reasoningLevels: ["max"], reasoningEffort: "max" })).toBe("max");
  });

  it("does not turn an invalid empty complete set into unrestricted capability", () => {
    expect(() => validatedReasoningEffort({ ...model, reasoningLevels: [] })).toThrow();
  });

  it("distinguishes unspecified effort from explicit off", () => {
    expect(resolveOpenAIReasoningEffort({ ...model, offEffort: "none" })).toBeUndefined();
    expect(resolveOpenAIReasoningEffort({ ...model, offEffort: "none", reasoningEffort: "off" })).toBe("none");
    expect(resolveOpenAIReasoningEffort({ ...model, reasoningLevels: ["off", "high"], reasoningEffort: "off" })).toBe(
      "none",
    );
    expect(resolveChatReasoning({ ...model, reasoningDialect: "deepseek" })).toEqual({
      fields: {},
      reasoningOn: false,
    });
  });

  it("validates the reasoning replay fallback instead of bypassing capabilities", () => {
    expect(() => resolveChatReasoning({ ...model, reasoningLevels: ["low", "high"] }, "medium")).toThrow(
      "not supported",
    );
    expect(resolveChatReasoning({ ...model, reasoningLevels: ["medium"] }, "medium").fields).toEqual({
      reasoning_effort: "medium",
    });
    expect(resolveChatReasoning({ ...model, reasoningEffort: "off" }, "medium").reasoningOn).toBe(false);
  });
});

describe("OpenAI Chat reasoning dialects", () => {
  it.each([
    ["openai", { reasoning_effort: "high" }, { reasoning_effort: "none" }],
    ["deepseek", { thinking: { type: "enabled" }, reasoning_effort: "high" }, { thinking: { type: "disabled" } }],
    ["qwen", { enable_thinking: true }, { enable_thinking: false }],
    ["openrouter", { reasoning: { effort: "high" } }, { reasoning: { effort: "none" } }],
  ] as const)(
    "encodes %s enabled/off without conflicting OpenAI fields",
    (reasoningDialect, enabledFields, disabledFields) => {
      const config = { ...model, reasoningDialect, offEffort: "none" as const };
      expect(resolveChatReasoning({ ...config, reasoningEffort: "high" })).toEqual({
        fields: enabledFields,
        reasoningOn: true,
      });
      expect(resolveChatReasoning({ ...config, reasoningEffort: "off" })).toEqual({
        fields: disabledFields,
        reasoningOn: false,
      });
    },
  );

  it("infers exact official endpoints but never a model name or similar hostname", () => {
    const config = { ...model, model: "deepseek-chat", reasoningEffort: "off" as const };
    expect(resolveChatReasoning({ ...config, baseUrl: "https://api.deepseek.com/v1" }).fields).toEqual({
      thinking: { type: "disabled" },
    });
    expect(resolveChatReasoning({ ...config, baseUrl: "https://api.deepseek.com.proxy.example/v1" }).fields).toEqual(
      {},
    );
    expect(resolveChatReasoning({ ...config, baseUrl: "https://proxy.example/v1" }).fields).toEqual({});
  });

  it("allows an explicit proxy dialect and does not apply it to a Claude endpoint", () => {
    const config = {
      ...model,
      model: "kimi-k2.6",
      reasoningDialect: "kimi" as const,
      reasoningEffort: "high" as const,
      baseUrl: "https://proxy.example/v1",
    };
    expect(resolveChatReasoning(config).fields).toEqual({ thinking: { type: "enabled" } });
    expect(resolveChatReasoning({ ...config, provider: "anthropic-messages" }).fields).toEqual({
      reasoning_effort: "high",
    });
  });

  it("uses documented K3 effort and K2 toggles instead of proxy-only thinking.effort", () => {
    const config = { ...model, baseUrl: "https://api.moonshot.ai/v1" };
    expect(resolveChatReasoning({ ...config, model: "kimi-k3", reasoningEffort: "max" }).fields).toEqual({
      reasoning_effort: "max",
    });
    expect(() => resolveChatReasoning({ ...config, model: "kimi-k3", reasoningEffort: "off" })).toThrow(
      "does not support disabling",
    );
    expect(() => resolveChatReasoning({ ...config, model: "kimi-k3", reasoningEffort: "medium" })).toThrow(
      "Allowed: low, high, max",
    );
    expect(resolveChatReasoning({ ...config, model: "kimi-k2.5", reasoningEffort: "off" }).fields).toEqual({
      thinking: { type: "disabled" },
    });
    expect(() => resolveChatReasoning({ ...config, model: "kimi-k2.7-code", reasoningEffort: "off" })).toThrow(
      "does not support disabling",
    );
    expect(
      resolveChatReasoning({ ...config, model: "kimi-k3", reasoningLevels: ["low", "high", "max"] }, "medium").fields,
    ).toEqual({});
  });

  it("does not silently reduce documented max on DeepSeek/OpenRouter", () => {
    expect(
      resolveChatReasoning({ ...model, reasoningDialect: "deepseek", reasoningEffort: "max" }).fields.reasoning_effort,
    ).toBe("max");
    expect(
      resolveChatReasoning({ ...model, reasoningDialect: "openrouter", reasoningEffort: "max" }).fields.reasoning,
    ).toEqual({ effort: "max" });
  });
});
