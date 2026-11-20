// Pure, dependency-free validators that guard the renderer -> privileged-main
// trust boundary. They live in their own module (only node:path, no electron /
// fs) so they can be unit-tested directly — the IPC registration in ipc.ts
// pulls in electron and cannot be imported under vitest. Keep these PURE: same
// input -> same output, no I/O, no side effects.

import path from "node:path";

/** Resolve `filePath` against `cwd` and return the workspace-relative path,
 * throwing if it escapes the workspace root (path traversal, absolute path,
 * or a drive-relative path that resolves outside cwd). Used by every
 * workspace file-IO IPC handler before touching disk. */
export function safeRelativePath(cwd: string, filePath: string): string {
  const absoluteCwd = path.resolve(cwd);
  const absoluteFile = path.resolve(absoluteCwd, filePath);
  const relative = path.relative(absoluteCwd, absoluteFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid workspace file path: ${filePath}`);
  return relative;
}

export type CustomAgent = {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  prompt: string;
  maxSteps?: number;
  extraDirectTools?: string[];
};

/** Sanitize renderer-supplied custom-agent JSON before it is persisted to
 * disk. Drops entries that fail the strict name allowlist, mode allowlist, or
 * required-field checks. Tolerant by design: invalid entries are filtered out
 * rather than throwing, and malformed JSON yields an empty list. */
export function parseCustomAgents(raw: string | null): CustomAgent[] {
  if (!raw) return [];
  try {
    const trimmed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    const VALID_MODES = new Set(["primary", "subagent", "all"]);
    return parsed
      .map((entry): CustomAgent | null => {
        if (!entry || typeof entry !== "object") return null;
        const e = entry as Record<string, unknown>;
        const name = typeof e.name === "string" ? e.name.trim() : "";
        const description = typeof e.description === "string" ? e.description.trim() : "";
        const prompt = typeof e.prompt === "string" ? e.prompt : "";
        const mode = typeof e.mode === "string" && VALID_MODES.has(e.mode) ? (e.mode as CustomAgent["mode"]) : "subagent";
        if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) return null;
        if (!description || !prompt) return null;
        const out: CustomAgent = { name, description, mode, prompt };
        if (typeof e.maxSteps === "number" && Number.isFinite(e.maxSteps) && e.maxSteps > 0) out.maxSteps = Math.floor(e.maxSteps);
        if (Array.isArray(e.extraDirectTools)) {
          const tools = e.extraDirectTools.filter((t): t is string => typeof t === "string" && t.length > 0);
          if (tools.length > 0) out.extraDirectTools = tools;
        }
        return out;
      })
      .filter((a): a is CustomAgent => Boolean(a));
  } catch {
    return [];
  }
}

/** Escape a value for embedding inside a PowerShell SINGLE-quoted string
 * literal. In PS single-quoted strings the only metacharacter is the single
 * quote itself, which is escaped by doubling it; nothing else (`$`, backtick,
 * `;`) is interpreted. So `Set-Location -LiteralPath '<quoted>'` is injection-
 * safe for any cwd. Returns the inner text only — the caller wraps it in `'`. */
export function quotePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** Allowlist check for URLs the renderer asks the main process to open via
 * shell.openExternal (reina:open-link). Only http:/https:/mailto: pass —
 * anything else (file:, smb:, or a custom protocol handler registered on the
 * OS) would let renderer content make the OS launch arbitrary local handlers,
 * so it is rejected. Malformed URLs are rejected too; new URL() throws on
 * them. The URL parser also normalizes case and strips embedded control/space
 * characters, so `JAVASCRIPT:` / `java\tscript:` style smuggling fails here
 * without a hand-rolled regex. */
export function isAllowedExternalUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const protocol = new URL(url.trim()).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
