// Copy the React chat window's owned CSS (+ hljs theme) and brand icons into the
// build output so the React main window can <link> them at runtime. These files
// were originally inherited verbatim from the legacy chat renderer to keep the
// look byte-identical, but they are now OWNED by renderer-react (under
// chat-styles/ and chat-assets/) — this script no longer reads from
// src/renderer, so the legacy renderer can be removed without breaking the build.
const fs = require("node:fs");
const path = require("node:path");

const reactRoot = path.resolve(__dirname, "../src/renderer-react");
const stylesSrc = path.join(reactRoot, "chat-styles");
const assetsSrc = path.join(reactRoot, "chat-assets");
const outDir = path.resolve(__dirname, "../../../dist/apps/desktop/renderer-react/legacy-styles");

// The chat-surface stylesheets main.html links, in load order, plus the
// hljs code-highlight theme. (workspace window has its own React port.)
const CSS_FILES = [
  "base.css",
  "themes.css",
  "topbar.css",
  "resize.css",
  "sidebar.css",
  "task-pane.css",
  "hljs-theme.css",
  "chat.css",
  "subagent-chips.css",
  "composer.css",
  "hitl.css",
  "palette.css",
  "responsive.css",
  "style.css",
  "glass.css",
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const name of CSS_FILES) {
  fs.copyFileSync(path.join(stylesSrc, name), path.join(outDir, name));
}

// Static assets the chat DOM references (open-with brand icons, app avatar).
const assetsOut = path.resolve(__dirname, "../../../dist/apps/desktop/renderer-react/legacy-assets");
fs.rmSync(assetsOut, { recursive: true, force: true });
fs.mkdirSync(path.join(assetsOut, "icons"), { recursive: true });
fs.cpSync(path.join(assetsSrc, "icons/app"), path.join(assetsOut, "icons/app"), { recursive: true });
const repoRoot = path.resolve(__dirname, "../../..");
const appIcon = path.join(repoRoot, "build/icon.png");
if (fs.existsSync(appIcon)) fs.copyFileSync(appIcon, path.join(assetsOut, "icon.png"));

// Vite bundles the provider SVGs; ship their license and source notices too.
const providerNoticesOut = path.join(outDir, "../licenses/provider-brands");
fs.mkdirSync(providerNoticesOut, { recursive: true });
for (const name of ["LICENSE.txt", "README.md"]) {
  fs.copyFileSync(path.join(reactRoot, "src/assets/provider-brands", name), path.join(providerNoticesOut, name));
}

console.log(`[copy-chat-assets] copied ${CSS_FILES.length} stylesheets + brand icons -> ${path.relative(repoRoot, outDir)} (owned, no legacy reads)`);
