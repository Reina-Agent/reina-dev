import type { ChatMessage, ModelConfig, ReinaConfig, RolloutItem, SessionState } from "@reina/protocol";
import { createId, modelConfigSchema, nowIso } from "@reina/protocol";
import { nextModelTurnStream } from "@reina/providers";
import { rollupSideUsage } from "./side-usage.js";
import { pushTrace } from "./trace.js";

/** Minimal host surface the TitleController needs from AgentEngine. Mirrors
 * the controller contracts in controllers/ (TodosHost etc.): the title stays
 * on `session.title` because persistence and the renderer read it by name,
 * but every WRITE to it from the auto-title subsystem goes through here.
 *
 * `session` must be getter-backed at the wiring site — loadSession and
 * rollbackToMessage replace the engine's session with a fresh object, and
 * generateAutoTitle re-reads the title AFTER awaiting the model call, so a
 * captured value would both check and write an orphan session. */
export interface TitleHost {
  readonly session: SessionState;
  record(item: RolloutItem): void;
  touch(): void;
  flushToStore(): void;
  reportBackgroundError(category: string, error: unknown, context?: Record<string, unknown>): void;
}

/** Owns session titling: the model-driven auto-title side call and the
 * first-user-message fallback. Settings can change between side requests. */
export class TitleController {
  private autoTitleInFlight = false;

  constructor(
    private readonly host: TitleHost,
    private titleModel?: Partial<ModelConfig>,
    private autoTitleConfig?: ReinaConfig["autoTitle"],
  ) {}

  updateConfig(input: Pick<ReinaConfig, "titleModel" | "autoTitle">): void {
    if ("titleModel" in input) this.titleModel = input.titleModel;
    if ("autoTitle" in input) this.autoTitleConfig = input.autoTitle;
  }

  /**
   * Ask the configured title model to summarize the conversation in a few
   * words and set it as the session title. Idempotent — safe to call after
   * every turn; bails out unless the session still has the default (or expected
   * provisional) title and a real first exchange to summarize.
   *
   * Returns the new title when it sets one, `null` otherwise. Failures are
   * swallowed (we never want a title side-call to fail a turn).
   */
  async generateAutoTitle(expectedProvisionalTitle?: string): Promise<string | null> {
    if (this.autoTitleConfig?.enabled === false) return null;
    if (this.autoTitleInFlight) return null;
    if (!isReplaceableTitle(this.host.session.title, expectedProvisionalTitle)) return null;

    const firstUser = this.host.session.messages.find((m) => m.role === "user");
    const firstAssistant = this.host.session.messages.find((m) => m.role === "assistant");
    if (!firstUser || !firstAssistant) return null;

    const userText = chatMessageText(firstUser).trim();
    const assistantText = chatMessageText(firstAssistant).trim();
    if (!userText) return null;

    // Title model defaults to the session's model. Deterministic provider can't
    // produce a meaningful title — skip rather than seed the title with the
    // fixture response. If the user explicitly configured a non-deterministic
    // titleModel, honor that even when the session model is deterministic.
    const titleModelConfig = modelConfigSchema.parse({
      ...this.host.session.model,
      ...this.titleModel,
    });
    if (titleModelConfig.provider === "deterministic") return null;

    this.autoTitleInFlight = true;
    try {
      const prompt =
        `Conversation:\nUser: ${truncateForTitle(userText, 600)}\nAssistant: ${truncateForTitle(assistantText, 600)}`;
      const systemPrompt =
        "You name chat conversations. Read the exchange and reply with a 3-6 word title summarizing the topic. " +
        "Reply with ONLY the title — no quotes, no trailing punctuation, no prefix. Use the user's language.";
      const turn = await nextModelTurnStream(titleModelConfig, {
        messages: [{ id: createId("msg"), role: "user", content: prompt, createdAt: nowIso() }],
        observations: [],
        tools: [],
        systemPrompt,
        // One-shot throwaway prefix — never cache-write it (1.25x surcharge).
        promptCache: "none",
      });
      // Count the spend even when the title is discarded below.
      rollupSideUsage(this.host.session, turn.usage);
      const next = cleanTitle(turn.content ?? "");
      if (!next) {
        // Title model responded but the cleaned result was empty — useful to
        // surface because it usually means the model is misbehaving (e.g.
        // wrapping the answer in code fences, or refusing the system prompt).
        this.host.reportBackgroundError("autotitle", "Title model returned empty content after cleanup.", {
          provider: titleModelConfig.provider,
          model: titleModelConfig.model,
          raw: (turn.content ?? "").slice(0, 200),
        });
        return null;
      }
      // The model call could take seconds. If the user renamed the session
      // (or some other path mutated the title) during the await, do NOT
      // overwrite their value — auto-title only fills in defaults or the exact
      // optimistic title supplied by the caller.
      if (!isReplaceableTitle(this.host.session.title, expectedProvisionalTitle)) return null;
      this.host.session.title = next;
      this.host.touch();
      this.host.record({ type: "config", changes: { title: next } });
      pushTrace(this.host.session, "session.autotitled", { title: next });
      this.host.flushToStore();
      return next;
    } catch (error) {
      this.host.reportBackgroundError("autotitle", error, {
        provider: titleModelConfig.provider,
        model: titleModelConfig.model,
      });
      return null;
    } finally {
      this.autoTitleInFlight = false;
    }
  }

  ensureTitleFromFirstUserMessage(pendingUserText?: string): string | null {
    if (!isDefaultTitle(this.host.session.title)) return null;
    const firstUser = this.host.session.messages.find((m) => m.role === "user");
    const userText = firstUser ? chatMessageText(firstUser) : pendingUserText;
    if (!userText) return null;
    const next = titleFromFirstUserMessage(userText);
    if (!next) return null;
    this.host.session.title = next;
    this.host.touch();
    this.host.record({ type: "config", changes: { title: next } });
    pushTrace(this.host.session, "session.config.updated", { title: next, source: "first_user_message" });
    this.host.flushToStore();
    return next;
  }
}

export const DEFAULT_SESSION_TITLE = "Reina";

function truncateForTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

// Legacy adjective + noun pools. Older sessions used these as placeholders;
// keep recognizing them as default titles so auto-title can still replace
// them after load.
const RANDOM_TITLE_ADJECTIVES = [
  "Amber", "Azure", "Brisk", "Calm", "Clever", "Crimson", "Curious", "Dappled",
  "Dusky", "Eager", "Emerald", "Frosty", "Gentle", "Glowing", "Golden", "Hidden",
  "Humble", "Indigo", "Jolly", "Lively", "Lucky", "Mellow", "Misty", "Nimble",
  "Olive", "Peaceful", "Quiet", "Rosy", "Ruby", "Silent", "Silver", "Sleepy",
  "Sunny", "Swift", "Tidy", "Velvet", "Warm", "Whimsical", "Wild", "Witty",
] as const;

const RANDOM_TITLE_NOUNS = [
  "Acorn", "Badger", "Beacon", "Bramble", "Breeze", "Cinder", "Cloud", "Comet",
  "Compass", "Cove", "Dawn", "Dune", "Ember", "Falcon", "Fern", "Glade",
  "Grove", "Harbor", "Heron", "Lantern", "Maple", "Meadow", "Mountain", "Otter",
  "Pebble", "Petal", "Quill", "Raven", "Reef", "River", "Sparrow", "Spruce",
  "Star", "Stone", "Thicket", "Thistle", "Tide", "Twig", "Willow", "Wren",
] as const;

const RANDOM_TITLE_ADJ_SET: ReadonlySet<string> = new Set(RANDOM_TITLE_ADJECTIVES);
const RANDOM_TITLE_NOUN_SET: ReadonlySet<string> = new Set(RANDOM_TITLE_NOUNS);

function randomSessionTitle(): string {
  const adj = RANDOM_TITLE_ADJECTIVES[Math.floor(Math.random() * RANDOM_TITLE_ADJECTIVES.length)];
  const noun = RANDOM_TITLE_NOUNS[Math.floor(Math.random() * RANDOM_TITLE_NOUNS.length)];
  return `${adj} ${noun}`;
}

function isRandomSessionTitle(title: string): boolean {
  const parts = title.split(" ");
  if (parts.length !== 2) return false;
  return RANDOM_TITLE_ADJ_SET.has(parts[0]) && RANDOM_TITLE_NOUN_SET.has(parts[1]);
}

function isDefaultTitle(title: string | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (trimmed === "" || trimmed === "Reina") return true;
  // Random placeholders count as default so auto-title can swap them out
  // once a real exchange has happened.
  return isRandomSessionTitle(trimmed);
}

function isReplaceableTitle(title: string | undefined, expectedProvisionalTitle?: string): boolean {
  return isDefaultTitle(title) || (expectedProvisionalTitle !== undefined && title === expectedProvisionalTitle);
}

function chatMessageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return "";
}

function titleFromFirstUserMessage(text: string): string {
  const firstNonEmpty = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const cleaned = firstNonEmpty.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 77).trimEnd()}...`;
}

function cleanTitle(raw: string): string {
  let cleaned = raw.trim();
  if (!cleaned) return "";
  cleaned = cleaned.replace(/^["'`「『《](.*)["'`」』》]$/u, "$1").trim();
  cleaned = cleaned.replace(/^Title[:：]\s*/i, "").trim();
  cleaned = cleaned.split(/\r?\n/, 1)[0]?.trim() ?? cleaned;
  cleaned = cleaned.replace(/[。．.!?！？]+$/u, "").trim();
  if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 80).trimEnd()}…`;
  return cleaned;
}
