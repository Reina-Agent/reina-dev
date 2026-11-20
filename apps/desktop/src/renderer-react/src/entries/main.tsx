import { createRoot } from "react-dom/client";
import { MainApp } from "~/windows/main/MainApp";
import { loadAppearance, subscribeAppearance } from "~/windows/main/legacyAppearance";
import { windowKind } from "~/lib/windowKind";
// Side-effect: stamp body[data-os] so macOS reserves room for the native
// traffic lights instead of overlapping our controls.
import "~/lib/osClass";
// Bundled OFL fonts so the appearance font pickers work without the fonts
// being installed system-wide (the legacy stylesheets only declare stacks).
import "~/assets/fonts/fonts.css";
// Sprite injection side-effect on import: registers the #i-* symbols the DOM's
// <use href="#i-..."> references (verbatim legacy module).
import "~/windows/main/icons.js";

// The floating session-sidebar window loads this same main.html with
// ?window=sidebar (createSessionSidebarWindow). main.html hardcodes
// data-window="main"; override it from the query so the legacy
// body[data-window="sidebar"] CSS collapses the layout to the session pane
// alone — mirrors the legacy renderer's `document.body.dataset.window = windowKind`.
document.body.dataset.window = windowKind;

// NOTE: no Tailwind theme.css import here. The chat window reuses the legacy
// stylesheets (linked from main.html ./legacy-styles/*) so the appearance stays
// byte-identical to the legacy renderer.

void loadAppearance().finally(() => {
  subscribeAppearance();
  // No StrictMode: the streaming/session store wires bridge event listeners in
  // effects; double-invocation in dev would attach duplicate listeners.
  createRoot(document.getElementById("root")!).render(<MainApp />);
});
