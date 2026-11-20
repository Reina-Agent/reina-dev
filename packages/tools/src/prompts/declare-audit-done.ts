export const description = [
  "Stop the autopilot audit loop. Meaningful only in autopilot mode — no-op in interactive mode (don't call).",
  "",
  "Pick `status`:",
  "- `complete` — goal achieved, no further exploration needed.",
  "- `exhausted` — looked everywhere reasonable, no more leads.",
  "- `blocked` — cannot progress without human input (missing credentials, target unavailable, tool gap).",
  "",
  "`summary`: 2-5 sentence wrap-up for the auto-generated report. Cite the most important note ids.",
].join("\n");
