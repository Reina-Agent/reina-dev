// Minimal ambient declarations for third-party modules that ship without
// TypeScript types and are not covered by @types/* packages in this workspace.

// highlight.js "common" ESM bundle (the same grammars the legacy renderer
// vendored). Ships no types; we declare only the surface Markdown.tsx uses.
declare module "@highlightjs/cdn-assets/es/highlight.min.js" {
  interface HighlightResult {
    value: string;
    language?: string;
  }
  interface HLJSApi {
    getLanguage(name: string): unknown;
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
    highlightAuto(code: string): HighlightResult;
  }
  const hljs: HLJSApi;
  export default hljs;
}
