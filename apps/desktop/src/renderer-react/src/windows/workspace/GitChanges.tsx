// Git changes list panel — mirrors legacy renderChangesView behavior.
// change.status letter codes follow git status porcelain format.

export interface GitChange {
  path: string;
  status: string;
}

interface GitChangesProps {
  changes: GitChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function statusColor(status: string): string {
  if (status.includes("A") || status.includes("?")) return "text-green-400";
  if (status.includes("D")) return "text-red-400";
  return "text-yellow-400";
}

// Short display path: last 2 path segments to keep it compact, matching
// legacy shortPath() which trims the cwd prefix and then clips to 2 segs.
function shortPath(p: string): string {
  const parts = p.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

// Inline SVG icons for add/remove/dot (mirrors legacy changeIconName)
function StatusIcon({ status }: { status: string }) {
  if (status.includes("A") || status.includes("?")) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status.includes("D")) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <circle cx="6" cy="6" r="3" />
    </svg>
  );
}

export function GitChanges({ changes, selectedPath, onSelect }: GitChangesProps) {
  if (changes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs italic text-muted-foreground">
        No git changes
      </div>
    );
  }

  const shown = changes.slice(0, 80);

  return (
    <div className="flex flex-col gap-0.5 overflow-auto p-1.5 pb-3">
      {shown.map((change) => {
        const isActive = change.path === selectedPath;
        const color = statusColor(change.status);
        return (
          <button
            key={change.path}
            type="button"
            title={change.path}
            aria-label={`${change.status} ${change.path}`}
            onClick={() => onSelect(change.path)}
            className={
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors duration-(--motion-fast) " +
              (isActive
                ? "bg-secondary text-foreground"
                : "hover:bg-secondary/60")
            }
          >
            {/* status icon */}
            <span className={`flex w-[14px] shrink-0 items-center justify-center ${color}`}>
              <StatusIcon status={change.status} />
            </span>
            {/* path */}
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
              {shortPath(change.path)}
            </span>
            {/* status badge */}
            <span
              className={
                "shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold leading-[18px] bg-secondary/80 " +
                color
              }
            >
              {change.status}
            </span>
          </button>
        );
      })}
    </div>
  );
}
