import {
  CODE_FONT_LABELS,
  CODE_FONT_STACKS,
  CORNER_RADII,
  DIFF_MODES,
  SPARK_VALUES,
  THEME_GALLERY,
  THEME_PRESETS,
  UI_FONT_LABELS,
  UI_FONT_STACKS,
  setViewSetting,
  useViewSettings,
  type ThemeGalleryEntry,
} from "~/lib/viewSettings";
import { FieldRow, NumberField, Section, Select, Toggle } from "~/components/ui";
import { useT } from "~/lib/i18n";
import { BUNDLED_FONT_FAMILIES, listSystemFonts } from "~/lib/systemFonts";
import { useEffect, useState } from "react";

// Fixed entries are Default plus only the fonts we ship — those render on
// every machine. Everything else comes from the live system enumeration
// (installed fonts only), so nothing offered can be missing; each option
// previews itself via `fontFamily` (Alma-style), no availability labels.
// Legacy preset keys stay resolvable in the stacks but are not offered; a
// persisted value outside the list (hidden legacy preset, uninstalled custom
// family) is appended so the trigger still shows it.
function fontOptions(
  stacks: Record<string, string>,
  labels: Record<string, string>,
  defaultLabel: string,
  systemFonts: string[],
  current: string,
): { value: string; label: string; fontFamily?: string }[] {
  const bundled = new Set(BUNDLED_FONT_FAMILIES.map((f) => f.toLowerCase()));
  const label = (k: string) => (k === "default" ? defaultLabel : (labels[k] ?? k));
  const presets = Object.keys(stacks)
    .filter((k) => k === "default" || bundled.has((labels[k] ?? k).toLowerCase()))
    .map((k) => ({ value: k, label: label(k), fontFamily: stacks[k] }));
  const taken = new Set(presets.map((o) => o.label.toLowerCase()));
  const system = systemFonts
    .filter((f) => !taken.has(f.toLowerCase()))
    .map((f) => ({ value: f, label: f, fontFamily: `"${f}"` }));
  const all = [...presets, ...system];
  if (current && !all.some((o) => o.value === current)) {
    all.push(
      Object.hasOwn(stacks, current)
        ? { value: current, label: label(current), fontFamily: stacks[current] }
        : { value: current, label: current, fontFamily: `"${current}"` },
    );
  }
  return all;
}

export function AppearancePanel() {
  const s = useViewSettings();
  const t = useT();
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    // queryLocalFonts fails on an unfocused frame (e.g. panel mounted while
    // the window is in the background) — retry whenever the window regains
    // focus until an enumeration succeeds; afterwards it's a cache hit.
    let alive = true;
    const load = () =>
      void listSystemFonts().then((fonts) => {
        if (alive && fonts.length) setSystemFonts(fonts);
      });
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, []);

  return (
    <div className="pane-enter">
      <Section title={t("appearance.style")}>
        <FieldRow label={t("appearance.preset")} hint={t("appearance.presetDesc")}>
          <Select
            value={s.themePreset}
            options={THEME_PRESETS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => void setViewSetting("themePreset", v as typeof s.themePreset)}
          />
        </FieldRow>
        <FieldRow label={t("appearance.cornerRadius")}>
          <Select
            value={s.cornerRadius}
            options={CORNER_RADII.map((r) => ({ value: r, label: r }))}
            onChange={(v) => void setViewSetting("cornerRadius", v as typeof s.cornerRadius)}
          />
        </FieldRow>
        <FieldRow label={t("appearance.chatSpark")}>
          <SparkSwatches
            value={s.chatSpark}
            accent={s.accentColor || THEME_GALLERY.find((e) => e.id === s.theme)?.accent || "var(--accent)"}
            onChange={(v) => void setViewSetting("chatSpark", v as typeof s.chatSpark)}
          />
        </FieldRow>
        <FieldRow label={t("appearance.glass")} hint={t("appearance.glassDesc")}>
          <Toggle checked={s.glass} onChange={(v) => void setViewSetting("glass", v)} />
        </FieldRow>
        <FieldRow label={t("appearance.sidebar")} hint={t("appearance.sidebarDesc")}>
          <Select
            value={s.sidebarPlacement}
            options={[
              { value: "floating", label: t("appearance.sidebarFloating") },
              { value: "inline", label: t("appearance.sidebarInline") },
            ]}
            onChange={(v) => void setViewSetting("sidebarPlacement", v as typeof s.sidebarPlacement)}
          />
        </FieldRow>
        <FieldRow label={t("appearance.workspace")} hint={t("appearance.workspaceDesc")}>
          <Select
            value={s.workspacePlacement}
            options={[
              { value: "inline", label: t("appearance.workspaceInline") },
              { value: "floating", label: t("appearance.workspaceFloating") },
            ]}
            onChange={(v) => void setViewSetting("workspacePlacement", v as typeof s.workspacePlacement)}
          />
        </FieldRow>
        <FieldRow label={t("appearance.diffMode")} hint={t("appearance.diffModeDesc")}>
          <Select
            value={s.diffMode}
            options={DIFF_MODES.map((m) => ({
              value: m,
              label: m === "split" ? t("appearance.diffSplit") : t("appearance.diffUnified"),
            }))}
            onChange={(v) => void setViewSetting("diffMode", v as typeof s.diffMode)}
          />
        </FieldRow>
      </Section>

      <Section title={t("appearance.fonts")}>
        <FieldRow label={t("appearance.uiFont")}>
          <Select
            value={s.uiFont}
            options={fontOptions(UI_FONT_STACKS, UI_FONT_LABELS, t("appearance.fontDefault"), systemFonts, s.uiFont)}
            onChange={(v) => void setViewSetting("uiFont", v)}
            searchable
            searchPlaceholder={t("appearance.searchFonts")}
            emptyText={t("appearance.noFontsFound")}
          />
        </FieldRow>
        <FieldRow label={t("appearance.uiFontSize")}>
          <NumberField value={s.fontSize} min={10} max={18} step={0.5} onChange={(v) => void setViewSetting("fontSize", v)} />
        </FieldRow>
        <FieldRow label={t("appearance.codeFont")}>
          <Select
            value={s.codeFont}
            options={fontOptions(CODE_FONT_STACKS, CODE_FONT_LABELS, t("appearance.fontDefault"), systemFonts, s.codeFont)}
            onChange={(v) => void setViewSetting("codeFont", v)}
            searchable
            searchPlaceholder={t("appearance.searchFonts")}
            emptyText={t("appearance.noFontsFound")}
          />
        </FieldRow>
        <FieldRow label={t("appearance.codeFontSize")}>
          <NumberField value={s.codeFontSize} min={10} max={18} step={0.5} onChange={(v) => void setViewSetting("codeFontSize", v)} />
        </FieldRow>
      </Section>
    </div>
  );
}

// Sent-bubble color schemes — shown as clickable swatches (not a dropdown) so
// the color itself is the affordance. Representative (dark-theme) hex per
// SPARK_VALUES; "mono" tracks the CHAT window's accent, which the caller must
// resolve (theme accent / custom accentColor) — the settings window's own
// var(--accent) is a different token and previews the wrong color. Source:
// legacy chat.css `:root[data-sent-bubble="…"] { --sent-bubble-color }`.
const SPARK_COLORS: Record<string, string> = {
  sky: "#4f7fd1",
  ocean: "#356b8f",
  slate: "#475569",
  steel: "#5b6472",
  graphite: "#242424",
};

function SparkSwatches({ value, accent, onChange }: { value: string; accent: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      {SPARK_VALUES.map((spark) => {
        const selected = spark === value;
        return (
          <button
            key={spark}
            type="button"
            title={spark}
            aria-label={spark}
            aria-pressed={selected}
            onClick={() => onChange(spark)}
            className={
              "relative size-6 rounded-full border border-black/15 outline-none transition-transform duration-(--motion-fast) hover:scale-110 focus-visible:scale-110 " +
              (selected ? "shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--ring)]" : "")
            }
            style={{ background: SPARK_COLORS[spark] ?? accent }}
          >
            {selected && (
              <svg
                viewBox="0 0 24 24"
                className="absolute inset-0 m-auto size-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function ThemeGallery({ current, onSelect }: { current: string; onSelect: (id: string) => void }) {
  const t = useT();
  const groups: { key: "dark" | "light"; label: string }[] = [
    { key: "dark", label: t("appearance.groupDark") },
    { key: "light", label: t("appearance.groupLight") },
  ];
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.key}>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{group.label}</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">
            {THEME_GALLERY.filter((t) => t.type === group.key).map((entry) => (
              <ThemeCard key={entry.id} entry={entry} selected={entry.id === current} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// A mini mock of the real UI in this theme: sidebar (panel) + main (bg) + an
// accent element, drawn in the theme's own colors (ported from the legacy
// theme gallery). Also reused by ThemesPanel for saved custom schemes.
export function ThemeCard({
  entry,
  selected,
  onSelect,
}: {
  entry: ThemeGalleryEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const accent = entry.accent ?? entry.swatches[3];
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-pressed={selected}
      className={
        "group w-full rounded-lg border p-1.5 text-left transition-[border-color,box-shadow] duration-(--motion-fast) " +
        (selected ? "border-ring shadow-[0_0_0_1px_var(--ring)]" : "hover:border-(--ring)")
      }
    >
      <div
        className="flex h-16 gap-1 overflow-hidden rounded-md border border-black/10 p-1"
        style={{ background: entry.bg, color: entry.fg }}
      >
        <div className="flex w-1/3 flex-col gap-1 rounded-sm p-1" style={{ background: entry.sidebar ?? entry.panel }}>
          <span className="h-1 rounded-full opacity-90" style={{ background: accent }} />
          <span className="h-1 rounded-full bg-current opacity-20" />
          <span className="h-1 rounded-full bg-current opacity-20" />
        </div>
        <div className="flex flex-1 flex-col gap-1 p-1">
          <span className="h-1 w-4/5 rounded-full bg-current opacity-30" />
          <span className="h-1 w-3/5 rounded-full bg-current opacity-30" />
          <span className="mt-auto h-2 w-7 rounded-full" style={{ background: accent }} />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between px-0.5">
        <span className="text-xs">{entry.name}</span>
        {selected && <span className="text-xs text-success-foreground">✓</span>}
      </div>
    </button>
  );
}
