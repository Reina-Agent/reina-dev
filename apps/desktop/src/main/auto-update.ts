import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, Notification } from "electron";
import { autoUpdater, type AppUpdater } from "electron-updater";

// Self-contained auto-update engine, modelled on Alma's electron-updater wiring.
//
// Feed: GitHub Releases (the public mirror repo configured under `build.publish`
// in the root package.json). electron-builder bakes that into `app-update.yml`
// inside the packaged app's resources; electron-updater reads it at runtime.
//
// Scope: Windows only for now. macOS auto-update requires a signed + notarised
// app (Squirrel.Mac refuses unsigned updates) and the build currently ships
// unsigned (`build.mac.identity: null`), so we report "unsupported" there rather
// than surface runtime errors. Lift SUPPORTED_PLATFORMS once signing lands.

export type AutoUpdateStatus =
  | { status: "idle" }
  | { status: "unsupported"; detail: string }
  | { status: "checking"; triggeredByUser: boolean }
  | { status: "available"; version: string; triggeredByUser: boolean }
  | { status: "not-available"; triggeredByUser: boolean }
  // downloading/error carry the pending version (when known) so a window that
  // mounts mid-download can still render it — the renderer must not have to
  // reconstruct it from event history it never saw.
  | { status: "downloading"; percent: number; version?: string; triggeredByUser: boolean }
  | { status: "downloaded"; version: string; triggeredByUser: boolean }
  // duringDownload distinguishes a failed user download (worth a prominent retry
  // in the main window) from a quiet background check error (settings panel only).
  | { status: "error"; detail: string; version?: string; triggeredByUser: boolean; duringDownload: boolean };

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["win32"]);
const UNSUPPORTED_DETAIL = "Auto-update is only available on Windows distribution builds.";
const FIRST_CHECK_DELAY_MS = 3_000;
const CHECK_INTERVAL_MS = 30 * 60_000;

type LogFn = (message: string) => void;

let log: LogFn = () => {};
let initialized = false;
let configured = false;
let triggeredByUser = false;
let status: AutoUpdateStatus | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let checkRunning = false;

/** A download is running or already finished — i.e. we've committed to this
 * update. Periodic re-checks must not knock this back to "available" (which
 * would let the UI start a second download), and downloadUpdate() must be a
 * no-op while it holds. */
function updateInFlight(): boolean {
  return status?.status === "downloading" || status?.status === "downloaded";
}

/** The pending update's version, carried forward from whichever status last
 * knew it (available → downloading → error), so every broadcast in a download's
 * lifecycle names the version. */
function knownVersion(): string | undefined {
  return status && "version" in status ? status.version : undefined;
}

/** Path to an optional dev feed config, letting us exercise the updater from an
 * unpackaged `npm run desktop` build (mirrors Alma's `dev-app-update.yml`). */
function devConfigPath(): string {
  return path.join(app.getAppPath(), "dev-app-update.yml");
}

/** Dev-only "exercise the updater" switch, set by `start-desktop.cmd
 * --update-test`. Forces the public GitHub mirror feed and a fake-old current
 * version so any published release looks like an available update — no need to
 * hand-edit package.json or drop a dev-app-update.yml. */
function isUpdateTestMode(): boolean {
  return !app.isPackaged && /^(1|true|on|yes)$/i.test(process.env.REINA_UPDATE_TEST ?? "");
}

/** True only when a real feed exists: a packaged build with a baked
 * `app-update.yml`, a dev build that opted in via `dev-app-update.yml`, or the
 * dev `--update-test` switch. */
function isSupported(): boolean {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) return false;
  if (isUpdateTestMode()) return true;
  if (app.isPackaged) return existsSync(path.join(process.resourcesPath, "app-update.yml"));
  return existsSync(devConfigPath());
}

function broadcast(next: AutoUpdateStatus): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("reina:event:auto-update-status", next);
    } catch {
      // A window can tear down between the guard and the send; ignore.
    }
  }
}

/** Lazily configure the shared electron-updater instance the first time we need
 * it. Returns the AppUpdater, or null when no feed is available. */
function getUpdater(): AppUpdater | null {
  if (!isSupported()) return null;
  if (!configured) {
    configured = true;
    autoUpdater.logger = {
      info: (m: unknown) => log(`[auto-update] ${String(m)}`),
      warn: (m: unknown) => log(`[auto-update] WARN ${String(m)}`),
      error: (m: unknown) => log(`[auto-update] ERROR ${String(m)}`),
      debug: () => {},
    };
    // Do NOT auto-download. Checking only surfaces an "available" status; the
    // user explicitly confirms via downloadUpdate(). Once downloaded, it still
    // installs on quit (or immediately via installUpdate()).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    if (isUpdateTestMode()) {
      // Write the public mirror feed to a throwaway temp config and point the
      // updater at it (electron-updater's native dev path) — no repo file and no
      // package.json edit needed. updateConfigPath also rebuilds the on-disk
      // config loader, so getUpdateInfoAndProvider reads THIS file.
      try {
        const cfgPath = path.join(app.getPath("temp"), "reina-update-test.yml");
        writeFileSync(cfgPath, "provider: github\nowner: Reina-Agent\nrepo: Reina\n");
        autoUpdater.updateConfigPath = cfgPath;
      } catch (error) {
        log(`[auto-update] TEST MODE: failed to write temp feed config: ${error instanceof Error ? error.message : String(error)}`);
      }
      autoUpdater.forceDevUpdateConfig = true;
      // Pretend we're on an ancient version so any published release reads as an
      // update. currentVersion is set once in electron-updater's constructor and
      // only READ during checks, so overriding it here sticks. Reuse its own
      // SemVer (off the existing instance) to avoid a separate `semver` import.
      // The property is typed readonly but is a plain writable field at runtime.
      try {
        const cur = autoUpdater.currentVersion;
        const SemVerCtor = cur.constructor as new (v: string) => typeof cur;
        (autoUpdater as { currentVersion: typeof cur }).currentVersion = new SemVerCtor("0.0.0");
      } catch {
        // Fall back to the app version; worst case the check finds no update.
      }
      log("[auto-update] TEST MODE: GitHub mirror feed (temp config), currentVersion=0.0.0");
    } else if (!app.isPackaged && existsSync(devConfigPath())) {
      autoUpdater.updateConfigPath = devConfigPath();
      autoUpdater.forceDevUpdateConfig = true;
      log(`[auto-update] using dev feed config: ${devConfigPath()}`);
    }
    wireEvents(autoUpdater);
  }
  return autoUpdater;
}

function wireEvents(updater: AppUpdater): void {
  updater.on("checking-for-update", () => {
    log("[auto-update] checking for updates");
    if (updateInFlight()) return;
    // A background re-check must not knock a known "available" back to
    // "checking" — the sidebar badge / download CTA would blink out for the
    // whole network round-trip, every poll interval.
    if (status?.status === "available" && !triggeredByUser) return;
    broadcast({ status: "checking", triggeredByUser });
  });
  updater.on("update-available", (info) => {
    log(`[auto-update] update available: ${info.version}`);
    // A periodic re-check re-emits this for the same release; ignore it once a
    // download is underway/done so the UI can't trigger a second download.
    if (updateInFlight()) return;
    broadcast({ status: "available", version: info.version, triggeredByUser });
  });
  updater.on("update-not-available", () => {
    log("[auto-update] no update available");
    if (updateInFlight()) return;
    broadcast({ status: "not-available", triggeredByUser });
  });
  updater.on("download-progress", (progress) => {
    // A late/buffered progress event must not knock a terminal state back to
    // "downloading": after "downloaded" it would hide the restart action; after
    // "error" it would strand updateInFlight() as true forever (Retry becomes a
    // no-op, polls skip, nothing ever leaves "downloading" again).
    if (status?.status === "downloaded" || status?.status === "error") return;
    const percent = Math.round(progress.percent);
    // electron-updater emits per received chunk; only fan out to the windows
    // when the rounded percent actually moved.
    if (status?.status === "downloading" && status.percent === percent) return;
    broadcast({ status: "downloading", percent, version: knownVersion(), triggeredByUser });
  });
  updater.on("update-downloaded", (info) => {
    log(`[auto-update] update downloaded: ${info.version}`);
    // We have the installer; stop polling so nothing re-checks/re-downloads.
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    broadcast({ status: "downloaded", version: info.version, triggeredByUser });
    // Best-effort native nudge so a downloaded update is visible even without
    // any in-app UI wired to the status events yet.
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: `Reina ${info.version} ready`,
          body: "A new version has been downloaded. It will install when you quit Reina.",
          silent: true,
        }).show();
      } catch {
        // Notification failures are cosmetic.
      }
    }
  });
  updater.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[auto-update] error: ${detail}`);
    // A transient re-check failure must not clobber a state the user can act
    // on: "available" (a network blip would remove the download CTA until the
    // next poll) or "downloaded" (the restart prompt would vanish).
    if (status?.status === "available" || status?.status === "downloaded") return;
    // We were mid-download iff the status was "downloading" when this fired.
    // This is the single source for ALL errors (electron-updater emits "error"
    // for download failures too), so downloadUpdate() doesn't re-broadcast.
    broadcast({ status: "error", detail, version: knownVersion(), triggeredByUser, duringDownload: status?.status === "downloading" });
  });
}

/** Current status for `checkUpdate`-style polling. Lazily settles to idle /
 * unsupported before the first event fires. */
export function getAutoUpdateStatus(): AutoUpdateStatus {
  if (status) return status;
  status = isSupported() ? { status: "idle" } : { status: "unsupported", detail: UNSUPPORTED_DETAIL };
  return status;
}

/** The product version to display. In a packaged build app.getVersion() reads
 * the baked-in root package.json (correct). In dev, the loaded app dir is
 * apps/desktop, so app.getVersion() returns that workspace's version (e.g.
 * 0.1.0) — not the product version — so read the repo-root package.json instead. */
function productVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    const rootPkg = path.join(app.getAppPath(), "..", "..", "package.json");
    const version = (JSON.parse(readFileSync(rootPkg, "utf8")) as { version?: unknown }).version;
    if (typeof version === "string" && version) return version;
  } catch {
    // Fall back to app.getVersion() below.
  }
  return app.getVersion();
}

/** Snapshot for the renderer (settings panel + top banner) on first render,
 * before any live `auto-update-status` event arrives. */
export function getUpdateInfo(): { version: string; supported: boolean; status: AutoUpdateStatus } {
  return { version: productVersion(), supported: isSupported(), status: getAutoUpdateStatus() };
}

/** Start background update checks. Safe to call once at startup; a no-op when no
 * feed is available (dev without dev-app-update.yml, non-Windows, etc.). */
export function initAutoUpdate(logFn: LogFn): void {
  log = logFn;
  if (initialized) return;
  initialized = true;
  const updater = getUpdater();
  if (!updater) {
    log(`[auto-update] disabled: ${getAutoUpdateStatus().status === "unsupported" ? UNSUPPORTED_DETAIL : "no feed"}`);
    return;
  }
  setTimeout(() => void runCheck(false), FIRST_CHECK_DELAY_MS);
  checkTimer = setInterval(() => void runCheck(false), CHECK_INTERVAL_MS);
  app.once("before-quit", () => {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
  });
}

async function runCheck(byUser: boolean): Promise<{ updateAvailable: boolean; version?: string }> {
  const updater = getUpdater();
  if (!updater) return { updateAvailable: false };
  // Don't let a background poll touch the network (or events) once we've already
  // committed to downloading/installing this update.
  if (!byUser && updateInFlight()) {
    const version = status && "version" in status ? status.version : undefined;
    return { updateAvailable: true, version };
  }
  // Never run two checks at once. Overlapping checks share the module-level
  // `triggeredByUser` flag (so events would get mislabeled) and double the
  // network round-trips (e.g. a user click landing on a 30-min background poll).
  if (checkRunning) return { updateAvailable: false };
  checkRunning = true;
  triggeredByUser = byUser;
  try {
    const result = await updater.checkForUpdates();
    const version = result?.updateInfo?.version;
    // Compare against the updater's OWN current version, not app.getVersion():
    // they diverge in dev, and `--update-test` overrides currentVersion to 0.0.0.
    const current = updater.currentVersion?.version ?? app.getVersion();
    const updateAvailable = !!version && version !== current;
    return updateAvailable ? { updateAvailable, version } : { updateAvailable: false };
  } catch (error) {
    log(`[auto-update] check failed: ${error instanceof Error ? error.message : String(error)}`);
    return { updateAvailable: false };
  } finally {
    triggeredByUser = false;
    checkRunning = false;
  }
}

/** User-triggered "check for updates now". With autoDownload off this only
 * reports availability; the actual download waits for downloadUpdate(). */
export function checkForUpdates(): Promise<{ updateAvailable: boolean; version?: string }> {
  return runCheck(true);
}

/** Start downloading the available update — only after the user has confirmed.
 * Idempotent: a second call while a download is running (or finished) is a
 * no-op, so a double-click can't kick off two downloads. */
export function downloadUpdate(): void {
  const updater = getUpdater();
  if (!updater) return;
  if (updateInFlight()) return;
  // Optimistically flip to downloading NOW (before the first progress event) so
  // updateInFlight() guards re-entry synchronously and the popup shows at once.
  broadcast({ status: "downloading", percent: 0, version: knownVersion(), triggeredByUser: true });
  // Only log here — electron-updater also emits the "error" event for download
  // failures, and that handler is the single broadcast source (so we don't race
  // it and risk a wrong duringDownload flag).
  updater.downloadUpdate().catch((error) => {
    log(`[auto-update] download failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Quit and install a downloaded update immediately. */
export function installUpdate(): void {
  const updater = getUpdater();
  if (!updater) return;
  // (isSilent=false, isForceRunAfter=true) — show the installer UI, relaunch.
  updater.quitAndInstall(false, true);
}
