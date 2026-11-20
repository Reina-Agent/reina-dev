// File viewer pane — matches legacy file-viewer behavior:
// - mono font, CSS-counter line numbers (out of selection flow)
// - markdown preview / source toggle for .md/.mdx files
// - edit → save / cancel flow via writeWorkspaceFile
// - binary / truncated indicators
// - highlight.js syntax colouring for the source view (same "common" ESM bundle
//   + GitHub Dark theme the chat window uses), split back into per-line spans so
//   the CSS-counter line numbers still work and multi-line tokens stay coloured.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "@highlightjs/cdn-assets/es/highlight.min.js";
import { bridge } from "~/lib/bridge";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";
// Pulls in the .hljs-* token colours (GitHub Dark). The base .hljs rule doesn't
// apply here since our code element has no .hljs class — only the token spans do,
// so base text keeps var(--foreground) and only tokens get coloured.
import "../../../chat-styles/hljs-theme.css";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export interface FileResult {
  kind?: string;
  path: string;
  content: string;
  size: number;
  binary?: boolean;
  truncated?: boolean;
}

interface FileViewerProps {
  file: FileResult;
  cwd: string | undefined;
  onSaved?: (updated: FileResult) => void;
}

function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p);
}

function escHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Syntax highlighting ──────────────────────────────────────────────────────
// Map file extensions to highlight.js language ids when the extension isn't
// already an hljs alias. Anything not listed falls back to highlightAuto.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  rs: "rust", go: "go", rb: "ruby", php: "php", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", cfg: "ini", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less", sql: "sql", lua: "lua",
  dockerfile: "dockerfile", makefile: "makefile", diff: "diff", patch: "diff",
};

function langForPath(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_LANG[ext] ?? ext;
}

// Highlight whole content (so multi-line strings/comments colour correctly),
// then split the resulting HTML into per-line fragments, carrying any open
// <span> stack across newlines so each line is independently well-formed.
function highlightLines(content: string, path: string): string[] {
  let html: string;
  try {
    const lang = langForPath(path);
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(content).value;
  } catch {
    html = escHtml(content);
  }

  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  const re = /(<span[^>]*>)|(<\/span>)|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else {
      const parts = m[3].split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          cur += "</span>".repeat(open.length);
          lines.push(cur);
          cur = open.join("");
        }
        cur += parts[i];
      }
    }
  }
  lines.push(cur);
  return lines;
}

// ── Main component ───────────────────────────────────────────────────────────

export function FileViewer({ file, cwd, onSaved }: FileViewerProps) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mdMode, setMdMode] = useState<"preview" | "source">("preview");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset editing state when the viewed file changes
  useEffect(() => {
    setEditing(false);
    setEditContent("");
    setSaving(false);
    setSaveError(null);
  }, [file.path]);

  const canEdit = !file.binary && !file.truncated;
  const isMarkdown = isMarkdownPath(file.path);

  // Highlight the source view lazily; recompute only when the file body changes.
  const highlighted = useMemo(
    () => (file.binary ? [] : highlightLines(file.content ?? "", file.path)),
    [file.binary, file.content, file.path],
  );

  const beginEdit = useCallback(() => {
    if (!canEdit) return;
    setEditContent(file.content ?? "");
    setEditing(true);
    setSaveError(null);
    // focus textarea after paint
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [canEdit, file.content]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditContent("");
    setSaveError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!cwd || !editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await bridge().writeWorkspaceFile(cwd, file.path, editContent) as {
        path?: string;
        size?: number;
      } | null;
      const updated: FileResult = {
        kind: "file",
        path: (saved?.path ?? file.path) as string,
        content: editContent,
        size: (saved?.size ?? new TextEncoder().encode(editContent).length) as number,
        binary: false,
        truncated: false,
      };
      setEditing(false);
      setEditContent("");
      onSaved?.(updated);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [cwd, editing, editContent, file.path, onSaved]);

  const isDirty = editing && editContent !== (file.content ?? "");

  // ── meta bar ──────────────────────────────────────────────────────────────
  const metaParts: string[] = [formatBytes(file.size)];
  if (file.truncated) metaParts.push("truncated");
  if (file.binary) metaParts.push("binary");
  if (editing) metaParts.push(isDirty ? "editing, unsaved" : "editing");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* context sub-bar: meta + controls */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--surface-divider) bg-card/80 px-3 py-1">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground/70">
          {metaParts.join(" | ")}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* markdown toggle */}
          {isMarkdown && !editing && (
            <div
              className="flex items-center rounded-md border border-(--surface-divider) bg-secondary/40"
              role="group"
              aria-label="Markdown view"
            >
              <button
                type="button"
                onClick={() => setMdMode("preview")}
                aria-pressed={mdMode === "preview"}
                className={
                  `h-[22px] rounded-l-md px-2.5 text-[11px] transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                  (mdMode === "preview"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setMdMode("source")}
                aria-pressed={mdMode === "source"}
                className={
                  `h-[22px] rounded-r-md px-2.5 text-[11px] transition-colors duration-(--motion-fast) ${FOCUS_RING} ` +
                  (mdMode === "source"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                Source
              </button>
            </div>
          )}
          {/* edit / save / cancel */}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={beginEdit}
              className={`h-[22px] rounded-md border border-(--surface-divider) px-2.5 text-[11px] transition-colors duration-(--motion-fast) hover:bg-secondary ${FOCUS_RING}`}
            >
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={saving || !isDirty}
                className={`h-[22px] rounded-md border border-(--surface-divider) px-2.5 text-[11px] transition-colors duration-(--motion-fast) hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className={`h-[22px] rounded-md border border-(--surface-divider) px-2.5 text-[11px] transition-colors duration-(--motion-fast) hover:bg-secondary disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* error */}
      {saveError && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
          {saveError}
        </div>
      )}

      {/* content area */}
      {editing ? (
        <textarea
          ref={textareaRef}
          aria-label={`Edit ${file.path}`}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none border-0 bg-card p-3 font-mono text-[length:--code-font-size] leading-[19px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
          style={{ tabSize: 4 }}
        />
      ) : file.binary ? (
        <div className="flex flex-1 items-center justify-center p-6 text-xs italic text-muted-foreground">
          Binary file — cannot display
        </div>
      ) : isMarkdown && mdMode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <WorkspaceMarkdown
            source={file.content ?? ""}
            cwd={cwd}
            basePath={file.path}
            className="mx-auto min-h-full max-w-[860px] px-8 py-7"
          />
        </div>
      ) : (
        // Plain text / source view with CSS-counter line numbers.
        // The ::before pseudo on each line span shows the line number via
        // a CSS counter, which keeps it out of text selection (matches spec).
        <div
          className="flex-1 overflow-auto bg-card"
          // inline counter reset so the component is self-contained
          style={{ counterReset: "file-line" }}
        >
          <style>{`
            .ws-file-line {
              display: block;
              position: relative;
              min-height: 19px;
              padding: 0 24px 0 60px;
              white-space: pre;
              font-family: var(--font-mono-family, monospace);
              font-size: var(--code-font-size, 13px);
              line-height: 19px;
              counter-increment: file-line;
              color: var(--foreground);
              tab-size: 4;
            }
            .ws-file-line::before {
              content: counter(file-line);
              position: absolute;
              left: 0;
              width: 44px;
              padding-right: 10px;
              text-align: right;
              color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
              font-size: 11px;
              user-select: none;
              pointer-events: none;
            }
            .ws-file-line:hover {
              background: color-mix(in srgb, var(--secondary) 40%, transparent);
            }
          `}</style>
          <code className="block">
            {highlighted.map((line, i) => (
              <span
                key={i}
                className="ws-file-line"
                // hljs output is entity-escaped; spans are balanced per line.
                dangerouslySetInnerHTML={{ __html: line || " " }}
              />
            ))}
          </code>
        </div>
      )}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function FileViewerEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted-foreground/40">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14,2 14,8 20,8" />
      </svg>
      <div>
        <p className="font-medium text-foreground/70">No file open</p>
        <p className="mt-0.5 text-xs">Select a file in the explorer to view it here.</p>
      </div>
    </div>
  );
}
