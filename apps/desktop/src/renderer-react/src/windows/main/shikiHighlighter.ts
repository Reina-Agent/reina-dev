// shikiHighlighter.ts — a single shared Shiki highlighter for the chat code
// blocks. Uses Shiki's **JavaScript RegExp engine** (oniguruma-to-js) instead of
// the default WebAssembly engine: the chat window CSP is `script-src 'self'
// 'unsafe-inline'` with no `wasm-unsafe-eval`, so the WASM engine fails silently
// (uncoloured code). The JS engine compiles grammars to native RegExp — no WASM,
// no eval — so it colours fine under that CSP.
//
// Theme is a CSS-variables theme (learned from Alma's base46→shiki bridge,
// done one better): every token colour is emitted as
// `var(--shiki-token-*, <github-dark default>)`. Dark built-in themes keep
// the GitHub-Dark fallback palette; light themes override the code block's
// variables in chat.css for readable colors on a light surface. Base46 injects
// --shiki-* from their base_16 syntax palette (see lib/base46.ts) and the
// code blocks re-colour instantly on theme switch — no re-tokenization.
// Shiki's own background is dropped in CodeBlock so the existing
// `.code-block` panel-soft surface shows through.

import type { Highlighter } from "shiki";

export const SHIKI_THEME = "reina-syntax";

// GitHub-Dark hexes as var() fallbacks — the no-theme-vars baseline.
const SHIKI_VARIABLE_DEFAULTS: Record<string, string> = {
  foreground: "#e6edf3",
  background: "#00000000",
  "token-constant": "#79c0ff",
  "token-string": "#a5d6ff",
  "token-comment": "#8b949e",
  "token-keyword": "#ff7b72",
  "token-parameter": "#ffa657",
  "token-function": "#d2a8ff",
  "token-string-expression": "#7ee787",
  "token-punctuation": "#e6edf3",
  "token-link": "#a5d6ff",
  "token-inserted": "#aff5b4",
  "token-deleted": "#ffdcd7",
  "token-changed": "#ffdfb6",
};

// Fence ids that Shiki doesn't recognise verbatim → its canonical language id.
const LANG_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  ts: "typescript",
  js: "javascript",
  txt: "text",
  plaintext: "text",
};

const PLAIN = new Set(["", "text", "txt", "plaintext", "ansi"]);

export function normalizeLang(lang: string): string {
  const l = (lang || "").toLowerCase().trim();
  return LANG_ALIASES[l] ?? l;
}

let highlighterPromise: Promise<Highlighter> | null = null;

// Lazily create the singleton. Shiki (a few MB of grammars registry) is
// dynamically imported so it only loads when the first code block renders, not
// on chat-window open. Langs then load on demand (see ensureLang).
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighter, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki"),
        import("shiki/engine/javascript"),
      ]);
      const theme = createCssVariablesTheme({
        name: SHIKI_THEME,
        variablePrefix: "--shiki-",
        variableDefaults: SHIKI_VARIABLE_DEFAULTS,
        fontStyle: true,
      });
      return createHighlighter({
        themes: [theme],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return highlighterPromise;
}

const loading = new Map<string, Promise<string>>();

// Ensure a grammar is loaded; resolve to the language actually usable — "text"
// for plain/unknown/unsupported ids so codeToTokens never throws. Concurrent
// loads of the same language are de-duplicated.
export async function ensureLang(hl: Highlighter, lang: string): Promise<string> {
  const norm = normalizeLang(lang);
  if (PLAIN.has(norm)) return "text";
  if (hl.getLoadedLanguages().includes(norm)) return norm;

  const inflight = loading.get(norm);
  if (inflight) return inflight;

  const load = (async () => {
    try {
      // `loadLanguage` accepts a BundledLanguage id and dynamically imports it.
      await hl.loadLanguage(norm as Parameters<Highlighter["loadLanguage"]>[0]);
      return norm;
    } catch {
      return "text";
    } finally {
      loading.delete(norm);
    }
  })();
  loading.set(norm, load);
  return load;
}
