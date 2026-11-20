import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const releaseDir = path.join(root, "release");
const requested = parseArgs(process.argv.slice(2));

// Artifacts land flat in release/ — the artifactName carries no subdir so the
// filenames stay GitHub-safe and match what electron-builder writes into the
// updater feed (latest.yml). electron-builder creates release/ itself.
mkdirSync(releaseDir, { recursive: true });

run("npm", ["run", "build:desktop"]);

const platform = process.platform;
const targets = requested.target === "all" ? ["win-all", "mac"] : [requested.target];

for (const target of targets) {
  if (target === "win") {
    if (platform !== "win32") {
      warn("Skipping Windows package: build it on Windows because native modules are rebuilt per platform.");
      continue;
    }
    run("npx", ["electron-builder", "--win", "nsis"]);
    cleanupReleaseByproducts();
    continue;
  }

  if (target === "win-all") {
    if (platform !== "win32") {
      warn("Skipping Windows packages: build them on Windows because native modules are rebuilt per platform.");
      continue;
    }
    run("npx", ["electron-builder", "--win", "nsis", "portable"]);
    cleanupReleaseByproducts();
    continue;
  }

  if (target === "win-portable") {
    if (platform !== "win32") {
      warn("Skipping Windows portable package: build it on Windows because native modules are rebuilt per platform.");
      continue;
    }
    run("npx", ["electron-builder", "--win", "portable"]);
    cleanupReleaseByproducts();
    continue;
  }

  if (target === "mac") {
    if (platform !== "darwin") {
      warn("Skipping macOS package: build it on macOS because Electron and node-pty need macOS native binaries.");
      continue;
    }
    run("npx", ["electron-builder", "--mac", "dmg", "zip"]);
    cleanupReleaseByproducts();
    continue;
  }

  throw new Error(`Unknown target: ${target}`);
}

console.log(`Release output: ${releaseDir}`);

function parseArgs(args) {
  const targetFlag = args.find((arg) => arg.startsWith("--target="));
  const target = targetFlag?.slice("--target=".length) || defaultTarget();
  if (!["win", "win-portable", "win-all", "mac", "all"].includes(target)) {
    throw new Error("Usage: npm run package:release -- --target=win|win-portable|win-all|mac|all");
  }
  return { target };
}

function defaultTarget() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "all";
}

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cleanupReleaseByproducts() {
  const removable = [
    "builder-debug.yml",
    "latest.yml",
    "latest-mac.yml",
    "win-unpacked",
    "mac",
    "mac-arm64",
    "mac-universal",
  ];

  for (const name of removable) {
    removePath(path.join(releaseDir, name));
  }

  for (const name of listDir(releaseDir)) {
    if (name.endsWith(".blockmap") || name.endsWith(".__uninstaller.exe")) {
      removePath(path.join(releaseDir, name));
    }
  }
}

function listDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function removePath(target) {
  try {
    if (!existsSync(target)) return;
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  } catch (error) {
    warn(`Could not remove ${path.relative(root, target)}: ${error.code || error.message}`);
  }
}

function warn(message) {
  console.warn(`[package-release] ${message}`);
}
