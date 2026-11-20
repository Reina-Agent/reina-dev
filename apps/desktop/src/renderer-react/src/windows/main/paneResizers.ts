// Pane resizer drag logic — React port of the legacy
// apps/desktop/src/renderer/layout.js (bindHorizontalResizer + restorePaneSizes
// + persistSize). Reproduces the exact behavior: dragging the handle writes a
// CSS variable inline on the `.app` element and persists pixel sizes to
// localStorage under "reina:desktop:pane-sizes", matching the legacy store so
// the legacy CSS grid columns (driven by --session-pane-width /
// --task-pane-width) respond identically.

const RESIZER_STORAGE_KEY = "reina:desktop:pane-sizes";

const DEFAULT_SIZES = {
  session: 280,
  chat: 760,
  workspaceInner: 220,
  task: 300,
} as const;

type StoredSizes = Record<string, number>;

export function restorePaneSizes(app: HTMLElement): void {
  const stored = readStoredSizes();
  applySize(app, "--session-pane-width", stored.session ?? DEFAULT_SIZES.session);
  applySize(app, "--chat-pane-width", stored.chat ?? DEFAULT_SIZES.chat);
  applySize(app, "--workspace-sidebar-width", stored.workspaceInner ?? DEFAULT_SIZES.workspaceInner);
  applySize(app, "--task-pane-width", stored.task ?? DEFAULT_SIZES.task);
}

export interface HorizontalResizerOptions {
  app: HTMLElement;
  handle: HTMLElement | null;
  cssVariable: string;
  storageField: string;
  min: number;
  max: number | (() => number);
  direction: "forward" | "reverse";
}

// Binds a pointerdown-driven horizontal drag to `handle`, writing `cssVariable`
// on `app` and persisting to `storageField`. Returns a cleanup function that
// removes the pointerdown listener (for React effect teardown).
export function bindHorizontalResizer({
  app,
  handle,
  cssVariable,
  storageField,
  min,
  max,
  direction,
}: HorizontalResizerOptions): () => void {
  if (!handle) return () => {};
  const onDown = (event: PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const resolveMax = () => typeof max === "function" ? max() : max;
    // A window may have been narrowed since this size was persisted. Begin from
    // the currently valid range so the first drag responds immediately instead
    // of spending pixels traversing an off-screen stored size.
    const startSize = clamp(readCssPixels(app, cssVariable), min, resolveMax());
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("is-resizing-pane");
    handle.classList.add("active");
    handle.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const signedDelta = direction === "reverse" ? -delta : delta;
      const nextSize = clamp(startSize + signedDelta, min, resolveMax());
      applySize(app, cssVariable, nextSize);
      persistSize(storageField, nextSize);
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("is-resizing-pane");
      handle.classList.remove("active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    // Also end the drag on pointercancel (browser/touch interruption): without
    // it the cursor, the is-resizing-pane body class, and the pointermove
    // listener all leak after an interrupted drag.
    window.addEventListener("pointercancel", onUp, { once: true });
  };

  handle.addEventListener("pointerdown", onDown);
  return () => handle.removeEventListener("pointerdown", onDown);
}

function readCssPixels(app: HTMLElement, cssVariable: string): number {
  const raw = getComputedStyle(app).getPropertyValue(cssVariable).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applySize(app: HTMLElement, cssVariable: string, size: number): void {
  app.style.setProperty(cssVariable, `${Math.round(size)}px`);
}

function persistSize(field: string, value: number): void {
  const stored = readStoredSizes();
  stored[field] = Math.round(value);
  localStorage.setItem(RESIZER_STORAGE_KEY, JSON.stringify(stored));
}

function readStoredSizes(): StoredSizes {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESIZER_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as StoredSizes) : {};
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
