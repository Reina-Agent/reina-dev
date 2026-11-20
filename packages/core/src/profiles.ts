// Profiles surface is split into `./profiles/` for clarity:
//   builtin.ts — the shipped default / summary profiles
//   loader.ts  — user agents.json loader (mtime-cached)
//   index.ts   — public API: listAllProfiles / resolveProfile / availableTools / requiresApproval
// This file stays as a barrel so existing `./profiles.js` imports keep working.
export * from "./profiles/index.js";
