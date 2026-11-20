import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { ensureFileIcons, fileIconName, folderIconName } from "./fileIcons";

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  depth: number;
}

interface FileTreeProps {
  files: FileEntry[];
  activeFilePath: string | null;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  onFileClick: (path: string) => void;
  onDirToggle: (path: string) => void;
}

function normPath(p: string): string {
  return p.replaceAll("\\", "/");
}

// ChevronRight icon (10x10)
function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className={className}>
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// SpinnerIcon (10x10) for loading dirs
function Spinner({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={className}>
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.25" strokeDasharray="5.5 4" strokeLinecap="round" />
    </svg>
  );
}

export function FileTree({ files, activeFilePath, expandedDirs, loadingDirs, onFileClick, onDirToggle }: FileTreeProps) {
  // Load the vscode-icons set once; re-render with real icons when ready. Until
  // then the icon column stays blank (no name handed to <Icon> → no API fetch).
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureFileIcons().then(() => { if (alive) setIconsReady(true); });
    return () => { alive = false; };
  }, []);

  const handleRowClick = useCallback((entry: FileEntry) => {
    if (entry.type === "directory") {
      onDirToggle(entry.path);
    } else {
      onFileClick(entry.path);
    }
  }, [onFileClick, onDirToggle]);

  if (files.length === 0) {
    return (
      <div className="px-3 py-2 text-xs italic text-muted-foreground">
        No files found.
      </div>
    );
  }

  // Determine which dirs have visible children in this render pass
  const visiblePaths = new Set(files.map((f) => normPath(f.path)));

  // Build visible list: show a file/dir entry only when all its ancestor dirs
  // are expanded (mirrors legacy toggleDir / renderFiles logic).
  const visible = files.filter((entry) => {
    const norm = normPath(entry.path);
    const parts = norm.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (!expandedDirs.has(ancestor)) return false;
    }
    return true;
  });

  // Suppress unused variable warning
  void visiblePaths;

  return (
    <div className="flex flex-col gap-0 overflow-auto py-1.5">
      {visible.map((entry) => {
        const norm = normPath(entry.path);
        const isDir = entry.type === "directory";
        const isExpanded = isDir && expandedDirs.has(norm);
        const isLoading = isDir && loadingDirs.has(norm);
        const isActive = !isDir && normPath(activeFilePath ?? "") === norm;
        const indent = entry.depth * 12 + 6; // px
        const label = entry.path.split(/[/\\]/).pop() ?? entry.path;
        const iconName = isDir
          ? folderIconName(label, isExpanded)
          : fileIconName(label);

        return (
          <button
            key={norm}
            type="button"
            onClick={() => handleRowClick(entry)}
            title={entry.path}
            style={{ paddingLeft: `${indent}px` }}
            className={
              "flex w-full min-h-[26px] items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors duration-(--motion-fast) " +
              (isActive
                ? "bg-secondary text-foreground"
                : isDir
                  ? "text-foreground hover:bg-secondary/60"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
            }
          >
            {/* chevron / spinner column — always 12px wide */}
            <span className="flex w-[12px] shrink-0 items-center justify-center text-muted-foreground/60">
              {isDir && isLoading ? (
                <Spinner className="animate-spin" />
              ) : isDir ? (
                <ChevronRight
                  className={"transition-transform duration-(--motion-fast) " + (isExpanded ? "rotate-90" : "")}
                />
              ) : null}
            </span>
            {/* type icon (vscode-icons) — blank until the set loads */}
            <span className="flex w-[16px] shrink-0 items-center justify-center">
              {iconsReady ? <Icon icon={iconName} width={16} height={16} /> : null}
            </span>
            {/* label */}
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
