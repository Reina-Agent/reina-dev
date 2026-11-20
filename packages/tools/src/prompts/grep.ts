export const description = [
  "Search file contents with bundled ripgrep. Read-only, respects .gitignore, and safe to run in parallel.",
  "",
  "Use grep for text, comments, logs, and config values. Prefer codegraph for definitions, callers, and other structural questions.",
  "",
  "`pattern` uses Rust regex syntax; enable `multiline` for cross-line matches. Narrow searches with `path`, `glob`, or `type`; choose paths, matching content, or counts with `output_mode`. Set `no_ignore: true` only when ignored or hidden paths are required.",
  "",
  "Paths are workspace-relative, binary files are skipped, and no matches is not an error.",
].join("\n");
