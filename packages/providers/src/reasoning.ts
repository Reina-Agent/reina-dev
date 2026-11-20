import {
  normalizeReasoningEffort,
  reasoningLevelsSchema,
  type ModelConfig,
  type ReasoningEffort,
} from "@reina/protocol";

/** Complete capabilities are opt-in. Legacy supportedEfforts only gates the
 * top tiers and must not turn ["xhigh", "max"] into a low/high exclusion. */
export function validatedReasoningEffort(
  config: ModelConfig,
  fallbackEffort?: ReasoningEffort,
): ReasoningEffort | undefined {
  const effort = normalizeReasoningEffort(config.reasoningEffort ?? fallbackEffort) as ReasoningEffort | undefined;
  if (config.reasoningLevels !== undefined) {
    // Resumed sessions can bypass the protocol schema; validate here as well.
    const levels = reasoningLevelsSchema.parse(config.reasoningLevels);
    if (effort !== undefined && !levels.includes(effort)) {
      throw new Error(
        `Reasoning effort "${effort}" is not supported by ${config.model}. Allowed: ${levels.join(", ")}.`,
      );
    }
  }
  return effort;
}

export function resolveOpenAIReasoningEffort(
  config: ModelConfig,
  fallbackEffort?: ReasoningEffort,
): "none" | Exclude<ReasoningEffort, "off"> | undefined {
  const effort = validatedReasoningEffort(config, fallbackEffort);
  if (effort === undefined) return undefined;
  if (effort === "off") return config.offEffort ?? (config.reasoningLevels?.includes("off") ? "none" : undefined);
  if (config.reasoningLevels !== undefined || (effort !== "xhigh" && effort !== "max")) return effort;
  if (effort === "max" && config.supportedEfforts?.includes("max")) return "max";
  return config.supportedEfforts?.includes("xhigh") ? "xhigh" : "high";
}

function chatDialect(config: ModelConfig): NonNullable<ModelConfig["reasoningDialect"]> {
  if (config.reasoningDialect) return config.reasoningDialect;
  let origin: string;
  try {
    origin = new URL(config.baseUrl ?? "https://api.openai.com/v1").origin;
  } catch {
    return "openai";
  }
  // Exact official origins only: a proxy serving the same model can speak a
  // different dialect. Never guess from a model name or hostname substring.
  switch (origin) {
    case "https://api.deepseek.com":
      return "deepseek";
    case "https://api.moonshot.cn":
    case "https://api.moonshot.ai":
      return "kimi";
    case "https://openrouter.ai":
      return "openrouter";
    case "https://dashscope.aliyuncs.com":
    case "https://dashscope-intl.aliyuncs.com":
    case "https://dashscope-us.aliyuncs.com":
      return "qwen";
    default:
      return "openai";
  }
}

export function resolveChatReasoning(
  config: ModelConfig,
  fallbackEffort?: ReasoningEffort,
): {
  fields: Record<string, unknown>;
  reasoningOn: boolean;
} {
  // The replay fallback is a generic gateway workaround. Native dialects can
  // preserve their upstream default; injecting medium breaks models like K3.
  const dialect = config.provider === "openai-chat" ? chatDialect(config) : "openai";
  const effectiveFallback = dialect === "openai" ? fallbackEffort : undefined;
  const effort = validatedReasoningEffort(config, effectiveFallback);
  if (effort === undefined) return { fields: {}, reasoningOn: false };
  const enabled = effort !== "off";
  // This adapter must not rewrite Kimi's Anthropic-compatible Messages route.
  const openAIEffort = resolveOpenAIReasoningEffort(config, effectiveFallback);
  // Known non-OpenAI dialects must not inherit OpenAI's unknown-model high cap.
  // Explicit legacy top-tier overrides still retain their original meaning.
  const wireEffort = config.supportedEfforts && config.reasoningLevels === undefined ? openAIEffort : effort;
  switch (dialect) {
    case "deepseek":
      // DeepSeek documents low/high/max; medium and xhigh are accepted aliases
      // for high. Preserve max rather than applying the generic OpenAI cap.
      return {
        fields: {
          thinking: { type: enabled ? "enabled" : "disabled" },
          ...(enabled ? { reasoning_effort: wireEffort } : {}),
        },
        reasoningOn: enabled,
      };
    case "kimi": {
      // Kimi's current API differs from some proxy implementations: K3 uses
      // top-level reasoning_effort; K2.x uses a toggle with no effort field.
      // https://platform.kimi.ai/docs/api/chat
      if (/^kimi-k3(?:$|-)/i.test(config.model)) {
        if (!enabled) throw new Error(`${config.model} does not support disabling thinking.`);
        if (wireEffort !== "low" && wireEffort !== "high" && wireEffort !== "max") {
          throw new Error(`Reasoning effort "${effort}" is not supported by ${config.model}. Allowed: low, high, max.`);
        }
        return { fields: { reasoning_effort: wireEffort }, reasoningOn: true };
      }
      if (/^kimi-k2\.(?:5|6|7)(?:$|-)/i.test(config.model)) {
        if (!enabled && /^kimi-k2\.7-code(?:$|-)/i.test(config.model))
          throw new Error(`${config.model} does not support disabling thinking.`);
        return { fields: { thinking: { type: enabled ? "enabled" : "disabled" } }, reasoningOn: enabled };
      }
      // Unknown or proxy-aliased models need explicit capabilities; do not
      // infer a K2/K3 protocol merely because their endpoint belongs to Kimi.
      return { fields: openAIEffort ? { reasoning_effort: openAIEffort } : {}, reasoningOn: enabled };
    }
    case "qwen":
      // DashScope's Chat extension is a toggle, not OpenAI reasoning_effort.
      return { fields: { enable_thinking: enabled }, reasoningOn: enabled };
    case "openrouter":
      return { fields: { reasoning: { effort: enabled ? wireEffort : "none" } }, reasoningOn: enabled };
    default:
      return { fields: openAIEffort ? { reasoning_effort: openAIEffort } : {}, reasoningOn: enabled };
  }
}
