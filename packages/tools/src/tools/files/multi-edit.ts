import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { applyTextEdits, previewTextEdits } from "./edit-file.js";
import { description } from "../../prompts/multi-edit.js";

const editSchema = z.object({
  oldText: z
    .string()
    .describe("Exact text to replace at this edit step. Each edit runs against the result of the previous edit, in order — so oldText must match what the file looks like AFTER prior edits in the same call applied."),
  newText: z.string().describe("Replacement text for this edit step. Empty string deletes oldText. Must differ from oldText."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("When true, replaces every occurrence of this edit's oldText. Defaults to false (single-match required)."),
});

const schema = z.object({
  path: z
    .string()
    .describe("Workspace-relative path. Must have been read this session. All edits in this call apply atomically — if any step fails the file is left unchanged."),
  edits: z
    .array(editSchema)
    .min(1)
    .describe("Ordered list of edits applied sequentially. Use this instead of N back-to-back edit_file calls when you have multiple changes to the same file — saves N-1 approval prompts and is atomic on failure."),
});

export const multiEditTool: ToolImplementation = {
  descriptor: {
    name: "multi_edit",
    description,
    permission: "write",
    requiresApproval: true,
    inputSchema: schema,
    examples: [
      {
        description: "Two coordinated edits in one file (rename + update its callers)",
        input: {
          path: "src/auth.ts",
          edits: [
            { oldText: "export function signIn(", newText: "export function login(" },
            { oldText: "signIn(user)", newText: "login(user)", replaceAll: true },
          ],
        },
      },
      {
        description: "Three small touch-ups atomically — wins if any fail",
        input: {
          path: "package.json",
          edits: [
            { oldText: "\"version\": \"1.0.0\"", newText: "\"version\": \"1.1.0\"" },
            { oldText: "\"node\": \"20.x\"", newText: "\"node\": \"22.x\"" },
            { oldText: "\"private\": false", newText: "\"private\": true" },
          ],
        },
      },
    ],
  },
  async preview(input, options) {
    const parsed = schema.parse(input);
    return previewTextEdits(parsed.path, parsed.edits, options);
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    return applyTextEdits(parsed.path, parsed.edits, options);
  },
};
