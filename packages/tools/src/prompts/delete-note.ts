export const description = [
  "Delete a shared note permanently. Removes `<cwd>/.reina/notes/<id>.md` from disk and drops it from the in-memory index.",
  "",
  "PREFER `update_note(status: \"dead\")` for ruled-out hypotheses — that keeps the audit trail showing what was considered.",
  "",
  "Use `delete_note` ONLY for:",
  "- Scratch / test notes you wrote while feeling out the audit.",
  "- Hallucinated or factually-broken notes (never grounded).",
  "- Exact duplicates (delete the lesser; reflect the merge in the survivor's body).",
  "",
  "Deletes do NOT cascade. If other notes have `refs: [<id>]`, those refs become dangling — the response lists every dependent so you can `update_note` them. The id is NOT reused by future `note` calls (sequence gaps are kept).",
].join("\n");
