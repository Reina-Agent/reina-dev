// Diff view pane — mirrors legacy renderDiffView + splitDiffLine/unifiedDiffLine.
// Receives a parsed diff object and renders it in unified or split mode.

export interface DiffResult {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  binary?: boolean;
}

export type DiffMode = "unified" | "split";

interface DiffViewProps {
  diff: DiffResult | null;
  mode: DiffMode;
  loading?: boolean;
}

// ── Line classification (matches legacy diffLineClass) ──────────────────────

type LineClass = "added" | "removed" | "hunk" | "meta-line" | "context";

function lineClass(line: string): LineClass {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  if (line.startsWith("diff --git") || line.startsWith("# ")) return "meta-line";
  return "context";
}

// Tailwind classes for each line class. Diff tints use success/destructive
// tokens at /15 opacity, as permitted by the conventions.
const LINE_BG: Record<LineClass, string> = {
  added: "bg-green-500/10",
  removed: "bg-red-500/10",
  hunk: "bg-secondary/50",
  "meta-line": "bg-secondary/30",
  context: "",
};

const LINE_TEXT: Record<LineClass, string> = {
  added: "text-green-400",
  removed: "text-red-400",
  hunk: "text-muted-foreground",
  "meta-line": "text-muted-foreground/70",
  context: "text-foreground",
};

// ── Unified row ─────────────────────────────────────────────────────────────

function UnifiedRow({ line, lineNumber }: { line: string; lineNumber: number }) {
  const cls = lineClass(line);
  return (
    <div className={`flex min-h-[19px] w-max min-w-full ${LINE_BG[cls]}`}>
      {/* line number — sticky left */}
      <span className="sticky left-0 z-[1] w-[42px] shrink-0 select-none border-r border-(--surface-divider) bg-inherit pr-2 text-right font-mono text-[11px] text-muted-foreground/50 tabular-nums">
        {lineNumber}
      </span>
      {/* code */}
      <span className={`min-w-0 flex-1 whitespace-pre px-2 font-mono text-[12.5px] leading-[19px] ${LINE_TEXT[cls]}`}>
        {line || " "}
      </span>
    </div>
  );
}

// ── Split row ────────────────────────────────────────────────────────────────

function SplitRow({ line, lineNumber }: { line: string; lineNumber: number }) {
  const cls = lineClass(line);
  const isAdd = cls === "added";
  const isRem = cls === "removed";

  const leftNum = isAdd ? "" : String(lineNumber);
  const rightNum = isRem ? "" : String(lineNumber);
  const leftText = isAdd ? "" : line || " ";
  const rightText = isRem ? "" : line || " ";
  const leftCls = isAdd ? "" : LINE_BG[cls];
  const rightCls = isRem ? "" : LINE_BG[cls];

  return (
    <div className="flex min-h-[19px] w-full">
      {/* left number */}
      <span className="w-[42px] shrink-0 select-none border-r border-(--surface-divider) pr-2 text-right font-mono text-[11px] text-muted-foreground/50 tabular-nums">
        {leftNum}
      </span>
      {/* left code */}
      <span className={`min-w-0 flex-1 overflow-hidden border-r border-(--surface-divider) whitespace-pre px-2 font-mono text-[12.5px] leading-[19px] ${leftCls} ${isRem ? LINE_TEXT["removed"] : LINE_TEXT[cls]}`}>
        {leftText || " "}
      </span>
      {/* right number */}
      <span className="w-[42px] shrink-0 select-none border-r border-(--surface-divider) pr-2 text-right font-mono text-[11px] text-muted-foreground/50 tabular-nums">
        {rightNum}
      </span>
      {/* right code */}
      <span className={`min-w-0 flex-1 overflow-hidden whitespace-pre px-2 font-mono text-[12.5px] leading-[19px] ${rightCls} ${isAdd ? LINE_TEXT["added"] : LINE_TEXT[cls]}`}>
        {rightText || " "}
      </span>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

// Short display path for the diff header title
function shortPath(p: string): string {
  const parts = p.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export function DiffView({ diff, mode, loading }: DiffViewProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading diff…
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted-foreground/40">
          <path d="M6 3v12" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" />
          <path d="M18 9v3a6 6 0 01-6 6H9" />
        </svg>
        <div>
          <p className="font-medium text-foreground/70">No change selected</p>
          <p className="mt-0.5 text-xs">Select a change to review it here.</p>
        </div>
      </div>
    );
  }

  const lines = diff.diff.split(/\r?\n/);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* sticky header */}
      <div className="sticky top-0 z-[2] flex min-h-[34px] items-center justify-between gap-4 border-b border-(--surface-divider) bg-card/95 px-3.5 backdrop-blur-sm">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium text-foreground">
          {shortPath(diff.path)}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-green-400/80">
          +{diff.additions} -{diff.deletions}
        </span>
      </div>

      {/* diff content */}
      <div className={`flex-1 overflow-auto bg-background font-mono text-[12.5px] ${mode === "split" ? "" : "scrollbar-stable"}`}>
        {diff.binary ? (
          <div className="p-3.5 text-xs italic text-muted-foreground">{diff.diff}</div>
        ) : lines.length === 0 || (lines.length === 1 && lines[0] === "") ? (
          <div className="p-3.5 text-xs italic text-muted-foreground">Empty diff</div>
        ) : (
          lines.map((line, i) =>
            mode === "split" ? (
              <SplitRow key={i} line={line} lineNumber={i + 1} />
            ) : (
              <UnifiedRow key={i} line={line} lineNumber={i + 1} />
            ),
          )
        )}
      </div>
    </div>
  );
}
