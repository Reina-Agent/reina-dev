export const description = [
  "Spawn a subagent. DEFAULT: blocks this turn until the child finishes. BUT if you emit MULTIPLE start_async_task calls in the SAME assistant response they run CONCURRENTLY (wall-clock ≈ max(children), not sum); each observation carries its child's full result for in-turn synthesis.",
  "Pick `start_async_task` for parallel fan-out (2+ independent subtasks). Pick `task` for ONE focused investigation.",
  "Set `background: true` to fire-and-forget — returns a `sub_<id>` handle to reap LATER via check / list / gather / wait_async_tasks. Concurrency cap: 8 running children/session.",
  "Same-brief auto-merge: identical (agent + description) calls in this batch or against a running task are deduplicated; the duplicate returns `<status>merged</status>` pointing at the original.",
  "See read_skill(\"subagent-delegation\") for fan-out patterns, background lifecycle, isolate:\"worktree\" semantics, and anti-patterns.",
].join("\n");
