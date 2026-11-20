import type { PointerEvent as ReactPointerEvent } from "react";

// Vertical drag handle for a left-anchored sidebar's right edge. Mirrors the
// chat window's .workspace-inner-resizer (apps/desktop/.../chat-styles/resize.css):
// a thin always-on divider line, an invisible ±5px-wider hit area, and a rounded
// grip pill that is hidden by default and fades + scales in on hover/drag.
// Pass `active` while a drag is in progress to keep the pill shown even after the
// pointer leaves the 1px line. Pair with useResizableSidebar.
export function ResizeHandle({
  onPointerDown,
  ariaLabel,
  active,
}: {
  onPointerDown: (event: ReactPointerEvent) => void;
  ariaLabel: string;
  active?: boolean;
}) {
  // Grip pill: shown (opacity-100 + scaleY-1) when actively dragging, otherwise
  // hidden until hover — exactly the chat ::after :hover/.active behavior.
  const pillState = active
    ? "scale-y-100 opacity-100"
    : "scale-y-[0.86] opacity-0 group-hover:scale-y-100 group-hover:opacity-100";

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      className="group relative z-[5] w-px shrink-0 cursor-col-resize bg-(--surface-divider)"
    >
      {/* widened invisible hit area (chat ::before inset: 0 -5px) */}
      <span className="absolute inset-y-0 -left-[5px] -right-[5px]" />
      {/* grip pill — chat ::after, 3px × 48px */}
      <span
        className={
          "pointer-events-none absolute top-1/2 left-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/70 transition-[opacity,transform] duration-(--motion-fast) " +
          pillState
        }
      />
    </div>
  );
}
