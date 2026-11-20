// Worktree surface is split into `./worktree/` for clarity:
//   git.ts          — execFile wrapper + path/branch naming
//   fast-resume.ts  — skip fetch+add when worktree already exists
//   changes.ts      — structured + boolean dirtiness checks (fail-closed)
//   sparse.ts       — sparse-checkout helper for monorepo subsets
//   hooks.ts        — WorktreeCreate / WorktreeRemove hook protocol
//   index.ts        — public API + the createWorktree fast-path wrapper
// This file stays as a barrel so existing `./worktree.js` imports keep working.
export * from "./worktree/index.js";
