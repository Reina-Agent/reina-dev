import { useMemo, useState } from "react";
import type { ContextRequestDetail } from "@reina/protocol";
import { useT } from "~/lib/i18n";
import { contextFileActivity, type ContextFileKind, type ContextFileOperation } from "./contextFileActivityModel";

const BUTTON = "rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";
const KINDS: ContextFileKind[] = ["read", "write", "search", "image"];

function Operation({ operation }: { operation: ContextFileOperation }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <details className="context-disclosure" onToggle={(event) => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    <summary className={`flex flex-wrap gap-2 py-1.5 ${BUTTON}`}>
      <span>{operation.tool}</span>
      <span className="text-muted-foreground">{t(`context.files.kind.${operation.kind}`)}</span>
      <span className={operation.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{t(`context.files.status.${operation.status}`)}</span>
    </summary>
    {open && <div className="mb-2 space-y-2 rounded border border-border/60 bg-secondary/15 p-2 text-xs">
      {operation.input !== undefined && <div>
        <div className="mb-1 text-muted-foreground">{t("context.files.arguments")}</div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{(typeof operation.input === "string" ? operation.input : JSON.stringify(operation.input, null, 2)).slice(0, 12_000)}</pre>
      </div>}
      {operation.output && <div>
        <div className="mb-1 text-muted-foreground">{t("context.files.result")}</div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{operation.output.slice(0, 12_000)}</pre>
      </div>}
      {operation.error && <p className="whitespace-pre-wrap break-words text-destructive">{operation.error.slice(0, 4_000)}</p>}
      <p className="text-muted-foreground">{t("context.files.previewLimit")}</p>
    </div>}
  </details>;
}

export function ContextFileActivity({ detail }: { detail: ContextRequestDetail }) {
  const t = useT();
  const activity = useMemo(() => contextFileActivity(detail), [detail]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ContextFileKind | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = activity.files.filter((file) => (!kind || file.counts[kind] > 0) && file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="context-card min-w-0 space-y-2" aria-label={t("context.files.title")}>
    <h3 className="text-xs font-medium">{t("context.files.title")}</h3>
    <p className="text-[10px] leading-4 text-muted-foreground">{t("context.files.scope")}</p>
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("context.files.filter")}>
        <button type="button" aria-pressed={kind === null} onClick={() => setKind(null)} className={`${BUTTON} ${kind === null ? "bg-secondary text-foreground" : ""}`}>{t("context.files.all")} {activity.files.length}</button>
        {KINDS.map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(kind === value ? null : value)}
          className={`${BUTTON} ${kind === value ? "bg-secondary text-foreground" : ""}`}>{t(`context.files.kind.${value}`)} {activity.counts[value]}</button>)}
      </div>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("context.files.search")} aria-label={t("context.files.search")}
        className="min-w-0 flex-[1_1_140px] rounded-md border border-border bg-background px-2 py-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" />
    </div>
    {(activity.unresolved > 0 || activity.truncated) && <p className="text-[10px] leading-4 text-muted-foreground">
      {activity.unresolved > 0 ? t("context.files.unresolved", { count: activity.unresolved }) : ""} {activity.truncated ? t("context.files.truncated") : ""}
    </p>}
    <div className="context-file-list divide-y divide-border/60">
      {visible.map((file) => <div key={file.path}>
        <button type="button" aria-expanded={expanded === file.path} onClick={() => setExpanded(expanded === file.path ? null : file.path)} className={`flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 py-2 text-left ${BUTTON}`}>
          <span aria-hidden className="text-muted-foreground">{expanded === file.path ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 break-words text-foreground">{file.path}</span>
          {KINDS.filter((value) => file.counts[value] > 0).map((value) => <span key={value}>{t(`context.files.kind.${value}`)} {file.counts[value]}</span>)}
        </button>
        {expanded === file.path && <div className="min-w-0 pl-3">
          {file.operations.filter((operation) => !kind || operation.kind === kind).map((operation) => <Operation key={`${detail.request.id}:${operation.id}`} operation={operation} />)}
        </div>}
      </div>)}
      {!visible.length && <p className="py-3 text-xs text-muted-foreground">{t(activity.files.length ? "context.files.noMatch" : "context.files.empty")}</p>}
    </div>
  </section>;
}
