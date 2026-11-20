// User-defined model catalog (~/.reina/models.json + .reina/models.json):
// the parse/validate layer, extracted from ipc.ts so it stays free of
// electron imports and unit-testable. parseCustomModels is BOTH the read
// path and the write sanitizer (writeCustomModels round-trips through it),
// so every ModelConfig capability field MUST be carried here or a settings
// save silently erases it from the user's file — see custom-models.test.ts.
import type { ModelConfig, ModelProvider, ReasoningEffort } from "@reina/protocol";
import { modelConfigSchema, normalizeReasoningEffort, reasoningEfforts, reasoningLevelsSchema, sanitizeModelHeaders } from "@reina/protocol";

export const ENGINE_CONFIG_PROVIDERS: ModelProvider[] = ["deterministic", "openai-responses", "openai-chat", "anthropic-messages", "openai-codex-responses"];

export type CustomModel = {
  id: string;
  label: string;
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  description?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  // Per-model capability fields (see ModelConfig): must survive the models.json
  // round-trip or the documented "set it per-model in models.json" contract breaks.
  thinkingMode?: ModelConfig["thinkingMode"];
  supportedEfforts?: ReasoningEffort[];
  reasoningLevels?: ReasoningEffort[];
  reasoningDialect?: ModelConfig["reasoningDialect"];
  offEffort?: ModelConfig["offEffort"];
  authMode?: ModelConfig["authMode"];
  headers?: ModelConfig["headers"];
};

/** Validate a models.json `supportedEfforts` entry: keep known tiers (migrating
 * the legacy `extra-high` alias), drop everything else. */
export function sanitizeSupportedEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers = value
    .map((tier) => normalizeReasoningEffort(tier))
    .filter((tier): tier is ReasoningEffort => typeof tier === "string" && (reasoningEfforts as readonly string[]).includes(tier));
  return tiers.length > 0 ? tiers : undefined;
}

export function parseCustomModels(raw: string | null): CustomModel[] {
  if (!raw) return [];
  try {
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): CustomModel | null => {
        if (!entry || typeof entry !== "object") return null;
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : null;
        const provider = typeof e.provider === "string" && (ENGINE_CONFIG_PROVIDERS as string[]).includes(e.provider) ? (e.provider as ModelProvider) : null;
        const model = typeof e.model === "string" && e.model.trim() ? e.model.trim() : null;
        if (!id || !provider || !model) return null;
        const out: CustomModel = {
          id,
          label: typeof e.label === "string" && e.label.trim() ? e.label.trim() : id,
          provider,
          model,
        };
        if (typeof e.apiKey === "string" && e.apiKey.trim()) out.apiKey = e.apiKey.trim();
        // Backwards-compat migration: older configs stored the literal key in `apiKeyEnv`.
        // If the literal-key field is empty and apiKeyEnv looks like a key value (not an
        // identifier), promote it to apiKey so existing users keep working.
        else if (typeof e.apiKeyEnv === "string" && e.apiKeyEnv.trim()) {
          out.apiKey = e.apiKeyEnv.trim();
        }
        if (typeof e.baseUrl === "string" && e.baseUrl.trim()) out.baseUrl = e.baseUrl.trim();
        if (typeof e.description === "string" && e.description.trim()) out.description = e.description.trim();
        if (typeof e.contextWindowTokens === "number" && Number.isFinite(e.contextWindowTokens) && e.contextWindowTokens > 0) {
          out.contextWindowTokens = Math.floor(e.contextWindowTokens);
        }
        if (typeof e.maxOutputTokens === "number" && Number.isFinite(e.maxOutputTokens) && e.maxOutputTokens > 0) {
          out.maxOutputTokens = Math.floor(e.maxOutputTokens);
        }
        if (e.thinkingMode === "adaptive" || e.thinkingMode === "budget") out.thinkingMode = e.thinkingMode;
        const supportedEfforts = sanitizeSupportedEfforts(e.supportedEfforts);
        if (supportedEfforts) out.supportedEfforts = supportedEfforts;
        if (e.reasoningLevels !== undefined) out.reasoningLevels = reasoningLevelsSchema.parse(e.reasoningLevels);
        if (e.reasoningDialect !== undefined) out.reasoningDialect = modelConfigSchema.shape.reasoningDialect.parse(e.reasoningDialect);
        if (e.offEffort !== undefined) out.offEffort = modelConfigSchema.shape.offEffort.parse(e.offEffort);
        if (e.authMode !== undefined) out.authMode = modelConfigSchema.shape.authMode.parse(e.authMode);
        if (e.headers !== undefined) out.headers = sanitizeModelHeaders(e.headers);
        return out;
      })
      .filter((m): m is CustomModel => Boolean(m));
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

/** Engine/side-call model overrides share the catalog's compatibility fields. */
export function sanitizeModel(model: unknown): Partial<ModelConfig> | undefined {
  if (!model || typeof model !== "object") return undefined;
  const incoming = model as Record<string, unknown>;
  const out: Partial<ModelConfig> = {};
  if (typeof incoming.provider === "string" && (ENGINE_CONFIG_PROVIDERS as string[]).includes(incoming.provider)) {
    out.provider = incoming.provider as ModelProvider;
  }
  if (typeof incoming.model === "string" && incoming.model.trim()) out.model = incoming.model.trim();
  if (typeof incoming.baseUrl === "string" && incoming.baseUrl.trim()) out.baseUrl = incoming.baseUrl.trim();
  if (typeof incoming.apiKey === "string" && incoming.apiKey.trim()) out.apiKey = incoming.apiKey.trim();
  // Migrate older configs that stored the literal key in apiKeyEnv.
  else if (typeof incoming.apiKeyEnv === "string" && incoming.apiKeyEnv.trim()) {
    out.apiKey = incoming.apiKeyEnv.trim();
  }
  if (typeof incoming.contextWindowTokens === "number" && Number.isFinite(incoming.contextWindowTokens) && incoming.contextWindowTokens > 0) {
    out.contextWindowTokens = Math.floor(incoming.contextWindowTokens);
  }
  if (typeof incoming.maxOutputTokens === "number" && Number.isFinite(incoming.maxOutputTokens) && incoming.maxOutputTokens > 0) {
    out.maxOutputTokens = Math.floor(incoming.maxOutputTokens);
  }
  // Resolve the subscription reference to a fresh token only at session start.
  if (typeof incoming.subscriptionId === "string" && incoming.subscriptionId.trim()) out.subscriptionId = incoming.subscriptionId.trim();
  if (typeof incoming.accountId === "string" && incoming.accountId.trim()) out.accountId = incoming.accountId.trim();
  if (incoming.thinkingMode === "adaptive" || incoming.thinkingMode === "budget") out.thinkingMode = incoming.thinkingMode;
  const supportedEfforts = sanitizeSupportedEfforts(incoming.supportedEfforts);
  if (supportedEfforts) out.supportedEfforts = supportedEfforts;
  if (incoming.reasoningEffort !== undefined) out.reasoningEffort = modelConfigSchema.shape.reasoningEffort.parse(incoming.reasoningEffort);
  if (incoming.reasoningLevels !== undefined) out.reasoningLevels = reasoningLevelsSchema.parse(incoming.reasoningLevels);
  if (incoming.reasoningDialect !== undefined) out.reasoningDialect = modelConfigSchema.shape.reasoningDialect.parse(incoming.reasoningDialect);
  if (incoming.offEffort !== undefined) out.offEffort = modelConfigSchema.shape.offEffort.parse(incoming.offEffort);
  if (incoming.authMode !== undefined) out.authMode = modelConfigSchema.shape.authMode.parse(incoming.authMode);
  if (incoming.headers !== undefined) out.headers = sanitizeModelHeaders(incoming.headers);
  return Object.keys(out).length ? out : undefined;
}
