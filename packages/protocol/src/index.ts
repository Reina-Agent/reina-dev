import { z } from "zod";
import type { ContextCompactionRecord, ContextComposition, ContextRequestRecord } from "./context-history.js";
export type { ContextCompactionRecord, ContextComposition, ContextHistory, ContextRequestDetail, ContextRequestRecord } from "./context-history.js";

export const permissionModes = ["plan", "default", "accept-edits", "bypass", "bubble"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const modelProviders = [
  "deterministic",
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  // Subscription-backed Codex (ChatGPT Plus/Pro). Speaks the OpenAI Responses
  // API but against `chatgpt.com/backend-api/codex` with OAuth Bearer auth and
  // a `chatgpt-account-id` header. See providers/src/index.ts (isCodex branch).
  "openai-codex-responses",
] as const;
export type ModelProvider = (typeof modelProviders)[number];

export const toolNames = [
  "write_todos",
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "grep",
  "glob",
  "run_shell",
  "task_output",
  "kill_shell",
  "monitor",
  "write_stdin",
  "apply_patch",
  "question",
  "plan",
  "task",
  "get_async_tasks",
  "recall_memory_chunk",
  "list_memory_chunks",
  "search_memory",
  "consolidate_memory",
  "list_skills",
  "read_skill",
  "web_fetch",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_status",
  "exit_plan_mode",
  "notify",
  "schedule_wakeup",
  "cancel_async_task",
  "update_async_task",
  "wait_async_tasks",
  // Legacy subagent-tool compatibility. Kept in the protocol and runtime
  // registry so persisted rollouts and stale calls remain executable, but
  // these names are no longer advertised to new model turns.
  "start_async_task",
  "check_async_task",
  "list_async_tasks",
  "gather_async_tasks",
  // Sibling channel: a subagent worker pushes a message to another live
  // worker (parent-mediated). Supervisors use update_async_task instead.
  "send_task_message",
  // Batch fan-out (codex Agent Jobs analog): dispatch one worker per item
  // with a bounded concurrency window; poll the batch as a unit.
  "start_task_batch",
  "check_task_batch",
  "submit_response",
  "note",
  "list_notes",
  "read_note",
  "update_note",
  "delete_note",
  "declare_audit_done",
  "search_tool",
  // Team-coordinator tools (Phase C team mode). They are exposed on demand
  // (for example via /team). The top-level coordinator builds a subtask DAG,
  // assigns owners, pushes the session phase forward, and DMs workers via
  // directed notes.
  "create_subtask",
  "update_subtask",
  "get_dag",
  "set_phase",
  "send_to_worker",
  // Dedicated Goal tools. Goal lifecycle is owned by the host, not by a
  // session mode or the legacy autopilot loop.
  "get_goal",
  "create_goal",
  "update_goal",
  // Java deserialization gadget lookup. Pure offline, embedded ~394-entry
  // catalog. Output JSON is verbose and gets a UI body-suppression rule in
  // the renderer (model still sees the full result); see conversation.js.
  "search_java_gadgets",
  "find_java_chains",
  // Kimi subscription server-side web tools (Moonshot search/fetch services).
  // Deferred; execute via the host bridge (token lives in the main process).
  "kimi_web_search",
  "kimi_web_fetch",
] as const;
export type ToolName = (typeof toolNames)[number] | `mcp__${string}__${string}`;

export type ToolPermissionLevel = "read" | "write" | "execute" | "network" | "state";
export type ToolApprovalPolicy = "allow" | "ask" | "deny";
export type MessageRole = "user" | "assistant" | "system";
export type ToolCallStatus = "pending_approval" | "running" | "completed" | "rejected" | "failed";
export type PendingQuestionStatus = "pending" | "answered" | "rejected";

// Matches Claude Code's effort tiers (low/medium/high/xhigh/max) plus an
// explicit `off` (thinking disabled) — six selectable states. `xhigh` is the
// Opus 4.7+ tier between high and max; pre-CC-parity builds called it
// `extra-high`, which is migrated below.
export const reasoningEfforts = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
/** Legacy persisted value → current tier. Applied wherever reasoningEffort is
 * parsed so old settings.json / sessions keep loading. */
export function normalizeReasoningEffort(value: unknown): unknown {
  return value === "extra-high" ? "xhigh" : value;
}

export const reasoningDialects = ["openai", "deepseek", "kimi", "qwen", "openrouter"] as const;
export const reasoningLevelsSchema = z.array(z.preprocess(normalizeReasoningEffort, z.enum(reasoningEfforts))).min(1);

const modelHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || seen.has(name.toLowerCase())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid or duplicate model header name", path: [name] });
    }
    seen.add(name.toLowerCase());
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Model header values must not contain line breaks or invalid characters",
        path: [name],
      });
    }
  }
});

/** Reject invalid custom headers rather than silently changing authentication. */
export function sanitizeModelHeaders(value: unknown): Record<string, string> | undefined {
  return value === undefined ? undefined : modelHeadersSchema.parse(value);
}

export const outputStyles = ["default", "concise", "explanatory", "learning"] as const;
export type OutputStyle = (typeof outputStyles)[number];

export const modelConfigSchema = z.object({
  provider: z.enum(modelProviders).default("deterministic"),
  model: z.string().default("reina-deterministic"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  /** Hard cap on tokens the model may generate per request. When set it is
   * sent as `max_tokens` to OpenAI-compatible chat backends, with a bounded
   * `max_completion_tokens` fallback on an explicit parameter rejection. Leave unset to
   * use the provider default — but note that a small provider default is the
   * usual cause of mid-answer truncation (the provider stops with
   * `finish_reason: "length"`). */
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.preprocess(normalizeReasoningEffort, z.enum(reasoningEfforts).optional()),
  /** How the model receives its reasoning effort (Anthropic only). `"adaptive"`
   * sends `thinking:{type:"adaptive"}` + `output_config.effort` — the shape the
   * newer Claude models (Opus 4.6+/Sonnet 4.6/Fable 5) require; `"budget"` sends
   * the older `thinking:{type:"enabled",budget_tokens}`. Set this per-model in
   * models.json so capability is data, not baked into code. When omitted the
   * provider falls back to a model-id heuristic. No remote API reports this, so
   * config is the authoritative source. */
  thinkingMode: z.enum(["adaptive", "budget"]).optional(),
  /** Legacy top-tier override, e.g. ["xhigh", "max"]. Only xhigh/max are
   * gated; low/medium/high retain their old pass-through behavior. Do not
   * reinterpret existing entries as a complete whitelist. New configurations
   * should use reasoningLevels for full capability validation. */
  supportedEfforts: z.array(z.preprocess(normalizeReasoningEffort, z.enum(reasoningEfforts))).optional(),
  /** Complete selectable effort set. Unlike legacy supportedEfforts (top tiers
   * only), every explicit effort is checked, including off. Never silently turn
   * thinking on when this set excludes off. Omit when capabilities are unknown. */
  reasoningLevels: reasoningLevelsSchema.optional(),
  /** OpenAI Chat wire dialect, independent from the model name. Ignored for
   * native Anthropic/Responses endpoints. Omit to use a known official endpoint
   * dialect or conservative OpenAI-compatible behavior. */
  reasoningDialect: z.enum(reasoningDialects).optional(),
  /** Explicit off encoding for generic OpenAI-compatible endpoints. Omission
   * preserves legacy behavior but does not guarantee that a default-on model
   * stops reasoning. A complete reasoningLevels set containing off also opts
   * into none; vendor dialects use their native disable control instead. */
  offEffort: z.literal("none").optional(),
  /** Auth strategy for the request. `"oauth"` switches Anthropic to Bearer
   * (subscription) auth + Claude Code identity impersonation instead of the
   * default `x-api-key`. Undefined behaves like `"api-key"`. */
  // "oauth"  — Claude Pro/Max subscription token: Bearer auth PLUS the full
  //            Claude Code impersonation set (betas, identity block, UA).
  // "bearer" — plain Bearer auth with none of the Claude Code extras. Used by
  //            Anthropic-COMPATIBLE endpoints authorized by an OAuth token
  //            (e.g. a Kimi subscription's api.kimi.com/coding endpoint).
  authMode: z.enum(["api-key", "oauth", "bearer"]).optional(),
  headers: modelHeadersSchema.optional(),
  /** Codex (ChatGPT subscription) `chatgpt-account-id`, extracted from the
   * OAuth access-token JWT. Only used by the `openai-codex-responses` provider. */
  accountId: z.string().optional(),
  /** Reference to a connected subscription account (`~/.reina/subscriptions.json`).
   * The desktop main process resolves this to a fresh `apiKey` (access token) +
   * `accountId` just before a session starts; it carries no secret itself. */
  subscriptionId: z.string().optional(),
  /** `User-Agent` impersonating the official CLI of the subscription, built by
   * the main process from the live npm package version and injected at resolve
   * time (alongside `apiKey`/`accountId`). Lets the provider forge the client
   * fingerprint without a hardcoded version. Only used by subscription paths. */
  subscriptionUserAgent: z.string().optional(),
  /** Server-side tools this subscription ships (e.g. Kimi's kimi_web_search /
   * kimi_web_fetch). Declared by the main process at resolve time so the
   * engine can promote them into the model's tools array natively — the
   * engine promotes whatever is listed and knows no vendor names. Capability
   * is data, not code: a new subscription kind with server tools only touches
   * its resolve site, never the engine. */
  subscriptionTools: z.array(z.string()).optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

/** Multimodal input attached to a user message. dataBase64 is the raw base64
 * payload without the `data:<mime>;base64,` prefix — providers that need the
 * prefix should rebuild it from `mime`. PDFs are sent as Anthropic document
 * blocks (Claude reads them natively). */
export type MessageAttachment = {
  kind: "image" | "pdf";
  mime: string;
  dataBase64: string;
  name?: string;
};

/** Provider-native reasoning captured from one assistant turn, kept so it can
 * be replayed into the model's context on later turns (Anthropic thinking
 * blocks with signatures, OpenAI Responses reasoning items with
 * `encrypted_content`, chat `reasoning_content`). This is the structured
 * counterpart to `ChatMessage.reasoning` (a flattened display string): it
 * carries exactly what the provider needs to ACCEPT the replay.
 *
 * `provider` + `model` scope it: signatures / encrypted content are only valid
 * for the exact provider+model that produced them, so a converter replays a
 * trace only on an exact provider+model match and otherwise sends `content`
 * alone (a stale signature is a 400). `blocks` is opaque to protocol and
 * engine — each provider in @reina/providers owns and interprets its own
 * shape. */
export type ReasoningTrace = {
  provider: ModelProvider;
  model: string;
  blocks: unknown;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: MessageAttachment[];
  /** Visible reasoning trace captured from the provider (Anthropic thinking
   * blocks, OpenAI reasoning summaries). Stored alongside the message so it
   * survives session reloads and can be rendered as a collapsible "Thoughts"
   * block above the assistant text. Empty/absent when the model didn't think
   * or thinking was disabled. */
  reasoning?: string;
  /** Structured, provider-native reasoning for this assistant turn (see
   * ReasoningTrace), kept so it can be replayed into the model context on later
   * turns. Distinct from `reasoning`, which is display-only. Absent on
   * user/system messages and when the provider produced no reasoning. */
  reasoningTrace?: ReasoningTrace;
  /** Internal continuation anchor: a message sent to the model (so the request
   * has a trailing user turn for systemReminders to weave into) but hidden from
   * the visible transcript by the renderer. Used by host-driven goal
   * continuation so autonomous "keep going" turns don't pile up as fake user
   * bubbles. Absent/false for normal messages. */
  ephemeral?: boolean;
  /** Hash snapshot of the dynamic model context after this hidden message was
   * consumed. The message body contains only changed sections; this metadata
   * lets later turns and restored sessions emit zero text when nothing changed.
   * If compaction drops the message, the missing baseline deliberately causes
   * one full context re-injection. */
  contextState?: {
    version: 1;
    sections: Record<string, string>;
  };
  /** Provenance for engine-injected, model-facing notices that ride as
   * `user`-role messages: the async-task state diff (`task-delta`), the
   * stale-file re-read nudge (`stale-read`), and the background completion
   * block (`task-notify`). Written for the model, not the reader — renderers
   * hide any message carrying this field. Typed so the renderer doesn't have
   * to sniff string prefixes (kimi #1990: prefix lists rot as wording
   * changes); the prefix match remains only as a fallback for sessions
   * persisted before this field existed. Absent on ordinary messages. */
  origin?: "task-delta" | "stale-read" | "task-notify";
  /** Provider finish reason for the model round that produced this assistant
   * message (Anthropic `stop_reason`, OpenAI `finish_reason`). Surfaced read-only
   * in the message's right-click menu as "Turn 结束原因". Absent on
   * user/system messages and when the provider reported no reason. */
  stopReason?: string;
  /** Token usage for the single model request that produced this assistant
   * message (not a session running total). Surfaced read-only in the message's
   * right-click menu as "用量". Absent on user/system messages. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  /** pi-style neutral structured record of a completed tool call, attached to
   * the ephemeral in-band tool-result message. Carries BOTH sides of the pair
   * in one message — the call (name + input) here, the output preview in
   * `content` — so providers can render native history items (Responses
   * function_call + function_call_output, Anthropic tool_use + tool_result)
   * with pairing guaranteed by construction: compaction can cut anywhere and
   * never orphan a call or a result. Absent on messages persisted before this
   * field existed — providers fall back to the flattened text `content`,
   * which is always written. */
  toolResult?: {
    callId: string;
    name: string;
    /** The tool's input arguments as recorded on the ToolCallRecord. */
    input?: unknown;
    /** Canonical model-facing result text. The live observation and durable
     * history replay use this exact value so the provider prompt stays
     * byte-stable across the pending-to-history transition. Older sessions
     * omit it and fall back to the flattened message `content`. */
    output?: string;
    /** Visual payloads (images) the tool produced — e.g. read_file on a PNG.
     * Replayed into the model's tool_result content blocks so the model can
     * SEE the file across turns, not just a text note. Only Anthropic
     * tool_result blocks accept inline images; on text-only provider paths
     * the `content` note stands in. Absent for ordinary text-output tools. */
    attachments?: MessageAttachment[];
  };
  createdAt: string;
};

/** A canonical invocation of a tool, used as a teaching example for the
 * model. Anthropic's advanced-tool-use research found that two or three
 * well-chosen examples lift call accuracy from ~72% to ~90% — the lift is
 * largest on tools with non-obvious arg shapes (enums, nested objects,
 * mixed-required-and-optional fields).
 *
 * Examples are rendered by `search_tool` inside the matching `<tool>`
 * block when a deferred tool surfaces. They do NOT ship in the cold-start
 * tools array — that's the whole point of pairing this with the deferred
 * exposure tier: pay the example-tokens only when the model is about to
 * use the tool. */
export type ToolUseExample = {
  /** One short clause describing what the example demonstrates. Keep it
   * action-oriented (e.g. "Poll CI every 5 min", "Two-perspective decision
   * on caching strategy"). Becomes a `<title>` in the rendered output. */
  description: string;
  /** Arguments that, when passed to the tool, would actually execute. Must
   * validate against the tool's `inputSchema`. The renderer JSON-stringifies
   * this, so any literal that survives `JSON.stringify` is fine. */
  input: unknown;
};

export type ToolDescriptor = {
  name: ToolName;
  description: string;
  permission: ToolPermissionLevel;
  requiresApproval: boolean;
  /** Raw MCP routing identity. Runtime MCP descriptors set both fields so
   * authorization and execution do not have to reverse a lossy model-facing
   * tool name such as `mcp__server__tool`. */
  mcpServer?: string;
  mcpTool?: string;
  concurrencySafe?: boolean;
  internal?: boolean;
  /** Exposure tier. `direct` (default) means the tool is in the cold-start
   * request array. `deferred` starts hidden: the model discovers it via
   * `search_tool` or the capability roster, then allowed definitions join
   * subsequent requests through `session.activeDeferredTools`. Discovery may
   * change the cached tools prefix once; an unchanged active set stays stable. */
  exposure?: "direct" | "deferred";
  /** One-line summary used by `search_tool` for deferred-tool discovery.
   * Keep it short enough to scan; falls back to the first sentence of
   * `description` when undefined. */
  catalogSummary?: string;
  inputSchema: z.ZodTypeAny;
  /** Optional raw JSON Schema for tools whose schema does not originate from
   * Zod, such as MCP tools. Providers should prefer this when present. */
  inputJsonSchema?: Record<string, unknown>;
  /** Optional canonical-invocation examples surfaced via `search_tool` for
   * deferred tools. See `ToolUseExample` for the rationale and shape. */
  examples?: ToolUseExample[];
};

export type ModelToolCall = {
  id: string;
  name: ToolName;
  input: unknown;
  summary: string;
  /** True when the provider could not parse the tool_call arguments as
   * JSON and fell back to a raw-wrapping object. Engine short-circuits
   * dispatch with a clear "args were unparseable" observation so the
   * model can resubmit instead of the tool downstream failing with a
   * misleading "missing required field". */
  parseFailed?: boolean;
};

export type PermissionDecision = "approve" | "edit" | "reject";

export type ToolCallRecord = {
  id: string;
  name: ToolName;
  input: unknown;
  summary: string;
  permission: ToolPermissionLevel;
  /** Raw MCP target copied from the authorized descriptor before any approval
   * pause. Keeping the pair on the record prevents config changes or sanitized
   * name collisions from rebinding an approved call to another server/tool. */
  mcpServer?: string;
  mcpTool?: string;
  status: ToolCallStatus;
  preview?: string;
  output?: string;
  error?: string;
  /** Relative path (from session cwd) to the full tool output persisted on
   * disk under `.reina/tool_outputs/`. Written for every non-empty executed
   * tool result as a complete audit trail and re-read source. When later-turn
   * replay truncates a large output, the engine appends a pointer to this file
   * so the model can `read_file` the complete output instead of losing the
   * middle. Absent only for empty results and outputs that failed to persist. */
  outputFile?: string;
  /** Decisions the UI should offer for this pending call. Set when status is pending_approval. */
  allowedDecisions?: PermissionDecision[];
  /** When set, this pending approval record was forwarded from a fork
   * subagent running in `permissionMode: "bubble"`. The parent's user
   * decides; the parent engine forwards the answer back to the child. */
  bubbledFromTask?: { id: string; name?: string };
  createdAt: string;
  completedAt?: string;
};

export type ToolObservation = {
  callId: string;
  name: ToolName;
  output?: string;
  error?: string;
  /** Visual payloads (images) produced by the tool this turn — carried from
   * the tool's ToolExecutionResult through to the provider so the model sees
   * them in the live tool_result. Only the Anthropic path renders them as
   * inline image blocks; text-only paths fall back to `output`. */
  attachments?: MessageAttachment[];
};

export type CompactBoundary = {
  id: string;
  type: "manual" | "auto" | "micro";
  compactType: "manual" | "auto" | "micro";
  createdAt: string;
  reason?: string;
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  preMessageCount: number;
  postMessageCount: number;
  messagesCompacted: number;
  historyPath?: string;
  lastUserMessageId?: string;
  preservedMessageIds: string[];
  summaryMessageId?: string;
  preservedSegment?: {
    summaryMessageId?: string;
    preservedMessageIds: string[];
  };
  reinjectedMessageIds?: string[];
};

export type SkillMetadata = {
  name: string;
  description: string;
  path: string;
  allowedTools?: string[];
  /** How this skill is meant to be invoked.
   *   - "inline" (default) — supervisor reads the SKILL.md body and
   *     applies it in its own conversation. Existing behavior.
   *   - "fork" — the skill is designed for one-shot deep work that
   *     wants the supervisor's context cache but should NOT clutter
   *     the supervisor's transcript. The supervisor reads the body,
   *     then dispatches a fork subagent via task({fork: true})
   *     with the skill body as the directive. Typical use:
   *     `/security-review`, `/init` — long-form audits the model
   *     should run once, summarize, and return.
   *
   * P2-9 ships the metadata. The runtime dispatch decision still lives
   * with the model — the field documents the skill author's intent and
   * lets the renderer show a "[fork-mode]" badge in the picker. */
  context?: "inline" | "fork";
  /** Frontmatter `model:` — model id this skill wants to run on. Applied
   * when the skill is dispatched to a subagent via
   * `task({skill: "<name>"})`: merged over the child session's
   * model the same way AgentProfile.model is (same provider/key, different
   * model id). Inline invocation cannot switch the main loop's model, so
   * the field is inert there. */
  model?: string;
  /** Frontmatter `effort:` — reasoning-effort tier this skill wants.
   * Applied alongside `model` on subagent dispatch (see above). */
  effort?: ReasoningEffort;
  /** Frontmatter `user-invocable: false` — hide this skill from the
   * user-facing `/skill` picker (model-only skill). Default (absent) is
   * user-invocable. */
  userInvocable?: false;
  /** Frontmatter `disable-model-invocation: true` — keep this skill OUT of
   * the model-visible skills list in the system prompt, so the model never
   * auto-invokes it; the user can still trigger it explicitly via `/skill`.
   * Default (absent) is model-visible. */
  disableModelInvocation?: true;
};

/** SKILL.md metadata minus the on-disk path — what frontmatter parsing alone
 * can produce. Each consumer attaches its own `path` (core keeps absolute
 * paths for Reveal-in-folder; ipc.ts mirrors that). */
export type ParsedSkillMetadata = Omit<SkillMetadata, "path">;

/** The single SKILL.md frontmatter parser behind core `loadSkills`, the
 * tools-side `list_skills`/`read_skill` name resolution, and the desktop
 * main-process skill listing — one implementation so the four consumers can
 * never drift. Hardened against real-world files:
 *   - UTF-8 BOM prefix (PowerShell's default encoding) would otherwise stop
 *     the `^---` anchor from matching and swallow the header into the body.
 *   - YAML block scalars (`description: >` folded / `|` literal, optional
 *     +/- chomping) — naive line parsing left the description as `">"`.
 *   - `allowed-tools` in Claude Code's comma-separated convention
 *     (`Read, Grep`) as well as space-separated.
 *   - Quote stripping only for a matching wrapping pair, never a lone edge
 *     quote. */
export function parseSkillFrontmatter(content: string, directoryName: string): ParsedSkillMetadata {
  const text = content.replace(/^\uFEFF/, "");
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!frontmatter) {
    return {
      name: directoryName,
      description: skillFirstParagraph(text) || `Workspace skill ${directoryName}`,
    };
  }

  const fields = parseSkillFrontmatterFields(frontmatter[1] ?? "");
  const name = fields.name || directoryName;
  const description =
    fields.description || skillFirstParagraph(text.slice(frontmatter[0].length)) || `Workspace skill ${name}`;
  const allowedTools = fields["allowed-tools"]?.split(/[,\s]+/).filter(Boolean);
  const contextRaw = fields.context?.trim().toLowerCase();
  const context = contextRaw === "fork" ? ("fork" as const) : contextRaw === "inline" ? ("inline" as const) : undefined;
  const model = fields.model?.trim() || undefined;
  const effortRaw = fields.effort?.trim().toLowerCase();
  const effort =
    effortRaw && (reasoningEfforts as readonly string[]).includes(effortRaw)
      ? (effortRaw as ReasoningEffort)
      : undefined;
  const userInvocable = fields["user-invocable"]?.trim().toLowerCase() === "false" ? (false as const) : undefined;
  const disableModelInvocation =
    fields["disable-model-invocation"]?.trim().toLowerCase() === "true" ? (true as const) : undefined;

  return {
    name,
    description,
    ...(allowedTools ? { allowedTools } : {}),
    ...(context ? { context } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
    ...(disableModelInvocation ? { disableModelInvocation } : {}),
  };
}

function parseSkillFrontmatterFields(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const block = value.match(/^([>|])[+-]?$/);
    if (block) {
      // Consume the indented continuation lines; folded (`>`) joins with
      // spaces, literal (`|`) preserves line breaks.
      const parts: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^[ \t]+\S/.test(lines[i + 1]!))) {
        parts.push(lines[++i]!.trim());
      }
      while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      value = parts.join(block[1] === ">" ? " " : "\n").trim();
    } else {
      const quoted = value.match(/^"(.*)"$/s) ?? value.match(/^'(.*)'$/s);
      if (quoted) value = quoted[1]!.trim();
    }
    result[match[1]!] = value;
  }
  return result;
}

function skillFirstParagraph(content: string): string | undefined {
  return content
    .split(/\r?\n\r?\n/)
    .map((item) =>
      item
        .replace(/^#+\s*/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean)
    ?.slice(0, 300);
}

/** A subagent task launched via the async task tool family. Tracks the
 * child engine's lifecycle so the parent can poll status, fetch the final
 * result, or cancel mid-flight. Stored on SessionState.asyncTasks so it
 * survives context compaction — the model can still see "task_xyz is
 * running" after older messages have been summarized away. */
export type AsyncTaskRecord = {
  /** task_<short> — referenced by check/cancel and shown in list output. */
  id: string;
  /** Optional human-readable handle assigned by the supervisor at
   * task dispatch time (e.g. "auth-reviewer"). When set, get /
   * update / cancel_async_task accept this name in place of the id.
   * Survives compaction so the supervisor can still address a worker
   * after the dispatch tool call rolled out of the live transcript.
   * Names are unique-per-session: starting a second task with the same
   * name returns an error rather than silently overwriting. */
  name?: string;
  /** Agent profile the child runs under (e.g. "plan", "summary", or a
   * custom profile from agents.json). */
  agent: string;
  /** The prompt handed to the child's first turn. Kept for telemetry and
   * because get_async_tasks echoes it back. */
  description: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "evicted"
    | "orphaned"
    | "recoverable"
    | "needs_attention"
    | "resuming"
    | "failed_unrecoverable";
  startedAt: string;
  completedAt?: string;
  /** Child session id for the currently active attempt, when known. */
  childSessionId?: string;
  /** Final assistant text from the child when status === "completed". */
  result?: string;
  error?: string;
  /** Tracks the isolation strategy. "none" reuses the parent's cwd;
   * "worktree" spawns a linked git worktree under .reina/worktrees/. */
  isolation: "none" | "worktree";
  /** Filled only for worktree isolation: the worktree path the child ran
   * in and the branch its commits landed on. The parent can `git diff
   * main..<branch>` to see changes. After teardown these are CLEARED
   * when the child made no changes (clean worktree → auto-removed) and
   * PRESERVED when the child made changes (worktree kept for inspection,
   * matches Claude Code's Agent tool behavior). */
  worktreePath?: string;
  worktreeBranch?: string;
  /** HEAD sha observed for the worktree when the task record was last
   * reconciled. Used to detect surprising resume targets. */
  worktreeHead?: string;
  /** HEAD sha captured at worktree creation. Used at teardown to detect
   * whether the child added commits; combined with `git status` it
   * decides "preserve vs auto-remove". Internal — not surfaced to the
   * model. */
  worktreeBaseSha?: string;
  /** Counts of model turns + tool calls the child performed. Helps the
   * parent decide whether the task is actually progressing. */
  turns?: number;
  toolCalls?: number;
  /** Durable attempt counters. A resumed child is a new attempt for the
   * same task, never a resurrection of the old child engine. */
  attemptCount?: number;
  resumeCount?: number;
  /** Recovery lease fields. Used to prevent two host processes from
   * starting fresh child attempts for the same recoverable task. */
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** Last heartbeat from a live child attempt. */
  lastHeartbeatAt?: string;
  /** Recovery classification metadata. This is model-visible via
   * check/list/gather, so messages must be concrete and non-speculative. */
  recovery?: {
    status: "orphaned" | "recoverable" | "needs_attention" | "resuming" | "failed_unrecoverable";
    reason: string;
    checkedAt: string;
    worktreeStatus?: "none" | "preserved" | "missing";
    leaseOwner?: string;
    leaseExpiresAt?: string;
  };
  /** Token / wall-clock cost the child accumulated. Filled when the task
   * settles (or on demand from `get_async_tasks`). Surfaced in the result
   * envelope so the supervisor can see the price of each delegation. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** Anthropic-only — see TokenUsage.cacheCreationInputTokens. */
    cacheCreationInputTokens?: number;
    reasoningTokens: number;
    durationMs: number;
  };
  /** ISO timestamp of when the supervisor first acknowledged a terminal
   * status via get_async_tasks. Once set, the engine sweeps the entry
   * out of `session.asyncTasks` after a grace period — keeps list output
   * focused on live + recently-finished work. Unread completions are NEVER
   * evicted (we don't drop results the supervisor never saw). */
  notifiedAt?: string;
  /** Set to true when the task was dispatched as fire-and-forget (the
   * supervisor passed `background: true` to task). The
   * engine uses this flag at settlement time to push a
   * `<task-notification>` event onto the completion injector, so the
   * supervisor sees the result on its next safe boundary without having
   * to remember to call check/gather. */
  background?: boolean;
  /** Set to true when the task was dispatched as a fork (the supervisor
   * passed `fork: true` to task). Forks inherit the parent's
   * recent message tail + skills + active deferred tools, so the model's
   * first call sees the parent's prompt-cache prefix and bills only the
   * fork-specific delta. Telemetry-only field — the runtime decision
   * happens at dispatch time based on the supervisor's input. */
  fork?: boolean;
  /** Set once a completion notification for this task has been drained
   * into the supervisor's transcript. Idempotency guard for the injector
   * — if the engine restarts mid-injection or the drain races with a
   * sweep, we never inject the same completion twice. */
  injectedAt?: string;
  /** True when this record represents a synchronous `task` tool dispatch
   * (blocks the parent turn rather than dispatching as fire-and-forget).
   * Default false. Sync records are written so the lifecycle is uniformly
   * observable across crash recovery / external cancel; get_async_tasks
   * filters them out by default to keep the live roster focused on real
   * async work. */
  sync?: boolean;
  /** Set when this worker was dispatched as one item of a start_task_batch
   * fan-out. Groups the batch's workers for check_task_batch and lets the
   * batch scheduler refill the concurrency window as members settle. */
  batchId?: string;
  /** True when the task has been moved out of `session.asyncTasks` (live
   * roster) into `session.asyncTasksArchived` (overflow area) due to the
   * live-cap eviction policy. Archived tasks are still gather/list-able
   * via `include_archived` but never re-emit lifecycle events and never
   * re-enter the live sweep loop. */
  archived?: boolean;
  /** Live token / wall-clock snapshot of the child engine WHILE it's
   * still running. Mirrors `usage` (which is only filled on settlement).
   * Updated on every child turn boundary above a delta threshold so the
   * supervisor's get_async_tasks can show "this worker has burned 80k
   * tokens so far" and decide whether to cancel. NOT used for final
   * billing — `usage` is authoritative after settlement. */
  runningUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** Anthropic-only — see TokenUsage.cacheCreationInputTokens. */
    cacheCreationInputTokens?: number;
    reasoningTokens: number;
    durationMs: number;
    turns: number;
  };
  /** Set to true when the task was originally dispatched as a fork but
   * the resume path could not faithfully reconstruct the fork context
   * (e.g., parent's message tail has drifted past the cache, or the
   * persisted forkContext is missing). The resumed child runs as a
   * normal subagent — supervisor is warned in the resume prompt so it
   * can decide whether to re-dispatch from scratch. */
  forkContextLost?: boolean;
  /** Snapshot of fork-inheritance pointers captured at dispatch time so
   * resume after process restart can reconstruct (best-effort) the
   * original fork context. Only set when `fork === true`. The pointers
   * are by-reference (message ids, skill names) — the manager resolves
   * them against the parent's CURRENT state on resume; if pointers no
   * longer match, `forkContextLost` is set instead. */
  forkContext?: {
    messageIds: string[];
    skillNames: string[];
    activeDeferredTools: string[];
  };
  /** Team mode: the DAG node this worker was dispatched for, set when the
   * supervisor passes `subtaskId` to task. The engine binds the
   * node (`status: in_progress` + `bindAsyncTaskId`) at dispatch and, on
   * settlement, mirrors the task's terminal status back onto the node
   * (completed / failed / cancelled) so downstream `blockedBy` edges
   * auto-unblock — no manual update_subtask round-trip. Absent for ordinary
   * (non-DAG) dispatches. */
  subtaskId?: string;
};

// ─── Goal v2 ────────────────────────────────────────────────────────────
//
// A session has at most one current Goal. GoalState is the sole durable
// source of truth for lifecycle, budget and autonomous-run state. Mutations
// happen through typed GoalCommand values and are persisted as GoalEvent
// snapshots. `revision`/`goalRevision` make stale model calls deterministic.

export const goalStatuses = ["active", "paused", "blocked", "complete"] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export type GoalActor = "user" | "model" | "runtime" | "verifier" | "system";

export type GoalBudgetLimits = {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
};

export type GoalUsage = {
  tokensUsed: number;
  turnsUsed: number;
  wallClockMs: number;
};

export type GoalRecord = {
  id: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  /** Increments when the objective/criterion changes. */
  revision: number;
  createdBy: "user" | "model";
  createdAt: string;
  updatedAt: string;
  usage: GoalUsage;
  budgetLimits?: GoalBudgetLimits;
  evidence?: string;
  terminalReason?: string;
  completedAt?: string;
};

export type GoalCompletionClaim = {
  id: string;
  goalId: string;
  goalRevision: number;
  evidence: string;
  claimedAt: string;
};

export type GoalRun = {
  id: string;
  goalId: string;
  goalRevision: number;
  startedAt: string;
  tokenBaseline: number;
  turnBaseline: number;
  rounds: number;
  lastContinuationAt?: string;
  stagnantTurns: number;
  lastProgressKey?: string;
  verifyRounds: number;
  lastVerifyReason?: string;
  lastVerifyFeedback?: string;
};

export type GoalState = {
  current: GoalRecord | null;
  history: GoalRecord[];
  run: GoalRun | null;
  completionClaim?: GoalCompletionClaim;
  /** Monotonic state-machine revision; every accepted command increments it. */
  revision: number;
};

export type GoalCommand =
  | {
      type: "create";
      objective: string;
      completionCriterion?: string;
      budgetLimits?: GoalBudgetLimits;
      expectedRevision?: number;
    }
  | {
      type: "replace";
      objective: string;
      completionCriterion?: string;
      budgetLimits?: GoalBudgetLimits;
      expectedRevision?: number;
    }
  | { type: "edit"; goalId: string; objective?: string; completionCriterion?: string; expectedRevision?: number }
  | { type: "pause"; goalId: string; expectedRevision?: number }
  | { type: "resume"; goalId: string; expectedRevision?: number }
  | { type: "clear"; goalId: string; reason?: string; expectedRevision?: number }
  | { type: "claim_complete"; goalId: string; evidence: string; expectedRevision?: number }
  | { type: "claim_blocked"; goalId: string; reason: string; expectedRevision?: number }
  | { type: "verification_passed"; claimId: string; evidence?: string }
  | { type: "verification_rejected"; claimId: string; reason: string; feedback: string }
  | { type: "advance_run"; progressKey: string; at?: string }
  | { type: "budget_reached"; reason: string };

export type UserGoalCommand = Extract<
  GoalCommand,
  { type: "create" | "replace" | "edit" | "pause" | "resume" | "clear" }
>;

export type GoalEventKind = GoalCommand["type"] | "migrated";

export type GoalEvent = {
  id: string;
  kind: GoalEventKind;
  actor: GoalActor;
  at: string;
  state: GoalState;
};

// Legacy rollout shape retained for read compatibility only. New code must
// never write SessionState.activeGoals or `session_goal` rollout items.
export const legacySessionGoalStatuses = ["active", "paused", "met", "cancelled", "budget_limited"] as const;
export type LegacySessionGoalStatus = (typeof legacySessionGoalStatuses)[number];

export type SessionGoal = {
  id: string;
  /** The condition text as typed by the user (or model). Free-form. */
  condition: string;
  status: LegacySessionGoalStatus;
  createdAt: string;
  /** Who initiated the goal — `user` for /goal slash, `model` for a
   * model-initiated legacy registration. */
  createdBy: "user" | "model";
  /** Set when status transitions to `met` or `cancelled`. */
  resolvedAt?: string;
  /** Required when status is `met`: the model's concrete evidence that
   * the condition is satisfied (test output, deployed URL, file diff
   * summary). Stored verbatim so a future review can audit the claim. */
  evidence?: string;
  /** Required when status is `cancelled`: the reason for giving up
   * (e.g. "scope changed", "infrastructure missing", "user pivoted"). */
  cancelReason?: string;
  /** Set when status is `budget_limited`: the engine-side limit that
   * stopped goal pursuit (e.g. "autopilot tokens limit reached"). */
  limitReason?: string;
  /** Tombstone for user-driven deletion (the 目标 card's 删除 control).
   * Rollout replay is upsert-by-id, so removal must be recorded as a final
   * event carrying this flag — the reducer then drops the goal instead of
   * re-adding it. A removed goal never renders and never gates anything. */
  removed?: boolean;
};

// ─── Team-mode (Phase C) primitives ─────────────────────────────────────
//
// Subtasks form a DAG owned by the top-level team coordinator. Each node is
// a unit of work delegated to a worker (typically an async subagent). The
// coordinator drives `phase` forward through the staged pipeline and uses
// the DAG to decide what to spawn next based on completed blockedBy edges.

/** Pipeline phases mirrored from OMC's team mode. Subset-friendly: the
 * coordinator can skip phases it doesn't need (e.g. small fix tasks may go
 * plan→exec→verify without a prd phase). Empty string is the implicit
 * "no phase declared" state for sessions that aren't running team mode. */
export const teamPhases = ["plan", "prd", "exec", "verify", "fix", "complete", "failed"] as const;
export type TeamPhase = (typeof teamPhases)[number];

/** A subtask is one node in the coordinator's DAG. Like AsyncTaskRecord but
 * planning-side rather than execution-side: a subtask can be `pending`
 * before any worker has been spawned for it, and a subtask can be
 * retried by binding a new async task id to it. Persisted via rollout
 * (`subtask` / `subtask_update` events) so the DAG survives reload. */
export type SubtaskRecord = {
  /** sub_<short> — referenced by update_subtask / send_to_worker / DAG view. */
  id: string;
  /** One-line summary shown on the DAG node. */
  title: string;
  /** Full instructions handed to the worker when the coordinator spawns one. */
  description: string;
  /** Worker name the coordinator pre-assigned this subtask to. Empty string =
   * unassigned. Workers should only act on subtasks where this matches. */
  owner: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "blocked";
  /** Subtask ids this one depends on; the DAG view dims nodes whose
   * blockedBy includes anything not yet completed. */
  blockedBy: string[];
  /** Reverse edges, derived & maintained by SubtaskStore for fast
   * "what's unblocked now?" queries when an upstream completes. */
  blocks: string[];
  /** Optional async task ids representing concrete execution attempts.
   * Multiple entries when the coordinator retried after a failure. The latest
   * one (last in the array) is the active binding. */
  asyncTaskIds: string[];
  /** Optional phase tag — which stage of the coordinator's pipeline created
   * this subtask. Lets the DAG view group nodes by phase. */
  phase?: TeamPhase;
  /** Free-form tag set the coordinator can use to mark category, file scope,
   * risk, etc. The DAG view can show these as small chips on the node. */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  /** Set by the coordinator when calling update_subtask with status terminal.
   * Carries the coordinator's interpretation (e.g. "completed, verified by ..."
   * or "failed, will retry with smaller scope"). Surfaced on the node
   * tooltip / detail view. */
  resultSummary?: string;
};

/** Lifecycle status for a shared audit note. Default is `"open"` — a
 * provisional finding or candidate that hasn't been verified. Transitions:
 * open → confirmed (verified) or open → dead (false positive / not
 * reachable). `todo` is for human-style scratch items. The status field
 * is the ONE bit of schema we keep beyond freeform tags — it's the
 * universal lifecycle bit for findings/leads across all audit personas. */
export type NoteStatus = "open" | "confirmed" | "dead" | "todo";

/** Index entry for a shared note. The full markdown body lives on disk
 * at `<cwd>/.reina/notes/<id>.md` with YAML frontmatter matching this
 * shape (minus the body) — read lazily via `read_note(id)` to avoid
 * pulling N×body into model context on every list_notes call. */
export type NoteIndexEntry = {
  /** Sequential human-readable id: `n_001`, `n_042`. Auditor reports
   * reference these directly. */
  id: string;
  title: string;
  /** Freeform tags. Convention: `sev:high/med/low` for severity,
   * `cwe-NNN` for CWE refs, `service:foo` / `component:bar` for grouping.
   * No schema enforcement — auditor / dev / red-team workflows all use
   * the same store with their own tag dialects. */
  tags: string[];
  /** Other note ids this note builds on. The core primitive for
   * expressing combination vulnerabilities — child A files n_001, child
   * B files n_002 with refs:[n_001], a third pass (parent agent or
   * human) sees the link explicitly. */
  refs: string[];
  status: NoteStatus;
  /** Who wrote it: "parent" (top-level session) or "sub_<id>" (subagent
   * task id). Lets the UI attribute findings to the right agent. */
  author: string;
  /** Optional targeted recipient. When set, this note is a directed
   * message in team mode — only intended for the named worker (or
   * coordinator inbox) to consume. `list_notes` defaults to filtering out
   * notes whose recipient is set and doesn't match the caller; pass
   * `includeDirected: true` to bypass. Absent on regular audit notes. */
  recipient?: string;
  createdAt: string;
};

/** Directory name of the GLOBAL cross-project notebook under REINA_HOME
 * (`<REINA_HOME>/notes`, `g_*` ids). Shared by the engine's NotesService
 * writer (packages/core) and the desktop main-process reader so the two can
 * never silently disagree on where global memory lives. */
export const GLOBAL_NOTES_DIRNAME = "notes";

// ── Obsidian on-disk interop (single source of truth) ───────────────────────
// On disk, refs are wikilinks ([[n_001]]) so Obsidian's graph view + backlinks
// connect the audit chain, and the tag namespace ':' becomes '/' — Obsidian's
// nested-tag separator (Obsidian silently truncates a tag at the first ':').
// Both are unwrapped on read so the in-memory model keeps its native n_001 /
// kind:finding form. These four functions define that contract for BOTH the
// core NotesService and the desktop main-process frontmatter reader — import
// them, do not copy them.
//
// Only the FIRST separator is the namespace colon (`kind:finding`,
// `file:apps/desktop/x.ts`); any '/' inside the value is real path text.
// So we convert every ':' on write but restore only the first '/' on read —
// otherwise a path-valued tag round-trips corrupted (file:a/b -> file:a:b).
// ponytail: assumes one namespace colon per tag (true for the whole
// vocabulary: kind:/sev:/component:/service:/file:/subtask:); a bare tag
// that itself contains '/' with no namespace would gain a spurious ':'.
export function toObsidianTag(tag: string): string {
  return tag.replace(/:/g, "/");
}
export function fromObsidianTag(tag: string): string {
  // A ':' means the tag is already native (legacy file written before the
  // Obsidian interop — on-disk Obsidian form never contains ':'). Converting
  // it would corrupt path-valued tags: file:a/b.ts -> file:a:b.ts.
  if (tag.includes(":")) return tag;
  return tag.replace("/", ":");
}
export function toWikiRef(ref: string): string {
  return `[[${ref}]]`;
}
export function fromWikiRef(ref: string): string {
  // Tolerate an Obsidian alias ([[n_001|display]]) — the writer never emits
  // one, but a human editing the vault can; the ref target is everything
  // before the '|', and passing the alias through would match no note id.
  const m = ref.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
  return m ? m[1]! : ref;
}

/** Index entry for one offloaded memory chunk (Phase B compaction).
 * Cheap to inject in the system prompt — content body is stored in
 * SQLite and pulled lazily via `recall_memory_chunk`. Mirrors the
 * progressive-disclosure pattern used by skills + notes. */
export type MemoryChunkMeta = {
  /** Sequential id within the session: `c_001`, `c_002`, ... */
  id: string;
  /** Owning session id (set on disk for query, redundant on the index). */
  sessionId: string;
  /** ISO timestamp of when this chunk was created (always at a compaction
   * boundary). Used for stable ordering and recency-based filtering. */
  createdAt: string;
  /** Single-line topic summary derived cheaply (first user message + main
   * tool names). <= 200 chars. Surfaced in the prompt index. */
  topicLine: string;
  /** Distinct tool names that appeared in this chunk's tool_calls — gives
   * the model a hint about what kind of work happened in the chunk. */
  toolNames: string[];
  /** Estimated token count of the chunk's content body, computed at write
   * time. Shown in the prompt so the model can budget recall calls. */
  tokenCount: number;
  /** ids of the original ChatMessage objects this chunk covers. Useful
   * for replay/debugging; not surfaced to the model. */
  messageIds: string[];
};

/** Full memory chunk including content body. Only loaded on demand by
 * `recall_memory_chunk(id)` — never injected into the system prompt. */
export type MemoryChunk = MemoryChunkMeta & {
  content: string;
};

/** Live state of the autopilot loop. Present (and `running:true`) only
 * when the engine is auto-driving parent turns. The renderer reads this
 * to show progress / "pause" controls; the engine itself uses it to
 * decide whether to auto-continue at turn boundaries. */
export type AutopilotState = {
  running: boolean;
  goal: string;
  startedAt: string;
  /** Optional hard limits — engine bails when any one fires. */
  maxWallClockMs?: number;
  maxTokens?: number;
  maxRounds?: number;
  /** Counters that drive the limits + UI progress display. */
  rounds: number;
  /** @deprecated Pre-Goal-v2 marker, retained only so load migration can
   * identify and discard an old Goal-backed autopilot mirror. */
  activeGoalId?: string;
  /** User has suspended autonomous continuation. The runtime stays present
   * but the legacy autopilot loop will not fire until the user resumes.
   * Distinct from `doneStatus` (terminal). */
  paused?: boolean;
  /** Wall-clock stamp of the last continuation turn the runtime launched.
   * Drives the UI "auto-continuing" indicator and time accounting. */
  lastContinuationAt?: string;
  /** Cumulative model tokens (input+output) spent across continuation turns,
   * for the token budget. Mirrors `rounds` for turns. */
  tokensUsed?: number;
  /** Cross-continuation stagnation tracking, ported from the bolt-on loop: if
   * the progress signature is unchanged for `stagnantTurns` consecutive
   * continuations the runtime auto-exhausts instead of burning budget. */
  stagnantTurns?: number;
  lastProgressKey?: string;
  /** Terminal state. Set by declare_audit_done (the model self-ending),
   * by the engine when a limit fires, or by the user pause action. */
  doneStatus?: "complete" | "exhausted" | "blocked" | "limit" | "paused";
  doneSummary?: string;
  doneAt?: string;
  /** How many times an independent completion verifier has rejected a
   * `declare_audit_done` attempt this run (autopilot-only). Bounded by
   * `ReinaConfig.autopilot.verify.maxRounds`; once it hits the cap the gate
   * stops re-judging and accepts the model's declaration (fail-open). */
  verifyRounds?: number;
  /** One-line reason from the most recent rejecting verdict, surfaced in the
   * Task panel so the user can see why the loop kept going. */
  lastVerifyReason?: string;
  /** The rejecting verdict's concrete next step. The declare_audit_done path
   * hands it to the model as the tool error; the idle-boundary verify has no
   * tool result to ride, so the continuation prompt reads it from here. */
  lastVerifyFeedback?: string;
};

export type TraceEvent = {
  id: string;
  type:
    | "session.created"
    | "turn.started"
    | "message.created"
    | "tool.pending"
    | "tool.completed"
    | "tool.rejected"
    | "tool.failed"
    /** Same-batch identical call short-circuited to a pointer at the original
     * (engine tool loop dedup); `data.duplicateOf` carries the original id. */
    | "tool.deduplicated"
    | "context.compacted"
    | "loop.repair"
    | "loop.limit"
    | "model.retry"
    | "model.context_overflow_recovery"
    | "question.pending"
    | "question.answered"
    | "plan.updated"
    | "turn.completed"
    | "turn.steered"
    | "turn.steer_retracted"
    | "turn.reminders.injected"
    | "session.interrupted"
    | "session.stale_approvals_reaped"
    | "session.config.updated"
    | "session.goal.paused"
    | "session.goal.updated"
    | "session.goal.removed"
    | "session.autotitled"
    | "exit_plan_mode.pending"
    | "exit_plan_mode.approved"
    | "exit_plan_mode.iterating"
    | "stale_reads"
    | "async_task.started"
    | "async_task.recovered"
    | "async_task.completed"
    | "async_task.failed"
    | "async_task.cancelled"
    | "async_task.timeout"
    | "async_task.stale"
    | "async_task.backgrounded"
    | "async_task.injected"
    | "async_task.skill_override"
    | "observation.turn_budget_spill"
    | "background.error"
    | "self_evolve.review"
    | "memory.consolidated"
    | "side_chat.started"
    | "side_chat.closed"
    | "cache.miss";
  createdAt: string;
  data: Record<string, unknown>;
};

export type ProviderState = {
  provider: ModelProvider;
  data: unknown;
};

export type AgentProfile = {
  name: string;
  description: string;
  prompt: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  model?: Partial<ModelConfig>;
  maxSteps?: number;
  /** Optional per-profile override for the subagent FOREGROUND BUDGET. When
   * set (and REINA_SUBAGENT_TIMEOUT_MS is not), a sync dispatch under this
   * profile blocks the supervisor for at most this long before detaching to
   * the background (the child is never killed on this budget). Falls back
   * to DEFAULT_SUBAGENT_TIMEOUT_MS (10 min). */
  subagentTimeoutMs?: number;
  /** Optional per-profile override for the stale watchdog's IDLE budget:
   * how long the child may go without emitting any stream event (while no
   * tool is running) before it is declared stuck and interrupted. Widen for
   * slow-thinking models. Env REINA_SUBAGENT_STALE_IDLE_MS wins over this. */
  staleIdleMs?: number;
  /** Optional per-profile override for the stale watchdog's IN-TOOL budget
   * (a tool call is running, or the first turn hasn't produced output yet).
   * Env REINA_SUBAGENT_STALE_IN_TOOL_MS wins over this. */
  staleInToolMs?: number;
  toolPermissions: Partial<Record<ToolName, ToolApprovalPolicy>>;
  /** Tool allow-list. When set, only these tool names (or `"*"` for all)
   * are exposed to this profile, layered on top of `toolPermissions` deny
   * entries. When undefined, every public tool that isn't explicitly
   * denied is exposed (legacy deny-only behavior). MCP tools may be
   * granted in bulk via the wildcard `mcp__<server>__*`. */
  tools?: ReadonlyArray<ToolName | "*" | `mcp__${string}__*`>;
  /** Deferred-by-default tools to force-expose for this profile. Each
   * named tool is promoted into the model's cold-start tools array (still
   * subject to `toolPermissions` deny). Use to give a coordinator-style
   * profile always-on access to tools that are otherwise discovered via
   * `search_tool` — at the cost of a profile-specific prompt-cache prefix.
   * Empty / undefined → default behavior (tools stay deferred). */
  extraDirectTools?: ReadonlyArray<ToolName>;
  /** UI hint for renderers: hex color (`#RRGGBB`) used to badge this
   * profile in the agent picker, Agent Team panel, and trace timeline.
   * Cosmetic only — has no effect on tool resolution or model behavior. */
  color?: string;
  /** Skill names to preload for this profile. When set, the engine
   * filters the workspace-loaded skills array down to just these names
   * before building the system prompt. A name with no matching
   * `.claude/skills/<name>/SKILL.md` or built-in is silently dropped.
   * When undefined, the full workspace skill catalog is exposed. */
  skills?: ReadonlyArray<string>;
  /** Verbatim text prepended to a subagent child's first user message
   * (the supervisor's brief). Lets a profile carry standing context —
   * project conventions, preferred libraries, "always reach for X" —
   * without duplicating it in every dispatch. Ignored for primary
   * profiles (no subagent dispatch happens against them). */
  initialPrompt?: string;
  /** MCP servers that must be in `connected` state before this profile
   * can dispatch. The engine polls `getMcpStatusForCwd` with a short
   * timeout (default 30s); when a required server hasn't reached
   * connected by the cap, dispatch fails with a clean error rather
   * than the model getting a half-broken tool catalog mid-turn. */
  requiredMcpServers?: ReadonlyArray<string>;
  /** Whitelist of MCP server names visible to this profile. When set,
   * MCP tools from any other server are stripped from the catalog at
   * resolveTools time. When undefined, every configured MCP server is
   * visible (existing behavior). Use this to scope a profile to just
   * the integrations it needs — e.g. a "github-only" reviewer profile
   * sees no slack / filesystem MCP tools. */
  mcpServers?: ReadonlyArray<string>;
  /** Optional. When set, runs under this profile MUST terminate by calling
   * the synthetic `submit_response` tool with arguments matching this schema.
   * The parent's ToolObservation receives `JSON.stringify(args)` as the
   * `output` instead of free-form text — useful for fan-out scenarios (code
   * audit, multi-file review) where the supervisor needs to aggregate
   * findings across N children programmatically. Designed for subagent
   * profiles; setting it on a `primary` profile is allowed but unusual. */
  responseSchema?: z.ZodTypeAny;
};

export type CompletionVerifyConfig = {
  /** Master switch. Default true; harmless when no real model resolves. */
  enabled?: boolean;
  /** Max consecutive rejections before the gate gives up and accepts the
   * declaration (fail-open against trapping a finished run). Default 3. */
  maxRounds?: number;
  /** On verifier ERROR (provider down / no verdict returned): true accepts
   * the model's declaration (default); false keeps the run active. */
  failOpen?: boolean;
  /** Model for the judge call. Merged over the session model and falls back
   * to `compactionModel`, then the session model, when unset. */
  model?: Partial<ModelConfig>;
};

export type ReinaConfig = {
  cwd?: string;
  agent?: string;
  permissionMode?: PermissionMode;
  model?: Partial<ModelConfig>;
  /** Model used for the side requests that auto-name new sessions after the
   * first turn. Falls back to the session model when unset. Configure a cheap
   * model here (e.g. haiku) to avoid spending big-model tokens on titles. */
  titleModel?: Partial<ModelConfig>;
  /** Model used for the compaction summary call. Same contract as
   * `titleModel`: merged over the session model (so include apiKey/baseUrl
   * when it lives on a different provider), falls back to the session model
   * when unset. A cheap long-context model keeps compaction fast and off the
   * big model's bill. */
  compactionModel?: Partial<ModelConfig>;
  /** Auto-title behavior. Disabled when `enabled: false`; otherwise the host
   * names any session that still has the default title after the first
   * assistant reply. */
  autoTitle?: {
    enabled?: boolean;
  };
  /** Dedicated Goal runtime behavior. */
  goal?: {
    /** Host-driven continuation safety cap. Default 50. */
    maxContinuationRounds?: number;
    /** Consecutive no-progress continuations before the Goal blocks. Default 3. */
    stagnationLimit?: number;
    /** Independent verification for model completion claims. */
    verify?: CompletionVerifyConfig;
  };
  /** Legacy autopilot behavior. Goal v2 never reads this namespace. */
  autopilot?: {
    /** Independent completion verification for an autopilot run's
     * `declare_audit_done` is gated by a separate judge-model call over a
     * compressed execution trace before the loop is allowed to close — a
     * decorrelated check against the working model self-declaring done
     * prematurely. Only fires in autopilot mode (interactive sessions have
     * the user as the judge). No-op when the resolved verifier model is the
     * deterministic provider (it cannot judge). */
    verify?: CompletionVerifyConfig;
  };
  outputStyle?: OutputStyle;
  outputStyleCustom?: string;
  toolLoop?: {
    hardMaxSteps?: number;
    stagnationLimit?: number;
    repeatedActionLimit?: number;
    consecutiveErrorLimit?: number;
    autoRepair?: boolean;
  };
  /** Subagent / fan-out behavior. */
  subagent?: {
    /** When true, `task({fork: true})` is allowed. Forks
     * inherit the supervisor's recent message tail + skills + deferred
     * tools so the first model call reuses the supervisor's prompt-cache
     * prefix — useful for fan-out workloads like code audit research.
     * Default true. */
    forkEnabled?: boolean;
    /** Default model for spawned subagent children ("run all workers on a
     * cheap model, leave the main session alone"). Merged over the parent
     * session's model at spawn time — same contract as `titleModel` /
     * `compactionModel`, so include apiKey/baseUrl when the cheap model
     * lives on a different provider. LOWEST priority: an AgentProfile's
     * `model` pin and a per-skill frontmatter model/effort override both
     * win at request time. Never applied to `fork: true` dispatches — a
     * fork's whole value is reusing the supervisor's prompt-cache prefix,
     * and switching models switches the cache namespace, so the fork
     * would pay a cold start anyway. */
    secondaryModel?: Partial<ModelConfig>;
  };
  /** Background self-improvement review (Hermes-style learning loop). When
   * enabled, after every `everyTurns` top-level turns the engine forks a
   * restricted child (the `self-review` profile — only note + file/skill
   * tools) that reviews the recent conversation and folds durable learnings
   * into the GLOBAL notebook (`note(scope:"global")`) and skills. The review
   * directive is an editable file at `<REINA_HOME>/self-evolve.md`. */
  selfEvolve?: {
    /** Master switch. Default false — a review spends a background turn's
     * worth of tokens, so it's opt-in. */
    enabled?: boolean;
    /** Fire the review once every N top-level turns. Default 5, min 1. */
    everyTurns?: number;
    /** Log a one-line "learned X" summary after a review writes something.
     * Default true. */
    notify?: boolean;
  };
  /** Background memory consolidation (the "dream" run): after a turn settles,
   * when a workspace has accumulated enough idle sessions, a detached
   * notes-only child folds their durable facts into the global notebook.
   * Env vars (REINA_MEMORY_*) override these per-process — config is the
   * user-facing knob, env the developer escape hatch. */
  memory?: {
    /** Master switch for the background run. Default true (the gates below
     * keep it rare). The manual consolidate_memory tool ignores this. */
    dream?: boolean;
    /** At least this long between runs per workspace. Default 72, 1–720. */
    cooldownHours?: number;
    /** At least this many idle sessions accumulated since the last run.
     * Default 10, 1–100. */
    minSessions?: number;
    /** Sessions must be untouched this long to count as settled material.
     * Default 6, 1–168. */
    idleHours?: number;
  };
  hooks?: ReinaHooks;
  tui?: {
    mouse?: boolean;
  };
  mcp?: {
    servers?: Record<
      string,
      {
        type?: "stdio";
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        timeoutMs?: number;
        inheritEnv?: boolean;
        enabled?: boolean;
      }
    >;
    /** Reina-specific MCP residency policy. mcp.json itself stays in the
     * portable cross-agent format (Claude Desktop / Cursor / Codex all read
     * it), so Reina's own preferences live here instead.
     *
     * Tools from servers named in `deferredServers` start hidden and join a
     * later request only after discovery. Any enabled server NOT named here is
     * "resident": its tools ship from turn one. Default (field omitted) is
     * "everything resident", matching Codex's `deferLoading=false` default. */
    deferredServers?: string[];
  };
};

/** Bounds + defaults for the `memory` consolidation knobs. Single source of
 * truth for every layer that consumes a knob value — the ipc sanitizer and
 * the engine's env/config resolution both clamp against this table, so the
 * ranges the settings page advertises are actually enforced (a hand-edited
 * reina.json or REINA_MEMORY_* env can't smuggle an out-of-range value in). */
export const MEMORY_DREAM_LIMITS = {
  cooldownHours: { min: 1, max: 720, fallback: 72 },
  minSessions: { min: 1, max: 100, fallback: 10 },
  idleHours: { min: 1, max: 168, fallback: 6 },
} as const;

export type TokenRequestBreakdown = {
  createdAt: string;
  provider: string;
  model: string;
  messagesCount: number;
  observationsCount: number;
  toolsCount: number;
  systemPromptChars: number;
  systemPromptTokens: number;
  messagesChars: number;
  messagesTokens: number;
  observationsChars: number;
  observationsTokens: number;
  toolsDescriptionChars: number;
  toolsSchemaChars: number;
  toolsTokens: number;
  totalChars: number;
  estimatedInputTokens: number;
  /** Read-only live preview calibrated from the most recent compatible
   * provider input plus the locally estimated change. Never provider usage. */
  projectedInputTokens?: number;
  composition?: ContextComposition;
  toolNames: string[];
  /** Fine-grained per-category breakdown for the context-window UI.
   * Optional so rollouts written before this field existed still load
   * (the renderer falls back to the coarse buckets above). All values
   * are token estimates. */
  categories?: TokenCategoryBreakdown;
  /** Per-tool token contribution for the "expand" view in the UI.
   * Sorted descending by total tokens so the heaviest tools surface
   * first. Optional for the same back-compat reason as `categories`. */
  toolDetails?: TokenToolDetail[];
};

export type TokenCategoryBreakdown = {
  /** Tokens that ACTUALLY ship to the model on the next request. */
  systemPromptBase: number;
  systemPromptSkills: number;
  systemPromptUserRules: number;
  messages: number;
  observations: number;
  reminders: number;
  toolsCore: number;
  toolsMcp: number;
  /** Tokens that DO NOT ship to the model this turn: every deferred tool
   * whose descriptor is currently hidden from the request array. Discovering
   * an allowed, available tool moves its definition out of this reserved tier
   * on the next request. */
  toolsCoreDeferred: number;
  toolsMcpDeferred: number;
  /** Sub-bucket of `toolsCore` / `toolsMcp`: tokens for originally-deferred
   * tools that ship on this request after discovery or an explicit profile,
   * mode, lifecycle, or subscription promotion. Resident MCP tools are not
   * counted as active deferred. NOT additive on top of `toolsCore`/`toolsMcp`;
   * those totals already include these tokens. */
  toolsCoreActiveDeferred?: number;
  toolsMcpActiveDeferred?: number;
  /** Sub-bucket of `reminders`: tokens for the hidden-tools reminder
   * specifically (the per-turn block that enumerates remaining deferred
   * tools and how to discover them). Tracked separately so cache-prefix
   * stability work can watch it move turn-to-turn. NOT additive on top
   * of `reminders`. */
  hiddenToolsReminder?: number;
  /** Reserved space the engine holds back so auto-compaction can fire
   * before the hard context-window cap is hit. */
  autocompactBuffer: number;
  /** Exact threshold used by shouldAutoCompactSession for this model. */
  autocompactThreshold?: number;
  /** Exact current estimate compared with autocompactThreshold. */
  autocompactEstimate?: number;
  /** Remaining = contextWindow - (sum of everything above). May go
   * negative if the request itself overflows the window. */
  freeSpace: number;
  /** Total context window of the active model. */
  contextWindow: number;
};

export type TokenToolDetail = {
  name: string;
  tokens: number;
  /** True when the tool's descriptor is hidden from this request's array —
   * its tokens are accounted for under `toolsCoreDeferred` /
   * `toolsMcpDeferred`, not the active buckets. */
  deferred: boolean;
  /** True when the tool came from an MCP server (mcp__server__tool). */
  mcp: boolean;
  /** True when this tool started deferred but ships on the current request
   * after discovery or an explicit profile, mode, lifecycle, or subscription
   * promotion. Resident MCP tools are excluded. Mutually exclusive with
   * `deferred: true`; always-direct tools have both flags false. */
  activeDeferred?: boolean;
};

export type TokenRequestTotals = {
  estimatedInputTokens: number;
  systemPromptTokens: number;
  messagesTokens: number;
  observationsTokens: number;
  toolsTokens: number;
};

export type TokenTurnUsage = {
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Anthropic-only — see TokenUsage.cacheCreationInputTokens. */
  cacheCreationInputTokens?: number;
  reasoningTokens: number;
  /** Authoritative provider total for the last completed request's
   * context-window footprint. Prefer this over input+output when present
   * because providers can include cached/reasoning accounting differently. */
  totalTokens?: number;
};

export type SessionState = {
  id: string;
  title: string;
  /** When this session was created by forking another (assistant menu
   * "创建分支"), the id of the source session. Drives the branch marker in the
   * sidebar. Absent for normal/root sessions. */
  parentSessionId?: string;
  agent: string;
  cwd: string;
  permissionMode: PermissionMode;
  model: ModelConfig;
  /** Dispatch-scoped model override, merged over BOTH the session model and
   * the profile's `model` pin at request time (most-specific wins). Set by
   * task when the dispatched skill's frontmatter declares
   * `model:`/`effort:` — without this the profile pin would silently clobber
   * the skill's choice on every request. */
  modelOverride?: Partial<ModelConfig>;
  outputStyle?: OutputStyle;
  outputStyleCustom?: string;
  messages: ChatMessage[];
  modelMessages?: ChatMessage[];
  toolCalls: ToolCallRecord[];
  readFileTimestamps?: Record<string, number>;
  recentFiles?: Array<{ path: string; mtimeMs: number; readAt: string }>;
  todos: Array<{ id: string; content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }>;
  /** Index into `toolCalls` of the most recent `write_todos` invocation.
   * Used by the engine's todo-nudge logic to decide when to remind the
   * model that the list has gone stale. Undefined until the first
   * write_todos call in the session. */
  lastWriteTodosToolCallIndex?: number;
  pendingQuestions: Array<{
    id: string;
    question: string;
    /** Short label (12 chars or so) displayed as a chip above the question
     * text. Useful when batching multiple questions to distinguish them at
     * a glance ("Auth method" / "Library" / "Approach"). */
    header?: string;
    options?: Array<{ label: string; description?: string; preview?: string }>;
    /** When true the UI renders checkboxes + Submit; the answer string is a
     * comma-joined list of picked labels. Defaults to single-select. */
    multiSelect?: boolean;
    /** Ties together N questions that came from a single batched `question`
     * tool call. The renderer groups them under one card with one Submit
     * button; the engine aggregates all answers into a single observation
     * keyed by groupId before resuming the model. */
    groupId?: string;
    /** Distinguishes a generic `question` HITL prompt from a specialized
     * gate emitted by a different tool. Used by `exit_plan_mode` so the
     * renderer can render the "approve this plan?" card differently, and
     * so the engine can apply side-effects on approval (switching out of
     * plan mode + flipping plan.status). */
    intent?: "question" | "exit_plan_mode";
    /** Optional payload tied to the intent. For exit_plan_mode this is the
     * plan markdown body so the UI can render it inside the gate card
     * without round-tripping back to session.plan. */
    intentPayload?: string;
    status: PendingQuestionStatus;
    answer?: string;
    createdAt: string;
    answeredAt?: string;
    /** Set when this question was bubbled up from a subagent worker via the
     * escalation channel: the worker called `question` while running as a
     * child, and the engine minted this mirror entry on the parent session so
     * the supervisor's UI can collect the answer and forward it back down.
     * Absent on the top-level agent's own questions. The renderer uses it to
     * label the prompt ("from worker X"). */
    bubbledFromTask?: { id: string; name?: string };
  }>;
  plan?: { content: string; status: "draft" | "approved"; updatedAt: string };
  skills: SkillMetadata[];
  /** Deferred-exposure tool names the model has discovered (via
   * `search_tool` or a direct call) in this session. Persists across turns and
   * reload via rollout, and lets allowed definitions join later request arrays.
   * Native definitions still obey the active profile, session blocks, and host
   * availability; MCP definitions also require a matching live runtime tool.
   * Empty/undefined = no deferred tool has been discovered yet. */
  activeDeferredTools?: string[];
  /** Snapshot of MCP server names taken at first system-prompt build, kept
   * frozen for the rest of the session so the cached system prompt prefix
   * (Anthropic ephemeral / OpenAI auto) stays byte-stable when servers
   * connect or drop mid-session. Live drift surfaces in the volatile
   * reminder so the user can `/new` to refresh the cached catalog. */
  mcpServerNamesSnapshot?: string[];
  /** Currently running / completed async subagent tasks scoped to this
   * session. Each entry survives compaction so the model can keep checking
   * back on long-running tasks. See AsyncTaskRecord for fields. */
  asyncTasks?: AsyncTaskRecord[];
  /** Overflow area for tasks evicted from `asyncTasks` due to the live-
   * roster cap (default 200, overridable via REINA_MAX_LIVE_ASYNC_TASKS).
   * Archived tasks carry `archived=true` and are accessible via
   * gather/list with `include_archived: true`. The manager NEVER emits
   * lifecycle events for archived tasks — they're cold storage. */
  asyncTasksArchived?: AsyncTaskRecord[];
  /** Persisted per-(agent, briefKey) failure counter for the brief-retry
   * guard. Survives process restart so a brief that already failed 3
   * times before the engine crashed still gets refused on reload. The
   * manager rehydrates its in-memory map from this array on boot and
   * writes back on each increment. Key is `${agent}::${normalizedBrief}`. */
  failedBriefs?: Array<{ agent: string; briefKey: string; count: number; lastFailedAt: string }>;
  /** Persistent composer toggles. Each ON entry overlays its
   * mode definition's `extraDirectTools` onto whatever the active profile
   * already exposes (deny still wins) AND injects a per-turn system
   * reminder. Goal is intentionally not a mode: it has its own lifecycle.
   * Session-scoped (a new session starts with all modes off); persisted
   * via the `session_modes_changed` rollout event for cold-start replay.
   * Empty / undefined ↔ no mode active. See packages/core/src/session-modes.ts
   * for the canonical mode roster. */
  sessionModes?: {
    /** @deprecated Accepted only when replaying pre-Goal-v2 snapshots. */
    goal?: boolean;
    team?: boolean;
  };
  /** Snapshot of `{taskId: status}` as of the LAST turn boundary. Used by
   * `injectAsyncTaskSnapshot` to diff against the current roster and
   * push ONLY state changes to the model — instead of dumping the full
   * roster every turn. New tasks (not in snapshot) and tasks whose
   * status flipped get surfaced; quiet tasks stay quiet. The model
   * pulls the full roster on demand via `get_async_tasks`. */
  lastTurnTaskStatuses?: Record<string, AsyncTaskRecord["status"]>;
  /** Per-session memory-chunk index. Populated by ChunkStore on session
   * load and after each compaction when REINA_COMPACTION_OFFLOAD=1.
   * Empty / undefined when the feature is off or no compaction has
   * produced chunks yet. Chunk content bodies live in SQLite
   * (`memory_chunks` table) and are read lazily via the
   * `recall_memory_chunk` tool — the index here only carries metadata. */
  memoryChunks?: MemoryChunkMeta[];
  /** Shared audit notebook — index entries only (no body). Each entry
   * corresponds to a markdown file under `<cwd>/.reina/notes/<id>.md`.
   * Populated by NotesService on engine boot (disk scan) and on every
   * `note` tool call. Shared by parent + all subagents — Reina's
   * cross-pollination channel for combination-vulnerability discovery.
   * Body is read lazily via `read_note(id)` to avoid context bloat. */
  notes?: NoteIndexEntry[];
  /** In-memory index of the GLOBAL notebook (`<REINA_HOME>/notes`, id
   * prefix `g_`) — cross-project durable memory injected into every
   * session. Separate from `notes` (per-workspace); the note tools route
   * by `scope`. Bodies read lazily via `read_note(id, scope:"global")`. */
  globalNotes?: NoteIndexEntry[];
  /** Append-only log of what background self-evolve reviews wrote, one entry
   * per review that changed something (empty reviews are not recorded). Kept
   * OUT of the model context — purely a UI/audit surface the renderer projects
   * into persistent transcript notices. Capped to the most recent entries. */
  selfEvolveLog?: { summary: string; at: string }[];
  /** Team-mode subtask DAG owned by the top-level coordinator. Team mode
   * builds this graph via create_subtask / update_subtask and pushes the
   * `phase` field through the pipeline as work progresses. Subagents
   * ignore both fields. Persisted via `subtask` /
   * `subtask_update` rollout events. */
  subtasks?: SubtaskRecord[];
  /** Current team-mode phase (plan / prd / exec / verify / fix /
   * complete / failed). Undefined for sessions not running team mode. */
  phase?: TeamPhase;
  /** Dedicated durable Goal state. This is authoritative for lifecycle,
   * runtime, budgets and verification. */
  goal?: GoalState;
  /** @deprecated Pre-Goal-v2 rollout compatibility only. */
  activeGoals?: SessionGoal[];
  /** Autopilot mode: when true, the engine auto-continues parent turns
   * after each natural turn boundary until a stop condition fires
   * (declare_audit_done / time limit / token budget / user pause).
   * See AutopilotState for live status. */
  autopilot?: AutopilotState;
  /** Depth in the subagent hierarchy. 0 (or undefined) = top-level session
   * the user is talking to. 1 = subagent. Reina only allows flat fan-out;
   * a subagent cannot spawn another subagent. */
  subagentDepth?: number;
  /** True when this session is a spawned subagent. The engine uses it to
   * strip delegation / HITL / memory tools from the child's toolset and to
   * refuse those tools at execution time even if a stale schema slipped them
   * through. Undefined on top-level sessions. */
  isSubagent?: boolean;
  /** True when this session was spawned as a FORK of its parent — meaning
   * the child inherited the parent's recent message tail + skills + system-
   * prompt-relevant context, and the dispatch added a `<fork-directive>`
   * user message as the launch trigger. Forks share the parent's prompt-
   * cache prefix on first call, which is the whole point of the mode.
   * `isFork=true` implies `isSubagent=true`. Forks are forbidden from
   * spawning their own subagents (no daisy-chaining). */
  isFork?: boolean;
  /** True when this session is a SIDE-CHAT child — the ephemeral "/btw"
   * companion forked from a top-level session so the user can ask side
   * questions without disturbing the main turn. Side chats inherit the
   * parent's FULL message history (byte-identical prefix → prompt-cache
   * hit) plus a boundary notice, and the tool dispatcher hard-vetoes every
   * non-`read` tool (kimi-style enforcement of codex's read-only policy).
   * `isSideChat=true` implies `isSubagent=true`. Never persisted — side
   * chats die with the parent session or on explicit close. */
  isSideChat?: boolean;
  /** JSON-serialized arguments from the most recent `submit_response` tool
   * call. Set by the engine when a subagent running under a profile with
   * `responseSchema` calls submit_response. Read by `runSubagent` /
   * `driveAsyncChild` to use as the parent's tool observation in place of
   * the last assistant message. */
  submittedResponse?: string;
  trace: TraceEvent[];
  summary?: string;
  compactBoundaries?: CompactBoundary[];
  providerState?: ProviderState;
  interrupted?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** Anthropic-only — see TokenUsage.cacheCreationInputTokens. Aggregated
     * across all turns this session. Optional for back-compat with rollouts
     * written before this field existed. */
    cacheCreationInputTokens?: number;
    reasoningTokens: number;
    turns: number;
    /** Subset of input/output/cached/reasoning that was rolled up from child
     * (subagent / async task) engines. Subtract from the totals to get the
     * parent's own consumption. Renderers use this to show "self vs child"
     * breakdowns; the totals still include children for cost accounting. */
    childInputTokens?: number;
    childOutputTokens?: number;
    childCachedInputTokens?: number;
    childCacheCreationInputTokens?: number;
    childReasoningTokens?: number;
    /** Subset rolled up from single-shot side requests made on the session's
     * behalf (compaction summaries, auto-title, autopilot verifier). Totals
     * above include them; before these fields the spend was dropped entirely
     * (invisible to the bill). See core/side-usage.ts. */
    sideInputTokens?: number;
    sideOutputTokens?: number;
    sideCachedInputTokens?: number;
    /** Context-window footprint. Source "provider" is the authoritative total
     * for the most recent completed provider request, set only when the usage
     * payload gives enough information to compute it. Source "estimate" is the
     * engine's o200k re-anchor written right after a compaction so renderers
     * show the drop immediately; the next provider total replaces it. Core
     * trigger logic only trusts source "provider". Renderers fall back to
     * summing `lastRequest.categories` for an estimate when this is absent. */
    contextTokens?: number;
    contextTokensSource?: "provider" | "estimate";
    /** Codex-style auto-compaction window baseline ("prefill input tokens").
     * The authoritative context total observed on the first provider response
     * AFTER the most recent compaction — i.e. the size of the stable prefix
     * (system prompt + tools + summary + preserved tail) that compaction can't
     * shed. The auto-compaction trigger scopes its budget to
     * `contextTokens - autoCompactBaseline` (growth since this window started)
     * so the fixed prefix never re-fires compaction. Cleared on every
     * compaction so the next response re-seeds it. Absent until the first
     * provider total of a window lands. Mirrors codex `AutoCompactWindow`. */
    autoCompactBaseline?: number;
    /** Live context-window footprint = the latest authoritative base (the
     * provider total above, or the post-compaction estimate) plus an o200k
     * estimate of pending tool observations not yet sent to the provider.
     * Updated on every context mutation (each tool result, compaction) so the
     * renderer's ring climbs in real time between model responses instead of
     * only snapping at each completion. Renderers prefer this over
     * `contextTokens` for the headline; it is always >= the provider base. */
    liveContextTokens?: number;
    /** Most recent model request measured before dispatch. These are local
     * estimates, useful for explaining why a turn is expensive even before
     * the provider returns authoritative usage. */
    lastRequest?: TokenRequestBreakdown;
    /** Most recent provider-reported usage payload, normalized to Reina's
     * token fields. */
    lastTurn?: TokenTurnUsage;
    /** Cumulative local request estimates, split by prompt/tool/message
     * bucket. Provider totals above remain authoritative for billing when
     * available. */
    requestTotals?: TokenRequestTotals;
    /** Cumulative prompt-cache waste (pi-style): prompt tokens that were in
     * the previous round's prompt — and should therefore have been cache
     * reads — but were re-billed at full/write price instead. Absent until
     * the first counted miss. See core/cache-stats.ts for the detection. */
    cacheWaste?: {
      missedTokens: number;
      missCount: number;
      /** v2 only counts regressions from a previously observed reusable prefix. */
      method?: "reusable-prefix-v2";
    };
  };
  createdAt: string;
  updatedAt: string;
};

export type AgentRunResult = {
  session: SessionState;
  pendingApprovals: ToolCallRecord[];
  pendingQuestions: SessionState["pendingQuestions"];
};

/**
 * Rollout event log — the append-only persistence format inspired by codex.
 *
 * Every mutation to a SessionState is recorded as a discrete RolloutItem and
 * appended to `<cwd>/.reina/sessions/<id>.jsonl`. Loading replays the file
 * line-by-line through a reducer to reconstruct the current SessionState.
 *
 * Why this shape:
 *   - Writes are pure appends. Concurrent renames + auto-titles can never
 *     clobber each other because each emits its own line; the reducer picks
 *     the last one.
 *   - Crash safety: at most the final partial line is lost; the rest of
 *     history is intact.
 *   - Audit / undo: full state derivation is replayable.
 *
 * A "meta" item is always the first line, holding the initial creation-time
 * snapshot of the session header (id, cwd, agent, model, etc.). Subsequent
 * items mutate parts of that state.
 */
export type RolloutLine = {
  /** ISO-8601 timestamp the event was queued. Wall-clock; ordering across
   * processes relies on file append ordering, not the timestamp. */
  ts: string;
} & RolloutItem;

export type RolloutItem =
  | { type: "session_meta"; meta: SessionMeta }
  | { type: "session_replace"; session: SessionState }
  | { type: "config"; changes: SessionConfigChanges }
  | { type: "message"; message: ChatMessage }
  | { type: "tool_call"; record: ToolCallRecord }
  | { type: "tool_update"; record: ToolCallRecord }
  | { type: "todos"; todos: SessionState["todos"] }
  | { type: "question"; question: SessionState["pendingQuestions"][number] }
  | { type: "question_update"; question: SessionState["pendingQuestions"][number] }
  | { type: "provider_state"; state: ProviderState }
  | { type: "provider_state_clear" }
  | { type: "usage"; usage: NonNullable<SessionState["usage"]> }
  | { type: "compacted"; boundary: CompactBoundary }
  | { type: "summary"; summary: string }
  | { type: "interrupted"; at: string }
  | { type: "plan"; plan: NonNullable<SessionState["plan"]> }
  | { type: "skills"; skills: SkillMetadata[] }
  | { type: "trace"; event: TraceEvent }
  | { type: "read_file"; path: string; mtimeMs: number; readAt: string }
  | { type: "async_task"; task: AsyncTaskRecord }
  | { type: "async_task_update"; task: AsyncTaskRecord }
  | { type: "subtask"; subtask: SubtaskRecord }
  | { type: "subtask_update"; subtask: SubtaskRecord }
  | { type: "phase"; phase: TeamPhase | null }
  | { type: "goal_event"; event: GoalEvent }
  /** @deprecated Pre-Goal-v2 rollout compatibility only. */
  | { type: "session_goal"; goal: SessionGoal }
  | { type: "active_deferred_tools"; names: string[] }
  | { type: "mcp_servers_snapshot"; names: string[] }
  /** One background self-evolve review's summary line. Appended by the
   * detached review itself (it completes AFTER the turn's store flush, so
   * without its own rollout line the entry would vanish on an app quit —
   * rollout replay is how relaunch rebuilds the session). */
  | { type: "self_evolve"; entry: NonNullable<SessionState["selfEvolveLog"]>[number] };

/** Initial snapshot of the SessionState header — everything that's set at
 * creation time and changes only via explicit `config` events afterward. */
export type SessionMeta = {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  permissionMode: PermissionMode;
  model: ModelConfig;
  outputStyle?: OutputStyle;
  outputStyleCustom?: string;
  createdAt: string;
};

/** Partial update emitted whenever any header-level field changes via
 * setTitle / setAgent / setModel / setPermissionMode / setOutputStyle /
 * updateConfig. Each non-undefined field is applied to SessionState. */
export type SessionConfigChanges = {
  title?: string;
  agent?: string;
  permissionMode?: PermissionMode;
  model?: Partial<ModelConfig>;
  outputStyle?: OutputStyle;
  outputStyleCustom?: string;
  cwd?: string;
  /** Sparse delta for SessionState.sessionModes — only flags whose value
   * actually flipped show up. Apply by spreading onto the existing
   * sessionModes record. Absent ↔ no mode toggle this update. */
  sessionModes?: {
    /** @deprecated Accepted only when replaying old config events. */
    goal?: boolean;
    team?: boolean;
  };
};

export type ModelRequest = {
  messages: ChatMessage[];
  tools: ToolDescriptor[];
  observations: ToolObservation[];
  systemPrompt: string;
  providerState?: ProviderState;
  /** Engine session id (`ses_<uuid>`). Providers that need a stable
   * per-conversation identity derive it from this — the Codex backend's
   * session_id/conversation_id headers must hold ONE value for the whole
   * conversation (the real CLI pins its rollout uuid) or upstream sticky
   * routing, and with it prompt-cache affinity, resets every turn.
   * Auxiliary one-off requests (title, compaction) may omit it. */
  sessionId?: string;
  /** Per-turn reminders that should reach the model but stay OUT of the
   * system prompt. Providers wrap them in `<system-reminder>` tags. The
   * engine materializes OpenAI-family snapshots into hidden model history
   * after each successful request so later tool rounds extend, rather than
   * rewrite, the cached prefix. */
  systemReminders?: string[];
  /** `"none"` suppresses prompt-cache WRITE markers on providers where cache
   * writes cost extra (Anthropic cache_control breakpoints bill 1.25x). Set it
   * on one-shot side requests with a throwaway prefix — the fenced compaction
   * summary, title, autopilot verifier — where the written cache is never read
   * again. Do NOT set it on the cache-reuse compaction fast path (that request
   * deliberately re-reads the main conversation's cached prefix). Mirrors pi's
   * `cacheRetention: "none"` (#6618). */
  promptCache?: "none";
};

export type ModelStreamEvent =
  | { type: "context-request"; request: ContextRequestRecord }
  | { type: "context-history-event"; event: ContextCompactionRecord }
  | {
      /** Accepted follow-up in a child task's conversation. Only the public
       * message is included; assembled resume/system prompts stay private. */
      type: "task-message";
      id: string;
      text: string;
      sender: "user" | "supervisor";
      createdAt: string;
    }
  | {
      /** A new child turn, including a resumed or interrupted follow-up. */
      type: "task-turn-started";
      id: string;
      createdAt: string;
    }
  | {
      /** Durable final answer, which may come from submittedResponse without
       * appearing in the provider's text deltas. */
      type: "task-turn-completed";
      id: string;
      text: string;
      createdAt: string;
    }
  | {
      type: "text-delta";
      text: string;
    }
  | {
      /** A user message committed mid-turn by the engine's pending-steer
       * drain. Fires when a `send_message` arrives while a turn is in
       * flight — agent-host calls `engine.injectSteer`, which queues the
       * message; the engine drains the queue at iteration boundaries.
       * Renderer reaction: append the user bubble to the transcript and
       * clear the in-progress assistant buffer so the next text-delta
       * starts a fresh assistant entry (responding to the steer rather
       * than appending to the previous response). */
      type: "user-message";
      text: string;
      /** Identity of the drained steer (engine-stamped, or caller-supplied via
       * injectSteer). Lets the renderer drop exactly the pending-steer row that
       * landed inline instead of guessing by text value. */
      steerId?: string;
      attachments?: MessageAttachment[];
    }
  | {
      /** A streaming attempt was abandoned mid-flight (the connection dropped)
       * and the engine is re-issuing the whole request. Renderer reaction:
       * discard the in-progress assistant + reasoning buffer so the retry's
       * fresh stream replaces the partial instead of appending to it. Mirrors
       * Codex, which rebuilds the request from history on a stream error rather
       * than stitching the partial. */
      type: "stream-reset";
    }
  | {
      /** Provider-agnostic reasoning text delta. Anthropic emits these as
       * thinking_delta blocks; OpenAI Responses emits reasoning summary text
       * deltas when `reasoning.summary: "auto"` is requested. The renderer
       * accumulates them into a per-message Thoughts disclosure. */
      type: "reasoning-delta";
      text: string;
    }
  | {
      type: "tool-input-delta";
      index: number;
      id?: string;
      name?: string;
      delta: string;
      input: string;
    }
  | {
      type: "tool-progress";
      id: string;
      name: ToolName;
      status: "running" | "completed" | "failed";
      input?: unknown;
      command?: string;
      message?: string;
      output?: string;
      elapsedMs?: number;
      totalLines?: number;
      totalBytes?: number;
      taskId?: string;
    }
  | {
      /** Real-time HITL question pushed mid-turn. Used by the subagent
       * escalation channel: when a worker calls `question`, the parent mints
       * a mirror pending question and emits this so the renderer can show the
       * prompt immediately — the result-time `question_request` desktop event
       * can't fire because the parent's run() is still blocked driving the
       * child. The renderer routes this into the same dock as `question_request`
       * and answers via `answer_question` (the parent's answerQuestion
       * short-circuits the mirror id back to the awaiting child). */
      type: "question-request";
      question: SessionState["pendingQuestions"][number];
    }
  | {
      /** Real-time HITL approval pushed mid-turn. Sibling of `question-request`
       * for the bubble channel: when a subagent's gated tool call bubbles up,
       * the parent mints a mirror `pending_approval` record and emits this so
       * the approval prompt surfaces immediately — the result-time
       * `permission_request` desktop event can't fire while the parent's run()
       * is still blocked driving the child (sync `task` dispatch). agent-host
       * translates it to the top-level `permission_request` message the
       * renderer already handles; `approve_tool`'s bubbled bypass forwards the
       * verdict to the awaiting child. */
      type: "permission-request";
      toolCall: ToolCallRecord;
    }
  | {
      type: "context-compaction-started";
      compactType: "manual" | "auto";
      reason: string;
    }
  | {
      type: "context-compacted";
      boundary: CompactBoundary;
    }
  | {
      /** A background self-evolve review folded durable learnings into global
       * memory / skills and produced a one-line summary. Fired detached AFTER
       * the turn that triggered it (see engine.runSelfEvolveReview). Renderer
       * reaction: surface a persistent "💾 self-evolve" notice in the transcript
       * so the memory/skill change is never silent — Hermes-style, must not be a
       * missable toast. Also mirrored into `session.selfEvolveLog` so a reloaded
       * session can restore the notices. */
      type: "self-evolve-review";
      summary: string;
      at: string;
    }
  | {
      type: "context-compaction-failed";
      compactType: "manual" | "auto";
      reason: string;
      error: string;
    }
  | {
      /** Cumulative session usage changed mid-turn (model response recorded,
       * tool observation appended, child rollup, compaction re-anchor).
       * Payload is the authoritative `session.usage` snapshot — renderers
       * re-render the context ring immediately instead of waiting for the
       * end-of-turn session_snapshot. Mirrors codex's TokenCount event. */
      type: "usage-updated";
      usage: NonNullable<SessionState["usage"]>;
    }
  | {
      type: "loop-repair";
      reason: "no_progress" | "repeated_action" | "consecutive_errors";
      message: string;
      turnCount: number;
      maxSteps: number;
      hardMaxSteps: number;
      preservedObservations: number;
    }
  | {
      type: "loop-limit";
      reason: "max_steps" | "hard_max_steps" | "no_progress" | "repeated_action" | "consecutive_errors";
      message: string;
      turnCount: number;
      maxSteps: number;
      hardMaxSteps: number;
      preservedObservations: number;
    }
  | {
      /** A stream event from a child engine spawned via task,
       * forwarded up to the parent's stream so the renderer can show "agent
       * team" activity under the launching tool card. The envelope keeps
       * the original event shape verbatim. */
      type: "subagent-event";
      taskId: string;
      childSessionId: string;
      event: ModelStreamEvent;
    }
  | {
      /** A stream event from the session's SIDE-CHAT child (the "/btw"
       * companion), forwarded up the parent's stream so the renderer's
       * side-chat panel can render it without a dedicated channel. Same
       * envelope idea as `subagent-event`, minus the task roster. */
      type: "side-chat-event";
      childSessionId: string;
      event: ModelStreamEvent;
    }
  | {
      /** Side-chat turn lifecycle. `started` fires when a prompt is accepted,
       * `completed`/`failed` when the child's runTurn settles, `closed` when
       * the side chat is torn down (session close / explicit close). The
       * renderer uses this to drive the panel's busy state instead of
       * guessing from deltas. */
      type: "side-chat-state";
      status: "started" | "completed" | "failed" | "closed";
      error?: string;
    }
  | {
      /** Lifecycle ping for the parent's async task roster. Fires when a
       * task is created / status changes / completes — enabling the
       * renderer to refresh the Agent Team panel without waiting for the
       * (much later) end-of-turn session_snapshot. The payload is the
       * authoritative record; treat as upsert keyed on `task.id`. */
      type: "async-task-updated";
      task: AsyncTaskRecord;
    }
  | {
      /** Pre-kill warning from the subagent watchdog. Fires when a child's
       * idle window passes the warning threshold (50% of the stale budget)
       * but hasn't yet exceeded the kill threshold. Gives the UI (and the
       * supervisor on its next turn via snapshot injection) a chance to
       * intervene with update_async_task or cancel_async_task before the
       * watchdog reaps the child. Emitted once per task per stale episode
       * — sustained staleness past the kill window produces a separate
       * `async-task-updated` with status=failed. */
      type: "async-task-warning";
      taskId: string;
      reason: "stale-idle" | "stale-in-tool";
      idleMs: number;
      remainingMs: number;
    }
  | {
      /** Fired when a background (fire-and-forget) async task settles
       * and the engine queues its result onto the completion injector.
       * The supervisor will see a `<task-notification>` user-role
       * observation at the next safe boundary (start of runTurn /
       * between continueLoop iterations). The UI can use this event
       * to surface a "task completed" toast before the supervisor
       * formally acknowledges the result. */
      type: "async-task-injected";
      task: AsyncTaskRecord;
    }
  | {
      /** Bulk recovery notice fired by SubagentManager.recoverStaleOnLoad
       * when a fresh process boot discovers tasks that were `running`
       * in the previous incarnation. Kept under the historical event name
       * for compatibility; payload tasks may now be `recoverable`,
       * `needs_attention`, or `failed_unrecoverable`, not just `evicted`. */
      type: "async-task-evicted-batch";
      tasks: AsyncTaskRecord[];
    }
  | {
      /** A shared note was created or modified. Fires after the markdown
       * file lands on disk and after `session.notes` index has been
       * updated. Renderer should upsert by `note.id`. */
      type: "notes-updated";
      note: NoteIndexEntry;
      /** "created" | "modified" | "deleted". `modified` fires on
       * `update_note` (status flips, body edits, tag changes); `deleted`
       * fires on `delete_note` and carries the removed entry as the
       * payload so renderers can identify which row to splice out. */
      change: "created" | "modified" | "deleted";
    }
  | {
      /** The GLOBAL cross-project notebook (`<REINA_HOME>/notes`) changed —
       * a self-evolve review or a note(scope:"global") write landed.
       * Deliberately payload-free: the notebook is shared across sessions,
       * so renderers re-list it from disk (reina:list-notes with
       * scope:"global") instead of merging per-session deltas. Distinct from
       * `notes-updated` so per-project consumers (workspace notebook cache,
       * rollout) never see global writes. */
      type: "global-notes-updated";
    }
  | {
      /** Autopilot status changed (started, round advanced, ended). The
       * renderer reads this to drive the "挂机审计" progress UI. The
       * payload is the authoritative state snapshot. */
      type: "autopilot-updated";
      state: AutopilotState;
    }
  | {
      /** An independent completion verifier judged a `declare_audit_done`
       * attempt (autopilot-only). The renderer surfaces "验收中 / 验收驳回"
       * on the Goal card. `pass=false` means the loop keeps running with the
       * verdict's feedback injected. */
      type: "autopilot-verify";
      round: number;
      pass: boolean;
      reason: string;
    }
  | {
      /** Lifecycle ping for a team-mode subtask (Phase C). Fires when
       * a node is created, status flips, owner is reassigned, or a
       * blockedBy edge changes. Renderer upserts by `subtask.id` and
       * re-renders the DAG. The payload is the authoritative record. */
      type: "subtask-updated";
      subtask: SubtaskRecord;
      change: "created" | "updated" | "removed";
    }
  | {
      /** Team-mode phase advanced. Renderer updates the phase indicator
       * above the DAG (plan→prd→exec→verify→fix→complete). null clears
       * the indicator (team mode not active). */
      type: "phase-changed";
      phase: TeamPhase | null;
    }
  | {
      /** Authoritative Goal v2 state changed. */
      type: "goal-state-changed";
      state: GoalState;
      event: Pick<GoalEvent, "id" | "kind" | "actor" | "at">;
    }
  | {
      /** Independent verifier result for one Goal completion claim. */
      type: "goal-verification";
      claimId: string;
      round: number;
      pass: boolean;
      reason: string;
    }
  | {
      /** A non-fatal side-effect failure (auto-title model call, save flush,
       * worktree teardown, etc.) the engine deliberately swallowed so the
       * turn could complete, but which the user should still be able to see.
       * Renderers should at minimum console.warn this; a debug panel may
       * surface a toast. `category` is a stable short tag the renderer can
       * filter on (e.g. "autotitle", "session.save", "worktree.cleanup"). */
      type: "background-error";
      category: string;
      message: string;
      context?: Record<string, unknown>;
    };

export type ModelStreamHandler = (event: ModelStreamEvent) => void;

export type TokenUsage = {
  /** Full input side of this turn's request — INCLUSIVE of cache reads and
   * cache-creation writes, so `cachedInputTokens` and `cacheCreationInputTokens`
   * are subsets of it, never additive on top. Canonical across providers:
   * OpenAI/OpenAI-compat (Kimi, GLM, DeepSeek…) already report `prompt_tokens`
   * this way; the Anthropic normalizer folds its separately-reported cache
   * fields in to match. Invariant when `totalTokens` is present:
   * `inputTokens + outputTokens === totalTokens`. This keeps downstream math
   * provider-agnostic — e.g. non-cached input = `inputTokens - cachedInputTokens`. */
  inputTokens: number;
  outputTokens: number;
  /** Context-window total for this turn. OpenAI reports `total_tokens` directly;
   * for Anthropic the normalizer derives it. Equals `inputTokens + outputTokens`
   * by the invariant above (cache is already inside `inputTokens`). */
  totalTokens?: number;
  /** Cached-read input tokens: the subset of `inputTokens` served from the
   * prompt cache (billed at a discount). Not additive on top of `inputTokens`. */
  cachedInputTokens?: number;
  /** Tokens written into the prompt cache on this turn (Anthropic; billed
   * 1.25x/2x input by TTL). Distinguishes "cold cache write" (next turn should
   * hit) from "no cache support" — both show `cachedInputTokens=0`. A subset of
   * `inputTokens`, not additive. OpenAI-compat providers don't surface it. */
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
};

export type ModelTurn = {
  content?: string;
  /** Concatenated reasoning text from the provider — Anthropic thinking
   * blocks, OpenAI Responses reasoning summary, etc. Engine writes this onto
   * the resulting assistant message so reloads can re-render the Thoughts
   * disclosure. */
  reasoning?: string;
  /** Structured provider-native reasoning blocks for this turn (see
   * ReasoningTrace). The engine stores this on the assistant message so later
   * turns can replay it into context. Parallel to `reasoning` (display text). */
  reasoningTrace?: ReasoningTrace;
  toolCalls: ModelToolCall[];
  providerState?: ProviderState;
  usage?: TokenUsage;
  /** The model stopped because it hit its output-token cap (OpenAI
   * `finish_reason: "length"`, Anthropic `stop_reason: "max_tokens"`, or
   * Responses `incomplete` with reason `max_output_tokens`). The engine marks
   * the assistant message so the truncation isn't silent. Like Codex/Claude we
   * do NOT auto-continue — raise `maxOutputTokens` to avoid it. */
  truncated?: boolean;
  /** The raw provider stop/finish reason for this turn (OpenAI Chat
   * `finish_reason`, Responses `incomplete_details.reason`, Anthropic
   * `stop_reason`). Normal completions (`stop`/`tool_calls`/`end_turn`/
   * `tool_use`) and the output-cap case (`length`/`max_tokens`, already flagged
   * via `truncated`) need no special handling. Abnormal values — most notably
   * `content_filter` from provider-side output moderation — let the engine
   * surface WHY a stream ended early instead of silently closing the turn. */
  stopReason?: string;
};

export const hookEvents = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "onStop",
  "onAsyncTaskComplete",
  "sessionStart",
  "sessionEnd",
  "preCompact",
] as const;
export type HookEvent = (typeof hookEvents)[number];

export type ReinaHook = {
  matcher?: string;
  command: string;
  timeoutMs?: number;
};

export type ReinaHooks = Partial<Record<HookEvent, ReinaHook[]>>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Normalize an unknown thrown value to a human string. Centralized here (the
 * lowest layer, imported everywhere) so the dozens of inline
 * `e instanceof Error ? e.message : String(e)` sites share one definition —
 * change error formatting (e.g. unwrap `.cause`) in one place. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeProvider(value: string): ModelProvider {
  switch (value) {
    case "openai":
      return "openai-chat";
    case "claude":
    case "anthropic":
      return "anthropic-messages";
    default: {
      const parsed = z.enum(modelProviders).safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `invalid provider: ${value}; expected deterministic, openai-responses, openai-chat, or anthropic-messages`,
        );
      }
      return parsed.data;
    }
  }
}

export function normalizePermissionMode(value: string): PermissionMode {
  const parsed = z.enum(permissionModes).safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid permission mode: ${value}; expected ${permissionModes.join(", ")}`);
  }
  return parsed.data;
}
