// OpenWith — the current-conversation actions menu in the main titlebar.
//
// The old control was a folder-brand split button dedicated to opening the
// workspace in another app. The titlebar now follows the Codex task-menu shape:
// one ellipsis trigger owns conversation actions in an Electron native menu,
// allowing nested menus to extend past the BrowserWindow edge. Selecting an app
// still persists it as the default and opens the current workspace as before.
//
// Notes vs legacy:
//   - Target resolution: the legacy `resolveTarget()` could prefer an active
//     file (state.activeFilePath / state.selectedChangePath). The React main
//     store (sessionStore) has no such file-level fields — the chat window has
//     no file pane — so the target is always the workspace folder, exactly as
//     it is in the legacy chat window. The file branch is kept for parity but
//     never fires here.
//   - Bridge: the legacy `desktop.*` calls map 1:1 to the typed React bridge
//     (resolveAppPath / revealInFolder / openPath / openShellIn / clipboardWrite
//     / storeGet / storeSet).
//   - selectedId / installed state lives inside this component (React state) —
//     sessionStore is NOT touched.

import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getMainState, refreshDesktopState, subscribeMainStore } from "./sessionStore";
import { startSessionRename } from "./SessionContextMenu";

interface AppEntry {
  id: string;
  label: string;
  binary?: string;
  kind?: "shellOpen" | "shellHere" | "wslHere";
  system?: boolean;
}

const APPS_WINDOWS: AppEntry[] = [
  { id: "vscode", label: "VS Code", binary: "code" },
  { id: "cursor", label: "Cursor", binary: "cursor" },
  { id: "antigravity", label: "Antigravity", binary: "antigravity" },
  { id: "explorer", label: "File Explorer", kind: "shellOpen", system: true },
  { id: "terminal", label: "Terminal", kind: "shellHere", system: true },
  { id: "wsl", label: "WSL", kind: "wslHere", binary: "wsl.exe" },
  { id: "intellij", label: "IntelliJ IDEA", binary: "idea64" },
  { id: "pycharm", label: "PyCharm", binary: "pycharm64" },
];

const APPS_MAC: AppEntry[] = [
  { id: "finder", label: "Finder", kind: "shellOpen", system: true },
  { id: "vscode", label: "VS Code", binary: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", binary: "Cursor" },
  { id: "antigravity", label: "Antigravity", binary: "Antigravity" },
  { id: "zed", label: "Zed", binary: "Zed" },
  { id: "intellij", label: "IntelliJ IDEA", binary: "IntelliJ IDEA" },
  { id: "pycharm", label: "PyCharm", binary: "PyCharm" },
  { id: "xcode", label: "Xcode", binary: "Xcode" },
  { id: "terminal", label: "Terminal", kind: "shellHere", system: true },
  { id: "sublime", label: "Sublime Text", binary: "Sublime Text" },
];

const APPS_LINUX: AppEntry[] = [
  { id: "files", label: "File Manager", kind: "shellOpen", system: true },
  { id: "vscode", label: "VS Code", binary: "code" },
  { id: "cursor", label: "Cursor", binary: "cursor" },
  { id: "zed", label: "Zed", binary: "zed" },
  { id: "terminal", label: "Terminal", kind: "shellHere", system: true },
  { id: "sublime", label: "Sublime Text", binary: "subl" },
];

function detectOS(): "win32" | "darwin" | "linux" {
  const value = navigator.platform || navigator.userAgent;
  if (/Win/i.test(value)) return "win32";
  if (/Mac/i.test(value)) return "darwin";
  return "linux";
}

function catalogFor(osId: "win32" | "darwin" | "linux"): AppEntry[] {
  if (osId === "win32") return APPS_WINDOWS;
  if (osId === "darwin") return APPS_MAC;
  return APPS_LINUX;
}

interface ResolvedTarget {
  kind: "folder" | "file";
  path: string;
}

// Resolve the path we should hand to the chosen app. The legacy chat window has
// no active-file state in this window, so the workspace folder is always the
// target. Mirrors legacy resolveTarget() (the file branch is unreachable here
// because the main store carries no activeFilePath/selectedChangePath).
function resolveTarget(): ResolvedTarget | null {
  const cwd = getMainState().workspaceCwd;
  if (!cwd) return null;
  return { kind: "folder", path: cwd };
}

function parentOf(absPath: string): string {
  const stripped = absPath.replace(/[\\/]+$/, "");
  const cut = stripped.replace(/[\\/][^\\/]+$/, "");
  return cut || absPath;
}

function MenuIcon({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function OpenWith({ onOpenSideChat }: { onOpenSideChat?: () => void }) {
  const osId = useMemo(detectOS, []);
  const catalog = useMemo(() => catalogFor(osId), [osId]);

  const [selectedId, setSelectedId] = useState<string>(() => catalog[0].id);
  // installed map: app id -> true (available) / false (missing) / undefined (unknown)
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  // Re-render hook for workspaceCwd changes so the action-button tooltip stays
  // accurate (mirrors the legacy `mouseenter` tooltip refresh + live state).
  const [, forceTick] = useState(0);

  // Guard so refreshInstalledApps() runs at most once concurrently (mirrors the
  // legacy `installedRefresh` promise latch).
  const refreshing = useRef(false);

  const pickApp = (id: string): AppEntry => catalog.find((entry) => entry.id === id) ?? catalog[0];

  const isAvailable = (app: AppEntry, map: Record<string, boolean> = installed): boolean => {
    if (app.system) return true;
    return map[app.id] === true;
  };

  // Probe which non-system apps are installed (resolveAppPath), then drop the
  // selection to the first available app if the current pick vanished. Mirrors
  // legacy refreshInstalledApps().
  async function refreshInstalledApps(): Promise<void> {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next: Record<string, boolean> = {};
      await Promise.all(
        catalog.map(async (app) => {
          if (app.system || !app.binary) {
            next[app.id] = true;
            return;
          }
          const resolved = await bridge()
            .resolveAppPath(app.binary)
            .catch(() => null);
          next[app.id] = Boolean(resolved);
        }),
      );
      setInstalled(next);
      setSelectedId((prev) => {
        if (isAvailable(pickApp(prev), next)) return prev;
        const fallback = catalog.find((app) => isAvailable(app, next)) ?? catalog[0];
        return fallback.id;
      });
    } finally {
      refreshing.current = false;
    }
  }

  // Persist + reflect the chosen default (mirrors legacy selectApp).
  function selectApp(id: string): void {
    setSelectedId(id);
    void bridge()
      .storeSet("view-settings", "openWithApp", id)
      .catch(() => undefined);
  }

  async function openWith(id: string): Promise<void> {
    const target = resolveTarget();
    if (!target) {
      console.error("Open a workspace first.");
      return;
    }
    const app = pickApp(id);
    const api = bridge();
    try {
      if (app.kind === "shellOpen") {
        // File Explorer: when a file is active, reveal it; otherwise open the
        // folder directly. (Folder is always the case in the chat window.)
        if (target.kind === "file") {
          await api.revealInFolder(target.path);
        } else {
          await api.openPath(target.path);
        }
        return;
      }
      if (app.kind === "shellHere") {
        const dir = target.kind === "file" ? parentOf(target.path) : target.path;
        await api.openShellIn(dir);
        return;
      }
      if (app.kind === "wslHere") {
        const dir = target.kind === "file" ? parentOf(target.path) : target.path;
        const bin = await api.resolveAppPath(app.binary as string);
        if (!bin) {
          setInstalled((prev) => ({ ...prev, [app.id]: false }));
          console.error(`${app.label} 未安装，或没有暴露可启动命令。`);
          return;
        }
        setInstalled((prev) => ({ ...prev, [app.id]: true }));
        await api.openShellIn(dir, "wsl");
        return;
      }
      const bin = await api.resolveAppPath(app.binary as string);
      if (!bin) {
        setInstalled((prev) => ({ ...prev, [app.id]: false }));
        console.error(`${app.label} 未安装，或没有暴露可启动命令。`);
        return;
      }
      setInstalled((prev) => ({ ...prev, [app.id]: true }));
      await api.openPath(target.path, bin);
    } catch (error) {
      console.error(error);
    }
  }

  // Load the persisted default + probe installs once on mount (mirrors legacy
  // init()), and keep the action-button tooltip live as workspaceCwd changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await bridge()
        .storeGet("view-settings", "openWithApp")
        .catch(() => null);
      if (cancelled) return;
      if (saved && catalog.some((entry) => entry.id === saved)) setSelectedId(saved);
      void refreshInstalledApps();
    })();
    const unsubscribe = subscribeMainStore(() => forceTick((n) => n + 1));
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  // ── Current conversation + menu state ───────────────────────────────────
  const mainState = getMainState();
  const activeItem =
    mainState.desktop?.sessions?.find((item) => item.id === mainState.sessionId) ?? null;
  const target = resolveTarget();
  const visibleApps = catalog.filter((app) => isAvailable(app));

  async function togglePin(): Promise<void> {
    if (!activeItem) return;
    try {
      await bridge().setSessionFlags(activeItem.id, { pinned: !activeItem.pinnedAt });
      await refreshDesktopState();
    } catch (error) {
      console.error(error);
    }
  }

  async function toggleArchive(): Promise<void> {
    if (!activeItem) return;
    try {
      await bridge().setSessionFlags(activeItem.id, { archived: !activeItem.archivedAt });
      await refreshDesktopState();
    } catch (error) {
      console.error(error);
    }
  }

  function copy(value: string): void {
    void bridge().clipboardWrite(value).catch(() => undefined);
  }

  // Electron owns this popup rather than the renderer DOM, so nested menus can
  // cross the BrowserWindow edge and are constrained only by the physical
  // display. Menu selections return through the existing menu-command event.
  useEffect(() => {
    return bridge().events.on("menu-command", (payload) => {
      if (typeof payload !== "string" || !payload.startsWith("conversation.")) return;
      if (payload === "conversation.pin") {
        void togglePin();
        return;
      }
      if (payload === "conversation.rename") {
        if (activeItem) startSessionRename(activeItem);
        return;
      }
      if (payload === "conversation.copy-title") {
        if (activeItem) copy(activeItem.title || `Session ${activeItem.id.slice(0, 8)}`);
        return;
      }
      if (payload === "conversation.copy-id") {
        if (activeItem) copy(activeItem.id);
        return;
      }
      if (payload === "conversation.copy-path") {
        if (target) copy(target.path);
        return;
      }
      if (payload === "conversation.archive") {
        void toggleArchive();
        return;
      }
      if (payload === "conversation.new-side-chat") {
        onOpenSideChat?.();
        return;
      }
      const appId = payload.startsWith("conversation.open-with:")
        ? payload.slice("conversation.open-with:".length)
        : "";
      const app = catalog.find((entry) => entry.id === appId);
      if (!app || !isAvailable(app)) return;
      selectApp(app.id);
      void openWith(app.id);
    });
  });

  return (
    <div className="open-with-control" id="open-with-control">
      <button
        className="open-with-toggle"
        id="open-with-toggle"
        type="button"
        title="More"
        aria-label="More conversation actions"
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          void refreshInstalledApps();
          bridge().popupMenu(
            "conversation",
            Math.round(rect.left),
            Math.round(rect.bottom + 4),
            {
              hasSession: Boolean(activeItem),
              hasTarget: Boolean(target),
              pinned: Boolean(activeItem?.pinnedAt),
              archived: Boolean(activeItem?.archivedAt),
              selectedAppId: selectedId,
              apps: visibleApps.map((app) => ({ id: app.id, label: app.label })),
            },
          );
        }}
      >
        <MenuIcon name="more-horizontal" />
      </button>
    </div>
  );
}
