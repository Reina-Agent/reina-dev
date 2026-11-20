import { useState } from "react";
import { useT } from "~/lib/i18n";
import { useUpdates } from "~/lib/useUpdates";
import { Button, FieldRow, Section } from "~/components/ui";

export function AboutPanel() {
  const t = useT();
  const { version, supported, status, percent, indeterminate, downloadFailed, check, download, install } = useUpdates();
  const [checking, setChecking] = useState(false);

  const onCheck = async () => {
    setChecking(true);
    try {
      await check();
    } finally {
      setChecking(false);
    }
  };

  // Status line shown under the version row. Live `auto-update-status` events
  // drive everything after the first user-initiated check.
  const statusLine = (() => {
    if (!supported) return t("updates.unsupported");
    if (checking || status.status === "checking") return t("updates.checking");
    switch (status.status) {
      case "available":
        return t("updates.available", { version: status.version });
      case "downloading":
        return t("updates.downloading", { percent: status.percent });
      case "downloaded":
        return t("updates.downloaded", { version: status.version });
      case "not-available":
        return t("updates.upToDate");
      case "error":
        // A failed download is not a failed check — mislabelling it hides what
        // actually went wrong (and the retry path differs).
        return status.duringDownload
          ? t("updates.downloadError", { detail: status.detail })
          : t("updates.error", { detail: status.detail });
      default:
        return t("updates.notChecked");
    }
  })();

  const canInstall = status.status === "downloaded";
  const canDownload = status.status === "available";
  const downloading = status.status === "downloading";

  return (
    <div className="pane-enter">
      <h1 className="text-base font-semibold">{t("about.title")}</h1>

      <div className="flex items-start justify-between gap-4 py-6">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">Reina</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("about.description")}</p>
        </div>
        <span className="shrink-0 pt-1 text-xs tabular-nums text-muted-foreground">
          {t("updates.currentVersion")} {version || "—"}
        </span>
      </div>

      <Section title={t("updates.section")} description={t("updates.autoNote")}>
        <FieldRow label={t("updates.status")} hint={statusLine}>
          {canInstall ? (
            <Button variant="accent" onClick={install}>
              {t("updates.restart")}
            </Button>
          ) : canDownload ? (
            <Button variant="accent" onClick={download}>
              {t("updates.download")}
            </Button>
          ) : downloadFailed ? (
            <Button variant="accent" onClick={download}>
              {t("updates.retry")}
            </Button>
          ) : (
            <Button onClick={onCheck} disabled={!supported || checking || downloading || status.status === "checking"}>
              {t("updates.check")}
            </Button>
          )}
        </FieldRow>

        {downloading && (
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "color-mix(in srgb, currentColor 14%, transparent)" }}
          >
            <div
              className={
                "h-full rounded-full " +
                (indeterminate ? "w-2/5 motion-safe:animate-pulse" : "transition-[width] duration-200")
              }
              style={{
                background: "var(--accent)",
                ...(indeterminate ? null : { width: `${percent}%` }),
              }}
            />
          </div>
        )}
      </Section>
    </div>
  );
}
