import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolCallRecord, ToolName } from "@reina/protocol";
import { reinaConfigHome } from "@reina/tools";
import { hasCommandChaining } from "./shell-approval.js";

export type PermissionDecision = "approve" | "edit" | "reject";

/**
 * A persistent permission rule. Evaluated in declaration order; first-match wins.
 * `mode: "allow"` skips the approval prompt entirely (auto-approve).
 * `mode: "deny"` blocks the call without prompting (observation carries the deny reason).
 * `mode: "ask"` forces the approval prompt even if other heuristics would skip it.
 *
 * Optional selectors narrow which calls a rule applies to:
 *   - `tool`: tool name (required)
 *   - `commandPrefix`: for run_shell, matches `command` after a leading-token normalize
 *       e.g., `git status` matches `git status -s` but not `git push`
 *   - `pathGlob`: for filesystem tools, matches the input's `path` field with `**`/`*`
 *       e.g., `**\/.env*` denies reading/writing any env file
 */
export type PermissionRule = {
  tool: ToolName | "*";
  mode: "allow" | "deny" | "ask";
  commandPrefix?: string;
  pathGlob?: string;
  /** Description shown to the user when this rule fires (e.g., explaining a deny). */
  reason?: string;
};

export type PermissionConfig = {
  rules: PermissionRule[];
};

export type PermissionVerdict =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string }
  | { kind: "pass" };

const EMPTY: PermissionConfig = { rules: [] };

/**
 * Mtime-cached read of the permissions config from disk. Combines workspace-scoped
 * rules (loaded first, so they win) with global rules from `~/.reina/permissions.json`.
 */
type CacheEntry = { mtime: number; config: PermissionConfig };
const cache = new Map<string, CacheEntry>();

export function loadPermissions(cwd: string): PermissionConfig {
  const workspace = loadFile(path.join(path.resolve(cwd), ".reina", "permissions.json"));
  const global = loadFile(path.join(reinaConfigHome(), "permissions.json"));
  return { rules: [...workspace.rules, ...global.rules] };
}

export function evaluatePermission(rules: PermissionRule[], record: ToolCallRecord): PermissionVerdict {
  // shellMatchTargets re-tokenizes and recursively expands the raw command;
  // this runs on EVERY run_shell dispatch, so compute the expansion once per
  // call instead of once per deny/ask rule.
  let cachedTargets: string[] | undefined;
  const targetsOf = (raw: string): string[] => (cachedTargets ??= shellMatchTargets(raw));
  for (const rule of rules) {
    if (!ruleMatches(rule, record, targetsOf)) continue;
    if (rule.mode === "allow") {
      // A commandPrefix ALLOW rule vetted only the command's head; a compound
      // command chains an unvetted command after it (`git log && rm -rf x`,
      // or a real newline that normalizeCommand folds to a space), so it
      // never auto-allows. deny/ask rules keep matching compound commands —
      // blocking must stay sticky.
      if (rule.commandPrefix !== undefined && isCompoundShellCommand(record)) continue;
      return { kind: "allow", reason: rule.reason };
    }
    if (rule.mode === "deny") return { kind: "deny", reason: rule.reason || "Blocked by permission rule" };
    if (rule.mode === "ask") return { kind: "ask", reason: rule.reason };
  }
  return { kind: "pass" };
}

function ruleMatches(rule: PermissionRule, record: ToolCallRecord, targetsOf: (raw: string) => string[]): boolean {
  if (rule.tool !== "*" && rule.tool !== record.name) return false;

  if (rule.commandPrefix !== undefined) {
    if (record.name !== "run_shell") return false;
    if (rule.mode === "allow") {
      const cmd = extractCommand(record);
      if (!cmd) return false;
      if (!commandHasPrefix(cmd, rule.commandPrefix)) return false;
    } else {
      // deny/ask must be sticky: match every chained segment and see through
      // wrapper prefixes, or `git status && rm -rf /`, `env X=1 rm -rf /` and
      // `bash -c "rm -rf /"` all escape a deny on `rm` — and deny is the only
      // barrier left when approval heuristics are skipped (always-allow mode).
      const raw = rawCommand(record);
      if (!raw) return false;
      const prefix = rule.commandPrefix;
      if (!targetsOf(raw).some((target) => commandHasPrefix(target, prefix))) return false;
    }
  }

  if (rule.pathGlob !== undefined) {
    const p = extractPath(record);
    if (!p) return false;
    if (!globMatches(rule.pathGlob, p)) return false;
  }

  return true;
}

function isCompoundShellCommand(record: ToolCallRecord): boolean {
  const input = record.input as { command?: unknown } | null | undefined;
  return !!input && typeof input.command === "string" && hasCommandChaining(input.command);
}

function extractCommand(record: ToolCallRecord): string {
  const input = record.input as { command?: unknown } | null | undefined;
  return input && typeof input.command === "string" ? normalizeCommand(input.command) : "";
}

/** RAW (untrimmed-whitespace-structure) command for deny/ask segment matching.
 * normalizeCommand folds newlines to spaces, which would erase the `\n`
 * command separator before the splitter can see it. */
function rawCommand(record: ToolCallRecord): string {
  const input = record.input as { command?: unknown } | null | undefined;
  return input && typeof input.command === "string" ? input.command : "";
}

// Depth cap for recursive unwrapping of `bash -c "…"` scripts and `$(…)` /
// backtick substitutions. Anything deeper than this is adversarial nesting;
// stopping early just falls back to today's behavior (segment unmatched).
const SHELL_TARGET_MAX_DEPTH = 4;

/**
 * Expand a raw shell command into every candidate string a deny/ask
 * commandPrefix rule should be matched against:
 *   - each chained segment (`;`, `&`/`&&`, `|`/`||`, newlines), quote-aware;
 *   - each segment with leading env assignments and wrapper commands
 *     (sudo/env/timeout/nice/nohup/…) stripped;
 *   - the inner script of `bash -c "…"` / `pwsh -Command …` / `cmd /c …`
 *     re-invocations and of `$(…)`/backtick substitutions, recursively.
 * Over-matching here only makes deny/ask stricter (fail-safe); a parse the
 * splitter can't follow simply degrades to the pre-expansion behavior.
 * Exported for tests.
 */
export function shellMatchTargets(raw: string, depth = 0): string[] {
  if (depth > SHELL_TARGET_MAX_DEPTH) return [];
  const targets: string[] = [];
  const { segments, substitutions } = splitChainedSegments(raw);
  for (const segment of segments) {
    const normalized = normalizeCommand(segment);
    if (!normalized) continue;
    targets.push(normalized);
    // `/bin/rm` and `rm.exe` are the same command as `rm` for deny purposes.
    const rebased = rebaseHeadToken(normalized);
    if (rebased !== normalized) targets.push(rebased);
    const { stripped, innerScripts } = stripWrapperPrefix(segment);
    if (stripped && stripped !== normalized) {
      targets.push(stripped);
      const rebasedStripped = rebaseHeadToken(stripped);
      if (rebasedStripped !== stripped) targets.push(rebasedStripped);
    }
    for (const script of innerScripts) targets.push(...shellMatchTargets(script, depth + 1));
  }
  for (const script of substitutions) targets.push(...shellMatchTargets(script, depth + 1));
  return targets;
}

/** Quote-aware split of a raw command into top-level chained segments, plus
 * the bodies of `$(…)` and backtick substitutions (returned separately so the
 * caller can recurse into them as commands in their own right). */
function splitChainedSegments(raw: string): { segments: string[]; substitutions: string[] } {
  const segments: string[] = [];
  const substitutions: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth > 0) {
        if (raw[j] === "(") depth++;
        else if (raw[j] === ")") depth--;
        if (depth > 0) j++;
      }
      substitutions.push(raw.slice(i + 2, j));
      current += " ";
      i = j; // skip past the closing paren (or end of string)
      continue;
    }
    if (ch === "`") {
      const j = raw.indexOf("`", i + 1);
      const end = j === -1 ? raw.length : j;
      substitutions.push(raw.slice(i + 1, end));
      current += " ";
      i = end;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return { segments: segments.filter((segment) => segment.trim().length > 0), substitutions };
}

/** Tokenize a segment keeping quoted spans intact (mirrors the approval-prefix
 * tokenizer in shell-approval.ts). */
function tokenizeSegment(segment: string): string[] {
  return segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquoteToken(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

/** Lowercased head-command word of a token: quotes off, `.exe` off. */
function headWord(token: string): string {
  return unquoteToken(token).toLowerCase().replace(/\.exe$/, "");
}

/** Replace a path-qualified or `.exe`-suffixed head token with its bare
 * command name (`/bin/rm x` / `rm.exe x` → `rm x`) so a deny written against
 * the bare command still bites. */
function rebaseHeadToken(normalized: string): string {
  const spaceIdx = normalized.indexOf(" ");
  const head = spaceIdx === -1 ? normalized : normalized.slice(0, spaceIdx);
  const base = (head.split(/[\\/]/).pop() ?? head).replace(/\.exe$/i, "");
  if (base === head || !base) return normalized;
  return spaceIdx === -1 ? base : `${base}${normalized.slice(spaceIdx)}`;
}

// Wrapper commands whose presence at the head of a segment hides the real
// command from a plain prefix match, mapped to the set of their flags that
// consume a following VALUE token (`sudo -u alice rm …`). Flags not listed
// are treated as bare (`env -i`), so they never swallow the wrapped command.
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "--user", "--group"]),
  doas: new Set(["-u"]),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(),
  env: new Set(["-u", "--unset", "-c", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n"]),
  setsid: new Set(),
};
// POSIX-shell re-invocations: `<shell> … -c <script>` runs <script>.
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Strip leading env assignments (`NAME=value`) and wrapper commands from a
 * segment, returning the residual command plus any inner scripts found in
 * shell re-invocations (`bash -c "…"`, `pwsh -Command …`, `cmd /c …`).
 * Approximate by design: over-stripping only widens what deny/ask can match,
 * and a shape it can't follow returns the segment unchanged (status quo).
 */
function stripWrapperPrefix(segment: string): { stripped: string; innerScripts: string[] } {
  const tokens = tokenizeSegment(segment);
  const innerScripts: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    // Leading environment assignments: FOO=bar cmd …
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++;
      continue;
    }
    const head = headWord(token);
    const base = head.split(/[\\/]/).pop() ?? head;
    if (POSIX_SHELLS.has(base)) {
      const cIdx = tokens.findIndex((t, idx) => idx > i && unquoteToken(t) === "-c");
      if (cIdx !== -1 && cIdx + 1 < tokens.length) innerScripts.push(unquoteToken(tokens[cIdx + 1]!));
      break;
    }
    if (base === "pwsh" || base === "powershell") {
      const cmdIdx = tokens.findIndex((t, idx) => {
        if (idx <= i) return false;
        const flag = unquoteToken(t).toLowerCase();
        return flag === "-command" || flag === "-c";
      });
      if (cmdIdx !== -1 && cmdIdx + 1 < tokens.length) {
        // -Command consumes the rest of the argv; join it back into a script.
        innerScripts.push(tokens.slice(cmdIdx + 1).map(unquoteToken).join(" "));
      }
      break;
    }
    if (base === "cmd") {
      const cIdx = tokens.findIndex((t, idx) => {
        if (idx <= i) return false;
        const flag = unquoteToken(t).toLowerCase();
        return flag === "/c" || flag === "/k";
      });
      if (cIdx !== -1 && cIdx + 1 < tokens.length) innerScripts.push(tokens.slice(cIdx + 1).map(unquoteToken).join(" "));
      break;
    }
    const valueFlags = WRAPPER_VALUE_FLAGS[base];
    if (!valueFlags) break;
    i++;
    // Consume the wrapper's own flags (and their values), plus timeout's
    // positional duration argument.
    while (i < tokens.length) {
      const arg = unquoteToken(tokens[i]!);
      if (arg.startsWith("-")) {
        const bare = arg.split("=")[0]!.toLowerCase();
        i++;
        if (valueFlags.has(bare) && !arg.includes("=") && i < tokens.length) i++;
        continue;
      }
      if (base === "timeout" && /^[0-9]/.test(arg)) {
        i++; // the DURATION positional
        continue;
      }
      break;
    }
  }
  return { stripped: normalizeCommand(tokens.slice(i).join(" ")), innerScripts };
}

function extractPath(record: ToolCallRecord): string {
  const input = record.input as { path?: unknown; uri?: unknown } | null | undefined;
  if (!input) return "";
  if (typeof input.path === "string") return input.path.replace(/\\/g, "/");
  if (typeof input.uri === "string") return input.uri;
  return "";
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function commandHasPrefix(command: string, prefix: string): boolean {
  const cmd = command.toLowerCase();
  const pre = normalizeCommand(prefix).toLowerCase();
  return cmd === pre || cmd.startsWith(`${pre} `);
}

/**
 * Minimal glob matcher supporting:
 *   - `**`  any number of path segments (including zero)
 *   - `*`   any chars within a segment (no `/`)
 *   - `?`   single char within a segment
 *   - `{a,b}` brace alternatives
 * Paths are compared with forward slashes only; backslashes are normalized.
 * Matching is case-insensitive: Windows and macOS default filesystems are
 * case-insensitive, so a case-sensitive deny would be bypassable by changing
 * the case of the path (`.ENV` opens the same file a `.env` deny protects).
 */
export function globMatches(pattern: string, value: string): boolean {
  const path = value.replace(/\\/g, "/");
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — zero or more path segments
        // Consume optional trailing slash so `**/x` matches `x` and `a/b/x`
        const nextSlash = pattern[i + 2] === "/";
        out += nextSlash ? "(?:.*/)?" : ".*";
        i += nextSlash ? 3 : 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") { out += "[^/]"; i++; continue; }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) { out += escapeRe(ch); i++; continue; }
      const alts = pattern.slice(i + 1, close).split(",").map(escapeRe).join("|");
      out += `(?:${alts})`;
      i = close + 1;
      continue;
    }
    out += escapeRe(ch);
    i++;
  }
  out += "$";
  return new RegExp(out, "i");
}

function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function loadFile(file: string): PermissionConfig {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return EMPTY;
  }
  const cached = cache.get(file);
  if (cached && cached.mtime === mtime) return cached.config;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as PermissionConfig;
    const config: PermissionConfig = {
      rules: Array.isArray(parsed?.rules) ? parsed.rules.filter(isValidRule) : [],
    };
    cache.set(file, { mtime, config });
    return config;
  } catch {
    return EMPTY;
  }
}

function isValidRule(rule: unknown): rule is PermissionRule {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Partial<PermissionRule>;
  if (typeof r.tool !== "string") return false;
  if (r.mode !== "allow" && r.mode !== "deny" && r.mode !== "ask") return false;
  return true;
}
