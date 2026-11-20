// imageLightbox.ts — faithful TS port of the legacy renderer's
// openImageLightbox (conversation.js). Full-window image viewer:
// scroll-to-zoom (anchored under the cursor), drag-to-pan when zoomed, rotate,
// a floating toolbar, keyboard shortcuts (+/- zoom, 0 reset, R rotate, Esc
// close) and backdrop-click to close.
//
// Kept imperative (builds DOM, appends to <body>) exactly like the legacy
// implementation: the overlay is a transient, self-contained modal whose pan/
// zoom math touches the DOM every frame — routing it through React state would
// add a re-render per wheel tick for no benefit. The `.image-lightbox*` CSS is
// already ported in chat-styles/chat.css. This REPLACES the React port's earlier
// `window.open` stopgap, which spawned a bare native window (menu bar + chrome)
// instead of an in-app lightbox.

import { icon } from "./icons";

// Teardown for the currently-open lightbox, if any. Each open() installs a fresh
// document-level keydown listener via a new closure, so a later open() can't
// remove the previous one by reference — we must run the prior teardown
// explicitly or it leaks a duplicate global key handler until Esc.
let activeTeardown: (() => void) | null = null;

export function openImageLightbox(src: string, alt?: string): void {
  if (!src) return;
  activeTeardown?.();
  document.getElementById("image-lightbox")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "image-lightbox";
  overlay.className = "image-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const img = document.createElement("img");
  img.className = "image-lightbox-image";
  img.src = src;
  img.alt = alt || "image";
  img.draggable = false;
  overlay.appendChild(img);

  const toolbar = document.createElement("div");
  toolbar.className = "image-lightbox-toolbar";
  toolbar.innerHTML = `
    <button class="image-lightbox-tool" type="button" data-act="zoom-out" title="缩小 (-)">${icon("minus")}</button>
    <span class="image-lightbox-zoom" title="点击复位 (0)">100%</span>
    <button class="image-lightbox-tool" type="button" data-act="zoom-in" title="放大 (+)">${icon("plus")}</button>
    <span class="image-lightbox-sep"></span>
    <button class="image-lightbox-tool" type="button" data-act="rotate-ccw" title="向左旋转">${icon("rotate-ccw")}</button>
    <button class="image-lightbox-tool" type="button" data-act="rotate-cw" title="向右旋转 (R)">${icon("rotate-cw")}</button>
    <span class="image-lightbox-sep"></span>
    <button class="image-lightbox-tool" type="button" data-act="close" title="关闭 (Esc)">${icon("x")}</button>
  `;
  overlay.appendChild(toolbar);
  const zoomLabel = toolbar.querySelector<HTMLSpanElement>(".image-lightbox-zoom")!;

  const MIN = 0.1;
  const MAX = 8;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let rotation = 0;
  const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));
  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${scale})`;
    img.classList.toggle("is-zoomed", scale > 1);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    rotation = 0;
    apply();
  };
  // Center-anchored zoom for buttons/keyboard (origin is the center, so tx/ty
  // stay put). The wheel handler re-anchors under the cursor instead.
  const zoomBy = (factor: number) => {
    const next = clamp(scale * factor);
    if (next === scale) return;
    scale = next;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    apply();
  };

  // Zoom toward the cursor: keep the image point under the pointer fixed as the
  // scale changes (origin is the image's center, so anchor math is in
  // center-relative coordinates — independent of rotation).
  overlay.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const ox = event.clientX - (rect.left + rect.width / 2) - tx;
      const oy = event.clientY - (rect.top + rect.height / 2) - ty;
      const next = clamp(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (next === scale) return;
      tx -= (ox / scale) * (next - scale);
      ty -= (oy / scale) * (next - scale);
      scale = next;
      if (scale === 1) {
        tx = 0;
        ty = 0;
      }
      apply();
    },
    { passive: false },
  );

  let dragging = false;
  let startX = 0;
  let startY = 0;
  img.addEventListener("pointerdown", (event) => {
    if (scale <= 1) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX - tx;
    startY = event.clientY - ty;
    img.setPointerCapture(event.pointerId);
  });
  img.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    tx = event.clientX - startX;
    ty = event.clientY - startY;
    apply();
  });
  const endDrag = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      img.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);
  img.addEventListener("dblclick", () => {
    if (scale === 1) {
      scale = 2;
      apply();
    } else {
      reset();
    }
  });

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (activeTeardown === close) activeTeardown = null;
  };
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") close();
    else if (event.key === "+" || event.key === "=") zoomBy(1.25);
    else if (event.key === "-" || event.key === "_") zoomBy(0.8);
    else if (event.key === "0") reset();
    else if (event.key === "r" || event.key === "R") {
      rotation += 90;
      apply();
    }
  }

  toolbar.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    if (act === "zoom-in") zoomBy(1.25);
    else if (act === "zoom-out") zoomBy(0.8);
    else if (act === "rotate-cw") {
      rotation += 90;
      apply();
    } else if (act === "rotate-ccw") {
      rotation -= 90;
      apply();
    } else if (act === "close") close();
  });
  zoomLabel.addEventListener("click", reset);
  // Backdrop click closes; clicks on the image or toolbar do not.
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);
  activeTeardown = close;
  document.body.appendChild(overlay);
  apply();
}
