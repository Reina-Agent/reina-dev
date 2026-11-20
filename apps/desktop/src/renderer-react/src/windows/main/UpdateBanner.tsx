import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "~/lib/i18n";
import { useUpdates } from "~/lib/useUpdates";

// Keep the card fully on-screen: shared by the drag handler and the window
// resize re-clamp (a position valid in a maximized window can be entirely
// outside the viewport after un-maximizing).
function clampToViewport(left: number, top: number, width: number, height: number) {
  const m = 8;
  const maxLeft = Math.max(m, window.innerWidth - width - m);
  const maxTop = Math.max(m, window.innerHeight - height - m);
  return {
    left: Math.min(Math.max(m, left), maxLeft),
    top: Math.min(Math.max(m, top), maxTop),
  };
}

// Update progress popup (bottom-right glass card). Shown once an update is
// actually being applied — i.e. downloading (tracks progress) or downloaded
// (turns into a "restart & install" prompt). The "available" state is surfaced
// by the sidebar 更新 badge, not here, so nothing pops up until the user opts in.
export function UpdateBanner() {
  const t = useT();
  const { status, pendingVersion, percent, indeterminate, downloadFailed, download, install } = useUpdates();
  // Dismissals are keyed by version so a newer update re-shows the popup.
  const [dismissed, setDismissed] = useState<string>("");
  // Drag: null = centered (CSS auto-margins); once dragged, explicit left/top.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ px: number; py: number; left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const phase = status.status;
  const downloaded = phase === "downloaded";
  // Only a failed *download* surfaces here; quiet background check errors stay in
  // the settings panel.
  const errored = downloadFailed;
  // Key the dismissal by milestone so closing the progress popup doesn't also
  // suppress the later "ready to restart" / error prompt for the same version.
  const dismissKey = (pendingVersion || "update") + (downloaded ? ":ready" : errored ? ":err" : ":dl");

  // A dismissal lasts only for the current milestone: clear it once the key
  // moves on, or dismissing the first attempt's progress popup would suppress
  // the popup for every retry of the same version (the key comes back around
  // to the identical ":dl" value).
  useEffect(() => {
    setDismissed((d) => (d && d !== dismissKey ? "" : d));
  }, [dismissKey]);

  // The component stays mounted across phases, so a dragged position persists;
  // re-clamp it when the window shrinks or the card is stranded off-screen.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => {
        if (!p) return p;
        const el = cardRef.current;
        const next = clampToViewport(p.left, p.top, el?.offsetWidth ?? 320, el?.offsetHeight ?? 120);
        return next.left === p.left && next.top === p.top ? p : next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only, and never start a drag from an interactive control.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { px: e.clientX, py: e.clientY, left: rect.left, top: rect.top };
    setPos({ left: rect.left, top: rect.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Write the position straight to the element during the drag — a setState
    // per pointermove re-renders the whole card at pointer-event rate. The
    // final position commits to state on release.
    const el = e.currentTarget;
    const next = clampToViewport(
      d.left + (e.clientX - d.px),
      d.top + (e.clientY - d.py),
      el.offsetWidth,
      el.offsetHeight,
    );
    el.style.left = `${next.left}px`;
    el.style.top = `${next.top}px`;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const el = e.currentTarget;
    setPos(clampToViewport(
      d.left + (e.clientX - d.px),
      d.top + (e.clientY - d.py),
      el.offsetWidth,
      el.offsetHeight,
    ));
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone; ignore.
    }
  };

  const show =
    (phase === "downloading" || phase === "downloaded" || errored) && dismissed !== dismissKey;

  if (!show) return null;

  const title = errored
    ? t("updateBanner.titleError")
    : downloaded
      ? t("updateBanner.titleReady")
      : t("updateBanner.titleUpdating");
  const sub = errored
    ? t("updateBanner.errorHint")
    : downloaded
      ? t("updateBanner.readyHint", { version: pendingVersion })
      : t("updateBanner.updatingHint");

  return createPortal(
    <div
      ref={cardRef}
      className={"update-toast" + (pos ? " is-dragged" : "")}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      role="status"
      aria-live="polite"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <button
        type="button"
        className="update-toast-dismiss"
        onClick={() => setDismissed(dismissKey)}
        title={t("updateBanner.dismiss")}
        aria-label={t("updateBanner.dismiss")}
      >
        ✕
      </button>

      <div className="update-toast-head">
        <span className={"update-toast-icon" + (downloaded ? " is-ready" : errored ? " is-error" : "")}>
          {errored ? (
            <svg viewBox="0 0 24 24" aria-hidden focusable={false}>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" x2="12" y1="9" y2="13" />
              <line x1="12" x2="12.01" y1="17" y2="17" />
            </svg>
          ) : downloaded ? (
            <svg viewBox="0 0 24 24" aria-hidden focusable={false}>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden focusable={false}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
          )}
        </span>
        <div className="update-toast-text">
          <div className="update-toast-title">
            {title}
            {pendingVersion ? <span className="update-toast-ver">Reina {pendingVersion}</span> : null}
          </div>
          <div className="update-toast-sub">{sub}</div>
        </div>
      </div>

      {phase === "downloading" && (
        <div className="update-toast-progress">
          <div className="update-toast-bar">
            <div
              className={"update-toast-bar-fill" + (indeterminate ? " is-indeterminate" : "")}
              style={indeterminate ? undefined : { width: `${percent}%` }}
            />
          </div>
          <span className="update-toast-pct">{indeterminate ? "…" : `${percent}%`}</span>
        </div>
      )}

      {downloaded && (
        <button type="button" className="update-toast-action" onClick={install}>
          {t("updateBanner.restart")}
        </button>
      )}

      {errored && (
        <button type="button" className="update-toast-action" onClick={download}>
          {t("updates.retry")}
        </button>
      )}
    </div>,
    document.body,
  );
}
