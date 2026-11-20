import { useLayoutEffect, useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";

// Shared drag-and-drop polish for the reorderable lists (session sidebar rows,
// task-pane cards): an opaque floating drag card instead of Chromium's
// translucent native snapshot, and a FLIP hook that glides keyed children to
// their new slots when the list reorders instead of letting them teleport.

// Chromium (especially on Windows) composites the NATIVE drag image at reduced
// opacity no matter what element setDragImage() is given — a washed-out look.
// To get a fully opaque Claude-Code-style floating card we suppress the native
// image with a blank 1×1 element and move a real DOM clone ourselves from the
// document-level dragover stream (mousemove does not fire during an HTML5
// drag; dragover does, with valid coordinates).

/** Lazily-created, permanently-parked invisible element handed to
 * setDragImage() so the native drag renders nothing. */
let blankDragImage: HTMLElement | null = null;

function getBlankDragImage(): HTMLElement {
  if (!blankDragImage) {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.top = "-10px";
    el.style.left = "-10px";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    blankDragImage = el;
  }
  return blankDragImage;
}

/** Teardown for the in-flight ghost, if any — a new dragstart cleans up a
 * stale one (dragend can be swallowed on some cancelled drags). */
let ghostCleanup: (() => void) | null = null;

/** Replace the translucent native drag snapshot with an opaque "elevated
 * card" clone of the source element — solid panel background, hairline
 * border, rounded corners, floating shadow — held at the pointer's grab
 * offset and driven by document dragover until drop/dragend. */
export function setDragGhost(e: ReactDragEvent, source: HTMLElement): void {
  const dt = e.dataTransfer;
  if (!dt || typeof dt.setDragImage !== "function") return;
  ghostCleanup?.();
  dt.setDragImage(getBlankDragImage(), 0, 0);

  const rect = source.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const offsetY = e.clientY - rect.top;
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.style.position = "fixed";
  ghost.style.left = "0";
  ghost.style.top = "0";
  ghost.style.width = `${Math.round(rect.width)}px`;
  ghost.style.maxHeight = "160px";
  ghost.style.overflow = "hidden";
  ghost.style.boxSizing = "border-box";
  ghost.style.margin = "0";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "10000";
  ghost.style.opacity = "1";
  ghost.style.background = "var(--panel-elevated, #26262b)";
  ghost.style.border = "1px solid var(--line, rgba(255, 255, 255, 0.12))";
  ghost.style.borderRadius = "10px";
  ghost.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3)";
  ghost.style.willChange = "transform";
  ghost.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
  document.body.appendChild(ghost);

  const move = (ev: DragEvent) => {
    // Chromium emits a final (0,0) dragover on some cancelled drags — ignore.
    if (ev.clientX === 0 && ev.clientY === 0) return;
    ghost.style.transform = `translate3d(${ev.clientX - offsetX}px, ${ev.clientY - offsetY}px, 0)`;
  };
  const cleanup = () => {
    ghostCleanup = null;
    ghost.remove();
    document.removeEventListener("dragover", move, true);
    document.removeEventListener("drop", cleanup, true);
    document.removeEventListener("dragend", cleanup, true);
  };
  ghostCleanup = cleanup;
  document.addEventListener("dragover", move, true);
  document.addEventListener("drop", cleanup, true);
  document.addEventListener("dragend", cleanup, true);
}

/** FLIP-animate vertical reorders: after every commit, diff each keyed child's
 * offsetTop against the previous commit and, for rows that moved, play the
 * move as a transform gliding from the old slot to the new one. Relies on the
 * items' stylesheet `transition: transform …` for the release leg.
 * Deliberately NOT gated behind prefers-reduced-motion — it is drop feedback
 * (where did my row land), not decoration. */
export function useListFlip(containerId: string, itemSelector: string, keyAttr: string): void {
  const prevTops = useRef<Map<string, number>>(new Map());
  // No dep array on purpose: tops must be re-diffed after every commit.
  useLayoutEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) {
      prevTops.current = new Map();
      return;
    }
    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    const prev = prevTops.current;
    const next = new Map<string, number>();
    const moved: Array<{ el: HTMLElement; delta: number }> = [];
    for (const el of items) {
      const key = el.getAttribute(keyAttr);
      if (!key) continue;
      const top = el.offsetTop;
      next.set(key, top);
      const before = prev.get(key);
      // Rows new to the list (or a fresh mount) have no old slot to glide from.
      if (before !== undefined && before !== top) moved.push({ el, delta: before - top });
    }
    prevTops.current = next;
    if (prev.size === 0 || moved.length === 0) return;
    // Invert: park every moved row at its old position with the transition off…
    for (const { el, delta } of moved) {
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
    }
    // …commit that start frame in one reflow…
    void container.offsetHeight;
    // …then release to the stylesheet transition, gliding to the new slot.
    for (const { el } of moved) {
      el.style.transition = "";
      el.style.transform = "";
    }
  });
}
