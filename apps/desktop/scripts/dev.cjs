const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const electron = require("electron");

const repoRoot = process.env.INIT_CWD || path.resolve(__dirname, "../../..");
const appEntry = path.resolve(repoRoot, "apps/desktop");

// Refuse to launch on a stale build: the agent-host runs as the bundled
// dist/packages/agent-host/stdio.cjs, so src edits without a rebuild mean
// the app silently runs last build's code. REINA_ALLOW_STALE=1 downgrades
// this to a warning (start-desktop.cmd --no-build sets it).
const staleCheck = spawnSync(process.execPath, [path.resolve(repoRoot, "scripts/check-stale-dist.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (staleCheck.status !== 0) process.exit(staleCheck.status ?? 1);

// CDP (Chrome DevTools Protocol) for Playwright/curl/etc. — enabled by
// default on port 9333. Override with REINA_CDP_PORT=N, disable with
// REINA_CDP_PORT=0 (or "off"/"no"/"false"/"none").
const cdpEnv = process.env.REINA_CDP_PORT;
const requestedCdpPort = cdpEnv === undefined ? "9333" : cdpEnv;
const cdpDisabled = ["0", "off", "no", "false", "none"].includes(
  String(requestedCdpPort).toLowerCase(),
);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  // Chromium flags come BEFORE the app entry by convention.
  const args = [];
  if (!cdpDisabled) {
    const cdpPort = await availablePort(Number(requestedCdpPort) || 9333);
    args.push(`--remote-debugging-port=${cdpPort}`);
    console.log(`[dev] CDP listening on http://127.0.0.1:${cdpPort}`);
  }
  args.push(appEntry);

  const child = spawn(electron, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function availablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`No available CDP port found from ${startPort} to ${startPort + 49}`);
}
