// Platform-aware keybind labels. Bindings are authored Windows-style
// ("Ctrl+Shift+S") and the handlers accept ctrlKey||metaKey, so on macOS the
// working key is ⌘ — the label should say so instead of showing a literal
// "Ctrl+" chord no mac user would press.

const isMac = navigator.platform.toLowerCase().includes("mac");

/** Format an authored "Ctrl+…" keybind for display on the host OS: mac gets
 * glyphs in the platform's canonical ⌥⇧⌘ order ("Ctrl+Shift+S" → "⇧⌘S"),
 * everything else passes through unchanged. */
export function displayKeybind(bind: string): string {
  if (!isMac) return bind;
  let rest = bind;
  const strip = (re: RegExp): boolean => {
    if (!re.test(rest)) return false;
    rest = rest.replace(re, "");
    return true;
  };
  const cmd = strip(/Ctrl\+/);
  const shift = strip(/Shift\+/);
  const alt = strip(/Alt\+/);
  return `${alt ? "⌥" : ""}${shift ? "⇧" : ""}${cmd ? "⌘" : ""}${rest}`;
}
