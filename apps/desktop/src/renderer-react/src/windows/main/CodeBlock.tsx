// CodeBlock.tsx — one fenced code block, incrementally highlighted with Shiki
// via shiki-stream's ShikiStreamTokenizer (JS engine, CSP-safe), wrapped in the
// legacy `.code-block` structure (hover toolbar with language + Copy, 40-line
// collapse) so chat.css styles it exactly as before. Rendered by Markdown.tsx.
//
// Why no flash: tokens render as React elements (not innerHTML), so React
// reconciles in place. During streaming we feed only the NEW text to the
// tokenizer (`enqueue(delta)`); it keeps a grammar state so already-tokenized
// lines stay byte-identical and their DOM nodes are never recreated — only the
// last (growing) line repaints. Highlighting is async; previous tokens stay on
// screen until the next batch resolves, so it never drops back to plain text.
// `memo` skips any block whose code/lang is unchanged (sealed blocks never
// re-tokenize). Async runs are serialized through a promise chain so overlapping
// streamed updates can't race on the tokenizer's append-only state.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import type { ShikiStreamTokenizer } from "shiki-stream";
import { ensureLang, getHighlighter, normalizeLang, SHIKI_THEME } from "./shikiHighlighter";

const COLLAPSE_THRESHOLD_LINES = 40;

interface CodeBlockProps {
  code: string;
  lang: string;
}

interface TokenizerState {
  tk: ShikiStreamTokenizer;
  lang: string;
  consumed: string;
}

function CodeBlockImpl({ code, lang }: CodeBlockProps) {
  const [tokens, setTokens] = useState<ThemedToken[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const stateRef = useRef<TokenizerState | null>(null);
  // Serialize tokenization so a newer streamed update can't enqueue before the
  // previous one finished updating `consumed` (which would corrupt the delta).
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // Monotonic id so a superseded run neither enqueues nor sets stale tokens.
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    chainRef.current = chainRef.current
      .then(async () => {
        if (req !== reqRef.current) return;
        const hl = await getHighlighter();
        const resolved = await ensureLang(hl, lang);
        if (req !== reqRef.current) return;

        let st = stateRef.current;
        const appendOnly = !!st && st.lang === resolved && code.startsWith(st.consumed);
        if (!st || st.lang !== resolved || !appendOnly) {
          const { ShikiStreamTokenizer } = await import("shiki-stream");
          st = {
            tk: new ShikiStreamTokenizer({
              highlighter: hl,
              lang: resolved as BundledLanguage,
              theme: SHIKI_THEME,
            }),
            lang: resolved,
            consumed: "",
          };
          stateRef.current = st;
        }

        const delta = code.slice(st.consumed.length);
        if (delta.length > 0) {
          await st.tk.enqueue(delta);
          st.consumed = code;
        }
        if (req !== reqRef.current) return;
        setTokens([...st.tk.tokensStable, ...st.tk.tokensUnstable]);
      })
      .catch(() => undefined);
  }, [code, lang]);

  const lineCount = code.split("\n").length;
  const collapsible = lineCount > COLLAPSE_THRESHOLD_LINES;
  const collapsed = collapsible && !expanded;

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => undefined,
    );
  }, [code]);

  return (
    <div className={`code-block${collapsed ? " code-block-collapsed" : ""}`}>
      <div className="code-block-toolbar">
        <span className="code-block-lang">{normalizeLang(lang) || "text"}</span>
        <button
          type="button"
          className={`code-block-copy${copied ? " is-copied" : ""}`}
          title="Copy code"
          onClick={onCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className="hljs">
          {tokens
            ? tokens.map((token, i) => (
                <span key={i} style={{ color: token.color }}>
                  {token.content}
                </span>
              ))
            : code}
        </code>
      </pre>
      {collapsible ? (
        <button type="button" className="code-block-expand" onClick={() => setExpanded((e) => !e)}>
          {collapsed ? `Show all ${lineCount} lines` : "Collapse"}
        </button>
      ) : null}
    </div>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
