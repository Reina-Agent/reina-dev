import { createTwoFilesPatch } from "diff";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { ToolImplementation, ToolRuntimeOptions } from "../../types.js";
import { assertWritableWorkspacePath } from "../../utils.js";
import { description } from "../../prompts/edit-file.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";

const schema = z.object({
  path: z
    .string()
    .describe(
      "Workspace-relative path of the file to edit. The file MUST have been read in this session (via read_file) before edit_file will accept it — read it first if a stale-cache error fires.",
    ),
  oldText: z
    .string()
    .describe(
      "Exact text to replace. Must match the file's current content. Whitespace-significant; if you're not sure of indentation, copy directly from a recent read_file output. Several relaxed matching strategies (trimmed-boundary, line-trimmed, indentation-flexible, context-anchor) kick in only when exact match fails.",
    ),
  newText: z
    .string()
    .describe(
      "Replacement text. Empty string deletes oldText. Must differ from oldText (identical text raises 'no changes to apply').",
    ),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "When true, replaces every occurrence of oldText in the file. Defaults to false — exactly one match is required, multiple matches throw with a count so you can add surrounding context to disambiguate.",
    ),
});

type Replacement = {
  next: string;
  strategy: string;
  count: number;
};

type TextFile = {
  text: string;
  bom: boolean;
};

async function preview(input: unknown, options: ToolRuntimeOptions): Promise<string> {
  const parsed = schema.parse(input);
  const target = assertWritableWorkspacePath(options.cwd, parsed.path);
  const previous = await readTextFile(target);
  const replacement = replaceText(previous.text, parsed.oldText, parsed.newText, Boolean(parsed.replaceAll));
  return createTwoFilesPatch(parsed.path, parsed.path, previous.text, replacement.next);
}

export const editFileTool: ToolImplementation = {
  descriptor: {
    name: "edit_file",
    description,
    permission: "write",
    requiresApproval: true,
    inputSchema: schema,
    examples: [
      {
        description: "Rename a single function call (one match expected)",
        input: {
          path: "src/utils.ts",
          oldText: "export function parseConfig(",
          newText: "export function parseAgentConfig(",
        },
      },
      {
        description: "Rename a variable everywhere in a file",
        input: {
          path: "src/store.ts",
          oldText: "userCount",
          newText: "activeUserCount",
          replaceAll: true,
        },
      },
      {
        description: "Delete a block — pass empty newText",
        input: {
          path: "src/legacy.ts",
          oldText: "// TODO: remove once Phase 2 ships\nconst LEGACY_FLAG = true;\n\n",
          newText: "",
        },
      },
    ],
  },
  preview,
  async execute(input, options) {
    const parsed = schema.parse(input);
    const target = assertWritableWorkspacePath(options.cwd, parsed.path);
    return withFileMutationQueue(
      [target],
      async () => {
        await assertFresh(target, parsed.path, options);
        const previous = await readTextFile(target);
        const replacement = replaceText(previous.text, parsed.oldText, parsed.newText, Boolean(parsed.replaceAll));
        options.signal?.throwIfAborted();
        await writeTextFile(target, replacement.next, previous.bom);
        const summary = `Replacement strategy: ${replacement.strategy}\nReplacements: ${replacement.count}`;
        // The UI paints the diff from old/newText, and on an exact match the
        // model already knows precisely what changed — so skip the echoed diff.
        // Only when a RELAXED strategy matched do we append it, so the model can
        // confirm the fuzzy hit landed where it intended.
        if (replacement.strategy === "exact") return summary;
        return [
          summary,
          createTwoFilesPatch(
            parsed.path,
            parsed.path,
            normalizeLineEndings(previous.text),
            normalizeLineEndings(replacement.next),
          ),
        ].join("\n");
      },
      options.signal,
    );
  },
};

export async function applyTextEdits(
  requestedPath: string,
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
  options: ToolRuntimeOptions,
): Promise<string> {
  if (edits.length === 0) throw new Error("multi_edit requires at least one edit.");
  const target = assertWritableWorkspacePath(options.cwd, requestedPath);
  return withFileMutationQueue(
    [target],
    async () => {
      await assertFresh(target, requestedPath, options);
      const previous = await readTextFile(target);
      let next = previous.text;
      const summaries: string[] = [];
      let anyFuzzy = false;
      for (const [index, edit] of edits.entries()) {
        const replacement = replaceText(next, edit.oldText, edit.newText, Boolean(edit.replaceAll));
        next = replacement.next;
        if (replacement.strategy !== "exact") anyFuzzy = true;
        summaries.push(`Edit ${index + 1}: ${replacement.strategy}, replacements=${replacement.count}`);
      }
      options.signal?.throwIfAborted();
      await writeTextFile(target, next, previous.bom);
      // Echo the diff only when a relaxed strategy matched (verification); on
      // all-exact edits the summary is enough and the UI shows the diff anyway.
      if (!anyFuzzy) return summaries.join("\n");
      return [
        ...summaries,
        createTwoFilesPatch(
          requestedPath,
          requestedPath,
          normalizeLineEndings(previous.text),
          normalizeLineEndings(next),
        ),
      ].join("\n");
    },
    options.signal,
  );
}

export async function previewTextEdits(
  requestedPath: string,
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
  options: ToolRuntimeOptions,
): Promise<string> {
  if (edits.length === 0) throw new Error("multi_edit requires at least one edit.");
  const target = assertWritableWorkspacePath(options.cwd, requestedPath);
  const previous = await readTextFile(target);
  let next = previous.text;
  const summaries: string[] = [];
  for (const [index, edit] of edits.entries()) {
    const replacement = replaceText(next, edit.oldText, edit.newText, Boolean(edit.replaceAll));
    next = replacement.next;
    summaries.push(`Edit ${index + 1}: ${replacement.strategy}, replacements=${replacement.count}`);
  }
  return [
    ...summaries,
    createTwoFilesPatch(requestedPath, requestedPath, normalizeLineEndings(previous.text), normalizeLineEndings(next)),
  ].join("\n");
}

async function assertFresh(target: string, requested: string, options: ToolRuntimeOptions): Promise<void> {
  const known = options.readFileTimestamps?.[target];
  if (options.readFileTimestamps && known === undefined) {
    throw new Error(`file has not been read yet: ${requested}. Read it before editing.`);
  }
  if (known === undefined) return;
  const stat = await fs.stat(target);
  if (stat.mtimeMs > known + 1) {
    throw new Error(`file changed since last read: ${requested}. Read it again before editing.`);
  }
}

async function readTextFile(file: string): Promise<TextFile> {
  const buffer = await fs.readFile(file);
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  return { bom, text: buffer.subarray(bom ? 3 : 0).toString("utf8") };
}

async function writeTextFile(file: string, text: string, bom: boolean): Promise<void> {
  const body = Buffer.from(text, "utf8");
  await fs.writeFile(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
}

function replaceText(content: string, oldText: string, newText: string, replaceAll: boolean): Replacement {
  if (oldText === newText) throw new Error("No changes to apply: oldText and newText are identical.");
  const ending = detectLineEnding(content);
  const oldWithEnding = convertLineEndings(stripBom(oldText), ending);
  const newWithEnding = convertLineEndings(stripBom(newText), ending);

  for (const [strategy, candidate] of candidates(content, oldWithEnding)) {
    const replaced = replaceLiteral(content, candidate, newWithEnding, replaceAll);
    if (replaced) return { ...replaced, strategy };
  }

  throw new Error(
    "oldText not found (tried exact + 6 fuzzy strategies, none matched). Re-read the file and copy oldText verbatim — indentation and whitespace included — or add more surrounding lines to anchor it. The text may have changed or never existed as written.",
  );
}

function* candidates(content: string, oldText: string): Generator<[string, string]> {
  yield ["exact", oldText];

  const trimmed = oldText.trim();
  if (trimmed && trimmed !== oldText) yield ["trimmed-boundary", trimmed];

  const lineTrimmed = oldText
    .split(/\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (lineTrimmed && lineTrimmed !== oldText) yield ["line-trimmed", lineTrimmed];

  const escaped = unescapeText(oldText);
  if (escaped !== oldText) yield ["escape-normalized", escaped];

  for (const block of indentationFlexibleMatches(content, oldText)) yield ["indentation-flexible", block];
  for (const block of whitespaceNormalizedMatches(content, oldText)) yield ["whitespace-normalized", block];
  for (const block of contextAnchorMatches(content, oldText)) yield ["context-anchor", block];
}

function replaceLiteral(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): Omit<Replacement, "strategy"> | undefined {
  if (!oldText || !content.includes(oldText)) return undefined;
  const count = content.split(oldText).length - 1;
  if (count > 1 && !replaceAll)
    throw new Error(`oldText matched ${count} times; set replaceAll=true or provide more context`);
  return {
    next: replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText),
    count: replaceAll ? count : 1,
  };
}

function* indentationFlexibleMatches(content: string, oldText: string): Generator<string> {
  const wanted = removeCommonIndent(oldText);
  const wantedLines = wanted.split("\n");
  const lines = content.split("\n");
  for (let i = 0; i <= lines.length - wantedLines.length; i++) {
    const block = lines.slice(i, i + wantedLines.length).join("\n");
    if (removeCommonIndent(block) === wanted) yield block;
  }
}

function* whitespaceNormalizedMatches(content: string, oldText: string): Generator<string> {
  const wanted = normalizeWhitespace(oldText);
  if (!wanted) return;
  const lines = content.split("\n");
  const windowSize = oldText.split("\n").length;
  for (let i = 0; i <= lines.length - windowSize; i++) {
    const block = lines.slice(i, i + windowSize).join("\n");
    if (normalizeWhitespace(block) === wanted) yield block;
  }
}

function* contextAnchorMatches(content: string, oldText: string): Generator<string> {
  const wanted = oldText.split("\n").filter((line) => line.trim().length > 0);
  if (wanted.length < 3) return;
  const first = wanted[0]!.trim();
  const last = wanted.at(-1)!.trim();
  const lines = content.split("\n");
  for (let start = 0; start < lines.length; start++) {
    if (lines[start]!.trim() !== first) continue;
    for (let end = start + 2; end < lines.length; end++) {
      if (lines[end]!.trim() !== last) continue;
      const block = lines.slice(start, end + 1).join("\n");
      // Guard against runaway anchor spans: when the anchor lines are common
      // (`}`, `);`, …) the first/last pair can bracket a block far larger
      // than oldText, and the 0.5 line-overlap similarity check alone can
      // still pass on it — silently replacing a big span of unrelated code.
      // Every later `end` only grows the block, so stop scanning this
      // `start` anchor entirely (opencode's isDisproportionateMatch).
      if (isDisproportionateMatch(block, oldText)) break;
      // Only stop at the FIRST `last`-anchor line that actually forms a
      // similar-enough block. Breaking unconditionally on the first matching
      // `last` line would skip a later, correct block when the nearest one
      // isn't a real match.
      if (similarEnough(block, oldText)) {
        yield block;
        break;
      }
    }
  }
}

/** True when a candidate block is so much larger than the oldText it stands
 * in for that replacing it would almost certainly destroy unrelated code:
 * line count at least oldText+3 AND doubled, or (for multi-line oldText)
 * content beyond oldText+500 chars AND quadrupled. Thresholds mirror
 * opencode's edit.ts isDisproportionateMatch. */
function isDisproportionateMatch(candidate: string, oldText: string): boolean {
  const oldLines = oldText.split("\n").length;
  const candidateLines = candidate.split("\n").length;
  if (candidateLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return candidate.trim().length > Math.max(oldText.trim().length + 500, oldText.trim().length * 4);
}

function similarEnough(actual: string, wanted: string): boolean {
  const actualLines = actual
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const wantedLines = wanted
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const total = Math.max(actualLines.length, wantedLines.length);
  if (total === 0) return false;
  const matches = wantedLines.filter((line) => actualLines.includes(line)).length;
  return matches / total >= 0.5;
}

function removeCommonIndent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => (line.trim() ? line.slice(min) : line)).join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unescapeText(text: string): string {
  return text.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "$":
        return "$";
      default:
        return char;
    }
  });
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function convertLineEndings(text: string, ending: "\n" | "\r\n"): string {
  const normalized = normalizeLineEndings(text);
  return ending === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
