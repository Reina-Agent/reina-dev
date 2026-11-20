// SearchOverlay — full-text search over the current workspace's conversation
// history (the sidebar "Search" button). Debounced input → the agent-host's
// `search_workspace_messages` (SQLite FTS5 over every session's messages,
// snippets with <mark> highlights, newest first) → hits grouped by session;
// clicking a group/hit loads that session. The command palette stays on
// Ctrl+P/K — this overlay owns content search, the palette owns commands.
//
// Query handling mirrors MemoryController.search: FTS5's MATCH grammar throws
// on unbalanced quotes/operators in free text, so a failed query is retried
// once as a single quoted phrase before reporting no results.
//
// Wiring mirrors ProjectManager: a module-level imperative opener
// (`openSearchOverlay`) bound to the mounted component, reusing the pm-*
// overlay/panel/search CSS plus a few so-* additions (sidebar.css).

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";
import { getMainState, loadSession, useMainStore } from "./sessionStore";
import type { SessionListItem } from "./protocol";

interface SearchHit {
  sessionId: string;
  messageId: string;
  ordinal: number;
  role: string;
  snippet: string;
  createdAt: string;
}

// ── Module-level imperative opener (mirror ProjectManager) ─────────────────────

let openImpl: (() => void) | null = null;

export function openSearchOverlay(): void {
  openImpl?.();
}

// FTS5 marks matches with literal <mark>…</mark> in the snippet text. Split on
// the markers and alternate plain/highlight — no raw HTML ever reaches the DOM.
function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/<\/?mark>/);
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>,
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SearchOverlay() {
  const t = useT();
  const desktop = useMainStore((s) => s.desktop);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // null = idle (nothing typed yet); [] = searched, no hits.
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic sequence — a stale response (slow query racing a newer one)
  // must never clobber the newer query's results.
  const seqRef = useRef(0);

  useEffect(() => {
    openImpl = () => setOpen(true);
    return () => {
      openImpl = null;
    };
  }, []);

  // Focus + select the query on open so a repeat search can retype instantly.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Debounced search. Each keystroke bumps the sequence; only the newest
  // in-flight response is allowed to land.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const seq = ++seqRef.current;
    if (!q) {
      setHits(null);
      setError("");
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const cwd = getMainState().workspaceCwd;
      if (!cwd) {
        setHits([]);
        setSearching(false);
        return;
      }
      const run = (match: string) =>
        bridge().invoke("search_workspace_messages", { cwd, query: match, limit: 80 }) as Promise<{
          hits?: SearchHit[];
        }>;
      try {
        let data: { hits?: SearchHit[] };
        try {
          data = await run(q);
        } catch {
          // Free text can be invalid MATCH grammar — retry as a quoted phrase.
          data = await run(`"${q.replace(/"/g, " ")}"`);
        }
        if (seqRef.current !== seq) return;
        setHits(data?.hits ?? []);
        setError("");
      } catch (err) {
        if (seqRef.current !== seq) return;
        setHits([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seqRef.current === seq) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, query]);

  // Group hits by session, newest group first. Hits whose session isn't in the
  // sidebar index (subagent transcripts, stale strays) are dropped — there'd
  // be nothing to open on click.
  const groups = useMemo(() => {
    if (!hits) return null;
    const sessionById = new Map((desktop?.sessions ?? []).map((s) => [s.id, s]));
    const byId = new Map<string, { session: SessionListItem; hits: SearchHit[] }>();
    for (const hit of hits) {
      const existing = byId.get(hit.sessionId);
      if (existing) {
        existing.hits.push(hit);
        continue;
      }
      const session = sessionById.get(hit.sessionId);
      if (session) byId.set(hit.sessionId, { session, hits: [hit] });
    }
    return [...byId.values()].sort((a, b) => b.hits[0]!.createdAt.localeCompare(a.hits[0]!.createdAt));
  }, [hits, desktop]);

  const openHit = async (session: SessionListItem) => {
    setOpen(false);
    await loadSession(session);
  };

  if (!open) return null;

  const hitCount = groups?.reduce((sum, g) => sum + g.hits.length, 0) ?? 0;

  return createPortal(
    <div
      className="pm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="pm-panel so-panel" role="dialog" aria-modal aria-label={t("convsearch.title")}>
        <header className="pm-header">
          <div className="pm-header-top">
            <h2 className="pm-title">{t("convsearch.title")}</h2>
            <button
              type="button"
              className="pm-close"
              aria-label={t("projects.close")}
              onClick={() => setOpen(false)}
            >
              <svg className="icon">
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          <div className="pm-search">
            <svg className="icon">
              <use href="#i-search" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={t("convsearch.placeholder")}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
          </div>
        </header>
        <div className="pm-list so-list">
          {groups === null ? (
            <div className="pm-empty">{t("convsearch.idle")}</div>
          ) : error ? (
            <div className="pm-empty so-error">{error}</div>
          ) : groups.length === 0 ? (
            <div className="pm-empty">{searching ? "…" : t("convsearch.noResults", { query: query.trim() })}</div>
          ) : (
            groups.map((group) => (
              <div key={group.session.id} className="so-group">
                <button
                  type="button"
                  className="so-group-header"
                  title={group.session.title}
                  onClick={() => void openHit(group.session)}
                >
                  <span className="so-group-title">{group.session.title || "Reina"}</span>
                  <span className="so-group-when">{formatWhen(group.hits[0]!.createdAt)}</span>
                </button>
                {group.hits.map((hit) => (
                  <button
                    key={hit.messageId}
                    type="button"
                    className="so-hit"
                    onClick={() => void openHit(group.session)}
                  >
                    <span className={"so-hit-role" + (hit.role === "user" ? " user" : "")}>
                      {hit.role === "user" ? t("convsearch.roleUser") : t("convsearch.roleAssistant")}
                    </span>
                    <span className="so-hit-snippet">{renderSnippet(hit.snippet)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <footer className="pm-footer">
          <span className="pm-count">
            {groups && groups.length > 0
              ? t("convsearch.count", { hits: hitCount, sessions: groups.length })
              : ""}
          </span>
          {searching && <span className="pm-count">{t("convsearch.searching")}</span>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
