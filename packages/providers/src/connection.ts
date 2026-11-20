import { sanitizeModelHeaders, type ModelConfig } from "@reina/protocol";

export type ModelConnection = Pick<ModelConfig, "baseUrl" | "authMode" | "headers"> & { provider: string };

/** SDKs require a credential option even when the user supplies the complete
 * auth header. The placeholder is always replaced by that validated header. */
export function modelApiKey(config: ModelConnection & Pick<ModelConfig, "apiKey">): string {
  if (config.apiKey?.trim()) return config.apiKey.trim();
  const headers = new Headers(sanitizeModelHeaders(config.headers));
  const keyHeader =
    config.provider === "anthropic-messages" && config.authMode !== "bearer" && config.authMode !== "oauth"
      ? "x-api-key"
      : "authorization";
  const header = headers.get(keyHeader)?.trim();
  if (header) return keyHeader === "x-api-key" ? header : "custom-header-auth";
  throw new Error(
    "API key is missing for this model. Open Settings → Models and fill in the API key field or its authentication header.",
  );
}

function providerEndpoint(provider: string): { base: string; operation: string } {
  switch (provider) {
    case "openai-chat":
      return { base: "https://api.openai.com/v1", operation: "/chat/completions" };
    case "openai-responses":
      return { base: "https://api.openai.com/v1", operation: "/responses" };
    case "openai-codex-responses":
      return { base: "https://chatgpt.com/backend-api/codex", operation: "/responses" };
    case "anthropic-messages":
      return { base: "https://api.anthropic.com", operation: "/messages" };
    default:
      throw new Error(`Provider ${provider} has no remote model endpoint.`);
  }
}

/** The probe and the SDK transport must try exactly the same URL shapes.
 * A complete operation URL (or the legacy trailing # marker) is explicit:
 * never add a version to it. Otherwise retain versionless gateways as a
 * bounded 404/405 fallback, without changing the configured origin. */
export function modelOperationUrls(config: ModelConnection, operation?: "models"): string[] {
  const endpoint = providerEndpoint(config.provider);
  const raw = config.baseUrl?.trim() || endpoint.base;
  const exactBase = raw.endsWith("#");
  const url = new URL(exactBase ? raw.slice(0, -1) : raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Model endpoint must be an HTTP(S) URL without embedded credentials.");
  }
  url.hash = "";
  let basePath = url.pathname.replace(/\/+$/, "");
  const suffix = ["/chat/completions", "/responses", "/completions", "/embeddings", "/messages", "/models"].find(
    (value) => basePath.toLowerCase().endsWith(value),
  );
  if (suffix) basePath = basePath.slice(0, -suffix.length);
  const versioned = /\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(basePath);
  let normalized = basePath;
  if (!suffix && !exactBase && !versioned && config.provider !== "openai-codex-responses") {
    const volces = url.hostname === "volces.com" || url.hostname.endsWith(".volces.com");
    if (volces && !basePath) normalized = "/api/v3";
    else if (volces && /^\/api(?:\/coding)?$/i.test(basePath)) normalized = `${basePath}/v3`;
    else normalized = `${basePath}/v1`;
  }
  const paths = [...new Set([normalized, basePath])];
  return paths.map((base) => {
    const candidate = new URL(url);
    candidate.pathname = `${base}${operation === "models" ? "/models" : endpoint.operation}`;
    return candidate.toString();
  });
}

/** The transport below resolves the final endpoint, including gateways whose
 * Anthropic endpoint has no /v1. Keep the SDK base query-free so it can safely
 * construct its own path; configured query parameters live on the final URL. */
export function providerSdkBaseUrl(config: ModelConnection): string {
  const url = new URL(modelOperationUrls(config)[0]!);
  const { operation } = providerEndpoint(config.provider);
  url.pathname = url.pathname.slice(0, -operation.length);
  if (config.provider === "anthropic-messages") url.pathname = url.pathname.replace(/\/v1$/i, "");
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function modelRequestHeaders(
  config: ModelConnection,
  apiKey: string,
  defaults: Record<string, string> = {},
): Record<string, string> {
  const headers = new Headers(defaults);
  if (config.provider === "anthropic-messages") {
    headers.set("anthropic-version", "2023-06-01");
    if (config.authMode === "bearer" || config.authMode === "oauth") {
      headers.delete("x-api-key");
      if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    } else {
      headers.delete("authorization");
      if (apiKey) headers.set("x-api-key", apiKey);
    }
  } else if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  for (const [name, value] of Object.entries(sanitizeModelHeaders(config.headers) ?? {})) headers.set(name, value);
  return Object.fromEntries(headers.entries());
}

/** Retry only an explicit unsupported-parameter rejection, not e.g. a token
 * limit/range error that happens to mention max_tokens. Preserve the entire
 * original payload (tools, reasoning and history included). */
function alternateChatTokenBody(body: string, error: string): string | undefined {
  if (!/unsupported|not supported|not allowed|unknown|unrecognized|unexpected/i.test(error)) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const from = Object.hasOwn(payload, "max_tokens") ? "max_tokens" : "max_completion_tokens";
  const to = from === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  if (!Object.hasOwn(payload, from) || Object.hasOwn(payload, to) || !error.includes(from)) return undefined;
  payload[to] = payload[from];
  delete payload[from];
  return JSON.stringify(payload);
}

export async function fetchModelOperation(
  config: ModelConnection,
  init: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
  query?: URLSearchParams,
): Promise<Response> {
  const urls = modelOperationUrls(config);
  let body = init.body;
  let tokenRetried = false;
  for (let index = 0; index < urls.length; index++) {
    const url = new URL(urls[index]!);
    for (const [name, value] of query ?? []) url.searchParams.set(name, value);
    let response = await fetchImpl(url, { ...init, body });
    if (config.provider === "openai-chat" && response.status === 400 && typeof body === "string" && !tokenRetried) {
      const replacement = alternateChatTokenBody(body, await response.clone().text());
      if (replacement !== undefined) {
        tokenRetried = true;
        body = replacement;
        await response.body?.cancel().catch(() => {});
        response = await fetchImpl(url, { ...init, body });
      }
    }
    if ((response.status !== 404 && response.status !== 405) || index === urls.length - 1) return response;
    await response.body?.cancel().catch(() => {});
  }
  throw new Error("No model endpoint configured.");
}

/** Adapt the SDK's JSON model POST to the same transport used by probes.
 * All SDK headers, abort/timeout signals and request options are retained. */
export function createProviderFetch(config: ModelConnection, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return fetchImpl(input, init);
    const body = typeof init?.body === "string" ? init.body : await request.clone().text();
    return fetchModelOperation(
      config,
      { ...init, method: request.method, headers: request.headers, body, signal: request.signal },
      fetchImpl,
      new URL(request.url).searchParams,
    );
  };
}
