import type { SessionState, ToolCallRecord, TraceEvent } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

export function pushTrace(session: SessionState, type: TraceEvent["type"], data: Record<string, unknown>): void {
  session.trace.push({
    id: createId("evt"),
    type,
    createdAt: nowIso(),
    data: redact(data),
  });
}

export function toolTraceData(record: ToolCallRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    summary: record.summary,
    permission: record.permission,
    status: record.status,
    input: record.input,
    preview: record.preview,
    output: record.output,
    error: record.error,
  };
}

function redact(value: unknown): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/key|token|secret|password|credential/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactValue(nested);
    }
  }
  return out;
}
