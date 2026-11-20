export const description = [
  "Read a file by relative or absolute path.",
  "",
  "Relative paths resolve from the session workspace; absolute paths are read directly. Access is limited only by the Reina process's operating-system permissions. Use 1-based `offset`/`limit` for large files. Large markdown files may return a section outline; re-read the needed range or pass an explicit limit.",
  "",
  "Supported images are returned inline. PDFs return extracted text by default; pass `pages` to view selected pages or scanned content. Other binary files and directories are rejected.",
  "",
  "Missing paths include recovery hints. Read independent files in parallel and prefer one useful range over many tiny slices.",
].join("\n");
