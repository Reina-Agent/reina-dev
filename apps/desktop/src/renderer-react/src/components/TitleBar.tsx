import { useEffect, useState } from "react";
import { bridge } from "~/lib/bridge";

// Frameless-window chrome bar: drag region + min/max/close on Windows/Linux.
// macOS keeps native traffic lights (titleBarStyle: "hidden"), so controls
// render only when the platform reports no native buttons.
const isMac = navigator.platform.toLowerCase().includes("mac");

export function TitleBar({ title, leading }: { title: string; leading?: React.ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  // macOS hides its traffic lights in fullscreen, so drop the left reserve there.
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const api = bridge();
    void api.windowIsMaximized().then(setMaximized).catch(() => undefined);
    void api.windowIsFullScreen().then(setFullscreen).catch(() => undefined);
    return api.events.on("window-state", (payload) => {
      const state = payload as { maximized?: boolean; fullscreen?: boolean } | undefined;
      if (typeof state?.maximized === "boolean") setMaximized(state.maximized);
      if (typeof state?.fullscreen === "boolean") setFullscreen(state.fullscreen);
    });
  }, []);

  return (
    <header
      className={
        "drag-region flex h-9 shrink-0 items-center justify-between select-none " +
        // macOS draws native traffic lights at the top-left (titleBarStyle:
        // "hidden"); reserve that strip (80px, matching topbar.css) so the
        // title/leading don't sit under them — but not in fullscreen, where the
        // lights are hidden and the reserve would be a dead gap.
        (isMac && !fullscreen ? "pl-[80px]" : "pl-2")
      }
    >
      <div className="flex min-w-0 items-center gap-1">
        {leading}
        <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      {!isMac && (
        <div className="flex h-full items-center">
          <WindowButton label="Minimize" onClick={() => void bridge().windowMinimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WindowButton>
          <WindowButton
            label={maximized ? "Restore" : "Maximize"}
            onClick={() => void bridge().windowToggleMaximize()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path
                  d="M2.5 2.5V.5h7v7h-2m-7-5h7v7h-7z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </WindowButton>
          <WindowButton label="Close" close onClick={() => void bridge().windowClose()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WindowButton>
        </div>
      )}
    </header>
  );
}

function WindowButton({
  label,
  close,
  onClick,
  children,
}: {
  label: string;
  close?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={
        "flex h-full w-12 items-center justify-center text-muted-foreground transition-colors duration-(--motion-fast) " +
        (close ? "hover:bg-red-600 hover:text-white" : "hover:bg-secondary hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
