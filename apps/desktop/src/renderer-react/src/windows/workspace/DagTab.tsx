// DAG tab body — React port of the legacy team-mode subtask DAG panel
// (apps/desktop/src/renderer/actions/dag-view.js). Reproduces the legacy
// FUNCTIONALITY (layered auto-layout, SVG node/edge rendering, wheel-zoom,
// drag-to-pan, drag-a-node-to-reposition, click-to-select with edge
// highlight/dim, auto-fit until the viewer takes over, phase + summary
// chips, refresh = reset layout, detail pane with depends-on / blocks /
// bound-task links) in the React/Tailwind workspace style (matching
// FileTree / GitChanges / NotesTab).
//
// ── Data path (fixed) ─────────────────────────────────────────────────────
// The legacy renderer is entirely stream-driven: an in-memory `state.subtasks`
// map fed by `model_stream` `subtask-updated` / `phase-changed` events plus
// full-session `hydrateFromSession`. The main process broadcasts those `agent`
// events to EVERY window, but the subtask DAG arrives NESTED as
// `{ type: "model_stream", event: { type: "subtask-updated", subtask, change } }`
// (and `phase-changed`) plus cold-load via `session_snapshot` carrying
// session.subtasks / session.phase — NOT a bespoke top-level channel.
// workspaceEngineStore owns the single "agent" subscription and the ported
// applySubtask / applyPhase / hydrateFromSession reducers; this tab reads the
// subtasks Map + phase as slices and keeps only view-local interaction state
// (selection, pan/zoom, drag positions).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResizeHandle } from "~/components/ResizeHandle";
import { useResizableSidebar } from "~/lib/useResizableSidebar";
import {
  useWorkspaceEngine,
  type SubtaskRecord,
  type SubtaskStatus,
} from "./workspaceEngineStore";

// Re-export so existing consumers importing SubtaskRecord from this module
// continue to resolve.
export type { SubtaskRecord };

interface DagTabProps {
  cwd: string | null;
  active: boolean;
}

// ── Status palette / labels (legacy STATUS_LABEL) ────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  blocked: "blocked",
};

// Theme-aware tint for each status, mirroring the legacy `--dag-*` CSS tokens
// (workspace.css) so the graph tracks the active React theme rather than
// baking in fixed colours. `stroke` = node border / dot / edge; `fill` = node
// background (status hue mixed into the card surface).
const STATUS_STROKE: Record<string, string> = {
  pending: "color-mix(in srgb, var(--muted-foreground) 72%, var(--foreground))",
  in_progress: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  blocked: "#f59e0b",
  cancelled: "color-mix(in srgb, var(--muted-foreground) 60%, transparent)",
};

const STATUS_FILL: Record<string, string> = {
  pending: "color-mix(in srgb, var(--muted-foreground) 14%, var(--card))",
  in_progress: "color-mix(in srgb, #3b82f6 16%, var(--card))",
  completed: "color-mix(in srgb, #22c55e 15%, var(--card))",
  failed: "color-mix(in srgb, #ef4444 15%, var(--card))",
  blocked: "color-mix(in srgb, #f59e0b 16%, var(--card))",
  cancelled: "color-mix(in srgb, var(--muted-foreground) 9%, var(--card))",
};

// Tailwind text tint for chips / detail badges (parallels NotesTab.statusColor).
function statusTextClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    case "blocked":
      return "text-yellow-400";
    case "in_progress":
      return "text-blue-400";
    case "cancelled":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function normStatus(status: string): string {
  return STATUS_LABEL[status] ? status : "pending";
}

// ── Layout constants (verbatim from legacy dag-view.js) ──────────────────────

const NODE_W = 220;
const NODE_H = 56;
const LAYER_GAP_X = 80;
const LAYER_GAP_Y = 24;
const PAD_X = 24;
const PAD_Y = 24;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const GRID_SIZE = 20;

// Summary-chip ordering (legacy renderDag `order`).
const CHIP_ORDER: SubtaskStatus[] = [
  "in_progress",
  "pending",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

// ── Pure helpers (verbatim from legacy) ──────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string | null | undefined, n: number): string {
  if (s == null) return "";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

interface Pos {
  x: number;
  y: number;
}

interface Layout {
  positions: Map<string, Pos>;
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface View {
  k: number;
  tx: number;
  ty: number;
  userAdjusted: boolean;
}

/** Longest-path layer assignment (legacy computeLayers). Cycle-safe. */
function computeLayers(nodes: SubtaskRecord[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(id: string): number {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle — treat as root
    visiting.add(id);
    const node = byId.get(id);
    if (!node || node.blockedBy.length === 0) {
      layer.set(id, 0);
      visiting.delete(id);
      return 0;
    }
    let max = 0;
    for (const depId of node.blockedBy) {
      const d = depth(depId);
      if (d + 1 > max) max = d + 1;
    }
    layer.set(id, max);
    visiting.delete(id);
    return max;
  }
  for (const node of nodes) depth(node.id);
  return layer;
}

/** Plan x/y per node by layer (col) + per-layer order (row), then apply any
 * manual drag overrides on top, and compute the bounding box (legacy
 * layoutNodes). */
function layoutNodes(
  nodes: SubtaskRecord[],
  overrides: Map<string, Pos>,
): Layout {
  if (nodes.length === 0) {
    return { positions: new Map(), minX: 0, minY: 0, width: 0, height: 0 };
  }
  const layers = computeLayers(nodes);
  const groups = new Map<number, SubtaskRecord[]>();
  for (const node of nodes) {
    const l = layers.get(node.id) ?? 0;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(node);
  }
  const sortedLayers = [...groups.keys()].sort((a, b) => a - b);
  const positions = new Map<string, Pos>();
  for (const l of sortedLayers) {
    const group = groups.get(l)!;
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    group.forEach((node, idx) => {
      positions.set(node.id, {
        x: PAD_X + l * (NODE_W + LAYER_GAP_X),
        y: PAD_Y + idx * (NODE_H + LAYER_GAP_Y),
      });
    });
  }
  // Manual drag positions override the auto-layout.
  if (overrides && overrides.size > 0) {
    for (const node of nodes) {
      const o = overrides.get(node.id);
      if (o) positions.set(node.id, { x: o.x, y: o.y });
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + NODE_W > maxX) maxX = x + NODE_W;
    if (y + NODE_H > maxY) maxY = y + NODE_H;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return { positions, minX, minY, width: maxX - minX, height: maxY - minY };
}

/** Center + scale the graph to fit the canvas (legacy fitDagView). */
function fitDagView(layout: Layout, cw: number, ch: number): View {
  const margin = 48;
  const w = Math.max(layout.width, 1);
  const h = Math.max(layout.height, 1);
  const k = clamp(Math.min((cw - margin) / w, (ch - margin) / h, 1), MIN_ZOOM, 1);
  return {
    k,
    tx: (cw - w * k) / 2 - layout.minX * k,
    ty: (ch - h * k) / 2 - layout.minY * k,
    userAdjusted: false,
  };
}

function countByStatus(nodes: SubtaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  return counts;
}

// ── Icons ───────────────────────────────────────────────────────────────────

function WorkflowIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-muted-foreground/40"
    >
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <path d="M6 9v3a3 3 0 0 0 3 3h3" />
      <path d="M18 9v6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function DagTab({ cwd }: DagTabProps) {
  // Canonical subtask map + phase from the shared engine store (fed by the
  // broadcast "agent" stream + session snapshots — see workspaceEngineStore).
  const subtasks = useWorkspaceEngine((s) => s.subtasks);
  const phase = useWorkspaceEngine((s) => s.phase);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Manual drag positions (legacy state.dagNodePos) and view transform
  // (legacy state.dagView). Kept in refs because they mutate during pointer
  // gestures at animation-frame cadence; we mirror into React state only to
  // drive re-renders where the SVG transform / node coords must update.
  const nodePos = useRef<Map<string, Pos>>(new Map());
  const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0, userAdjusted: false });
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Most recent laid-out positions (legacy lastPositions) — read when a node
  // drag starts so the drag math has the node's current on-screen position.
  const lastPositions = useRef<Map<string, Pos>>(new Map());

  // ── Stable nodes array (oldest first), recomputed when the map changes ──
  const nodes = useMemo(
    () =>
      [...subtasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [subtasks],
  );

  // ── Layout (pure) — recomputed when nodes or manual drags change ──────────
  // `nodePosVersion` bumps whenever a drag mutates nodePos so the memo refreshes.
  const [nodePosVersion, setNodePosVersion] = useState(0);
  const layout = useMemo(
    () => layoutNodes(nodes, nodePos.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, nodePosVersion],
  );
  lastPositions.current = layout.positions;

  // ── Reset view/interaction state on cwd change ──────────────────────────────
  // The subtask data itself is owned by the shared store (re-hydrated from the
  // next session_snapshot); here we only reset the view-local interaction state
  // so a workspace switch starts from an auto-fitted, undragged graph.
  useEffect(() => {
    setSelectedId(null);
    nodePos.current = new Map();
    viewRef.current = { k: 1, tx: 0, ty: 0, userAdjusted: false };
    setNodePosVersion((v) => v + 1);
  }, [cwd]);

  // Drop the selection if its subtask disappears from the store (legacy
  // applySubtask removed-branch selection clear).
  useEffect(() => {
    setSelectedId((cur) => (cur && !subtasks.has(cur) ? null : cur));
  }, [subtasks]);

  // ── Auto-fit until the viewer pans / zooms / drags (legacy renderDag) ─────
  // Runs after layout changes while the view is still auto-managed.
  useEffect(() => {
    if (nodes.length === 0) return;
    if (viewRef.current.userAdjusted) return;
    const el = canvasRef.current;
    const cw = el?.clientWidth || 800;
    const ch = el?.clientHeight || 500;
    viewRef.current = fitDagView(layout, cw, ch);
    rerender();
  }, [layout, nodes.length, rerender]);

  // ── Selection (legacy selectSubtask — toggles) ────────────────────────────
  const selectSubtask = useCallback((id: string) => {
    setSelectedId((cur) => (cur === id ? null : id));
  }, []);

  // ── Refresh = reset to auto-layout + re-fit (legacy dagRefresh.onclick) ───
  const handleRefresh = useCallback(() => {
    nodePos.current = new Map();
    viewRef.current = { k: 1, tx: 0, ty: 0, userAdjusted: false };
    setNodePosVersion((v) => v + 1);
    rerender();
  }, [rerender]);

  // ── Wheel-zoom toward the cursor (legacy bindCanvasInteractions wheel) ────
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const view = viewRef.current;
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k2 = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
    if (k2 === view.k) return;
    view.tx = mx - (mx - view.tx) * (k2 / view.k);
    view.ty = my - (my - view.ty) * (k2 / view.k);
    view.k = k2;
    view.userAdjusted = true;
    rerender();
  }, [rerender]);

  // ── Pointer gestures: node-drag / pan / click-select ──────────────────────
  // (legacy bindCanvasInteractions pointerdown/move/up). Window-level move/up
  // listeners are attached for the duration of a gesture so a drag that leaves
  // the canvas still tracks.
  const gesture = useRef<{
    mode: "node" | "pan" | null;
    dragId: string | null;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    startNodeX: number;
    startNodeY: number;
    panMoved: boolean;
  }>({
    mode: null,
    dragId: null,
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    startNodeX: 0,
    startNodeY: 0,
    panMoved: false,
  });
  /** Detach hook for the in-flight drag's window listeners (see below). */
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const g = gesture.current;
    g.panMoved = false;
    g.startX = e.clientX;
    g.startY = e.clientY;
    const target = e.target as Element;
    const nodeEl = target.closest?.("g[data-subtask-id]") as Element | null;
    if (nodeEl) {
      g.mode = "node";
      g.dragId = nodeEl.getAttribute("data-subtask-id");
      const pos = (g.dragId ? lastPositions.current.get(g.dragId) : null) || { x: 0, y: 0 };
      g.startNodeX = pos.x;
      g.startNodeY = pos.y;
    } else {
      g.mode = "pan";
      g.startTx = viewRef.current.tx;
      g.startTy = viewRef.current.ty;
    }

    const onMove = (ev: PointerEvent) => {
      if (!g.mode) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (!g.panMoved && Math.abs(dx) + Math.abs(dy) > 4) g.panMoved = true;
      if (g.mode === "pan") {
        const view = viewRef.current;
        view.tx = g.startTx + dx;
        view.ty = g.startTy + dy;
        view.userAdjusted = true;
        rerender();
      } else if (g.dragId) {
        // Pixel delta → content delta (undo the zoom). Free movement, incl.
        // negative coords (fit/pan account for the full extent). Lock the view
        // so auto-fit can't fight the drag.
        const k = viewRef.current.k || 1;
        nodePos.current.set(g.dragId, {
          x: g.startNodeX + dx / k,
          y: g.startNodeY + dy / k,
        });
        viewRef.current.userAdjusted = true;
        setNodePosVersion((v) => v + 1);
      }
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      const clickedId = g.mode === "node" && !g.panMoved ? g.dragId : null;
      g.mode = null;
      g.dragId = null;
      detach();
      if (clickedId) selectSubtask(clickedId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dragCleanupRef.current = detach;
  }, [rerender, selectSubtask]);

  // Unmount safety net: a drag that outlives the component (tab switch
  // mid-drag) must not leave window-level listeners running layout math and
  // setState against an unmounted tree.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const view = viewRef.current;
  const selected = selectedId ? subtasks.get(selectedId) ?? null : null;
  const counts = useMemo(() => countByStatus(nodes), [nodes]);

  // Detail pane is drag-to-resize (handle on its LEFT edge → drag left widens),
  // persisted like the AgentTeam process column.
  const detailPane = useResizableSidebar({
    storageKey: "reina.workspace.dagDetail",
    defaultWidth: 288,
    minWidth: 220,
    maxWidth: 520,
    side: "right",
  });

  // ── Empty state ───────────────────────────────────────────────────────────
  const isEmpty = nodes.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ── sub-toolbar: phase chip + summary chips + refresh ── */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
        <span className="shrink-0 text-[12px] font-medium text-foreground/80">Team DAG</span>
        {phase && (
          <span className="shrink-0 rounded-full bg-secondary/70 px-1.5 py-px text-[10px] font-medium text-primary">
            Phase: {phase}
          </span>
        )}
        <div className="flex-1" />
        {/* summary chips */}
        <div className="flex items-center gap-1">
          {CHIP_ORDER.filter((status) => counts[status]).map((status) => (
            <span
              key={status}
              title={`${counts[status]} ${STATUS_LABEL[status]}`}
              className={
                "rounded-full bg-secondary/70 px-1.5 py-px text-[10px] font-medium " +
                statusTextClass(status)
              }
            >
              {STATUS_LABEL[status]} {counts[status]}
            </span>
          ))}
        </div>
        <button
          type="button"
          title="Reset layout & fit view (clears manual drags, pan and zoom)"
          aria-label="Reset DAG layout"
          onClick={handleRefresh}
          disabled={isEmpty}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* ── body: canvas + detail ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* canvas */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {isEmpty ? (
            <DagEmpty />
          ) : (
            <div
              ref={canvasRef}
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              className="dag-canvas relative min-h-0 flex-1 overflow-hidden [touch-action:none] select-none"
              style={{
                cursor: gesture.current.mode === "pan" ? "grabbing" : "default",
                backgroundImage:
                  "radial-gradient(circle, color-mix(in srgb, var(--muted-foreground) 22%, transparent) 1px, transparent 1px)",
                backgroundSize: `${GRID_SIZE * view.k}px ${GRID_SIZE * view.k}px`,
                backgroundPosition: `${view.tx}px ${view.ty}px`,
              }}
            >
              <DagSvg
                nodes={nodes}
                layout={layout}
                view={view}
                selectedId={selectedId}
              />
            </div>
          )}
        </div>

        {/* detail pane */}
        {selected && (
          <>
            <ResizeHandle onPointerDown={detailPane.startResize} active={detailPane.resizing} ariaLabel="Resize detail panel" />
            <div
              style={{ width: detailPane.width }}
              className="shrink-0 overflow-auto bg-card"
            >
              <DagDetail node={selected} subtasks={subtasks} onSelectRef={selectSubtask} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── SVG graph (legacy buildSvg, as React elements) ───────────────────────────

function DagSvg({
  nodes,
  layout,
  view,
  selectedId,
}: {
  nodes: SubtaskRecord[];
  layout: Layout;
  view: View;
  selectedId: string | null;
}) {
  const { positions } = layout;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ── Edges (legacy drawEdge) — dedup, parent-status coloured ──
  const edges: React.ReactNode[] = [];
  const drawn = new Set<string>();
  const pushEdge = (parentId: string, childId: string) => {
    const key = `${parentId}->${childId}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    const from = positions.get(parentId);
    const to = positions.get(childId);
    if (!from || !to) return;
    const parent = byId.get(parentId);
    const child = byId.get(childId);
    const parentStatus = normStatus(parent?.status ?? "pending");
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
    const statusLabel = STATUS_LABEL[parentStatus] ?? parentStatus;
    const parentTitle = parent?.title ?? parentId;
    const childTitle = child?.title ?? childId;
    const labelText = truncate(parentTitle, 14);
    const labelWidth = Math.max(28, labelText.length * 6 + 12);
    const tooltip = `${parentTitle} → ${childTitle}\nblocker: ${statusLabel}`;
    const isActive = !!selectedId && (parentId === selectedId || childId === selectedId);
    const dim = !!selectedId && !isActive;
    const stroke = STATUS_STROKE[parentStatus];
    edges.push(
      <g key={key} opacity={dim ? 0.25 : 1}>
        <title>{tooltip}</title>
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={isActive ? 2.5 : 1.5}
          markerEnd={`url(#dag-arrow-${parentStatus})`}
        />
        <rect
          x={cx - labelWidth / 2}
          y={cy - 8}
          width={labelWidth}
          height={14}
          rx={3}
          fill="var(--card)"
          stroke="var(--surface-divider)"
          strokeWidth={1}
        />
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          fontSize={9}
          fill="var(--muted-foreground)"
          className="pointer-events-none"
        >
          {labelText}
        </text>
      </g>,
    );
  };
  for (const node of nodes) {
    for (const parentId of node.blockedBy) pushEdge(parentId, node.id);
    for (const childId of node.blocks) pushEdge(node.id, childId);
  }

  // ── Nodes (legacy node build) ──
  const nodeEls: React.ReactNode[] = [];
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const status = normStatus(node.status);
    const isSelected = node.id === selectedId;
    const idLabel = node.id.replace(/^sub_/, "").slice(0, 10);
    const title = truncate(node.title, 34);
    const statusText = STATUS_LABEL[node.status] ?? node.status;
    const stroke = STATUS_STROKE[status];
    const fill = STATUS_FILL[status];
    nodeEls.push(
      <g
        key={node.id}
        data-subtask-id={node.id}
        tabIndex={0}
        className="cursor-pointer outline-none"
      >
        <rect
          x={pos.x}
          y={pos.y}
          width={NODE_W}
          height={NODE_H}
          rx={8}
          fill={fill}
          stroke={isSelected ? "var(--primary)" : stroke}
          strokeWidth={isSelected ? 2.5 : 1.25}
        />
        <circle cx={pos.x + 14} cy={pos.y + 15} r={4.5} fill={stroke} />
        <text x={pos.x + 26} y={pos.y + 18} fontSize={11} fontFamily="ui-monospace, monospace" fill="var(--muted-foreground)" className="pointer-events-none">
          {idLabel}
        </text>
        <text x={pos.x + NODE_W - 10} y={pos.y + 18} textAnchor="end" fontSize={10} fontWeight={600} fill={stroke} className="pointer-events-none">
          {statusText}
        </text>
        <text x={pos.x + 12} y={pos.y + 37} fontSize={13} fontWeight={500} fill="var(--foreground)" className="pointer-events-none">
          {title}
        </text>
        {node.owner && (
          <text x={pos.x + 12} y={pos.y + NODE_H - 8} fontSize={10} fill="var(--muted-foreground)" className="pointer-events-none">
            {truncate(node.owner, 16)}
          </text>
        )}
        {node.phase && (
          <text x={pos.x + NODE_W - 10} y={pos.y + NODE_H - 8} textAnchor="end" fontSize={10} fill="var(--muted-foreground)" className="pointer-events-none">
            {node.phase}
          </text>
        )}
      </g>,
    );
  }

  // One arrow marker per status (legacy arrowDefs) so the head matches its edge.
  const arrowDefs = Object.keys(STATUS_STROKE).map((status) => (
    <marker
      key={status}
      id={`dag-arrow-${status}`}
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={6}
      markerHeight={6}
      orient="auto-start-reverse"
    >
      <path d="M0,0 L10,5 L0,10 Z" fill={STATUS_STROKE[status]} />
    </marker>
  ));

  return (
    <svg
      width="100%"
      height="100%"
      role="img"
      aria-label="Team subtask DAG"
      className="absolute inset-0 h-full w-full"
    >
      <defs>{arrowDefs}</defs>
      <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
        {edges}
        {nodeEls}
      </g>
    </svg>
  );
}

// ── Detail pane (legacy renderDetail) ────────────────────────────────────────

function DagDetail({
  node,
  subtasks,
  onSelectRef,
}: {
  node: SubtaskRecord;
  subtasks: Map<string, SubtaskRecord>;
  onSelectRef: (id: string) => void;
}) {
  const status = normStatus(node.status);
  // `blocks` rebuilt live from the full map (legacy downstreamIds) so adds /
  // removals reflect immediately without waiting for a cross-node emission.
  const downstreamIds = useMemo(
    () =>
      [...subtasks.values()]
        .filter((n) => n.blockedBy.includes(node.id))
        .map((n) => n.id),
    [subtasks, node.id],
  );

  const RefChip = ({ refId, direction }: { refId: string; direction: "up" | "down" }) => {
    const arrow = direction === "up" ? "⤺" : "⤻";
    const ref = subtasks.get(refId);
    if (!ref) {
      return (
        <span
          title={`${refId} (not loaded)`}
          className="inline-flex items-center gap-1 rounded-md bg-secondary/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
        >
          {arrow} {refId}
        </span>
      );
    }
    const refStatus = normStatus(ref.status);
    const tooltip = `${ref.title}\nstatus: ${STATUS_LABEL[ref.status] ?? ref.status}`;
    return (
      <button
        type="button"
        title={tooltip}
        onClick={() => onSelectRef(refId)}
        className={
          "inline-flex items-center gap-1 rounded-md bg-secondary/60 px-1.5 py-px text-[10px] transition-colors duration-(--motion-fast) hover:bg-secondary " +
          statusTextClass(refStatus)
        }
      >
        {arrow} {truncate(ref.title, 24)}
        <span className="font-mono text-muted-foreground/70">{refId}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col">
      {/* header */}
      <div className="border-b border-(--surface-divider) bg-card/80 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground/70">{node.id}</span>
          <span className={"rounded-full bg-secondary/70 px-1.5 py-px text-[10px] font-medium " + statusTextClass(status)}>
            {STATUS_LABEL[node.status] ?? node.status}
          </span>
        </div>
        <h2 className="mt-1.5 text-[14px] font-semibold leading-snug text-foreground">{node.title}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {node.owner && (
            <span>
              Owner: <strong className="text-foreground/80">{node.owner}</strong>
            </span>
          )}
          {node.phase && <span>Phase: {node.phase}</span>}
          {node.tags && node.tags.length > 0 && <span>Tags: {node.tags.join(", ")}</span>}
        </div>
      </div>

      {/* description */}
      <section className="border-b border-(--surface-divider) px-3 py-3">
        <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          Description
        </h3>
        <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
          {node.description || <span className="italic text-muted-foreground">No description.</span>}
        </div>
      </section>

      {/* result */}
      {node.resultSummary && (
        <section className="border-b border-(--surface-divider) px-3 py-3">
          <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            Result
          </h3>
          <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
            {node.resultSummary}
          </div>
        </section>
      )}

      {/* links */}
      <section className="px-3 py-3">
        <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          Links
        </h3>
        <div className="flex flex-col gap-2">
          {node.blockedBy.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-foreground/70">Depends on:</span>
              {node.blockedBy.map((id) => (
                <RefChip key={`up-${id}`} refId={id} direction="up" />
              ))}
            </div>
          )}
          {downstreamIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-foreground/70">Blocks:</span>
              {downstreamIds.map((id) => (
                <RefChip key={`down-${id}`} refId={id} direction="down" />
              ))}
            </div>
          )}
          {node.asyncTaskIds && node.asyncTaskIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-foreground/70">Bound tasks:</span>
              {node.asyncTaskIds.map((id) => (
                <span key={`task-${id}`} className="rounded-md bg-secondary/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                  task {id}
                </span>
              ))}
            </div>
          )}
          {node.blockedBy.length === 0 && downstreamIds.length === 0 && (!node.asyncTaskIds || node.asyncTaskIds.length === 0) && (
            <span className="text-[11px] italic text-muted-foreground">No linked subtasks.</span>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Empty state (legacy dag-empty) ───────────────────────────────────────────

function DagEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <WorkflowIcon />
      <div>
        <p className="font-medium text-foreground/70">No subtasks yet.</p>
        <p className="mx-auto mt-1 max-w-md text-xs">
          Give the agent a multi-step goal that benefits from explicit subtask
          tracking (multi-module audit/refactor, PRD-driven feature, parallel
          investigations). It will decompose the work into a DAG you can watch
          here.
        </p>
      </div>
    </div>
  );
}
