import { execa } from "execa";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { resolveWorkspacePath, truncateToolOutput } from "../../utils.js";
import { description } from "../../prompts/glob.js";
import { resolveRipgrepBinary } from "./grep.js";

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Glob to match file paths, e.g. `**/*.ts`, `src/**/*.tsx`, `packages/*/package.json`. `**` crosses directories; `*` stays within one segment."),
  path: z
    .string()
    .optional()
    .describe("Workspace-relative directory to search under. Defaults to the workspace root."),
  no_ignore: z
    .boolean()
    .optional()
    .describe(
      "Also list files ripgrep skips by default: .gitignored paths AND dotfiles/dirs (rg --no-ignore --hidden). Default false. Set true when the file lives in a scratch/, build, ignored, or hidden location.",
    ),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe("Cap returned paths (like `| head -N`). Omit for no cap; oversized output is saved to a file you can read_file."),
});

export const globTool: ToolImplementation = {
  descriptor: {
    name: "glob",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: schema,
    examples: [
      {
        description: "Find all test files anywhere in the tree",
        input: { pattern: "**/*.test.ts" },
      },
      {
        description: "Find every package manifest under packages/",
        input: { pattern: "packages/*/package.json" },
      },
      {
        description: "Find React components under a subdir, including gitignored ones",
        input: { pattern: "**/*.tsx", path: "apps/desktop/src", no_ignore: true },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input);

    // rg runs with cwd = workspace root and reads the directory tree (not
    // stdin) because we always pass an explicit path positional. Validate the
    // search root stays inside the workspace.
    const searchPath = parsed.path ?? ".";
    if (parsed.path) resolveWorkspacePath(options.cwd, parsed.path);

    // `--files` lists files instead of searching contents; `--glob` filters
    // them; `--sortr modified` orders newest-first (so files in active flight
    // surface at the top, matching Claude Code's Glob). `--no-messages`
    // swallows unreadable-path noise so a skipped device/permission file
    // doesn't flip the exit code. See grep.ts for the path-separator note.
    const args: string[] = ["--color=never", "--no-messages", "--files", "--sortr", "modified"];
    if (parsed.no_ignore) args.push("--no-ignore", "--hidden");
    args.push("--glob", parsed.pattern, "--", searchPath);

    const result = await execa(resolveRipgrepBinary(), args, {
      cwd: options.cwd,
      reject: false,
      cancelSignal: options.signal,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stripFinalNewline: true,
      stdin: "ignore",
    });

    const stderr = (result.stderr || "").trim();
    if (result.exitCode === undefined) {
      throw new Error(`ripgrep failed to run: ${result.shortMessage ?? result.message ?? "unknown spawn error"}`);
    }
    // exit 1 = no files matched (not an error). exit>=2 WITH stderr is a real
    // usage error (e.g. a malformed glob); exit>=2 with empty stderr just means
    // some files were skipped (unreadable/device) — the listing still ran.
    if (result.exitCode >= 2 && stderr !== "") {
      throw new Error(`ripgrep error (exit ${result.exitCode}): ${stderr}`);
    }
    const someSkipped = result.exitCode >= 2;

    const hasOutput = result.stdout.trim() !== "";
    if (!hasOutput) {
      const where = parsed.path ? ` under ${parsed.path}` : "";
      const ignoreHint = parsed.no_ignore
        ? ""
        : " (Note: .gitignored and hidden files were NOT listed. Retry with no_ignore: true if you expected a hit in an ignored/hidden path.)";
      return { output: `No files match \`${parsed.pattern}\`${where}.${ignoreHint}` };
    }

    let lines = result.stdout.split("\n").map((line) => line.replace(/\\/g, "/").replace(/^\.\//, ""));
    let capped = false;
    if (parsed.head_limit !== undefined && lines.length > parsed.head_limit) {
      lines = lines.slice(0, parsed.head_limit);
      capped = true;
    }

    const warn = someSkipped
      ? `<note>Some paths could not be read and were skipped (e.g. reserved device names / permission).</note>\n`
      : "";
    const header = `<note>${lines.length} file(s) matching \`${parsed.pattern}\`, newest first${capped ? ` (capped at head_limit=${parsed.head_limit})` : ""}.</note>\n`;
    const body = warn + header + lines.join("\n");
    return { output: (await truncateToolOutput(options.cwd, body)).content };
  },
};
