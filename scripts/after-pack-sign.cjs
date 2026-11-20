// electron-builder `afterPack` hook — ad-hoc code-sign the packed macOS .app.
//
// The build config sets `mac.identity = null` (no Apple Developer ID), so
// electron-builder skips code signing entirely. An *unsigned* app:
//   • refuses to launch on Apple Silicon (arm64 requires at least a signature), and
//   • trips Gatekeeper's "已损坏 / is damaged" dialog the moment a quarantine
//     xattr is attached (AirDrop / WeChat / browser download).
//
// An ad-hoc signature (`codesign --sign -`) makes the binary loadable on arm64
// and stops the "damaged" misfire from a bad/missing signature. It is NOT
// notarized, so a recipient still clears quarantine ONCE after transfer:
//   sudo xattr -rd com.apple.quarantine /Applications/Reina.app
//
// Runs per packed arch, before dmg/zip assembly, so the distributed artifacts
// contain the signed app. No-op on non-macOS targets (codesign is macOS-only).

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPackSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename; // "Reina"
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing ${appPath}`);
  // --deep signs nested code (Electron Framework, node-pty, asar.unpacked) first;
  // --force overwrites any stale signature. "-" is the ad-hoc identity.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
