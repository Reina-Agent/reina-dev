import { useEffect, useState } from "react";
import {
  THEME_GALLERY,
  setViewSetting,
  useViewSettings,
  type ThemeGalleryEntry,
} from "~/lib/viewSettings";
import { ColorField, FieldRow, Section } from "~/components/ui";
import { ThemeCard, ThemeGallery } from "~/windows/settings/panels/AppearancePanel";
import { usePromptDialog } from "~/components/PromptDialog";
import { useConfirmDialog } from "~/components/ConfirmDialog";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";

// A saved scheme is a named snapshot of the four color-owning view settings
// (base theme + the three custom overrides). Applying one just writes those
// keys back, so every derived token / window / FOUC mirror behaves exactly as
// if the user had picked them by hand — no parallel theming machinery.
interface SavedScheme {
  id: string;
  name: string;
  theme: string;
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
}

const SCHEME_STORE = { name: "view-settings", key: "customSchemes" };

function parseSchemes(raw: string | null): SavedScheme[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (s): s is SavedScheme =>
        !!s &&
        typeof s === "object" &&
        typeof (s as SavedScheme).id === "string" &&
        typeof (s as SavedScheme).name === "string" &&
        typeof (s as SavedScheme).theme === "string",
    );
  } catch {
    return [];
  }
}

// Resolve a scheme's display colors the same way applyAppearance() does:
// custom override wins, else the base theme's gallery entry supplies it.
function schemeGalleryEntry(scheme: SavedScheme): ThemeGalleryEntry {
  const base = THEME_GALLERY.find((e) => e.id === scheme.theme) ?? THEME_GALLERY[0];
  return {
    id: scheme.id,
    name: scheme.name,
    type: base.type,
    bg: scheme.backgroundColor || base.bg,
    panel: scheme.backgroundColor || base.panel,
    fg: scheme.foregroundColor || base.fg,
    accent: scheme.accentColor || base.accent,
    ...(scheme.backgroundColor ? {} : base.sidebar ? { sidebar: base.sidebar } : {}),
    swatches: base.swatches,
  };
}

// 配色方案 (Color scheme): the theme gallery + the custom-color overrides. Moved
// here out of the Appearance panel so all color/theme controls live together.
export function ThemesPanel() {
  const s = useViewSettings();
  const t = useT();
  const { prompt, element: promptElement } = usePromptDialog();
  const { confirm, element: confirmElement } = useConfirmDialog();
  const [schemes, setSchemes] = useState<SavedScheme[]>([]);

  useEffect(() => {
    void bridge()
      .storeGet(SCHEME_STORE.name, SCHEME_STORE.key)
      .then((raw) => setSchemes(parseSchemes(raw)))
      .catch(() => {});
  }, []);

  async function persistSchemes(next: SavedScheme[]) {
    setSchemes(next);
    try {
      await bridge().storeSet(SCHEME_STORE.name, SCHEME_STORE.key, JSON.stringify(next));
    } catch {
      /* persisting is best-effort; UI state already updated */
    }
  }

  async function handleSaveScheme() {
    const name = (
      await prompt({
        title: t("appearance.schemeName"),
        placeholder: t("appearance.schemeNamePlaceholder"),
        okLabel: t("appearance.saveScheme"),
      })
    )?.trim();
    if (!name) return;
    const scheme: SavedScheme = {
      id: `scheme-${Date.now().toString(36)}`,
      name,
      theme: s.theme,
      accentColor: s.accentColor,
      backgroundColor: s.backgroundColor,
      foregroundColor: s.foregroundColor,
    };
    // Saving under an existing name replaces that scheme (save-as semantics).
    await persistSchemes([...schemes.filter((x) => x.name !== name), scheme]);
  }

  async function applyScheme(scheme: SavedScheme) {
    await setViewSetting("theme", scheme.theme);
    await setViewSetting("accentColor", scheme.accentColor ?? "");
    await setViewSetting("backgroundColor", scheme.backgroundColor ?? "");
    await setViewSetting("foregroundColor", scheme.foregroundColor ?? "");
  }

  async function deleteScheme(scheme: SavedScheme) {
    const ok = await confirm({
      title: t("appearance.deleteScheme"),
      message: t("appearance.deleteSchemeConfirm", { name: scheme.name }),
      confirmLabel: t("appearance.deleteScheme"),
      danger: true,
    });
    if (!ok) return;
    await persistSchemes(schemes.filter((x) => x.id !== scheme.id));
  }

  const schemeActive = (scheme: SavedScheme) =>
    s.theme === scheme.theme &&
    s.accentColor === (scheme.accentColor ?? "") &&
    s.backgroundColor === (scheme.backgroundColor ?? "") &&
    s.foregroundColor === (scheme.foregroundColor ?? "");

  // Computed theme colors — the swatch/placeholder fallback shown when a custom
  // override is empty (same source applyAppearance() writes into the tokens).
  const themeEntry = THEME_GALLERY.find((e) => e.id === s.theme) ?? THEME_GALLERY[0];
  const computedAccent = themeEntry.accent ?? themeEntry.swatches[3];
  const computedBackground = themeEntry.bg;
  const computedForeground = themeEntry.fg;

  return (
    <div className="pane-enter">
      {promptElement}
      {confirmElement}
      {/* User-defined schemes first: quick one-click presets above the stock gallery. */}
      <Section title={t("appearance.mySchemes")} description={t("appearance.mySchemesDesc")}>
        <div className="px-4 py-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">
            {schemes.map((scheme) => (
              <div key={scheme.id} className="group/scheme relative">
                <ThemeCard
                  entry={schemeGalleryEntry(scheme)}
                  selected={schemeActive(scheme)}
                  onSelect={() => void applyScheme(scheme)}
                />
                <button
                  type="button"
                  onClick={() => void deleteScheme(scheme)}
                  aria-label={t("appearance.deleteSchemeAria", { name: scheme.name })}
                  title={t("appearance.deleteScheme")}
                  className="absolute right-1.5 top-1.5 hidden size-5 items-center justify-center rounded-md bg-black/50 text-[12px] leading-none text-white transition-colors duration-(--motion-fast) hover:bg-destructive group-hover/scheme:flex"
                >
                  ×
                </button>
              </div>
            ))}
            {/* Add card — same footprint as a ThemeCard, doubles as the empty state. */}
            <button
              type="button"
              onClick={() => void handleSaveScheme()}
              className="w-full rounded-lg border border-dashed p-1.5 text-left text-muted-foreground transition-colors duration-(--motion-fast) hover:border-(--ring) hover:text-foreground"
            >
              <div className="flex h-16 items-center justify-center rounded-md text-xl font-light">+</div>
              <div className="mt-1.5 px-0.5 text-xs">{t("appearance.saveScheme")}</div>
            </button>
          </div>
        </div>
      </Section>

      <Section title={t("appearance.theme")} description={t("appearance.themeDesc")}>
        <div className="px-4 py-3">
          <ThemeGallery current={s.theme} onSelect={(id) => void setViewSetting("theme", id)} />
        </div>
      </Section>

      <Section title={t("appearance.customColors")} description={t("appearance.customColorsDesc")}>
        <FieldRow label={t("appearance.accent")}>
          <ColorField
            value={s.accentColor}
            placeholder="#rrggbb"
            computed={computedAccent}
            onChange={(hex) => void setViewSetting("accentColor", hex)}
            onReset={() => void setViewSetting("accentColor", "")}
          />
        </FieldRow>
        <FieldRow label={t("appearance.background")}>
          <ColorField
            value={s.backgroundColor}
            placeholder="#rrggbb"
            computed={computedBackground}
            onChange={(hex) => void setViewSetting("backgroundColor", hex)}
            onReset={() => void setViewSetting("backgroundColor", "")}
          />
        </FieldRow>
        <FieldRow label={t("appearance.foreground")}>
          <ColorField
            value={s.foregroundColor}
            placeholder="#rrggbb"
            computed={computedForeground}
            onChange={(hex) => void setViewSetting("foregroundColor", hex)}
            onReset={() => void setViewSetting("foregroundColor", "")}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
