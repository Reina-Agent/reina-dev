import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui";

export interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  /** Hint the OS keyboard / disallow non-numeric guidance for numeric inputs. */
  numeric?: boolean;
}

type PromptResolve = (value: string | null) => void;

/**
 * Electron's renderer hard-disables `window.prompt()` (it silently returns
 * null), so this hook is an in-app replacement. Call `prompt(opts)` to open a
 * modal and `await` the trimmed input string, or `null` if the user cancels
 * (Cancel button, Escape, or backdrop click). Render `element` once anywhere
 * in the component's JSX — it is `null` while closed and portals to
 * `document.body` so panel `overflow:hidden` / transforms never clip it.
 */
export function usePromptDialog(): {
  prompt: (options?: PromptOptions) => Promise<string | null>;
  element: React.ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PromptOptions>({});
  const [value, setValue] = useState("");
  const resolveRef = useRef<PromptResolve | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback((options: PromptOptions = {}) => {
    setOpts(options);
    setValue(options.defaultValue ?? "");
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: string | null) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  // Focus + select the field once the dialog is mounted.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const element = open
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(null);
          }}
        >
          <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg">
            {opts.title && <div className="mb-1 text-sm font-semibold text-foreground">{opts.title}</div>}
            {opts.message && <div className="mb-3 text-[12.5px] text-muted-foreground">{opts.message}</div>}
            <input
              ref={inputRef}
              type="text"
              inputMode={opts.numeric ? "numeric" : undefined}
              value={value}
              placeholder={opts.placeholder}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  settle(value.trim());
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  settle(null);
                }
              }}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-[13px] text-foreground outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => settle(null)}>Cancel</Button>
              <Button variant="accent" onClick={() => settle(value.trim())}>
                {opts.okLabel ?? "OK"}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { prompt, element };
}
