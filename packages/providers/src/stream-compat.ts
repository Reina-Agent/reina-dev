import OpenAI from "openai";

/** A provider explicitly rejected the turn; this is not a transport drop. */
export class ProviderStreamError extends OpenAI.APIError {
  constructor(body: Record<string, unknown>, headers?: Headers) {
    const status = streamErrorStatus(body);
    super(status, body, undefined, headers);
    this.name = "ProviderStreamError";
  }
}

function streamErrorStatus(body: Record<string, unknown>): number | undefined {
  for (const status of [body.status_code, body.status]) {
    if (typeof status === "number" && status >= 400 && status <= 599) return status;
  }
  const kind = `${body.code ?? ""} ${body.type ?? ""}`;
  if (/invalid_api_key|authentication_error|unauthorized/.test(kind)) return 401;
  if (/permission_error|permission_denied|forbidden/.test(kind)) return 403;
  if (/model_not_found|not_found_error/.test(kind)) return 404;
  if (/rate_limit|usage_limit|insufficient_quota/.test(kind)) return 429;
  if (/invalid_request|bad_request|context_length|context_too_large/.test(kind)) return 400;
  if (/server_error|internal_error|overloaded|service_unavailable/.test(kind)) return 503;
  return undefined;
}

export function responsesStreamError(event: unknown): ProviderStreamError | undefined {
  if (!event || typeof event !== "object") return undefined;
  const payload = event as Record<string, unknown>;
  const response = payload.response as Record<string, unknown> | undefined;
  const raw = response?.error ?? payload.error;
  if (!raw && payload.type !== "response.failed" && payload.type !== "response.error" && payload.type !== "error") {
    return undefined;
  }
  const body = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : { ...payload };
  if (typeof raw === "string") body.message = raw;
  if (body.message === undefined) body.message = body.code ?? "Provider stream failed without error details";
  if (body.status_code === undefined && payload.status_code !== undefined) body.status_code = payload.status_code;
  if (body.status === undefined && payload.status !== undefined) body.status = payload.status;
  return new ProviderStreamError(body);
}

/** The SDK throws named SSE errors before yielding them; retain their body. */
export function normalizeStreamAPIError(error: unknown): unknown {
  if (error instanceof ProviderStreamError) return error;
  if (error instanceof OpenAI.APIError && error.status === undefined && error.error) {
    return new ProviderStreamError(error.error as Record<string, unknown>, error.headers);
  }
  return error;
}

type ToolDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type ChatToolCall = { index: number; id?: string; name?: string; arguments: string };

/** Keep wire indexes and stable IDs separate from the UI's accumulator index. */
export class ChatToolCallAccumulator {
  private readonly calls: ChatToolCall[] = [];
  private readonly byIndex = new Map<number, ChatToolCall>();
  private readonly byId = new Map<string, ChatToolCall>();

  clear(): void {
    this.calls.length = 0;
    this.byIndex.clear();
    this.byId.clear();
  }

  append(delta: ToolDelta, batchSize: number): ChatToolCall {
    const id = delta.id || undefined;
    const indexed = delta.index !== undefined;
    if (indexed && (!Number.isInteger(delta.index) || delta.index! < 0)) this.fail();
    const byIndex = indexed ? this.byIndex.get(delta.index!) : undefined;
    const byId = id ? this.byId.get(id) : undefined;
    if (byIndex && byId && byIndex !== byId) this.fail();
    let call = byIndex ?? byId;
    if (!call && !indexed) {
      const unbound = this.calls.filter((candidate) => !candidate.id);
      if (id && unbound.length > 0) {
        if (this.calls.length !== 1 || batchSize !== 1) this.fail();
        call = unbound[0];
      } else if (!id) {
        if (this.calls.length > 1 || batchSize !== 1) this.fail();
        call = this.calls[0];
      }
    }
    if (!call) {
      call = { index: this.calls.length, arguments: "" };
      this.calls.push(call);
    }
    if (id && call.id && call.id !== id) this.fail();
    if (delta.function?.name && call.name && call.name !== delta.function.name) this.fail();
    if (indexed) {
      // A stable ID may acquire its first explicit index, but cannot change it.
      for (const [index, candidate] of this.byIndex) {
        if (candidate === call && index !== delta.index) this.fail();
      }
      this.byIndex.set(delta.index!, call);
    }
    if (id) {
      call.id = id;
      this.byId.set(id, call);
    }
    if (delta.function?.name) call.name = delta.function.name;
    if (delta.function?.arguments) call.arguments += delta.function.arguments;
    return call;
  }

  complete(): Array<ChatToolCall & { id: string; name: string }> {
    if (this.calls.some((call) => !call.id || !call.name)) this.fail();
    return this.calls as Array<ChatToolCall & { id: string; name: string }>;
  }

  private fail(): never {
    throw new ProviderStreamError({
      status: 400,
      code: "ambiguous_tool_call",
      type: "invalid_response_error",
      message:
        "Provider returned ambiguous or incomplete tool-call identities; this response's tools were not accepted.",
    });
  }
}
