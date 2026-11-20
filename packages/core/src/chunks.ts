/**
 * Pure chunk extraction for Phase B compaction offload.
 *
 * Splits the compacted slice of `session.modelMessages` into one or more
 * "turn arcs" — each chunk is the work between two user messages
 * (inclusive of the first, exclusive of the next). A chunk gets force-
 * split if it overshoots a token budget so the model can recall a chunk
 * without ballooning its current turn.
 *
 * Topic-line extraction is cheap and rule-based (no LLM call) — the first
 * user message's prefix + a comma-joined list of distinct tool names in
 * the chunk. Good enough as a hint; the model decides whether to recall.
 */

import type { ChatMessage, MemoryChunk, ToolCallRecord } from "@reina/protocol";
import { nowIso } from "@reina/protocol";

const TOPIC_LINE_MAX_CHARS = 160;
const DEFAULT_MAX_TOKENS = 4_000;
const DEFAULT_MAX_MESSAGES = 24;
const DEFAULT_MIN_MESSAGES = 1;

export interface ExtractChunksInput {
  /** Messages being removed from `session.modelMessages` at this compaction
   * boundary. Caller passes the same slice that goes to `buildCompactSummary`. */
  messages: ChatMessage[];
  /** Tool-call records the engine recorded during the session. The chunk
   * extractor cross-references by message-id pair (via createdAt windows)
   * to enrich `toolNames`. Filter your input array to records whose
   * createdAt sits inside the compacted window before passing. */
  toolCalls?: ToolCallRecord[];
  /** Session id the chunks belong to. */
  sessionId: string;
  /** Existing chunk count for this session — used to mint the next id
   * sequence (`c_001`, `c_002`, ...). */
  startOrdinal: number;
  /** Token estimator (pass `(s) => tokenizer.encode(s).length` from
   * compaction.ts). Required so chunks share the same tokenization rules
   * as the compaction trigger. */
  estimateTokens: (text: string) => number;
  /** Override the default per-chunk token cap. */
  maxTokens?: number;
  /** Override the default per-chunk message cap. */
  maxMessages?: number;
}

/** Group messages into turn-bounded chunks. A new chunk starts at every
 * user-role message that isn't the very first; chunks are also forcibly
 * split when they overshoot the message or token budget so no single
 * chunk is too large to comfortably recall. */
export function extractChunks(input: ExtractChunksInput): MemoryChunk[] {
  const { messages, toolCalls = [], sessionId, startOrdinal, estimateTokens } = input;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (messages.length === 0) return [];

  const buckets: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const messageTokens = estimateTokens(`${msg.role}: ${msg.content}`);
    const isTurnBoundary = msg.role === "user" && current.length >= DEFAULT_MIN_MESSAGES;
    const wouldOverflow = current.length >= maxMessages || currentTokens + messageTokens > maxTokens;
    if (isTurnBoundary || wouldOverflow) {
      if (current.length > 0) buckets.push(current);
      current = [msg];
      currentTokens = messageTokens;
    } else {
      current.push(msg);
      currentTokens += messageTokens;
    }
  }
  if (current.length > 0) buckets.push(current);

  const createdAt = nowIso();
  return buckets.map((bucket, index) => {
    const content = bucket.map((m) => `[${m.createdAt}] ${m.role}: ${m.content}`).join("\n\n");
    const tokenCount = estimateTokens(content);
    const toolNames = collectToolNames(bucket, toolCalls);
    const topicLine = buildTopicLine(bucket, toolNames);
    return {
      id: chunkId(startOrdinal + index),
      sessionId,
      createdAt,
      topicLine,
      toolNames,
      tokenCount,
      messageIds: bucket.map((m) => m.id),
      content,
    };
  });
}

/** Format the chunk id from its session-scoped ordinal — `c_001`, `c_042`. */
function chunkId(ordinal: number): string {
  return `c_${ordinal.toString().padStart(3, "0")}`;
}

/** Collect distinct tool names whose tool-call records fall inside the
 * chunk's time window. The matching is timestamp-based since
 * ToolCallRecord doesn't directly carry the originating message id. */
function collectToolNames(bucket: ChatMessage[], toolCalls: ToolCallRecord[]): string[] {
  if (bucket.length === 0 || toolCalls.length === 0) return [];
  const firstAt = bucket[0]!.createdAt;
  const lastAt = bucket[bucket.length - 1]!.createdAt;
  const names = new Set<string>();
  for (const call of toolCalls) {
    if (call.createdAt >= firstAt && call.createdAt <= lastAt) {
      names.add(call.name);
    }
  }
  return [...names].sort();
}

/** Build the one-line topic for a chunk. Format:
 * `<first 80 chars of the first user message> [tool1, tool2, ...]`
 * Falls back to "(assistant-only segment)" when no user message exists. */
function buildTopicLine(bucket: ChatMessage[], toolNames: string[]): string {
  const firstUser = bucket.find((m) => m.role === "user");
  const head = firstUser
    ? truncate(firstUser.content.replace(/\s+/g, " ").trim(), TOPIC_LINE_MAX_CHARS - 40)
    : "(assistant-only segment)";
  const tail = toolNames.length > 0 ? ` [${toolNames.join(", ")}]` : "";
  return `${head}${tail}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Should the offload feature run at all? Checked against the env var so
 * Phase A remains the default until the user opts in explicitly. */
export function isCompactionOffloadEnabled(): boolean {
  return process.env.REINA_COMPACTION_OFFLOAD === "1";
}
