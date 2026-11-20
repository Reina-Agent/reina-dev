export const description = [
  "Fetch the raw material for a memory consolidation pass: briefs (title + rolling summary) of every session updated since the last consolidation.",
  "YOU then do the consolidation in this turn: merge the durable facts — decisions, preferences, project state — into the global notebook via note(scope:\"global\") / update_note, resolving contradictions in favour of the newest session and discarding one-off noise.",
  "Call it when the start-of-turn notice reports accumulated sessions (or when the user asks to consolidate memory). Calling it stamps the consolidation clock, so don't call it idly — read the material and actually write the notes.",
].join("\n");
