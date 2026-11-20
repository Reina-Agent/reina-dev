import { defineConfig } from "tsup";

const shared = {
  platform: "node" as const,
  target: "node22",
  dts: false,
  external: ["electron", "node-pty"],
  // electron-updater is a runtime dependency, but the electron-builder `files`
  // allowlist (root package.json) excludes node_modules, so it must be bundled
  // into main.js rather than left as a bare import that fails in the packaged
  // app. tsup externalizes `dependencies` by default, so force it in here.
  noExternal: ["@reina/desktop-protocol", "@reina/protocol", "electron-updater"],
  outDir: "../../dist/apps/desktop",
};

export default defineConfig([
  {
    ...shared,
    entry: { main: "src/main.ts" },
    format: ["esm"],
    clean: true,
    // The ESM bundle inlines CJS deps (electron-updater -> fs-extra) that call
    // `require()` at runtime. esbuild's ESM output has no `require`, so define a
    // real one from import.meta.url — otherwise "Dynamic require of fs is not
    // supported" crashes the main process on launch. ESM-only: the CJS preload
    // build below already has a native require.
    banner: {
      js: "import { createRequire as __reinaCreateRequire } from 'module'; const require = __reinaCreateRequire(import.meta.url);",
    },
  },
  {
    ...shared,
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
  },
]);
