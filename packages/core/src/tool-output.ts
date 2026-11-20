import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, MessageAttachment, ModelConfig, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { contextWindowTokens } from "./compaction.js";

/** Minimal host surface the ToolOutputController needs from AgentEngine.
 * Mirrors the controller contracts in controllers/ (TodosHost etc.).
 *
 * Both `session` AND `pendingObservations` must be getter-backed at the
 * wiring site: loadSession/rollbackToMessage replace the engine's session
 * with a fresh object, and the engine REASSIGNS `pendingObservations` at
 * every loop reset/filter site — a captured array reference would read
 * (and materialize) a stale, orphaned round. */
export interface ToolOutputHost {
  readonly session: SessionState;
  readonly pendingObservations: ToolObservation[];
  appendMessage(item: ChatMessage): void;
  reportBackgroundError(category: string, error: unknown, context?: Record<string, unknown>): void;
}

/** Owns tool-output materialization: persisting each tool call's full output
 * to `.reina/tool_outputs/` and materializing the pending round's observations
 * into the durable transcript as `ephemeral` messages. The observations
 * themselves stay on the engine's loop state (`pendingObservations`) and tool
 * records on `session.toolCalls`; only the write paths live here. */
export class ToolOutputController {
  constructor(private readonly host: ToolOutputHost) {}

  /** Persist a tool call's full output to `.reina/tool_outputs/<callId>.txt` and
   * record the relative path on the record. Best-effort: a write failure is
   * reported but never blocks the turn (the materialized preview just falls back
   * to the truncated excerpt with no pointer). The file is the verbatim output —
   * the read_file pointer is added separately in `materializePendingToolResults`,
   * so the on-disk copy stays clean for the model (and the user) to read back. */
  async persistToolOutput(record: ToolCallRecord, text: string): Promise<void> {
    try {
      const dir = path.join(this.host.session.cwd, ".reina", "tool_outputs");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${record.id}.txt`);
      await writeFile(file, text, "utf8");
      record.outputFile = path.relative(this.host.session.cwd, file);
    } catch (error) {
      this.host.reportBackgroundError("tool_output.persist", error, { tool: record.name, callId: record.id });
    }
  }

  /** Return pending observations in the same model-facing form that will later
   * be persisted into ChatMessage.toolResult. The engine-owned observations
   * stay raw for audit/persistence; only the provider request receives copies. */
  modelObservations(): ToolObservation[] {
    if (this.host.pendingObservations.length === 0) return this.host.pendingObservations;
    const cap = toolOutputPreviewCap(this.host.session.model);
    return this.host.pendingObservations.map((observation) => {
      const record = this.host.session.toolCalls.find((call) => call.id === observation.callId);
      if (!record) return observation;
      const raw = observation.error ?? observation.output ?? "";
      if (raw.length === 0 && !observation.attachments?.length) return observation;
      const output = toolResultOutput(raw, record.outputFile, cap);
      return observation.error !== undefined
        ? { ...observation, error: output, output: undefined }
        : { ...observation, output };
    });
  }

  /** Materialize the just-sent tool-result observations into the durable
   * transcript as `ephemeral` user messages, so the model keeps seeing them on
   * later turns and compaction shrinks them like any other message.
   *
   * Called at the pending→history transition (right after a model response
   * consumes the current round natively, before `pendingObservations` is
   * cleared). The full output is already on disk via `persistToolOutput`; here
   * we persist only a capped preview + a `read_file` pointer. `ephemeral` keeps
   * these out of the VISIBLE transcript (the UI renders tool calls via the tool
   * panel) while the model still receives them in the request.
   *
   * Replaces the old per-turn `modelMessagesWithToolOutputs` weaving: tool
   * results now live in `modelMessages` ONCE, not rebuilt every request — a
   * single shrink path (compaction), no replay budget / firstAt window / dedup
   * bookkeeping, and the firstAt-reset-after-compaction footgun is gone. */
  materializePendingToolResults(): void {
    if (this.host.pendingObservations.length === 0) return;
    const cap = toolOutputPreviewCap(this.host.session.model);
    for (const observation of this.host.pendingObservations) {
      // Only tool-call observations are durable (sourced like the old weaving,
      // which read session.toolCalls). Non-tool observations — e.g. question
      // answers (name: "question") — were never replayed and stay one-shot.
      const record = this.host.session.toolCalls.find((call) => call.id === observation.callId);
      if (!record) continue;
      const item = toolResultMessage(observation.name, observation.callId, observation.error ?? observation.output ?? "", record.outputFile, cap, record.input, observation.attachments);
      if (item) this.host.appendMessage(item);
    }
  }
}

/** Per-output cap for a tool result MATERIALIZED into the durable transcript.
 * The full output was already shipped verbatim the turn the tool ran (via the
 * `observations` channel) AND persisted to disk under `.reina/tool_outputs/`,
 * so the persisted in-context copy only needs a PREVIEW — `truncateToolOutputForModel`
 * keeps a head+tail excerpt and `materializePendingToolResults` appends a
 * `read_file` pointer to the on-disk full copy. Scales mildly with the window;
 * compaction shrinks the aggregate from here, so there is no separate replay
 * budget — detail is always one `read_file` away. */
export function toolOutputPreviewCap(model: ModelConfig): number {
  const window = contextWindowTokens(model);
  if (window >= 400_000) return 16_000;
  if (window >= 128_000) return 6_000;
  if (window >= 32_000) return 4_000;
  return 4_000;
}

/** Cap a materialized tool output so the persisted preview doesn't bloat the
 * context window. The model already saw the full output the turn the tool ran
 * (shipped natively via the `observations` channel); the persisted copy keeps a
 * head+tail excerpt large enough to remember what happened. `cap` comes from
 * `toolOutputPreviewCap(model)`. */
export function truncateToolOutputForModel(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap - 200);
  const tail = text.slice(-200);
  return `${head}\n… [${text.length - cap} chars truncated] …\n${tail}`;
}

/** Exact text sent through the native tool-result channel both live and from
 * history. The human-readable wrapper remains only in ChatMessage.content. */
export function toolResultOutput(raw: string, outputFile: string | undefined, cap: number): string {
  const shown = truncateToolOutputForModel(raw, cap);
  const pointer =
    raw.length > cap && outputFile
      ? `\n[Full output saved to ${outputFile} — read_file it for the ${raw.length - cap} omitted chars.]`
      : "";
  return `${shown}${pointer}`;
}

/** Leading sentinel of every in-band tool-result message. `toolResultMessage`
 * builds contents with it, and the old-session backfill in engine.ts
 * (`backfillInbandToolResults`) detects already-materialized sessions via
 * `content.startsWith(...)` — shared as a constant so the producer and the
 * idempotence check can't drift apart. */
export const TOOL_RESULT_MESSAGE_PREFIX = "Tool ";

/** Build an `ephemeral` in-band tool-result message: a head+tail preview of the
 * output (the full copy lives on disk via `persistToolOutput`) plus a `read_file`
 * pointer when truncated. `ephemeral` keeps it out of the VISIBLE transcript (the
 * UI renders tool calls via the tool panel) while the model still receives it.
 * Returns undefined for empty output. Shared by the live materialize path and
 * the old-session backfill so both format identically. */
export function toolResultMessage(
  name: string,
  callId: string,
  raw: string,
  outputFile: string | undefined,
  cap: number,
  input?: unknown,
  attachments?: MessageAttachment[],
): ChatMessage | undefined {
  // A tool with no text output but a visual payload (read_file on an image)
  // still needs its result message so the image survives reload/replay.
  if (raw.length === 0 && !attachments?.length) return undefined;
  const output = toolResultOutput(raw, outputFile, cap);
  const item = message("user", `${TOOL_RESULT_MESSAGE_PREFIX}${name} (${callId}) result:\n${output}`);
  item.ephemeral = true;
  // Dual-write the structured pair (call + result in ONE message) so providers
  // can render native tool history; the text content above stays the fallback
  // for providers (and old sessions) without native rendering.
  item.toolResult = {
    callId,
    name,
    ...(input !== undefined ? { input } : {}),
    output,
    ...(attachments?.length ? { attachments } : {}),
  };
  return item;
}

/** Aggregate cap on inline media (image/PDF base64) carried in ONE request.
 * Per-file caps (read_file's 5 MiB image / 10 MiB PDF) bound a single read, but
 * a session that reads several files would re-ship every blob every turn and
 * blow past the provider's hard request-size ceiling (Anthropic 413
 * `request_too_large` at ~32 MB). 16 MiB of base64 leaves headroom for the
 * system prompt, text history, and tools while keeping the most recent
 * media visible. */
export const MAX_INFLIGHT_ATTACHMENT_BYTES = 16 * 1024 * 1024;

function attachmentBytes(message: ChatMessage): number {
  let total = 0;
  for (const att of message.toolResult?.attachments ?? []) total += att.dataBase64.length;
  return total;
}

/** Non-destructively bound the total inline-media bytes in the messages bound
 * for one request. Walks newest→oldest keeping media within `budget`; once the
 * budget is spent, OLDER tool-result messages get a shallow clone with their
 * attachments stripped and a re-read pointer appended to the text, so the
 * request stays under the provider size limit while the model keeps the most
 * recent media. The durable `session.messages` is never mutated — the stripped
 * blobs stay on disk (the original file) and a later read_file re-inlines them.
 * Returns the same array reference when nothing needs eviction (the common
 * case: no media, or media already under budget). */
export function capInflightAttachmentBytes(messages: ChatMessage[], budget: number): ChatMessage[] {
  let running = 0;
  let evicted = false;
  // First pass newest→oldest to decide which messages keep their media.
  const keep = new Array<boolean>(messages.length).fill(true);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const bytes = attachmentBytes(messages[i]!);
    if (bytes === 0) continue;
    if (running + bytes <= budget) {
      running += bytes;
    } else {
      keep[i] = false;
      evicted = true;
    }
  }
  if (!evicted) return messages;
  return messages.map((message, i) => {
    if (keep[i] || !message.toolResult?.attachments?.length) return message;
    const toolResult = { ...message.toolResult };
    delete toolResult.attachments;
    return {
      ...message,
      content: `${message.content}\n[Inline image/PDF dropped here to keep the request under the size limit — re-read the file with read_file if you need to see it again.]`,
      toolResult,
    };
  });
}

/** Local copy of the engine's message() helper (same shape compaction.ts and
 * controllers/turn-context.ts keep): building a ChatMessage is a pure
 * two-liner, and importing it from engine.ts would create a module→engine
 * cycle. */
function message(role: ChatMessage["role"], content: string, attachments?: MessageAttachment[]): ChatMessage {
  const msg: ChatMessage = { id: createId("msg"), role, content, createdAt: nowIso() };
  if (attachments && attachments.length > 0) msg.attachments = attachments;
  return msg;
}
