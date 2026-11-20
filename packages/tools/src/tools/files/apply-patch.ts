import { execa } from "execa";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { assertWritableWorkspacePath } from "../../utils.js";
import { description } from "../../prompts/apply-patch.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";

const schema = z.object({
  patch: z
    .string()
    .describe(
      "Unified diff text in standard `git apply` format. Must include `--- a/<path>` / `+++ b/<path>` headers and `@@` hunk markers. Workspace-relative paths. Multi-file patches are supported in a single call. Use this when you have a pre-generated diff (e.g. from a previous tool output); prefer edit_file / multi_edit when constructing the change yourself.",
    ),
});

// Git's quoted paths encode UTF-8 bytes as C-style octal escapes, not JSON.
function decodePatchPath(raw: string): string {
  if (!raw.startsWith('"')) return raw.split("\t", 1)[0]!;
  const quoted = /^"((?:\\.|[^"\\])*)"(?:\t.*)?$/.exec(raw);
  if (!quoted) throw new Error("Unsupported quoted patch path.");
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  const chunks: Buffer[] = [];
  for (const part of quoted[1]!.matchAll(/\\([0-3][0-7]{2}|.)|([^\\]+)/gs)) {
    if (part[2] !== undefined) {
      chunks.push(Buffer.from(part[2]));
    } else {
      const escape = part[1]!;
      const byte = /^[0-3][0-7]{2}$/.test(escape) ? Number.parseInt(escape, 8) : escapes[escape];
      if (byte === undefined) throw new Error("Unsupported escape in quoted patch path.");
      chunks.push(Buffer.from([byte]));
    }
  }
  const bytes = Buffer.concat(chunks);
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(bytes)) throw new Error("Patch paths must be valid UTF-8.");
  return decoded;
}

// Include both sides of edits, renames and copies for the write guard and queue.
function extractPatchPaths(patch: string): string[] {
  const out: string[] = [];
  const push = (raw: string, prefix = "") => {
    const decoded = decodePatchPath(raw);
    if (decoded === "/dev/null") return;
    if (!decoded.startsWith(prefix) || decoded.length === prefix.length) {
      throw new Error("Unsupported patch path: use --- a/<path> / +++ b/<path> headers.");
    }
    out.push(decoded.slice(prefix.length));
  };
  for (const section of patch.split(/(?=^diff --git )/m)) {
    const before = out.length;
    const lines = section.split(/\r?\n/);
    let oldRemaining = 0;
    let newRemaining = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      // Hunk contents may themselves start with --- / +++ or rename/copy.
      if (oldRemaining > 0 || newRemaining > 0) {
        if (line.startsWith(" ") || line.startsWith("-")) oldRemaining--;
        if (line.startsWith(" ") || line.startsWith("+")) newRemaining--;
        continue;
      }
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldRemaining = Number(hunk[1] ?? 1);
        newRemaining = Number(hunk[2] ?? 1);
        continue;
      }
      if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
        push(line.slice(4), "a/");
        push(lines[++index]!.slice(4), "b/");
      }
      const move = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
      if (move) push(move[1]!);
    }
    if (section.startsWith("diff --git ") && out.length === before) {
      throw new Error("Unsupported patch section: include unified file headers or rename/copy paths.");
    }
  }
  if (out.length === 0)
    throw new Error("No writable patch paths found: include unified file headers or rename/copy paths.");
  return out;
}

export const applyPatchTool: ToolImplementation = {
  descriptor: {
    name: "apply_patch",
    description,
    permission: "write",
    requiresApproval: true,
    inputSchema: schema,
    examples: [
      {
        description:
          "Apply a one-file unified diff (the typical shape — read the file first to know hunk line numbers)",
        input: {
          patch:
            '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,3 +1,3 @@\n-export const PORT = 3000;\n+export const PORT = 4000;\n const HOST = "localhost";\n',
        },
      },
    ],
  },
  async preview(input) {
    return schema.parse(input).patch;
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    // Same .reina write guard as write_file/edit_file, applied to every path
    // the patch touches BEFORE git apply runs.
    const touched = extractPatchPaths(parsed.patch);
    const targets = [...new Set(touched)].map((file) => assertWritableWorkspacePath(options.cwd, file));
    const result = await withFileMutationQueue(
      targets,
      () =>
        execa("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: options.cwd,
          input: parsed.patch,
          reject: false,
          cancelSignal: options.signal,
        }),
      options.signal,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || "git apply failed");
    // Don't echo the patch back — the model just sent it and the UI renders
    // the diff from the input. Return a one-line confirmation instead.
    const files = [...parsed.patch.matchAll(/^\+\+\+ b\/([^\t\r\n]+)/gm)].map((m) => m[1]!.trim());
    const hunks = (parsed.patch.match(/^@@ /gm) ?? []).length;
    const where = files.length ? files.join(", ") : "(see patch)";
    return `Applied patch → ${where}${hunks ? ` (${hunks} hunk${hunks === 1 ? "" : "s"})` : ""}`;
  },
};
