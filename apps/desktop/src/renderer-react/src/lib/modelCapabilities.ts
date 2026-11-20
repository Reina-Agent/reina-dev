// Model capability detection + tag filtering — the single source of truth for
// both the composer "more models" picker (windows/main/agentSettings.ts) and
// the Settings → Models browser (windows/settings/panels/ModelsPanel.tsx).
//
// Ported verbatim from the legacy renderer/model-ui.js so groups/filters/tags
// match the plain-JS renderer exactly. Pure functions, no module deps — safe to
// import from any window bundle (importing agentSettings.ts instead would pull
// the main-window session store into the settings bundle).

export interface ModelTagDef {
  key: string;
  labelKey: string;
  fallback: string;
}

/** Minimal structural shape the capability heuristics read. Both the settings
 *  ModelEntry and the main-window KnownModel satisfy this. */
export interface CapabilityModel {
  id?: string;
  model?: string;
  name?: string;
  label?: string;
  provider?: string;
  baseUrl?: string;
  description?: string;
}

export const MODEL_TAGS: ModelTagDef[] = [
  { key: "vision", labelKey: "models.tag.vision", fallback: "Vision" },
  { key: "reasoning", labelKey: "models.tag.reasoning", fallback: "Reasoning" },
  { key: "tool", labelKey: "models.tag.tool", fallback: "Tool" },
  { key: "embedding", labelKey: "models.tag.embedding", fallback: "Embedding" },
  { key: "web", labelKey: "models.tag.web", fallback: "Web" },
  { key: "free", labelKey: "models.tag.free", fallback: "Free" },
];

function modelText(model: CapabilityModel): { lower: string; base: string; id: string; label: string } {
  const id = model?.model || model?.id || model?.name || "";
  const label = model?.label || model?.name || "";
  const lower = `${id} ${label}`.toLowerCase();
  const base = String(id).toLowerCase().split("/").pop()?.split(":")[0] || lower;
  return { lower, base, id: String(id), label: String(label) };
}

function isRerankModel(model: CapabilityModel): boolean {
  const { base } = modelText(model);
  return /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i.test(base);
}

export function isEmbeddingModel(model: CapabilityModel): boolean {
  if (isRerankModel(model)) return true;
  const { lower, base } = modelText(model);
  const regex = /(?:^text-|embed|bge-|e5-|llm2vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i;
  return regex.test(base) || regex.test(lower);
}

export function isTextToImageModel(model: CapabilityModel): boolean {
  const { base } = modelText(model);
  return /(?:dall-e|gpt-image|imagen|flux|stable-?diffusion|stabilityai|sd-|sdxl|cogview|qwen-image|janus|midjourney|mj-|z-image|longcat-image|hunyuanimage|seedream|kandinsky)(?:[-\w]+)?/i.test(base);
}

export function isVisionModel(model: CapabilityModel): boolean {
  if (isEmbeddingModel(model) || isTextToImageModel(model)) return false;
  const { lower, base } = modelText(model);
  const excluded = /(?:gpt-4-\d+-preview|gpt-4-turbo-preview|gpt-4-32k|gpt-4-\d+|o1-mini|o3-mini|o1-preview|aidc-ai\/marco-o1)/i;
  if (excluded.test(lower)) return false;
  const regex = /(?:llava|moondream|minicpm|gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d)?-(?:flash|pro)|flash|pro|flash-lite)|claude-3|claude-(?:haiku|sonnet|opus)-4|vision|glm-4(?:\.\d+)?v|glm-5v|qwen(?:2(?:\.5)?|3)?-vl|qwen(?:2\.5|3)-omni|qvq|internvl|grok-(?:vision|4)|pixtral|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o|o[134]|deepseek-vl|kimi-(?:k2\.[56]|latest|vl)|gemma-?[34]|doubao-seed-(?:1[.-][68]|2[.-]0|code)|llama-4|step-1[ov]|mistral-(?:large|medium|small)|mimo-v2(?:\.5|-omni))/i;
  return regex.test(base);
}

export function isReasoningModel(model: CapabilityModel): boolean {
  if (isEmbeddingModel(model) || isTextToImageModel(model)) return false;
  const { lower, base } = modelText(model);
  if (/-non-reasoning\b/i.test(base)) return false;
  const general = /(?:^o\d+(?:-[\w-]+)?$|\b(?:reasoning|reasoner|thinking|think)\b|-[rR]\d+\b|\bqwq\b|\bhunyuan-t1\b|\bglm-zero-preview\b|\bgrok-(?:3-mini|4|4-fast)\b)/i;
  const qwen = /(?:^qwen3(?:\.[5-9])?-(?:max|plus|flash|turbo|\d)|^qwen-max-latest|qwq|qvq)/i;
  const gemini = /gemini-(?:2\.5|3(?:\.\d+)?-(?:flash|pro)|flash-latest|pro-latest|flash-lite-latest)/i;
  const claude = /claude-(?:3[.-]7-sonnet|(?:haiku|sonnet|opus)-4)/i;
  const doubao = /doubao-(?:1[.-]5-thinking|seed-1[.-][68](?:-flash)?|seed-code|seed-2[.-]0)/i;
  const deepseek = /deepseek-(?:chat|v3(?:[.-]\d)|v[4-9])|deepseek-v3\.2-speciale/i;
  const others = /(?:kimi-k2-thinking|kimi-k(?:2\.[5-9]|[3-9])|minimax-m[12]|mimo-v2|glm-z1|glm-4\.5|glm-4\.7|glm-5|step-3|step-r1|magistral|mistral-small-2603|pangu-pro-moe|seed-oss|gemma-?4|hunyuan-a13b|ring-1t|ring-mini|ring-flash)/i;
  return [general, qwen, gemini, claude, doubao, deepseek, others].some((regex) => regex.test(base) || regex.test(lower));
}

export function isToolModel(model: CapabilityModel): boolean {
  if (isEmbeddingModel(model) || isTextToImageModel(model)) return false;
  const { lower, base } = modelText(model);
  const excluded = /(?:aqa|imagen|o1-mini|o1-preview|aidc-ai\/marco-o1|gemini-1(?:\.[\w-]+)?|qwen-mt|gpt-5-chat|glm-4\.5v|gemini-2\.5-flash-image|gemini-2\.0-flash-preview-image-generation|gemini-3(?:\.\d+)?-pro-image|deepseek-v3\.2-speciale|deepseek-r1)/i;
  if (excluded.test(lower)) return false;
  const regex = /(?:gpt-4o|gpt-4o-mini|gpt-4|gpt-4\.5|gpt-oss|gpt-5|o[134]|claude|qwen3?|hunyuan|deepseek|glm-(?:4|4\.5|4\.7|5)|learnlm|gemini|gemma-?4|grok-[34]|doubao-seed-(?:1[.-][68]|2[.-]0|code)|kimi-k2|ling-\w+|ring-\w+|minimax-m2|mimo-v2|function|tool)/i;
  return regex.test(base);
}

export function isWebModel(model: CapabilityModel): boolean {
  const { lower, base } = modelText(model);
  return /(?:web[-_ ]?search|search|online|联网|browse|browser)/i.test(base) || /web[-_ ]?search/i.test(lower);
}

export function isFreeModel(model: CapabilityModel): boolean {
  const { lower, base } = modelText(model);
  return /(?:^free[-_/]|[-_/]free$|free-trial|免费|gratis|no-cost)/i.test(base) || /\bfree\b/i.test(lower);
}

export function getModelTagKeys(model: CapabilityModel): string[] {
  const tags: string[] = [];
  if (isVisionModel(model)) tags.push("vision");
  if (isReasoningModel(model)) tags.push("reasoning");
  if (isToolModel(model)) tags.push("tool");
  if (isEmbeddingModel(model)) tags.push("embedding");
  if (isWebModel(model)) tags.push("web");
  if (isFreeModel(model)) tags.push("free");
  return tags;
}

export function modelMatchesTags(model: CapabilityModel, selectedTags: Set<string>): boolean {
  if (!selectedTags || selectedTags.size === 0) return true;
  const tags = new Set(getModelTagKeys(model));
  for (const tag of selectedTags) {
    if (!tags.has(tag)) return false;
  }
  return true;
}

export function modelMatchesQuery(model: CapabilityModel, query: string): boolean {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [model?.label, model?.model, model?.provider, model?.baseUrl, model?.description, model?.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => haystack.includes(part));
}
