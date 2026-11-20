import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Lightweight right-click context menu. Call `open(event, items)` from an
 * element's `onContextMenu` handler, and render `element` once in the
 * component's JSX (it is `null` while closed and portals to `document.body`).
 * Closes on outside click, Escape, scroll, or resize.
 */
export function useContextMenu(): {
  open: (event: ReactMouseEvent, items: ContextMenuItem[]) => void;
  element: React.ReactNode;
} {
  const [state, setState] = useState<MenuState | null>(null);

  const open = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    // Clamp to the viewport so the menu never opens off-screen.
    const x = Math.min(event.clientX, window.innerWidth - 192);
    const y = Math.min(event.clientY, window.innerHeight - (items.length * 32 + 16));
    setState({ x: Math.max(8, x), y: Math.max(8, y), items });
  }, []);

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [state, close]);

  const element = state
    ? createPortal(
        <div
          className="fixed inset-0 z-50"
          onMouseDown={close}
          onContextMenu={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <div
            className="absolute min-w-44 overflow-hidden rounded-md border bg-popover py-1 shadow-lg"
            style={{ top: state.y, left: state.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {state.items.map((item, i) => (
              <button
                // Menu items are a fixed, ordered list per open — index key is stable here.
                // biome-ignore lint/suspicious/noArrayIndexKey: static per-open menu
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={
                  "flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition-colors duration-(--motion-fast) hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 " +
                  (item.danger ? "text-destructive" : "text-foreground")
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )
    : null;

  return { open, element };
}
