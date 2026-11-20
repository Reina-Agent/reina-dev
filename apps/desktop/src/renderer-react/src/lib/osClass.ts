// Stamp `data-os` on <body> so platform-specific CSS can target the host OS.
// The chat stylesheets (topbar.css/glass.css) and the Tailwind TitleBar key
// their macOS behaviour off `body[data-os="mac"]` — most importantly, reserving
// the top-left strip for the native traffic lights (titleBarStyle:"hidden")
// instead of letting them overlap our window controls. Without this attribute
// every `body[data-os="mac"]` rule is dead, which is why macOS shows the
// traffic lights on top of the settings gear / workspace tabs.
//
// Imported for its side effect from each renderer entry, before React mounts,
// so the attribute is present on first paint (no overlap flash).

function detectOs(): "mac" | "win" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "mac";
  if (platform.includes("win")) return "win";
  return "linux";
}

document.body.dataset.os = detectOs();
