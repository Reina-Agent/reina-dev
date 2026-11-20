import { describe, expect, it } from "vitest";
import { isProviderBrand, PROVIDER_BRANDS, resolveProviderBrand } from "./providerBrands";

describe("isProviderBrand", () => {
  it("accepts each built-in brand ID", () => {
    expect(PROVIDER_BRANDS).toHaveLength(13);
    expect(PROVIDER_BRANDS.every(({ id }) => isProviderBrand(id))).toBe(true);
  });

  it("rejects unknown IDs and non-string values", () => {
    for (const value of ["", "OpenAI", "custom", "../openai", "__proto__", null, undefined, 1, {}]) {
      expect(isProviderBrand(value)).toBe(false);
    }
  });
});

describe("resolveProviderBrand", () => {
  it.each([
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://API.MOONSHOT.CN/v1", "kimi"],
    ["https://api.kimi.com/coding/v1", "kimi"],
    ["https://api.xiaomimimo.com/v1", "xiaomi"],
    ["https://coding.dashscope.aliyuncs.com/v1", "alibaba"],
    ["https://api.x.ai/v1", "xai"],
    ["https://generativelanguage.googleapis.com/v1beta", "gemini"],
    ["https://open.bigmodel.cn/api/paas/v4", "zai"],
    ["https://api.minimax.io/anthropic/v1", "minimax"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.mistral.ai/v1", "mistral"],
    ["https://ollama.com/api", "ollama"],
  ])("uses the provider endpoint %s despite a generic transport label", (baseUrl, brand) => {
    expect(resolveProviderBrand({ label: "openai-chat", baseUrl, provider: "openai-chat" })).toBe(brand);
  });

  it("prioritizes the endpoint over an outdated provider name", () => {
    expect(resolveProviderBrand({ label: "OpenAI", baseUrl: "https://api.deepseek.com/v1", provider: "openai-chat" })).toBe("deepseek");
  });

  it.each([
    [" Kimi ", "kimi"], ["小米", "xiaomi"], ["ali", "alibaba"], ["grok", "xai"],
  ])("honors an explicitly named provider %s on a custom endpoint", (label, brand) => {
    expect(resolveProviderBrand({ label, baseUrl: "https://gateway.example/v1", provider: "openai-chat" })).toBe(brand);
  });

  it.each([
    "https://gateway.example/v1",
    "https://api.deepseek.com.evil.example/v1",
    "https://notdeepseek.com/v1",
    "https://api.openai.com@evil.example/v1",
    "https://evil.example/api.openai.com/v1",
    "https://evil.example/?upstream=api.openai.com",
    "not a url",
  ])("keeps unknown gateways neutral (%s)", (baseUrl) => {
    expect(resolveProviderBrand({ label: "openai-chat", baseUrl, provider: "openai-chat" })).toBeNull();
  });

  it("does not treat a model ID or a hostname in the label as a provider name", () => {
    for (const label of ["deepseek-v4-flash", "api.deepseek.com.evil.example", "openai-chat — gateway.example"]) {
      expect(resolveProviderBrand({ label, baseUrl: "https://gateway.example/v1", provider: "openai-chat" })).toBeNull();
    }
  });

  it("uses the protocol brand only when no endpoint is configured", () => {
    expect(resolveProviderBrand({ label: "My provider", baseUrl: "  ", provider: "openai-responses" })).toBe("openai");
    expect(resolveProviderBrand({ label: "My provider", baseUrl: "", provider: "anthropic-messages" })).toBe("anthropic");
    expect(resolveProviderBrand({ label: "My provider", baseUrl: "", provider: "custom" })).toBeNull();
  });
});
