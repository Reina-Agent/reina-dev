import { useT } from "~/lib/i18n";
import { useUpdates } from "~/lib/useUpdates";

// Small "更新" badge in the sidebar footer (Codex-style). The subtle, persistent
// entry point: appears when an update is available, actively downloading
// (showing live %), already downloaded, or a download failed. Clicking starts
// the download, or — once downloaded — restarts to install. It stays visible
// through the whole download so dismissing the popup never strands the user.
export function UpdateSidebarButton() {
  const t = useT();
  const { status, pendingVersion, percent, indeterminate, downloadFailed, download, install } = useUpdates();
  const phase = status.status;
  // A failed download stays actionable here as a "retry"; quiet background check
  // errors don't surface in the sidebar.
  const errored = downloadFailed;
  const downloading = phase === "downloading";

  if (phase !== "available" && phase !== "downloaded" && !downloading && !errored) return null;

  const ready = phase === "downloaded";
  const variant = ready ? " is-ready" : errored ? " is-error" : downloading ? " is-downloading" : "";

  const label = errored
    ? t("updates.retry")
    : downloading
      ? `${percent}%`
      : t("updateBadge.label");
  const title = ready
    ? t("updateBadge.ready", { version: pendingVersion })
    : errored
      ? t("updateBadge.retry", { version: pendingVersion })
      : downloading
        ? t("updateBadge.downloading", { version: pendingVersion, percent })
        : t("updateBadge.available", { version: pendingVersion });

  return (
    <button
      type="button"
      className={"sidebar-update-badge" + variant}
      onClick={ready ? install : download}
      // Inert while downloading — the badge is a live status pill, not a control.
      disabled={downloading}
      title={title}
    >
      {downloading && (
        <span
          className={"sidebar-update-badge-fill" + (indeterminate ? " is-indeterminate" : "")}
          style={indeterminate ? undefined : { width: `${percent}%` }}
          aria-hidden
        />
      )}
      <span className="sidebar-update-badge-label">{label}</span>
    </button>
  );
}
