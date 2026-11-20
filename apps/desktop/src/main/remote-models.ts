// Model discovery and probes stay Electron-free so the actual HTTP contract
// can be tested alongside the SDK runtime against the same fixture server.
import type { ModelConfig } from "@reina/protocol";
import { fetchModelOperation, modelApiKey, modelOperationUrls, modelRequestHeaders } from "@reina/providers/connection";
import { resolveChatReasoning, resolveOpenAIReasoningEffort } from "@reina/providers/reasoning";
import { resolveAnthropicThinking } from "@reina/providers";
import { validateModelProbeResponse } from "./model-probe-response.js";

export type RemoteModelParams = { provider: string } & Partial<
  Pick<
    ModelConfig,
    | "baseUrl"
    | "apiKey"
    | "authMode"
    | "headers"
    | "maxOutputTokens"
    | "thinkingMode"
    | "reasoningEffort"
    | "supportedEfforts"
    | "reasoningLevels"
    | "reasoningDialect"
    | "offEffort"
  >
>;

type RemoteModel = { id: string; created?: number };

type ModelListPage = { data?: unknown[]; models?: unknown[]; has_more?: boolean; last_id?: string };

function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

/** Anthropic's `/v1/models` is cursor-paginated and defaults to 20 entries per
 * page (`has_more` + `last_id`); without following the cursor the picker
 * silently shows only the first page. Walk every page from the base that just
 * answered, accumulating into `data`. OpenAI-compat endpoints return the whole
 * list at once and omit `has_more`, so `paginate` is left off for them. */
async function drainModelPages(
  url: string,
  headers: Record<string, string>,
  limit: number,
  firstPage: ModelListPage,
  signal: AbortSignal,
): Promise<ModelListPage> {
  const data = [...(Array.isArray(firstPage.data) ? firstPage.data : [])];
  let page = firstPage;
  // Cap the walk so a server that always claims `has_more` can't spin forever.
  for (let i = 0; i < 100 && page.has_more && typeof page.last_id === "string"; i++) {
    if (signal.aborted) break;
    let response: Response;
    try {
      response = await fetch(appendQuery(url, { limit: String(limit), after_id: page.last_id }), { headers, signal });
    } catch {
      // The first page already succeeded; a mid-walk blip should not discard
      // what we have. Return the partial set rather than failing the picker.
      break;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      break;
    }
    page = (await response.json().catch(() => ({}))) as ModelListPage;
    if (signal.aborted) break;
    if (Array.isArray(page.data)) data.push(...page.data);
  }
  return { data };
}

async function fetchModelListPayload(
  urls: string[],
  headers: Record<string, string>,
  signal: AbortSignal,
  paginate?: { limit: number },
): Promise<ModelListPage> {
  const errors: string[] = [];

  for (const url of urls) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(paginate ? appendQuery(url, { limit: String(paginate.limit) }) : url, { headers, signal });
    } catch (error) {
      signal.throwIfAborted();
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Network error reaching ${url}: ${msg}`);
      continue;
    }

    if (response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ModelListPage;
      signal.throwIfAborted();
      return paginate ? await drainModelPages(url, headers, paginate.limit, payload, signal) : payload;
    }

    const text = await response.text().catch(() => "");
    signal.throwIfAborted();
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    errors.push(`${url} returned ${response.status} ${response.statusText}${detail}`);
    if (response.status !== 404 && response.status !== 405) break;
  }

  throw new Error(errors.join(" | "));
}

function parseRemoteModels(payload: { data?: unknown[]; models?: unknown[] }): RemoteModel[] {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = list
    .map((entry) => {
      if (typeof entry === "string") {
        const id = entry.trim();
        return id ? ({ id } as RemoteModel) : null;
      }
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const id =
        typeof e.id === "string" && e.id.trim()
          ? e.id.trim()
          : typeof e.name === "string" && e.name.trim()
            ? e.name.trim()
            : typeof e.model === "string" && e.model.trim()
              ? e.model.trim()
              : typeof e.model_id === "string" && e.model_id.trim()
                ? e.model_id.trim()
                : null;
      if (!id) return null;
      const created = typeof e.created === "number" ? e.created : undefined;
      return { id, created } as RemoteModel;
    })
    .filter((m): m is RemoteModel => Boolean(m));
  models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  return models;
}

type ProbeResult = { ok: true; latencyMs: number; httpStatus: number; modelsCount?: number };

/** Reachability only; per-model validation below still requires a 2xx. */
async function probeAnthropicMessages(params: RemoteModelParams, start: number): Promise<ProbeResult> {
  const apiKey = modelApiKey(params);
  const headers = modelRequestHeaders(params, apiKey, {
    "User-Agent": "reina/0.1.0",
    "content-type": "application/json",
  });
  const response = await fetchModelOperation(params, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "." }], max_tokens: 1 }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if ([401, 403, 404, 405].includes(response.status)) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${extractRemoteErrorDetail(text)}`);
  }
  await response.body?.cancel().catch(() => {});
  return { ok: true, latencyMs: Math.round(performance.now() - start), httpStatus: response.status };
}

export async function probeRemoteConnection(params: RemoteModelParams): Promise<ProbeResult> {
  const start = performance.now();
  switch (params.provider) {
    case "anthropic-messages":
      return probeAnthropicMessages(params, start);
    case "openai-responses":
    case "openai-chat": {
      // OpenAI-compat endpoints reliably expose GET /v1/models, so reuse the
      // existing model-list discovery as the probe — also gives the user a
      // useful "returned N models" signal in the success message.
      const result = await fetchRemoteModels(params);
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - start),
        httpStatus: 200,
        modelsCount: result.models.length,
      };
    }
    case "deterministic":
      throw new Error("The deterministic provider has no remote endpoint to probe.");
    default:
      throw new Error(`Provider ${params.provider} does not support connection probing.`);
  }
}

/** Pull the human-readable message out of a provider error body (OpenAI-style
 * `{error:{message}}`, Anthropic-style `{error:{message}}`, or flat
 * `{message}`); fall back to a snippet of the raw text. */
function extractRemoteErrorDetail(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === "string" && msg.trim()) return `: ${msg.trim().slice(0, 300)}`;
  } catch {
    // Not JSON — fall through to the raw snippet.
  }
  return `: ${text.slice(0, 200)}`;
}

/** Cap on each probe request. A hung endpoint (accepted socket, no response)
 * would otherwise pend forever — the renderer's Test button has no cancel. */
const PROBE_TIMEOUT_MS = 30_000;

/** Probe whether ONE specific model actually answers, by sending it a real
 * minimal completion request. Unlike {@link probeRemoteConnection} (endpoint +
 * key reachability), any non-2xx here — unknown model, no quota, needs
 * verification — is a failure surfaced with the provider's error message. */
export async function probeModel(params: RemoteModelParams & { model: string }): Promise<ProbeResult> {
  const start = performance.now();
  const apiKey = modelApiKey(params);
  const model = params.model?.trim();
  if (!model) throw new Error("Model id required.");
  const headers = modelRequestHeaders(params, apiKey, {
    "User-Agent": "reina/0.1.0",
    "content-type": "application/json",
  });
  let body: Record<string, unknown>;
  switch (params.provider) {
    case "anthropic-messages": {
      const plan = resolveAnthropicThinking({ ...params, provider: "anthropic-messages", model });
      const thinking = plan?.thinking ?? (params.reasoningEffort === "off" ? { type: "disabled" as const } : undefined);
      body = {
        model,
        messages: [{ role: "user", content: "." }],
        max_tokens: thinking?.type === "enabled" ? thinking.budget_tokens + 1024 : 1,
        ...(thinking ? { thinking } : {}),
        ...(plan?.outputConfig ? { output_config: plan.outputConfig } : {}),
      };
      break;
    }
    case "openai-responses": {
      const reasoning = resolveOpenAIReasoningEffort({ ...params, provider: "openai-responses", model });
      body = { model, input: ".", max_output_tokens: 16, ...(reasoning ? { reasoning: { effort: reasoning } } : {}) };
      break;
    }
    case "openai-chat":
      body = {
        model,
        messages: [{ role: "user", content: "." }],
        max_tokens: 1,
        stream: true,
        ...resolveChatReasoning({ ...params, provider: "openai-chat", model }).fields,
      };
      break;
    default:
      throw new Error(`Provider ${params.provider} does not support model probing.`);
  }
  const response = await fetchModelOperation(params, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${extractRemoteErrorDetail(await response.text().catch(() => ""))}`);
  }
  await validateModelProbeResponse(response, params.provider);
  return { ok: true, latencyMs: Math.round(performance.now() - start), httpStatus: response.status };
}

export async function fetchRemoteModels(params: RemoteModelParams): Promise<{ models: RemoteModel[] }> {
  const provider = params.provider;
  const apiKey = params.apiKey?.trim() ?? "";
  const headers = modelRequestHeaders(params, apiKey, { "User-Agent": "reina/0.1.0" });
  let urls: string[];

  switch (provider) {
    case "anthropic-messages": {
      urls = modelOperationUrls(params, "models");
      break;
    }
    case "openai-responses":
    case "openai-chat": {
      urls = modelOperationUrls(params, "models");
      break;
    }
    case "deterministic":
      throw new Error("The deterministic provider has no remote model list.");
    default:
      throw new Error(`Provider ${provider} does not support remote model discovery.`);
  }

  // Only Anthropic's endpoint paginates; the `limit` cap + cursor walk would
  // be ignored (or rejected by strict proxies) on OpenAI-compat `/v1/models`,
  // which returns the full list in one response.
  const paginate = provider === "anthropic-messages" ? { limit: 1000 } : undefined;
  // One budget covers the first URL, any version fallback, and every page.
  const payload = await fetchModelListPayload(urls, headers, AbortSignal.timeout(PROBE_TIMEOUT_MS), paginate);
  return { models: parseRemoteModels(payload) };
}
