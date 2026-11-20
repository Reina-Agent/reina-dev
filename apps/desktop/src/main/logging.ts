import { appendFileSync } from "node:fs";
import path from "node:path";
import type { LogFn } from "./types.js";

export function createLogger(repoRoot: string): LogFn {
  const logPath = process.env.REINA_DESKTOP_LOG || path.resolve(repoRoot, "reina-desktop.log");
  return (message: string) => {
    const timestamp = new Date().toISOString();
    try {
      appendFileSync(logPath, `[${timestamp}] ${message}\n`, "utf8");
    } catch {
      // Logging must never prevent the desktop app from starting.
    }
  };
}
