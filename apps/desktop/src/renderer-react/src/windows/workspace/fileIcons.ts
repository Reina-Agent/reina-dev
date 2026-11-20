// VSCode-style per-type file icons for the workspace file tree.
//
// Uses the `vscode-icons` icon set (the same pack VSCode's "vscode-icons"
// extension ships) via Iconify, plus `vscode-icons-js` for the rich
// filename → icon-name mapping (handles package.json, Dockerfile, .gitignore,
// folder-type-src, etc.).
//
// The icon set (~3.6 MB, 1.5k icons) is loaded once via a dynamic import so Vite
// splits it into its own lazy chunk — kept out of the initial workspace bundle,
// yet loaded as a module script (not fetch), which works under the file://
// origin the windows use (Chromium blocks fetch() of file:// URLs). It's then
// registered with addCollection so <Icon> renders fully offline — no
// api.iconify.design calls. Any name not present falls back to
// default-file/default-folder so Iconify never tries to fetch a missing icon.

import { addCollection } from "@iconify/react";
import {
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from "vscode-icons-js";

const PREFIX = "vscode-icons";
const FALLBACK_FILE = `${PREFIX}:default-file`;
const FALLBACK_FOLDER = `${PREFIX}:default-folder`;
const FALLBACK_FOLDER_OPEN = `${PREFIX}:default-folder-opened`;

// Populated once the collection loads; until then resolvers return fallbacks so
// only registered names are ever handed to <Icon>.
let available: Set<string> | null = null;
let loading: Promise<void> | null = null;

export function ensureFileIcons(): Promise<void> {
  if (available) return Promise.resolve();
  if (loading) return loading;
  loading = import("@iconify-json/vscode-icons")
    .then(({ icons }) => {
      addCollection(icons as Parameters<typeof addCollection>[0]);
      available = new Set(Object.keys(icons.icons ?? {}));
    })
    .catch(() => {
      // Leave resolvers returning fallbacks; those are also absent, so nothing
      // renders rather than triggering a network fetch for a missing icon.
      available = new Set();
    });
  return loading;
}

// vscode-icons-js returns names like "file_type_python.svg"; the Iconify set
// uses "file-type-python". Normalise and verify it exists.
function toIconName(raw: string | undefined, fallback: string): string {
  if (!available || !raw) return fallback;
  const name = raw.replace(/\.svg$/i, "").replace(/_/g, "-");
  return available.has(name) ? `${PREFIX}:${name}` : fallback;
}

export function fileIconName(filename: string): string {
  return toIconName(getIconForFile(filename), FALLBACK_FILE);
}

export function folderIconName(name: string, open: boolean): string {
  const raw = open ? getIconForOpenFolder(name) : getIconForFolder(name);
  return toIconName(raw, open ? FALLBACK_FOLDER_OPEN : FALLBACK_FOLDER);
}
