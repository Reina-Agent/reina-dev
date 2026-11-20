import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Drag-to-resize + collapse state for a left-anchored sidebar, persisted to
// localStorage. Mirrors the inline provider-pane resizer in ModelsPanel but
// reusable across the settings nav and the workspace git/files sidebars. The
// drag handle sits on the sidebar's right edge: dragging right widens it.

export interface ResizableSidebarOptions {
  /** localStorage key holding `{ width, collapsed }` for this sidebar. */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  defaultCollapsed?: boolean;
  /** Which edge the panel is anchored to. "left" (default): the handle sits on
   * the panel's RIGHT edge and dragging right widens it. "right": the handle
   * sits on the panel's LEFT edge and dragging LEFT widens it (the delta is
   * inverted). */
  side?: "left" | "right";
}

export interface ResizableSidebar {
  width: number;
  collapsed: boolean;
  /** True while a drag is in progress (mirrors the chat resizer's .active). */
  resizing: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  startResize: (event: ReactPointerEvent) => void;
}

interface Persisted {
  width?: number;
  collapsed?: boolean;
}

function readPersisted(key: string): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Persisted) : {};
  } catch {
    return {};
  }
}

function writePersisted(key: string, patch: Persisted): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readPersisted(key), ...patch }));
  } catch {
    // Width/collapse are non-critical UI prefs — ignore quota/serialize errors.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function useResizableSidebar(opts: ResizableSidebarOptions): ResizableSidebar {
  const { storageKey, defaultWidth, minWidth, maxWidth, defaultCollapsed = false, side = "left" } = opts;

  const [width, setWidth] = useState<number>(() => {
    const w = readPersisted(storageKey).width;
    return typeof w === "number" && w >= minWidth && w <= maxWidth ? w : defaultWidth;
  });
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    const c = readPersisted(storageKey).collapsed;
    return typeof c === "boolean" ? c : defaultCollapsed;
  });
  const [resizing, setResizing] = useState(false);

  // Keep the latest width visible to the pointer-move closure without
  // re-binding the drag listeners every render.
  const widthRef = useRef(width);
  widthRef.current = width;

  // Teardown for an in-flight drag, so unmounting mid-drag (e.g. a workspace
  // tab/cwd switch unmounts the sidebar before pointerup) doesn't leak the
  // window pointermove listener or strand `cursor: col-resize` on <body>.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writePersisted(storageKey, { collapsed: next });
  }, [storageKey]);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      writePersisted(storageKey, { collapsed: next });
      return next;
    });
  }, [storageKey]);

  const startResize = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizing(true);

    let latest = startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      latest = clamp(startWidth + (side === "right" ? -delta : delta), minWidth, maxWidth);
      setWidth(latest);
    };
    // Idempotent: also runs from the unmount cleanup if a drag is in flight.
    const finish = () => {
      if (!endDragRef.current) return;
      endDragRef.current = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      writePersisted(storageKey, { width: Math.round(latest) });
    };
    endDragRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [storageKey, minWidth, maxWidth, side]);

  return { width, collapsed, resizing, setCollapsed, toggleCollapsed, startResize };
}
