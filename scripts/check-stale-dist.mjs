#!/usr/bin/env node
// Detect a stale build (source newer than its compiled output) and exit
// non-zero so launch paths can refuse to run against an outdated bundle.
// The classic failure this closes: editing packages/core or packages/tools,
// launching the app without `npm run build:desktop`, and the agent-host
// (which runs as the bundled dist/packages/agent-host/stdio.cjs, not live
// from src) crashing every tool call against last week's code.
//
// Pure file-mtime comparison — no TypeScript program is started, cheap
// enough to run before every launch. Ported from maka-agent's
// check-stale-dist gate, adapted to Reina's single root dist/ mirror.
//
// Escape hatch: REINA_ALLOW_STALE=1 downgrades the failure to a warning
// (used by `start-desktop.cmd --no-build`, where running the last compiled
// output is explicitly requested).

import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each target maps the source trees that feed a runtime artifact to that
// artifact. The artifacts are compared as EXPLICIT FILES (`outFiles`), not
// directory walks: `tsc -b` emits its own per-package .js into the same
// dist/ tree, so "newest file under dist/..." goes fresh after a mere
// typecheck build while the tsup bundle the app actually loads stays old.
// agent-host is a tsup bundle that INLINES core/tools/providers/protocol,
// so all of those src trees invalidate it.
const targets = [
  {
    name: "agent-host bundle",
    src: [
      "packages/agent-host/src",
      "packages/core/src",
      "packages/tools/src",
      "packages/providers/src",
      "packages/protocol/src",
      "packages/desktop-protocol/src",
    ],
    outFiles: ["dist/packages/agent-host/stdio.cjs"],
  },
  {
    name: "desktop main+preload",
    src: ["apps/desktop/src"],
    srcExclude: ["renderer-react"],
    outFiles: ["dist/apps/desktop/main.js", "dist/apps/desktop/preload.cjs"],
  },
  {
    name: "renderer-react",
    src: ["apps/desktop/src/renderer-react"],
    out: "dist/apps/desktop/renderer-react",
  },
];

const SRC_EXT = [".ts", ".tsx", ".cjs", ".mjs", ".js", ".css", ".html"];
const OUT_EXT = [".js", ".cjs", ".mjs", ".css", ".html"];

function walkMaxMtime(dir, extensions, excludeDirs = []) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        if (excludeDirs.includes(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      const m = statSync(full).mtimeMs;
      if (m > max) max = m;
    }
  }
  return max;
}

const stale = [];
for (const target of targets) {
  const srcDirs = target.src.map((s) => join(repoRoot, s)).filter((s) => existsSync(s));
  if (srcDirs.length === 0) continue;
  let outMax;
  if (target.outFiles) {
    const files = target.outFiles.map((f) => join(repoRoot, f));
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      stale.push({ name: target.name, reason: `output missing (${missing.map((f) => f.slice(repoRoot.length + 1)).join(", ")})` });
      continue;
    }
    outMax = Math.max(...files.map((f) => statSync(f).mtimeMs));
  } else {
    const outDir = join(repoRoot, target.out);
    if (!existsSync(outDir)) {
      stale.push({ name: target.name, reason: "output missing" });
      continue;
    }
    outMax = walkMaxMtime(outDir, OUT_EXT, target.outExclude ?? []);
  }
  const srcMax = Math.max(...srcDirs.map((s) => walkMaxMtime(s, SRC_EXT, target.srcExclude ?? [])));
  if (srcMax > outMax) {
    stale.push({
      name: target.name,
      reason: `src newer than output (Δ=${Math.round((srcMax - outMax) / 1000)}s)`,
    });
  }
}

if (stale.length === 0) {
  console.log("[check-stale-dist] build outputs are fresh.");
  process.exit(0);
}

const allowStale = process.env.REINA_ALLOW_STALE === "1";
const log = allowStale ? console.warn : console.error;
log(`[check-stale-dist] STALE BUILD OUTPUT${allowStale ? " (allowed by REINA_ALLOW_STALE=1)" : ""}:`);
for (const s of stale) log(`  - ${s.name}: ${s.reason}`);
if (allowStale) process.exit(0);
console.error("\nRun `npm run build:desktop` (or start-desktop.cmd) and retry.");
console.error("To launch anyway on the last compiled output: set REINA_ALLOW_STALE=1.");
process.exit(2);
