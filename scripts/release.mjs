// One-command release.
//
//   npm run release 0.1.4
//
// Steps:
//   1. bump package.json version
//   2. commit + push the bump on the current branch
//   3. create + push tag v<version> (triggers the cloud release workflow)
//   4. wait for that workflow run to finish
//
// Requires: gh (logged in), git, a clean working tree.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkgPath = path.join(root, "package.json");

const SOURCE_REPO = "7-e1even/reina"; // where the workflow builds + publishes
const WORKFLOW = "release.yml";
const onWin = process.platform === "win32";

main();

function main() {
  const version = parseVersion(process.argv.slice(2));
  const tag = `v${version}`;

  preflight(tag);

  step(`Bumping version -> ${version}`);
  bumpVersion(version);

  step(`Committing + pushing version bump`);
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `release: ${tag}`]);
  run("git", ["push", "origin", branch]);

  step(`Tagging ${tag} and pushing (this triggers the build)`);
  run("git", ["tag", "-a", tag, "-m", `Reina ${tag}`]);
  run("git", ["push", "origin", tag]);

  step(`Waiting for the release workflow to build all platforms`);
  const runId = waitForRun(tag);
  if (!runId) fail("Timed out waiting for the workflow run to appear.");
  console.log(`  Watching run ${runId} ...`);
  run("gh", ["run", "watch", String(runId), "--exit-status", "--interval", "30"]);

  console.log(`\n✅ Released ${tag}:`);
  console.log(`   https://github.com/${SOURCE_REPO}/releases/tag/${tag}`);
}

function parseVersion(args) {
  const version = args[0];
  if (!version) {
    fail("Usage: npm run release <version>   e.g. npm run release 0.1.4");
  }
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid version "${version}". Expected something like 0.1.4`);
  }
  return version;
}

function preflight(tag) {
  // gh must be installed + authenticated
  if (silent("gh", ["auth", "status"]) !== 0) {
    fail("gh is not authenticated. Run `gh auth login` first.");
  }
  // working tree must be clean so the release commit only contains the bump
  const dirty = capture("git", ["status", "--porcelain"]).trim();
  if (dirty) {
    fail("Working tree is not clean. Commit or stash changes first:\n" + dirty);
  }
  // tag must not already exist
  if (capture("git", ["tag", "--list", tag]).trim()) {
    fail(`Tag ${tag} already exists locally. Pick a new version.`);
  }
  // version must actually change
  const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (`v${current}` === tag) {
    fail(`package.json is already at ${current}. Pick a new version.`);
  }
}

function bumpVersion(version) {
  const text = readFileSync(pkgPath, "utf8");
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text) fail("Could not find a version field to update in package.json.");
  writeFileSync(pkgPath, next);
}

// Poll until the tag-triggered run shows up, return its id (or null on timeout).
function waitForRun(tag) {
  for (let i = 0; i < 40; i++) {
    const out = capture("gh", [
      "run", "list", "--workflow", WORKFLOW, "--event", "push",
      "--json", "databaseId,headBranch", "--limit", "20",
    ]);
    let runs = [];
    try { runs = JSON.parse(out); } catch { /* run list not ready yet */ }
    const match = runs.find((r) => r.headBranch === tag);
    if (match) return match.databaseId;
    sleep(3000);
  }
  return null;
}

// --- small helpers (match scripts/package-release.mjs style) ---------------

// Under `shell: true` (Windows) Node concatenates argv into one command line
// WITHOUT quoting, so cmd.exe re-splits any arg containing spaces — a commit
// message like "release: v0.1.5" arrived as two tokens and git treated the
// version as a pathspec. Quote whitespace-bearing args so they survive the
// shell. No-op off Windows (shell is false there; argv is passed verbatim).
function shellArgs(args) {
  if (!onWin) return args;
  return args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
}

function run(command, args) {
  console.log(`  > ${command} ${args.join(" ")}`);
  const result = spawnSync(command, shellArgs(args), { cwd: root, stdio: "inherit", shell: onWin });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, shellArgs(args), { cwd: root, encoding: "utf8", shell: onWin });
  return result.stdout || "";
}

function silent(command, args) {
  const result = spawnSync(command, shellArgs(args), { cwd: root, stdio: "ignore", shell: onWin });
  return result.status ?? 1;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function step(message) {
  console.log(`\n=== ${message} ===`);
}

function fail(message) {
  console.error(`\n[release] ${message}`);
  process.exit(1);
}
