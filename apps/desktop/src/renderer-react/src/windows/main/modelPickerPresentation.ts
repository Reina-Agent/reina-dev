import { isProviderBrand, PROVIDER_BRANDS, resolveProviderBrand, type ProviderBrand } from "../../lib/providerBrands";
import { isProviderLogo } from "../../lib/providerLogoUpload";
import type { KnownModel } from "./agentSettings";

export interface ProviderPresentationMeta {
  provider: string;
  baseUrl: string;
  label?: string;
  logoBrand?: ProviderBrand;
  logoDataUrl?: string;
}

export interface PickerModelPresentation {
  category: "subscription" | "api" | "offline";
  groupKey: string;
  groupLabel: string;
  groupDetail: string;
  name: string;
  detail: string;
  logo: ProviderPresentationMeta & { label: string };
}

export function parseProviderPresentation(raw: string | null): ProviderPresentationMeta[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): ProviderPresentationMeta[] => {
      if (!entry || typeof entry !== "object" || typeof entry.provider !== "string" || !entry.provider.trim()) return [];
      return [{
        provider: entry.provider.trim(),
        baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "",
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
        ...(isProviderBrand(entry.logoBrand) ? { logoBrand: entry.logoBrand } : {}),
        ...(isProviderLogo(entry.logoDataUrl) ? { logoDataUrl: entry.logoDataUrl } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function providerKey(provider: string, baseUrl: string): string {
  return `${provider}|${baseUrl.trim().replace(/\/+$/, "")}`;
}

function endpointDisplay(baseUrl: string): { host: string; detail: string } {
  if (!baseUrl) return { host: "", detail: "默认端点" };
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { host: url.host, detail: `${url.host}${url.pathname.replace(/\/+$/, "")}` };
    }
  } catch {
    // Incomplete endpoints should not expose credentials or query parameters.
  }
  return { host: "", detail: "自定义端点" };
}

const SUBSCRIPTION_BRANDS: Record<string, { label: string; brand: ProviderBrand }> = {
  "openai-codex": { label: "ChatGPT Codex", brand: "openai" },
  "kimi-oauth": { label: "Kimi", brand: "kimi" },
  "anthropic-oauth": { label: "Claude", brand: "anthropic" },
};

export function describePickerModel(model: KnownModel, providers: ProviderPresentationMeta[]): PickerModelPresentation {
  const provider = model.provider || "";
  const baseUrl = (model.baseUrl || "").trim();
  const modelName = model.model.trim();

  if (model.subscription || model.subscriptionId) {
    const kind = model.subscriptionKind || (provider === "openai-codex-responses" ? "openai-codex" : "unknown");
    const subscription = SUBSCRIPTION_BRANDS[kind];
    const label = subscription?.label || "订阅账号";
    return {
      category: "subscription",
      groupKey: `subscription:${kind}`,
      groupLabel: label,
      groupDetail: "订阅账号",
      name: modelName || "默认模型",
      detail: model.subscriptionEmail?.trim() || model.label?.trim() || "已连接账号",
      logo: { label, baseUrl: "", provider: "", logoBrand: subscription?.brand },
    };
  }

  if (provider === "deterministic" || model.id === "deterministic") {
    return {
      category: "offline",
      groupKey: "offline:deterministic",
      groupLabel: "离线模型",
      groupDetail: "内置",
      name: "离线测试模型",
      detail: "无需 API · 不联网",
      logo: { label: "离线", baseUrl: "", provider: "deterministic" },
    };
  }

  const key = providerKey(provider, baseUrl);
  const meta = providers.find((entry) => providerKey(entry.provider, entry.baseUrl) === key);
  const endpoint = endpointDisplay(baseUrl);
  const storedLabel = meta?.label?.trim() || "";
  const automaticLabel = !storedLabel || storedLabel === provider || storedLabel === "New provider"
    || [endpoint.host, baseUrl].some((suffix) => suffix && [" — ", " - "].some((separator) => storedLabel === `${provider}${separator}${suffix}`));
  const customLabel = automaticLabel ? "" : storedLabel;
  const brand = resolveProviderBrand({ label: customLabel, baseUrl, provider });
  const groupLabel = customLabel || PROVIDER_BRANDS.find((entry) => entry.id === brand)?.label || endpoint.host || "自定义提供方";
  const name = model.label?.trim() || modelName || model.id;

  return {
    category: "api",
    groupKey: `api:${key}`,
    groupLabel,
    groupDetail: endpoint.detail,
    name,
    detail: name === modelName ? "" : modelName,
    logo: {
      label: groupLabel,
      baseUrl,
      provider,
      logoBrand: meta?.logoBrand ?? brand ?? undefined,
      logoDataUrl: meta?.logoDataUrl,
    },
  };
}
