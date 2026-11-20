// Relationship graph for the shared notebook — nodes are notes, directed
// edges are `refs` (a → b when note a cites b). Self-contained: no graph
// library (chat CSP blocks external assets and we avoid new deps).
//
// Obsidian-style LIVE force simulation, not a precomputed layout: a
// d3-force-like tick loop (pairwise charge repulsion + edge springs + centre
// gravity + collision, velocity-damped integration) runs on rAF while the
// alpha "temperature" is warm, then sleeps — no perpetual jiggle. Dragging a
// node pins it and reheats the simulation so its neighbours follow on their
// springs; releasing lets the cloud settle again. The view auto-fits while
// the graph settles until the viewer takes over (wheel-zoom toward the
// cursor with smoothed glide, background drag = pan, fit controls). Labels
// fade in past a zoom threshold; the focused node and its neighbours stay
// readable at any zoom. Deterministic spiral seed (no Math.random) so the
// settled layout is stable across re-renders.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NoteMeta } from "./NotesTab";

// Node fill by reasoning group — mirrors NotesTab's status/kind grouping so
// the graph reads with the same colour language as the list.
const GROUP_FILL: Record<string, string> = {
  confirmed: "#4ade80", // green-400
  dead: "#f87171", // red-400
  hypothesis: "#fb923c", // orange-400
  anchor: "#60a5fa", // blue-400
  open: "#facc15", // yellow-400
};

function groupOf(note: NoteMeta): string {
  if (note.status === "confirmed") return "confirmed";
  if (note.status === "dead") return "dead";
  const tags = note.tags ?? [];
  if (tags.includes("kind:hypothesis")) return "hypothesis";
  if (tags.includes("kind:goal") || tags.includes("kind:handoff")) return "anchor";
  return "open";
}

// View transform (same shape as DagTab): content → screen is
// translate(tx, ty) scale(k). `userAdjusted` locks out auto-fit.
interface View {
  k: number;
  tx: number;
  ty: number;
  userAdjusted: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
// Non-focus labels fade in across this zoom band (invisible below lo, fully
// visible above hi) so the fitted overview shows a clean point cloud.
const LABEL_FADE_LO = 0.55;
const LABEL_FADE_HI = 0.9;

// ── Simulation constants (content units, d3-force-ish magnitudes) ───────────
const LINK_DIST = 100; // spring rest length
const LINK_STRENGTH = 0.4;
const CHARGE = 260; // pairwise repulsion: Δv = unit · CHARGE·alpha / d
const GRAVITY_LINKED = 0.03; // weak centring pull — springs hold the cluster
const GRAVITY_ISOLATED = 0.1; // stronger pull bounds the repulsion ring
const COLLIDE_PAD = 14; // extra clearance between node discs
const DAMPING = 0.6; // velocity retained per tick (d3 velocityDecay 0.4)
const ALPHA_DECAY = 0.975; // temperature retained per tick (~150-tick settle)
const ALPHA_MIN = 0.02; // below this the simulation sleeps
const MAX_STEP = 40; // per-tick displacement cap (spiral-seed explosions)

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // Pinned position while dragged; null = free.
  fx: number | null;
  fy: number | null;
  isolated: boolean;
  r: number;
}

interface Sim {
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  springs: Array<[SimNode, SimNode]>;
  alpha: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Fit the current cloud into the container (DagTab fitDagView shape). Fit
// zoom is capped so tiny graphs don't blow up into billboard-sized dots.
function fitViewFor(nodes: SimNode[], cw: number, ch: number): View {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const margin = 90; // room for node radii + focus labels
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const k = clamp(Math.min((cw - margin) / w, (ch - margin) / h), MIN_ZOOM, 1.2);
  return {
    k,
    tx: (cw - w * k) / 2 - minX * k,
    ty: (ch - h * k) / 2 - minY * k,
    userAdjusted: false,
  };
}

const MAX_NODES = 300;

export function NotesGraph({
  notes,
  selectedId,
  onSelect,
}: {
  notes: NoteMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Simulation + view live in refs (mutated at rAF cadence); a counter
  // mirrors them into React renders — DagTab pattern.
  const simRef = useRef<Sim>({ nodes: [], byId: new Map(), springs: [], alpha: 0 });
  const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0, userAdjusted: false });
  // Pending smooth-zoom destination (wheel / buttons / fit glide toward it);
  // null when the view is at rest.
  const viewTarget = useRef<{ k: number; tx: number; ty: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingNode = useRef<SimNode | null>(null);
  /** Detach hook for the in-flight drag's window listeners (see pointerdown). */
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const model = useMemo(() => {
    // Cap to the most recent notes so the O(n²) charge pass stays snappy.
    const capped = notes.length > MAX_NODES
      ? notes.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, MAX_NODES)
      : notes;
    const present = new Set(capped.map((n) => n.id));
    const edges: Array<[string, string]> = [];
    const degree = new Map<string, number>();
    for (const note of capped) {
      for (const ref of note.refs ?? []) {
        if (!present.has(ref)) continue; // skip dangling refs (deleted target)
        edges.push([note.id, ref]);
        degree.set(note.id, (degree.get(note.id) ?? 0) + 1);
        degree.set(ref, (degree.get(ref) ?? 0) + 1);
      }
    }
    return { capped, edges, degree, byId: new Map(capped.map((n) => [n.id, n])) };
  }, [notes]);

  const { capped, edges, degree } = model;

  // ── Simulation tick loop ───────────────────────────────────────────────────
  // One rAF loop serves both the physics and the smooth-zoom glide; it parks
  // itself when the simulation is asleep and the view is at rest.
  const step = useCallback(() => {
    rafRef.current = null;
    const sim = simRef.current;
    let busy = false;

    if (sim.alpha > ALPHA_MIN && sim.nodes.length > 1) {
      busy = true;
      const { nodes, springs } = sim;
      const alpha = sim.alpha;

      // Pairwise charge repulsion (exact O(n²) — fine at MAX_NODES).
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            // Deterministic nudge for coincident points.
            dx = (i - j) * 0.1;
            dy = 0.05 * (i + 1);
            d2 = dx * dx + dy * dy;
          }
          const f = (CHARGE * alpha) / d2;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }

      // Edge springs toward the rest length.
      for (const [a, b] of springs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - LINK_DIST) / d) * LINK_STRENGTH * alpha * 0.5;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }

      // Centre gravity + damped integration (pinned nodes track the pointer).
      for (const n of nodes) {
        const g = (n.isolated ? GRAVITY_ISOLATED : GRAVITY_LINKED) * alpha;
        n.vx -= n.x * g;
        n.vy -= n.y * g;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        if (n.fx != null && n.fy != null) {
          n.x = n.fx;
          n.y = n.fy;
          n.vx = 0;
          n.vy = 0;
        } else {
          n.x += clamp(n.vx, -MAX_STEP, MAX_STEP);
          n.y += clamp(n.vy, -MAX_STEP, MAX_STEP);
        }
      }

      // Collision: positional separation of overlapping discs.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          const minD = a.r + b.r + COLLIDE_PAD;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d >= minD) continue;
          if (d < 0.01) {
            dx = 0.1 * (j - i);
            dy = 0.05;
          }
          const push = (minD - d) / (d || 1) * 0.5;
          const aFree = a.fx == null ? 1 : 0;
          const bFree = b.fx == null ? 1 : 0;
          const total = aFree + bFree || 1;
          a.x -= dx * push * (aFree / total);
          a.y -= dy * push * (aFree / total);
          b.x += dx * push * (bFree / total);
          b.y += dy * push * (bFree / total);
        }
      }

      // Hold the temperature while a drag is live so springs keep responding.
      sim.alpha = draggingNode.current ? Math.max(sim.alpha * ALPHA_DECAY, 0.3) : sim.alpha * ALPHA_DECAY;

      // Follow the settling cloud until the viewer takes over.
      if (!viewRef.current.userAdjusted) {
        const el = containerRef.current;
        if (el) {
          viewRef.current = fitViewFor(sim.nodes, el.clientWidth || 800, el.clientHeight || 500);
          viewTarget.current = null;
        }
      }
    }

    // Smooth-zoom glide toward the pending target.
    const tgt = viewTarget.current;
    if (tgt) {
      const v = viewRef.current;
      const nk = v.k + (tgt.k - v.k) * 0.3;
      const ntx = v.tx + (tgt.tx - v.tx) * 0.3;
      const nty = v.ty + (tgt.ty - v.ty) * 0.3;
      const settled =
        Math.abs(tgt.k - nk) / tgt.k < 0.002 && Math.abs(tgt.tx - ntx) < 0.5 && Math.abs(tgt.ty - nty) < 0.5;
      viewRef.current = settled
        ? { k: tgt.k, tx: tgt.tx, ty: tgt.ty, userAdjusted: v.userAdjusted }
        : { k: nk, tx: ntx, ty: nty, userAdjusted: v.userAdjusted };
      if (settled) viewTarget.current = null;
      else busy = true;
    }

    rerender();
    if (busy) rafRef.current = requestAnimationFrame(step);
  }, [rerender]);

  // Wake the loop (physics reheat and/or view glide).
  const kick = useCallback(
    (alpha = 0) => {
      const sim = simRef.current;
      sim.alpha = Math.max(sim.alpha, alpha);
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
    },
    [step],
  );

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // ── Sync simulation nodes with the notebook (before paint so the first
  // render never sees ids missing from the sim) ──────────────────────────────
  useLayoutEffect(() => {
    const prev = simRef.current.byId;
    const linked = new Set<string>();
    for (const [a, b] of model.edges) {
      linked.add(a);
      linked.add(b);
    }
    let carried = false;
    const nodes = model.capped.map((note, i) => {
      const old = prev.get(note.id);
      if (old) carried = true;
      // Deterministic golden-angle spiral seed for new nodes.
      const angle = i * 2.39996;
      const rad = 26 * Math.sqrt(i + 1);
      return {
        id: note.id,
        x: old ? old.x : Math.cos(angle) * rad,
        y: old ? old.y : Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        isolated: !linked.has(note.id),
        r: 6 + Math.min(7, model.degree.get(note.id) ?? 0),
      } satisfies SimNode;
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    simRef.current = {
      nodes,
      byId,
      springs: model.edges.flatMap(([a, b]): Array<[SimNode, SimNode]> => {
        const na = byId.get(a);
        const nb = byId.get(b);
        return na && nb ? [[na, nb]] : [];
      }),
      alpha: simRef.current.alpha,
    };
    // A completely new node set (scope switch) restarts the follow-fit; a
    // refresh of the same notebook keeps the viewer's transform.
    if (!carried) {
      viewRef.current = { ...viewRef.current, userAdjusted: false };
      viewTarget.current = null;
    }
    if (nodes.length > 0) kick(carried ? 0.3 : 1);
  }, [model, kick]);

  // ── Wheel-zoom toward the cursor, glided (compounds on the pending target
  // so fast scrolls stay smooth) ────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cur = viewTarget.current ?? viewRef.current;
      const k2 = clamp(cur.k * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      if (k2 === cur.k) return;
      viewTarget.current = {
        k: k2,
        tx: mx - (mx - cur.tx) * (k2 / cur.k),
        ty: my - (my - cur.ty) * (k2 / cur.k),
      };
      viewRef.current.userAdjusted = true;
      kick();
    },
    [kick],
  );

  // Button zoom steps toward the container centre (same glide path).
  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      const cur = viewTarget.current ?? viewRef.current;
      const k2 = clamp(cur.k * factor, MIN_ZOOM, MAX_ZOOM);
      if (k2 === cur.k) return;
      viewTarget.current = {
        k: k2,
        tx: cx - (cx - cur.tx) * (k2 / cur.k),
        ty: cy - (cy - cur.ty) * (k2 / cur.k),
      };
      viewRef.current.userAdjusted = true;
      kick();
    },
    [kick],
  );

  const applyFit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const fit = fitViewFor(simRef.current.nodes, el.clientWidth || 800, el.clientHeight || 500);
    viewTarget.current = { k: fit.k, tx: fit.tx, ty: fit.ty };
    // Re-arm follow mode: if the cloud is still settling, keep tracking it.
    viewRef.current.userAdjusted = false;
    kick();
  }, [kick]);

  // ── Pointer gestures: node-drag (pins the node, reheats the sim) / pan /
  // click-select ────────────────────────────────────────────────────────────
  const gesture = useRef<{
    mode: "node" | "pan" | null;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    panMoved: boolean;
  }>({ mode: null, startX: 0, startY: 0, startTx: 0, startTy: 0, panMoved: false });

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const el = containerRef.current;
      if (!el) return;
      const g = gesture.current;
      g.panMoved = false;
      g.startX = e.clientX;
      g.startY = e.clientY;
      const target = e.target as Element;
      const nodeEl = target.closest?.("g[data-note-id]") as Element | null;
      const nodeId = nodeEl?.getAttribute("data-note-id") ?? null;
      const simNode = nodeId ? simRef.current.byId.get(nodeId) ?? null : null;
      if (simNode) {
        g.mode = "node";
        draggingNode.current = simNode;
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
          viewTarget.current = null; // pan cancels any zoom glide
          rerender();
        } else if (draggingNode.current) {
          // Pointer → content coords; pin the node there and keep the
          // simulation warm so its neighbours follow on their springs.
          const rect = el.getBoundingClientRect();
          const view = viewRef.current;
          const node = draggingNode.current;
          node.fx = (ev.clientX - rect.left - view.tx) / view.k;
          node.fy = (ev.clientY - rect.top - view.ty) / view.k;
          view.userAdjusted = true; // stop auto-fit fighting the drag
          kick(0.3);
        }
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        dragCleanupRef.current = null;
      };
      const onUp = () => {
        const clickedId = g.mode === "node" && !g.panMoved ? draggingNode.current?.id ?? null : null;
        if (draggingNode.current) {
          draggingNode.current.fx = null;
          draggingNode.current.fy = null;
          draggingNode.current = null;
        }
        g.mode = null;
        detach();
        if (clickedId) onSelect(clickedId);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      dragCleanupRef.current = detach;
    },
    [onSelect, rerender, kick],
  );

  // Unmount safety net: a drag that outlives the component (tab switch
  // mid-drag) must not leave window-level listeners running sim physics
  // against an unmounted tree.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Double-click on empty canvas re-fits (nodes keep click semantics).
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (target.closest?.("g[data-note-id]")) return;
      applyFit();
    },
    [applyFit],
  );

  // Neighbours of the focused node (hover wins over selection) for highlight.
  const focus = hovered ?? selectedId;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const [a, b] of edges) {
      if (a === focus) set.add(b);
      if (b === focus) set.add(a);
    }
    return set;
  }, [focus, edges]);

  if (capped.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No notes to graph yet.
      </div>
    );
  }

  const dim = (id: string): boolean => neighbours !== null && !neighbours.has(id);

  const sim = simRef.current;
  const view = viewRef.current;
  // Non-focus labels fade in as the viewer zooms past the readability band.
  const labelAlpha = clamp((view.k - LABEL_FADE_LO) / (LABEL_FADE_HI - LABEL_FADE_LO), 0, 1);
  // Screen-constant label size while zoomed out (11px), content-scaled past 1×.
  const labelSize = 11 / Math.min(view.k, 1);

  const ctlBtn =
    "flex size-7 items-center justify-center rounded-md border border-(--surface-divider) bg-card/80 text-muted-foreground backdrop-blur transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {notes.length > MAX_NODES && (
        <div className="shrink-0 border-b border-(--surface-divider) bg-card/60 px-3 py-1 text-[11px] text-muted-foreground">
          Showing {MAX_NODES} most recent of {notes.length} notes.
        </div>
      )}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
      >
        <svg
          className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
          role="img"
          aria-label="Note relationship graph"
        >
          <defs>
            <marker id="notes-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--muted-foreground, #888)" />
            </marker>
          </defs>

          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            {/* edges */}
            {edges.map(([a, b], i) => {
              const pa = sim.byId.get(a);
              const pb = sim.byId.get(b);
              if (!pa || !pb) return null;
              const active = focus !== null && (a === focus || b === focus);
              const faded = neighbours !== null && !active;
              return (
                <line
                  key={i}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke={active ? "var(--primary, #7c3aed)" : "var(--surface-divider, #888)"}
                  strokeWidth={active ? 2 : 1.25}
                  vectorEffect="non-scaling-stroke"
                  markerEnd="url(#notes-arrow)"
                  style={{ opacity: faded ? 0.12 : 0.5, transition: "opacity 150ms" }}
                />
              );
            })}

            {/* nodes */}
            {capped.map((note) => {
              const p = sim.byId.get(note.id);
              if (!p) return null;
              const isSel = note.id === selectedId;
              const isFocus = note.id === focus;
              const faded = dim(note.id);
              // Focus + its neighbours stay readable at any zoom; the rest
              // follow the zoom fade so the fitted overview is a clean cloud.
              const alpha = isFocus ? 1 : neighbours?.has(note.id) ? Math.max(labelAlpha, 0.9) : labelAlpha;
              return (
                <g
                  key={note.id}
                  data-note-id={note.id}
                  transform={`translate(${p.x} ${p.y})`}
                  style={{ cursor: "pointer", opacity: faded ? 0.25 : 1, transition: "opacity 150ms" }}
                  onMouseEnter={() => setHovered(note.id)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <circle
                    r={isFocus ? p.r + 1.5 : p.r}
                    fill={GROUP_FILL[groupOf(note)] ?? GROUP_FILL.open}
                    stroke={isSel ? "var(--foreground, #fff)" : "rgba(0,0,0,0.35)"}
                    strokeWidth={isSel ? 2.5 : 1}
                  />
                  {alpha > 0.02 && (
                    <text
                      y={p.r + labelSize + 3}
                      textAnchor="middle"
                      fontSize={labelSize}
                      fill="var(--foreground, #ddd)"
                      fillOpacity={alpha}
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {isFocus ? `${note.id} — ${truncate(note.title || "", 40)}` : note.id}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* view controls */}
        <div className="absolute bottom-3 right-3 flex flex-col gap-1">
          <button type="button" className={ctlBtn} title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.35)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button type="button" className={ctlBtn} title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.35)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" className={ctlBtn} title="Fit graph" aria-label="Fit graph" onClick={applyFit}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </div>

        {/* gesture hint */}
        <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-muted-foreground/50">
          Scroll to zoom · drag to pan · drag nodes to arrange
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
