// base46 → Reina token mapping (approach learned from Alma / NvChad base46).
// A base46 theme ships two palettes: base_30 (30 UI colors) and base_16 (16
// syntax colors). Themes only provide colors; the ROLE each color plays (which
// one is the canvas, which is the card, which is the accent) is decided here,
// once, so themes keep a consistent surface hierarchy unless a palette's
// established identity deliberately needs its original composition (Yoru).
// Values are injected as inline custom properties on <html> by
// legacyAppearance (chat window); the settings/workspace windows only take
// the bg/panel/fg/accent summary through the theme gallery.
import { BASE46_THEMES, type Base46Theme } from "./base46-data";

// Curated, representative subset actually offered in the gallery (user
// request: keep the list short). base46-data.ts keeps all 70 palettes — to
// ship another one, add its name here, in display order.
const CURATED_ORDER = [
  "yoru",
  "vscode_dark",
  "onedark",
  "catppuccin",
  "tokyonight",
  "gruvbox",
  "nord",
  "rosepine",
  "one_light",
  "github_light",
  "rosepine-dawn",
];

const CURATED_THEMES: Base46Theme[] = CURATED_ORDER
  .map((name) => BASE46_THEMES.find((t) => t.name === name))
  .filter((t): t is Base46Theme => !!t);

const byName = new Map(CURATED_THEMES.map((t) => [t.name, t]));

export function getBase46Theme(id: string): Base46Theme | null {
  return byName.get(id) ?? null;
}

export function isBase46ThemeId(id: unknown): boolean {
  return typeof id === "string" && byName.has(id);
}

// ── color math (hex in, hex out — deterministic values keep the FOUC mirror
//    and DOM inspection readable, no nested color-mix strings) ──────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function mix(from: string, to: string, weight: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * weight)
    .toString(16)
    .padStart(2, "0");
  return `#${ch(a.r, b.r)}${ch(a.g, b.g)}${ch(a.b, b.b)}`;
}

function alpha(hex: string, fraction: number): string {
  return `${hex}${Math.round(fraction * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrastRatio(left: string, right: string): number {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

function contrastText(background: string): string {
  const dark = "#09090b";
  const light = "#ffffff";
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

// Syntax colours for the chat code blocks (consumed by the shiki
// css-variables theme, see windows/main/shikiHighlighter.ts). Same role
// assignment as Alma's base_16 → --syntax-* bridge. base03 is nominally the
// base16 "comments" slot, but some palettes (yoru!) fill base01–04 with
// background shades — guard on contrast against base00 and fall back to a
// legible mix so comments never vanish.
function shikiVars(t: Base46Theme): Record<string, string> {
  const b16 = t.base_16;
  const comment =
    Math.abs(luminance(b16.base03) - luminance(b16.base00)) < 0.09
      ? mix(b16.base05, b16.base00, 0.5)
      : b16.base03;
  return {
    "--shiki-foreground": b16.base05,
    "--shiki-token-constant": b16.base09,
    "--shiki-token-string": b16.base0B,
    "--shiki-token-comment": comment,
    "--shiki-token-keyword": b16.base0E,
    "--shiki-token-parameter": b16.base08,
    "--shiki-token-function": b16.base0D,
    "--shiki-token-string-expression": b16.base0C,
    "--shiki-token-punctuation": b16.base05,
    "--shiki-token-link": b16.base09,
    "--shiki-token-inserted": t.base_30.green,
    "--shiki-token-deleted": t.base_30.red,
    "--shiki-token-changed": t.base_30.yellow,
  };
}

// ── chat-window token map ────────────────────────────────────────────────
// Emits every token the chat CSS themes (base.css :root + themes.css blocks)
// define, so a base46 theme fully shadows the stylesheet defaults. Both
// branches MUST emit the same key set — legacyAppearance derives its managed
// var list from Object.keys() of this map.

// Dark palettes use their native base canvas (`black`) and lift panels one
// step to `black2`. This preserves the palette hue while giving the floating
// sidebar the same surface direction as Reina's built-in themes.
function darkChatVars(t: Base46Theme): Record<string, string> {
  const b = t.base_30;
  const white = b.white; // main foreground
  const bg = b.black;
  const accent = b.blue;
  const accentContrast = contrastText(accent);
  return {
    "color-scheme": "dark",
    "--bg": bg,
    "--panel": b.black2,
    "--panel-soft": b.one_bg,
    "--panel-elevated": b.one_bg2,
    "--sidebar-chrome": b.black2,
    "--panel-hover": alpha(white, 0.055),
    "--panel-active": alpha(white, 0.08),
    "--panel-selected": alpha(white, 0.09),
    "--line": alpha(white, 0.1),
    "--line-soft": alpha(white, 0.06),
    "--line-strong": alpha(white, 0.18),
    "--text": white,
    "--text-strong": t.base_16.base07,
    "--text-muted": mix(white, bg, 0.34),
    "--text-faint": mix(white, bg, 0.56),
    "--text-disabled": mix(white, bg, 0.7),
    "--accent": accent,
    "--accent-hover": mix(accent, "#ffffff", 0.16),
    "--accent-contrast": accentContrast,
    "--accent-soft": alpha(accent, 0.18),
    "--success": b.green,
    "--success-soft": alpha(b.green, 0.14),
    "--success-border": alpha(b.green, 0.28),
    "--warning": b.yellow,
    "--warning-soft": alpha(b.yellow, 0.11),
    "--warning-border": alpha(b.yellow, 0.24),
    "--danger": b.red,
    "--danger-soft": alpha(b.red, 0.12),
    "--danger-border": alpha(b.red, 0.25),
    "--danger-text": mix(b.red, "#ffffff", 0.45),
    "--diff-added": alpha(b.green, 0.12),
    "--diff-added-text": mix(b.green, "#ffffff", 0.4),
    "--diff-removed": alpha(b.red, 0.12),
    "--diff-removed-text": mix(b.red, "#ffffff", 0.45),
    "--diff-hunk": alpha(white, 0.08),
    "--diff-hunk-text": mix(white, bg, 0.25),
    "--control-bg": alpha(white, 0.04),
    "--control-bg-hover": alpha(white, 0.075),
    "--control-bg-strong": alpha(white, 0.11),
    "--overlay-bg": "rgba(0, 0, 0, 0.62)",
    "--scrollbar-thumb": alpha(white, 0.12),
    "--scrollbar-thumb-hover": alpha(white, 0.22),
    "--code-bg": alpha(white, 0.06),
    "--switch-bg": alpha(white, 0.14),
    "--switch-knob": t.base_16.base07,
    "--composer-bg": b.one_bg2,
    "--composer-bg-focus": b.one_bg3,
    "--composer-border": alpha(white, 0.12),
    "--shadow-sm": "none",
    "--shadow-md": "none",
    "--shadow-lg": "none",
    ...shikiVars(t),
  };
}

// Yoru's original character depends on Alma's inverted dark hierarchy: a
// softer one_bg chat canvas framed by near-black sidebar chrome. Keep that
// palette-specific composition instead of forcing the shared floating-panel
// direction onto it.
function yoruChatVars(t: Base46Theme): Record<string, string> {
  const b = t.base_30;
  const white = b.white;
  const bg = b.one_bg;
  return {
    ...darkChatVars(t),
    "--bg": bg,
    "--panel": b.black2,
    "--panel-soft": b.one_bg2,
    "--panel-elevated": b.one_bg3,
    "--sidebar-chrome": b.darker_black,
    "--text-muted": mix(white, bg, 0.38),
    "--text-faint": mix(white, bg, 0.56),
    "--text-disabled": mix(white, bg, 0.7),
    "--accent-contrast": b.black,
    "--diff-hunk-text": mix(white, bg, 0.25),
    "--composer-bg": b.one_bg2,
    "--composer-bg-focus": b.one_bg3,
  };
}

// Light palettes invert the naming: `black` is the lightest surface and
// `darker_black` is the subtly tinted canvas behind it.
function lightChatVars(t: Base46Theme): Record<string, string> {
  const b = t.base_30;
  const white = b.white; // darkest — main text
  const black = b.black; // lightest — floating surface
  const bg = b.darker_black; // subtly tinted page canvas
  const accent = b.blue;
  const accentContrast = contrastText(accent);
  return {
    "color-scheme": "light",
    "--bg": bg,
    "--panel": black,
    "--panel-soft": b.black2,
    "--panel-elevated": mix(black, "#ffffff", 0.55),
    "--sidebar-chrome": black,
    "--panel-hover": alpha(white, 0.05),
    "--panel-active": alpha(white, 0.08),
    "--panel-selected": alpha(white, 0.07),
    "--line": alpha(white, 0.12),
    "--line-soft": alpha(white, 0.07),
    "--line-strong": alpha(white, 0.18),
    "--text": white,
    "--text-strong": mix(white, "#000000", 0.3),
    "--text-muted": mix(white, bg, 0.36),
    "--text-faint": mix(white, bg, 0.6),
    "--text-disabled": mix(white, bg, 0.75),
    "--accent": accent,
    "--accent-hover": mix(accent, "#000000", 0.12),
    "--accent-contrast": accentContrast,
    "--accent-soft": alpha(accent, 0.14),
    "--success": b.green,
    "--success-soft": alpha(b.green, 0.11),
    "--success-border": alpha(b.green, 0.26),
    "--warning": b.yellow,
    "--warning-soft": alpha(b.yellow, 0.09),
    "--warning-border": alpha(b.yellow, 0.22),
    "--danger": b.red,
    "--danger-soft": alpha(b.red, 0.1),
    "--danger-border": alpha(b.red, 0.24),
    "--danger-text": mix(b.red, "#000000", 0.25),
    "--diff-added": alpha(b.green, 0.13),
    "--diff-added-text": mix(b.green, "#000000", 0.3),
    "--diff-removed": alpha(b.red, 0.13),
    "--diff-removed-text": mix(b.red, "#000000", 0.25),
    "--diff-hunk": alpha(white, 0.08),
    "--diff-hunk-text": mix(white, bg, 0.3),
    "--control-bg": alpha(white, 0.035),
    "--control-bg-hover": alpha(white, 0.07),
    "--control-bg-strong": alpha(white, 0.1),
    "--overlay-bg": "rgba(26, 28, 27, 0.32)",
    "--scrollbar-thumb": alpha(white, 0.16),
    "--scrollbar-thumb-hover": alpha(white, 0.28),
    "--code-bg": alpha(white, 0.07),
    "--switch-bg": alpha(white, 0.18),
    "--switch-knob": "#ffffff",
    "--composer-bg": black,
    "--composer-bg-focus": mix(black, "#ffffff", 0.55),
    "--composer-border": alpha(white, 0.16),
    "--shadow-sm": "none",
    "--shadow-md": "none",
    "--shadow-lg": "none",
    ...shikiVars(t),
  };
}

export function base46ChatVars(t: Base46Theme): Record<string, string> {
  if (t.name === "yoru") return yoruChatVars(t);
  return t.type === "light" ? lightChatVars(t) : darkChatVars(t);
}

// Every property base46ChatVars can emit — legacyAppearance clears exactly
// this set when the active theme is a built-in (stylesheet-driven) one.
export const BASE46_CHAT_VAR_NAMES: readonly string[] = Object.keys(darkChatVars(BASE46_THEMES[0]));

// ── gallery entries (settings/workspace windows) ─────────────────────────
// Preview swatch order mirrors Alma's theme cards: [surface, blue, green,
// red, purple, foreground]. The accent is carried separately because Reina's
// gallery convention (swatches[3] = accent) doesn't fit this order.

export interface Base46GalleryEntry {
  id: string;
  name: string;
  type: "dark" | "light";
  bg: string;
  panel: string;
  sidebar: string;
  fg: string;
  accent: string;
  swatches: string[];
}

export function base46GalleryEntries(): Base46GalleryEntry[] {
  return CURATED_THEMES.map((t) => {
    const b = t.base_30;
    const dark = t.type === "dark";
    const yoru = t.name === "yoru";
    return {
      id: t.name,
      name: t.displayName,
      type: t.type,
      bg: yoru ? b.one_bg : dark ? b.black : b.darker_black,
      panel: dark ? b.black2 : b.black,
      sidebar: yoru ? b.darker_black : dark ? b.black2 : b.black,
      fg: b.white,
      accent: b.blue,
      swatches: [yoru ? b.one_bg : dark ? b.black : b.darker_black, b.blue, b.green, b.red, b.purple, b.white],
    };
  });
}
