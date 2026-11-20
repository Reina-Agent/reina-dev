export const description = [
  "Mutate an existing subtask: advance status, reassign owner, attach async-task binding, or revise blockedBy edges.",
  "",
  "Fields (all optional except `id`):",
  "- `status` — `pending` / `in_progress` / `completed` / `failed` / `cancelled` / `blocked`.",
  "- `owner` — reassign; empty string clears.",
  "- `addBlockedBy` / `removeBlockedBy` — adjust dependency edges (cycles refused).",
  "- `bindAsyncTaskId` — record `sub_<id>` from task so the DAG node tracks its run.",
  "- `phase` — re-tag.",
  "- `tags` — replace tag list.",
  "- `resultSummary` — one-line summary for the DAG tooltip (esp. on terminal statuses).",
  "",
  "Terminal transitions (completed / failed / cancelled) auto-flip downstream nodes from `blocked` to `pending` when their blockedBy edges fully resolve.",
].join("\n");
