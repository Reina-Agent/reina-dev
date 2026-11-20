// Session list sidebar — React port.
// Reproduces the EXACT DOM that the legacy renderer builds inside #session-list
// (apps/desktop/src/renderer/actions/session.js: renderSessions, buildSessionRow,
// updateSessionRow, buildSectionHeading).
//
// The legacy CSS (apps/desktop/src/renderer/styles/sidebar.css) is reused
// verbatim — every class name, element tag, and data-attribute here must match
// the legacy output precisely, or the styling breaks.
//
// Do NOT add Tailwind classes. Do NOT use any CSS other than the legacy class names.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { setDragGhost, useListFlip } from "~/lib/dnd";
import { isSidebarWindow } from "~/lib/windowKind";
import {
  useMainStore,
  loadSession,
  refreshDesktopState,
  setSidebarActiveSession,
} from "./sessionStore";
import {
  SessionContextMenu,
  openSessionContextMenu,
  startSessionRename,
} from "./SessionContextMenu";
import type { SessionListItem, DesktopState } from "./protocol";
import {
  sessionListAgeLabel,
  sessionListAgeTitle,
  shortPath,
  effectiveSessionTs,
  loadCollapsedGroups,
  persistCollapsedGroups,
  ARCHIVED_GROUP_ID,
  DRAFT_SESSION_ID,
} from "./sessionHelpers";

// ---------------------------------------------------------------------------
// Icon helper — mirrors legacy `icon("name")` output exactly:
//   <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
//     <use href="#i-NAME"/>
//   </svg>
// ---------------------------------------------------------------------------

function Icon({ name }: { name: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden
      focusable={false}
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types for the flat desired-entries list (mirrors session.js "desired" array)
// ---------------------------------------------------------------------------

interface LabelEntry {
  kind: "label";
  title: string;
}

interface ToggleEntry {
  kind: "toggle";
  id: string;
  title: string;
  count: number;
  collapsed: boolean;
}

interface SessionEntry {
  kind: "session";
  item: SessionListItem;
  depth: number;
  // True for rows that participate in drag-to-reorder: every normal session
  // (forks included — each fork is its own independent top-level row).
  // Drafts and pinned/archived rows stay fixed.
  draggable: boolean;
}

interface DividerEntry {
  kind: "divider";
}

type DesiredEntry = LabelEntry | ToggleEntry | SessionEntry | DividerEntry;

// ---------------------------------------------------------------------------
// Build the ordered flat list of entries to render (mirrors renderSessions in
// session.js): drafts → pinned (with "Pinned" label) → flat newest-first
// normal sessions → archived toggle + items.
// ---------------------------------------------------------------------------

function buildDesiredEntries(
  snapshot: DesktopState,
  workspaceCwd: string | null,
  collapsedGroups: Set<string>,
  draftItem: SessionListItem | null,
): DesiredEntry[] {
  const activeWs = snapshot.workspaces.find(
    (ws) => ws.id === snapshot.activeWorkspaceId,
  );
  const activeCwd = activeWs?.cwd ?? workspaceCwd ?? null;
  const inScope = (item: SessionListItem) =>
    item.draft || !activeCwd || item.cwd === activeCwd;

  const all = draftItem
    ? [draftItem, ...snapshot.sessions]
    : snapshot.sessions;
  const scoped = all.filter(inScope);

  // Every conversation is independent: a forked session is rendered as its own
  // top-level row rather than nested under the conversation it
  // branched from. It keeps its `is-fork` branch badge (via item.parentId) so
  // you can still tell it was a fork, but it is never grouped with — or
  // dragged together with — its parent or sibling forks.

  const drafts = scoped.filter((item) => item.draft);
  const pinned = scoped.filter(
    (item) => !item.draft && item.pinnedAt && !item.archivedAt,
  );
  const normal = scoped.filter(
    (item) => !item.draft && !item.pinnedAt && !item.archivedAt,
  );
  const archived = scoped.filter(
    (item) => !item.draft && item.archivedAt,
  );

  const desired: DesiredEntry[] = [];

  // All rows sit at depth 0 (flat). Only the normal pass is draggable;
  // drafts and pinned/archived rows stay fixed.
  const push = (item: SessionListItem, draggable = false) => {
    desired.push({ kind: "session", item, depth: 0, draggable });
  };

  for (const item of drafts) push(item);

  if (pinned.length > 0) {
    desired.push({ kind: "label", title: "Pinned" });
    for (const item of pinned) push(item);
    // Visually separate the pinned block from the normal list below it.
    if (normal.length > 0) desired.push({ kind: "divider" });
  }

  // Flat, newest-first list — no Today/Yesterday/Previous-7-days time headings
  // (they fragmented the list and read as clutter). Sorted by effective
  // timestamp (orderTs override → recency) so a dragged row keeps its slot.
  // Decorate-sort: parse each timestamp once (not twice per comparison), and
  // sink missing/unparseable timestamps to the bottom — a raw NaN comparator
  // result would leave those rows at arbitrary, render-unstable positions.
  const normalSorted = normal
    .map((item) => {
      const ts = Date.parse(effectiveSessionTs(item));
      return [Number.isFinite(ts) ? ts : -Infinity, item] as const;
    })
    .sort((a, b) => (a[0] === b[0] ? 0 : b[0] - a[0]))
    .map(([, item]) => item);
  for (const item of normalSorted) push(item, true);

  if (archived.length > 0) {
    const collapsed = collapsedGroups.has(ARCHIVED_GROUP_ID);
    desired.push({
      kind: "toggle",
      id: ARCHIVED_GROUP_ID,
      title: "Archived",
      count: archived.length,
      collapsed,
    });
    if (!collapsed) {
      for (const item of archived) push(item);
    }
  }

  return desired;
}

// ---------------------------------------------------------------------------
// SectionHeading — plain label or collapsible "Archived" toggle.
// Mirrors buildSectionHeading in session.js.
//
// Plain label:
//   <div class="session-group-heading">Title</div>
//
// Toggle (Archived):
//   <div class="session-group-heading [is-collapsed]">
//     <button class="session-group-toggle" type="button">
//       <span class="session-group-name">Archived</span>
//       <span class="session-group-count">N</span>
//     </button>
//   </div>
// ---------------------------------------------------------------------------

function SectionHeading({
  entry,
  onToggle,
}: {
  entry: LabelEntry | ToggleEntry;
  onToggle?: (id: string) => void;
}) {
  if (entry.kind === "label") {
    return <div className="session-group-heading">{entry.title}</div>;
  }

  return (
    <div
      className={`session-group-heading${entry.collapsed ? " is-collapsed" : ""}`}
    >
      <button
        className="session-group-toggle"
        type="button"
        onClick={() => onToggle?.(entry.id)}
      >
        <span className="session-group-name">{entry.title}</span>
        <span className="session-group-count">
          {entry.count > 0 ? String(entry.count) : ""}
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionRow — single session item.
// Mirrors buildSessionRow + updateSessionRow in session.js.
//
// Structure (non-draft):
//   <div class="session-item [active] [is-running] [is-attention] [is-pinned] [is-fork] [is-nested] [session-item-draft]"
//        data-session-id="ID"
//        style="--session-depth: N"
//        [title="分支会话"]>
//     <button class="session-main" type="button">
//       <span class="session-dot"></span>
//       <span class="session-title">Title</span>
//       <span class="session-model-chip">Xm</span>
//       <small>path - agent - model</small>
//     </button>
//     <div class="session-row-actions">
//       <button class="session-row-action session-row-pin" type="button" tabindex="-1">
//         <svg class="icon">…</svg>
//       </button>
//     </div>
//   </div>
//
// Draft omits .session-row-actions entirely.
// ---------------------------------------------------------------------------

type DropEdge = "top" | "bottom";

function SessionRow({
  item,
  depth,
  isActive,
  running,
  attention,
  canDrag,
  isDragging,
  dropEdge,
  onSelect,
  onPin,
  onDragStart,
  onDragEnd,
}: {
  item: SessionListItem;
  depth: number;
  isActive: boolean;
  running: boolean;
  attention: boolean;
  canDrag: boolean;
  isDragging: boolean;
  dropEdge: DropEdge | null;
  onSelect: (item: SessionListItem) => void;
  onPin: (item: SessionListItem) => void;
  onDragStart: (item: SessionListItem) => void;
  onDragEnd: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const isDraft = item.draft === true;
  const isPinned = !isDraft && Boolean(item.pinnedAt);
  const isFork = !isDraft && Boolean(item.parentId);
  const isNested = (depth || 0) > 0;

  const className = [
    "session-item",
    isDraft ? "session-item-draft" : "",
    isActive ? "active" : "",
    running ? "is-running" : "",
    attention ? "is-attention" : "",
    isPinned ? "is-pinned" : "",
    isFork ? "is-fork" : "",
    isNested ? "is-nested" : "",
    canDrag ? "is-draggable" : "",
    isDragging ? "is-dragging" : "",
    dropEdge === "top" ? "drop-before" : "",
    dropEdge === "bottom" ? "drop-after" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // dragover/drop live on the #session-list container (see SessionList) so a
  // release over labels, dividers, pinned rows, or empty space still lands —
  // per-row handlers only start and end the drag.
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.id);
      // Elevated-card ghost instead of Chromium's washed-out row snapshot.
      if (rowRef.current) setDragGhost(e, rowRef.current);
      onDragStart(item);
    },
    [item, onDragStart],
  );

  const ageLabel = sessionListAgeLabel(item);
  const ageTitle = sessionListAgeTitle(item);
  const sessionTitle = item.title || `Session ${item.id.slice(0, 8)}`;

  // model field can be a string or SessionModelRef object — mirror the legacy
  // `${item.model}` coercion (small.textContent = `${shortPath(item.cwd)} - ${item.agent} - ${item.model}`)
  const modelStr =
    typeof item.model === "object" && item.model !== null
      ? `${item.model.provider}/${item.model.model}`
      : String(item.model ?? "");

  const handleMainClick = useCallback(() => {
    onSelect(item);
  }, [item, onSelect]);

  const handlePinClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onPin(item);
    },
    [item, onPin],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isDraft) return; // draft rows have no context menu (mirror legacy)
      e.preventDefault();
      e.stopPropagation();
      const node = rowRef.current;
      if (node) openSessionContextMenu(e, item, node);
    },
    [item, isDraft],
  );

  // The ⋯ actions button opens the same context menu, anchored to the row
  // (mirror legacy: the row-action ⋯ button calls openSessionContextMenu).
  const handleActionsClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const node = rowRef.current;
      if (node) openSessionContextMenu(e, item, node);
    },
    [item],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDraft) return;
      e.preventDefault();
      e.stopPropagation();
      startSessionRename(item);
    },
    [item, isDraft],
  );

  return (
    <div
      ref={rowRef}
      className={className}
      data-session-id={item.id}
      style={
        { "--session-depth": String(depth || 0) } as React.CSSProperties
      }
      title={isFork ? "分支会话" : undefined}
      draggable={canDrag}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragEnd={canDrag ? onDragEnd : undefined}
    >
      <button
        className="session-main"
        type="button"
        onClick={handleMainClick}
      >
        <span className="session-dot" />
        <span className="session-title">{sessionTitle}</span>
        <span className="session-model-chip" title={ageTitle}>
          {ageLabel}
        </span>
        <small>{`${shortPath(item.cwd)} - ${item.agent ?? ""} - ${modelStr}`}</small>
      </button>

      {/* Draft rows have no actions — mirrors legacy isDraft branch that calls
          node.querySelector(".session-row-actions")?.remove() */}
      {!isDraft && (
        <div className="session-row-actions">
          <button
            className={`session-row-action session-row-pin${isPinned ? " is-on" : ""}`}
            type="button"
            tabIndex={-1}
            title={isPinned ? "Unpin" : "Pin to top"}
            aria-label={isPinned ? "Unpin" : "Pin to top"}
            onClick={handlePinClick}
          >
            <Icon name="pin" />
          </button>
          {/* ⋯ button — opens the SessionContextMenu anchored to the row, the
              same menu right-click raises (SessionContextMenu exposes this
              imperative trigger for the actions button per its design). */}
          <button
            className="session-row-action session-row-menu"
            type="button"
            tabIndex={-1}
            title="More"
            aria-label="More session actions"
            aria-haspopup="menu"
            onClick={handleActionsClick}
          >
            <Icon name="more-horizontal" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionList — the exported component.
// Renders the INNER content of #session-list (rows + group headings).
// The containing <div id="session-list"> lives in MainApp.tsx.
// ---------------------------------------------------------------------------

export function SessionList() {
  const desktop = useMainStore((s) => s.desktop);
  const sessionId = useMainStore((s) => s.sessionId);
  const workspaceCwd = useMainStore((s) => s.workspaceCwd);
  const isDraft = useMainStore((s) => !s.sessionId && !s.activeSession);
  // Sidebar badges: the visible session's running tracks `working`; background
  // sessions read their cached attention/running badge (mirror legacy).
  const working = useMainStore((s) => s.working);
  const sessionBadges = useMainStore((s) => s.sessionBadges);

  // Collapsed-groups state — mirrors the module-level `collapsedGroups` Set in
  // session.js. We persist to localStorage on each toggle.
  const [collapsedGroups, updateCollapsedGroups] = useReducer(
    (_prev: Set<string>, next: Set<string>) => next,
    undefined,
    () => loadCollapsedGroups(),
  );

  const toggleGroupCollapse = useCallback(
    (id: string) => {
      const next = new Set(collapsedGroups);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistCollapsedGroups(next);
      updateCollapsedGroups(next);
    },
    [collapsedGroups],
  );

  // Refresh the desktop state once per minute to keep age labels current
  // (mirrors the 60s setInterval in createSessionActions).
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshDesktopState();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Build the synthetic draft item when the user has no active saved session
  // (mirrors buildDraftSessionItem in session.js).
  const draftItem: SessionListItem | null = useMemo(() => {
    if (!isDraft || !workspaceCwd || !desktop) return null;
    const ws =
      desktop.workspaces.find((w) => w.cwd === workspaceCwd) ??
      desktop.workspaces.find((w) => w.id === desktop.activeWorkspaceId) ??
      null;
    const now = new Date().toISOString();
    return {
      id: DRAFT_SESSION_ID,
      draft: true,
      title: "New session",
      cwd: workspaceCwd,
      workspaceId: ws?.id,
      projectId: ws?.projectId,
      agent: "default",
      model: "reina-deterministic",
      createdAt: now,
      updatedAt: now,
    };
  }, [isDraft, workspaceCwd, desktop]);

  const desired = useMemo<DesiredEntry[]>(() => {
    if (!desktop) return [];
    return buildDesiredEntries(
      desktop,
      workspaceCwd,
      collapsedGroups,
      draftItem,
    );
  }, [desktop, workspaceCwd, collapsedGroups, draftItem]);

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback((item: SessionListItem) => {
    if (item.draft) return;
    // The floating sidebar window has no chat surface: ask the MAIN window to
    // load the session instead, highlighting the row optimistically (the
    // active-session broadcast confirms it). Mirrors legacy selectSession's
    // sidebar branch (markPendingSessionActive + openSessionInMain).
    if (isSidebarWindow) {
      setSidebarActiveSession(item.id);
      void bridge().openSessionInMain(item).catch(() => undefined);
      return;
    }
    void loadSession(item);
  }, []);

  const handlePin = useCallback((item: SessionListItem) => {
    void bridge()
      .setSessionFlags(item.id, { pinned: !item.pinnedAt })
      .then(() => refreshDesktopState())
      .catch(() => undefined);
  }, []);

  // ---------------------------------------------------------------------------
  // Drag-to-reorder. Only the normal rows participate (entry.draggable). On
  // drop we compute a new effective timestamp (`orderTs`) as the midpoint of
  // the drop target's neighbours and persist it; the backend re-sorts by that
  // timestamp, so the row settles where it was dropped and stays there across
  // refreshes.
  // ---------------------------------------------------------------------------

  const [drag, setDrag] = useState<{
    id: string;
    overId: string;
    edge: DropEdge;
  } | null>(null);

  // The draggable rows in display order — the sequence we reorder within.
  const draggableOrder = useMemo(
    () =>
      desired
        .filter(
          (e): e is SessionEntry => e.kind === "session" && e.draggable,
        )
        .map((e) => e.item),
    [desired],
  );

  const handleDragStart = useCallback((item: SessionListItem) => {
    setDrag({ id: item.id, overId: item.id, edge: "top" });
  }, []);

  const handleDragEnd = useCallback(() => setDrag(null), []);

  // Glide rows to their new slots whenever the list reorders (drop settle,
  // activity bump, pin/unpin) instead of teleporting.
  useListFlip("session-list", ".session-item[data-session-id]", "data-session-id");

  // Latest drag state + row order for the container-level listeners below —
  // refs so the listeners bind ONCE per drag instead of rebinding on every
  // dragover tick (each tick updates `drag`, which would churn the effect).
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const draggableOrderRef = useRef(draggableOrder);
  draggableOrderRef.current = draggableOrder;

  const commitDrop = useCallback((targetId: string, edge: DropEdge) => {
    const current = dragRef.current;
    setDrag(null);
    if (!current) return;
    const dragId = current.id;
    const order = draggableOrderRef.current;

    // The ordered list with the dragged row removed, then the slot it lands in.
    const without = order.filter((it) => it.id !== dragId);
    const targetIdx = without.findIndex((it) => it.id === targetId);
    if (targetIdx < 0) return;
    const insertIdx = edge === "top" ? targetIdx : targetIdx + 1;

    const above = without[insertIdx - 1];
    const below = without[insertIdx];
    const ms = (it: SessionListItem | undefined): number | null => {
      if (!it) return null;
      const parsed = Date.parse(effectiveSessionTs(it));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const aboveMs = ms(above);
    const belowMs = ms(below);

    // Newer rows sit higher (sort is descending by effective time), so the
    // row above has the LARGER timestamp. Pick a value strictly between the
    // neighbours; at an end, step one minute past the lone neighbour.
    let nextMs: number | null = null;
    if (aboveMs !== null && belowMs !== null)
      nextMs = Math.floor((aboveMs + belowMs) / 2);
    else if (belowMs !== null) nextMs = belowMs + 60_000;
    else if (aboveMs !== null) nextMs = aboveMs - 60_000;
    if (nextMs === null) return;

    // No-op guard: dropping a row back into its own slot.
    const currentMs = ms(order.find((it) => it.id === dragId));
    if (currentMs !== null && currentMs === nextMs) return;

    void bridge()
      .setSessionOrder(dragId, new Date(nextMs).toISOString())
      .then(() => refreshDesktopState())
      // Non-fatal (the row just snaps back), but never silent — a BOM/store
      // write failure looked identical to "drag does nothing".
      .catch((error) => console.warn("[session-list] setSessionOrder failed:", error));
  }, []);

  // Container-level dragover/drop: the whole #session-list surface accepts the
  // drop, mapped to the NEAREST draggable row (top/bottom half → before/after).
  // Rows only start/end drags — with per-row-only handlers, releasing over the
  // Pinned block, a heading, a divider, or the empty tail cancelled the drag
  // with zero feedback ("拖动有时候不成功"). Bound only while a drag is live so
  // foreign drags (files into the composer, etc.) are untouched.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const container = document.getElementById("session-list");
    if (!container) return;

    const locate = (clientY: number): { id: string; edge: DropEdge } | null => {
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>(".session-item.is-draggable[data-session-id]"),
      );
      let best: { id: string; edge: DropEdge; dist: number } | null = null;
      for (const el of rows) {
        const id = el.getAttribute("data-session-id");
        if (!id) continue;
        const rect = el.getBoundingClientRect();
        const edge: DropEdge = clientY < rect.top + rect.height / 2 ? "top" : "bottom";
        const dist =
          clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        if (!best || dist < best.dist) best = { id, edge, dist };
      }
      return best ? { id: best.id, edge: best.edge } : null;
    };

    const onDragOver = (e: DragEvent) => {
      // preventDefault claims the drop for the whole list surface; without it
      // the browser cancels any release outside a handler-bearing row.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const hit = locate(e.clientY);
      if (hit) setDrag((prev) => (prev ? { ...prev, overId: hit.id, edge: hit.edge } : prev));
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const hit = locate(e.clientY);
      if (hit) commitDrop(hit.id, hit.edge);
      else setDrag(null);
    };

    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    return () => {
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
    };
  }, [dragActive, commitDrop]);

  // Rename / delete / archive are driven by the SessionContextMenu (right-click
  // or the ⋯ button), which calls the store + bridge directly — see
  // SessionContextMenu.tsx — so no per-row handlers are needed here.

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!desktop) return null;

  if (desired.length === 0) {
    // Mirrors the empty state: <div class="meta">No sessions yet</div>
    return <div className="meta">No sessions yet</div>;
  }

  return (
    <>
      {desired.map((entry, index) => {
        if (entry.kind === "divider") {
          return <div key={`divider-${index}`} className="session-group-divider" />;
        }
        if (entry.kind === "label" || entry.kind === "toggle") {
          return (
            <SectionHeading
              key={`${entry.kind}-${entry.title}-${index}`}
              entry={entry}
              onToggle={toggleGroupCollapse}
            />
          );
        }

        const { item, depth } = entry;
        const isActive = item.draft
          ? isDraft
          : item.id === sessionId;
        const badge = sessionBadges[item.id] ?? {};
        const running = isActive && !item.draft ? working : Boolean(badge.running);
        const attention = isActive ? false : Boolean(badge.attention);
        const isDragging = drag?.id === item.id;
        const dropEdge =
          drag && drag.id !== item.id && drag.overId === item.id
            ? drag.edge
            : null;

        return (
          <SessionRow
            key={item.id}
            item={item}
            depth={depth}
            isActive={isActive}
            running={running}
            attention={attention}
            canDrag={entry.draggable}
            isDragging={isDragging}
            dropEdge={dropEdge}
            onSelect={handleSelect}
            onPin={handlePin}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        );
      })}
      {/* Singleton host for the session context menu + rename dialog. Mounted
          once here (alongside the rows) since the menu/dialog are module-level
          singletons; the host is layout-neutral (position: fixed menu + a
          <dialog>), so it does not disturb the #session-list flow. */}
      <SessionContextMenu />
    </>
  );
}
