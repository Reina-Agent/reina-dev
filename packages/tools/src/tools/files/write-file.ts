import { createTwoFilesPatch } from "diff";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolImplementation, ToolRuntimeOptions } from "../../types.js";
import { assertWritableWorkspacePath } from "../../utils.js";
import { description } from "../../prompts/write-file.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";

const schema = z.object({
  path: z
    .string()
    .describe(
      "Workspace-relative path. Parent directories are created automatically. Overwrites if the file already exists — use edit_file for in-place changes you want to diff against existing content.",
    ),
  content: z
    .string()
    .describe("Full file contents as a string. UTF-8. Include trailing newline if the file convention expects one."),
});

async function preview(input: unknown, options: ToolRuntimeOptions): Promise<string> {
  const parsed = schema.parse(input);
  const target = assertWritableWorkspacePath(options.cwd, parsed.path);
  const previous = await fs.readFile(target, "utf8").catch(() => "");
  return createTwoFilesPatch(parsed.path, parsed.path, previous, parsed.content);
}

export const writeFileTool: ToolImplementation = {
  descriptor: {
    name: "write_file",
    description,
    permission: "write",
    requiresApproval: true,
    inputSchema: schema,
    examples: [
      {
        description: "Create a new file (parent dirs autocreated)",
        input: { path: "docs/notes/new-feature.md", content: "# New feature\n\nDraft.\n" },
      },
      {
        description: "Overwrite an existing file with full new content",
        input: { path: "package.json", content: '{\n  "name": "example",\n  "version": "1.0.0"\n}\n' },
      },
    ],
  },
  preview,
  async execute(input, options) {
    const parsed = schema.parse(input);
    const target = assertWritableWorkspacePath(options.cwd, parsed.path);
    const existed = await withFileMutationQueue(
      [target],
      async () => {
        const existed = await fs.readFile(target, "utf8").then(
          () => true,
          () => false,
        );
        options.signal?.throwIfAborted();
        await fs.mkdir(path.dirname(target), { recursive: true });
        options.signal?.throwIfAborted();
        await fs.writeFile(target, parsed.content, "utf8");
        return existed;
      },
      options.signal,
    );
    // Don't echo a full diff — for a new file it's just the input content
    // again, and the UI renders the diff from the input regardless. A concise
    // confirmation is enough for the model.
    const lines = parsed.content === "" ? 0 : parsed.content.replace(/\n$/, "").split("\n").length;
    const bytes = Buffer.byteLength(parsed.content, "utf8");
    return `${existed ? "Overwrote" : "Created"} ${parsed.path} (${lines} line${lines === 1 ? "" : "s"}, ${bytes} B)`;
  },
};
