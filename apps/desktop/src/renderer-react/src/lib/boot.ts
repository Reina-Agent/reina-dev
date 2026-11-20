import { bridge } from "./bridge";
import { THEME_GALLERY } from "./viewSettings";

// Apply persisted appearance classes to <html> BEFORE React mounts so the
// first paint is already themed (no light/dark flash). Mirrors the legacy
// renderer's applyAppearance() keys in view-settings; the full theme-gallery
// port lands with the appearance settings panel.
export async function applyBootAppearance(): Promise<void> {
  const root = document.documentElement;
  root.classList.add("no-transitions");
  try {
    const api = bridge();
    const [theme, glass] = await Promise.all([
      api.storeGet("view-settings", "theme").catch(() => null),
      api.storeGet("view-settings", "glass").catch(() => null),
    ]);
    // Resolve light/dark from the gallery's own metadata — a substring guess
    // here missed "snow"/"silver", flashing those windows dark on open until
    // loadViewSettings corrected it. Unknown ids keep the dark default.
    const isLight = THEME_GALLERY.some((t) => t.id === theme && t.type === "light");
    root.classList.toggle("dark", !isLight);
    root.classList.toggle("glass", glass === "true" || glass === "1");
  } catch {
    root.classList.add("dark");
  } finally {
    // Two frames: one for class application to land, one before transitions return.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove("no-transitions"));
    });
  }
}
