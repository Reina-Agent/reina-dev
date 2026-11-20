import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import type {
  ChatMessage,
  MessageAttachment,
  ModelConfig,
  ModelRequest,
  ModelStreamHandler,
  ModelToolCall,
  ModelTurn,
  ProviderState,
  ReasoningTrace,
  ToolDescriptor,
  ToolName,
  ToolObservation,
  TokenUsage,
} from "@reina/protocol";
import { errorMessage, createId } from "@reina/protocol";
import { normalizeToolInput, normalizeToolName, parseToolJson, wasJsonParseFallback } from "./tool-compat.js";
import { createProviderFetch, modelApiKey, modelRequestHeaders, providerSdkBaseUrl } from "./connection.js";
import { resolveChatReasoning, resolveOpenAIReasoningEffort, validatedReasoningEffort } from "./reasoning.js";
export { resolveChatReasoning } from "./reasoning.js";

function toModelToolCall(id: string, rawName: string, parsedArgs: unknown, summary: string): ModelToolCall {
  const name = normalizeToolName(rawName);
  const parseFailed = wasJsonParseFallback(parsedArgs);
  const call: ModelToolCall = {
    id,
    name,
    input: normalizeToolInput(name, parsedArgs),
    summary,
  };
  if (parseFailed) call.parseFailed = true;
  return call;
}

import { normalizeToolPairing } from "./tool-pairing.js";
import { ChatToolCallAccumulator, normalizeStreamAPIError, ProviderStreamError, responsesStreamError } from "./stream-compat.js";

type OpenAIChatState = {
  assistantMessage?: OpenAI.Chat.Completions.ChatCompletionMessageParam;
  /** DeepSeek/Qwen/Doubao etc. extend Chat Completions with `reasoning_content`
   * on assistant turns. When that turn carries tool_calls, the follow-up
   * request must echo `reasoning_content` back on the replayed assistant
   * message — otherwise the provider rejects the call with 400. */
  reasoningContent?: string;
  /** Which wire key carried the reasoning inbound (see
   * REASONING_DIALECT_KEYS). The echo above must use the SAME key the
   * endpoint speaks — current vLLM accepts only `reasoning`. Absent =
   * `reasoning_content` (the historical default). */
  reasoningKey?: string;
};

/** The OpenAI-compatible ecosystem never standardized the streamed reasoning
 * field: `reasoning_content` (DeepSeek/Moonshot/most gateways),
 * `reasoning_details` (OpenRouter), `reasoning` (GPT-OSS guidance; current
 * vLLM emits AND accepts only this). Scan in priority order, first string
 * wins — non-string values are skipped (vLLM streams a
 * `reasoning_content: null` placeholder next to `reasoning`; OpenRouter's
 * `reasoning_details` is an array). Mirrors kimi-code's reasoning-key
 * dialect detection. */
const REASONING_DIALECT_KEYS = ["reasoning_content", "reasoning_details", "reasoning"] as const;

function reasoningDialectDelta(delta: Record<string, unknown>): { key: string; text: string } | undefined {
  for (const key of REASONING_DIALECT_KEYS) {
    const value = delta[key];
    if (typeof value === "string" && value.length > 0) return { key, text: value };
  }
  return undefined;
}

type AnthropicState = {
  assistantContent?: Anthropic.Messages.ContentBlock[];
};

/** Within-turn replay state for the Responses API. When a round produces tool
 * calls, we stash that round's assistant output items (reasoning + function_call,
 * in original order) so the NEXT request can re-emit them right before the
 * function_call_output observations. Reasoning items carry `encrypted_content`;
 * replaying them lets the model resume its own chain of thought across the tool
 * call (the gap the chat/Anthropic paths already close via their own state).
 * The function_call items supply the call_id the outputs join on. */
type OpenAIResponsesState = {
  assistantItems?: OpenAI.Responses.ResponseInputItem[];
};

type AnthropicThinkingConfig = { type: "enabled"; budget_tokens: number };
// Newer Claude models (Opus 4.6+/Sonnet 4.6/Fable 5) use *adaptive* thinking:
// the effort level travels in `output_config` instead of a fixed token budget,
// and the model decides how much to think. `display:"summarized"` is required —
// these models default to "omitted", which returns empty thinking blocks.
type AnthropicAdaptiveThinkingConfig = { type: "adaptive"; display: "summarized" };
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
type AnthropicThinkingPlan = {
  thinking: AnthropicThinkingConfig | AnthropicAdaptiveThinkingConfig;
  /** Adaptive models only: effort travels here instead of as a token budget. */
  outputConfig?: { effort: AnthropicEffort };
};

type ReasoningBuf = { buf: string };

/** Append a reasoning delta to a running buffer, guarding against two bridge
 * bugs that produce叠瓦-style duplication in the Thoughts panel:
 *
 *   1. Cumulative-vs-incremental delta. OpenAI-compat layers fronting
 *      DeepSeek-R1, Qwen-QwQ, GLM via `reasoning_content` (and some
 *      Anthropic-compat bridges) sometimes emit the cumulative text on every
 *      event instead of just the new chunk. Detected via `delta.startsWith(prev)`.
 *
 *   2. Tail-prefix overlap. The bridge restarts a chunk and re-emits the
 *      last N chars of the previous delta as the start of the new one. We
 *      strip the overlap only when it's long enough to be unambiguous (≥16
 *      chars) so we don't false-positive on common short repeats.
 *
 * Returns the substring actually appended — call sites forward this to
 * `onEvent` so the renderer's own buffer stays in sync with `state.buf`. */
function appendReasoning(state: ReasoningBuf, delta: string): string {
  if (!delta) return "";
  const prev = state.buf;
  if (!prev) {
    state.buf = delta;
    return delta;
  }
  if (delta.startsWith(prev)) {
    const incremental = delta.slice(prev.length);
    state.buf = delta;
    return incremental;
  }
  const maxOverlap = Math.min(prev.length, delta.length, 256);
  for (let k = maxOverlap; k >= 16; k--) {
    if (prev.endsWith(delta.slice(0, k))) {
      const incremental = delta.slice(k);
      state.buf = prev + incremental;
      return incremental;
    }
  }
  state.buf = prev + delta;
  return delta;
}

export async function nextModelTurn(config: ModelConfig, request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
  return nextModelTurnStream(config, request, undefined, signal);
}

export async function nextModelTurnStream(
  config: ModelConfig,
  request: ModelRequest,
  onEvent?: ModelStreamHandler,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  switch (config.provider) {
    case "deterministic":
      return deterministicTurn(request);
    case "openai-responses":
      return openaiResponsesTurn(config, request, onEvent, signal);
    case "openai-codex-responses":
      // Same Responses streaming path; the codex endpoint/headers and
      // system-prompt placement branch on config.provider inside the turn.
      return openaiResponsesTurn(config, request, onEvent, signal);
    case "openai-chat":
      return openaiChatTurn(config, request, onEvent, signal);
    case "anthropic-messages":
      return anthropicMessagesTurn(config, request, onEvent, signal);
  }
}

function deterministicTurn(request: ModelRequest): ModelTurn {
  if (request.observations.length > 0) {
    return {
      content: [
        "Tool work completed.",
        ...request.observations.map((item) =>
          item.error ? `- ${item.name} failed: ${item.error}` : `- ${item.name} completed.`,
        ),
      ].join("\n"),
      toolCalls: [],
    };
  }

  const prompt = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  // Test hook: drive the engine's abnormal-termination diagnostic without a
  // live model. "stop_reason <reason> [trailing text]" returns a turn with that
  // raw stop reason, optional content, and no tool calls — mirroring a provider
  // that closes the stream early (e.g. `content_filter` from output-side
  // moderation). "stop_reason empty" yields a turn with nothing at all.
  const stopMatch = prompt.match(/^stop_reason\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (stopMatch) {
    const reason = stopMatch[1]!;
    if (reason === "empty") return { toolCalls: [] };
    return { content: stopMatch[2] || undefined, reasoning: "internal planning", toolCalls: [], stopReason: reason };
  }
  const calls = plannedToolsFromPrompt(prompt);
  if (calls.length === 0) {
    return {
      content:
        "The deterministic provider only handles explicit read/list/run/git prompts. Configure a real LLM provider for general reasoning.",
      toolCalls: [],
    };
  }
  return {
    content: "I will inspect the workspace and call the needed tools.",
    toolCalls: calls,
  };
}

/** Parse the deterministic provider's `question` shorthand. Examples:
 *   "Pick one?"                           → single text question, no options
 *   "Pick one? | Cat | Dog | Bird"        → single-select with 3 options
 *   "multi Features? | Auth | Logs | UI"  → multi-select (leading "multi ")
 *   "Pick? | Cat: cute and small | Dog: loyal" → label + description (":")
 *   "Pick? | Cat: small :: ASCII art..."   → label + description + preview ("::")
 * The format is for the deterministic provider only — real LLMs build the
 * JSON directly. */
function parseDeterministicQuestion(raw: string): {
  question: string;
  options?: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
} {
  const parts = raw.split("|").map((s) => s.trim());
  let question = parts.shift() ?? "";
  let multiSelect = false;
  if (/^multi\s+/i.test(question)) {
    multiSelect = true;
    question = question.replace(/^multi\s+/i, "");
  }
  if (parts.length === 0) return { question };
  const options = parts.filter(Boolean).map((part) => {
    const previewIdx = part.indexOf("::");
    let body = part;
    let preview: string | undefined;
    if (previewIdx !== -1) {
      body = part.slice(0, previewIdx).trim();
      preview = part.slice(previewIdx + 2).trim() || undefined;
    }
    const descIdx = body.indexOf(":");
    if (descIdx === -1) return { label: body, ...(preview ? { preview } : {}) };
    const label = body.slice(0, descIdx).trim();
    const description = body.slice(descIdx + 1).trim() || undefined;
    return { label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) };
  });
  return { question, options, ...(multiSelect ? { multiSelect } : {}) };
}

function plannedToolsFromPrompt(prompt: string): ModelToolCall[] {
  const lower = prompt.toLowerCase();
  if (lower.includes("git status")) return [toolCall("run_shell", { command: "git status --short --branch" }, "Check git status")];
  if (lower.includes("git diff")) return [toolCall("run_shell", { command: "git diff" }, "Read git diff")];
  if (lower.includes("repo overview") || lower.includes("project overview")) return [toolCall("read_file", { path: "." }, "List workspace files")];
  if (lower.startsWith("dup_read ")) {
    // Two IDENTICAL calls in one assistant batch — exercises the engine's
    // same-batch tool dedup (the twin must mirror the original's result, not
    // re-execute). Test-only, like the async_* directives below.
    const p = prompt.slice("dup_read ".length).trim();
    return [toolCall("read_file", { path: p }, "Read file"), toolCall("read_file", { path: p }, "Read file")];
  }
  if (lower.startsWith("question ")) return [toolCall("question", parseDeterministicQuestion(prompt.slice(9)), "Ask user a question")];
  if (lower.startsWith("plan ")) return [toolCall("plan", { content: prompt.slice(5), status: "draft" }, "Update plan")];
  if (lower.startsWith("exit plan ")) return [toolCall("exit_plan_mode", { plan: prompt.slice(10) }, "Submit plan for approval")];
  if (lower.startsWith("task ")) return [toolCall("task", { description: prompt.slice(5), agent: "default" }, "Run subagent task")];
  if (lower.startsWith("async_start ")) {
    // Format: "async_start [<agent>] <description>" — agent in brackets is optional
    const rest = prompt.slice("async_start ".length);
    const agentMatch = rest.match(/^\[(\w+)\]\s*/);
    const agent = agentMatch?.[1] ?? "default";
    const description = agentMatch ? rest.slice(agentMatch[0].length) : rest;
    return [toolCall("start_async_task", { description, agent }, "Launch async subagent")];
  }
  if (lower.startsWith("async_start_bg ")) {
    // Same as async_start but explicitly opts into background mode — the
    // tool returns the dispatch handle immediately without blocking on
    // the child. Used by tests that drive the lifecycle by hand.
    const rest = prompt.slice("async_start_bg ".length);
    const agentMatch = rest.match(/^\[(\w+)\]\s*/);
    const agent = agentMatch?.[1] ?? "default";
    const description = agentMatch ? rest.slice(agentMatch[0].length) : rest;
    return [toolCall("start_async_task", { description, agent, background: true }, "Launch async subagent (background)")];
  }
  if (lower.startsWith("async_start_isolated ")) {
    const description = prompt.slice("async_start_isolated ".length);
    return [toolCall("start_async_task", { description, agent: "default", isolate: "worktree" }, "Launch isolated async subagent")];
  }
  if (lower.startsWith("async_check ")) {
    return [toolCall("check_async_task", { taskId: prompt.slice("async_check ".length).trim() }, "Check async task")];
  }
  if (lower.startsWith("async_cancel ")) {
    return [toolCall("cancel_async_task", { taskId: prompt.slice("async_cancel ".length).trim() }, "Cancel async task")];
  }
  if (lower === "async_list" || lower.startsWith("async_list ")) {
    return [toolCall("list_async_tasks", {}, "List async tasks")];
  }
  if (lower === "async_wait" || lower.startsWith("async_wait ")) {
    // Format: "async_wait" (all running) or "async_wait <id1>,<id2>[ timeout=<ms>]"
    const rest = prompt.slice("async_wait".length).trim();
    if (!rest) return [toolCall("wait_async_tasks", {}, "Wait for async tasks")];
    const parts = rest.split(/\s+/);
    const idsPart = parts[0] ?? "";
    const timeoutPart = parts.find((p) => p.startsWith("timeout="));
    const input: Record<string, unknown> = {};
    const ids = idsPart.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) input.taskIds = ids;
    if (timeoutPart) {
      const parsed = Number.parseInt(timeoutPart.slice("timeout=".length), 10);
      if (Number.isFinite(parsed)) input.timeoutMs = parsed;
    }
    return [toolCall("wait_async_tasks", input, "Wait for async tasks")];
  }
  if (lower.startsWith("async_parallel ")) {
    // Format: "async_parallel <desc1> | <desc2> | ..."
    const descs = prompt.slice("async_parallel ".length).split("|").map((s) => s.trim()).filter(Boolean);
    return descs.map((desc) => toolCall("start_async_task", { description: desc, agent: "default" }, "Launch async subagent"));
  }
  if (lower.startsWith("async_parallel_bg ")) {
    // Background variant: each dispatch returns immediately. Lets tests
    // poke at the running-task lifecycle without the sync default
    // blocking out the model loop.
    const descs = prompt.slice("async_parallel_bg ".length).split("|").map((s) => s.trim()).filter(Boolean);
    return descs.map((desc) => toolCall("start_async_task", { description: desc, agent: "plan", background: true }, "Launch async subagent (background)"));
  }
  if (lower.includes("readme")) return [toolCall("read_file", { path: "README.md" }, "Read README")];
  if (lower.startsWith("readpath ")) return [toolCall("read_file", { path: prompt.slice(9).trim() }, "Read file by path")];
  if (lower.includes("package.json")) return [toolCall("read_file", { path: "package.json" }, "Read package.json")];
  if (lower.includes("code search")) {
    const query = prompt.split(/\s+/).at(-1) ?? "";
    return [toolCall("run_shell", { command: `rg -n ${JSON.stringify(query)}` }, "Search code with context")];
  }
  if (lower.includes("mcp resources")) return [toolCall("mcp_list_resources", {}, "List MCP resources")];
  if (lower.includes("task output")) return [toolCall("task_output", { taskId: prompt.split(/\s+/).at(-1) ?? "" }, "Read background task output")];
  if (lower.includes("grep")) {
    const query = prompt.split(/\s+/).at(-1) ?? "";
    return [toolCall("run_shell", { command: `rg -n ${JSON.stringify(query)}` }, "Search workspace")];
  }
  if (lower.startsWith("run ")) return [toolCall("run_shell", { command: prompt.slice(4) }, "Run shell command")];
  if (lower.includes("list") || lower.includes("tree") || lower.includes("directory")) {
    return [toolCall("read_file", { path: "." }, "List workspace files")];
  }
  return [];
}

function toolCall(name: ToolName, input: unknown, summary: string): ModelToolCall {
  return { id: createId("call"), name, input, summary };
}

/** Max times we re-issue a request whose stream dropped mid-flight. Like Codex
 * (`stream_max_retries`) we re-send the WHOLE request and let the model
 * regenerate — completions are stateless, so this is safe. Override with
 * `REINA_STREAM_MAX_RETRIES` (0 disables). */
const STREAM_MAX_RETRIES = 2;

function nonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function positiveIntEnv(name: string): number | undefined {
  const n = nonNegativeIntEnv(name);
  return n !== undefined && n > 0 ? n : undefined;
}

/** SDK-level retries for connect-time failures, default OFF: the SDKs' retry
 * backoff sleeps ignore our AbortSignal and honor `retry-after` up to ~60s, so
 * Esc during a 429 backoff hung until it elapsed. `driveStreamingTurn` owns
 * connect-time retries instead, with an abortable backoff (pi #6980 made the
 * same move: SDK maxRetries pinned to 0, retries replicated locally).
 * `REINA_PROVIDER_MAX_RETRIES` restores SDK retries if ever needed. */
const PROVIDER_MAX_RETRIES = 0;

function providerMaxRetries(): number {
  return nonNegativeIntEnv("REINA_PROVIDER_MAX_RETRIES") ?? PROVIDER_MAX_RETRIES;
}

/** Per-request timeout (ms) handed to the provider SDKs, mirroring pi's
 * `retry.provider.timeoutMs`. Unset by default — the SDK's own default applies
 * (OpenAI ~10min, Anthropic scales with max_tokens) — and overridable via
 * `REINA_PROVIDER_TIMEOUT_MS`. A flaky relay that accepts the request then holds
 * the connection open without finishing the response otherwise only unblocks on
 * the coarse SDK default or a manual Stop; a tighter bound surfaces the stall as
 * a timeout error, which `isRetryableStreamError` classifies retryable so
 * `driveStreamingTurn` re-issues the whole request (Codex model). */
function providerTimeoutMs(): number | undefined {
  return positiveIntEnv("REINA_PROVIDER_TIMEOUT_MS");
}

/** Spread helper for an SDK per-request options object: `{ timeout }` when
 * configured, else `{}` so we never override the SDK default unless opted in. */
function requestTimeoutOption(): { timeout?: number } {
  const ms = providerTimeoutMs();
  return ms !== undefined ? { timeout: ms } : {};
}

function resolveMaxOutputTokens(config: ModelConfig): number | undefined {
  return config.maxOutputTokens ?? positiveIntEnv("REINA_MAX_OUTPUT_TOKENS");
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
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

/** Exponential backoff with jitter, capped at 8s — mirrors Codex's
 * `backoff(retries)` for stream reconnect attempts. */
function streamBackoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

/** Terminal Codex/ChatGPT limit markers — a usage cap or billing state that
 * won't clear on retry, as opposed to a transient `rate_limit_exceeded` (too
 * fast → worth retrying). Mirrors pi's `isTerminalRateLimitError` set so we
 * don't burn retries on an exhausted account. */
function isTerminalCodexLimit(code: string, message: string): boolean {
  return /usage_limit_reached|usage_not_included|insufficient_quota|GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|out of budget|quota exceeded|billing/i.test(
    `${code} ${message}`,
  );
}

/** Quota/billing exhaustion (OpenAI 429 `insufficient_quota`, Anthropic "credit
 * balance is too low", ChatGPT Codex usage-limit codes) is a persistent account
 * state, not a transient blip, so re-issuing just burns attempts and delays the
 * error the user must act on. */
function isQuotaOrBillingError(cause: unknown): boolean {
  if (cause instanceof OpenAI.APIError) {
    if (cause.code === "insufficient_quota") return true;
    const body = cause.error as { code?: string; type?: string; message?: string } | undefined;
    if (isTerminalCodexLimit(`${body?.code ?? ""} ${body?.type ?? ""}`, body?.message || "")) return true;
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  return message.includes("insufficient_quota") || message.includes("credit balance") || isTerminalCodexLimit("", message);
}

/** Rewrite a Codex usage-limit / billing 429 into a human-readable message
 * (preserving the error TYPE so retry/auth classification still works) — the
 * raw backend body is opaque JSON. The limit body carries `plan_type` and an
 * epoch-seconds `resets_at`; surface the plan and an ETA. No-op off the codex
 * path or for any non-limit error. Mirrors pi's `parseErrorResponse`. */
export function enrichCodexLimitError(cause: unknown, isCodex: boolean): unknown {
  if (!isCodex || !(cause instanceof OpenAI.APIError)) return cause;
  const body = cause.error as { code?: string; type?: string; plan_type?: string; resets_at?: number } | undefined;
  const code = body?.code || body?.type || "";
  const isLimit = /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || cause.status === 429;
  if (!isLimit) return cause;
  const plan = body?.plan_type ? ` (${body.plan_type.toLowerCase()} plan)` : "";
  const mins =
    typeof body?.resets_at === "number" ? Math.max(0, Math.round((body.resets_at * 1000 - Date.now()) / 60000)) : undefined;
  const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
  cause.message = `You've hit your ChatGPT usage limit${plan}.${when}`.trim();
  return cause;
}

/** Transport / premature-stream-end markers that warrant a retry even when a
 * relay wrapped the failure in a non-5xx HTTP status (e.g. an upstream socket
 * drop returned as a 400, or a "you can retry your request" hint). Mirrors pi's
 * RETRYABLE_PROVIDER_ERROR_PATTERN so a stalled-then-timed-out stream, a dropped
 * socket, or an early EOF all re-issue the request instead of dead-ending the
 * turn. Quota/billing exhaustion is excluded separately (it won't clear). */
const RETRYABLE_STREAM_TEXT =
  /overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(error|refused|lost|reset)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang ?up|timed?.?out|timeout|terminated|websocket.?(closed|error)|ended without|stream (ended|closed) before|http2 request did not get a response|you can retry your request|(try|please retry) your request/i;

/** A dropped/timed-out stream or transient 5xx/429 is worth retrying; an
 * outright 4xx (bad request, auth) or a quota/billing 429 is not — re-issuing
 * would just fail again. */
export function isRetryableStreamError(error: unknown): boolean {
  const cause = error instanceof MidStreamError ? error.cause : error;
  if (isQuotaOrBillingError(cause)) return false;
  if (cause instanceof ProviderStreamError) return cause.status === 429 || (cause.status !== undefined && cause.status >= 500);
  // Transport / premature-end text is retryable regardless of any HTTP status a
  // relay may have wrapped it in (pi parity) — covers SDK timeouts surfaced as
  // APIConnectionTimeoutError and proxy-wrapped upstream drops.
  if (RETRYABLE_STREAM_TEXT.test(errorMessage(cause))) return true;
  if (cause instanceof OpenAI.APIError || cause instanceof Anthropic.APIError) {
    const status = (cause as { status?: number }).status;
    if (typeof status === "number") return status === 429 || status >= 500;
    return true; // connection/timeout errors carry no HTTP status
  }
  return true; // network / unknown errors
}

/** A 401 means the API key / OAuth access token was rejected. For subscription
 * (OAuth) models the engine treats this as a cue to refresh the short-lived
 * access token from the main process and retry once, rather than ending the
 * turn — the stored token simply expired between turns. */
export function isAuthError(error: unknown): boolean {
  const cause = error instanceof MidStreamError ? error.cause : error;
  if (cause instanceof OpenAI.APIError || cause instanceof Anthropic.APIError) {
    return (cause as { status?: number }).status === 401;
  }
  return false;
}

export function isContextWindowError(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  if (!text) return false;
  if (isQuotaOrBillingError(error) || text.includes("rate limit")) return false;
  return (
    text.includes("context_length_exceeded") ||
    text.includes("context window exceeded") ||
    text.includes("context length exceeded") ||
    text.includes("maximum context length") ||
    text.includes("maximum context window") ||
    text.includes("prompt is too long") ||
    text.includes("input is too long") ||
    text.includes("request is too long") ||
    text.includes("too many tokens") ||
    /context (length|window).*(exceed|too long|overflow|larger)/.test(text) ||
    /(prompt|input|request|messages?).*(exceed|too long).*(context|token)/.test(text) ||
    /tokens?.*(exceed|larger than|greater than).*(context|maximum|max)/.test(text)
  );
}

/** Marks a failure that happened *after* the request was accepted and the
 * stream began — a dropped connection mid-response. Kept distinct from
 * connect-time errors (which propagate to callers unwrapped) so error text
 * shown to the user reflects the original cause. */
class MidStreamError extends Error {
  constructor(readonly cause: unknown) {
    super(errorMessage(cause));
    this.name = "MidStreamError";
  }
}

/** Shared stream-recovery policy for every provider — the Codex model.
 *
 * `runAttempt(attempt)` issues ONE whole request and streams it into the
 * caller's accumulators. On a mid-stream drop it throws `MidStreamError`; the
 * driver then re-issues the entire request (with backoff), exactly like Codex
 * rebuilding the prompt from history — we do NOT stitch a partial + "continue".
 * On `attempt > 0` the provider must reset its accumulators and emit a
 * `stream-reset` event so the renderer discards the partial it already showed.
 * Connect-time failures are retried HERE too (the SDK clients run with
 * maxRetries 0 — their backoff sleeps ignore our AbortSignal and honor
 * retry-after up to ~60s, so Esc hung until they elapsed); they still
 * propagate unwrapped when retries are exhausted. Output-token truncation is
 * NOT an error here — the provider records it on the returned
 * `ModelTurn.truncated`. */
async function driveStreamingTurn(
  runAttempt: (attempt: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const maxRetries = nonNegativeIntEnv("REINA_STREAM_MAX_RETRIES") ?? STREAM_MAX_RETRIES;
  let attempt = 0;
  for (;;) {
    try {
      await runAttempt(attempt);
      return;
    } catch (error) {
      const cause = error instanceof MidStreamError ? error.cause : error;
      // A user interrupt or session teardown fired the abort signal — surface
      // the failure now instead of re-issuing a request that would just abort
      // again (and sleeping through the backoff first).
      if (signal?.aborted) throw cause;
      if (attempt < maxRetries && isRetryableStreamError(error)) {
        attempt += 1;
        // Abortable: Esc during the backoff resolves immediately, and the
        // post-sleep aborted check below surfaces the failure without another
        // request.
        await sleepMs(streamBackoffMs(attempt), signal);
        if (signal?.aborted) throw cause;
        continue;
      }
      throw cause;
    }
  }
}

async function openaiChatTurn(config: ModelConfig, request: ModelRequest, onEvent?: ModelStreamHandler, signal?: AbortSignal): Promise<ModelTurn> {
  const client = new OpenAI({
    apiKey: apiKey(config, "OPENAI_API_KEY"),
    baseURL: providerSdkBaseUrl(config),
    fetch: createProviderFetch(config),
    maxRetries: providerMaxRetries(),
    defaultHeaders: modelRequestHeaders(config, apiKey(config, "OPENAI_API_KEY"), {
      "User-Agent": "reina/0.1.0",
      "x-app": "desktop",
      ...openaiAffinityHeaders(request),
    }),
  });
  const state = stateData<OpenAIChatState>(request.providerState, "openai-chat");
  // Bidirectional pairing normalization (see tool-pairing.ts): matched pairs
  // replay natively, calls missing a result get a synthetic output, orphan
  // observations degrade to text. The previous all-or-nothing gate cost the
  // whole round its native pairing whenever ONE follow-up didn't match.
  const chatCallIds = openAIChatToolCallIds(state.assistantMessage);
  const pairing = request.observations.length > 0 ? normalizeToolPairing(chatCallIds, request.observations) : undefined;
  const replayAssistantMessage =
    pairing && chatCallIds.length > 0
      ? (state.assistantMessage as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam)
      : undefined;
  const reminderText = formatSystemReminders(request.systemReminders);

  // Build the message list. `useReplay` toggles the native tool_call replay
  // shape (some OpenAI-compatible backends 400 on it).
  const historicalReasoning = hasOpenAIChatHistoricalReasoning(request.messages, config);
  const buildMessages = (
    useReplay: boolean,
    replayHistoricalReasoning = true,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
    // useReplay=false is the conservative shape for backends that 400 on
    // native tool messages — it strips BOTH the within-turn replay and the
    // native tool HISTORY rendering in one toggle.
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...toOpenAIChatMessages(request.messages, config, useReplay, replayHistoricalReasoning),
    ];
    if (useReplay && replayAssistantMessage && pairing) {
      const replayMessage = state.reasoningContent
        ? ({
            ...replayAssistantMessage,
            [state.reasoningKey ?? "reasoning_content"]: state.reasoningContent,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam)
        : replayAssistantMessage;
      msgs.push(replayMessage);
      msgs.push(...pairing.matched.map(openAIToolObservation));
      msgs.push(
        ...pairing.synthesized.map((synthetic) => ({
          role: "tool" as const,
          tool_call_id: synthetic.callId,
          content: synthetic.output,
        })),
      );
      msgs.push(...formatObservationMessages(pairing.orphans));
      // Tool media goes AFTER every role:"tool" message so the tool block stays
      // contiguous under its assistant tool_calls (a user message wedged
      // between tool results would break OpenAI's pairing).
      for (const observation of pairing.matched) {
        msgs.push(...openAIChatToolMediaMessages(observation.attachments));
      }
    } else {
      msgs.push(...formatObservationMessages(request.observations));
      for (const observation of request.observations) {
        msgs.push(...openAIChatToolMediaMessages(observation.attachments));
      }
    }
    if (reminderText) msgs.push({ role: "user", content: reminderText });
    return msgs;
  };

  // One API / New API-class gateways 400 when a replayed assistant message
  // carries `reasoning_content` but the request omits `reasoning_effort`
  // (kimi-code#1616). Auto-pin "medium" when this turn replays reasoning
  // content and the config didn't set an effort — an explicit value (incl.
  // "off") is obeyed verbatim, so the auto-pin only fires on the unset path.
  const fallbackEffort =
    (config.reasoningEffort === undefined &&
      ((state.reasoningContent && replayAssistantMessage && pairing) || historicalReasoning)
      ? ("medium" as const)
      : undefined);
  const chatReasoning = resolveChatReasoning(config, fallbackEffort);
  const cacheKey = openaiConversationCacheKey(request);
  const maxOutputTokens = resolveMaxOutputTokens(config);
  const chatRequest = {
    model: config.model,
    tools: request.tools.map(openAIChatTool),
    ...(request.tools.length > 0 ? { tool_choice: "auto" as const } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...chatReasoning.fields,
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
  } satisfies Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "messages"> & { prompt_cache_key?: string };

  const content: string[] = [];
  const reasoningBuf: ReasoningBuf = { buf: "" };
  const toolCalls = new ChatToolCallAccumulator();
  let chatUsage: TokenUsage | undefined;
  let truncated = false;
  let stopReason: string | undefined;
  // First reasoning-bearing key observed on this stream; locked for the turn so
  // the tool-round echo goes back under the dialect the endpoint speaks.
  let reasoningKey: string | undefined;

  await driveStreamingTurn(async (attempt) => {
    if (attempt > 0) {
      // Re-issuing the whole request — drop the partial from the failed attempt
      // (our accumulators) and tell the renderer to discard what it showed.
      content.length = 0;
      reasoningBuf.buf = "";
      toolCalls.clear();
      chatUsage = undefined;
      truncated = false;
      stopReason = undefined;
      reasoningKey = undefined;
      onEvent?.({ type: "stream-reset" });
    }
    // Open the stream, transparently falling back to the no-native-tool-replay
    // shape if the provider 400s on replayed tool_calls. The explicit
    // `stream: true` after the spread pins the streaming overload so `response`
    // is async-iterable; connect-time failures throw raw (SDK already retried).
    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      response = await client.chat.completions.create(
        { ...chatRequest, messages: buildMessages(true), stream: true },
        { signal, ...requestTimeoutOption() },
      );
    } catch (error) {
      if (canRetryOpenAIChatWithoutHistoricalReasoning(error, historicalReasoning)) {
        try {
          response = await client.chat.completions.create(
            { ...chatRequest, messages: buildMessages(true, false), stream: true },
            { signal, ...requestTimeoutOption() },
          );
        } catch (fallbackError) {
          if (!canRetryOpenAIChatWithoutNativeToolReplay(fallbackError, request.observations)) throw fallbackError;
          response = await client.chat.completions.create(
            { ...chatRequest, messages: buildMessages(false, false), stream: true },
            { signal, ...requestTimeoutOption() },
          );
        }
      } else {
        if (!canRetryOpenAIChatWithoutNativeToolReplay(error, request.observations)) throw error;
        response = await client.chat.completions.create(
          { ...chatRequest, messages: buildMessages(false, false), stream: true },
          { signal, ...requestTimeoutOption() },
        );
      }
    }
    let finishReason: string | null | undefined;
    try {
      for await (const chunk of response) {
        if (chunk.usage) chatUsage = normalizeOpenAIUsage(chunk.usage) ?? chatUsage;
        const choice = chunk.choices[0];
        // Some providers (e.g. Moonshot) hang usage on the CHOICE instead of
        // the chunk's top level — same fallback as pi's openai-completions.
        if (!chunk.usage && choice) {
          const choiceUsage = (choice as { usage?: unknown }).usage;
          if (choiceUsage) chatUsage = normalizeOpenAIUsage(choiceUsage) ?? chatUsage;
        }
        // Keep collecting late usage, but do not mutate a finished answer.
        if (finishReason) continue;
        const delta = choice?.delta;
        if (!delta) {
          finishReason = choice?.finish_reason;
          continue;
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content.push(delta.content);
          onEvent?.({ type: "text-delta", text: delta.content });
        }
        const reasoningDelta = reasoningDialectDelta(delta as Record<string, unknown>);
        if (reasoningDelta) {
          reasoningKey ??= reasoningDelta.key;
          const emit = appendReasoning(reasoningBuf, reasoningDelta.text);
          if (emit) onEvent?.({ type: "reasoning-delta", text: emit });
        }
        for (const toolCall of delta.tool_calls ?? []) {
          const current = toolCalls.append(toolCall, delta.tool_calls!.length);
          if (toolCall.function?.arguments) {
            onEvent?.({
              type: "tool-input-delta",
              index: current.index,
              id: current.id,
              name: current.name,
              delta: toolCall.function.arguments,
              input: current.arguments,
            });
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (error) {
      if (!finishReason) {
        const cause = normalizeStreamAPIError(error);
        if (cause instanceof ProviderStreamError) throw cause;
        throw new MidStreamError(cause);
      }
    }
    // The stream closed without ever sending a finish_reason — an OpenAI-compat
    // bridge that EOF'd the SSE connection with no terminal signal. Like Codex
    // ("stream closed before response.completed") and pi ("Stream ended without
    // finish_reason"), treat it as a mid-stream drop so driveStreamingTurn
    // re-issues the request instead of silently returning a half-finished turn.
    if (!finishReason) {
      throw new MidStreamError(new Error("stream closed before finish_reason"));
    }
    truncated = finishReason === "length";
    stopReason = finishReason ?? undefined;
  }, signal);

  const assistantContent = content.join("");
  const message = {
    role: "assistant",
    content: assistantContent || null,
    tool_calls: toolCalls.complete()
      .map((call) => ({
        id: call.id!,
        type: "function" as const,
        function: {
          name: call.name!,
          arguments: call.arguments,
        },
      })),
  } satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam;
  const assistantMessage = message.tool_calls?.length ? message : undefined;
  const assistantReasoning = reasoningBuf.buf;
  return {
    content: assistantContent || undefined,
    reasoning: assistantReasoning || undefined,
    // Structured trace for cross-turn replay: chat backends echo reasoning back
    // as `reasoning_content` on the assistant message (DeepSeek/Qwen/GLM). Plain
    // text — no signature — but still provider+model-scoped so the converter
    // only replays it to the same backend. Stage 3 reads `blocks.reasoningContent`.
    reasoningTrace: assistantReasoning
      ? {
          provider: config.provider,
          model: config.model,
          blocks: { reasoningContent: assistantReasoning, reasoningKey: reasoningKey ?? "reasoning_content" },
        }
      : undefined,
    toolCalls:
      message.tool_calls?.map((call) =>
        toModelToolCall(call.id, call.function.name, parseToolJson(call.function.arguments), `Call ${call.function.name}`),
      ) ?? [],
    providerState: assistantMessage
      ? stateFor("openai-chat", {
          assistantMessage,
          ...(assistantReasoning ? { reasoningContent: assistantReasoning, reasoningKey } : {}),
        })
      : undefined,
    usage: chatUsage,
    truncated,
    stopReason,
  };
}

// Subscription User-Agents come live from the main process (built from the npm
// package version) via `config.subscriptionUserAgent`. These literals are only a
// last resort for when no live value was injected (e.g. unit tests, or a request
// that didn't go through subscription resolution) — production always carries the
// live one. Env vars pin a specific value if ever needed.
const CODEX_FALLBACK_USER_AGENT = "codex_cli_rs/0.138.0 (Ubuntu 22.4.0; x86_64) xterm-256color";
const CLAUDE_FALLBACK_USER_AGENT = "claude-cli/2.1.161 (external, cli)";

/** User-Agent for the Codex (ChatGPT) responses path. ChatGPT's backend
 * fingerprints this against the real `codex_cli_rs` client (originator + UA);
 * prefer the live value injected by main, then an env override, then a realistic
 * fallback. */
function codexRequestUserAgent(config: ModelConfig): string {
  return process.env.REINA_CODEX_USER_AGENT?.trim() || config.subscriptionUserAgent?.trim() || CODEX_FALLBACK_USER_AGENT;
}

/** User-Agent for the Anthropic OAuth (Claude Code) path — Claude Code-scoped
 * tokens are validated against a `claude-cli/x.y.z` UA. Prefer the live value
 * from main, then an env override, then a realistic fallback. */
function claudeRequestUserAgent(config: ModelConfig): string {
  return process.env.REINA_CLAUDE_USER_AGENT?.trim() || config.subscriptionUserAgent?.trim() || CLAUDE_FALLBACK_USER_AGENT;
}

/** Stable per-conversation uuid derived from the engine session id. Used
 * wherever a request must carry ONE identity for the whole conversation —
 * the Codex backend's `session_id`/`conversation_id` headers and
 * `prompt_cache_key`, and the Claude OAuth `metadata.user_id` session
 * segment. The real CLIs pin these per conversation; regenerating per
 * request hands every turn to a potentially different backend route, so the
 * prompt cache never warms (cached_tokens ≈ 0 while each turn re-bills the
 * full replayed history). Reina session ids are `ses_<uuid>`, so reuse that
 * uuid verbatim (stable across process restarts too); any other shape hashes
 * into a stable uuid-v4 layout. One-off requests without a sessionId (title,
 * compaction) keep the fresh-uuid behavior. */
function conversationUuid(sessionId: string | undefined): string {
  if (!sessionId) return globalThis.crypto.randomUUID();
  const bare = sessionId.replace(/^ses_/, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare)) return bare.toLowerCase();
  const hex = createHash("sha256").update(sessionId).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function openaiResponsesTurn(config: ModelConfig, request: ModelRequest, onEvent?: ModelStreamHandler, signal?: AbortSignal): Promise<ModelTurn> {
  // Codex = a ChatGPT subscription speaking the Responses API against
  // chatgpt.com/backend-api/codex, authed with an OAuth Bearer token + a
  // `chatgpt-account-id` header. The stream parsing, reasoning replay, and
  // tool-call extraction below are identical to the api.openai.com path; only
  // the client endpoint/headers and the system-prompt placement differ.
  const isCodex = config.provider === "openai-codex-responses";
  const codexSessionId = isCodex ? conversationUuid(request.sessionId) : undefined;
  const client = new OpenAI({
    apiKey: apiKey(config, "OPENAI_API_KEY"),
    baseURL: providerSdkBaseUrl(config),
    fetch: createProviderFetch(config),
    maxRetries: providerMaxRetries(),
    defaultHeaders: modelRequestHeaders(config, apiKey(config, "OPENAI_API_KEY"), isCodex
      ? {
          // The SDK already sends `Authorization: Bearer <apiKey>`; the access
          // token is a ChatGPT OAuth JWT, so Bearer is exactly what Codex wants.
          "chatgpt-account-id": config.accountId ?? "",
          // Forge the official Codex CLI fingerprint. ChatGPT's codex/responses
          // backend gates on the originator + User-Agent looking like the real
          // `codex_cli_rs` client; anything else risks being treated as a
          // non-official client (and mis-attributed off your plan limits).
          originator: "codex_cli_rs",
          "User-Agent": codexRequestUserAgent(config),
          "OpenAI-Beta": "responses=experimental",
          // Underscore form matches the real Codex CLI traffic (sub2api documents
          // needing `underscores_in_headers on` in nginx for exactly this header).
          // The real CLI sends session_id + conversation_id together.
          session_id: codexSessionId!,
          conversation_id: codexSessionId!,
        }
      : {
          "User-Agent": "reina/0.1.0",
          "x-app": "desktop",
          ...openaiAffinityHeaders(request),
        }),
  });
  const reasoning = openAIReasoningEffort(config);
  const state = stateData<OpenAIResponsesState>(request.providerState, "openai-responses");
  // `"none"` is an explicit thinking-OFF encoding (offEffort), not thinking on.
  const replay = reasoningReplay(config, request, reasoning !== undefined && reasoning !== "none");
  const cacheKey = openaiConversationCacheKey(request);
  const reminderText = formatSystemReminders(request.systemReminders);
  const maxOutputTokens = resolveMaxOutputTokens(config);
  // Bidirectional pairing normalization (see tool-pairing.ts): matched pairs
  // replay natively, calls missing a result get a synthetic output, orphan
  // observations degrade to text.
  const responsesCallIds = responsesFunctionCallIds(state.assistantItems);
  const responsesPairing =
    request.observations.length > 0 ? normalizeToolPairing(responsesCallIds, request.observations) : undefined;
  const baseInput: OpenAI.Responses.ResponseInputItem[] = [
    // Codex carries the system prompt in `instructions` (set on the request
    // body below); sending it as a system input item too would double-count it.
    ...(isCodex ? [] : [{ role: "system" as const, content: request.systemPrompt }]),
    ...request.messages.flatMap((message): OpenAI.Responses.ResponseInputItem[] => {
      if (isVacuousAssistantMessage(message)) return [];
      // Structured tool history (ChatMessage.toolResult): render the pair
      // natively — the model sees its own past calls in the format it was
      // trained on instead of a flattened text transcript. Both sides derive
      // from ONE message, so the pair can never be half-compacted. Messages
      // from sessions persisted before the field existed take the text path
      // below unchanged.
      if (message.toolResult) {
        return [
          {
            type: "function_call" as const,
            call_id: message.toolResult.callId,
            name: message.toolResult.name,
            arguments: JSON.stringify(message.toolResult.input ?? {}),
          },
          {
            type: "function_call_output" as const,
            call_id: message.toolResult.callId,
            output: message.toolResult.output ?? message.content,
          },
          // Media (image/PDF) the tool returned rides as a follow-up user item —
          // the Responses function_call_output channel is text-only.
          ...openAIResponsesToolMediaItems(message.toolResult.attachments),
        ];
      }
      const role = openAIResponseRole(message);
      const item: OpenAI.Responses.ResponseInputItem =
        role === "user" && message.attachments && message.attachments.length > 0
          ? { role, content: openAIResponsesUserContent(message.content, message.attachments) }
          : { role, content: message.content };
      // Cross-turn replay: emit the prior turn's encrypted reasoning items right
      // before the assistant message they preceded, so the model resumes its own
      // chain of thought. Gated to non-empty content (a flattened tool-call round
      // has no message to anchor the reasoning to; that case replays via state).
      if (message.content) {
        const blocks = replayableTrace(message, replay) as OpenAI.Responses.ResponseInputItem[] | undefined;
        if (blocks) {
          // Traces that carry the original assistant message item (msg_ id)
          // replay the item stream verbatim — pi-style — and drop the flattened
          // role message (the item already holds the text, and engine-appended
          // ⚠️ dead-turn notices stay out of model context). Older traces
          // (reasoning items only) keep the anchored-role-message shape.
          const hasMessageItem = blocks.some((block) => (block as { type?: string }).type === "message");
          return hasMessageItem ? blocks : [...blocks, item];
        }
        // Model switched mid-session: downgrade the unreplayable trace's plain
        // reasoning text into the assistant message for continuity.
        const downgraded = downgradedReasoning(message, replay.config);
        if (downgraded) return [{ role, content: `${downgraded}\n\n${message.content}` }];
      }
      return [item];
    }),
    // Within-turn replay: re-emit the prior round's assistant items (reasoning +
    // function_call, in original order) right before the matching outputs, so
    // the model resumes its own chain of thought across the tool call and the
    // function_call_output items have the function_call they join to. The
    // Responses API is an item list (not alternating roles), so emitting these
    // after the history messages is well-formed. Pairing is normalized first:
    // matched pairs stay native, a call whose result went missing gets a
    // synthetic output (else "No tool output found for function call"), and an
    // orphan observation degrades to text (else "No tool call found for
    // function call output with call_id ...").
    ...(responsesPairing && responsesCallIds.length > 0 ? state.assistantItems! : []),
    ...(responsesPairing
      ? [
          ...responsesPairing.matched.map((observation) => ({
            type: "function_call_output" as const,
            call_id: observation.callId,
            output: observation.output ?? observation.error ?? "",
          })),
          ...responsesPairing.synthesized.map((synthetic) => ({
            type: "function_call_output" as const,
            call_id: synthetic.callId,
            output: synthetic.output,
          })),
          // Tool media as follow-up user items, after every function_call_output
          // so each output stays joined to its function_call by call_id.
          ...responsesPairing.matched.flatMap((observation) => openAIResponsesToolMediaItems(observation.attachments)),
          ...(responsesPairing.orphans.length > 0
            ? [{ role: "user" as const, content: responsesPairing.orphans.map(formatObservation).join("\n\n") }]
            : []),
        ]
      : []),
    ...(reminderText ? [{ role: "user" as const, content: reminderText }] : []),
  ];
  const content: string[] = [];
  const reasoningBuf: ReasoningBuf = { buf: "" };
  const toolInputs = new Map<string, { name?: string; arguments: string; outputIndex?: number }>();
  const doneItems: OpenAI.Responses.ResponseOutputItem[] = [];
  let finalResponse: OpenAI.Responses.Response | undefined;
  let usage: TokenUsage | undefined;
  let truncated = false;
  let stopReason: string | undefined;

  await driveStreamingTurn(async (attempt) => {
    if (attempt > 0) {
      content.length = 0;
      reasoningBuf.buf = "";
      toolInputs.clear();
      doneItems.length = 0;
      finalResponse = undefined;
      usage = undefined;
      truncated = false;
      stopReason = undefined;
      onEvent?.({ type: "stream-reset" });
    }
    const responseRequest: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: config.model,
      input: baseInput,
      tools: request.tools.map(openAIResponseTool),
      stream: true,
      // Asking for `summary: "auto"` makes the Responses API stream reasoning
      // summary deltas alongside the answer. Without this the model still
      // reasons (and bills reasoning_tokens) but we get no visible trace.
      // `include: reasoning.encrypted_content` makes the API attach an encrypted
      // reasoning blob to each reasoning item so we can replay it back into
      // context on later turns without server-side `store` (the ZDR-friendly
      // path codex/pi use). Captured into `reasoningTrace` below; replayed in
      // Stage 3.
      // SDK types lag the top-tier effort values ("xhigh"/"max", reachable only
      // via an explicit supportedEfforts config); cast — the endpoint accepts them.
      // `"none"` (offEffort) is an explicit thinking-OFF encoding: send the bare
      // effort field, without requesting summaries or encrypted traces.
      ...(reasoning === "none"
        ? { reasoning: { effort: "none" as NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>["effort"] } }
        : reasoning
          ? {
              reasoning: {
                effort: reasoning as NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>["effort"],
                summary: "auto" as const,
              },
              include: ["reasoning.encrypted_content" as const],
            }
          : {}),
      // The codex backend rejects `max_output_tokens` ("Unsupported parameter") —
      // it's a normal Responses API field, but the ChatGPT-account codex endpoint
      // doesn't accept it. Send it only on the standard OpenAI path.
      ...(maxOutputTokens && !isCodex ? { max_output_tokens: maxOutputTokens } : {}),
      // Codex backend requirements: stateless (`store:false`), system prompt via
      // `instructions`, and always request encrypted reasoning so it can be
      // replayed next turn (the backend is ZDR — no server-side store to read
      // it back from).
      ...(isCodex
        ? { store: false, instructions: request.systemPrompt, include: ["reasoning.encrypted_content" as const] }
        : {}),
    };
    // SDK 4.104 doesn't expose `prompt_cache_key` on the Responses type yet, but
    // the API accepts it. Attach via Record-cast so the literal `stream: true`
    // overload still resolves correctly above. Codex parity: the real CLI sends
    // its conversation id as the cache key (history diverges per conversation,
    // so the per-system-prompt hash is the wrong routing granularity there).
    const responsesCacheKey = isCodex && cacheKey ? codexSessionId : cacheKey;
    if (responsesCacheKey) (responseRequest as unknown as Record<string, unknown>).prompt_cache_key = responsesCacheKey;
    let response: Awaited<ReturnType<typeof client.responses.create>>;
    try {
      response = await client.responses.create(responseRequest, { signal, ...requestTimeoutOption() });
    } catch (error) {
      // Connect-time failure (e.g. a usage-limit 429): make the message
      // readable while preserving the APIError so retry/auth/quota
      // classification upstream is unchanged.
      throw enrichCodexLimitError(error, isCodex);
    }
    let roundFinal: OpenAI.Responses.Response | undefined;
    try {
      for await (const event of response) {
        const terminalError = responsesStreamError(event);
        if (terminalError) throw terminalError;
        if (event.type === "response.output_text.delta") {
          content.push(event.delta);
          onEvent?.({ type: "text-delta", text: event.delta });
          continue;
        }
        if (event.type === "response.reasoning_summary_text.delta") {
          const emit = appendReasoning(reasoningBuf, event.delta);
          if (emit) onEvent?.({ type: "reasoning-delta", text: emit });
          continue;
        }
        // The Responses API emits multiple "summary parts" per reasoning
        // span — each is an independent mini-summary of the same underlying
        // thinking. Concatenating them without a break reads as the same
        // idea rephrased N times. Insert a blank line so the renderer (which
        // applies `white-space: pre-wrap` on .assistant-reasoning-body) shows
        // them as separate paragraphs.
        if (event.type === "response.reasoning_summary_part.added") {
          if (reasoningBuf.buf) {
            reasoningBuf.buf += "\n\n";
            onEvent?.({ type: "reasoning-delta", text: "\n\n" });
          }
          continue;
        }
        if (event.type === "response.output_item.added" && event.item.type === "function_call") {
          const current = {
            name: event.item.name,
            arguments: event.item.arguments ?? "",
            outputIndex: event.output_index,
          };
          toolInputs.set(event.item.call_id, current);
          if (event.item.id) toolInputs.set(event.item.id, current);
          continue;
        }
        if (event.type === "response.function_call_arguments.delta") {
          const current = toolInputs.get(event.item_id) ?? { arguments: "" };
          current.arguments += event.delta;
          toolInputs.set(event.item_id, current);
          onEvent?.({
            type: "tool-input-delta",
            index: current.outputIndex ?? 0,
            id: event.item_id,
            name: current.name,
            delta: event.delta,
            input: current.arguments,
          });
          continue;
        }
        // Item-level assembly source: collect every finished output item. The
        // chatgpt.com codex backend (seen with gpt-5.5) can send a slim
        // `response.completed` whose `output` is missing/empty even though
        // item events streamed — these collected items are the fallback so
        // tool calls / text / reasoning aren't silently dropped (codex and pi
        // assemble from item events for exactly this reason).
        if (event.type === "response.output_item.done") {
          doneItems.push(event.item);
          continue;
        }
        // `response.incomplete` fires when the cap is hit; both carry the final
        // Response object whose status/incomplete_details we inspect below.
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          roundFinal = event.response;
          break;
        }
      }
    } catch (error) {
      const cause = normalizeStreamAPIError(error);
      if (cause instanceof ProviderStreamError) throw enrichCodexLimitError(cause, isCodex);
      throw new MidStreamError(cause);
    }
    // No `response.completed`/`response.incomplete` terminal event arrived — the
    // stream closed early. Matches Codex's "stream closed before
    // response.completed": re-issue rather than return a partial turn.
    if (!roundFinal) {
      throw new MidStreamError(new Error("stream closed before response.completed"));
    }
    finalResponse = roundFinal ?? finalResponse;
    usage = normalizeOpenAIUsage(roundFinal?.usage) ?? usage;
    truncated = Boolean(roundFinal?.status === "incomplete" && roundFinal?.incomplete_details?.reason === "max_output_tokens");
    stopReason = roundFinal?.incomplete_details?.reason ?? undefined;
  }, signal);

  // Canonical output items for this round: prefer the final Response object's
  // `output`, but fall back to the items collected from output_item.done — the
  // codex backend's slim completed event ships no output array, and reading
  // only the final object silently dropped every tool call gpt-5.5 made.
  const outputItems = finalResponse?.output?.length ? finalResponse.output : doneItems;
  // Safety net: harvest message text (and refusals) from the output items when
  // no `output_text.delta` events arrived; without this the turn is mistaken
  // for reasoning-only/empty and triggers the engine's dead-turn recovery.
  if (content.length === 0) {
    for (const item of outputItems) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push(part.text);
          onEvent?.({ type: "text-delta", text: part.text });
        } else if (part.type === "refusal" && part.refusal) {
          content.push(part.refusal);
          onEvent?.({ type: "text-delta", text: part.refusal });
        }
      }
    }
  }
  const toolCalls: ModelToolCall[] = [];
  for (const item of outputItems) {
    if (item.type === "function_call") {
      const streamed = toolInputs.get(item.call_id);
      toolCalls.push(
        toModelToolCall(item.call_id, item.name, parseToolJson(streamed?.arguments || item.arguments), `Call ${item.name}`),
      );
    }
  }
  // Structured trace for cross-turn replay: the reasoning items carry
  // `encrypted_content` (requested via `include` above), and the assistant
  // message items keep their original `msg_` ids. Keep the raw items verbatim
  // and replay the WHOLE item stream next turn (pi-style): the codex backend
  // tracks rs_/msg_ pairing, and replaying reasoning anchored to an id-less
  // flattened role message reads as foreign history to codex-tuned models —
  // the root cause of their narrate-then-stop / empty-turn decay. Provider+
  // model-scoped (encrypted content is only valid for the same model).
  const traceItems = outputItems.filter((item) => item.type === "reasoning" || item.type === "message");
  const hasReasoningItems = traceItems.some((item) => item.type === "reasoning");
  // Within-turn replay state: when this round made tool calls, stash its ordered
  // assistant items (reasoning + function_call) so the next request re-emits them
  // before the function_call_output (see baseInput). Output items are accepted
  // back as input items. The engine clears providerState at the turn boundary,
  // so this never leaks across turns (cross-turn replay goes via reasoningTrace).
  const assistantItems =
    toolCalls.length > 0
      ? (outputItems.filter(
          (item) => item.type === "reasoning" || item.type === "function_call",
        ) as unknown as OpenAI.Responses.ResponseInputItem[])
      : undefined;
  return {
    content: content.join("") || undefined,
    reasoning: reasoningBuf.buf || undefined,
    reasoningTrace: hasReasoningItems
      ? { provider: config.provider, model: config.model, blocks: traceItems }
      : undefined,
    toolCalls,
    providerState:
      assistantItems && assistantItems.length > 0 ? stateFor("openai-responses", { assistantItems }) : undefined,
    usage,
    truncated,
    stopReason,
  };
}

async function anthropicMessagesTurn(config: ModelConfig, request: ModelRequest, onEvent?: ModelStreamHandler, signal?: AbortSignal): Promise<ModelTurn> {
  // OAuth = a Claude Pro/Max subscription token (injected by the desktop main
  // process). It authenticates with `Authorization: Bearer` instead of
  // `x-api-key`, and the upstream only accepts it when the request also carries
  // the Claude Code betas + a Claude Code identity system block (see
  // anthropicBetas + anthropicSystemPrompt below).
  const isOAuth = config.authMode === "oauth";
  // "bearer" = an Anthropic-COMPATIBLE endpoint authorized by a Bearer token
  // (e.g. Kimi subscription): authenticate like OAuth but send NONE of the
  // Claude Code impersonation extras (betas / identity block / CLI UA) — a
  // third-party endpoint would reject or misroute them.
  const isBearer = config.authMode === "bearer";
  const client = new Anthropic({
    apiKey: isOAuth || isBearer ? null : apiKey(config, "ANTHROPIC_API_KEY"),
    ...(isOAuth || isBearer ? { authToken: apiKey(config, "ANTHROPIC_API_KEY") } : {}),
    baseURL: providerSdkBaseUrl(config),
    fetch: createProviderFetch(config),
    maxRetries: providerMaxRetries(),
    defaultHeaders: modelRequestHeaders(config, apiKey(config, "ANTHROPIC_API_KEY"),
      isOAuth ? { "x-app": "cli", "user-agent": claudeRequestUserAgent(config) } : {}),
  });
  const state = stateData<AnthropicState>(request.providerState, "anthropic-messages");
  // Reassignable: an adaptive plan downgrades to budget-based in place if the
  // model/endpoint rejects the adaptive shape (see the retry below).
  let thinkingPlan = resolveAnthropicThinking(config);
  // Only auto-downgrade when the mode wasn't pinned in config — an explicit
  // `thinkingMode` is obeyed verbatim (its 400 surfaces like any other error).
  const autoThinkingMode = config.thinkingMode === undefined;
  // Anthropic requires max_tokens. Honour a configured cap, but never below the
  // thinking budget (+ slack for the answer) or the request errors.
  // Default raised to 64k (matches Claude Code's OpenAI-path default) so long
  // single-turn replies aren't silently capped at 4k. Endpoints that enforce a
  // smaller ceiling (e.g. some bigmodel-proxied GLMs) will 400 — in that case
  // set `maxOutputTokens` per-model in models.json (or `REINA_MAX_OUTPUT_TOKENS`
  // env) to whatever that endpoint accepts.
  const baseMaxTokens = resolveMaxOutputTokens(config) ?? 64_000;
  const replay = reasoningReplay(config, request, thinkingPlan !== undefined);

  // Build the message list fresh per attempt: the cache breakpoint mutates the
  // last message in place, so sharing arrays across attempts would leak
  // cache_control into the no-cache fallback.
  // Bidirectional pairing normalization (see tool-pairing.ts): matched pairs
  // replay natively, tool_use blocks missing a result get a synthetic
  // tool_result (else "tool_use ids were found without tool_result blocks"),
  // orphan observations degrade to text (else "unexpected tool_use_id").
  const anthropicCallIds = (state.assistantContent ?? [])
    .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use")
    .map((block) => block.id);
  const anthropicPairing =
    request.observations.length > 0 ? normalizeToolPairing(anthropicCallIds, request.observations) : undefined;

  const buildMessages = (usePromptCache: boolean): Anthropic.Messages.MessageParam[] => {
    const msgs: Anthropic.Messages.MessageParam[] = toAnthropicMessages(request.messages, replay);
    if (anthropicPairing && anthropicCallIds.length > 0 && state.assistantContent) {
      msgs.push({ role: "assistant", content: state.assistantContent });
      msgs.push({
        role: "user",
        content: [
          ...anthropicPairing.matched.map(anthropicToolObservation),
          ...anthropicPairing.synthesized.map((synthetic) => ({
            type: "tool_result" as const,
            tool_use_id: synthetic.callId,
            content: synthetic.output,
          })),
          // Orphan observations ride as a text block in the SAME user envelope
          // (the formatObservationMessages shape) — strict Anthropic-compatible
          // relays (Kimi/MiniMax) 400 on consecutive user turns.
          ...(anthropicPairing.orphans.length > 0
            ? [{ type: "text" as const, text: anthropicPairing.orphans.map(formatObservation).join("\n\n") }]
            : []),
        ],
      });
    } else {
      // One envelope for ALL observations (same merge shape as the chat path's
      // formatObservationMessages) — per-observation envelopes would be
      // consecutive user turns, which strict relays reject.
      if (request.observations.length > 0) {
        msgs.push({ role: "user", content: request.observations.map(formatObservation).join("\n\n") });
      }
    }
    // History can still surface consecutive user turns (e.g. compaction's
    // [user prompt, user summary] shape) — collapse them BEFORE the cache
    // breakpoint so the breakpoint still lands on the true last block.
    const merged = mergeConsecutiveAnthropicUserMessages(msgs);
    // Place the rolling history cache breakpoint BEFORE reminders so reminder
    // content (which changes turn-to-turn) sits outside the cached prefix.
    if (usePromptCache) applyAnthropicHistoryCacheBreakpoint(merged, anthropicCacheTtl());
    applyAnthropicReminders(merged, request.systemReminders);
    return merged;
  };

  const blocks = new Map<number, { text?: string; id?: string; name?: string; input?: string }>();
  const content: string[] = [];
  const reasoningBuf: ReasoningBuf = { buf: "" };
  let usage: TokenUsage | undefined;
  let assistantContent: Anthropic.Messages.ContentBlock[] = [];
  let truncated = false;
  let stopReason: string | undefined;
  const resetAccumulators = () => {
    blocks.clear();
    content.length = 0;
    reasoningBuf.buf = "";
    usage = undefined;
    assistantContent = [];
    truncated = false;
    stopReason = undefined;
  };

  await driveStreamingTurn(async (attempt) => {
    if (attempt > 0) {
      // Re-issuing the whole request — discard the failed attempt's partial.
      resetAccumulators();
      onEvent?.({ type: "stream-reset" });
    }
    // Stream one request. Returns "cache-unsupported" for a pre-stream 400 we
    // can retry without the cache breakpoint, or "adaptive-unsupported" when the
    // model rejects the adaptive thinking shape (retry with budget-based);
    // throws raw on a connect-time failure (the SDK already retried it, so we
    // don't double-retry); throws MidStreamError on a mid-stream drop so the
    // driver re-issues the whole request (the Codex model — no partial stitching).
    // `thinking`/`maxTokens`/`betaHeader` derive from `thinkingPlan`, which can
    // flip adaptive→budget between calls, so compute them per attempt.
    const streamOnce = async (usePromptCache: boolean): Promise<"ok" | "cache-unsupported" | "adaptive-unsupported"> => {
      const thinking = thinkingPlan?.thinking ?? (config.reasoningEffort === "off" ? { type: "disabled" as const } : undefined);
      // Budget-based thinking needs headroom for the budget + the answer;
      // adaptive thinking manages its own allocation inside max_tokens.
      const maxTokens =
        thinking?.type === "enabled" ? Math.max(baseMaxTokens, thinking.budget_tokens + 1024) : baseMaxTokens;
      const betaHeader = anthropicBetas(config, thinkingPlan, usePromptCache);
      const streamBody = {
        model: config.model,
        max_tokens: maxTokens,
        system: anthropicSystemPrompt(request.systemPrompt, usePromptCache, isOAuth),
        messages: buildMessages(usePromptCache),
        tools: anthropicTools(request.tools, usePromptCache),
        // Budget-based thinking is SDK-typed; the adaptive shape is attached
        // below via a cast (the SDK types lag it).
        ...(thinking && thinking.type !== "adaptive" ? { thinking } : {}),
        // The real Claude Code CLI tags every request with a structured
        // metadata.user_id; Anthropic's Claude-Code validation requires it for
        // plan-limit attribution on OAuth (subscription) tokens. We also send
        // it through a custom baseUrl (proxy/relay) when a session is known:
        // multi-account relays (sub2api) use the session_id segment as their
        // top-priority sticky-routing key, pinning the conversation to one
        // upstream account so the prompt cache stays warm. Direct
        // api.anthropic.com API-key requests keep the authentic CLI shape (no
        // metadata) — they don't need relay stickiness.
        ...(isOAuth || (config.baseUrl && request.sessionId)
          ? { metadata: { user_id: claudeMetadataUserId(config, request.sessionId) } }
          : {}),
      };
      if (thinking?.type === "adaptive") {
        // SDK types lag both the "adaptive" thinking shape and the "xhigh"/"max"
        // effort values; attach through a cast — the runtime API accepts them.
        const extra = streamBody as Record<string, unknown>;
        extra.thinking = thinking;
        if (thinkingPlan?.outputConfig) extra.output_config = thinkingPlan.outputConfig;
      }
      const response = client.messages.stream(streamBody, {
        ...(betaHeader ? { headers: { "anthropic-beta": betaHeader } } : {}),
        ...(signal ? { signal } : {}),
        ...requestTimeoutOption(),
      });
      let sawEvent = false;
      try {
        for await (const event of response) {
          sawEvent = true;
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              blocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                input: "",
              });
            } else if (event.content_block.type === "thinking" && reasoningBuf.buf) {
              // Non-first thinking block — Anthropic (and especially the
              // Anthropic-compat layers fronting GLM/Qwen/Moonshot) can emit
              // multiple `thinking` content_blocks per response, one per
              // reasoning round. Without a separator they mash together and
              // read as the same idea rephrased N times. Insert a blank line
              // so the renderer's `white-space: pre-wrap` shows them as
              // separate paragraphs.
              reasoningBuf.buf += "\n\n";
              onEvent?.({ type: "reasoning-delta", text: "\n\n" });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              content.push(event.delta.text);
              onEvent?.({ type: "text-delta", text: event.delta.text });
              continue;
            }
            // Thinking blocks stream as `thinking_delta`. The companion
            // `signature_delta` carries the signature we must echo back on tool
            // follow-ups; we don't render it, but `finalMessage.content` keeps it
            // intact for providerState replay. `appendReasoning` guards
            // against bridge bugs that resend cumulative or overlapping text.
            if (event.delta.type === "thinking_delta") {
              const emit = appendReasoning(reasoningBuf, event.delta.thinking);
              if (emit) onEvent?.({ type: "reasoning-delta", text: emit });
              continue;
            }
            if (event.delta.type === "input_json_delta") {
              const current = blocks.get(event.index) ?? { input: "" };
              current.input = `${current.input ?? ""}${event.delta.partial_json}`;
              blocks.set(event.index, current);
              onEvent?.({
                type: "tool-input-delta",
                index: event.index,
                id: current.id,
                name: current.name,
                delta: event.delta.partial_json,
                input: current.input,
              });
            }
          }
        }
      } catch (error) {
        if (!sawEvent && autoThinkingMode && thinking?.type === "adaptive" && isAnthropicAdaptiveThinkingUnsupported(error))
          return "adaptive-unsupported";
        if (!sawEvent && usePromptCache && isAnthropicPromptCacheUnsupported(error)) return "cache-unsupported";
        if (!sawEvent) throw error; // connect-time -> SDK already retried; don't double-retry
        throw new MidStreamError(error); // mid-stream drop -> driver re-issues whole request
      }
      const finalMessage = await response.finalMessage();
      assistantContent = finalMessage.content;
      usage = normalizeAnthropicUsage(finalMessage.usage) ?? usage;
      // Fall back to scanning the final message in case the SDK ever delivers
      // thinking only as terminal blocks (no deltas) — a belt-and-suspenders
      // catch. Anthropic-compat bridges (smartly, ZhipuAI) often take this
      // path with multiple thinking blocks: separate them with `\n\n` so the
      // multi-block case follows the same paragraph rule as the streamed case.
      if (!reasoningBuf.buf) {
        for (const block of finalMessage.content) {
          if (block.type === "thinking" && typeof (block as { thinking?: string }).thinking === "string") {
            if (reasoningBuf.buf) reasoningBuf.buf += "\n\n";
            reasoningBuf.buf += (block as { thinking: string }).thinking;
          }
        }
      }
      truncated = finalMessage.stop_reason === "max_tokens";
      stopReason = finalMessage.stop_reason ?? undefined;
      return "ok";
    };

    // Re-issue until a clean stream. Each pre-stream-400 sentinel can fire at
    // most once — the adaptive downgrade removes the adaptive shape and the
    // cache downgrade removes cache_control — so this is bounded at 3 attempts.
    // (A sequential `if` pair here once swallowed the second sentinel: a cache
    // 400 followed by an adaptive 400 returned a silent empty turn with no
    // learned downgrade.)
    // One-shot side requests (promptCache:"none") skip cache_control entirely:
    // an Anthropic cache WRITE bills 1.25x, and a throwaway prefix is never
    // read back — pure surcharge.
    let usePromptCache = shouldUseAnthropicPromptCache(config) && request.promptCache !== "none";
    let outcome = await streamOnce(usePromptCache);
    while (outcome !== "ok") {
      if (outcome === "adaptive-unsupported") {
        // Model/endpoint rejected the adaptive thinking shape — remember it so
        // we stop probing (this turn and every later one this process), and
        // downgrade to budget-based thinking.
        adaptiveThinkingUnsupported.add(adaptiveCapabilityKey(config));
        thinkingPlan = resolveAnthropicThinking(config);
      } else {
        // Provider rejected cache_control before streaming — retry without it.
        usePromptCache = false;
      }
      resetAccumulators();
      outcome = await streamOnce(usePromptCache);
    }
  }, signal);

  // `blocks` is keyed by the stream's absolute content-block index (thinking,
  // text, and tool_use all advance it), but the assembled tool calls are the
  // *filtered* tool_use-only subset. Matching streamed input by filtered
  // position silently hands tool B the args streamed for tool A whenever a
  // thinking/text block precedes the tools (the default shape for parallel
  // tool rounds with reasoning on). Look up the streamed input by the block's
  // own id instead so it is position-independent.
  const streamedById = new Map<string, { text?: string; id?: string; name?: string; input?: string }>();
  for (const streamed of blocks.values()) {
    if (streamed.id) streamedById.set(streamed.id, streamed);
  }
  const toolCalls: ModelToolCall[] = assistantContent
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block: Anthropic.ToolUseBlock) => {
      const streamed = streamedById.get(block.id);
      const parsed = streamed?.input ? parseToolJson(streamed.input) : block.input;
      return toModelToolCall(block.id, block.name, parsed, `Call ${block.name}`);
    });
  // Structured trace for cross-turn replay: thinking / redacted_thinking blocks
  // carry the signature Anthropic verifies on replay. Keep them verbatim and in
  // order — Stage 3 prepends them to the assistant message. Provider+model-scoped
  // (a signature is only valid for the exact model that produced it).
  const reasoningBlocks = assistantContent.filter(
    (block) => block.type === "thinking" || block.type === "redacted_thinking",
  );
  return {
    content: content.join("") || undefined,
    reasoning: reasoningBuf.buf || undefined,
    reasoningTrace:
      reasoningBlocks.length > 0 ? { provider: config.provider, model: config.model, blocks: reasoningBlocks } : undefined,
    toolCalls,
    providerState: stateFor("anthropic-messages", { assistantContent }),
    usage,
    truncated,
    stopReason,
  };
}

function shouldUseAnthropicPromptCache(config: ModelConfig): boolean {
  const setting = process.env.REINA_ANTHROPIC_PROMPT_CACHE?.trim().toLowerCase();
  if (setting === "0" || setting === "false") return false;
  if (setting === "1" || setting === "true") return true;
  return isOfficialAnthropicEndpoint(config.baseUrl);
}

function isOfficialAnthropicEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.anthropic.com";
  } catch {
    return false;
  }
}

// Per-turn reminders the engine wants the model to see, wrapped in the
// widely-recognized `<system-reminder>` convention. Kept OUT of the
// system prompt so the cached `[system + tools]` prefix stays
// byte-stable across turns where reminder content varies (e.g. the
// hidden-tools roster shrinks as deferred tools get unmasked).
export function formatSystemReminders(reminders: string[] | undefined): string | undefined {
  if (!reminders || reminders.length === 0) return undefined;
  const blocks = reminders
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => `<system-reminder>\n${r}\n</system-reminder>`);
  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}

// Append a reminder text block onto the last user-role Anthropic message.
// Anthropic disallows consecutive user messages, so we splice into the
// existing one rather than pushing a new envelope.
function applyAnthropicReminders(
  messages: Anthropic.Messages.MessageParam[],
  reminders: string[] | undefined,
): void {
  const text = formatSystemReminders(reminders);
  if (!text) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const block: Anthropic.Messages.TextBlockParam = { type: "text", text };
    if (typeof m.content === "string") {
      m.content = m.content ? [{ type: "text", text: m.content }, block] : [block];
    } else {
      m.content = [...m.content, block];
    }
    return;
  }
  // No user message yet — push a fresh envelope so the model still sees the reminder.
  messages.push({ role: "user", content: [{ type: "text", text }] });
}

function shouldUseOpenAIPromptCache(): boolean {
  return process.env.REINA_OPENAI_PROMPT_CACHE !== "0";
}

// Stable per-system-prompt routing hint. OpenAI's prefix cache is automatic,
// but `prompt_cache_key` pins requests sharing the same prefix to the same
// machine so hit rates stay high at scale. Hashing the system prompt keeps
// the key stable across a session without leaking content into the field.
function openaiPromptCacheKey(systemPrompt: string): string | undefined {
  if (!shouldUseOpenAIPromptCache()) return undefined;
  if (!systemPrompt) return undefined;
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 32);
}

// Plain-OpenAI routing identity. The Codex path already pins prompt_cache_key
// to the conversation uuid (see openaiResponsesTurn); the public api.openai.com
// path historically hashed the system prompt, which churns daily (the env
// block carries today's date) and collides across unrelated conversations.
// Multi-account relays (e.g. sub2api) key their sticky upstream routing on this
// value, so a per-conversation-stable id keeps the upstream prefix cache warm
// (cached_tokens > 0) instead of re-routing every turn. Sessionless one-offs
// (title, compaction) keep the prompt-hash fallback.
function openaiConversationCacheKey(request: ModelRequest): string | undefined {
  if (request.sessionId && shouldUseOpenAIPromptCache()) {
    return conversationUuid(request.sessionId);
  }
  return openaiPromptCacheKey(request.systemPrompt);
}

// Session-affinity headers for the public OpenAI path, mirroring the Codex
// client and pi's coding agent. Relays that route "header first" (sub2api) pin
// the conversation to one upstream account from these; the underscore form
// matches the real Codex CLI traffic sub2api documents. Empty for sessionless
// one-offs so their per-call random uuid doesn't fragment routing.
function openaiAffinityHeaders(request: ModelRequest): Record<string, string> {
  if (!request.sessionId) return {};
  const id = conversationUuid(request.sessionId);
  return { session_id: id, conversation_id: id };
}

/** Cache TTL for Anthropic ephemeral cache breakpoints. Default "5m" — the
 * cheaper write tier (1.25x input vs 2x for 1h) and the right default for a
 * continuously-active conversation, where turn gaps stay under 5min so the
 * prefix never goes cold and the 1h write premium is pure waste. Mirrors
 * sub2api's proxy default (`DefaultCacheControlTTL`). Opt into "1h" with
 * `REINA_ANTHROPIC_CACHE_TTL=1h` to trade the 2x write cost for tolerance of
 * long user pauses (think/lunch gaps that would otherwise drop the cached
 * prefix); the 1h tier needs the extended-cache-ttl beta, added automatically
 * (see anthropicBetas). */
function anthropicCacheTtl(): "5m" | "1h" {
  return process.env.REINA_ANTHROPIC_CACHE_TTL === "1h" ? "1h" : "5m";
}

function anthropicCacheControl(): Anthropic.Messages.CacheControlEphemeral {
  return { type: "ephemeral", ttl: anthropicCacheTtl() };
}

function anthropicSystemPrompt(
  prompt: string,
  usePromptCache: boolean,
  isOAuth = false,
): string | Anthropic.TextBlockParam[] {
  if (!isOAuth) {
    // Always send system as content blocks (never a bare string): Anthropic's
    // API accepts both forms, but some Anthropic-compat relays (aiproxy-style
    // converters) only unmarshal `system` into []ClaudeContent and 400 on a
    // string. Claude Code also always sends the block form.
    if (!usePromptCache) return [{ type: "text", text: prompt }];
    return [{ type: "text", text: prompt, cache_control: anthropicCacheControl() }];
  }
  // OAuth (subscription) tokens are scoped to Claude Code. The upstream rejects
  // the request unless the FIRST system block declares the Claude Code identity;
  // the real system prompt follows as a second block.
  const identity: Anthropic.TextBlockParam = {
    type: "text",
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
  };
  const userBlock: Anthropic.TextBlockParam = usePromptCache
    ? { type: "text", text: prompt, cache_control: anthropicCacheControl() }
    : { type: "text", text: prompt };
  return [identity, userBlock];
}

function anthropicTools(tools: ToolDescriptor[], usePromptCache: boolean): Anthropic.Tool[] {
  const mapped = tools.map(anthropicTool);
  if (!usePromptCache || mapped.length === 0) return mapped;
  const last = mapped[mapped.length - 1]!;
  mapped[mapped.length - 1] = { ...last, cache_control: anthropicCacheControl() };
  return mapped;
}

/** Attach a cache_control breakpoint to the LAST block of the LAST message
 * so the model's view of conversation history becomes part of the cached
 * prefix. Without this, only [tools + system] are cached — every new turn
 * re-reads the entire (growing) message array at full input price.
 *
 * The breakpoint advances each turn; previous turns' breakpoints stay
 * valid in Anthropic's cache, so subsequent turns get cumulative hits
 * across the rolling window. Called BEFORE reminders are spliced in so
 * the reminder block sits outside the cached prefix (reminders are
 * per-turn volatile). */
function applyAnthropicHistoryCacheBreakpoint(
  messages: Anthropic.Messages.MessageParam[],
  _ttl: "5m" | "1h",
): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1]!;
  const cacheControl = anthropicCacheControl();
  if (typeof last.content === "string") {
    if (!last.content) return;
    last.content = [{ type: "text", text: last.content, cache_control: cacheControl }];
    return;
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return;
  const lastBlock = last.content[last.content.length - 1] as { cache_control?: Anthropic.Messages.CacheControlEphemeral };
  lastBlock.cache_control = cacheControl;
}

function isAnthropicPromptCacheUnsupported(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status !== 400) return false;
  const text = (errorMessage(error)).toLowerCase();
  return text.includes("cache_control") || text.includes("prompt cache") || text.includes("ttl") || (text.includes("cache") && text.includes("unsupported"));
}

/** A pre-stream 400 that means this model/endpoint doesn't accept the adaptive
 * thinking shape (`thinking:{type:"adaptive"}` / `output_config.effort`), so the
 * caller downgrades to budget-based thinking and retries. Worst case of an
 * over-broad match is a downgrade to budget (still a valid answer), so this errs
 * toward catching it. */
function isAnthropicAdaptiveThinkingUnsupported(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status !== 400) return false;
  const text = errorMessage(error).toLowerCase();
  return (
    text.includes("output_config") ||
    text.includes("adaptive") ||
    text.includes("xhigh") ||
    (text.includes("effort") && text.includes("thinking"))
  );
}

function normalizeOpenAIUsage(usage: unknown): TokenUsage | undefined {
  const raw = asRecord(usage);
  if (!raw) return undefined;
  const rawOutputTokens = firstNumber(raw.completion_tokens, raw.output_tokens);
  const outputTokens = rawOutputTokens ?? 0;
  const totalTokens = firstPositiveNumber(raw.total_tokens);
  const rawInputTokens = firstNumber(raw.prompt_tokens, raw.input_tokens);
  const inputTokens =
    rawInputTokens !== undefined && rawInputTokens > 0
      ? rawInputTokens
      : totalTokens !== undefined
        ? Math.max(0, totalTokens - outputTokens)
        : rawInputTokens ?? 0;
  const exactTotal =
    totalTokens
    ?? (
      rawInputTokens !== undefined && rawInputTokens > 0 && rawOutputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined
    );
  const promptDetails = asRecord(raw.prompt_tokens_details) ?? asRecord(raw.input_tokens_details);
  const outputDetails = asRecord(raw.completion_tokens_details) ?? asRecord(raw.output_tokens_details);
  // OpenAI's prompt_tokens already includes the cached subset, so inputTokens is
  // the full input side and cachedInputTokens ⊆ inputTokens — already Reina's
  // canonical convention (see TokenUsage docs / normalizeAnthropicUsage).
  return {
    inputTokens,
    outputTokens,
    ...(exactTotal !== undefined ? { totalTokens: exactTotal } : {}),
    // Cache-hit dialects beyond OpenAI's documented shape: Moonshot/Kimi put
    // `cached_tokens` at the usage TOP level, DeepSeek's official API reports
    // `prompt_cache_hit_tokens` there — first defined number wins.
    cachedInputTokens: firstNumber(promptDetails?.cached_tokens, raw.cached_input_tokens, raw.cached_tokens, raw.prompt_cache_hit_tokens) ?? undefined,
    reasoningTokens: firstNumber(outputDetails?.reasoning_tokens, raw.reasoning_tokens) ?? undefined,
  };
}

function normalizeAnthropicUsage(usage: unknown): TokenUsage | undefined {
  const raw = asRecord(usage);
  if (!raw) return undefined;
  // Anthropic reports input_tokens as the NON-cached portion, with cache reads
  // and cache-creation writes broken out separately. Canonicalize to Reina's
  // convention (see TokenUsage docs): inputTokens is the full input side with
  // cache folded in, so cachedInputTokens ⊆ inputTokens — matching the
  // OpenAI/Kimi shape and keeping downstream cost math provider-agnostic.
  const nonCachedInput = firstNumber(raw.input_tokens) ?? 0;
  const rawOutputTokens = firstNumber(raw.output_tokens);
  const outputTokens = rawOutputTokens ?? 0;
  const cachedInputTokens = firstNumber(raw.cache_read_input_tokens) ?? undefined;
  const cacheCreationInputTokens = firstNumber(raw.cache_creation_input_tokens) ?? undefined;
  const inputTokens = nonCachedInput + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const hasInputSide = inputTokens > 0;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    ...(hasInputSide && rawOutputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function apiKey(config: ModelConfig, _fallbackEnv: string): string {
  return modelApiKey(config);
}

/** Per-request context for cross-turn reasoning replay. Built once by each turn
 * function and threaded into its history converter. */
type ReasoningReplay = {
  config: ModelConfig;
  /** Reasoning/thinking is enabled on THIS request. Replaying signed/encrypted
   * reasoning while reasoning is OFF is rejected by the providers, so we gate. */
  reasoningOn: boolean;
  /** Id of the assistant message owned by the in-flight tool round (replayed via
   * providerState). Skip cross-turn replay for it to avoid duplicating its
   * reasoning. undefined on a fresh turn (no pending observations). */
  skipMessageId?: string;
};

/** Build the replay context for a request: scoped to the active provider+model,
 * gated on whether reasoning is on this turn, skipping the latest tool round's
 * assistant message (that round replays via providerState, not history). */
function reasoningReplay(config: ModelConfig, request: ModelRequest, reasoningOn: boolean): ReasoningReplay {
  let skipMessageId: string | undefined;
  if (request.observations.length > 0) {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      if (request.messages[i]!.role === "assistant") {
        skipMessageId = request.messages[i]!.id;
        break;
      }
    }
  }
  return { config, reasoningOn, skipMessageId };
}

/** The provider-native reasoning blocks to replay for a historical assistant
 * message, or undefined when replay shouldn't happen: reasoning off this turn,
 * the message is the providerState-owned latest round, or the trace came from a
 * different provider+model (signatures / encrypted content are model-scoped —
 * replaying a mismatch is a 400). */
function replayableTrace(message: ChatMessage, replay: ReasoningReplay): ReasoningTrace["blocks"] | undefined {
  if (!replay.reasoningOn) return undefined;
  if (message.role !== "assistant" || message.id === replay.skipMessageId) return undefined;
  const trace = message.reasoningTrace;
  if (!trace || trace.provider !== replay.config.provider || trace.model !== replay.config.model) return undefined;
  return trace.blocks;
}

/** Plain-text reasoning to feed as ordinary assistant text for a historical
 * message whose trace came from a DIFFERENT provider+model — i.e. the session
 * switched models. Signed/encrypted blocks can't replay across models (400),
 * but the visible reasoning text still carries the chain of thought, so
 * downgrade it to text for continuity (mirrors pi's transform-messages).
 * Trace presence is the gate: reasoning-only dead turns drop their trace on
 * purpose and must stay out of context. Gated to non-empty content so we never
 * emit an orphaned reasoning-only assistant message. */
function downgradedReasoning(message: ChatMessage, config: ModelConfig): string | undefined {
  if (message.role !== "assistant" || !message.reasoning || !message.content) return undefined;
  const trace = message.reasoningTrace;
  if (!trace || (trace.provider === config.provider && trace.model === config.model)) return undefined;
  return message.reasoning;
}

/** Wire-time guard against session-wedging empty assistant messages. A
 * thinking-only round (reasoning captured, no visible text, tool calls carried
 * by providerState/toolResult pairs) persists as {role:"assistant", content:""};
 * serialized bare it is the exact shape strict providers reject ("message at
 * position N with role 'assistant' must not be empty") — and because the
 * message lives in history, the 400 would repeat on every later request.
 * Dropping it from the wire loses nothing: reasoning replay is already gated
 * on non-empty content in all three converters, and the transcript keeps the
 * message for display. (Mirrors kimi-code's vacuous-message drop.) */
function isVacuousAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !message.toolResult && message.content.trim().length === 0;
}

function toOpenAIChatMessages(
  messages: ChatMessage[],
  config: ModelConfig,
  nativeToolHistory = true,
  replayHistoricalReasoning = true,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    // A model tool round is persisted as one assistant message followed by one
    // or more toolResult messages. Reassemble that exact native shape instead
    // of emitting one synthetic assistant message per result. Besides preserving
    // parallel calls, this keeps the prompt prefix byte-stable when providerState
    // is cleared at the user-turn boundary.
    if (nativeToolHistory && message.role === "assistant") {
      const toolResults: ChatMessage[] = [];
      let next = index + 1;
      while (next < messages.length && messages[next]!.toolResult) {
        toolResults.push(messages[next]!);
        next += 1;
      }
      if (toolResults.length > 0) {
        const downgraded = downgradedReasoning(message, config);
        const content = downgraded ? `${downgraded}\n\n${message.content}` : message.content;
        const assistant = {
          role: "assistant" as const,
          content: content || null,
          tool_calls: toolResults.map((item) => ({
            id: item.toolResult!.callId,
            type: "function" as const,
            function: {
              name: item.toolResult!.name,
              arguments: JSON.stringify(item.toolResult!.input ?? {}),
            },
          })),
        } satisfies OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
        const historicalReasoning = replayHistoricalReasoning
          ? openAIChatHistoricalReasoning(message, config)
          : undefined;
        if (historicalReasoning) {
          (assistant as unknown as Record<string, unknown>)[historicalReasoning.key] = historicalReasoning.content;
        }
        result.push(assistant);
        result.push(
          ...toolResults.map((item) => ({
            role: "tool" as const,
            tool_call_id: item.toolResult!.callId,
            content: item.toolResult!.output ?? item.content,
          })),
        );
        for (const item of toolResults) {
          result.push(...openAIChatToolMediaMessages(item.toolResult!.attachments));
        }
        index = next - 1;
        continue;
      }
    }

    if (isVacuousAssistantMessage(message)) continue;
    // Structured tool history (ChatMessage.toolResult): render the pair
    // natively — an assistant tool_calls message immediately followed by its
    // role:"tool" result. `nativeToolHistory=false` is the conservative shape
    // for backends that 400 on native tool messages (the same toggle as the
    // within-turn replay retry); it keeps the flattened text path below.
    if (message.toolResult) {
      // Media (image/PDF) the tool returned rides as a follow-up user message
      // after the text result — the OpenAI tool channel can't carry it.
      const media = openAIChatToolMediaMessages(message.toolResult.attachments);
      if (nativeToolHistory) {
        result.push(
          {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: message.toolResult.callId,
                type: "function" as const,
                function: { name: message.toolResult.name, arguments: JSON.stringify(message.toolResult.input ?? {}) },
              },
            ],
          },
          {
            role: "tool" as const,
            tool_call_id: message.toolResult.callId,
            content: message.toolResult.output ?? message.content,
          },
          ...media,
        );
        continue;
      }
      // Conservative backends: flatten to a plain user message, still carrying
      // any media so the model can see the file.
      result.push({ role: "user" as const, content: message.content }, ...media);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    if (role === "user" && message.attachments && message.attachments.length > 0) {
      result.push({ role, content: openAIChatUserContent(message.content, message.attachments) });
      continue;
    }
    if (role === "assistant") {
      const downgraded = downgradedReasoning(message, config);
      if (downgraded) {
        result.push({ role, content: `${downgraded}\n\n${message.content}` });
        continue;
      }
    }
    result.push({ role, content: message.content });
  }
  return result;
}

function openAIChatHistoricalReasoning(
  message: ChatMessage,
  config: ModelConfig,
): { key: string; content: string } | undefined {
  const trace = message.reasoningTrace;
  if (!trace || trace.provider !== config.provider || trace.model !== config.model) return undefined;
  const blocks = trace.blocks as { reasoningContent?: unknown; reasoningKey?: unknown };
  if (typeof blocks.reasoningContent !== "string" || blocks.reasoningContent.length === 0) return undefined;
  const key =
    typeof blocks.reasoningKey === "string" && REASONING_DIALECT_KEYS.includes(blocks.reasoningKey as (typeof REASONING_DIALECT_KEYS)[number])
      ? blocks.reasoningKey
      : "reasoning_content";
  return { key, content: blocks.reasoningContent };
}

function hasOpenAIChatHistoricalReasoning(messages: ChatMessage[], config: ModelConfig): boolean {
  return messages.some((message) => openAIChatHistoricalReasoning(message, config) !== undefined);
}

/** Build a Chat Completions multimodal content array: one image_url/file part
 * per attachment, then the text. Images go in via `image_url` with a base64
 * data URL; PDFs use the `file` content part with `file_data` set to a
 * `data:application/pdf;base64,…` URL (GPT-4.1/4o/o-class models read PDFs
 * natively this way). */
function openAIChatUserContent(
  text: string,
  attachments: MessageAttachment[],
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const att of attachments) {
    const dataUrl = `data:${att.mime};base64,${att.dataBase64}`;
    if (att.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    } else if (att.kind === "pdf") {
      parts.push({
        type: "file",
        file: { file_data: dataUrl, ...(att.name ? { filename: att.name } : {}) },
      });
    }
  }
  if (text.trim().length > 0) parts.push({ type: "text", text });
  return parts;
}

/** Build a Responses API multimodal content array: one input_image/input_file
 * per attachment, then the text. The Responses API accepts a base64 data URL
 * directly in `image_url` (string, not object), and PDFs go in via
 * `input_file.file_data` as a `data:application/pdf;base64,…` URL. */
function openAIResponsesUserContent(
  text: string,
  attachments: MessageAttachment[],
): OpenAI.Responses.ResponseInputContent[] {
  const parts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const att of attachments) {
    const dataUrl = `data:${att.mime};base64,${att.dataBase64}`;
    if (att.kind === "image") {
      parts.push({ type: "input_image", image_url: dataUrl, detail: "high" });
    } else if (att.kind === "pdf") {
      parts.push({
        type: "input_file",
        file_data: dataUrl,
        ...(att.name ? { filename: att.name } : {}),
      });
    }
  }
  if (text.trim().length > 0) parts.push({ type: "input_text", text });
  return parts;
}

/** Tool-returned media to re-surface as a follow-up USER message on the OpenAI
 * family (Chat Completions, Responses, Codex, and forwarded OpenAI-compatible
 * relays) — these can't carry media inside a tool/function result. Restricted
 * to IMAGES: `image_url` input is broadly supported (incl. most relays),
 * whereas PDF (`input_file`/`file`) support is spotty and a relay that rejects
 * it would 400 the whole turn. PDFs reach these models as extracted text in the
 * tool output instead (see read_file's readPdf). The Anthropic path inlines
 * both image and document blocks in the tool_result and never calls this. */
function toolMediaAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
  return (attachments ?? []).filter((att) => att.kind === "image");
}

const TOOL_MEDIA_NOTE =
  "Media from the preceding tool call (the tool result above is a text summary; the actual file follows):";

function openAIChatToolMediaMessages(
  attachments: MessageAttachment[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const media = toolMediaAttachments(attachments);
  if (media.length === 0) return [];
  return [{ role: "user", content: openAIChatUserContent(TOOL_MEDIA_NOTE, media) }];
}

function openAIResponsesToolMediaItems(
  attachments: MessageAttachment[] | undefined,
): OpenAI.Responses.ResponseInputItem[] {
  const media = toolMediaAttachments(attachments);
  if (media.length === 0) return [];
  return [{ role: "user", content: openAIResponsesUserContent(TOOL_MEDIA_NOTE, media) }];
}

function toAnthropicMessages(messages: ChatMessage[], replay: ReasoningReplay): Anthropic.Messages.MessageParam[] {
  return messages
    .filter((message) => message.role !== "system" && !isVacuousAssistantMessage(message))
    .flatMap((message): Anthropic.Messages.MessageParam[] => {
      // Structured tool history (ChatMessage.toolResult): render the pair
      // natively — an assistant tool_use immediately followed by the user
      // tool_result, the adjacency Anthropic requires. Both sides derive from
      // ONE message, so the pair can never be half-compacted. Messages from
      // sessions persisted before the field existed take the text path below.
      if (message.toolResult) {
        const input = message.toolResult.input;
        return [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use" as const,
                id: message.toolResult.callId,
                name: message.toolResult.name,
                input: typeof input === "object" && input !== null ? input : {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: message.toolResult.callId,
                content: anthropicToolResultContent(
                  message.toolResult.output ?? message.content,
                  message.toolResult.attachments,
                ),
              },
            ],
          },
        ];
      }
      const role = message.role === "assistant" ? "assistant" : "user";
      if (role === "user" && message.attachments && message.attachments.length > 0) {
        return [{ role, content: userContentWithAttachments(message.content, message.attachments) }];
      }
      // Cross-turn replay: prepend the prior turn's signed thinking blocks
      // (thinking must come first in an Anthropic assistant turn) ahead of the
      // answer text. Gated to non-empty content so we never emit an orphaned
      // thinking-only message, which Anthropic 400s on (matches Claude Code).
      if (role === "assistant" && message.content) {
        const blocks = replayableTrace(message, replay);
        if (blocks) {
          const thinking = blocks as Anthropic.Messages.ContentBlockParam[];
          return [{ role, content: [...thinking, { type: "text" as const, text: message.content }] }];
        }
        // Model switched mid-session: the old trace can't replay natively, but
        // the plain reasoning text still can — prepend it as ordinary text.
        const downgraded = downgradedReasoning(message, replay.config);
        if (downgraded) {
          return [{ role, content: [{ type: "text" as const, text: downgraded }, { type: "text" as const, text: message.content }] }];
        }
      }
      return [{ role, content: message.content }];
    });
}

/** Collapse consecutive user turns into one (concatenating content, string
 * content normalized to a text block). Lenient providers read distinct turns
 * more clearly, but strict Anthropic-compatible relays (Kimi/MiniMax) 400
 * with "roles must alternate" — and consecutive user turns arise naturally
 * (compaction's [user prompt, user summary] shape, reminders after an
 * observation envelope). Same idea as kimi-code's merge-user-messages. */
function mergeConsecutiveAnthropicUserMessages(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === "user" && message.role === "user") {
      last.content = [...anthropicUserContentBlocks(last.content), ...anthropicUserContentBlocks(message.content)];
    } else {
      out.push({ ...message });
    }
  }
  return out;
}

function anthropicUserContentBlocks(content: Anthropic.Messages.MessageParam["content"]): Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return [...content];
}

/** Build a multimodal content array: leading text block (if non-empty) +
 * one image or document block per attachment. Anthropic accepts `image` and
 * `document` blocks via base64 source — `mime` becomes `media_type`. */
function userContentWithAttachments(
  text: string,
  attachments: MessageAttachment[],
): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const att of attachments) {
    if (att.kind === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: att.dataBase64,
        },
      });
    } else if (att.kind === "pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: att.dataBase64,
        },
        ...(att.name ? { title: att.name } : {}),
      });
    }
  }
  if (text.trim().length > 0) blocks.push({ type: "text", text });
  return blocks;
}

function openAIToolObservation(observation: ToolObservation): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: "tool",
    tool_call_id: observation.callId,
    content: observation.output ?? observation.error ?? "",
  };
}

function anthropicToolObservation(observation: ToolObservation): Anthropic.Messages.ToolResultBlockParam {
  const text = observation.output ?? observation.error ?? "";
  return {
    type: "tool_result",
    tool_use_id: observation.callId,
    content: anthropicToolResultContent(text, observation.attachments),
    is_error: Boolean(observation.error),
  };
}

/** Build the `content` for an Anthropic tool_result. With no visual payload
 * it's a plain string (the common case). When the tool returned attachments
 * (read_file on a screenshot/diagram/PDF), emit an array of inline image
 * and/or document blocks followed by the text note, so a vision/PDF-capable
 * model SEES the file. Anthropic tool_result content accepts text, image, and
 * document blocks (per the SDK ToolResultBlockParam type). */
function anthropicToolResultContent(
  text: string,
  attachments: MessageAttachment[] | undefined,
): string | Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam | Anthropic.Messages.DocumentBlockParam> {
  const media = (attachments ?? []).filter((att) => att.kind === "image" || att.kind === "pdf");
  if (media.length === 0) return text;
  const blocks: Array<
    Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam | Anthropic.Messages.DocumentBlockParam
  > = media.map((att) =>
    att.kind === "pdf"
      ? {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: att.dataBase64,
          },
          ...(att.name ? { title: att.name } : {}),
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: att.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: att.dataBase64,
          },
        },
  );
  if (text.trim().length > 0) blocks.push({ type: "text", text });
  return blocks;
}

function formatObservationMessages(observations: ToolObservation[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (observations.length === 0) return [];
  return [{ role: "user", content: observations.map(formatObservation).join("\n\n") }];
}

function formatObservation(observation: ToolObservation): string {
  return `Tool ${observation.name} (${observation.callId}) result:\n${observation.output ?? observation.error ?? ""}`;
}

/** call_ids of the stashed round's function_call items — the calls this
 * request's observations must join to (input to normalizeToolPairing). */
function responsesFunctionCallIds(items: OpenAI.Responses.ResponseInputItem[] | undefined): string[] {
  return (items ?? [])
    .map((item) =>
      (item as { type?: string }).type === "function_call" ? (item as { call_id?: unknown }).call_id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function canRetryOpenAIChatWithoutNativeToolReplay(error: unknown, observations: ToolObservation[]): boolean {
  if (observations.length === 0) return false;
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status !== 400) return false;
  const text = (errorMessage(error)).toLowerCase();
  // Recognize the various provider phrasings for a tool/tool_calls pairing
  // violation so the safe text-observation retry still kicks in:
  //   OpenAI:        "...must be followed by tool messages responding to each
  //                   'tool_call_id'"
  //   DeepSeek/Qwen: "Messages with role 'tool' must be a response to a
  //                   preceding message with 'tool_calls'"  (no "tool_call_id")
  if (!text.includes("tool_calls")) return false;
  return text.includes("tool_call_id") || text.includes("role 'tool'") || text.includes("preceding message");
}

function canRetryOpenAIChatWithoutHistoricalReasoning(
  error: unknown,
  hasHistoricalReasoning: boolean,
): boolean {
  if (!hasHistoricalReasoning) return false;
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status !== 400) return false;
  const text = errorMessage(error).toLowerCase();
  return text.includes("reasoning") || text.includes("extra inputs") || text.includes("extra fields");
}

function openAIChatToolCallIds(message: OpenAI.Chat.Completions.ChatCompletionMessageParam | undefined): string[] {
  if (!message || !("tool_calls" in message) || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((toolCall) => toolCall.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

function openAIChatTool(tool: ToolDescriptor): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolInputJsonSchema(tool),
    },
  };
}

function openAIResponseTool(tool: ToolDescriptor): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: toolInputJsonSchema(tool),
  } as OpenAI.Responses.Tool;
}

function anthropicTool(tool: ToolDescriptor): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toolInputJsonSchema(tool) as Anthropic.Tool.InputSchema,
  };
}

/** Return the exact JSON Schema sent to model providers for a tool input. */
export function toolInputJsonSchema(tool: ToolDescriptor): Record<string, unknown> {
  return tool.inputJsonSchema ?? zodToJsonSchema(tool.inputSchema);
}

function zodToJsonSchema(schema: ToolDescriptor["inputSchema"]): Record<string, unknown> {
  // Model tool APIs consume JSON Schema; OpenAPI 3's boolean exclusiveMinimum is rejected by draft-07+ validators.
  const converted = convertZodToJsonSchema(schema, { target: "jsonSchema7" });
  if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
    return { type: "object", properties: {} };
  }
  const { $schema: _schema, definitions: _definitions, ...jsonSchema } = converted as Record<string, unknown>;
  return jsonSchema;
}

function openAIResponseRole(message: ChatMessage): "user" | "assistant" | "system" {
  if (message.role === "assistant") return "assistant";
  if (message.role === "system") return "system";
  return "user";
}

function stateData<T>(state: ProviderState | undefined, provider: ProviderState["provider"]): T {
  return state?.provider === provider && typeof state.data === "object" && state.data ? (state.data as T) : ({} as T);
}

function stateFor(provider: ProviderState["provider"], data: unknown): ProviderState {
  return { provider, data };
}

let claudeSessionUuid: string | undefined;
/** Stable per-process session id for `metadata.user_id`'s session segment —
 * minted once per agent-host launch, matching how the real CLI rotates its
 * session id per launch. */
function claudeSessionId(): string {
  if (!claudeSessionUuid) claudeSessionUuid = globalThis.crypto.randomUUID();
  return claudeSessionUuid;
}

/** Format the first 32 hex chars of `hex` as a UUID (8-4-4-4-12). */
function hexToUuid(hex: string): string {
  const h = hex.slice(0, 32).padEnd(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Extract the dotted version from a `claude-cli/X.Y.Z (...)` User-Agent. */
function claudeCliVersion(ua: string): string | undefined {
  const match = /claude-cli\/(\d+(?:\.\d+)*)/.exec(ua);
  return match ? match[1] : undefined;
}

/** Compare dotted numeric versions; missing trailing segments count as 0. */
function compareDottedVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// The real Claude Code CLI switched metadata.user_id from the legacy
// `user_<hex>_account_<uuid>_session_<uuid>` string to a JSON object at 2.1.78.
// Emit whichever the impersonated UA version implies (claudeRequestUserAgent),
// or the fingerprint is self-inconsistent — a 2.1.161 UA paired with the legacy
// shape is exactly the tell Anthropic uses to downgrade a request to
// third-party "extra usage". Mirrors sub2api FormatMetadataUserID.
const CLAUDE_JSON_USER_ID_MIN_VERSION = "2.1.78";

/** `metadata.user_id` in the exact shape the real Claude Code CLI sends.
 * Anthropic's Claude-Code validation requires a well-formed user_id; without it
 * an OAuth request is downgraded to third-party "extra usage". The identity
 * hashes derive from the subscription id (stable per account, contains no
 * token/PII); the session segment pins to the engine session when known (the
 * real CLI keeps one session uuid per conversation), falling back to a
 * per-agent-host-launch uuid for one-off requests. Format (JSON vs legacy
 * string) follows the impersonated CLI version — see the constant above. */
function claudeMetadataUserId(config: ModelConfig, sessionId?: string): string {
  const seed = config.subscriptionId || config.accountId || "reina";
  const deviceId = createHash("sha256").update(`reina-user:${seed}`).digest("hex");
  const accountUuid = hexToUuid(createHash("sha256").update(`reina-account:${seed}`).digest("hex"));
  const sessionUuid = sessionId ? conversationUuid(sessionId) : claudeSessionId();
  const version = claudeCliVersion(claudeRequestUserAgent(config));
  if (version && compareDottedVersion(version, CLAUDE_JSON_USER_ID_MIN_VERSION) >= 0) {
    return JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: sessionUuid });
  }
  return `user_${deviceId}_account_${accountUuid}_session_${sessionUuid}`;
}

/** Fallback heuristic: Claude model-ids that default to adaptive thinking when
 * `config.thinkingMode` isn't set. No provider API reports this capability, so
 * this only ships a sane out-of-the-box default — set `thinkingMode` per-model
 * in models.json to drive it from data instead of this list. Keyed on the
 * official Claude family (mirrors `supportsAnthropic1mContext`); non-Claude
 * proxy models (their own ids) never match and keep the budget path. */
function isAnthropicAdaptiveThinkingModel(model: string): boolean {
  return /^claude-(opus-4-[678]|sonnet-4-6|fable-5)/.test(model.toLowerCase());
}

// Models (keyed by id + endpoint) that returned a 400 rejecting the adaptive
// thinking shape. Learned at runtime so we stop sending it and fall back to
// budget-based thinking for the rest of the process — the static heuristic
// self-corrects without a code change. The endpoint is part of the key because
// the same model id can be served both by a proxy that lacks adaptive support
// and by the official API that has it.
const adaptiveThinkingUnsupported = new Set<string>();
function adaptiveCapabilityKey(config: ModelConfig): string {
  return `${config.model.toLowerCase()}|${config.baseUrl ?? ""}`;
}

/** Whether this turn uses adaptive thinking. Precedence: explicit `thinkingMode`
 * config → a learned downgrade (the endpoint already rejected adaptive) → the
 * model-id heuristic. */
function usesAdaptiveThinking(config: ModelConfig): boolean {
  if (config.thinkingMode) return config.thinkingMode === "adaptive";
  if (adaptiveThinkingUnsupported.has(adaptiveCapabilityKey(config))) return false;
  return isAnthropicAdaptiveThinkingModel(config.model);
}

/** Fold a top reasoning tier DOWN the ladder (max → xhigh → high), never up,
 * so we never send an effort the endpoint rejects. `supported` is the set of
 * top tiers the endpoint accepts — `config.supportedEfforts` when set (the
 * authoritative, data-driven source; see models.json), otherwise a
 * provider-specific heuristic. */
function clampTopEffort(effort: "xhigh" | "max", supported: readonly string[]): "high" | "xhigh" | "max" {
  if (effort === "max" && supported.includes("max")) return "max";
  return supported.includes("xhigh") ? "xhigh" : "high";
}

/** Top effort tiers (`xhigh`/`max`) the official Claude models accept, used
 * only when `config.supportedEfforts` isn't set. No provider API reports this
 * capability, so this only ships a sane out-of-the-box default for known ids —
 * set `supportedEfforts` per-model in models.json to drive it from data
 * instead of this list (mirrors `thinkingMode`). Known caps: `max` landed with
 * Opus 4.5 and Sonnet 4.6 has it too; `xhigh` (a tier between high and max)
 * arrived with Opus 4.7 and Fable 5 has it — Sonnet 4.6 rejects it. */
function heuristicAnthropicTopEfforts(model: string): ReadonlyArray<"xhigh" | "max"> {
  const m = model.toLowerCase();
  if (/opus-4-[78]|fable-5/.test(m)) return ["xhigh", "max"];
  if (/opus-4-[56]|sonnet-4-6/.test(m)) return ["max"];
  return [];
}

/** Map Reina's reasoning tier to the adaptive effort value. `low`/`medium`/
 * `high` are universal and pass through; the top tiers are gated on
 * `supportedEfforts` (config first, model-id heuristic as fallback) and fold
 * down — the adaptive auto-downgrade is a backstop, but capping avoids the
 * wasted probe. */
function anthropicAdaptiveEffort(
  effort: NonNullable<ModelConfig["reasoningEffort"]>,
  config: ModelConfig,
): AnthropicEffort {
  if (effort === "off") return "low"; // unreachable (off → no thinking upstream); type floor
  if (config.reasoningLevels !== undefined) return effort;
  if (effort !== "xhigh" && effort !== "max") return effort; // low | medium | high
  return clampTopEffort(effort, config.supportedEfforts ?? heuristicAnthropicTopEfforts(config.model));
}

/** Resolve the thinking config for a turn: adaptive (effort in `output_config`)
 * for newer Claude models, budget-based for older ones, or undefined when no
 * reasoning effort is set. */
export function resolveAnthropicThinking(config: ModelConfig): AnthropicThinkingPlan | undefined {
  // Normalize at the boundary: resumed sessions (rollout replay / SQLite) carry
  // the persisted model verbatim WITHOUT a zod parse, so a pre-migration
  // `extra-high` can reach here raw — unnormalized it would miss the budget map
  // (thinking silently off) or go out on the wire as-is (400).
  const effort = validatedReasoningEffort(config);
  if (!effort || effort === "off") return undefined; // off / unset → no thinking
  if (usesAdaptiveThinking(config)) {
    return {
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: anthropicAdaptiveEffort(effort, config) },
    };
  }
  const budget = { low: 1024, medium: 4096, high: 16384, xhigh: 32768, max: 49152 }[effort];
  if (!budget) return undefined;
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

/** Comma-separated value for the `anthropic-beta` header. Returns undefined
 * when no opt-in betas apply, so the caller can skip the header entirely.
 *
 * Two betas are auto-enabled based on the active model + reasoning config:
 *
 * - `interleaved-thinking-2025-05-14` — whenever extended thinking is on,
 *   lets the model emit `thinking` blocks BETWEEN tool calls within a
 *   single assistant turn ("think → tool → think → tool"). This is the
 *   meaningful upgrade over basic thinking; the existing stream loop
 *   already handles multiple `thinking` content_blocks per response, so
 *   no code path change is needed beyond the header. Models that don't
 *   support the beta ignore the header silently.
 *
 * - `context-1m-2025-08-07` — gated by a configured `contextWindowTokens`
 *   (> 200k) first, model family (Sonnet 4 / Opus 4.x) as fallback.
 *   Setting the header doesn't force long context — it just lifts the
 *   200k cap to 1M, harmless for short turns. The family fallback keys on
 *   prefixes so future point-releases inherit the cap without a code change.
 *
 * Override (escape hatch): `REINA_ANTHROPIC_BETAS` env var, comma-
 * separated, REPLACES the auto list entirely. Useful for trying a beta
 * that we don't auto-detect yet, or for forcing-off in a hostile proxy. */
function anthropicBetas(config: ModelConfig, plan: AnthropicThinkingPlan | undefined, usePromptCache = false): string | undefined {
  const override = process.env.REINA_ANTHROPIC_BETAS;
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const betas: string[] = [];
  if (config.authMode === "oauth") {
    // Claude Code-scoped OAuth tokens are billed against your *plan* limits only
    // when the request advertises the full Claude Code beta set; a missing beta
    // downgrades the request to third-party "extra usage" (or gets it rejected).
    // Mirror the official CLI's advertised set (sub2api's FullClaudeCodeMimicry
    // Betas). These are header-only capability opt-ins — inert unless the matching
    // request params are sent — so advertising them carries no behavioural change.
    betas.push(
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "prompt-caching-scope-2026-01-05",
      "effort-2025-11-24",
      "context-management-2025-06-27",
      "extended-cache-ttl-2025-04-11",
    );
  } else if (plan) {
    betas.push("interleaved-thinking-2025-05-14");
    // Direct-API adaptive requests carry effort in output_config; advertise the
    // effort beta so the endpoint honours it (the OAuth set already includes it).
    if (plan.outputConfig) betas.push("effort-2025-11-24");
  }
  // The 1h cache TTL rides the extended-cache-ttl beta. Every cache breakpoint
  // we attach carries `ttl:"1h"` by default (anthropicCacheControl), so an
  // API-key request without this header gets its ttl field 400-rejected — and
  // the cache-unsupported retry then strips caching entirely: double request,
  // zero cache, EVERY turn. The OAuth set above already advertises it; the
  // 5m tier needs no beta.
  if (usePromptCache && config.authMode !== "oauth" && anthropicCacheTtl() === "1h") {
    betas.push("extended-cache-ttl-2025-04-11");
  }
  if (supportsAnthropic1mContext(config)) betas.push("context-1m-2025-08-07");
  return betas.length > 0 ? betas.join(",") : undefined;
}

/** Whether to advertise the 1M-context beta. Config is authoritative: a
 * declared `contextWindowTokens` states the endpoint's real capability (proxy
 * aliases / future ids no regex can know — and it lets a user force the beta
 * OFF without REINA_ANTHROPIC_BETAS, which replaces the whole list). The
 * family regex only decides when nothing is declared. */
function supportsAnthropic1mContext(config: ModelConfig): boolean {
  if (config.contextWindowTokens !== undefined) return config.contextWindowTokens > 200_000;
  const lower = config.model.toLowerCase();
  return /^claude-(sonnet-4|opus-4)/.test(lower);
}

export function openAIReasoningEffort(config: ModelConfig): "none" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return resolveOpenAIReasoningEffort(config);
}
