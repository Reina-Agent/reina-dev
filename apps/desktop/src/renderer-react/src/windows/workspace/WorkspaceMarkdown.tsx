import { useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { bridge } from "../../lib/bridge";
import {
  resolveWorkspaceRelativePath,
  workspaceAbsolutePath,
  workspaceFileUrl,
} from "./workspace-markdown-utils";
import "./workspace-markdown.css";

interface MarkdownNode {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

const ALERT_LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/** Turn GitHub's > [!NOTE] convention into a semantic, styleable blockquote. */
function remarkGithubAlerts() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "blockquote") {
        const paragraph = node.children?.[0];
        const marker = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
        const match = marker?.type === "text" ? marker.value?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i) : null;
        if (match && marker?.value !== undefined) {
          const kind = match[1]!.toLowerCase();
          marker.value = marker.value.slice(match[0].length);
          if (!marker.value) paragraph?.children?.shift();
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              dataAlert: kind,
              dataAlertLabel: ALERT_LABELS[kind],
            },
          };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      "dataAlert",
      "dataAlertLabel",
    ],
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkGithubAlerts, remarkBreaks];
const REHYPE_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
];

interface WorkspaceMarkdownProps {
  source: string;
  cwd?: string;
  basePath?: string;
  className?: string;
}

function ExternalOrWorkspaceLink({
  href,
  cwd,
  basePath,
  children,
  ...props
}: {
  href?: string;
  cwd?: string;
  basePath: string;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const url = href ?? "";
  const isExternal = /^(?:https?|mailto):/i.test(url);
  const hasUnsupportedScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) && !isExternal;
  const relative = cwd ? resolveWorkspaceRelativePath(basePath, url) : null;
  const safeHref = hasUnsupportedScheme ? "#" : url;

  return (
    <a
      {...props}
      href={safeHref}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      onClick={(event) => {
        if (isExternal) {
          event.preventDefault();
          bridge().openLink(url);
        } else if (cwd && relative) {
          event.preventDefault();
          void bridge().openPath(workspaceAbsolutePath(cwd, relative)).catch(() => undefined);
        } else if (hasUnsupportedScheme) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </a>
  );
}

export function WorkspaceMarkdown({ source, cwd, basePath = "README.md", className = "" }: WorkspaceMarkdownProps) {
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, href, children, ...props }) => (
      <ExternalOrWorkspaceLink href={href} cwd={cwd} basePath={basePath} {...props}>
        {children}
      </ExternalOrWorkspaceLink>
    ),
    img: ({ node: _node, alt, ...props }) => (
      <img {...props} alt={alt ?? ""} loading="lazy" />
    ),
  }), [basePath, cwd]);

  const transformUrl = useCallback<UrlTransform>((url, key, node) => {
    if (key === "src" && node.tagName === "img" && cwd) {
      return workspaceFileUrl(cwd, basePath, url) ?? defaultUrlTransform(url);
    }
    return defaultUrlTransform(url);
  }, [basePath, cwd]);

  return (
    <article className={`workspace-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={transformUrl}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}
