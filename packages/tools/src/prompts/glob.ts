export const description = [
  "Find files by name or path with bundled ripgrep. Read-only, respects .gitignore, and safe to run in parallel.",
  "",
  "Use glob for filename patterns such as `**/*.test.ts`; use grep for contents and codegraph for definitions or callers.",
  "",
  "Scope with workspace-relative `path`. Results are newest first. Set `no_ignore: true` only when ignored or hidden paths are required.",
  "",
  "Returned paths are workspace-relative, and no matches is not an error.",
].join("\n");
