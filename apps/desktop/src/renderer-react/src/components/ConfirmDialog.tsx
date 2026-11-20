import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui";

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

type ConfirmResolve = (value: boolean) => void;

/**
 * In-app replacement for `window.confirm`, styled to match the rest of the
 * settings UI. Call `confirm(opts)` and `await` a boolean; render `element`
 * once in the component's JSX (it portals to `document.body`). Enter confirms,
 * Escape / backdrop / Cancel reject.
 */
export function useConfirmDialog(): {
  confirm: (options?: ConfirmOptions) => Promise<boolean>;
  element: React.ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({});
  const resolveRef = useRef<ConfirmResolve | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions = {}) => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      else if (e.key === "Enter") settle(true);
    };
    window.addEventListener("keydown", onKey);
    const id = requestAnimationFrame(() => confirmBtnRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(id);
    };
  }, [open, settle]);

  const element = open
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg">
            {opts.title && <div className="mb-1 text-sm font-semibold text-foreground">{opts.title}</div>}
            {opts.message && <div className="text-[12.5px] text-muted-foreground">{opts.message}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => settle(false)}>{opts.cancelLabel ?? "Cancel"}</Button>
              <button
                ref={confirmBtnRef}
                type="button"
                onClick={() => settle(true)}
                className={
                  "h-7 rounded-md px-3 text-[12.5px] transition-colors duration-(--motion-fast) hover:opacity-90 " +
                  (opts.danger ? "bg-destructive text-white" : "bg-primary text-primary-foreground")
                }
              >
                {opts.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { confirm, element };
}
