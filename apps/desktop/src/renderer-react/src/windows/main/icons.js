// Inline lucide-style icon set. Stroke-only icons that inherit currentColor.
// Inject the sprite once on import, then use `icon("name")` to get an HTML string
// or `iconNode("name")` to get a fresh SVG element.

const STROKE = `
  fill="none" stroke="currentColor" stroke-width="1.75"
  stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
`;

const ICONS = {
  // window / panel
  "sidebar-left": `<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" x2="9" y1="3" y2="21"/>`,
  "sidebar-right": `<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" x2="15" y1="3" y2="21"/>`,
  "panel-split": `<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" x2="12" y1="3" y2="21"/>`,
  "panel-layout": `<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" x2="21" y1="9" y2="9"/>`,

  // common
  plus: `<line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/>`,
  target: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  lightbulb: `<path d="M9 18h6"/><path d="M10 22h4"/><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5C14.6 15.2 14 16.1 14 17h-4c0-.9-.6-1.8-1.5-2.5Z"/>`,
  minus: `<line x1="5" x2="19" y1="12" y2="12"/>`,
  x: `<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  search: `<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/>`,
  refresh: `<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/>`,
  "rotate-cw": `<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/>`,
  "rotate-ccw": `<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/>`,
  "undo-2": `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  "more-horizontal": `<circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/>`,
  "grip-vertical": `<circle cx="8" cy="5" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="5" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="16" cy="19" r="1"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  menu: `<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>`,

  // chevrons / arrows
  "chevron-down": `<polyline points="6 9 12 15 18 9"/>`,
  "chevron-up": `<polyline points="18 15 12 9 6 15"/>`,
  "chevron-right": `<polyline points="9 18 15 12 9 6"/>`,
  "chevron-left": `<polyline points="15 18 9 12 15 6"/>`,
  "arrow-up": `<line x1="12" x2="12" y1="19" y2="5"/><polyline points="5 12 12 5 19 12"/>`,
  "arrow-right": `<line x1="5" x2="19" y1="12" y2="12"/><polyline points="12 5 19 12 12 19"/>`,

  // files / git
  file: `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>`,
  "file-code": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>`,
  "file-json": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M10 13a2 2 0 0 0 0 4"/><path d="M14 13a2 2 0 0 1 0 4"/>`,
  "file-text": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8"/><path d="M8 17h5"/>`,
  "file-image": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><circle cx="9" cy="13" r="1.25"/><path d="m8 18 2.5-2.5 1.7 1.7L14.8 14 18 18"/>`,
  "file-lock": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="14" width="8" height="5" rx="1"/><path d="M10 14v-1a2 2 0 0 1 4 0v1"/>`,
  "file-plus": `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" x2="12" y1="13" y2="19"/><line x1="9" x2="15" y1="16" y2="16"/>`,
  folder: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  "folder-plus": `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" x2="12" y1="10" y2="16"/><line x1="9" x2="15" y1="13" y2="13"/>`,
  "folder-open": `<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>`,
  "git-branch": `<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  "git-commit": `<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>`,
  workflow: `<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>`,
  terminal: `<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`,

  // composer / chat
  "at-sign": `<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>`,
  paperclip: `<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 1 1-2.83-2.83l8.49-8.48"/>`,
  send: `<path d="M2 12 22 2l-7 20-4-9-9-1z"/>`,
  square: `<rect x="6" y="6" width="12" height="12" rx="1.5"/>`,
  sparkles: `<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>`,
  bot: `<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 3v5"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>`,
  "messages-square": `<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>`,
  store: `<path d="m2 7 2-4h16l2 4"/><path d="M22 7v3a3 3 0 0 1-6 0V7"/><path d="M16 7v3a3 3 0 0 1-6 0V7"/><path d="M10 7v3a3 3 0 0 1-6 0V7"/><path d="M4 11v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9"/>`,

  // misc
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.51 1z"/>`,
  shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
  zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  command: `<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>`,
  keyboard: `<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01"/><path d="M10 10h.01"/><path d="M14 10h.01"/><path d="M18 10h.01"/><path d="M6 14h.01"/><path d="M18 14h.01"/><path d="M8 17h8"/>`,
  cube: `<path d="m12.83 2.18 9 5.19a1 1 0 0 1 .5.87v8.69a1 1 0 0 1-.5.87l-9 5.18a1 1 0 0 1-1 0l-9-5.18a1 1 0 0 1-.5-.87V8.24a1 1 0 0 1 .5-.87l9-5.19a1 1 0 0 1 1 0z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
  cloud: `<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A7 7 0 1 0 6 17.34"/>`,
  book: `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>`,
  list: `<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>`,
  rocket: `<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22 22 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>`,
  contrast: `<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>`,
  palette: `<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>`,

  // playback (goal runtime pause / resume)
  play: `<polygon points="6 3 20 12 6 21 6 3"/>`,
  pause: `<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>`,

  // status / dots
  dot: `<circle cx="12" cy="12" r="5" fill="currentColor"/>`,
  "alert-circle": `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
  external: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>`,
  hand: `<path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11"/><path d="M15 9.5V4.5a1.5 1.5 0 0 0-3 0V11"/><path d="M12 4.5a1.5 1.5 0 0 0-3 0V13"/><path d="M9 7.5a1.5 1.5 0 0 0-3 0v8.5a6 6 0 0 0 6 6h2a6 6 0 0 0 6-6v-3"/>`,
  edit: `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>`,
  pin: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
  archive: `<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>`,
  "archive-restore": `<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/>`,
  gauge: `<path d="M12 14 5.5 7.5"/><circle cx="12" cy="14" r="9"/><path d="M3.6 9A9 9 0 1 0 20.4 9"/>`,
  "shield-off": `<path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18"/><path d="M4.73 4.73 4 5v7c0 6 8 10 8 10a20.29 20.29 0 0 0 5.62-4.38"/><line x1="2" x2="22" y1="2" y2="22"/>`,
  "book-open": `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
  "win-minimize": `<line x1="5" x2="19" y1="12" y2="12"/>`,
  "win-maximize": `<rect x="5" y="5" width="14" height="14" rx="1"/>`,
  "win-restore": `<rect x="7" y="3" width="14" height="14" rx="1"/><rect x="3" y="7" width="14" height="14" rx="1"/>`,
  "win-close": `<line x1="6" x2="18" y1="6" y2="18"/><line x1="6" x2="18" y1="18" y2="6"/>`,
  "trash-2": `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
  info: `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="11" y2="16"/><line x1="12" x2="12.01" y1="8" y2="8"/>`,
};

const SPRITE_ID = "reina-icon-sprite";

function injectSprite() {
  if (document.getElementById(SPRITE_ID)) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = SPRITE_ID;
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.style.width = "0";
  svg.style.height = "0";
  svg.style.overflow = "hidden";
  const symbols = Object.entries(ICONS)
    .map(
      ([name, body]) =>
        `<symbol id="i-${name}" viewBox="0 0 24 24" ${STROKE.trim()}>${body}</symbol>`,
    )
    .join("");
  svg.innerHTML = symbols;
  document.body.insertBefore(svg, document.body.firstChild);
}

function applyIconDefaults(root = document) {
  for (const svg of root.querySelectorAll("svg.icon")) {
    if (!svg.hasAttribute("viewBox")) svg.setAttribute("viewBox", "0 0 24 24");
    if (!svg.hasAttribute("focusable")) svg.setAttribute("focusable", "false");
    if (!svg.hasAttribute("aria-hidden")) svg.setAttribute("aria-hidden", "true");
  }
}

function initIcons() {
  injectSprite();
  applyIconDefaults();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initIcons, { once: true });
  } else {
    initIcons();
  }
}

export function icon(name, { className = "icon", size } = {}) {
  if (!ICONS[name]) {
    console.warn(`[icons] missing: ${name}`);
    return "";
  }
  const sizeAttr = size ? ` width="${size}" height="${size}"` : "";
  return `<svg class="${className}" viewBox="0 0 24 24"${sizeAttr} aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

export function iconNode(name, opts) {
  const wrap = document.createElement("span");
  wrap.innerHTML = icon(name, opts);
  return wrap.firstElementChild;
}

export function decorateButtons() {
  // Replace `<button data-icon="name">…</button>` markup with svg + label.
  for (const el of document.querySelectorAll("[data-icon]")) {
    if (el.dataset.iconReplaced === "1") continue;
    const name = el.dataset.icon;
    if (!ICONS[name]) continue;
    el.insertAdjacentHTML("afterbegin", icon(name));
    el.dataset.iconReplaced = "1";
  }
  applyIconDefaults();
}

export const ICON_NAMES = Object.keys(ICONS);
