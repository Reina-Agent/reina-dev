import { useCallback, useSyncExternalStore } from "react";
import { bridge, type UpdateInfo, type UpdateStatus } from "~/lib/bridge";

// Shared auto-update state for the settings panel, sidebar badge and progress
// toast. A module-level singleton: the window subscribes to the live
// `auto-update-status` broadcast ONCE and fetches the getUpdateInfo() snapshot
// ONCE, no matter how many components mount the hook — per-consumer copies
// would multiply the setState fan-out of every progress event.

interface UpdatesState {
  version: string;
  supported: boolean;
  status: UpdateStatus;
  // The pending update's version. Statuses that know it carry a `version`
  // field; keep the last seen one so phases without it stay labelled.
  pendingVersion: string;
}

let state: UpdatesState = {
  version: "",
  supported: true,
  status: { status: "idle" },
  pendingVersion: "",
};
const listeners = new Set<() => void>();
let started = false;

function setState(patch: Partial<UpdatesState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

function applyStatus(next: UpdateStatus): void {
  const patch: Partial<UpdatesState> = { status: next };
  if ("version" in next && next.version) patch.pendingVersion = next.version;
  else if (next.status === "not-available" || next.status === "unsupported" || next.status === "idle") {
    // No pending update anymore — don't keep showing a stale version.
    patch.pendingVersion = "";
  }
  setState(patch);
}

function start(): void {
  if (started) return;
  started = true;
  // The snapshot (getUpdateInfo) and live events race. If a live event lands
  // first, it's newer than the snapshot — so apply the snapshot's STATUS only
  // when no event has arrived yet, or a late snapshot could clobber it (e.g.
  // revert "downloaded" back to "downloading" and stick). version/supported
  // come only from the snapshot, so always apply those.
  let sawEvent = false;
  void bridge()
    .getUpdateInfo()
    .then((info: UpdateInfo) => {
      setState({ version: info.version, supported: info.supported });
      if (!sawEvent) applyStatus(info.status);
    })
    .catch(() => undefined);
  // Window-lifetime subscription — deliberately never unsubscribed.
  bridge().events.on("auto-update-status", (payload) => {
    if (payload && typeof payload === "object" && "status" in payload) {
      sawEvent = true;
      applyStatus(payload as UpdateStatus);
    }
  });
}

function subscribe(onChange: () => void): () => void {
  start();
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useUpdates() {
  const snap = useSyncExternalStore(subscribe, () => state);

  const st = snap.status;
  const percent = st.status === "downloading" ? Math.max(0, Math.min(100, Math.floor(st.percent))) : 0;
  // No byte transferred yet (connecting / waiting for headers): consumers show
  // an indeterminate sweep instead of a bar frozen at 0%, which reads as "stuck".
  const indeterminate = st.status === "downloading" && percent <= 0;
  // A failed *download* (worth a prominent retry) vs a quiet check error.
  const downloadFailed = st.status === "error" && st.duringDownload;

  const check = useCallback(() => bridge().checkUpdate().catch(() => ({ updateAvailable: false })), []);
  const download = useCallback(() => void bridge().downloadUpdate().catch(() => undefined), []);
  const install = useCallback(() => void bridge().installUpdate().catch(() => undefined), []);

  return {
    version: snap.version,
    supported: snap.supported,
    status: snap.status,
    pendingVersion: snap.pendingVersion,
    percent,
    indeterminate,
    downloadFailed,
    check,
    download,
    install,
  };
}
