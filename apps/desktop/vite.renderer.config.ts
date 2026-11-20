import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(__dirname, "src/renderer-react");
const outDir = path.resolve(__dirname, "../../dist/apps/desktop/renderer-react");

// React renderer build. Multi-page: one HTML entry per Electron window (main
// chat, settings, workspace). The main chat window is a faithful tech-stack
// swap — it reuses the legacy chat CSS verbatim (copied to ./legacy-styles by
// scripts/copy-legacy-chat-assets.cjs) and reproduces the exact legacy DOM.
// Loaded via loadFile() from dist — hence base "./" so asset URLs stay relative.
export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "~": path.resolve(rendererRoot, "src"),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "chrome140",
    // The 500 kB warning targets network-delivered web apps; this renderer
    // loads from local disk (file://). The offenders are already lazy-loaded
    // dynamic-import chunks: the vscode-icons collection (~3.6 MB JSON, Files
    // tab only) and shiki per-language grammars.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: path.resolve(rendererRoot, "main.html"),
        conversationMenu: path.resolve(rendererRoot, "conversation-menu.html"),
        settings: path.resolve(rendererRoot, "settings.html"),
        workspace: path.resolve(rendererRoot, "workspace.html"),
      },
    },
  },
});
