// Notes tab body — React port of the legacy shared-notebook panel
// (apps/desktop/src/renderer/actions/notes.js). Reproduces the legacy
// FUNCTIONALITY (status-grouped collapsible sidebar, status filter, summary
// chips, note selection + body lazy-load with cache, detail header with
// tags/refs, one-hop ref navigation, markdown body) in the React/Tailwind
// workspace style (matching FileTree / GitChanges / FileViewer).
//
// Data comes from the preload bridge:
//   listNotes(cwd)        -> { notes: NoteMeta[] }
//   readNote(cwd, noteId) -> { meta: NoteMeta, body: string } | null
//
// Live `notes-updated` stream events are NOT forwarded to the workspace
// window (only the main chat window consumes the engine stream), so — like
// the Git and Files tabs — this tab cold-loads via listNotes and refreshes
// explicitly (WorkspaceApp reloads on cwd change / tab activation / Refresh).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResizeHandle } from "~/components/ResizeHandle";
import type { ResizableSidebar } from "~/lib/useResizableSidebar";
import { NotesGraph } from "./NotesGraph";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

// ── Types (mirror listNotes / readNote shapes from main/ipc.ts) ─────────────

export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  refs: string[];
  status: string;
  author: string;
  recipient?: string;
  createdAt: string;
}

interface NotesTabProps {
  notes: NoteMeta[];
  loading: boolean;
  // readNote bound to the active cwd by the parent — returns the body string.
  readNote: (noteId: string) => Promise<string>;
  // Resizable-sidebar controller owned by WorkspaceApp; the collapse toggle
  // lives in the notes sub-toolbar (unified with Git/Files), so it is shared
  // rather than duplicated here.
  sidebar: ResizableSidebar;
  // Which notebook is shown: this project's audit dossier (`workspace`) or the
  // cross-project self-evolve memory (`global`). Owned by WorkspaceApp (it
  // drives which notebook is loaded); this tab renders the toggle.
  scope: "workspace" | "global";
  onScopeChange: (scope: "workspace" | "global") => void;
}

// ── Legacy status glyph / label tables ──────────────────────────────────────

const STATUS_GLYPH: Record<string, string> = {
  open: "○",
  confirmed: "✓",
  dead: "⊘",
  todo: "·",
};

const STATUS_LABEL: Record<string, string> = {
  open: "open",
  confirmed: "confirmed",
  dead: "dead",
  todo: "todo",
};

// Status tint for chips / glyphs / badges (Tailwind tokens).
function statusColor(status: string): string {
  switch (status) {
    case "confirmed":
      return "text-green-400";
    case "dead":
      return "text-red-400";
    case "todo":
      return "text-muted-foreground";
    default:
      return "text-yellow-400";
  }
}

// Sidebar grouping mirrors the model-facing index (legacy SIDEBAR_GROUPS).
const SIDEBAR_GROUPS: Array<[string, string]> = [
  ["confirmed", "Confirmed findings & chains"],
  ["hypothesis", "Hypotheses — verify or refute"],
  ["dead", "Dead ends"],
  ["open", "Open leads"],
  ["anchor", "Goals & handoffs"],
];

function noteGroupKey(note: NoteMeta): string {
  if (note.status === "confirmed") return "confirmed";
  if (note.status === "dead") return "dead";
  const tags = note.tags || [];
  if (tags.includes("kind:hypothesis")) return "hypothesis";
  if (tags.includes("kind:goal") || tags.includes("kind:handoff")) return "anchor";
  return "open";
}

// The GLOBAL notebook is durable cross-project memory, not an audit dossier, so
// it groups by `kind:*` rather than finding status. The kinds below are the
// GLOBAL_WIKI_SCHEMA_SEED vocabulary and get curated labels + a stable order —
// but schema.md is agent-evolvable, so novel kinds still get their own section
// (capitalized slug) instead of silently collapsing into "Other". Mirrors
// core's buildIndexMd, which groups by whatever kind:* actually appears.
const GLOBAL_KIND_GROUPS: Array<[string, string]> = [
  ["preference", "Preferences — how you work"],
  ["technique", "Techniques & recipes"],
  ["concept", "Concepts"],
  ["entity", "Tools & environment"],
  ["summary", "Distilled sources"],
];

function globalKindOf(note: NoteMeta): string | null {
  return (note.tags || []).find((t) => t.startsWith("kind:"))?.slice("kind:".length) || null;
}

function globalGroupKey(note: NoteMeta): string {
  return globalKindOf(note) ?? "other";
}

function globalGroupsFor(notes: NoteMeta[]): Array<[string, string]> {
  const known = new Set(GLOBAL_KIND_GROUPS.map(([key]) => key));
  const novel = [...new Set(
    notes.map(globalKindOf).filter((kind): kind is string => kind !== null && !known.has(kind)),
  )]
    .sort()
    .map((kind): [string, string] => [kind, kind.charAt(0).toUpperCase() + kind.slice(1)]);
  return [...GLOBAL_KIND_GROUPS, ...novel, ["other", "Other"]];
}

const STATUS_FILTERS: Array<[string, string]> = [
  ["all", "All"],
  ["open", "Open"],
  ["confirmed", "Confirmed"],
  ["dead", "Dead"],
  ["todo", "Todo"],
];

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── Icons ───────────────────────────────────────────────────────────────────

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className={className}>
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NotebookIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted-foreground/40">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function NotesTab({ notes, loading, readNote, sidebar, scope, onScopeChange }: NotesTabProps) {
  const isGlobal = scope === "global";
  const groups = useMemo<Array<[string, string]>>(
    () => (isGlobal ? globalGroupsFor(notes) : SIDEBAR_GROUPS),
    [isGlobal, notes],
  );
  const groupKeyOf = isGlobal ? globalGroupKey : noteGroupKey;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"detail" | "graph">("detail");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Transient export feedback. Sidebar collapse/width are owned by the
  // `sidebar` controller (toggle in the notes sub-toolbar).
  const [exportLabel, setExportLabel] = useState<string | null>(null);
  // Body cache + active body, mirroring legacy state.notesBodyCache.
  const bodyCache = useRef<Map<string, string>>(new Map());
  const [activeBody, setActiveBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const pendingNote = useRef<string | null>(null);

  const notesById = useMemo(
    () => new Map(notes.map((n) => [n.id, n])),
    [notes],
  );

  // Drop the body cache when the underlying notes list changes identity
  // (cwd switch / refresh) so stale bodies don't linger.
  useEffect(() => {
    bodyCache.current = new Map();
  }, [notes]);

  // Clear the selection if the selected note vanished or no longer matches
  // the active filter (mirrors legacy renderNotes / setStatusFilter guards).
  const selected = selectedId ? notesById.get(selectedId) ?? null : null;
  // In global scope the audit status filter has no UI (the chip row is
  // workspace-only), so it must not filter either — otherwise a filter picked
  // in workspace scope would invisibly blank the global list with no way to
  // clear it. The workspace selection is kept and re-applies on flip-back.
  const matchesFilter = useCallback(
    (note: NoteMeta | null | undefined) =>
      isGlobal || !statusFilter || note?.status === statusFilter,
    [statusFilter, isGlobal],
  );

  useEffect(() => {
    if (selectedId && (!notesById.has(selectedId) || !matchesFilter(notesById.get(selectedId)))) {
      setSelectedId(null);
      setActiveBody(null);
    }
  }, [selectedId, notesById, matchesFilter]);

  // A selected note belongs to ONE notebook — drop it the moment the scope
  // flips so the detail pane can't show (or fetch) an id from the other
  // notebook while the new list is still loading.
  useEffect(() => {
    setSelectedId(null);
    setActiveBody(null);
  }, [scope]);

  // ── Select a note (lazy-load body with cache + race guard) ────────────────
  const selectNote = useCallback(async (noteId: string) => {
    setSelectedId(noteId);
    pendingNote.current = noteId;
    const cached = bodyCache.current.get(noteId);
    if (cached !== undefined) {
      setActiveBody(cached);
      setBodyLoading(false);
      return;
    }
    setActiveBody(null);
    setBodyLoading(true);
    try {
      const body = await readNote(noteId);
      if (pendingNote.current !== noteId) return;
      bodyCache.current.set(noteId, body);
      setActiveBody(body);
    } catch {
      if (pendingNote.current !== noteId) return;
      bodyCache.current.set(noteId, "");
      setActiveBody("");
    } finally {
      if (pendingNote.current === noteId) setBodyLoading(false);
    }
  }, [readNote]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Export confirmed findings as a markdown report to the clipboard ────────
  // Port of legacy notes.js exportReport — a core security-research workflow.
  const exportReport = useCallback(async () => {
    const confirmed = notes.filter((n) => n.status === "confirmed");
    if (confirmed.length === 0) {
      setExportLabel("No confirmed findings");
      window.setTimeout(() => setExportLabel(null), 1600);
      return;
    }
    const sections = [
      "# Audit Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Confirmed findings: ${confirmed.length}`,
      "",
    ];
    for (const meta of confirmed) {
      let body = bodyCache.current.get(meta.id);
      if (body === undefined) {
        try {
          body = await readNote(meta.id);
          bodyCache.current.set(meta.id, body);
        } catch {
          body = "";
        }
      }
      const metaLine = [
        `**status:** ${meta.status}`,
        meta.tags?.length ? `**tags:** ${meta.tags.join(", ")}` : "",
        meta.refs?.length ? `**refs:** ${meta.refs.join(", ")}` : "",
        `**author:** ${meta.author}`,
        `**created:** ${meta.createdAt}`,
      ].filter(Boolean).join(" · ");
      sections.push(`## ${meta.id} · ${meta.title}`, "", metaLine, "", body ?? "", "", "---", "");
    }
    try {
      await navigator.clipboard.writeText(sections.join("\n"));
      setExportLabel(`Copied ${confirmed.length} findings`);
    } catch {
      setExportLabel("Copy failed");
    }
    window.setTimeout(() => setExportLabel(null), 1800);
  }, [notes, readNote]);

  // ── Summary chip counts (legacy updateSummaryChips) ───────────────────────
  const counts = useMemo(() => {
    const c: Record<string, number> = { open: 0, confirmed: 0, dead: 0, todo: 0 };
    for (const note of notes) c[note.status] = (c[note.status] ?? 0) + 1;
    return c;
  }, [notes]);

  // ── Filtered + grouped sidebar rows (legacy renderSidebar) ────────────────
  const filtered = !isGlobal && statusFilter ? notes.filter((n) => n.status === statusFilter) : notes;
  const sorted = useMemo(
    () => filtered.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [filtered],
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ── sidebar: toolbar + filter + summary chips + grouped tree ── */}
      {!sidebar.collapsed && (
      <>
      <div
        style={{ width: sidebar.width }}
        className="flex shrink-0 flex-col overflow-hidden border-r border-(--surface-divider) bg-card"
      >
        {/* scope toggle: this project's notebook vs cross-project memory */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--surface-divider) px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 overflow-hidden rounded-md border border-(--surface-divider) text-[11px]">
            {([["workspace", "Workspace"], ["global", "Global"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onScopeChange(value)}
                aria-pressed={scope === value}
                title={value === "global" ? "Cross-project memory the self-evolve loop writes to (<REINA_HOME>/notes)" : "This project's shared notebook (.reina/notes)"}
                className={
                  `shrink-0 whitespace-nowrap px-1.5 py-0.5 transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                  (scope === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")
                }
              >
                {label}
              </button>
            ))}
          </div>
          {/* Export confirmed findings — an audit-dossier action, workspace only. */}
          {!isGlobal && (
            <button
              type="button"
              onClick={() => void exportReport()}
              title={exportLabel ?? "Export confirmed findings to clipboard"}
              aria-live="polite"
              className={`ml-auto h-[20px] min-w-0 max-w-[88px] shrink overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary/60 hover:text-foreground ${FOCUS_RING}`}
            >
              {exportLabel ?? "Export"}
            </button>
          )}
        </div>
        {/* status filter (audit lifecycle — workspace only) */}
        {!isGlobal && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--surface-divider) px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STATUS_FILTERS.map(([value, label]) => {
            const active = (value === "all" && !statusFilter) || value === statusFilter;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value === "all" ? null : value)}
                aria-pressed={active}
                className={
                  `h-[20px] shrink-0 whitespace-nowrap rounded-md px-1.5 text-[11px] transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                  (active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                }
              >
                {label}
                <span className="ml-1 tabular-nums text-[10px] opacity-65">
                  {value === "all" ? notes.length : counts[value] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        )}

        {/* grouped note tree */}
        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {loading && notes.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-muted-foreground">Loading notes…</div>
          ) : sorted.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-muted-foreground">
              {notes.length === 0
                ? (isGlobal ? "Nothing learned yet." : "No notes yet.")
                : "No notes match this filter."}
            </div>
          ) : (
            groups.map(([key, heading]) => {
              const rows = sorted.filter((note) => groupKeyOf(note) === key);
              if (rows.length === 0) return null;
              const isCollapsed = collapsedGroups.has(key);
              return (
                <div key={key} className="mb-0.5">
                  {/* group header */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    aria-expanded={!isCollapsed}
                    className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80 transition-colors duration-(--motion-fast) hover:text-foreground ${FOCUS_RING}`}
                  >
                    <ChevronRight
                      className={"shrink-0 transition-transform duration-(--motion-fast) " + (isCollapsed ? "" : "rotate-90")}
                    />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{heading}</span>
                    <span className="shrink-0 rounded-full bg-secondary px-1 text-[10px] text-muted-foreground">{rows.length}</span>
                  </button>

                  {/* leaves */}
                  {!isCollapsed &&
                    rows.map((note) => {
                      const isActive = note.id === selectedId;
                      return (
                        <button
                          key={note.id}
                          type="button"
                          title={note.title || note.id}
                          onClick={() => void selectNote(note.id)}
                          aria-current={isActive ? "true" : undefined}
                          className={
                            `flex w-full items-center gap-1.5 rounded-md py-1 pl-6 pr-2 text-left text-[12.5px] transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                            (isActive
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                          }
                        >
                          <span className={"shrink-0 " + statusColor(note.status)}>
                            {STATUS_GLYPH[note.status] ?? "·"}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{note.id}</span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {truncate(note.title || "", 80)}
                          </span>
                        </button>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
      </div>
      <ResizeHandle onPointerDown={sidebar.startResize} active={sidebar.resizing} ariaLabel="Resize notes list" />
      </>
      )}

      {/* ── detail / graph pane ── */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {/* Keep the view switch in document flow so long note titles never run
            underneath it. */}
        {notes.length > 0 && (
          <div className="flex h-8 shrink-0 items-center justify-end border-b border-(--surface-divider) bg-card/55 px-2">
            <div
              className="flex overflow-hidden rounded-md border border-(--surface-divider) bg-card text-[11px]"
              role="group"
              aria-label="Notes view"
            >
              {(["detail", "graph"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={
                    `px-2 py-1 capitalize transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                    (view === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        {view === "graph" ? (
          <NotesGraph
            notes={notes}
            selectedId={selectedId}
            onSelect={(id) => {
              void selectNote(id);
              setView("detail");
            }}
          />
        ) : selected ? (
          <NoteDetail
            note={selected}
            body={bodyLoading ? null : activeBody ?? bodyCache.current.get(selected.id) ?? ""}
            loading={bodyLoading}
            onRefClick={(refId) => {
              if (notesById.has(refId)) void selectNote(refId);
            }}
          />
        ) : (
          <NotesEmpty
            total={notes.length}
            visible={statusFilter ? filtered.length : notes.length}
            statusFilter={statusFilter}
            isGlobal={isGlobal}
          />
        )}
      </div>
    </div>
  );
}

// ── Detail pane ──────────────────────────────────────────────────────────────

function NoteDetail({
  note,
  body,
  loading,
  onRefClick,
}: {
  note: NoteMeta;
  body: string | null;
  loading: boolean;
  onRefClick: (refId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* header */}
      <div className="shrink-0 border-b border-(--surface-divider) bg-card/80 px-4 py-3">
        <h2 className="break-words text-pretty text-[15px] font-semibold leading-snug text-foreground">
          {note.title || note.id}
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className={"font-medium " + statusColor(note.status)}>
            {STATUS_GLYPH[note.status] ?? "·"} {STATUS_LABEL[note.status] ?? note.status}
          </span>
          <span className="font-mono text-muted-foreground/70">{note.id}</span>
          {note.author && <span>by {note.author}</span>}
          {note.createdAt && <span>{formatTime(note.createdAt)}</span>}
        </div>

        {/* tags */}
        {note.tags && note.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {note.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-secondary/70 px-1.5 py-px text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* refs (one-hop navigation) */}
        {note.refs && note.refs.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>refs:</span>
            {note.refs.map((refId) => (
              <button
                key={refId}
                type="button"
                onClick={() => onRefClick(refId)}
                className={`rounded-md bg-secondary/60 px-1.5 py-px font-mono text-[10px] text-primary transition-colors duration-(--motion-fast) hover:bg-secondary ${FOCUS_RING}`}
              >
                {refId}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <WorkspaceMarkdown
            source={body ?? ""}
            className="mx-auto min-h-full max-w-[860px] px-8 py-7"
          />
        </div>
      )}
    </div>
  );
}

// ── Empty state (context-aware, mirrors legacy renderDetail(null)) ───────────

function NotesEmpty({
  total,
  visible,
  statusFilter,
  isGlobal,
}: {
  total: number;
  visible: number;
  statusFilter: string | null;
  isGlobal: boolean;
}) {
  let title: string;
  let hint: string;
  if (total === 0) {
    title = isGlobal ? "Nothing learned yet." : "No shared notes yet.";
    hint = isGlobal
      ? "As Reina works with you it records durable, cross-project learnings here — your preferences, reusable techniques, general facts. Enable the self-evolve loop in Settings to grow this automatically."
      : "Subagents write findings via note(...) as they investigate. They appear here — open one to see refs, tags, and the full markdown body.";
  } else if (visible === 0) {
    title = `No ${STATUS_LABEL[statusFilter ?? ""] ?? statusFilter} notes.`;
    hint = "Change the status filter to see other shared notes.";
  } else {
    title = `${visible} shared note${visible === 1 ? "" : "s"} — pick one to view.`;
    hint = "Click any entry on the left to see its body, tags, and refs.";
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <NotebookIcon />
      <div>
        <p className="font-medium text-foreground/70">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-xs">{hint}</p>
      </div>
    </div>
  );
}
