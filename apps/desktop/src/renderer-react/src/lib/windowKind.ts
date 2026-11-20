// Which Electron window this renderer instance is driving. The main chat window
// and the floating session-sidebar window both load main.html (the sidebar
// window is opened with ?window=sidebar by createSessionSidebarWindow in
// apps/desktop/src/main/windows.ts), so a single entry must branch on the URL
// query — exactly like the legacy renderer's `windowKind` (renderer.js).
//
// The legacy CSS keys the sidebar-only layout off `body[data-window="sidebar"]`,
// so callers must also stamp that attribute on <body> (done in main.tsx before
// first paint). main.html ships `data-window="main"` as the default.

const params = new URLSearchParams(window.location.search);

export const windowKind: string = params.get("window") || "main";
export const isSidebarWindow: boolean = windowKind === "sidebar";
export const isMainChatWindow: boolean = windowKind === "main";
