import type { ReinaConfig, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { MEMORY_DREAM_LIMITS, nowIso } from "@reina/protocol";
import { isCompactionOffloadEnabled } from "../chunks.js";
import type { SessionStore } from "../store/session-store.js";

/** Minimal host surface the MemoryController needs. The two recall tools
 * read from the offloaded memory-chunk store keyed by session.id. The store
 * is nullable because unit-tested engines and the renderer-only path don't
 * wire a SessionStore — the controller returns a structured error in that
 * case rather than crashing. `memoryConfig` is the user-facing settings
 * block (reina.json `memory`); REINA_MEMORY_* env vars override it. */
export interface MemoryHost {
  readonly session: SessionState;
  readonly sessionStore: SessionStore | null;
  readonly memoryConfig?: ReinaConfig["memory"];
}

/** Owns the deferred recall tools (recall_memory_chunk / list_memory_chunks)
 * that surface compacted-out chat slices from SQLite. Both tools are pure
 * reads — the WRITE side (persistMemoryChunks, called from compaction) stays
 * in the engine because it's tied to the compaction lifecycle, not the
 * tool-call dispatch. */
export class MemoryController {
  constructor(private readonly host: MemoryHost) {}

  recall(record: ToolCallRecord): ToolObservation {
    if (!isCompactionOffloadEnabled()) {
      return { callId: record.id, name: record.name, error: "Memory-chunk offload is disabled (set REINA_COMPACTION_OFFLOAD=1)." };
    }
    if (!this.host.sessionStore) {
      return { callId: record.id, name: record.name, error: "Memory chunks require a SessionStore; this engine instance has none." };
    }
    const input = record.input as { id?: string };
    const id = input?.id?.trim();
    if (!id) {
      return { callId: record.id, name: record.name, error: "recall_memory_chunk requires an `id` (e.g. `c_007`)." };
    }
    const chunk = this.host.sessionStore.readMemoryChunk(this.host.session.id, id);
    if (!chunk) {
      return { callId: record.id, name: record.name, error: `No memory chunk with id ${id} for this session.` };
    }
    return {
      callId: record.id,
      name: record.name,
      output: [
        `<memory_chunk id="${chunk.id}" createdAt="${chunk.createdAt}" tokens="${chunk.tokenCount}">`,
        chunk.content,
        `</memory_chunk>`,
      ].join("\n"),
    };
  }

  list(record: ToolCallRecord): ToolObservation {
    if (!isCompactionOffloadEnabled()) {
      return { callId: record.id, name: record.name, error: "Memory-chunk offload is disabled (set REINA_COMPACTION_OFFLOAD=1)." };
    }
    if (!this.host.sessionStore) {
      return { callId: record.id, name: record.name, error: "Memory chunks require a SessionStore; this engine instance has none." };
    }
    const chunks = this.host.sessionStore.listMemoryChunks(this.host.session.id);
    if (chunks.length === 0) {
      return { callId: record.id, name: record.name, output: "No memory chunks for this session yet." };
    }
    const lines = chunks.map((c) => {
      const tools = c.toolNames.length > 0 ? ` [${c.toolNames.join(", ")}]` : "";
      return `${c.id} (${c.createdAt}, ~${c.tokenCount}t): ${c.topicLine}${tools}`;
    });
    return {
      callId: record.id,
      name: record.name,
      output: [`Memory chunks (${chunks.length}, oldest→newest):`, ...lines].join("\n"),
    };
  }

  /** Keyword retrieval across this workspace's long-term memory surfaces:
   * message history of EVERY session (FTS5, BM25-ordered by the store),
   * offloaded compaction chunks (substring scan), and the notes indexes
   * already on the session. Read-only; each hit carries the pointer needed
   * to pull the full content (session/message, recall_memory_chunk id, or
   * read_note id). Grok-style "memory search" adapted to Reina's existing
   * stores — no new index, no embeddings. */
  search(record: ToolCallRecord): ToolObservation {
    const input = record.input as { query?: string; maxResults?: number };
    const query = input?.query?.trim();
    if (!query) {
      return { callId: record.id, name: record.name, error: "search_memory requires a non-empty `query`." };
    }
    const cap = Math.min(Math.max(1, Math.floor(input?.maxResults ?? 12)), 30);
    const sections: string[] = [];
    const store = this.host.sessionStore;
    let crossSessionHit = false;

    if (store) {
      // FTS MATCH grammar chokes on unbalanced quotes/operators in free
      // text; retry the failed query as one quoted phrase before giving up.
      let messageHits: ReturnType<SessionStore["searchMessages"]> = [];
      try {
        messageHits = store.searchMessages(query, cap);
      } catch {
        try {
          messageHits = store.searchMessages(`"${query.replace(/"/g, " ")}"`, cap);
        } catch {
          messageHits = [];
        }
      }
      if (messageHits.length > 0) {
        const titles = store.getSessionTitles(messageHits.map((h) => h.sessionId));
        const lines = messageHits.map((h) => {
          const here = h.sessionId === this.host.session.id ? " (this session)" : "";
          const title = titles.get(h.sessionId) ?? h.sessionId;
          return `- [${h.createdAt}] "${title}"${here} ${h.role}: ${h.snippet}`;
        });
        sections.push([`Conversation history (${messageHits.length} hits, newest first):`, ...lines].join("\n"));
      }

      // Chunk pointers are only useful when recall_memory_chunk will honour
      // them — with offload disabled, recall() hard-errors, so surfacing
      // chunk hits would hand the model dead pointers.
      const chunkHits = isCompactionOffloadEnabled() ? store.searchMemoryChunks(query, cap) : [];
      if (chunkHits.length > 0) {
        const lines = chunkHits.map((h) => {
          const here = h.sessionId === this.host.session.id ? ", this session" : "";
          return `- ${h.chunkId} (~${h.tokenCount}t${here}): ${h.topicLine}\n  ${h.snippet}`;
        });
        sections.push([
          `Offloaded chunks (${chunkHits.length} hits; recall THIS session's with recall_memory_chunk(id)):`,
          ...lines,
        ].join("\n"));
      }

      // Signal precondition: only hits from PAST top-level live sessions
      // count — subagent/worker transcripts and archived sessions are working
      // scratch, not "you needed this twice" evidence (same exclusion the
      // dream gate and the material builder apply).
      const pastIds = [...messageHits, ...chunkHits]
        .map((h) => h.sessionId)
        .filter((id) => id !== this.host.session.id);
      crossSessionHit = pastIds.length > 0 && store.hasDurableSessions(pastIds);
    }

    const needle = query.toLowerCase();
    const noteHits = [
      ...(this.host.session.notes ?? []).map((n) => ({ ...n, scope: "workspace" as const })),
      ...(this.host.session.globalNotes ?? []).map((n) => ({ ...n, scope: "global" as const })),
    ].filter((n) => `${n.title} ${n.tags.join(" ")}`.toLowerCase().includes(needle)).slice(0, cap);
    if (noteHits.length > 0) {
      const lines = noteHits.map((n) => `- ${n.id} [${n.scope}] ${n.title}${n.tags.length ? ` (${n.tags.join(", ")})` : ""} — read_note("${n.id}")`);
      sections.push([`Notes (${noteHits.length} index hits):`, ...lines].join("\n"));
    }

    if (sections.length === 0) {
      return {
        callId: record.id,
        name: record.name,
        output: `No memory hits for "${query}". Try fewer/different keywords; note titles+tags, all sessions' messages, and offloaded chunks were searched.`,
      };
    }
    // Retrieval-as-signal: a hit coming back from a PAST session means this
    // knowledge was needed a second time — the strongest evidence it's
    // durable. Nudge the model to promote it instead of re-deriving it again
    // next session. Notes hits don't count (already promoted).
    if (crossSessionHit) {
      sections.push(
        'Some hits above come from past sessions — knowledge you had to look up again. If a fact here will matter beyond this session, fold it into the global notebook now (note/update_note with scope:"global").',
      );
    }
    return { callId: record.id, name: record.name, output: sections.join("\n\n") };
  }

  /** Dream-style consolidation, agent-native: instead of a scheduled LLM
   * job (grok's `dream`), this tool hands the CALLING model the raw
   * material — briefs of sessions updated since the last consolidation —
   * and instructs it to fold the durable facts into the global notebook
   * itself. The EXPLICIT path deliberately skips the idle filter: the user
   * (or the model on the user's behalf) asked to fold NOW, so freshly
   * finished sessions are exactly the point — only the background dream
   * waits for sessions to settle. Stamps both clocks up front; if the model
   * flakes on the write, that batch is not re-offered (the raw sessions
   * stay reachable via search_memory). */
  consolidate(record: ToolCallRecord): ToolObservation {
    const store = this.host.sessionStore;
    if (!store) {
      return { callId: record.id, name: record.name, error: "Memory consolidation requires a SessionStore; this engine instance has none." };
    }
    const directive = this.buildConsolidationDirective(undefined);
    if (!directive) {
      return { callId: record.id, name: record.name, output: "No sessions have accumulated since the last consolidation — nothing to fold in." };
    }
    // Manual folds consume everything up to now, so both the cooldown clock
    // and the material cursor land on the same instant.
    const at = nowIso();
    store.setWorkspaceMeta(CONSOLIDATED_AT_KEY, at);
    store.setWorkspaceMeta(CONSOLIDATION_CURSOR_KEY, at);
    return { callId: record.id, name: record.name, output: directive };
  }

  /** Shared material builder for both consolidation paths (the manual
   * consolidate_memory tool and the engine's background dream run): briefs of
   * sessions updated since the material cursor, wrapped with the fold
   * instructions. `untilIso` is the idle upper bound — the background run
   * passes its cutoff, the manual tool passes undefined (no idle gate).
   * Returns null when nothing accumulated. Does NOT stamp — callers own that. */
  private buildConsolidationDirective(untilIso: string | undefined): string | null {
    const store = this.host.sessionStore;
    if (!store) return null;
    const since = consolidationSince(store);
    const briefs = store
      .listRecentSessionBriefs(since, 15, untilIso)
      .filter((b) => b.id !== this.host.session.id);
    if (briefs.length === 0) return null;
    const lines = briefs.map((b) => {
      const summary = b.summary ? `\n  ${truncateFlat(b.summary, 600)}` : "";
      return `- [${b.updatedAt}] "${b.title}" (${b.agent}, ${b.messageCount} msgs)${summary}`;
    });
    return [
      `<consolidation_material sessions="${briefs.length}"${since ? ` since="${since}"` : ""}>`,
      ...lines,
      `</consolidation_material>`,
      "",
      "Fold the DURABLE facts above into the global notebook now:",
      "- merge related facts into one note; prefer update_note on an existing global note over creating near-duplicates (the notes index is in your context)",
      "- resolve contradictions in favour of the newest session; convert relative dates to absolute",
      "- discard one-off noise (transient errors, abandoned experiments) — only decisions, preferences, and project facts worth recalling in a future session qualify",
      "- while you're in the notebook, prune it: delete_note global notes the sessions above have overturned or superseded — the notebook earns its keep by staying small and current",
      '- write via note(scope:"global") / update_note; if nothing above is durable, say so and stop.',
    ].join("\n");
  }

  /** Gate for the engine's background consolidation run (grok's dream gates,
   * cheapest first): enabled, cooldown since the last run, and enough
   * sessions accumulated past the material cursor. Pure check — no side
   * effects; the engine calls beginConsolidation() to commit. */
  consolidationDue(): boolean {
    const cfg = this.host.memoryConfig;
    if (!dreamEnabled(cfg)) return false;
    const store = this.host.sessionStore;
    if (!store) return false;
    const lastRun = store.getWorkspaceMeta(CONSOLIDATED_AT_KEY);
    if (lastRun && Date.now() - Date.parse(lastRun) < consolidationCooldownMs(cfg)) return false;
    // Same idle bound as the material builder — a session still being worked
    // on doesn't count toward the gate, so we never open on half-done work.
    return store.countSessionsUpdatedSince(consolidationSince(store), idleCutoffIso(cfg)) >= consolidationMinSessions(cfg);
  }

  /** Commit a background consolidation: build the directive from sessions
   * settled before the idle cutoff, then stamp BOTH clocks — the cooldown
   * clock at `now` (grok's stamp-is-the-lock: the stamp is what prevents a
   * concurrent second run) and the material CURSOR at the idle cutoff, i.e.
   * the high-water mark of what this run actually consumed. Sessions still
   * inside the idle window stay ahead of the cursor and are picked up by a
   * later run once they settle — stamping `now` here would strand them
   * behind the cursor forever. No rollback on failure: a flaked run's batch
   * is NOT re-offered (the cursor has already moved); the raw sessions stay
   * reachable via search_memory, the notebook just misses that fold.
   * Returns null when nothing accumulated. */
  beginConsolidation(): string | null {
    const store = this.host.sessionStore;
    if (!store) return null;
    const cutoff = idleCutoffIso(this.host.memoryConfig);
    const directive = this.buildConsolidationDirective(cutoff);
    if (!directive) return null;
    store.setWorkspaceMeta(CONSOLIDATED_AT_KEY, nowIso());
    store.setWorkspaceMeta(CONSOLIDATION_CURSOR_KEY, cutoff);
    return directive;
  }

}

/** workspace_meta key holding the ISO timestamp of the last consolidation
 * RUN — drives the cooldown gate only. */
const CONSOLIDATED_AT_KEY = "memory_consolidated_at";
/** workspace_meta key holding the material high-water mark: sessions with
 * `updated_at > cursor` are still unconsumed. Split from the run clock so a
 * background run (whose material stops at the idle cutoff) doesn't strand
 * the sessions that settled during the idle window. Falls back to the run
 * clock for workspaces stamped before the split. */
const CONSOLIDATION_CURSOR_KEY = "memory_consolidation_cursor";

/** Lower bound for material + gate counting: the cursor when present, else
 * the pre-split run clock (old workspaces), else undefined (fold everything). */
function consolidationSince(store: SessionStore): string | undefined {
  return store.getWorkspaceMeta(CONSOLIDATION_CURSOR_KEY) ?? store.getWorkspaceMeta(CONSOLIDATED_AT_KEY);
}

/** Positive-int knob resolution, cheapest override first: REINA_MEMORY_* env
 * (developer escape hatch) > reina.json `memory` block (the settings-page
 * knob) > built-in default. Every accepted value is clamped into the limit's
 * [min, max] — the settings page advertises these ranges, so hand-edited
 * configs and env overrides obey them too. */
function intKnob(
  envName: string,
  configValue: number | undefined,
  limit: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const clamp = (v: number) => Math.min(limit.max, Math.max(limit.min, Math.floor(v)));
  const raw = process.env[envName];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return clamp(parsed);
  }
  if (typeof configValue === "number" && Number.isFinite(configValue) && configValue > 0) {
    return clamp(configValue);
  }
  return limit.fallback;
}

type MemoryDreamConfig = ReinaConfig["memory"];

/** Master switch, same env-beats-config shape as intKnob: a blank env var
 * counts as unset (falls through to config, matching intKnob's `if (raw)`),
 * a set one wins in BOTH directions — "0"/"false"/"off"/"no" disable,
 * anything else enables. Config `dream: false` is honoured only when the
 * env is unset, so an exported-but-empty REINA_MEMORY_DREAM can't silently
 * override the settings page. */
function dreamEnabled(cfg: MemoryDreamConfig): boolean {
  const raw = process.env.REINA_MEMORY_DREAM?.trim().toLowerCase();
  if (raw) return !["0", "false", "off", "no"].includes(raw);
  return cfg?.dream !== false;
}

/** Gate: at least this many sessions updated since the last consolidation…
 * grok's dream defaults were 5 / 24h, but dream runs as a BACKGROUND job —
 * Reina's consolidation rides the user's own turn, so the defaults are more
 * conservative (10 sessions / 72h). Tune via settings page or env. */
function consolidationMinSessions(cfg: MemoryDreamConfig): number {
  return intKnob("REINA_MEMORY_MIN_SESSIONS", cfg?.minSessions, MEMORY_DREAM_LIMITS.minSessions);
}
/** …and at least this long since it ran. */
function consolidationCooldownMs(cfg: MemoryDreamConfig): number {
  return intKnob("REINA_MEMORY_COOLDOWN_HOURS", cfg?.cooldownHours, MEMORY_DREAM_LIMITS.cooldownHours) * 60 * 60 * 1000;
}
/** codex-style idle filter: only sessions untouched for this long are settled
 * enough to fold — never summarize work that's still in flight. Applies to
 * the BACKGROUND gate and material (they must agree or the gate could open
 * on sessions the directive then filters out); the manual consolidate_memory
 * tool deliberately skips it. Default 6h, like codex's
 * min_rollout_idle_hours. */
function idleCutoffIso(cfg: MemoryDreamConfig): string {
  return new Date(Date.now() - intKnob("REINA_MEMORY_IDLE_HOURS", cfg?.idleHours, MEMORY_DREAM_LIMITS.idleHours) * 60 * 60 * 1000).toISOString();
}

function truncateFlat(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}
