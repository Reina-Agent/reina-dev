export const description = [
  "Replace one occurrence of `oldText` with `newText` in a file. Preferred over write_file for any change that isn't a full rewrite.",
  "",
  "Required: you MUST have called read_file on this path earlier this session. Edits are rejected if the file changed on disk since — re-read first.",
  "",
  "- `oldText` must appear verbatim (whitespace/indentation tolerant); include enough surrounding context to make it unique. Fails fast on ambiguous matches.",
  "- Set `replaceAll: true` to replace every occurrence.",
  "- Use multi_edit for several edits to the same file in one shot.",
].join("\n");
