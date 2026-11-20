export type ProviderBrand =
  | "openai" | "anthropic" | "deepseek" | "kimi" | "xiaomi" | "alibaba"
  | "xai" | "gemini" | "zai" | "minimax" | "openrouter" | "mistral" | "ollama";

export const PROVIDER_BRANDS: { id: ProviderBrand; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "kimi", label: "Kimi" },
  { id: "xiaomi", label: "Xiaomi MiMo" },
  { id: "alibaba", label: "Alibaba Qwen" },
  { id: "xai", label: "xAI" },
  { id: "gemini", label: "Gemini" },
  { id: "zai", label: "Z.ai" },
  { id: "minimax", label: "MiniMax" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "mistral", label: "Mistral" },
  { id: "ollama", label: "Ollama" },
];

const PROVIDER_BRAND_IDS = new Set<string>(PROVIDER_BRANDS.map(({ id }) => id));

export function isProviderBrand(value: unknown): value is ProviderBrand {
  return typeof value === "string" && PROVIDER_BRAND_IDS.has(value);
}

export interface ProviderBrandIdentity {
  label: string;
  baseUrl: string;
  provider: string;
}

const BRAND_DOMAINS: [ProviderBrand, string[]][] = [
  ["openai", ["openai.com"]],
  ["anthropic", ["anthropic.com"]],
  ["deepseek", ["deepseek.com"]],
  ["kimi", ["moonshot.cn", "moonshot.ai", "kimi.com"]],
  ["xiaomi", ["xiaomimimo.com"]],
  ["alibaba", ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "bailian.aliyuncs.com"]],
  ["xai", ["x.ai"]],
  ["gemini", ["generativelanguage.googleapis.com", "aiplatform.googleapis.com"]],
  ["zai", ["z.ai", "bigmodel.cn"]],
  ["minimax", ["minimax.io", "minimaxi.com", "minimax.chat"]],
  ["openrouter", ["openrouter.ai"]],
  ["mistral", ["mistral.ai"]],
  ["ollama", ["ollama.com"]],
];

const BRAND_ALIASES: [ProviderBrand, string[]][] = [
  ["openai", ["openai", "chatgpt"]],
  ["anthropic", ["anthropic", "claude"]],
  ["deepseek", ["deepseek", "深度求索"]],
  ["kimi", ["kimi", "moonshot", "月之暗面"]],
  ["xiaomi", ["xiaomi", "mimo", "小米", "小米 mimo"]],
  ["alibaba", ["ali", "alibaba", "qwen", "dashscope", "阿里", "阿里云", "通义千问", "百炼"]],
  ["xai", ["xai", "x.ai", "grok"]],
  ["gemini", ["google", "gemini"]],
  ["zai", ["zai", "z.ai", "zhipu", "智谱"]],
  ["minimax", ["minimax"]],
  ["openrouter", ["openrouter"]],
  ["mistral", ["mistral"]],
  ["ollama", ["ollama"]],
];

const PROTOCOL_BRANDS: Record<string, ProviderBrand> = {
  "openai-chat": "openai",
  "openai-responses": "openai",
  openai: "openai",
  "anthropic-messages": "anthropic",
  anthropic: "anthropic",
  google: "gemini",
  gemini: "gemini",
  ollama: "ollama",
};

export function resolveProviderBrand({ label, baseUrl, provider }: ProviderBrandIdentity): ProviderBrand | null {
  const endpoint = baseUrl.trim();
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol === "https:" || url.protocol === "http:") {
        const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
        for (const [brand, domains] of BRAND_DOMAINS) {
          if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return brand;
        }
      }
    } catch {
      // An incomplete URL can still have an explicitly named provider.
    }
  }

  // Match explicit provider names, never substrings in gateway hostnames or
  // model IDs. A transport name such as "openai-chat" is not a brand label.
  const name = label.trim().toLowerCase();
  for (const [brand, aliases] of BRAND_ALIASES) {
    if (aliases.includes(name)) return brand;
  }

  return endpoint ? null : (PROTOCOL_BRANDS[provider.trim().toLowerCase()] ?? null);
}
