export const description = [
  "Spawn a subagent. By default this blocks until the child finishes and returns its result. Multiple `task` calls in the same assistant response run concurrently for parallel fan-out.",
  "Set `background: true` when you have independent work to continue while the child runs. It returns a `sub_<id>` immediately; inspect it later with `get_async_tasks` or block with `wait_async_tasks`. The child cannot spawn subagents; reserve bubbled user questions for true blockers.",
  "Set `fork: true` when the child needs your recent conversation context (bounded by the fork budget). This is independent of background mode: use both for inherited context while you continue working. Without fork, provide a self-contained brief; omit fork for an independent review.",
  "See read_skill(\"subagent-delegation\") for briefing, fork/worktree isolation, lifecycle, and anti-patterns.",
].join("\n");
