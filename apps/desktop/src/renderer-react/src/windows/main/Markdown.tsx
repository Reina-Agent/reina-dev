// Markdown.tsx — assistant chat markdown rendered with react-markdown (React
// elements, NOT dangerouslySetInnerHTML). The legacy markdown-it pipeline
// replaced the whole message subtree + re-ran hljs on every streamed token,
// tearing down and rebuilding the DOM → the per-token flash. react-markdown
// produces React elements so React reconciles in place; code blocks colour via
// Shiki's JS engine (see CodeBlock / shikiHighlighter), which is CSP-safe.
//
// The output DOM matches what chat.css targets: standard prose tags under
// `.entry.assistant`, `.code-block` fenced blocks (CodeBlock), and
// `.entry-path-link` anchors for bare workspace paths. remark-gfm + remark-breaks
// mirror the legacy markdown-it `linkify`/`breaks`/task-list behaviour.

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { bridge } from "~/lib/bridge";
import { CodeBlock } from "./CodeBlock";
import { getMainState } from "./sessionStore";

// ─── File-path linkify (remark plugin) ───────────────────────────────────────
// Turn bare workspace paths like `apps/desktop/src/foo.ts:42` in prose into
// `.entry-path-link` anchors. Operates on mdast `text` nodes only, so paths
// inside `code`/`inlineCode` nodes (different node types) stay literal.

const FILE_PATH_RE =
  /(?<![/\w.])((?:[\w\-]+[/\\])+[\w\-.]+\.[a-zA-Z][a-zA-Z0-9]{0,7})(?::(\d+)(?:[-:](\d+))?)?(?![a-zA-Z0-9])/g;

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
  [k: string]: unknown;
}

function splitFilePaths(text: string): MdNode[] | null {
  if (!text.includes("/") && !text.includes("\\")) return null;
  FILE_PATH_RE.lastIndex = 0;
  if (!FILE_PATH_RE.test(text)) return null;
  FILE_PATH_RE.lastIndex = 0;

  const out: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    const whole = m[0];
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({
      type: "link",
      url: whole,
      data: { hProperties: { className: "entry-path-link" } },
      children: [{ type: "text", value: whole }],
    });
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function remarkFilePaths() {
  return (tree: MdNode) => {
    const walk = (node: MdNode, parent: MdNode | null): void => {
      if (node.type === "text" && parent && parent.type !== "link" && parent.children) {
        const replaced = splitFilePaths(node.value ?? "");
        if (replaced) {
          const idx = parent.children.indexOf(node);
          if (idx >= 0) {
            parent.children.splice(idx, 1, ...replaced);
            return;
          }
        }
      }
      if (Array.isArray(node.children)) for (const c of [...node.children]) walk(c, node);
    };
    walk(tree, null);
  };
}

// ─── Anchor (workspace file paths + external links) ──────────────────────────

function joinWorkspacePath(cwd: string, rel: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/";
  const cleanRel = rel.replace(/^[.][\\/]/, "").replace(/[\\/]/g, sep);
  return cwd.replace(/[\\/]+$/, "") + sep + cleanRel;
}

function Anchor({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const url = href ?? "";

  if ((className ?? "").includes("entry-path-link")) {
    return (
      <a
        className="entry-path-link"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          const rel = url.split(":")[0]; // workspace paths carry no colon
          const cwd = getMainState().workspaceCwd;
          if (rel && cwd) void bridge().openPath(joinWorkspacePath(cwd, rel)).catch(() => undefined);
        }}
      >
        {children}
      </a>
    );
  }

  const isExternal = /^(?:https?|mailto|tel):/i.test(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (isExternal) {
          e.preventDefault();
          window.reinaDesktop.openLink(url);
        }
      }}
    >
      {children}
    </a>
  );
}

// ─── Components map (module-level so react-markdown keeps a stable identity) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COMPONENTS: any = {
  a: Anchor,
  // Unwrap react-markdown's <pre> — CodeBlock supplies its own.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: ({ className, children, ...props }: any) => {
    const match = /language-([\w+-]+)/.exec(className || "");
    const text = String(children ?? "").replace(/\n$/, "");
    if (match || text.includes("\n")) {
      return <CodeBlock code={text} lang={match?.[1] ?? ""} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkFilePaths];

// ─── Component ────────────────────────────────────────────────────────────────

interface MarkdownProps {
  source: string;
  className?: string;
}

export const Markdown = memo(
  function Markdown({ source, className }: MarkdownProps) {
    return (
      <div className={className}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {source}
        </ReactMarkdown>
      </div>
    );
  },
  (prev, next) => prev.source === next.source && prev.className === next.className,
);
