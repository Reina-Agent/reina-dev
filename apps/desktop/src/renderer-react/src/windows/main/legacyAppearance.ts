// Faithful port of the legacy chat renderer's appearance application
// (apps/desktop/src/renderer/actions/local-settings.js applyAppearance +
// applyCustomColors). The chat React window reuses the legacy CSS verbatim, so
// it MUST drive the same <html> attributes/custom-props the legacy CSS keys
// off: data-theme, data-style, data-radius, data-sent-bubble, --accent/--bg/
// --text families, --font-ui/--font-code, --ui-font-size, glass-on. Keep this
// in lockstep with the legacy module — same keys, same values.
import { bridge } from "~/lib/bridge";
import { BASE46_CHAT_VAR_NAMES, base46ChatVars, getBase46Theme, isBase46ThemeId } from "~/lib/base46";
import { sanitizeFontFamily } from "~/lib/systemFonts";
import { syncViewLanguage } from "~/lib/viewSettings";

const STORE = "view-settings";

const THEME_PRESETS = ["codex", "heroui", "shadcn", "github", "vercel", "apple", "tokyo"];
const CORNER_RADII = ["small", "medium", "large", "full"];
const SPARK_VALUES = ["sky", "ocean", "slate", "steel", "graphite", "mono"];

const UI_FONT_STACKS: Record<string, string> = {
  default:
    '"Microsoft YaHei UI", "Segoe UI Variable", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  anthropic:
    '"Anthropic Sans", "Anthropic Sans Text", "Reina Sans", "Inter", "Microsoft YaHei UI", "PingFang SC", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  reina: '"Reina Sans", "Inter", "Microsoft YaHei UI", "PingFang SC", ui-sans-serif, system-ui, sans-serif',
  familjen: '"Familjen Grotesk", "Inter", "Microsoft YaHei UI", "PingFang SC", ui-sans-serif, system-ui, sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  segoe: '"Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif',
  inter: '"Inter", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  arial: "Arial, Helvetica, sans-serif",
};

const CODE_FONT_STACKS: Record<string, string> = {
  default: '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, ui-monospace, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
  sfmono: '"SFMono-Regular", "SF Mono", "Source Code Pro", Menlo, Monaco, Consolas, ui-monospace, monospace',
  consolas: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  fira: '"Fira Code", "Cascadia Code", Consolas, ui-monospace, monospace',
  sourceCode: '"Source Code Pro", "Cascadia Code", Consolas, ui-monospace, monospace',
};

// Theme gallery ids (the dark/light palettes the gallery offers). Used only to
// validate a persisted theme id; the actual colors live in themes.css.
const THEME_IDS = ["dark", "onyx", "midnight", "mono", "graphite", "carbon", "light", "porcelain", "snow", "silver"];

// Built-in themes' background colors — needed in JS (themes.css owns the vars)
// so a custom accent can be contrast-checked against the theme it lands on.
// Keep in lockstep with viewSettings.ts THEME_GALLERY bg values.
const THEME_BGS: Record<string, string> = {
  dark: "#060607",
  onyx: "#050506",
  midnight: "#050711",
  mono: "#111113",
  graphite: "#211e1b",
  carbon: "#07090d",
  light: "#f7f7f8",
  porcelain: "#f1f3f6",
  snow: "#ffffff",
  silver: "#e6e8eb",
};

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const FONT_MIN = 10;
const FONT_MAX = 18;

interface Appearance {
  theme: string;
  themePreset: string;
  cornerRadius: string;
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  chatSpark: string;
  glass: boolean;
  uiFont: string;
  codeFont: string;
  fontSize: number;
  codeFontSize: number;
}

const DEFAULTS: Appearance = {
  theme: "yoru",
  themePreset: "codex",
  cornerRadius: "medium",
  // Keep in lockstep with viewSettings.ts DEFAULTS — white accent on yoru.
  accentColor: "#ffffff",
  backgroundColor: "",
  foregroundColor: "",
  chatSpark: "graphite",
  glass: false,
  uiFont: "anthropic",
  codeFont: "default",
  fontSize: 13.5,
  codeFontSize: 13.5,
};

let current: Appearance = { ...DEFAULTS };

// Preset stack key, or a raw system font family picked from queryLocalFonts —
// custom families lead the default stack so missing glyphs still resolve.
// Keep in lockstep with viewSettings.ts uiFontStack/codeFontStack.
function resolveFontStack(value: string, stacks: Record<string, string>): string {
  if (Object.hasOwn(stacks, value)) return stacks[value];
  const family = sanitizeFontFamily(value);
  return family ? `"${family}", ${stacks.default}` : stacks.default;
}

function clampFont(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n * 2) / 2));
}

function normalizeAccentColor(value: unknown): string {
  const next = String(value ?? "").trim();
  const hex = next.startsWith("#") ? next : `#${next}`;
  return HEX_COLOR_RE.test(hex) ? hex.toLowerCase() : "";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const value = normalizeAccentColor(hex).slice(1);
  if (!value) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(from: string, to: string, weight: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  if (!a || !b) return from;
  return rgbToHex({ r: a.r + (b.r - a.r) * weight, g: a.g + (b.g - a.g) * weight, b: a.b + (b.b - a.b) * weight });
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// Auto-adjust a custom accent to the background it lands on (依据背景自动调整):
// an accent whose contrast against the bg is under ~2:1 (e.g. the default
// white accent on a light theme) flips toward the opposite pole, keeping 15%
// of the original tint. Legible accents pass through untouched, so this only
// fires in the would-be-invisible cases.
function adaptAccentToBg(accent: string, bg: string): string {
  const a = hexToRgb(accent);
  const b = hexToRgb(bg);
  if (!a || !b) return accent;
  const la = luminance(a);
  const lb = luminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  if (ratio >= 2) return accent;
  return mixHex(accent, lb > 0.45 ? "#111111" : "#ffffff", 0.85);
}

// Custom color overrides write into the same vars map the base46 injection
// fills, so they always win over a base46 theme and never leave stale inline
// values behind: applyAppearance() sets/clears the whole managed set in one
// pass afterwards. `themeBg` is the active theme's background — the reference
// a custom accent is contrast-checked against (custom background wins).
function overlayCustomColors(vars: Record<string, string>, themeBg: string): void {
  const background = normalizeAccentColor(current.backgroundColor);
  const foreground = normalizeAccentColor(current.foregroundColor);
  const rawAccent = normalizeAccentColor(current.accentColor);
  const accent = rawAccent ? adaptAccentToBg(rawAccent, background || themeBg) : "";

  if (accent) {
    const rgb = hexToRgb(accent);
    if (rgb) {
      const contrast = luminance(rgb) > 0.45 ? "#111111" : "#ffffff";
      const hoverTarget = contrast === "#ffffff" ? "#ffffff" : "#000000";
      vars["--accent"] = accent;
      vars["--accent-hover"] = mixHex(accent, hoverTarget, 0.16);
      vars["--accent-contrast"] = contrast;
      vars["--accent-soft"] = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`;
    }
  }

  if (background) {
    const bgRgb = hexToRgb(background);
    const lift = bgRgb && luminance(bgRgb) > 0.5 ? "#000000" : "#ffffff";
    vars["--bg"] = background;
    vars["--panel"] = `color-mix(in srgb, ${background} 94%, ${lift})`;
    vars["--panel-soft"] = `color-mix(in srgb, ${background} 88%, ${lift})`;
    vars["--panel-elevated"] = `color-mix(in srgb, ${background} 80%, ${lift})`;
    vars["--composer-bg"] = background;
    vars["--composer-bg-focus"] = `color-mix(in srgb, ${background} 88%, ${lift})`;
  }

  if (foreground) {
    vars["--text"] = `color-mix(in srgb, ${foreground} 86%, var(--bg))`;
    vars["--text-strong"] = foreground;
    vars["--text-muted"] = `color-mix(in srgb, ${foreground} 62%, var(--bg))`;
    vars["--text-faint"] = `color-mix(in srgb, ${foreground} 44%, var(--bg))`;
    vars["--line"] = `color-mix(in srgb, ${foreground} 12%, transparent)`;
    vars["--line-soft"] = `color-mix(in srgb, ${foreground} 7%, transparent)`;
    vars["--line-strong"] = `color-mix(in srgb, ${foreground} 22%, transparent)`;
  }
}

export function applyAppearance(): void {
  const root = document.documentElement;
  const theme =
    THEME_IDS.includes(current.theme) || isBase46ThemeId(current.theme) ? current.theme : DEFAULTS.theme;
  const preset = THEME_PRESETS.includes(current.themePreset) ? current.themePreset : DEFAULTS.themePreset;
  root.dataset.theme = theme;
  root.dataset.sentBubble = SPARK_VALUES.includes(current.chatSpark) ? current.chatSpark : DEFAULTS.chatSpark;
  delete root.dataset.chatSpark;
  if (preset === "codex") delete root.dataset.style;
  else root.dataset.style = preset;
  const radius = CORNER_RADII.includes(current.cornerRadius) ? current.cornerRadius : DEFAULTS.cornerRadius;
  if (radius === DEFAULTS.cornerRadius) delete root.dataset.radius;
  else root.dataset.radius = radius;

  // Theme colors, one pass: base46 themes inject their full token set inline
  // (built-ins have static CSS blocks instead → empty map), then custom color
  // overrides shadow whatever they own. Everything in the managed set that
  // ends up unset is cleared so stylesheet themes shine through again.
  const b46 = getBase46Theme(theme);
  const vars: Record<string, string> = b46 ? base46ChatVars(b46) : {};
  // Glass mode owns the sidebar surface (glass.css redefines --main-surface-1
  // to the acrylic tint); drop the chrome hint so the fallback chain decides.
  if (current.glass) delete vars["--sidebar-chrome"];
  overlayCustomColors(vars, vars["--bg"] ?? THEME_BGS[theme] ?? "");
  for (const name of BASE46_CHAT_VAR_NAMES) {
    const value = vars[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  const ui = clampFont(current.fontSize, DEFAULTS.fontSize);
  const code = clampFont(current.codeFontSize, DEFAULTS.codeFontSize);
  root.style.setProperty("--font-ui", resolveFontStack(current.uiFont, UI_FONT_STACKS));
  root.style.setProperty("--font-code", resolveFontStack(current.codeFont, CODE_FONT_STACKS));
  root.style.setProperty("--ui-font-size", `${ui}px`);
  root.style.setProperty("--code-font-size", `${code}px`);
  root.classList.toggle("glass-on", !!current.glass);
  mirrorAppearance(root);
}

// FOUC guard (learned from Alma): the real settings arrive over async IPC, so
// mirror the final applied appearance into localStorage. main.html's head
// script replays it synchronously before first paint — no default-theme flash
// on launch. Stale mirrors self-correct: loadAppearance() re-applies (and
// re-mirrors) as soon as the store answers.
const MIRROR_KEY = "reina:appearance-mirror:chat";

function mirrorAppearance(root: HTMLElement): void {
  try {
    const attrs: Record<string, string> = {};
    for (const name of ["data-theme", "data-style", "data-radius", "data-sent-bubble"]) {
      const v = root.getAttribute(name);
      if (v !== null) attrs[name] = v;
    }
    localStorage.setItem(
      MIRROR_KEY,
      JSON.stringify({
        attrs,
        style: root.getAttribute("style") ?? "",
        classes: { "glass-on": !!current.glass },
      }),
    );
  } catch {
    /* localStorage unavailable (private mode / quota) — boot replay just skips */
  }
}

function coerce(key: keyof Appearance, raw: unknown): Appearance[keyof Appearance] {
  switch (key) {
    case "glass":
      return raw === "true" || raw === "1" || raw === true;
    case "fontSize":
    case "codeFontSize":
      return clampFont(raw, DEFAULTS[key]);
    case "accentColor":
    case "backgroundColor":
    case "foregroundColor":
      return normalizeAccentColor(raw);
    default:
      return String(raw ?? DEFAULTS[key]);
  }
}

export async function loadAppearance(): Promise<void> {
  const api = bridge();
  const next = { ...DEFAULTS };
  const values = await api.storeGetAll(STORE).catch(() => ({} as Record<string, string>));
  syncViewLanguage(values.language);
  for (const key of Object.keys(DEFAULTS) as (keyof Appearance)[]) {
    const raw = values[key];
    if (raw !== null && raw !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = coerce(key, raw);
    }
  }
  current = next;
  applyAppearance();
}

// Live cross-window updates (settings window changing theme/font/glass).
export function subscribeAppearance(): () => void {
  return bridge().events.on("view-settings-changed", (payload) => {
    const { key, value } = (payload ?? {}) as { key?: keyof Appearance | "language"; value?: unknown };
    if (key === "language") { syncViewLanguage(value); return; }
    if (!key || !(key in DEFAULTS)) return;
    (current as unknown as Record<string, unknown>)[key] = coerce(key, value);
    applyAppearance();
  });
}
