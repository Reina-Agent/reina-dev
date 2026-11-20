// React port of the legacy view-settings appearance domain
// (apps/desktop/src/renderer/actions/local-settings.js). Same store name, same
// keys, same persisted string formats — both renderers read identical state.
import { useSyncExternalStore } from "react";
import type { CompactionSettings } from "@reina/desktop-protocol";
import { bridge } from "./bridge";
import { base46GalleryEntries } from "./base46";
import { sanitizeFontFamily } from "./systemFonts";

const STORE = "view-settings";

export const THEME_PRESETS = ["codex", "heroui", "shadcn", "github", "vercel", "apple", "tokyo"] as const;
export const CORNER_RADII = ["small", "medium", "large", "full"] as const;
export const SPARK_VALUES = ["sky", "ocean", "slate", "steel", "graphite", "mono"] as const;
export const DIFF_MODES = ["unified", "split"] as const;

export const UI_FONT_STACKS: Record<string, string> = {
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

// Picker display names — each option is named after the font it actually
// renders (first resolvable family in its stack).
export const UI_FONT_LABELS: Record<string, string> = {
  default: "Default",
  anthropic: "Anthropic Sans",
  reina: "Reina Sans",
  familjen: "Familjen Grotesk",
  system: "System UI",
  segoe: "Segoe UI",
  yahei: "Microsoft YaHei",
  pingfang: "PingFang SC",
  inter: "Inter",
  arial: "Arial",
};

export const CODE_FONT_STACKS: Record<string, string> = {
  default: '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, ui-monospace, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
  sfmono: '"SFMono-Regular", "SF Mono", "Source Code Pro", Menlo, Monaco, Consolas, ui-monospace, monospace',
  consolas: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  fira: '"Fira Code", "Cascadia Code", Consolas, ui-monospace, monospace',
  sourceCode: '"Source Code Pro", "Cascadia Code", Consolas, ui-monospace, monospace',
};

export const CODE_FONT_LABELS: Record<string, string> = {
  default: "Default",
  cascadia: "Cascadia Code",
  jetbrains: "JetBrains Mono",
  sfmono: "SF Mono",
  consolas: "Consolas",
  fira: "Fira Code",
  sourceCode: "Source Code Pro",
};

export interface ThemeGalleryEntry {
  id: string;
  name: string;
  type: "dark" | "light";
  bg: string;
  panel: string;
  fg: string;
  /** Theme-supplied accent (base46 themes); custom accentColor still wins. */
  accent?: string;
  /** Sidebar chrome color when it differs from panel (base46 dark themes). */
  sidebar?: string;
  swatches: string[];
}

// Mirrors the legacy THEME_GALLERY. bg/panel/fg double as the actual theme
// values in the React renderer: applyAppearance() writes them straight into
// --background / --card / --foreground and every other token derives.
export const THEME_GALLERY: ThemeGalleryEntry[] = [
  { id: "dark", name: "Default Dark", type: "dark", bg: "#060607", panel: "#18181b", fg: "#ececee", accent: "#0485f7", swatches: ["#232325", "#28282c", "#8b8b94", "#0485f7", "#a1a1aa", "#17c964"] },
  { id: "onyx", name: "Onyx", type: "dark", bg: "#050506", panel: "#101012", fg: "#e6e6e6", swatches: ["#202024", "#52525b", "#71717a", "#ffffff", "#9a9a9a", "#fafafa"] },
  { id: "midnight", name: "Midnight", type: "dark", bg: "#050711", panel: "#0f1220", fg: "#e4e6ee", swatches: ["#202438", "#50576d", "#737b91", "#d5d7df", "#a3a9bb", "#f9fafe"] },
  { id: "mono", name: "Mono", type: "dark", bg: "#111113", panel: "#1c1c1f", fg: "#e2e2e2", swatches: ["#2e2e32", "#55555d", "#7a7a82", "#ffffff", "#a3a3aa", "#fafafa"] },
  { id: "graphite", name: "Graphite", type: "dark", bg: "#211e1b", panel: "#2c2824", fg: "#dad6d2", swatches: ["#403a34", "#5e5750", "#7c756e", "#ece8e4", "#a29e9a", "#f4f0ec"] },
  { id: "carbon", name: "Carbon", type: "dark", bg: "#07090d", panel: "#10131a", fg: "#ebedf1", swatches: ["#212630", "#484f5d", "#707784", "#ffffff", "#9a9fac", "#ffffff"] },
  { id: "light", name: "Default Light", type: "light", bg: "#f7f7f8", panel: "#ffffff", fg: "#3f3f46", swatches: ["#f1f1f3", "#d4d4d8", "#a1a1aa", "#18181b", "#71717a", "#18181b"] },
  { id: "porcelain", name: "Porcelain", type: "light", bg: "#f1f3f6", panel: "#ffffff", fg: "#232528", swatches: ["#eceef1", "#c1c3c6", "#97999c", "#14161b", "#6b6d70", "#0c0e11"] },
  { id: "snow", name: "Snow", type: "light", bg: "#ffffff", panel: "#ffffff", fg: "#1f1f1f", swatches: ["#f4f4f5", "#d4d4d4", "#949494", "#000000", "#666666", "#000000"] },
  { id: "silver", name: "Silver", type: "light", bg: "#e6e8eb", panel: "#f7f8fa", fg: "#2d2f32", swatches: ["#eef0f3", "#b2b4b7", "#8a8c8f", "#17191e", "#606265", "#0f1114"] },
  // NvChad base46 palettes (Yoru, Catppuccin, Gruvbox, …) — data + role
  // mapping live in base46.ts / base46-data.ts.
  ...base46GalleryEntries(),
];

const CORNER_RADIUS_REM: Record<(typeof CORNER_RADII)[number], string> = {
  small: "0.4rem",
  medium: "0.625rem",
  large: "0.8rem",
  full: "1.1rem",
};

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

// ── Accent-vs-background auto contrast (依据背景自动调整) ─────────────────────
// Mirror of legacyAppearance.ts adaptAccentToBg — keep the two in lockstep. A
// custom accent whose contrast against the background is under ~2:1 (e.g. the
// default white accent on a light theme) flips toward the opposite pole,
// keeping 15% of the original tint; legible accents pass through untouched.

function hexToRgbTriplet(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR_RE.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function relLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function mixHexPair(from: string, to: string, weight: number): string {
  const a = hexToRgbTriplet(from);
  const b = hexToRgbTriplet(to);
  if (!a || !b) return from;
  const c = (x: number, y: number) => Math.round(x + (y - x) * weight).toString(16).padStart(2, "0");
  return `#${c(a.r, b.r)}${c(a.g, b.g)}${c(a.b, b.b)}`;
}

function adaptAccentToBg(accent: string, bg: string): string {
  const a = hexToRgbTriplet(accent);
  const b = hexToRgbTriplet(bg);
  if (!a || !b) return accent;
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  if (ratio >= 2) return accent;
  return mixHexPair(accent, lb > 0.45 ? "#111111" : "#ffffff", 0.85);
}

export interface ViewSettings {
  theme: string;
  themePreset: (typeof THEME_PRESETS)[number];
  cornerRadius: (typeof CORNER_RADII)[number];
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  chatSpark: (typeof SPARK_VALUES)[number];
  glass: boolean;
  sidebarPlacement: "floating" | "inline";
  workspacePlacement: "floating" | "inline";
  closeAction: "ask" | "tray" | "quit";
  diffMode: (typeof DIFF_MODES)[number];
  uiFont: string;
  codeFont: string;
  fontSize: number;
  codeFontSize: number;
  terminalShell: string;
  terminalCols: number;
  terminalRows: number;
  notifySystem: boolean;
  notifyWarnings: boolean;
  notifySound: boolean;
  subagentConcurrency: number;
  compactionOffload: boolean;
  compactionAuto: boolean;
  compactionTriggerPercent: number;
  compactionBufferTokens: number;
  compactionKeepRecent: number;
  language: "zh" | "en";
}

export const DEFAULTS: ViewSettings = {
  theme: "yoru",
  themePreset: "codex",
  cornerRadius: "medium",
  // White accent on the yoru default. Contrast stays legible by construction:
  // the settings/workspace windows derive --primary-foreground from
  // --background, the chat window computes contrast from luminance.
  accentColor: "#ffffff",
  backgroundColor: "",
  foregroundColor: "",
  chatSpark: "graphite",
  glass: false,
  sidebarPlacement: "inline",
  workspacePlacement: "inline",
  closeAction: "ask",
  diffMode: "unified",
  uiFont: "anthropic",
  codeFont: "default",
  fontSize: 13.5,
  codeFontSize: 13.5,
  terminalShell: "",
  terminalCols: 120,
  terminalRows: 30,
  notifySystem: true,
  notifyWarnings: true,
  notifySound: false,
  subagentConcurrency: 8,
  compactionOffload: false,
  compactionAuto: true,
  compactionTriggerPercent: 70,
  compactionBufferTokens: 13000,
  compactionKeepRecent: 8,
  language: "en",
};

const NUMBER_KEYS = new Set<keyof ViewSettings>([
  "fontSize",
  "codeFontSize",
  "terminalCols",
  "terminalRows",
  "subagentConcurrency",
  "compactionTriggerPercent",
  "compactionBufferTokens",
  "compactionKeepRecent",
]);

const BOOLEAN_KEYS = new Set<keyof ViewSettings>([
  "notifySystem",
  "notifyWarnings",
  "notifySound",
  "glass",
  "compactionOffload",
  "compactionAuto",
]);

const FONT_MIN = 10;
const FONT_MAX = 18;

function clampFont(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n * 2) / 2));
}

function readNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function normalizeTheme(value: unknown): string {
  return THEME_GALLERY.some((entry) => entry.id === value) ? (value as string) : DEFAULTS.theme;
}

function normalizeAccentColor(value: unknown): string {
  const next = String(value ?? "").trim();
  const hex = next.startsWith("#") ? next : `#${next}`;
  return HEX_COLOR_RE.test(hex) ? hex.toLowerCase() : "";
}

function coerce<K extends keyof ViewSettings>(key: K, raw: unknown): ViewSettings[K] {
  if (key === "compactionTriggerPercent" && (raw === 0 || raw === "0" || raw === "")) {
    return 0 as ViewSettings[K];
  }
  if (NUMBER_KEYS.has(key)) {
    const fallback = DEFAULTS[key] as number;
    return (key === "fontSize" || key === "codeFontSize"
      ? clampFont(raw, fallback)
      : readNumber(raw, fallback)) as ViewSettings[K];
  }
  if (BOOLEAN_KEYS.has(key)) {
    return (raw === "true" || raw === "1" || raw === true) as ViewSettings[K];
  }
  switch (key) {
    case "theme":
      return normalizeTheme(raw) as ViewSettings[K];
    case "themePreset":
      return (THEME_PRESETS.includes(raw as never) ? raw : DEFAULTS.themePreset) as ViewSettings[K];
    case "cornerRadius":
      return (CORNER_RADII.includes(raw as never) ? raw : DEFAULTS.cornerRadius) as ViewSettings[K];
    case "chatSpark":
      return (SPARK_VALUES.includes(raw as never) ? raw : DEFAULTS.chatSpark) as ViewSettings[K];
    case "uiFont":
      return (Object.hasOwn(UI_FONT_STACKS, String(raw))
        ? raw
        : sanitizeFontFamily(raw) || DEFAULTS.uiFont) as ViewSettings[K];
    case "codeFont":
      return (Object.hasOwn(CODE_FONT_STACKS, String(raw))
        ? raw
        : sanitizeFontFamily(raw) || DEFAULTS.codeFont) as ViewSettings[K];
    case "accentColor":
    case "backgroundColor":
    case "foregroundColor":
      return normalizeAccentColor(raw) as ViewSettings[K];
    case "sidebarPlacement":
    case "workspacePlacement":
      return (raw === "floating" ? "floating" : "inline") as ViewSettings[K];
    case "closeAction":
      return (raw === "tray" || raw === "quit" ? raw : "ask") as ViewSettings[K];
    case "diffMode":
      return (raw === "split" ? "split" : "unified") as ViewSettings[K];
    case "language":
      return (raw === "zh" || raw === "en" ? raw : DEFAULTS.language) as ViewSettings[K];
    default:
      return raw as ViewSettings[K];
  }
}

// ── store ────────────────────────────────────────────────────────────────

let settings: ViewSettings = { ...DEFAULTS };
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export async function loadViewSettings(): Promise<ViewSettings> {
  const api = bridge();
  const next = { ...DEFAULTS };
  await Promise.all(
    (Object.keys(DEFAULTS) as (keyof ViewSettings)[]).map(async (key) => {
      const raw = await api.storeGet(STORE, key).catch(() => null);
      if (raw === null || raw === undefined) return;
      (next as Record<string, unknown>)[key] = coerce(key, raw);
    }),
  );
  settings = next;
  loaded = true;
  applyAppearance();
  emit();
  return settings;
}

export function getViewSettings(): ViewSettings {
  return settings;
}

/** Main chat owns its legacy theme; sync translations without applying the
 * settings/workspace appearance defaults over it. */
export function syncViewLanguage(raw: unknown): void {
  const language = coerce("language", raw);
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  if (settings.language === language) return;
  settings = { ...settings, language };
  emit();
}

export async function setViewSetting<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]): Promise<void> {
  settings = { ...settings, [key]: coerce(key, value) };
  applyAppearance();
  emit();
  try {
    await bridge().storeSet(STORE, key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* persisting is best-effort; UI state already updated */
  }
}

export async function saveCompactionSettings(next: CompactionSettings): Promise<void> {
  await bridge().invoke("save_compaction_settings", { settings: next });
  settings = { ...settings, ...next };
  emit();
}

export async function saveSubagentConcurrency(concurrency: number): Promise<void> {
  await bridge().invoke("save_subagent_concurrency", { concurrency });
  settings = { ...settings, subagentConcurrency: concurrency };
  emit();
}

export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => settings,
  );
}

// Other windows (or this one) writing view-settings broadcast through main.
export function subscribeViewSettingsBroadcast(): () => void {
  return bridge().events.on("view-settings-changed", (payload) => {
    const { key, value } = (payload ?? {}) as { key?: keyof ViewSettings; value?: unknown };
    if (!key || !(key in DEFAULTS)) return;
    settings = { ...settings, [key]: coerce(key, value) };
    applyAppearance();
    emit();
  });
}

// ── appearance application ───────────────────────────────────────────────

// uiFont/codeFont hold either a preset stack key or a raw system font family
// (picked from the queryLocalFonts list). Custom families lead the default
// stack so missing glyphs (e.g. CJK under a Latin-only font) still resolve.
// Keep in lockstep with legacyAppearance.ts (chat window copy).
export function uiFontStack(value: string): string {
  if (Object.hasOwn(UI_FONT_STACKS, value)) return UI_FONT_STACKS[value];
  const family = sanitizeFontFamily(value);
  return family ? `"${family}", ${UI_FONT_STACKS.default}` : UI_FONT_STACKS.default;
}

export function codeFontStack(value: string): string {
  if (Object.hasOwn(CODE_FONT_STACKS, value)) return CODE_FONT_STACKS[value];
  const family = sanitizeFontFamily(value);
  return family ? `"${family}", ${CODE_FONT_STACKS.default}` : CODE_FONT_STACKS.default;
}

export function applyAppearance(): void {
  if (!loaded) return;
  const root = document.documentElement;
  const entry = THEME_GALLERY.find((t) => t.id === normalizeTheme(settings.theme)) ?? THEME_GALLERY[0];

  root.lang = settings.language === "zh" ? "zh-CN" : "en";
  root.classList.toggle("dark", entry.type === "dark");
  root.dataset.theme = entry.id;
  root.dataset.sentBubble = settings.chatSpark;

  // Theme = three base colors; custom colors override the gallery's.
  const bg = settings.backgroundColor || entry.bg;
  const fg = settings.foregroundColor || entry.fg;
  const panel = settings.backgroundColor ? settings.backgroundColor : entry.panel;
  root.style.setProperty("--background", bg);
  root.style.setProperty("--card", panel);
  root.style.setProperty("--foreground", fg);

  const rawAccent = settings.accentColor || entry.accent || "";
  // Contrast-check the accent against the background it actually lands on —
  // the default white accent must not vanish on light themes.
  const accent = rawAccent ? adaptAccentToBg(rawAccent, bg) : "";
  if (accent) {
    root.style.setProperty("--primary", accent);
    root.style.setProperty("--ring", accent);
  } else {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--ring");
  }

  root.style.setProperty("--radius", CORNER_RADIUS_REM[settings.cornerRadius]);
  root.style.setProperty("--font-ui-family", uiFontStack(settings.uiFont));
  root.style.setProperty("--font-mono-family", codeFontStack(settings.codeFont));
  root.style.setProperty("--ui-font-size", `${clampFont(settings.fontSize, DEFAULTS.fontSize)}px`);
  root.style.setProperty("--code-font-size", `${clampFont(settings.codeFontSize, DEFAULTS.codeFontSize)}px`);

  root.classList.toggle("glass", settings.glass);
  mirrorAppearance(root);
}

// FOUC guard (learned from Alma): settings arrive over async IPC, so mirror
// the final applied appearance into localStorage. settings.html/workspace.html
// head scripts replay it synchronously before first paint — no default-theme
// flash on launch. Stale mirrors self-correct on the next applyAppearance().
const MIRROR_KEY = "reina:appearance-mirror:app";

function mirrorAppearance(root: HTMLElement): void {
  try {
    localStorage.setItem(
      MIRROR_KEY,
      JSON.stringify({
        attrs: {
          "data-theme": root.dataset.theme ?? DEFAULTS.theme,
          "data-sent-bubble": root.dataset.sentBubble ?? DEFAULTS.chatSpark,
        },
        style: root.getAttribute("style") ?? "",
        classes: { dark: root.classList.contains("dark"), glass: settings.glass },
        lang: root.lang,
      }),
    );
  } catch {
    /* localStorage unavailable (private mode / quota) — boot replay just skips */
  }
}
