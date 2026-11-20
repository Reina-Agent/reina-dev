import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { ChatMessage, CompactBoundary, ModelConfig, SessionState, ToolDescriptor, ToolObservation } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { isRetryableStreamError, nextModelTurnStream } from "@reina/providers";
import { resolveProfile } from "./profiles.js";
import { rollupSideUsage } from "./side-usage.js";

// Default tuned to the modern "long context" floor: Claude / GLM-5 / GLM-4.6
// all sit at 200k. Models with smaller real windows (e.g. DeepSeek 128k) must
// still set `contextWindowTokens` per-model in models.json — overshooting the
// real window risks `context too long` on the provider before auto-compaction
// triggers. Models genuinely at 1M (gpt-4.1, anything tagged `[1m]`) are still
// recognised below in `inferContextWindowTokens`.
const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
const AUTO_COMPACT_BUFFER_TOKENS = 13_000;
const AUTO_COMPACT_MIN_MESSAGES = 12;
// Floor for the body-after-prefix budget (see `autoCompactBodyLimit`). Even when
// the safety buffer is small (e.g. an aggressive trigger-percent override), the
// next compaction still waits for this much fresh context so a high prefix
// baseline can't churn the summarizer turn-by-turn.
const AUTO_COMPACT_MIN_BODY_GROWTH = 4_000;
const COMPACT_KEEP_RECENT_MESSAGES = 8;
const COMPACT_KEEP_RECENT_TOKENS = 5000;
// Minimum size of the prefix-to-drop for a compaction to be worth doing.
// compactSessionContext re-injects a small post-compact context message after
// every run, so dropping a prefix smaller than this nets ~zero tokens freed —
// and since that re-injected message becomes the next round's prefix, manual
// /compact would churn one message forever (each costing a summary model call).
// Auto-compaction only fires near the context window, where the prefix is far
// larger than this, so this floor never blocks a compaction that actually helps.
const COMPACT_MIN_COMPACTED_TOKENS = 2000;
// Output cap. The summary is now folded ONCE into a cacheable post-compact
// message in modelMessages (see buildPostCompactContextMessage) — like
// Codex/CC — instead of being re-sent uncached as a per-turn system-reminder.
// It still occupies context between compactions, so keep it dense.
const COMPACT_SUMMARY_MAX_CHARS = 8000;
// The compacted slice is sent to the summary model NATIVELY (codex-style: the
// real messages followed by a summarize instruction) instead of being
// serialized into one string and middle-truncated at a fixed char cap. The
// only limit is the model's own window: when the slice estimate overshoots
// this fraction of the effective window, oldest messages are dropped WHOLE
// until it fits (see trimOldestToTokenBudget). The fraction absorbs the o200k
// estimate running ~15-20% low against non-OpenAI tokenizers.
const COMPACT_SUMMARY_SOURCE_WINDOW_FRACTION = 0.8;
// Bound for the last-user-message tail anchor in `compactSplitIndex`: the
// preserved slice may grow to at most this fraction of the effective window to
// keep the anchoring user message verbatim. Beyond that, compaction could no
// longer free meaningful space, so we fall back to the summary's verbatim-quote
// sections (6 "All user messages" / 9 "Next Step quotes") to carry the intent.
const COMPACT_TAIL_USER_ANCHOR_WINDOW_FRACTION = 0.25;
// Post-compact restored context lists recently read file PATHS only (pi-style:
// formatFileOperations). Re-injecting file bodies (formerly 5 files × 20k
// chars) put a ~25k-token floor under every compaction — the single biggest
// reason "compacted" sessions stayed large. The files are on disk; the model
// re-reads the ones it actually still needs.
const POST_COMPACT_MAX_FILES_TO_LIST = 20;

export type AutoCompactDecision = { shouldCompact: false } | { shouldCompact: true; reason: string };

export function shouldAutoCompactSession(session: SessionState, extraInputTokens = 0): AutoCompactDecision {
  if (process.env.REINA_COMPACTION_AUTO === "0") return { shouldCompact: false };
  const current = modelMessages(session);
  if (current.length < AUTO_COMPACT_MIN_MESSAGES) return { shouldCompact: false };
  const { tokens: historyTokens, source } = sessionContextTokens(session);
  // On the estimate path (providers that never report usage) the modelMessages
  // estimate is blind to the fixed request prefix — system prompt, tools,
  // reminders — and to historical tool outputs woven back at send time, so on
  // a tool-heavy session it under-counts the real request several-fold (see
  // measureModelRequest's "Estimate now" note in engine.ts). The trigger would
  // then sit below the threshold forever while the actual request is already
  // past it. The engine measures every outgoing request; use the latest
  // measure as a floor so this path converges to the same request-shaped
  // footprint the provider path triggers on.
  const measured = source === "estimate" ? measuredRequestTokens(session) : undefined;
  const tokens = measured !== undefined && measured > historyTokens ? measured : historyTokens;
  // `extraInputTokens` covers content bound for the NEXT request that isn't in
  // session history yet — chiefly pending tool observations woven in at send
  // time. The provider total / history estimate can't see them, so a follow-up
  // call right after a large tool result would under-count without this. 0 (the
  // default) reproduces the history-only trigger for fresh-turn callers.
  const extra = Math.max(0, extraInputTokens);
  const projected = tokens + extra;
  const threshold = autoCompactThreshold(session.model);
  if (projected < threshold) return { shouldCompact: false };

  // Codex-style body-after-prefix gate (mirrors `AutoCompactWindow` +
  // `AutoCompactTokenLimitScope::BodyAfterPrefix`). The threshold above is the
  // hard cap on the TOTAL footprint (so we never approach the real window), but
  // the bulk of that total can be an unshrinkable stable prefix — system prompt,
  // tool schemas, the summary, and (on weak models) the replayed tool outputs
  // woven back every turn. Compacting can't reduce that prefix, so triggering on
  // total alone makes compaction re-fire every turn for ~zero net gain.
  //
  // `autoCompactBaseline` is the request-shaped total observed right after the
  // last compaction = the size of that prefix — the provider total on providers
  // that report usage, or the engine's own request measure on providers that
  // don't (seeded by accumulateUsage; the measured floor above re-introduced
  // exactly this churn on the estimate path: a post-compaction footprint the
  // compactor cannot shrink — prefix + the launching directive kept verbatim —
  // would re-fire on every message). We only auto-compact again once the body
  // that grew SINCE the baseline clears a budget, so a high baseline can't
  // churn. Applied only when the CURRENT total is request-shaped too (provider
  // total or a fresh measure) — the raw modelMessages estimate under-counts
  // and would mask real growth against a request-shaped baseline.
  const baseline = session.usage?.autoCompactBaseline;
  const requestShaped = source === "provider" || measured !== undefined;
  if (requestShaped && typeof baseline === "number" && Number.isFinite(baseline)) {
    const bodyGrowth = projected - baseline;
    const bodyLimit = autoCompactBodyLimit(session.model);
    if (bodyGrowth < bodyLimit) {
      return { shouldCompact: false };
    }
  }

  const detail = extra > 0
    ? `context ${tokens} tokens (${source}) + ${extra} pending`
    : `context ${tokens} tokens (${source})`;
  return {
    shouldCompact: true,
    reason: `${detail} exceeded autocompact threshold ${threshold}`,
  };
}

/** Latest measured full-request footprint (`measureModelRequest` →
 * `usage.lastRequest.categories.autocompactEstimate`), used to floor the
 * estimate-path trigger above. Only valid when the measure postdates the last
 * compaction — a stale pre-compact measure describes a history that no longer
 * exists and would re-fire the trigger immediately, churning the summarizer. */
function measuredRequestTokens(session: SessionState): number | undefined {
  const last = session.usage?.lastRequest;
  if (!last) return undefined;
  const measured = last.categories?.autocompactEstimate;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0) return undefined;
  const boundary = session.compactBoundaries?.at(-1);
  if (boundary && last.createdAt <= boundary.createdAt) return undefined;
  return Math.floor(measured);
}

/** Per-window body budget for the body-after-prefix auto-compaction gate above.
 * How much NEW context may accumulate after a compaction before the next one
 * fires. Defaults to half the safety buffer that sits between the auto-compact
 * threshold and the effective window, so `baseline + bodyLimit` stays
 * comfortably under the real window even when the baseline is already high.
 * `REINA_COMPACTION_BODY_GROWTH_TOKENS` overrides it directly. */
export function autoCompactBodyLimit(model: ModelConfig): number {
  const override = positiveIntEnv("REINA_COMPACTION_BODY_GROWTH_TOKENS");
  if (override !== undefined) return override;
  const buffer = Math.max(0, effectiveContextWindow(model) - autoCompactThreshold(model));
  return Math.max(AUTO_COMPACT_MIN_BODY_GROWTH, Math.floor(buffer / 2));
}

/**
 * Authoritative context-window footprint of the live session, used to drive
 * the auto-compaction trigger. Mirrors codex (`tokens_in_context_window` →
 * provider `total_tokens`) and pi (`calculateContextTokens` → `usage.totalTokens`):
 * the model's own count is the source of truth, so compaction fires at the real
 * boundary instead of a local estimate that drifts (o200k is cross-tokenizer for
 * Claude/GLM/Kimi/etc. and omits framing overhead — typically ~15-20% low).
 *
 * Falls back to the o200k estimate only when no provider total exists yet — the
 * first round of a session, a provider that doesn't report `total_tokens`, or
 * immediately after a compaction (which clears `usage.contextTokens` so the next
 * round re-seeds from a fresh request instead of re-triggering on the stale peak).
 */
export function sessionContextTokens(session: SessionState): { tokens: number; source: "provider" | "estimate" } {
  const usage = session.usage;
  const providerTotal =
    usage?.contextTokensSource === "provider" &&
    typeof usage.contextTokens === "number" &&
    Number.isFinite(usage.contextTokens) &&
    usage.contextTokens > 0
      ? Math.floor(usage.contextTokens)
      : undefined;
  if (providerTotal !== undefined) return { tokens: providerTotal, source: "provider" };
  // No `summary` arg: the rolling summary now lives inside `modelMessages` (folded
  // into the post-compact restored-context message), so passing it here too would
  // double-count it on the estimate branch and trip auto-compaction early.
  return { tokens: estimateContextTokens(modelMessages(session)), source: "estimate" };
}

export function estimateSessionContextTokens(session: SessionState): number {
  // See sessionContextTokens: summary is already counted inside modelMessages.
  return estimateContextTokens(modelMessages(session));
}

/** o200k estimate of what the pending tool observations will add to the next
 * request as tool_result blocks. They live on the engine's transient
 * `pendingObservations`, not in session history, so `sessionContextTokens`
 * misses them — the request-aware preflight adds this on top before deciding
 * whether to compact. Mirrors the `name: value` shape providers weave (same as
 * `measureModelRequest`'s usage breakdown) so the estimate tracks what's sent. */
export function estimateObservationTokens(observations: readonly ToolObservation[]): number {
  if (observations.length === 0) return 0;
  const text = observations.map((o) => `${o.name}: ${o.error ?? o.output ?? ""}`).join("\n");
  return estimateTextTokens(text);
}

export function autoCompactThreshold(model: ModelConfig): number {
  const contextWindow = contextWindowTokens(model);
  const effectiveWindow = effectiveContextWindow(model);
  return Math.max(AUTO_COMPACT_MIN_MESSAGES, effectiveWindow - autocompactBufferTokens(effectiveWindow, contextWindow));
}

export function effectiveContextWindow(model: ModelConfig): number {
  const contextWindow = contextWindowTokens(model);
  const reservedOutput = Math.min(contextWindow, COMPACT_MAX_OUTPUT_TOKENS);
  return Math.max(8_000, contextWindow - reservedOutput);
}

export function contextWindowTokens(model: ModelConfig): number {
  if (model.contextWindowTokens) return model.contextWindowTokens;
  const env = process.env.REINA_CONTEXT_WINDOW_TOKENS;
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return inferContextWindowTokens(model.model);
}

/** Optional hooks for the caller to react to the compaction lifecycle.
 * Used by the engine to wire Phase B offload (chunk extraction +
 * persistence) without leaking SQLite or session-store imports into
 * compaction.ts. */
export interface CompactSessionOptions {
  /** Fires after compaction determines there is a non-empty slice to drop,
   * but before any potentially slow summary/offload work starts. */
  onStart?: () => void;
  /** Fires once with the messages that are about to be dropped from
   * `session.modelMessages`. The hook runs BEFORE the model summary call
   * (so failure to write chunks does not block compaction), but the
   * caller may await async work — `compactSessionContext` will wait for
   * the promise before continuing. */
  onCompactedMessages?: (compacted: readonly ChatMessage[]) => void | Promise<void>;
  /** Aborts the summary model call when the session is interrupted or torn
   * down, so an in-flight compaction doesn't keep streaming after the user
   * has moved on. Falls back to the extractive summary on abort. */
  signal?: AbortSignal;
  /** Dedicated model for the summary call (config `compactionModel` merged
   * over the session model by the engine). Defaults to the session model.
   * Also sizes the source budget, so a smaller-window summary model trims
   * the slice to ITS window, not the session's. */
  summaryModel?: ModelConfig;
  /** Live main-agent prefix (system + tools) for this turn. Supplied by the
   * engine ONLY when the summary runs on the SAME model+provider the main agent
   * caches against, so the summary call reuses the just-cached
   * `[system + tools + history]` prefix (bulk of the slice bills at cache-read,
   * ~10%, instead of full price). Omitted by non-engine callers/tests and when a
   * distinct `compactionModel` is configured — the fast path stays off. */
  cacheReuse?: SummaryCacheReuse;
}

export async function compactSessionContext(
  session: SessionState,
  type: CompactBoundary["type"],
  reason: string,
  options?: CompactSessionOptions,
): Promise<CompactBoundary | undefined> {
  const current = modelMessages(session);
  const splitIndex = compactSplitIndex(current, session.model);
  if (splitIndex <= 0) return undefined;

  const compacted = current.slice(0, splitIndex);
  const preserved = current.slice(splitIndex);
  options?.onStart?.();
  if (options?.onCompactedMessages) {
    await options.onCompactedMessages(compacted);
  }
  // No `summary` arg in either metric: on a post-fold session the (old) summary
  // already lives inside `current`/`nextModelMessages` via the restored-context
  // message, so adding it again would double-count the boundary token metrics.
  const estimatedTokensBefore = estimateContextTokens(current);
  const summary = await buildCompactSummary(session, compacted, reason, options?.signal, options?.summaryModel, options?.cacheReuse);
  const historyPath = await writeConversationHistory(session, compacted, type);
  // Fold the freshly-built summary into the once-injected, cacheable restored-
  // context message (passed explicitly — `session.summary` is still the OLD
  // value until the assignment below).
  const restoredContext = buildPostCompactContextMessage(session, summary, historyPath);
  const summaryMessageId = createId("summary");
  const reinjectedMessages = restoredContext ? [restoredContext] : [];
  const nextModelMessages = [...reinjectedMessages, ...preserved];
  const estimatedTokensAfter = estimateContextTokens(nextModelMessages);
  const preservedMessageIds = preserved.map((item) => item.id);
  const boundary: CompactBoundary = {
    id: createId("compact"),
    type,
    compactType: type,
    createdAt: nowIso(),
    reason,
    preCompactTokenCount: estimatedTokensBefore,
    postCompactTokenCount: estimatedTokensAfter,
    estimatedTokensBefore,
    estimatedTokensAfter,
    preMessageCount: current.length,
    postMessageCount: nextModelMessages.length,
    messagesCompacted: compacted.length,
    historyPath,
    lastUserMessageId: lastUserMessageId(current),
    preservedMessageIds,
    summaryMessageId,
    preservedSegment: {
      summaryMessageId,
      preservedMessageIds,
    },
    reinjectedMessageIds: reinjectedMessages.map((item) => item.id),
  };

  session.summary = summary;
  session.modelMessages = nextModelMessages;
  // Do NOT clear session.providerState here. It carries the within-turn
  // replay of the LAST round's assistant output (Responses: reasoning +
  // function_call items; Anthropic: tool_use blocks; chat: the tool_calls
  // assistant message). When auto-compaction fires at a loop boundary with
  // tool observations still pending, the next request re-emits those items
  // so the observations have a call to join to — wiping the state here
  // orphans them and the provider rejects the request with a 400
  // ("No tool call found for function call output with call_id ..."). The
  // replay items are self-contained input items, valid regardless of the
  // history rewrite; the engine already drops the state at turn boundaries.
  session.compactBoundaries ??= [];
  session.compactBoundaries.push(boundary);
  return boundary;
}

export function upsertRecentFile(
  files: Array<{ path: string; mtimeMs: number; readAt: string }>,
  next: { path: string; mtimeMs: number; readAt: string },
): Array<{ path: string; mtimeMs: number; readAt: string }> {
  const filtered = files.filter((file) => file.path !== next.path);
  filtered.unshift(next);
  return filtered.slice(0, 20);
}

/**
 * Strip the model's `<analysis>` drafting scratchpad and unwrap `<summary>`
 * into a plain text section. Exported for tests.
 */
export function formatCompactSummary(raw: string): string {
  let formatted = raw;
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${summaryMatch[1]!.trim()}`);
  }
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

function modelMessages(session: SessionState): ChatMessage[] {
  return session.modelMessages ?? session.messages;
}

function inferContextWindowTokens(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("[1m]") || normalized.includes("1m")) return 1_000_000;
  if (normalized.includes("gpt-4.1")) return 1_000_000;
  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

function autocompactBufferTokens(effectiveWindow: number, contextWindow: number): number {
  // Percentage override (1-99) is the user-friendly knob: "compact when this
  // much of the total context window is used". Wins over the absolute tokens
  // override below — same percent works across 200k / 1M models without
  // re-tuning. The buffer is whatever's left in the effective window when
  // the trigger fires at percent-of-total.
  const percent = positiveIntEnv("REINA_COMPACTION_TRIGGER_PERCENT");
  if (percent !== undefined && percent >= 1 && percent <= 99) {
    const triggerAtTotal = Math.floor(contextWindow * percent / 100);
    return Math.max(0, effectiveWindow - triggerAtTotal);
  }
  const override = positiveIntEnv("REINA_COMPACTION_BUFFER_TOKENS");
  if (override !== undefined) return override;
  if (effectiveWindow >= 800_000) return 50_000;
  if (effectiveWindow >= 400_000) return 30_000;
  return AUTO_COMPACT_BUFFER_TOKENS;
}

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function writeConversationHistory(
  session: SessionState,
  messagesToCompact: ChatMessage[],
  type: CompactBoundary["type"],
): Promise<string | undefined> {
  if (messagesToCompact.length === 0) return undefined;
  const dir = path.join(session.cwd, ".reina", "conversation_history");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session.id}.md`);
  const section = [
    `## Compacted at ${nowIso()}`,
    "",
    `- type: ${type}`,
    `- messages: ${messagesToCompact.length}`,
    "",
    formatMessagesForSummary(messagesToCompact),
    "",
  ].join("\n");
  await appendFile(file, section, "utf8");
  return path.relative(session.cwd, file);
}

/** Marker prefix every post-compact restored-context message starts with.
 * Doubles as the idempotency sentinel for the load-time summary backfill
 * (`AgentEngine.backfillCompactionSummaryMessage`) and as the marker
 * `buildCompactSummary` uses to keep a prior restored-context message out of
 * the next summary's source. */
export const POST_COMPACT_CONTEXT_PREFIX = "Post-compact restored context:";
/** Section header introducing the rolling summary inside a restored-context
 * message. Part of the backfill sentinel (prefix + this header). */
export const POST_COMPACT_SUMMARY_SECTION = "Conversation summary:";
const POST_COMPACT_RESUME_DIRECTIVE = [
  "Continue the conversation from where it left off. Do not acknowledge this",
  "summary, do not recap what was happening, do not preface with \"I'll continue\"",
  "or similar. Resume directly — pick up the last task as if the break never",
  "happened.",
].join(" ");

function buildPostCompactContextMessage(session: SessionState, summary: string, historyPath?: string): ChatMessage | undefined {
  const recentFiles = [...(session.recentFiles ?? [])]
    .sort((a, b) => b.readAt.localeCompare(a.readAt))
    .slice(0, POST_COMPACT_MAX_FILES_TO_LIST);
  const sections: string[] = [];
  // Lead with the rolling summary. Folding it into this once-injected, cacheable
  // message (instead of re-emitting it as a per-turn system-reminder) is the
  // optimization: the summary rides the cached message prefix and is paid once
  // per compaction rather than re-sent uncached every turn — mirrors Codex's
  // build_compacted_history. `summary` is passed in (not read from
  // `session.summary`, which is still the OLD value at the call site).
  if (summary) {
    sections.push(`${POST_COMPACT_SUMMARY_SECTION}\n${summary}`);
  }
  if (historyPath) {
    sections.push(`Full pre-compact conversation history was saved at ${historyPath}. Read it if exact earlier details are needed.`);
  }
  // Grok-style compaction recovery, retrieval flavour: don't re-inject
  // dropped content (that's what the summary is for) — point at the
  // retrieval affordance so a detail the summary missed is one keyword
  // search away instead of gone.
  sections.push(
    "If a needed detail is missing from the summary above, search_memory(\"<keywords>\") retrieves it from full history, offloaded chunks, and notes.",
  );
  // Paths only — no file bodies (see POST_COMPACT_MAX_FILES_TO_LIST). A stale
  // 20k-char snapshot is worse than a pointer: it bloats the post-compact floor
  // AND risks the model trusting pre-compact file content over the live disk.
  if (recentFiles.length > 0) {
    sections.push(
      [
        "Recently read files (most recent first). Contents were NOT restored — re-read a file before relying on or editing it:",
        ...recentFiles.map((file) => `- ${path.relative(session.cwd, file.path)}`),
      ].join("\n"),
    );
  }
  if (session.skills.length > 0) {
    sections.push(`Active skills: ${session.skills.map((skill) => `${skill.name} (${skill.path})`).join(", ")}`);
  }

  // Nothing to restore (no summary, history, files, or skills) — emit no message
  // so a trivial compaction doesn't inject an empty stub. A summary alone is
  // enough (it was pushed first above), so summary-only sessions still get a
  // message now that the per-turn summary reminder is gone. The resume directive
  // suppresses the wasted "OK, I've reviewed the prior summary..." ack turn.
  if (sections.length === 0) return undefined;
  sections.push(POST_COMPACT_RESUME_DIRECTIVE);
  return message("user", `${POST_COMPACT_CONTEXT_PREFIX}\n\n${sections.join("\n\n")}`);
}

/** Build the summary-bearing restored-context message used by the load-time
 * backfill for sessions compacted before the summary was folded into history.
 * Shape matches `buildPostCompactContextMessage` (same prefix + summary header
 * + resume directive) so the backfill's idempotency sentinel recognises it. */
export function buildSummaryRestoredContextMessage(summary: string): ChatMessage {
  return message(
    "user",
    `${POST_COMPACT_CONTEXT_PREFIX}\n\n${POST_COMPACT_SUMMARY_SECTION}\n${summary}\n\n${POST_COMPACT_RESUME_DIRECTIVE}`,
  );
}

/**
 * Build the system prompt for the compaction summary model call. The structure
 * is `NO_TOOLS_PREAMBLE` + `profile.prompt` (role anchor) + `BASE_COMPACT_PROMPT`
 * (9-section structure with verbatim-quote requirement) + `NO_TOOLS_TRAILER`.
 *
 * Why dual no-tools fencing: `nextModelTurnStream` is called with `tools: []`,
 * which is schema-level enforcement. But OpenAI-compatible endpoints (KIMI,
 * DeepSeek, some Ollama configs) ignore the empty tools array and still
 * attempt tool calls. The preamble + trailer prompt-level fencing catches
 * those cases.
 */
const NO_TOOLS_PREAMBLE = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "",
  "- Do NOT use read_file, run_shell, search_files, edit_file, or ANY other tool.",
  "- You already have all the context you need in the conversation segment below.",
  "- Tool calls will be REJECTED and will waste your only turn — you will fail the task.",
  "- Your entire response must be plain text: an <analysis> block followed by a <summary> block.",
].join("\n");

const BASE_COMPACT_PROMPT = [
  "Your task is to create a detailed summary of the conversation so far, paying",
  "close attention to the user's explicit requests and your previous actions.",
  "Be thorough in capturing technical details, code patterns, and decisions",
  "essential for continuing development without losing context.",
  `Keep the summary within ${COMPACT_SUMMARY_MAX_CHARS} characters; prioritize user constraints, current work, and next steps.`,
  "",
  "Before your final summary, wrap your analysis in <analysis> tags:",
  "1. Chronologically analyze each section. For each: user's explicit requests,",
  "   your approach, key decisions, file names, full code snippets, function",
  "   signatures, errors and fixes, user feedback.",
  "2. Double-check technical accuracy and completeness.",
  "",
  "Your summary must include these sections:",
  "",
  "1. Primary Request and Intent",
  "2. Key Technical Concepts",
  "3. Files and Code Sections (full snippets + why important)",
  "4. Errors and Fixes (including user feedback)",
  "5. Problem Solving",
  "6. All user messages (list every non-tool-result user message)",
  "7. Pending Tasks",
  "8. Current Work (exactly what was happening immediately before compaction)",
  "9. Optional Next Step — include direct verbatim quotes from the most recent",
  "   user message. Do not paraphrase user words.",
  "",
  "Preserve all file paths, commands, error messages, and direct user quotes",
  "literally. Never rewrite a user's words. If a previous summary exists, copy",
  "still-relevant parts verbatim rather than rephrasing.",
  "",
  "Format:",
  "<analysis>...</analysis>",
  "<summary>",
  "1. Primary Request and Intent: ...",
  "...",
  "</summary>",
].join("\n");

const NO_TOOLS_TRAILER = [
  "REMINDER: Do NOT call any tools. Respond with plain text only —",
  "an <analysis> block followed by a <summary> block.",
].join("\n");

function buildSummarySystemPrompt(): string {
  const profile = resolveProfile("summary");
  return [NO_TOOLS_PREAMBLE, "", profile.prompt, "", BASE_COMPACT_PROMPT, "", NO_TOOLS_TRAILER].join("\n");
}

/** The compacted slice prepared for the summary request.
 *
 * - A prior post-compact restored-context message is excluded: its embedded
 *   summary is already carried verbatim via the instruction's previous-summary
 *   block, so re-summarizing it would duplicate the summary.
 * - Structured tool pairs (ChatMessage.toolResult) are flattened to labeled
 *   user text: the summary request declares `tools: []`, and Anthropic rejects
 *   tool_use/tool_result blocks when no tools are defined.
 * - System entries are downgraded to user text (toAnthropicMessages silently
 *   drops system-role history), reasoning/attachments are stripped, and empty
 *   messages are skipped (some providers 400 on empty content).
 */
function toSummarySourceMessages(messagesToCompact: readonly ChatMessage[]): ChatMessage[] {
  return messagesToCompact
    // Engine-injected notices (`origin`: task deltas, stale-read nudges,
    // completion blocks) are per-turn bookkeeping the injectors rebuild from
    // live state — summarizing them wastes summary budget on stale snapshots
    // (kimi's compaction drops all injection-origin messages for the same
    // reason).
    .filter((item) => !item.origin && !item.content.startsWith(POST_COMPACT_CONTEXT_PREFIX))
    .map((item): ChatMessage => {
      if (item.toolResult) {
        return {
          id: item.id,
          role: "user",
          content: `Tool result (${item.toolResult.name}):\n${item.content}`,
          createdAt: item.createdAt,
        };
      }
      return {
        id: item.id,
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content,
        createdAt: item.createdAt,
      };
    })
    .filter((item) => item.content.trim().length > 0);
}

/** Drop oldest messages WHOLE until the slice fits the token budget. Always
 * keeps at least the newest message. Returns how many were dropped so the
 * opener can say so instead of silently truncating. */
function trimOldestToTokenBudget(messages: ChatMessage[], budgetTokens: number): { kept: ChatMessage[]; dropped: number } {
  let total = estimateMessagesTokens(messages);
  let start = 0;
  while (start < messages.length - 1 && total > budgetTokens) {
    total -= estimateMessageTokens(messages[start]!);
    start += 1;
  }
  return { kept: start > 0 ? messages.slice(start) : messages, dropped: start };
}

/** Build the messages array for the summary model call — codex-style: a user
 * opener, then the compacted slice as REAL messages (roles intact, nothing
 * serialized or middle-truncated), then a trailing user instruction carrying
 * the compaction reason + previous summary. The slice is a subset of a history
 * that already fit the live window, so the budget trim is the exception, not
 * the rule. The opener also guarantees the request starts with a user message
 * for providers that require it. Exported for tests. */
export function buildSummaryRequestMessages(
  session: SessionState,
  messagesToCompact: readonly ChatMessage[],
  reason: string,
  summaryModel?: ModelConfig,
): ChatMessage[] {
  const source = toSummarySourceMessages(messagesToCompact);
  const previous = session.summary ? `\n\nPrevious summary (copy verbatim if still relevant):\n${session.summary}` : "";
  const instructionText = [
    `Compaction reason: ${reason}${previous}`,
    "",
    "The messages above are the conversation segment being compacted away.",
    "Produce the <analysis> + <summary> response now.",
  ].join("\n");
  const overhead = estimateTextTokens(buildSummarySystemPrompt()) + estimateTextTokens(instructionText) + 256;
  const budget = Math.max(
    8_000,
    Math.floor(effectiveContextWindow(summaryModel ?? session.model) * COMPACT_SUMMARY_SOURCE_WINDOW_FRACTION) - overhead,
  );
  const { kept, dropped } = trimOldestToTokenBudget(source, budget);
  const openerText =
    dropped > 0
      ? `Conversation segment to summarize follows (oldest first; the ${dropped} oldest messages were omitted to fit the context window).`
      : "Conversation segment to summarize follows (oldest first).";
  return [message("user", openerText), ...kept, message("user", instructionText)];
}

/** The live main-agent prefix for this turn, supplied by the engine ONLY when
 * the summary runs on the SAME model+provider the main agent has been caching
 * against (see `compactWithLifecycle`). Lets the summary call reuse the
 * byte-identical `[system + tools + history]` prefix instead of paying full
 * price on the whole compacted slice. */
export interface SummaryCacheReuse {
  systemPrompt: string;
  tools: ToolDescriptor[];
}

/** Trailing instruction for the cache-friendly path. The system block is now
 * the main agent's prompt (so the cache hits), which means the no-tools fencing
 * and the <analysis>/<summary> structure must travel in THIS user message
 * instead — the main prompt actively encourages tool use, so the fencing here
 * is what keeps the model summarizing rather than acting. */
function buildCacheFriendlySummaryInstruction(session: SessionState, reason: string): string {
  const previous = session.summary
    ? `\n\nPrevious summary (copy verbatim if still relevant):\n${session.summary}`
    : "";
  return [
    NO_TOOLS_PREAMBLE,
    "",
    "The entire conversation above is being compacted to free context. Summarize it now — do NOT continue the task and do NOT call any tools.",
    "",
    BASE_COMPACT_PROMPT,
    "",
    `Compaction reason: ${reason}${previous}`,
    "",
    NO_TOOLS_TRAILER,
  ].join("\n");
}

/** Transient-error retry for the summary side requests. Without it, one
 * network blip on the (non-fatal) summary call silently degrades the compact
 * summary to the extractive fallback — pi hit the same invisible quality loss
 * (retry-summary-requests, #6647). Retries only what the main turn would
 * retry (isRetryableStreamError), with an abortable backoff; non-retryable
 * errors and exhausted retries propagate to the callers' existing fallbacks. */
const SUMMARY_MAX_RETRIES = 2;

function summaryBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.min(8_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function summaryTurnWithRetries(
  model: ModelConfig,
  request: Parameters<typeof nextModelTurnStream>[1],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof nextModelTurnStream>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await nextModelTurnStream(model, request, undefined, signal);
    } catch (error) {
      if (signal?.aborted || attempt >= SUMMARY_MAX_RETRIES || !isRetryableStreamError(error)) throw error;
      await summaryBackoff(attempt, signal);
      if (signal?.aborted) throw error;
    }
  }
}

/** Cache-reuse summary attempt. Sends the compacted slice as NATIVE messages
 * (no flatten, no filter, no trim) so the provider serializes them
 * byte-identically to the main agent's just-cached request, then rides the
 * summarize instruction as a fresh trailing user message after the cached
 * prefix. Returns undefined — never a partial — when the model defects to a
 * tool call or yields nothing usable, so the caller falls back to the fenced
 * no-tools path. Reina's tool pairs are single `.toolResult` messages, so the
 * slice boundary can never strand a tool_use (no pairing 400 risk). */
async function tryCacheFriendlySummary(
  model: ModelConfig,
  session: SessionState,
  messagesToCompact: ChatMessage[],
  reason: string,
  cacheReuse: SummaryCacheReuse,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const instruction = buildCacheFriendlySummaryInstruction(session, reason);
    const turn = await summaryTurnWithRetries(
      model,
      {
        // No promptCache:"none" here — this request deliberately re-reads the
        // main conversation's cached prefix (that is the whole fast path).
        messages: [...messagesToCompact, message("user", instruction)],
        observations: [],
        tools: cacheReuse.tools,
        systemPrompt: cacheReuse.systemPrompt,
      },
      signal,
    );
    rollupSideUsage(session, turn.usage);
    const content = turn.content?.trim();
    if (!turn.truncated && turn.toolCalls.length === 0 && content && !content.includes("deterministic provider only handles")) {
      return truncateMiddle(formatCompactSummary(content), COMPACT_SUMMARY_MAX_CHARS);
    }
  } catch {
    // Fall through to the fenced no-tools path below.
  }
  return undefined;
}

async function buildCompactSummary(
  session: SessionState,
  messagesToCompact: ChatMessage[],
  reason: string,
  signal?: AbortSignal,
  summaryModel?: ModelConfig,
  cacheReuse?: SummaryCacheReuse,
): Promise<string> {
  const model = summaryModel ?? session.model;
  // Fast path: reuse the main agent's cached prefix. On a tool-call defection or
  // empty output this returns undefined and we drop to the safe path, so the
  // worst case is one extra (mostly cache-read) call, never a degraded summary.
  if (cacheReuse) {
    const reused = await tryCacheFriendlySummary(model, session, messagesToCompact, reason, cacheReuse, signal);
    if (reused) return reused;
  }
  try {
    const turn = await summaryTurnWithRetries(
      model,
      {
        messages: buildSummaryRequestMessages(session, messagesToCompact, reason, model),
        observations: [],
        tools: [],
        systemPrompt: buildSummarySystemPrompt(),
        // One-shot request with a throwaway prefix: writing it to the prompt
        // cache is pure 1.25x surcharge — nothing ever reads it back.
        promptCache: "none",
      },
      signal,
    );
    rollupSideUsage(session, turn.usage);
    const content = turn.content?.trim();
    if (!turn.truncated && turn.toolCalls.length === 0 && content && !content.includes("deterministic provider only handles")) {
      return truncateMiddle(formatCompactSummary(content), COMPACT_SUMMARY_MAX_CHARS);
    }
  } catch {
    // Fall back to an extractive summary so compaction never blocks the main turn.
  }

  const sourceMessages = messagesToCompact.filter(
    (item) => !item.origin && !item.content.startsWith(POST_COMPACT_CONTEXT_PREFIX),
  );
  return extractiveSummary(sourceMessages, session.summary);
}

function compactSplitIndex(messages: ChatMessage[], model?: ModelConfig): number {
  const keepRecent = positiveIntEnv("REINA_COMPACTION_KEEP_RECENT") ?? COMPACT_KEEP_RECENT_MESSAGES;
  if (messages.length <= keepRecent) return 0;
  let keepFrom = Math.max(0, messages.length - keepRecent);
  let keptTokens = estimateMessagesTokens(messages.slice(keepFrom));
  while (keepFrom > 1 && keptTokens < COMPACT_KEEP_RECENT_TOKENS) {
    keepFrom--;
    keptTokens += estimateMessageTokens(messages[keepFrom]!);
  }
  // Keep the ACTIVE task directive verbatim: when auto-compaction fires
  // mid-turn (a long tool loop), the recent-N tail is all tool results and the
  // user message that launched the work would be summarized away — the model
  // resumes on a paraphrase of its own instructions (hermes hit this as
  // #10896). Pull the split back to the last real user message (not an
  // ephemeral in-band tool result, not a restored-context injection), bounded
  // so an ancient directive can't inflate the preserved slice past the point
  // where compaction still frees meaningful space.
  const lastUserIdx = lastRealUserMessageIndex(messages);
  if (lastUserIdx >= 0 && lastUserIdx < keepFrom && model) {
    const budget = Math.floor(effectiveContextWindow(model) * COMPACT_TAIL_USER_ANCHOR_WINDOW_FRACTION);
    if (estimateMessagesTokens(messages.slice(lastUserIdx)) <= budget) keepFrom = lastUserIdx;
  }
  // Don't compact when the prefix we'd drop is trivial — otherwise /compact
  // peels off one tiny message, re-injects a context message of similar size,
  // and can be repeated forever with no net reduction. See
  // COMPACT_MIN_COMPACTED_TOKENS. Returning 0 makes compactSessionContext bail
  // and the host report "nothing to compact".
  if (estimateMessagesTokens(messages.slice(0, keepFrom)) < COMPACT_MIN_COMPACTED_TOKENS) return 0;
  return keepFrom;
}

/** Index of the newest message that is a REAL user turn: authored by the user,
 * not an `ephemeral` in-band tool result (those are role "user" too), and not
 * a prior post-compact restored-context injection. -1 when none exists. */
function lastRealUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]!;
    if (item.role !== "user") continue;
    if (item.ephemeral === true || item.toolResult) continue;
    // Typed injected notices (task deltas / stale reads / completion blocks)
    // are user-role but not user-authored — anchoring the preserved tail on
    // one would resume the model on bookkeeping instead of its directive.
    if (item.origin) continue;
    if (item.content.startsWith(POST_COMPACT_CONTEXT_PREFIX)) continue;
    return i;
  }
  return -1;
}

function estimateContextTokens(messages: ChatMessage[], summary?: string): number {
  return estimateMessagesTokens(messages) + estimateTextTokens(summary ?? "");
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, item) => total + estimateMessageTokens(item), 0);
}

function estimateMessageTokens(item: ChatMessage): number {
  return estimateTextTokens(`${item.role}: ${item.content}`) + 8;
}

/**
 * Real tokenizer via js-tiktoken (o200k_base — the 2024+ vocabulary used by
 * GPT-4o / GPT-4.1 / o1 / o3). Exact for OpenAI family; for Claude / GLM /
 * Qwen / DeepSeek the error vs each provider's true tokenizer is in the
 * ±10% range, and o200k's CJK compression is ~1.4× denser than cl100k so
 * estimates are noticeably tighter on Chinese-heavy sessions. Lazy-init the
 * encoder so the rank table only loads on the first compaction-relevant
 * call rather than on engine boot.
 */
let cachedEncoder: Tiktoken | undefined;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  if (!cachedEncoder) cachedEncoder = getEncoding("o200k_base");
  return cachedEncoder.encode(text).length;
}

function formatMessagesForSummary(messages: ChatMessage[]): string {
  return messages.map((item) => `[${item.createdAt}] ${item.role}: ${item.content}`).join("\n\n");
}

function extractiveSummary(messages: ChatMessage[], previousSummary?: string): string {
  // Reserve separate space for new requests and progress: a full rolling
  // summary must never consume the entire fallback budget on the next fold.
  const sections = ["Extractive fallback: excerpts only; consult the saved conversation history for omitted details."];
  if (previousSummary) {
    sections.push(`Previous summary:\n${truncateMiddle(previousSummary, 2_000)}`);
  }
  const requests = messages.filter((item) => item.role === "user" && !item.toolResult && !item.ephemeral);
  const userExcerpts = extractiveMessageExcerpts(requests, 3_000);
  // Keep the newest requests at the very end so the next fallback's bounded
  // previous-summary excerpt retains them too, alongside the original goal.
  const suffix = userExcerpts ? `\n\nUser requests:\n${userExcerpts}` : "";
  sections.push("Compacted conversation:");
  const prefix = sections.join("\n\n");
  const requestIds = new Set(requests.map((item) => item.id));
  const progress = extractiveMessageExcerpts(
    messages.filter((item) => !requestIds.has(item.id)),
    COMPACT_SUMMARY_MAX_CHARS - prefix.length - suffix.length - 1,
  );
  return `${prefix}${progress ? `\n${progress}` : ""}${suffix}`;
}

/** Keep the first excerpt and the newest complete excerpts in chronological
 * order. Tool output cannot evict requests, and long messages retain both ends. */
function extractiveMessageExcerpts(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const item of messages) {
    const content = item.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    const role = item.toolResult ? `tool (${item.toolResult.name})` : item.role;
    lines.push(truncateMiddle(`- ${role}: ${content}`, 384));
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;

  const omitted = "... [older messages omitted]";
  let start = 1;
  let length = text.length + omitted.length + 1;
  while (start < lines.length - 1 && length > maxChars) {
    length -= lines[start]!.length + 1;
    start++;
  }
  return [lines[0], omitted, ...lines.slice(start)].join("\n");
}

function lastUserMessageId(messages: ChatMessage[]): string | undefined {
  return [...messages].reverse().find((item) => item.role === "user")?.id;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n... [truncated]\n";
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}
