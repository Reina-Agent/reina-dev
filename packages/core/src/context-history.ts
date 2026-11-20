import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChatMessage, ContextCompactionRecord, ContextComposition, ContextHistory, ContextRequestDetail, ContextRequestRecord, ModelRequest, ToolCallRecord,
} from "@reina/protocol";
import { toolInputJsonSchema } from "@reina/providers";

export const CONTEXT_HISTORY_LIMIT = 100;
const EVENT_LIMIT = 200;
const MAX_ITEM_CHARS = 80_000;
const MAX_DETAIL_CHARS = 400_000;
const MAX_PENDING_WRITES = 202;
const WRITER_ID = randomUUID();

export type ContextHistoryOwner = { cwd: string; sessionId: string; taskId?: string };
type Sections = ContextRequestDetail["sections"];
type PendingWrites = { tail: Promise<void>; count: number };
// Serializes a completed child's last write with the next child's first write,
// and lets a parent read pending child history without retaining child engines.
const pendingWrites = new Map<string, PendingWrites>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function contextMessageCategory(message: ChatMessage): keyof ContextComposition {
  if (message.toolResult || (message.ephemeral && /^Tool .+ result:\n/.test(message.content))) return "toolResults";
  if (message.role === "system") return "system";
  if (message.ephemeral || message.origin || message.contextState) return "injected";
  return message.role === "assistant" ? "assistant" : "user";
}

/** Joined text tokenization has small boundary differences. Apportion its
 * measured total by independent item weights so every category reconciles. */
export function apportionContextTokens(weights: readonly number[], total: number): number[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightTotal) return weights.map((_, index) => index === 0 ? total : 0);
  let remaining = total;
  let cumulative = 0;
  return weights.map((weight, index) => {
    cumulative += weight;
    const tokens = index === weights.length - 1 ? remaining : Math.min(remaining, Math.round(total * cumulative / weightTotal) - (total - remaining));
    remaining -= tokens;
    return tokens;
  });
}

export function contextHistoryDirectory(owner: ContextHistoryOwner): string {
  return path.join(owner.cwd, ".reina", "context-history", digest(owner.sessionId), owner.taskId ? digest(owner.taskId) : "main");
}

/** Keep textual model-facing input, never transport credentials, provider state,
 * encrypted reasoning or inline media. Limits apply to the saved inspection
 * copy only; the actual request and its token estimates remain untouched. */
export function captureContextSections(
  request: ModelRequest,
  composition?: ContextComposition,
  calls: ReadonlyArray<Pick<ToolCallRecord, "id" | "input">> = [],
): Sections {
  let remaining = MAX_DETAIL_CHARS;
  const callInputs = new Map(calls.map((call) => [call.id, call.input]));
  const incompleteCategories = new Set<keyof ContextComposition>();
  type Metadata = Pick<Sections[number]["items"][number], "category" | "source" | "role" | "createdAt">;
  const item = (id: string, label: string, value: unknown, metadata: Metadata): Sections[number]["items"][number] => {
    let truncated = false;
    const boundedString = (text: string) => {
      const redacted = text.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g, "[inline media omitted]");
      if (redacted.length > MAX_ITEM_CHARS) truncated = true;
      return redacted.slice(0, MAX_ITEM_CHARS);
    };
    const serialized = typeof value === "string" ? boundedString(value) : JSON.stringify(value, (key, entry: unknown) => {
      if (/^(?:apiKey|api_key|authorization|providerState|dataBase64|encryptedContent|encrypted_content|signature)$/i.test(key)) {
        return "[omitted]";
      }
      return typeof entry === "string" ? boundedString(entry) : entry;
    }, 2) ?? "";
    const limit = Math.min(MAX_ITEM_CHARS, remaining);
    truncated ||= serialized.length > limit;
    const content = serialized.slice(0, limit);
    remaining -= content.length;
    if (truncated && metadata.category) incompleteCategories.add(metadata.category);
    return { id, label, content, ...metadata, ...(truncated ? { truncated: true } : {}) };
  };
  const section = (id: string, label: string, values: Array<{ id: string; label: string; value: unknown } & Metadata>): Sections[number] => {
    const items: Sections[number]["items"] = [];
    for (const [index, value] of values.entries()) {
      if (remaining <= 0) {
        for (const omitted of values.slice(index)) if (omitted.category) incompleteCategories.add(omitted.category);
        items.push({ id: `${id}-omitted`, label: "Remaining items", content: "Inspection size limit reached.", category: value.category, truncated: true });
        break;
      }
      items.push(item(value.id, value.label, value.value, { category: value.category, source: value.source, role: value.role, createdAt: value.createdAt }));
    }
    return { id, label, items };
  };
  const sections = [
    section("system", "System prompt", [{ id: "system", label: "System prompt", value: request.systemPrompt, category: "system", source: "system-prompt" }]),
    section("messages", "Messages", request.messages.map((message, index) => ({
      id: message.id || `message-${index}`, label: `${index + 1}. ${message.role}`,
      category: contextMessageCategory(message), source: message.toolResult?.name ?? message.origin ?? (message.contextState ? "context-state" : message.ephemeral ? "engine" : message.role),
      role: message.role, createdAt: message.createdAt,
      value: {
        role: message.role, content: message.content, reasoning: message.reasoning,
        reasoningTrace: message.reasoningTrace, attachments: message.attachments, toolResult: message.toolResult,
      },
    }))),
    section("reminders", "System reminders", (request.systemReminders ?? []).map((value, index) => ({
      id: `reminder-${index}`, label: `Reminder ${index + 1}`, value, category: "injected", source: "system-reminder",
    }))),
    section("tools", "Tool definitions", request.tools.map((tool) => ({
      id: tool.name, label: tool.name, category: "tools", source: tool.name,
      value: { name: tool.name, description: tool.description, inputSchema: toolInputJsonSchema(tool) },
    }))),
    section("observations", "Tool results", request.observations.map((observation, index) => ({
      id: observation.callId || `observation-${index}`, label: observation.name,
      value: callInputs.has(observation.callId) ? { input: callInputs.get(observation.callId), ...observation } : observation,
      category: "toolResults", source: observation.name,
    }))),
  ];
  if (composition) {
    const items = sections.flatMap((entry) => entry.items);
    for (const category of Object.keys(composition) as Array<keyof ContextComposition>) {
      const matching = items.filter((entry) => entry.category === category);
      // These are allocations of an already measured category budget, not
      // tokens from re-encoding the JSON inspection wrapper. Do not assign a
      // full category's tokens to surviving excerpts when any part was cut.
      if (incompleteCategories.has(category)) continue;
      const tokens = apportionContextTokens(matching.map((entry) => entry.content.length), composition[category]);
      matching.forEach((entry, index) => { entry.tokens = tokens[index]; });
    }
  }
  return sections;
}

export class ContextHistoryStore {
  readonly directory: string;

  constructor(owner: ContextHistoryOwner, private readonly onError: (error: unknown) => void = () => undefined) {
    this.directory = contextHistoryDirectory(owner);
  }

  recordRequest(request: ContextRequestRecord, sections?: Sections): void {
    // Snapshot now, before later engine/provider mutation. Only inspection
    // content crosses this boundary; callers never pass ModelConfig.
    this.enqueue(async () => {
      if (sections) await this.atomicWrite(this.detailPath(request.id), sections);
      const history = await this.readIndex();
      const existing = history.requests.findIndex((entry) => entry.id === request.id);
      if (existing >= 0) history.requests[existing] = request;
      else history.requests.push(request);
      const removed = history.requests.splice(0, Math.max(0, history.requests.length - CONTEXT_HISTORY_LIMIT));
      await this.atomicWrite(path.join(this.directory, "index.json"), history);
      await Promise.all(removed.map((entry) => rm(this.detailPath(entry.id), { force: true })));
    });
  }

  recordEvent(event: ContextCompactionRecord): void {
    this.enqueue(async () => {
      const history = await this.readIndex();
      const existing = history.events.findIndex((entry) => entry.id === event.id);
      if (existing >= 0) history.events[existing] = event;
      else history.events.push(event);
      history.events = history.events.slice(-EVENT_LIMIT);
      await this.atomicWrite(path.join(this.directory, "index.json"), history);
    });
  }

  async history(): Promise<ContextHistory> {
    await this.flush();
    return this.readIndex();
  }

  async flush(): Promise<void> {
    await pendingWrites.get(this.directory)?.tail;
  }

  async request(id: string): Promise<ContextRequestDetail | null> {
    const request = (await this.history()).requests.find((entry) => entry.id === id);
    if (!request) return null;
    try {
      const sections = JSON.parse(await readFile(this.detailPath(id), "utf8")) as Sections;
      return { request, sections };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readIndex(): Promise<ContextHistory> {
    try {
      const history = JSON.parse(await readFile(path.join(this.directory, "index.json"), "utf8")) as ContextHistory & { writerId?: string };
      if (!Array.isArray(history.requests) || !Array.isArray(history.events)) throw new Error("Invalid context history");
      if (history.writerId !== WRITER_ID) {
        history.requests = history.requests.map((request) => request.status === "running"
          ? { ...request, status: "cancelled", error: "The previous agent-host process ended before this request settled." }
          : request);
        history.events = history.events.map((event) => event.status === "started"
          ? { ...event, status: "failed", error: "The previous agent-host process ended during compaction." }
          : event);
      }
      return { requests: history.requests.slice(-CONTEXT_HISTORY_LIMIT), events: history.events.slice(-EVENT_LIMIT), retentionLimit: CONTEXT_HISTORY_LIMIT };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { requests: [], events: [], retentionLimit: CONTEXT_HISTORY_LIMIT };
    }
  }

  private detailPath(id: string): string {
    return path.join(this.directory, `${digest(id)}.json`);
  }

  private async atomicWrite(file: string, value: unknown): Promise<void> {
    const persisted = path.basename(file) === "index.json" ? { ...(value as ContextHistory), writerId: WRITER_ID } : value;
    await writeFile(`${file}.tmp`, JSON.stringify(persisted), "utf8");
    await rename(`${file}.tmp`, file);
  }

  private enqueue(write: () => Promise<void>): void {
    const pending = pendingWrites.get(this.directory) ?? { tail: Promise.resolve(), count: 0 };
    if (pending.count >= MAX_PENDING_WRITES) {
      this.report(new Error("Context history write queue is full; inspection record skipped"));
      return;
    }
    pending.count += 1;
    pending.tail = pending.tail.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await write();
    }).catch((error) => this.report(error)).finally(() => {
      pending.count -= 1;
      if (pending.count === 0) pendingWrites.delete(this.directory);
    });
    pendingWrites.set(this.directory, pending);
  }

  private report(error: unknown): void {
    try { this.onError(error); } catch { /* Observability must never fail the model turn. */ }
  }
}
