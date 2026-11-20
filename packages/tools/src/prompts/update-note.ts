export const description = [
  "Update an existing shared note. Use to FIX mistakes (wrong title/body/tags) or to FLIP STATUS as the investigation progresses (open → confirmed once verified; open → dead for ruled-out false positives).",
  "",
  "Provide `id` plus ONLY the fields to change. Omitted fields are preserved as-is.",
  "",
  "Updatable: `title`, `body`, `tags`, `refs`, `status`. NOT updatable: `id`, `author`, `createdAt`, `recipient` (route-time properties).",
  "",
  "Status guidance:",
  "- `open` → `confirmed`: include verification evidence in the new `body`.",
  "- `open` → `dead`: include the reason in `body` so future passes don't re-investigate.",
  "",
  "`refs` is validated — every id must exist (same rule as `note`). The note's `id` stays the same; the on-disk file is overwritten. The renderer receives a `notes-updated` event with `change: \"modified\"`.",
].join("\n");
