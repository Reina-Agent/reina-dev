// Conversation tab body — React port of the legacy inter-agent conversation
// feed (apps/desktop/src/renderer/actions/conversation.js). Reproduces the
// legacy FUNCTIONALITY (a chronological, chat-style feed of inter-agent
// activity, per-agent colour hues, agent filter chips, an event count, and
// lazy-expanded directed-message bodies) in the React/Tailwind workspace style
// (matching NotesTab / GitChanges / FileViewer).
//
// ── Data sourcing (fixed) ─────────────────────────────────────────────────────
// The legacy view holds no data of its own: it re-projects three LIVE renderer
// state buckets:
//   • notes      — directed messages (send_to_worker → notes w/ recipient)
//   • subtasks   — subtask lifecycle transitions
// Both now flow through workspaceEngineStore, which subscribes once to the
// broadcast "agent" channel and applies the nested model_stream sub-events
// (notes-updated, subtask-updated/phase-changed) plus
// session_snapshot hydration. This tab reads those slices and ports the
// legacy buildTimeline merge faithfully. Directed-message bodies still live on
// disk, lazy-fetched via readNote on click; the note META list is seeded from a
// listNotes(cwd) cold-load on activation, then kept live via the store.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import {
  useWorkspaceEngine,
  seedWorkspaceNotes,
  type NoteMeta,
} from "./workspaceEngineStore";

// One row in the merged feed. Mirrors legacy buildTimeline entries.
interface ConvEntry {
  ts?: string;
  kind: "message" | "broadcast" | "subtask";
  from: string;
  to?: string;
  title: string;
  noteId?: string;
  body?: string;
  status?: string;
}

// ── Legacy pseudo-recipients (mirror packages/core mailbox.ts) ──────────────

const BROADCAST_RECIPIENT = "team-broadcast";
const COORDINATOR_RECIPIENT = "team-lead";

const KIND_LABEL: Record<string, string> = {
  message: "message",
  broadcast: "broadcast",
  subtask: "subtask",
};

// ── Legacy helpers (verbatim behaviour) ─────────────────────────────────────

/** Friendly display name for an agent handle. The top-level session writes
 * notes as "parent"; team aliases get human labels. */
function displayAgent(name?: string): string {
  if (!name) return "—";
  if (name === "parent") return "coordinator";
  if (name === COORDINATOR_RECIPIENT) return "coordinator";
  if (name === BROADCAST_RECIPIENT) return "everyone";
  return name;
}

/** Stable hue per agent so each speaker keeps one colour across the feed. */
function agentHue(name?: string): number {
  const key = displayAgent(name);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConversationTab({ cwd, active }: { cwd: string | null; active: boolean }) {
  // Three live channels from the shared engine store (fed by the broadcast
  // "agent" stream + session snapshots — see workspaceEngineStore).
  const notes = useWorkspaceEngine((s) => s.notes);
  const subtasks = useWorkspaceEngine((s) => s.subtasks);
  const sessionId = useWorkspaceEngine((s) => s.sessionId);
  const [loading, setLoading] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  // Lazy-expanded directed-message bodies, mirroring legacy
  // state.notesBodyCache + state.conversationExpanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const bodyCache = useRef<Map<string, string>>(new Map());
  // Bump to re-render when an async body load mutates the cache.
  const [, setBodyTick] = useState(0);

  // Track which cwd the current notes belong to, to guard async races on
  // workspace switch (same approach as WorkspaceApp.loadNotes).
  const loadedCwd = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // ── Seed the note META list from disk (cold-load via listNotes) ───────────
  // The store keeps notes live via notes-updated; this just back-fills history
  // that landed before the workspace window was listening (legacy hydrate).
  const loadNotes = useCallback(async (workspaceCwd: string) => {
    setLoading(true);
    try {
      const result = (await bridge().listNotes(workspaceCwd)) as { notes?: NoteMeta[] } | null;
      if (loadedCwd.current !== workspaceCwd) return;
      seedWorkspaceNotes(result?.notes ?? []);
    } catch {
      if (loadedCwd.current !== workspaceCwd) return;
      seedWorkspaceNotes([]);
    } finally {
      if (loadedCwd.current === workspaceCwd) setLoading(false);
    }
  }, []);

  // ── Lazy-load on first activation / cwd change ────────────────────────────
  // Deferred to first activation so the notebook isn't fetched for workspaces
  // the user never opens the Conversation tab on (mirrors WorkspaceApp notes).
  useEffect(() => {
    if (!active || !cwd) return;
    if (loadedCwd.current === cwd) return;
    loadedCwd.current = cwd;
    bodyCache.current = new Map();
    setExpanded(new Set());
    setAgentFilter(null);
    void loadNotes(cwd);
  }, [active, cwd, loadNotes]);

  // ── Reset the agent filter on a bound-session change ──────────────────────
  // A same-workspace session switch keeps `cwd`, so the activation effect above
  // doesn't re-run; without this the filter stays pinned to an agent absent from
  // the new session, and with <2 agents the chip strip (incl. "All") hides,
  // stranding the user on "No activity for this agent" with no way to clear.
  useEffect(() => {
    setAgentFilter(null);
  }, [sessionId]);

  // ── Reset on workspace switch from another window ─────────────────────────
  useEffect(() => {
    const unsub = bridge().events.on("open-workspace", (payload) => {
      const newCwd = typeof payload === "string" ? payload : null;
      if (!newCwd) return;
      // Invalidate so the activation effect refetches for the new workspace.
      loadedCwd.current = null;
      bodyCache.current = new Map();
      setExpanded(new Set());
      setAgentFilter(null);
    });
    return unsub;
  }, []);

  // ── Build the merged timeline (legacy buildTimeline — all three channels) ──
  const timeline = useMemo<ConvEntry[]>(() => {
    const entries: ConvEntry[] = [];

    // 1. Directed messages (send_to_worker → notes with a recipient).
    for (const note of notes) {
      if (!note?.recipient) continue;
      const broadcast = note.recipient === BROADCAST_RECIPIENT;
      entries.push({
        ts: note.createdAt,
        kind: broadcast ? "broadcast" : "message",
        from: note.author,
        to: note.recipient,
        title: note.title || "(message)",
        noteId: note.id,
      });
    }

    // 2. Subtask lifecycle (one entry at the latest transition).
    for (const sub of subtasks.values()) {
      entries.push({
        ts: sub.updatedAt || sub.createdAt,
        kind: "subtask",
        from: sub.owner || "coordinator",
        status: sub.status,
        title: `${sub.id} · ${sub.title}`,
        body: sub.resultSummary || "",
      });
    }

    entries.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
    return entries;
  }, [notes, subtasks]);

  // ── Unique agents for the filter strip (legacy uniqueAgents) ──────────────
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const e of timeline) {
      set.add(displayAgent(e.from));
      if (e.to && e.to !== BROADCAST_RECIPIENT) set.add(displayAgent(e.to));
    }
    set.delete("—");
    return [...set].sort();
  }, [timeline]);

  // ── Apply agent filter (legacy applyFilter) ───────────────────────────────
  const visible = useMemo(() => {
    if (!agentFilter) return timeline;
    return timeline.filter(
      (e) => displayAgent(e.from) === agentFilter || displayAgent(e.to) === agentFilter,
    );
  }, [timeline, agentFilter]);

  // ── Chat-style scroll pinning (legacy render: stay pinned near bottom) ─────
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // ── Lazy-expand a directed message body (legacy expandMessage) ────────────
  const expandMessage = useCallback(
    async (noteId: string) => {
      setExpanded((prev) => {
        if (prev.has(noteId)) return prev;
        const next = new Set(prev);
        next.add(noteId);
        return next;
      });
      if (bodyCache.current.has(noteId)) {
        setBodyTick((t) => t + 1);
        return;
      }
      const workspaceCwd = loadedCwd.current;
      try {
        const result = (await bridge().readNote(workspaceCwd ?? undefined, noteId)) as
          | { body?: string }
          | null;
        bodyCache.current.set(noteId, result?.body ?? "");
      } catch {
        bodyCache.current.set(noteId, "(could not load message body)");
      }
      setBodyTick((t) => t + 1);
    },
    [],
  );

  const refresh = useCallback(() => {
    if (cwd) void loadNotes(cwd);
  }, [cwd, loadNotes]);

  const hasAny = timeline.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ── sub-toolbar: title + event count + refresh ── */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
          Conversation{" "}
          {loading && notes.length === 0 ? (
            <span className="text-muted-foreground">…</span>
          ) : (
            <span className="text-muted-foreground">
              {hasAny ? `${timeline.length} event${timeline.length === 1 ? "" : "s"}` : "0"}
            </span>
          )}
        </span>
        <button
          type="button"
          title="Refresh conversation"
          aria-label="Refresh conversation"
          onClick={refresh}
          disabled={!cwd}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* ── agent filter chips (legacy renderFilters; only when ≥2 agents) ── */}
      {agents.length >= 2 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-(--surface-divider) bg-card px-2 py-1.5">
          <FilterChip
            label="All"
            active={!agentFilter}
            onClick={() => setAgentFilter(null)}
          />
          {agents.map((agent) => (
            <FilterChip
              key={agent}
              label={agent}
              hue={agentHue(agent)}
              active={agentFilter === agent}
              onClick={() => setAgentFilter((cur) => (cur === agent ? null : agent))}
            />
          ))}
        </div>
      )}

      {/* ── feed ── */}
      {!hasAny ? (
        <ConversationEmpty loading={loading} />
      ) : (
        <div
          ref={threadRef}
          onScroll={onThreadScroll}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3"
        >
          {visible.length === 0 ? (
            <div className="px-1 py-2 text-xs italic text-muted-foreground">
              No activity for this agent.
            </div>
          ) : (
            visible.map((entry, i) => (
              <ConversationEntry
                key={entry.noteId ?? `${entry.kind}-${entry.ts ?? ""}-${i}`}
                entry={entry}
                expanded={entry.noteId ? expanded.has(entry.noteId) : false}
                body={entry.noteId ? bodyCache.current.get(entry.noteId) : undefined}
                onExpand={() => {
                  if (entry.noteId) void expandMessage(entry.noteId);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Filter chip (per-agent hue, mirrors legacy .conv-filter) ─────────────────

function FilterChip({
  label,
  hue,
  active,
  onClick,
}: {
  label: string;
  hue?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={hue !== undefined ? { color: active ? undefined : `hsl(${hue} 55% 60%)` } : undefined}
      className={
        "flex items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors duration-(--motion-fast) h-[20px] " +
        (active
          ? "bg-secondary text-foreground"
          : "hover:bg-secondary/60 hover:text-foreground")
      }
    >
      {hue !== undefined && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: `hsl(${hue} 60% 55%)` }}
        />
      )}
      {label}
    </button>
  );
}

// ── One feed entry (legacy renderEntry) ──────────────────────────────────────

function ConversationEntry({
  entry,
  expanded,
  body,
  onExpand,
}: {
  entry: ConvEntry;
  expanded: boolean;
  body: string | undefined;
  onExpand: () => void;
}) {
  const fromHue = agentHue(entry.from);
  const toHue = entry.to ? agentHue(entry.to) : 0;
  const kindLabel =
    entry.kind === "subtask" && entry.status
      ? `subtask · ${entry.status}`
      : KIND_LABEL[entry.kind] ?? entry.kind;
  // Inline body (subtask results) renders
  // immediately. Directed messages keep their body on disk — show the title and
  // lazy-fetch on click (legacy renderEntry).
  const inlineBody = entry.body;
  const showLazyBody = expanded && body !== undefined;

  return (
    <div className="rounded-md border border-(--surface-divider) bg-card/70 px-3 py-2">
      {/* head: from → to · kind · time */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="font-medium" style={{ color: `hsl(${fromHue} 60% 62%)` }}>
          {displayAgent(entry.from)}
        </span>
        {entry.to && (
          <>
            <span className="text-muted-foreground/60">→</span>
            <span className="font-medium" style={{ color: `hsl(${toHue} 60% 62%)` }}>
              {displayAgent(entry.to)}
            </span>
          </>
        )}
        <span className="rounded-full bg-secondary/70 px-1.5 py-px text-[10px] text-muted-foreground">
          {kindLabel}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {formatTime(entry.ts)}
        </span>
      </div>

      {/* title */}
      <div className="mt-1 text-[12.5px] text-foreground">{entry.title}</div>

      {/* body */}
      {inlineBody ? (
        <div className="mt-1.5 whitespace-pre-wrap rounded-md bg-secondary/30 px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
          {inlineBody}
        </div>
      ) : entry.noteId ? (
        showLazyBody ? (
          <div className="mt-1.5 whitespace-pre-wrap rounded-md bg-secondary/30 px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
            {body || "(empty message)"}
          </div>
        ) : (
          <button
            type="button"
            onClick={onExpand}
            className="mt-1 text-[11px] text-primary transition-colors duration-(--motion-fast) hover:underline"
          >
            show message
          </button>
        )
      ) : null}
    </div>
  );
}

// ── Empty state (mirrors legacy conversationEmpty) ───────────────────────────

function ConversationEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <ConversationIcon />
      <div>
        <p className="font-medium text-foreground/70">
          {loading ? "Loading conversation…" : "No inter-agent activity yet."}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs">
          When agents message each other (send_to_worker) or broadcast to the team,
          their exchanges appear here as a chronological feed. Open a message to read
          its full body.
        </p>
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted-foreground/40">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}
