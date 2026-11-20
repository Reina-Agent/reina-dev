import { describe, expect, it } from "vitest";
import type { KnownModel } from "./agentSettings";
import { describePickerModel, parseProviderPresentation } from "./modelPickerPresentation";

const model: KnownModel = { id: "kimi", provider: "anthropic-messages", model: "k3", baseUrl: "https://api.kimi.com/coding/v1" };
const uploadedLogo = "data:image/png;base64,iVBORw0KGgo=";

describe("parseProviderPresentation", () => {
  it("extracts only display fields, keeping credentials outside the picker metadata", () => {
    const result = parseProviderPresentation(JSON.stringify([{
      provider: "openai-chat", baseUrl: "https://gateway.example/v1", label: "我的网关",
      logoBrand: "kimi", logoDataUrl: uploadedLogo, apiKey: "private-key", headers: { Authorization: "private-token" },
    }]));
    expect(result).toEqual([{
      provider: "openai-chat", baseUrl: "https://gateway.example/v1", label: "我的网关", logoBrand: "kimi", logoDataUrl: uploadedLogo,
    }]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects invalid logos and tolerates invalid or incomplete store data", () => {
    for (const raw of [null, "{", "{}", "null"]) expect(parseProviderPresentation(raw)).toEqual([]);
    expect(parseProviderPresentation(JSON.stringify([null, 3, {}, { provider: "" }, {
      provider: "openai-chat", logoBrand: "../openai", logoDataUrl: "https://example.com/logo.png",
    }]))).toEqual([{ provider: "openai-chat", baseUrl: "" }]);
  });
});

describe("describePickerModel", () => {
  it.each([
    ["kimi-oauth", "Kimi", "kimi"],
    ["anthropic-oauth", "Claude", "anthropic"],
    ["openai-codex", "ChatGPT Codex", "openai"],
  ])("identifies %s subscriptions by account kind instead of the transport", (subscriptionKind, label, brand) => {
    const presentation = describePickerModel({
      ...model, subscription: true, subscriptionId: "account-1", subscriptionKind,
      subscriptionEmail: "account@example.com", label: "Custom account name",
    }, []);
    expect(presentation).toMatchObject({
      category: "subscription", groupLabel: label, name: "k3", detail: "account@example.com", logo: { logoBrand: brand },
    });
  });

  it("keeps an unknown subscription neutral and retains the account label", () => {
    expect(describePickerModel({ ...model, subscription: true, model: "", label: "工作账号" }, [])).toMatchObject({
      groupLabel: "订阅账号", name: "默认模型", detail: "工作账号", logo: { logoBrand: undefined },
    });
  });

  it("identifies API brands from the endpoint and replaces the automatic transport label", () => {
    expect(describePickerModel(model, [{
      provider: model.provider, baseUrl: `${model.baseUrl}/`, label: "anthropic-messages — api.kimi.com",
    }])).toMatchObject({
      category: "api", groupLabel: "Kimi", groupDetail: "api.kimi.com/coding/v1", name: "k3", detail: "", logo: { logoBrand: "kimi" },
    });
  });

  it("matches provider metadata using protocol and the full endpoint, normalizing trailing slashes", () => {
    const providers = [{ provider: model.provider, baseUrl: `${model.baseUrl}/`, label: "工作 Kimi", logoDataUrl: uploadedLogo }];
    expect(describePickerModel(model, providers)).toMatchObject({ groupLabel: "工作 Kimi", logo: { logoDataUrl: uploadedLogo } });
    expect(describePickerModel({ ...model, provider: "openai-chat" }, providers).groupLabel).toBe("Kimi");
    expect(describePickerModel({ ...model, baseUrl: "https://api.kimi.com/other/v1" }, providers).groupLabel).toBe("Kimi");
    expect(describePickerModel(model, providers).groupKey).toBe(describePickerModel({ ...model, baseUrl: `${model.baseUrl}/` }, providers).groupKey);
  });

  it("keeps the same model on different paths and protocols in separate groups", () => {
    const variants = [model, { ...model, provider: "openai-chat" }, { ...model, baseUrl: "https://api.kimi.com/other/v1" }];
    expect(new Set(variants.map((entry) => describePickerModel(entry, []).groupKey)).size).toBe(3);
    expect(describePickerModel(variants[2], []).groupDetail).toBe("api.kimi.com/other/v1");
  });

  it("preserves model aliases while exposing the exact model ID", () => {
    expect(describePickerModel({ ...model, label: "Kimi 工作模型" }, [])).toMatchObject({ name: "Kimi 工作模型", detail: "k3" });
  });

  it("uses unknown gateway names without confusing model names or protocols for brands", () => {
    expect(describePickerModel({ ...model, provider: "openai-chat", model: "deepseek-v4-pro", baseUrl: "https://gateway.example/v1" }, [])).toMatchObject({
      groupLabel: "gateway.example", logo: { logoBrand: undefined },
    });
  });

  it("keeps manual logo selection independent from the provider name", () => {
    expect(describePickerModel(model, [{ provider: model.provider, baseUrl: model.baseUrl!, logoBrand: "openai" }])).toMatchObject({
      groupLabel: "Kimi", logo: { logoBrand: "openai" },
    });
    expect(describePickerModel(model, [{ provider: model.provider, baseUrl: model.baseUrl!, label: "工作网关", logoBrand: "openai" }])).toMatchObject({
      groupLabel: "工作网关", logo: { logoBrand: "openai" },
    });
  });

  it("omits endpoint credentials, query parameters, and fragments from visible labels", () => {
    const result = describePickerModel({ ...model, baseUrl: "https://user:password@gateway.example:8443/v1?key=private#secret" }, []);
    expect(result.groupLabel).toBe("gateway.example:8443");
    expect(result.groupDetail).toBe("gateway.example:8443/v1");
    expect([result.groupLabel, result.groupDetail, result.name, result.detail].join(" ")).not.toMatch(/password|private|secret|user/);
  });

  it("describes deterministic models as an offline fixture", () => {
    expect(describePickerModel({ id: "deterministic", provider: "deterministic", model: "reina-deterministic" }, [])).toMatchObject({
      category: "offline", groupLabel: "离线模型", name: "离线测试模型", detail: "无需 API · 不联网",
    });
  });
});
