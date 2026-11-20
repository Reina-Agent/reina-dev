import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { resolveWorkspacePath, truncateToolOutput } from "../../utils.js";
import { description } from "../../prompts/grep.js";

// ripgrep ships its binary in a platform-specific sibling package
// (`@vscode/ripgrep-<platform>-<arch>`), resolved at runtime. We replicate
// `@vscode/ripgrep`'s tiny resolution logic here rather than importing the
// package's `rgPath`, for two reasons:
//   1. The package is ESM-only; the agent-host bundle is CJS, and we don't
//      want to depend on `require(esm)` support in whatever Node/Electron
//      runtime spawns the host.
//   2. The package's exported `rgPath` does NOT rewrite the asar path, so in a
//      packaged Electron app it points inside `app.asar` — where executables
//      can't run. We do the `app.asar` -> `app.asar.unpacked` swap ourselves
//      (the binary is listed in electron-builder `asarUnpack`).
// `require.resolve` only locates the file; it never loads the ESM module.
//
// Resolution context differs by runtime: the agent-host runs this as a bundled
// CJS module (native `require` available, and `import.meta.url` is empty there —
// so we must NOT depend on it), while vitest runs the source as ESM (no
// `require`). `typeof require` is "undefined" in ESM without throwing, so we
// pick native `require.resolve` in the CJS bundle (resolves from the bundle's
// location → Reina's node_modules) and a cwd-seeded createRequire only for the
// ESM/test path (cwd is the repo root there).
const requireResolve =
  typeof require === "function"
    ? require.resolve
    : createRequire(path.join(process.cwd(), "package.json")).resolve;

let cachedRgPath: string | null = null;
export function resolveRipgrepBinary(): string {
  if (cachedRgPath) return cachedRgPath;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";

  // 1. Bundled platform binary — the normal path: offline, deterministic, no
  //    network. Ships via @vscode/ripgrep's per-platform optional dependency.
  const arch = process.env.npm_config_arch || process.arch;
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
  try {
    const resolved = requireResolve(`${platformPkg}/bin/${binaryName}`);
    cachedRgPath = resolved.replace(/\bapp\.asar\b/, "app.asar.unpacked");
    return cachedRgPath;
  } catch {
    // fall through to the system-PATH fallback
  }

  // 2. System ripgrep on PATH. Covers the cross-build gap (the platform
  //    optional dep only installs on its own OS, so a mac package built on a
  //    non-mac host could ship without the binary) and any arch the optional
  //    deps don't cover. Same "prefer system rg" idea as pi's tools-manager,
  //    but WITHOUT runtime-downloading a binary — that doesn't fit Reina's
  //    local-first, no-network-at-runtime model.
  const probe = spawnSync(binaryName, ["--version"], { stdio: "ignore" });
  if (!probe.error) {
    cachedRgPath = binaryName;
    return cachedRgPath;
  }

  throw new Error(
    `ripgrep is unavailable: neither the bundled ${platformPkg} nor a system \`${binaryName}\` on PATH was found. `
    + `Reinstall dependencies (\`npm install\`) or install ripgrep, or search via run_shell.`,
  );
}

const schema = z.object({
  pattern: z.string().min(1).describe("Rust-regex pattern (ripgrep syntax, not PCRE). Escape literal braces: `interface\\{\\}`."),
  path: z.string().optional().describe("Workspace-relative file or directory to search. Defaults to the workspace root."),
  glob: z.string().optional().describe("Filter files by glob, e.g. `*.ts` or `**/*.test.ts`. Repeatable patterns: comma-separate."),
  type: z.string().optional().describe("Restrict to a ripgrep file type, e.g. `js`, `py`, `rust`, `go`. More efficient than glob for standard types."),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("`files_with_matches` (paths only, default), `content` (matching lines, supports -n/-A/-B/-C), or `count` (per-file match counts)."),
  "-i": z.boolean().optional().describe("Case-insensitive search."),
  "-n": z.boolean().optional().describe("Show 1-based line numbers (content mode only). Defaults to true in content mode."),
  "-A": z.number().int().min(0).max(100).optional().describe("Lines of context AFTER each match (content mode)."),
  "-B": z.number().int().min(0).max(100).optional().describe("Lines of context BEFORE each match (content mode)."),
  "-C": z.number().int().min(0).max(100).optional().describe("Lines of context BEFORE and AFTER each match (content mode). Overrides -A/-B."),
  multiline: z.boolean().optional().describe("Let patterns span lines (`.` matches newlines). Default false."),
  no_ignore: z
    .boolean()
    .optional()
    .describe(
      "Also search files ripgrep skips by default: .gitignored paths AND dotfiles/dirs (rg --no-ignore --hidden). Default false. Set true when a match is expected in an ignored, scratch, build, or hidden location (e.g. files under scratch/ — which is commonly gitignored).",
    ),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe("Cap returned lines/entries (like `| head -N`). Omit for no cap; oversized output is saved to a file you can read_file."),
});

export const grepTool: ToolImplementation = {
  descriptor: {
    name: "grep",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: schema,
    examples: [
      {
        description: "Find which files reference a symbol (paths only)",
        input: { pattern: "AgentEngine", glob: "*.ts" },
      },
      {
        description: "Show matching lines with line numbers and 2 lines of context",
        input: { pattern: "TODO\\(", output_mode: "content", "-n": true, "-C": 2 },
      },
      {
        description: "Case-insensitive count of a log marker under a subdir",
        input: { pattern: "deprecated", path: "packages/core", output_mode: "count", "-i": true },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    const mode = parsed.output_mode ?? "files_with_matches";

    // Validate the search path stays inside the workspace. rg runs with
    // cwd = workspace root. We ALWAYS pass an explicit path (default ".") —
    // ripgrep reads from stdin instead of searching the directory when no path
    // is given and stdin is a pipe (which execa makes it), so omitting the path
    // would hang forever.
    const searchPath = parsed.path ?? ".";
    if (parsed.path) resolveWorkspacePath(options.cwd, parsed.path);

    // NB: we deliberately do NOT pass `--path-separator /`. On Windows that
    // flag makes ripgrep rebuild paths with `/` and then fail the subsequent
    // file IO with "os error 3 (path not found)" on nested trees. Instead rg
    // emits native paths and we normalize the path prefix ourselves below.
    // `--no-messages` suppresses file open/read errors (an unreadable path, a
    // reserved Windows device file like NUL, a permission denial) — the noise
    // that otherwise flips rg to exit 2 even on a clean zero-match search.
    // Crucially it KEEPS regex/usage errors, so after this the only thing left
    // on stderr at exit>=2 is a genuine pattern error (see exit handling below).
    // It is also locale-independent, unlike parsing the (localized) error text.
    const args: string[] = ["--color=never", "--no-messages"];
    // By default rg respects .gitignore/.ignore and skips hidden files — sane
    // for real repos (no node_modules/dist noise), but it also hides the
    // agent's own scratch/ output and gitignored target trees. `no_ignore`
    // opens both up.
    if (parsed.no_ignore) args.push("--no-ignore", "--hidden");
    if (parsed["-i"]) args.push("--ignore-case");
    if (parsed.glob) {
      for (const g of parsed.glob.split(",").map((s) => s.trim()).filter(Boolean)) {
        args.push("--glob", g);
      }
    }
    if (parsed.type) args.push("--type", parsed.type);
    if (parsed.multiline) args.push("--multiline", "--multiline-dotall");

    if (mode === "files_with_matches") {
      args.push("--files-with-matches");
    } else if (mode === "count") {
      args.push("--count");
    } else {
      // content mode
      if (parsed["-n"] !== false) args.push("--line-number");
      if (parsed["-C"] !== undefined) args.push("--context", String(parsed["-C"]));
      else {
        if (parsed["-A"] !== undefined) args.push("--after-context", String(parsed["-A"]));
        if (parsed["-B"] !== undefined) args.push("--before-context", String(parsed["-B"]));
      }
      // Context lines default to a `-` field separator (`path-line-text`),
      // which is ambiguous when a path itself contains `-`. Force `:` so match
      // AND context lines share the `path:line:text` shape — then the first
      // colon reliably delimits the (colon-free) relative path for normalize.
      args.push("--field-context-separator", ":");
    }

    // `-e` guards against a pattern that begins with `-`; `--` ends flags so
    // the path positional can't be misread as one.
    args.push("-e", parsed.pattern, "--", searchPath);

    const result = await execa(resolveRipgrepBinary(), args, {
      cwd: options.cwd,
      reject: false,
      cancelSignal: options.signal,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stripFinalNewline: true,
      // Belt-and-suspenders: even with an explicit path, never let rg block on
      // a piped stdin.
      stdin: "ignore",
    });

    // rg exit codes: 0 = matches, 1 = no matches (not an error), 2 = an error
    // occurred. A missing exitCode means a spawn failure (e.g. ENOENT).
    const stderr = (result.stderr || "").trim();
    const hasOutput = result.stdout.trim() !== "";
    if (result.exitCode === undefined) {
      throw new Error(`ripgrep failed to run: ${result.shortMessage ?? result.message ?? "unknown spawn error"}`);
    }
    // Because `--no-messages` already swallowed file open/read errors, the only
    // way stderr is non-empty at exit>=2 is a genuine regex/usage error — THAT
    // is the only fatal case. A bare exit>=2 with empty stderr just means some
    // files were skipped (NUL device, permission); the search itself ran and a
    // zero-match result there is "No matches", not an error. This is the fix for
    // the Windows-NUL bug where searching a non-existent pattern at the root
    // threw a tool_error instead of returning No matches.
    if (result.exitCode >= 2 && stderr !== "") {
      throw new Error(`ripgrep error (exit ${result.exitCode}): ${stderr}`);
    }
    // exit>=2 with empty stderr == some unreadable files were skipped.
    const someSkipped = result.exitCode !== undefined && result.exitCode >= 2;
    if (!hasOutput) {
      const where = parsed.path ? ` under ${parsed.path}` : "";
      // Most "but rg finds it!" surprises are .gitignore/hidden skips — say so
      // instead of a dead-end, so the model (or user) knows the retry.
      const ignoreHint = parsed.no_ignore
        ? ""
        : " (Note: .gitignored and hidden files were NOT searched. If you expected a hit in a scratch/build/ignored/hidden path, retry with no_ignore: true.)";
      const skipHint = someSkipped ? " Some files could not be read and were skipped." : "";
      return { output: `No matches for /${parsed.pattern}/${where}.${skipHint}${ignoreHint}` };
    }

    // Normalize the PATH PREFIX of each line to plain workspace-relative,
    // forward-slash form (e.g. `.\src\main.ts:1:hit` -> `src/main.ts:1:hit`).
    // A relative path produced from the `.` root never contains a colon, so
    // the first `:` (when present) delimits path from `line:text` / `count`;
    // for files-mode lines (no colon) the whole line is the path. We touch
    // only that prefix, so backslashes/colons inside matched text survive.
    let lines = result.stdout.split("\n").map(normalizePathPrefix);
    let capped = false;
    if (parsed.head_limit !== undefined && lines.length > parsed.head_limit) {
      lines = lines.slice(0, parsed.head_limit);
      capped = true;
    }

    // Surface partial-failure (some files unreadable) as a compact note — the
    // matches are the payload. `--no-messages` already swallowed the per-file
    // error text, so we report the fact, not the (localized) details.
    const warn = someSkipped
      ? `<note>Some files could not be read and were skipped (e.g. reserved device names / permission). Matches below are from the readable files.</note>\n`
      : "";

    const header =
      mode === "files_with_matches"
        ? `<note>${lines.length} file(s) with matches${capped ? ` (capped at head_limit=${parsed.head_limit})` : ""}.</note>\n`
        : capped
          ? `<note>Output capped at head_limit=${parsed.head_limit} lines.</note>\n`
          : "";

    const body = warn + header + lines.join("\n");
    return { output: (await truncateToolOutput(options.cwd, body)).content };
  },
};

/** Rewrite the leading path of one rg output line to forward-slash,
 * workspace-relative form. Operates ONLY on the substring before the first
 * `:` (the colon-free relative path from the `.` root), leaving `line:text` /
 * `count` — and any backslashes or colons inside matched text — untouched.
 * Lines with no colon (files-mode paths, `--` context separators) are treated
 * as all-path. */
function normalizePathPrefix(line: string): string {
  const colon = line.indexOf(":");
  const head = colon === -1 ? line : line.slice(0, colon);
  const rest = colon === -1 ? "" : line.slice(colon);
  const fixed = head.replace(/\\/g, "/").replace(/^\.\//, "");
  return fixed + rest;
}
