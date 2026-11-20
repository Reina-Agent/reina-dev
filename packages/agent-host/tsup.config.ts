import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/stdio.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "../../dist/packages/agent-host",
  dts: false,
  // node-pty is a native addon (run_shell pty:true). It must stay external so
  // the bundle `require()`s the installed build at runtime instead of esbuild
  // trying to inline its .node binary.
  external: ["node-pty"],
  noExternal: [
    "@reina/core",
    "@reina/protocol",
    "@reina/providers",
    "@reina/tools",
    "@reina/desktop-protocol",
    // jimp (downsample oversized images) and unpdf (extract PDF text) are
    // ESM-only; a CJS `require()` of them would fail at runtime, so inline both
    // into the bundle (esbuild transpiles their ESM to CJS). pdf-lib (slice PDF
    // pages) is dual CJS/ESM — inline it too for a deterministic bundle.
    "jimp",
    "unpdf",
    "pdf-lib",
  ],
  outExtension: () => ({ js: ".cjs" }),
});
