export const description = [
  "List shared-notebook index rows (id, title, tags, status), not note bodies. Use `read_note(id)` for content.",
  "",
  "Optional filters are AND-combined: all `tags`, one `status`, any cited `refs_any`, and ISO `since`.",
  "",
  "Returns the newest 50 by default; `limit` is capped at 200.",
].join("\n");
