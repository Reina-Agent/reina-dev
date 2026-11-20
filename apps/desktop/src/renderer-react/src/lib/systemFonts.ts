// System font enumeration via Chromium's Local Font Access API
// (window.queryLocalFonts). Names come from DirectWrite/CoreText typographic
// families — exactly the strings CSS font-family matches, full length (GDI's
// 31-char truncation does not apply). Electron grants the local-fonts
// permission by default (no permission handler is installed in main), and no
// user gesture is required there; any failure degrades to an empty list so
// the pickers simply fall back to the preset stacks.
interface LocalFontData {
  family: string;
}

// Families shipped inside the app (~/assets/fonts/fonts.css) — renderable on
// every machine regardless of what's installed. This is the ONE hardcoded
// font-name list (it has to mirror the @font-face declarations); the pickers
// offer exactly these as fixed entries, everything else via queryLocalFonts.
export const BUNDLED_FONT_FAMILIES = [
  "Inter",
  "Familjen Grotesk",
  "Reina Sans",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Cascadia Code",
];

let cache: string[] | null = null;

export async function listSystemFonts(): Promise<string[]> {
  // Only successful non-empty enumerations are cached: queryLocalFonts throws
  // (or returns nothing) while the frame is unfocused, and caching that would
  // leave the pickers permanently empty — callers retry on window focus.
  if (cache?.length) return cache;
  const query = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof query !== "function") return [];
  try {
    const fonts = await query.call(globalThis);
    const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    if (families.length) cache = families;
    return families;
  } catch {
    return [];
  }
}

// A custom font value is persisted as the raw family name (anything that is
// not a preset stack key). It ends up quoted inside a CSS custom property, so
// strip quotes/braces/etc. that could break out of the string, plus control
// characters (char codes below 0x20, and DEL).
export function sanitizeFontFamily(value: unknown): string {
  const printable = Array.from(String(value ?? ""))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  return printable
    .replace(/["'<>;{}()\\/]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
