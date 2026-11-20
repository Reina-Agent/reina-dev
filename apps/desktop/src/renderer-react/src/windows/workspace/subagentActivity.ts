export type ActivityKind = "tool" | "text" | "reasoning" | "warning" | "message" | "wait" | "system";

export interface ActivityEntry {
  kind: ActivityKind;
  eventType: string;
  key?: string;
  name?: string;
  input?: unknown;
  command?: string;
  status?: string;
  output?: string;
  message?: string;
  text?: string;
  messageId?: string;
  sender?: "user" | "supervisor";
  elapsedMs?: number;
  totalLines?: number;
  totalBytes?: number;
  payload?: Record<string, unknown>;
  ts: string;
  updatedAt: string;
}

export interface ActivitySourceRecord {
  event: { type?: string; [key: string]: unknown };
  timestamp: string;
  /** True when the exact payload is also appended to the task's JSONL. */
  persisted?: boolean;
}

const INCIDENTAL_ACTIVITY_LIMIT = 200;
const STREAM_TEXT_LIMIT = 24_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactStreamText(value: unknown, max = STREAM_TEXT_LIMIT): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const marker = "\n…\n";
  const head = Math.ceil((max - marker.length) / 2);
  const tail = max - marker.length - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function uniqueEntryKey(next: ActivityEntry[], record: ActivityEntry): string {
  const base = `${record.eventType}-${record.ts}`;
  if (!next.some((entry) => entry.key === base)) return base;
  let suffix = 2;
  while (next.some((entry) => entry.key === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function appendCapped(next: ActivityEntry[], record: ActivityEntry): ActivityEntry[] {
  next.push(record.key ? record : { ...record, key: uniqueEntryKey(next, record) });
  // Chat history must survive a tool-heavy turn. Bound diagnostic activity,
  // while retaining messages, replies and the boundaries between their turns.
  const isConversation = (entry: ActivityEntry) =>
    entry.kind === "message" || entry.kind === "text" || entry.eventType === "task-turn-started";
  let excess = next.filter((entry) => !isConversation(entry)).length - INCIDENTAL_ACTIVITY_LIMIT;
  for (let index = 0; excess > 0 && index < next.length; ) {
    if (isConversation(next[index]!)) index += 1;
    else {
      next.splice(index, 1);
      excess -= 1;
    }
  }
  return next;
}

function upsertCapped(next: ActivityEntry[], record: ActivityEntry): ActivityEntry[] {
  if (record.key) {
    const index = next.findIndex((entry) => entry.key === record.key);
    if (index !== -1) next.splice(index, 1);
  }
  return appendCapped(next, record);
}

function isPendingWait(entry: ActivityEntry): boolean {
  return entry.kind === "wait" && (entry.status === "pending" || entry.status === "pending_approval");
}

function settlePendingWaitsInPlace(
  next: ActivityEntry[],
  timestamp: string,
  outcome: "resolved" | "interrupted" = "resolved",
): boolean {
  let changed = false;
  for (let index = 0; index < next.length; index += 1) {
    const entry = next[index]!;
    if (!isPendingWait(entry)) continue;
    changed = true;
    next[index] = {
      ...entry,
      status: outcome,
      text:
        outcome === "interrupted"
          ? "Worker interrupted before a response"
          : entry.eventType === "question-request"
            ? "Answer received"
            : "Decision received",
      updatedAt: timestamp,
    };
  }
  return changed;
}

/** Close stale question/approval rows when task lifecycle proves the worker is
 * no longer blocked. This is also used when a task settles without emitting a
 * final child-stream event after the user's decision. */
export function settlePendingActivityWaits(
  buffer: ActivityEntry[],
  timestamp: string,
  outcome: "resolved" | "interrupted" = "resolved",
): ActivityEntry[] | null {
  const next = buffer.slice();
  return settlePendingWaitsInPlace(next, timestamp, outcome) ? next : null;
}

function sourceSignature(record: ActivitySourceRecord): string {
  try {
    return JSON.stringify(record.event);
  } catch {
    return `${record.event.type ?? "unknown"}:${String(record.event.id ?? "")}`;
  }
}

/** Merge the durable prefix with events observed live while disk hydration was
 * pending. The JSONL is an ordered prefix of live child events, so matching its
 * longest suffix against the live prefix avoids collapsing legitimate repeated
 * deltas. Parent-only lifecycle/HITL records are then placed by timestamp. */
export function mergeSubagentActivityRecords(
  disk: ActivitySourceRecord[],
  live: ActivitySourceRecord[],
): ActivitySourceRecord[] {
  const durableLive = live.filter((record) => record.persisted !== false);
  const maxOverlap = Math.min(disk.length, durableLive.length);
  const diskSignatures = disk.slice(-maxOverlap).map(sourceSignature);
  const liveSignatures = durableLive.slice(0, maxOverlap).map(sourceSignature);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (diskSignatures[diskSignatures.length - size + index] !== liveSignatures[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = size;
      break;
    }
  }

  return [...disk, ...durableLive.slice(overlap), ...live.filter((record) => record.persisted === false)]
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.record.timestamp);
      const rightAt = Date.parse(right.record.timestamp);
      if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt) || leftAt === rightAt) return left.index - right.index;
      return leftAt - rightAt;
    })
    .map(({ record }) => record);
}

export function foldSubagentActivityRecords(records: ActivitySourceRecord[]): ActivityEntry[] {
  let buffer: ActivityEntry[] = [];
  for (const record of records) {
    const updated = foldSubagentActivityEvent(buffer, record.event, record.timestamp);
    if (updated) buffer = updated;
  }
  return buffer;
}

/** Fold one child ModelStreamEvent into the compact workspace activity model.
 * The raw protocol stays deliberately loose here because cold JSONL replay can
 * include events written by an older Reina build. */
export function foldSubagentActivityEvent(
  buffer: ActivityEntry[],
  eventValue: { type?: string; [key: string]: unknown } | null | undefined,
  timestamp: string,
): ActivityEntry[] | null {
  if (!eventValue || typeof eventValue !== "object" || !eventValue.type) return null;
  const next = buffer.slice();
  const eventType = eventValue.type;

  if (eventType === "task-message" || eventType === "task-turn-started") {
    const id = asString(eventValue.id);
    const key = id ? `${eventType}-${id}` : undefined;
    if (key && next.some((entry) => entry.key === key)) return null;
    const createdAt = asString(eventValue.createdAt) ?? timestamp;
    if (eventType === "task-turn-started") {
      settlePendingWaitsInPlace(next, createdAt, "interrupted");
      return appendCapped(next, {
        kind: "system",
        eventType,
        key,
        name: "Turn started",
        ts: createdAt,
        updatedAt: createdAt,
      });
    }
    const sender = eventValue.sender === "user" ? "user" : "supervisor";
    return appendCapped(next, {
      kind: "message",
      eventType,
      key,
      messageId: id,
      sender,
      name: sender === "user" ? "You" : "Main agent",
      text: asString(eventValue.text) ?? "",
      ts: createdAt,
      updatedAt: createdAt,
    });
  }

  if (eventType === "task-turn-completed") {
    const id = asString(eventValue.id);
    const key = id ? `task-result-${id}` : undefined;
    if (key && next.some((entry) => entry.key === key)) return null;
    const text = asString(eventValue.text) ?? "";
    if (!text.trim()) return null;
    let turnStart = next.length - 1;
    while (turnStart >= 0 && next[turnStart]?.eventType !== "task-turn-started") turnStart -= 1;
    const texts = next.slice(turnStart + 1).filter((entry) => entry.kind === "text");
    // Most providers already streamed their final answer. Structured responses
    // can arrive only at settlement, so retain those without repeating text.
    if (
      texts.at(-1)?.text?.trim() === text.trim() ||
      texts
        .map((entry) => entry.text ?? "")
        .join("")
        .trim() === text.trim()
    ) {
      return null;
    }
    const createdAt = asString(eventValue.createdAt) ?? timestamp;
    return appendCapped(next, {
      kind: "text",
      eventType,
      key,
      text,
      ts: createdAt,
      updatedAt: createdAt,
    });
  }

  if (
    eventType === "tool-progress" ||
    eventType === "text-delta" ||
    eventType === "reasoning-delta" ||
    eventType === "user-message" ||
    eventType === "loop-limit" ||
    eventType === "loop-repair" ||
    eventType === "background-error" ||
    eventType === "context-compaction-failed" ||
    eventType === "context-compaction-started" ||
    eventType === "context-compacted" ||
    eventType === "stream-reset"
  ) {
    settlePendingWaitsInPlace(next, timestamp);
  }

  if (eventType === "tool-input-delta") {
    const id = asString(eventValue.id);
    if (!id) return null;
    const index = next.findIndex((entry) => entry.key === `tool-${id}`);
    if (index === -1) return null;
    next[index] = {
      ...next[index],
      input: eventValue.input ?? next[index]?.input,
      updatedAt: timestamp,
    };
    return next;
  }

  if (eventType === "tool-progress") {
    const id = asString(eventValue.id);
    const name = asString(eventValue.name) ?? "tool";
    const key = `tool-${id ?? name}`;
    const index = next.findIndex((entry) => entry.key === key);
    if (index !== -1) {
      const existing = next[index]!;
      next[index] = {
        ...existing,
        name,
        input: eventValue.input ?? existing.input,
        command: asString(eventValue.command) ?? existing.command,
        status: asString(eventValue.status) ?? existing.status,
        output: asString(eventValue.output) ?? existing.output,
        message: asString(eventValue.message) ?? existing.message,
        elapsedMs: asNumber(eventValue.elapsedMs) ?? existing.elapsedMs,
        totalLines: asNumber(eventValue.totalLines) ?? existing.totalLines,
        totalBytes: asNumber(eventValue.totalBytes) ?? existing.totalBytes,
        updatedAt: timestamp,
      };
      return next;
    }
    return appendCapped(next, {
      kind: "tool",
      eventType,
      key,
      name,
      input: eventValue.input,
      command: asString(eventValue.command),
      status: asString(eventValue.status),
      output: asString(eventValue.output),
      message: asString(eventValue.message),
      elapsedMs: asNumber(eventValue.elapsedMs),
      totalLines: asNumber(eventValue.totalLines),
      totalBytes: asNumber(eventValue.totalBytes),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "text-delta" || eventType === "reasoning-delta") {
    const kind = eventType === "text-delta" ? "text" : "reasoning";
    const delta = asString(eventValue.text) ?? "";
    const tail = next.at(-1);
    if (tail?.kind === kind) {
      next[next.length - 1] = {
        ...tail,
        text: compactStreamText(`${tail.text ?? ""}${delta}`),
        updatedAt: timestamp,
      };
      return next;
    }
    return appendCapped(next, {
      kind,
      eventType,
      text: compactStreamText(delta),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "user-message") {
    return upsertCapped(next, {
      kind: "message",
      eventType,
      sender: "supervisor",
      name: "Supervisor update",
      text: asString(eventValue.text) ?? "",
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "question-request") {
    const question = asRecord(eventValue.question);
    return upsertCapped(next, {
      kind: "wait",
      eventType,
      key: `question-${asString(question?.id) ?? timestamp}`,
      name: asString(question?.header) ?? "Question",
      status: asString(question?.status) ?? "pending",
      text: asString(question?.question) ?? "Waiting for an answer",
      payload: question,
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "permission-request") {
    const toolCall = asRecord(eventValue.toolCall);
    const toolName = asString(toolCall?.name);
    return upsertCapped(next, {
      kind: "wait",
      eventType,
      key: `approval-${asString(toolCall?.id) ?? timestamp}`,
      name: toolName ? `Approval · ${toolName}` : "Approval",
      status: asString(toolCall?.status) ?? "pending_approval",
      text: asString(toolCall?.summary) ?? "Waiting for tool approval",
      input: toolCall?.input,
      payload: toolCall,
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "loop-limit" || eventType === "loop-repair") {
    return appendCapped(next, {
      kind: "warning",
      eventType,
      name: eventType === "loop-limit" ? "Loop stopped" : "Loop repaired",
      text: asString(eventValue.message) ?? asString(eventValue.reason) ?? "",
      payload: asRecord(eventValue),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "async-task-warning") {
    const idleMs = asNumber(eventValue.idleMs);
    const reason = asString(eventValue.reason);
    return appendCapped(next, {
      kind: "warning",
      eventType,
      name: "Worker idle warning",
      text:
        idleMs === undefined
          ? (reason ?? "The worker may be stalled.")
          : `${reason ?? "idle"} · no activity for ${Math.max(1, Math.round(idleMs / 1_000))}s`,
      payload: asRecord(eventValue),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "background-error" || eventType === "context-compaction-failed") {
    return appendCapped(next, {
      kind: "warning",
      eventType,
      name:
        eventType === "context-compaction-failed"
          ? "Context compaction failed"
          : (asString(eventValue.category) ?? "Background error"),
      text: asString(eventValue.error) ?? asString(eventValue.message) ?? "",
      payload: asRecord(eventValue),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "usage-updated") {
    return upsertCapped(next, {
      kind: "system",
      eventType,
      key: "usage-latest",
      name: "Usage updated",
      payload: asRecord(eventValue.usage),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "context-compaction-started") {
    return appendCapped(next, {
      kind: "system",
      eventType,
      name: "Context compaction",
      status: "running",
      text: asString(eventValue.reason) ?? "Compacting context",
      payload: asRecord(eventValue),
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "context-compacted") {
    const boundary = asRecord(eventValue.boundary);
    const compacted = asNumber(boundary?.messagesCompacted);
    return appendCapped(next, {
      kind: "system",
      eventType,
      name: "Context compacted",
      status: "completed",
      text: compacted === undefined ? undefined : `${compacted} messages compacted`,
      payload: boundary,
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  if (eventType === "stream-reset") {
    while (next.at(-1)?.kind === "text" || next.at(-1)?.kind === "reasoning") next.pop();
    return appendCapped(next, {
      kind: "system",
      eventType,
      name: "Stream retry",
      text: "Partial output was discarded and the request was retried.",
      ts: timestamp,
      updatedAt: timestamp,
    });
  }

  return null;
}
