// Shared settings primitives. Visual spec: hairline borders (token --border),
// 120ms hover transitions, radius from the derived scale — no one-off values.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-3 divide-y divide-(--surface-divider) rounded-xl border bg-card">{children}</div>
    </section>
  );
}

export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

// Custom listbox-style dropdown replacing the native <select>: its option popup
// is browser/OS-painted and unstyleable, so we render our own floating panel
// (portal + fixed positioning → never clipped by a scrolling settings pane,
// flips above when there's no room below). Same {value, options, onChange} API
// as before, so every call site is unchanged. Keyboard: ↑/↓/Home/End move,
// Enter/Space commit, Esc closes, printable keys type-ahead.

interface SelectOption {
  value: string;
  label: string;
  // Render this option (and the trigger while selected) in the given CSS
  // font-family — the option previews itself, à la the Alma font picker.
  fontFamily?: string;
}

interface MenuPos {
  left: number;
  width: number;
  maxWidth: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const OPTION_ROW_PX = 32;
const MENU_MAX_PX = 280;

export function Select({
  value,
  options,
  onChange,
  disabled = false,
  title,
  className = "",
  searchable = false,
  searchPlaceholder,
  emptyText,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  // Long lists (e.g. every installed font): a filter input pinned at the top
  // of the panel replaces trigger type-ahead.
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [query, setQuery] = useState("");
  const listboxId = useId();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeBuf = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const shown =
    searchable && query.trim()
      ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
      : options;

  const selectedIdx = options.findIndex((o) => o.value === value);
  const currentLabel = options[selectedIdx]?.label ?? "";
  const currentFontFamily = options[selectedIdx]?.fontFamily;

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    const wanted = Math.min(MENU_MAX_PX, options.length * OPTION_ROW_PX + 8);
    const openUp = spaceBelow < wanted && spaceAbove > spaceBelow;
    // Horizontal: left-align the panel to the trigger, but if its natural width
    // (grown via minWidth: max-content) would run past the right viewport edge,
    // slide the whole panel left so it stays fully on-screen — never past the
    // left edge. The panel is measured once it has mounted (see setListRef);
    // before that we fall back to the trigger width.
    const menuW = listRef.current?.offsetWidth ?? r.width;
    const left = Math.max(margin, Math.min(r.left, vw - menuW - margin));
    setPos({
      left,
      width: r.width,
      maxWidth: vw - margin * 2,
      ...(openUp ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: Math.max(120, Math.min(MENU_MAX_PX, (openUp ? spaceAbove : spaceBelow) - 8)),
    });
  }, [options.length]);

  // Callback ref: when the floating panel mounts, re-run positioning so we can
  // measure its real width and shift it on-screen before the browser paints.
  const repositionRef = useRef(reposition);
  repositionRef.current = reposition;
  const setListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) repositionRef.current();
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While open: set the keyboard highlight to the selected row, and keep the
  // menu anchored on scroll/resize. Outside pointer / Escape close it.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
    const onScrollResize = () => reposition();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row scrolled into view as it moves.
  useEffect(() => {
    if (!open || activeIdx < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  function commit(idx: number) {
    const o = shown[idx];
    if (o) onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function typeAhead(ch: string) {
    const now = Date.now();
    const buf = now - typeBuf.current.at > 700 ? ch : typeBuf.current.text + ch;
    typeBuf.current = { text: buf, at: now };
    const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(buf.toLowerCase()));
    if (hit >= 0) setActiveIdx(hit);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Home" && !searchable) {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End" && !searchable) {
      e.preventDefault();
      setActiveIdx(shown.length - 1);
    } else if (e.key === "Enter" || (e.key === " " && !searchable)) {
      e.preventDefault();
      commit(activeIdx);
    } else if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      typeAhead(e.key);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={
          "inline-flex h-7 max-w-[16rem] items-center justify-between gap-1.5 rounded-md border bg-transparent pl-2.5 pr-2 text-[12.5px] text-foreground outline-none transition-colors duration-(--motion-fast) hover:bg-secondary focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-secondary disabled:pointer-events-none disabled:opacity-50 " +
          className
        }
      >
        <span className="truncate" style={currentFontFamily ? { fontFamily: currentFontFamily } : undefined}>
          {currentLabel}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={"shrink-0 text-muted-foreground transition-transform duration-(--motion-fast) " + (open ? "rotate-180" : "")}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={setListRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            style={{
              position: "fixed",
              left: pos.left,
              width: pos.width,
              minWidth: "max-content",
              maxWidth: pos.maxWidth,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
              maxHeight: pos.maxHeight,
            }}
            className="z-50 flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            {searchable && (
              <div className="shrink-0 border-b border-(--surface-divider) p-1">
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  value={query}
                  placeholder={searchPlaceholder}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIdx(0);
                  }}
                  onKeyDown={onKeyDown}
                  className="h-6.5 w-full rounded-md bg-transparent px-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}
            <div className="overflow-y-auto overflow-x-hidden p-1">
              {shown.length === 0 && (
                <div className="px-2.5 py-1.5 text-[12.5px] text-muted-foreground">{emptyText ?? ""}</div>
              )}
              {shown.map((o, i) => {
                const selected = o.value === value;
                const active = i === activeIdx;
                return (
                  <div
                    key={o.value}
                    data-idx={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => commit(i)}
                    className={
                      "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] text-foreground transition-colors duration-(--motion-fast) " +
                      (active ? "bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] " : "") +
                      (selected ? "font-medium " : "")
                    }
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={o.fontFamily ? { fontFamily: o.fontFamily } : undefined}
                    >
                      {o.label}
                    </span>
                    {selected && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-primary"
                        aria-hidden
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={
        "relative h-[18px] w-8 rounded-full transition-colors duration-(--motion-fast) " +
        (checked ? "bg-primary" : "bg-input")
      }
    >
      <span
        className={
          "absolute top-[2px] size-[14px] rounded-full bg-background shadow-sm transition-[left] duration-(--motion-fast) " +
          (checked ? "left-[16px]" : "left-[2px]")
        }
      />
    </button>
  );
}

export function NumberField({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 w-20 rounded-md border bg-transparent px-2 text-right text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function TextField({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="h-7 w-48 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "accent";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "h-7 rounded-md px-3 text-[12.5px] transition-colors duration-(--motion-fast) disabled:pointer-events-none disabled:opacity-40 " +
        (variant === "accent"
          ? "bg-primary text-primary-foreground hover:opacity-90"
          : "border hover:bg-secondary")
      }
    >
      {children}
    </button>
  );
}

export function TextArea({
  value,
  placeholder,
  onChange,
  rows = 12,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-md border bg-transparent p-2 font-mono text-[12px] leading-relaxed outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

// ── Color picker ─────────────────────────────────────────────────────────────
// The native <input type="color"> popup is OS-painted and unstyleable (same
// reason Select replaces <select>), so ColorField opens its own themed popover:
// SV square + hue slider + screen eyedropper, styled with the popover tokens.

interface Hsv {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex(Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255));
}

const PICKER_W = 224;

function ColorPickerPopover({
  anchorRef,
  hex,
  onChange,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  hex: string;
  onChange: (hex: string) => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => {
    const rgb = hexToRgb(hex) ?? { r: 136, g: 136, b: 136 };
    return rgbToHsv(rgb.r, rgb.g, rgb.b);
  });
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const lastEmitted = useRef<string | null>(null);
  // While the OS eyedropper overlay is up, the dismissing click lands outside
  // the panel — don't treat it as an outside-close.
  const eyedropping = useRef(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const currentHex = hsvToHex(hsv);

  // Follow external edits (the hex text field stays live while the popover is
  // open, and Reset swaps in the computed color). Grays carry no hue — keep
  // the slider where it was so the thumb doesn't snap to red.
  useEffect(() => {
    if (hex === lastEmitted.current) return;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    setHsv((prev) => {
      const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
      if (next.s === 0) next.h = prev.h;
      return next;
    });
  }, [hex]);

  const reposition = useCallback(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const panelH = panelRef.current?.offsetHeight ?? 190;
    const openUp = vh - r.bottom < panelH + margin && r.top > vh - r.bottom;
    const left = Math.max(margin, Math.min(r.left, vw - PICKER_W - margin));
    setPos({ left, ...(openUp ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [anchorRef]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  useEffect(() => {
    const onScrollResize = () => reposition();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    const onPointerDown = (e: MouseEvent) => {
      if (eyedropping.current) return;
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [reposition, onClose, anchorRef]);

  function emit(next: Hsv) {
    setHsv(next);
    const out = hsvToHex(next);
    lastEmitted.current = out;
    onChange(out);
  }

  function svFromEvent(e: { clientX: number; clientY: number }) {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    emit({
      ...hsvRef.current,
      s: clamp01((e.clientX - rect.left) / rect.width),
      v: 1 - clamp01((e.clientY - rect.top) / rect.height),
    });
  }

  function hueFromEvent(e: { clientX: number }) {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect) return;
    emit({ ...hsvRef.current, h: clamp01((e.clientX - rect.left) / rect.width) * 360 });
  }

  function dragHandlers(move: (e: { clientX: number; clientY: number }) => void) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.buttons & 1) move(e);
      },
    };
  }

  const EyeDropperCtor = (window as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } })
    .EyeDropper;

  async function pickFromScreen() {
    if (!EyeDropperCtor) return;
    eyedropping.current = true;
    try {
      const res = await new EyeDropperCtor().open();
      const rgb = hexToRgb(res.sRGBHex);
      if (rgb) {
        const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
        if (next.s === 0) next.h = hsvRef.current.h;
        emit(next);
      }
    } catch {
      // eyedropper cancelled
    } finally {
      setTimeout(() => {
        eyedropping.current = false;
      }, 0);
    }
  }

  const thumb =
    "pointer-events-none absolute rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]";

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Color picker"
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        width: PICKER_W,
        ...(pos?.top !== undefined ? { top: pos.top } : {}),
        ...(pos?.bottom !== undefined ? { bottom: pos.bottom } : {}),
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-50 select-none rounded-lg border bg-popover p-2.5 text-popover-foreground shadow-lg"
    >
      <div
        ref={padRef}
        {...dragHandlers(svFromEvent)}
        className="relative h-32 w-full cursor-crosshair touch-none overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)]"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`,
        }}
      >
        <div
          className={thumb + " size-3 -translate-x-1/2 -translate-y-1/2"}
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: currentHex }}
        />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {EyeDropperCtor && (
          <button
            type="button"
            title="Pick color from screen"
            aria-label="Pick color from screen"
            onClick={() => void pickFromScreen()}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m2 22 1-1h3l9-9" />
              <path d="M3 21v-3l9-9" />
              <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.9.9a2.1 2.1 0 1 1-3 3l-6-6a2.1 2.1 0 1 1 3-3l.9.9Z" />
            </svg>
          </button>
        )}
        <div
          ref={hueRef}
          {...dragHandlers(hueFromEvent)}
          className="relative h-3 flex-1 cursor-pointer touch-none rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)]"
          style={{
            background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
          }}
        >
          <div
            className={thumb + " top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2"}
            style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
          />
        </div>
        <span className="size-6 shrink-0 rounded-full border" style={{ backgroundColor: currentHex }} />
      </div>
    </div>,
    document.body,
  );
}

export function ColorField({
  value,
  placeholder,
  computed,
  onChange,
  onReset,
}: {
  value: string;
  placeholder: string;
  /**
   * Effective theme color shown when no custom value is set — drives the
   * picker swatch and the hex placeholder so the field previews the live
   * computed color (parity with legacy syncColorControl). Falls back to
   * `placeholder` for the hex hint and a neutral gray for the picker.
   */
  computed?: string;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const swatch = value || computed || "transparent";
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative size-7 cursor-pointer overflow-hidden rounded-md border outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
        style={{ backgroundColor: swatch }}
      >
        {!value && !computed && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">—</span>
        )}
      </button>
      <input
        type="text"
        value={value}
        placeholder={computed || placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-7 w-24 rounded-md border bg-transparent px-2 font-mono text-[12px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
      />
      {value && (
        <button
          type="button"
          onClick={onReset}
          className="h-7 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
        >
          Reset
        </button>
      )}
      {open && (
        <ColorPickerPopover
          anchorRef={triggerRef}
          hex={value || computed || "#888888"}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
