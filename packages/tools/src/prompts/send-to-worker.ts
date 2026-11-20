export const description = [
  "Send a directed message to a specific worker (or the coordinator inbox, stored as `team-lead`, if you're reporting back), or broadcast with `recipient: \"*\"`. Writes a note to the shared notebook with a `recipient` field, so the message is durable and visible in the Notes panel.",
  "",
  "Fields:",
  "- `recipient` — worker name / session id / coordinator inbox (`team-lead`) / `\"*\"` (broadcast).",
  "- `subject` — one-line title.",
  "- `body` — Markdown.",
  "- `subtaskId` (optional) — adds a tag for filtering.",
  "",
  "Workers fetch their inbox via `list_notes` with their own name as `recipient` — they see directed notes, un-addressed (team-wide), and broadcasts.",
].join("\n");
