export const description = [
  "Add a node to the team-mode subtask DAG. Use to break a high-level task into trackable units; each subtask gets a stable `sub_<id>` referenced by update_subtask, send_to_worker, and task bindings.",
  "",
  "Fields:",
  "- `title` — one-line DAG node label.",
  "- `description` — full self-contained brief for the worker (file paths, success criteria, scope).",
  "- `owner` (optional) — pre-assign to a worker name or task session id; blank to leave unassigned.",
  "- `blockedBy` (optional) — `sub_<id>` deps; new node is `blocked` if any blocker is non-terminal, else `pending`.",
  "- `phase` (optional) — `plan` / `prd` / `exec` / `verify` / `fix` for DAG grouping.",
  "- `tags` (optional) — freeform chips on the node.",
  "",
  "Returns the new subtask record as JSON.",
].join("\n");
