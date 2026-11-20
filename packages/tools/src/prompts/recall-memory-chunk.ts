export const description = [
  "Fetch the full content of an offloaded conversation chunk listed in the system-prompt's 'Offloaded memory' section.",
  "",
  "Call when you need an exact earlier detail (file path, command, quote, stack trace) not in recent verbatim messages, AND a chunk's topic line looks relevant.",
  "",
  "Returns raw chunk text as a tool observation for THIS turn only — not re-added to long-term context. For multiple chunks, call once per id; do not batch.",
].join("\n");
