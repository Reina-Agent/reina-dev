import { Stream } from "openai/core/streaming";

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : undefined;
}

function rejectProviderFailure(payload: Payload): void {
  const response = record(payload.response);
  const rawError = response?.error ?? payload.error;
  const status = response?.status ?? payload.status;
  if (
    !rawError &&
    status !== "failed" &&
    status !== "cancelled" &&
    payload.type !== "response.failed" &&
    payload.type !== "response.error" &&
    payload.type !== "error"
  )
    return;
  const detail = record(rawError)?.message ?? rawError ?? payload.message ?? payload.code ?? status ?? payload.type;
  throw new Error(`Model rejected the probe: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function validJsonReply(provider: string, payload: Payload): boolean {
  if (provider === "openai-responses") {
    return (payload.status === "completed" || payload.status === "incomplete") && Array.isArray(payload.output);
  }
  if (provider === "anthropic-messages") {
    return (
      payload.type === "message" &&
      payload.role === "assistant" &&
      Array.isArray(payload.content) &&
      typeof payload.stop_reason === "string"
    );
  }
  if (provider === "openai-chat" && Array.isArray(payload.choices)) {
    return payload.choices.some((value) => {
      const choice = record(value);
      const message = record(choice?.message);
      return (
        message &&
        (typeof choice?.finish_reason === "string" ||
          typeof message.content === "string" ||
          Array.isArray(message.tool_calls))
      );
    });
  }
  return false;
}

/** A 2xx only proves HTTP success. Some gateways still return an API failure,
 * or force SSE even when the minimal probe requested a non-stream response. */
export async function validateModelProbeResponse(response: Response, provider: string): Promise<void> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    let payload: Payload | undefined;
    try {
      payload = record(await response.json());
    } catch {
      throw new Error("Model returned an invalid JSON response to the probe.");
    }
    if (!payload) throw new Error("Model returned an invalid response to the probe.");
    rejectProviderFailure(payload);
    if (!validJsonReply(provider, payload)) throw new Error("Model did not return a completed response to the probe.");
    return;
  }

  const controller = new AbortController();
  const stream = Stream.fromSSEResponse<Payload>(response, controller);
  let anthropicStarted = false;
  try {
    for await (const payload of stream) {
      rejectProviderFailure(payload);
      if (
        provider === "openai-responses" &&
        (payload.type === "response.completed" || payload.type === "response.incomplete") &&
        record(payload.response)
      )
        return;
      if (provider === "anthropic-messages") {
        if (payload.type === "message_start" && record(payload.message)) anthropicStarted = true;
        if (payload.type === "message_stop" && anthropicStarted) return;
      }
      if (
        provider === "openai-chat" &&
        Array.isArray(payload.choices) &&
        payload.choices.some((choice) => Boolean(record(choice)?.finish_reason))
      )
        return;
    }
    throw new Error("Model probe stream closed before a terminal event.");
  } finally {
    controller.abort();
    await response.body?.cancel().catch(() => {});
  }
}
