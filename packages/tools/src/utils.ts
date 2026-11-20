import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

export const ignoreGlobs = ["node_modules/**", "dist/**", "target/**", "参考/**", ".git/**"];
export const defaultMaxOutputBytes = 50 * 1024;
export const defaultMaxOutputLines = 2000;

// Strip ANSI/VT escape sequences and stray non-printable control bytes from
// shell command output before it becomes model-visible text. Implemented as a
// char-code scan (no regex literals, no raw control bytes in source) so the
// behaviour is identical under tsc and esbuild. Colour codes, cursor moves and
// binary control bytes from CLI tools (test runners, package managers, progress
// spinners) otherwise poison the transcript and waste tokens. Tab, newline and
// carriage return are deliberately preserved.
export function sanitizeShellOutput(text: string): string {
  if (!text) return text;
  let out = "";
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    // ESC (0x1B) or 8-bit CSI (0x9B): consume the whole escape sequence.
    if (code === 0x1b || code === 0x9b) {
      let j = i + 1;
      if (code === 0x1b && text.charCodeAt(j) === 0x5d) {
        // OSC string: ESC ] ... terminated by BEL (0x07) or ST (ESC \).
        j++;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 0x07) {
            j++;
            break;
          }
          if (c === 0x1b && text.charCodeAt(j + 1) === 0x5c) {
            j += 2;
            break;
          }
          j++;
        }
      } else {
        // CSI / two-char escapes: optional '[' then params, ending at a final
        // byte in 0x40-0x7E.
        if (code === 0x1b && text.charCodeAt(j) === 0x5b) j++;
        while (j < n) {
          const c = text.charCodeAt(j);
          j++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      }
      i = j - 1; // the for-loop increment resumes after the sequence
      continue;
    }
    // Keep tab / newline / carriage return; drop other C0/C1 controls + DEL.
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
    ) {
      out += text[i];
    }
  }
  return out;
}

export function resolveWorkspacePath(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  assertRealTargetWithinWorkspace(root, target, requested);
  return target;
}

// The string-level resolve above is not enough on its own: a symlink/junction
// INSIDE the workspace can point outside it, and the mutation tools would then
// happily write through it. codex/pi do the same realpath walk for their
// writable-root guard. Kept synchronous because resolveWorkspacePath has many
// sync callers (glob, grep, mutation tools, ...).
function assertRealTargetWithinWorkspace(root: string, target: string, requested: string): void {
  let realRoot: string;
  try {
    realRoot = normalizeRealPath(realpathSync(root));
  } catch (error) {
    // The workspace root itself doesn't exist yet — nothing inside it can be
    // a symlink, so the string-level check above is all that can apply.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // The target may not exist yet (write_file creating a NEW file), so realpath
  // the nearest existing ancestor and re-append the missing tail for the
  // comparison. We still hand the original string-resolved `target` back to
  // the caller above — this check only decides whether the access is allowed.
  let ancestor = target;
  const tail: string[] = [];
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = normalizeRealPath(realpathSync(ancestor));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error; // filesystem root — should not happen
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const realTarget = tail.length > 0 ? path.join(realAncestor, ...tail) : realAncestor;
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace through a symlink: ${requested}`);
  }
}

// realpathSync on Windows can return a different drive-letter case (and UNC
// forms with the `native` option) than path.resolve, which would defeat a
// plain prefix compare. NTFS is case-insensitive, so lowercasing both sides
// is the safe normalisation there; POSIX paths are compared as-is.
function normalizeRealPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** `.reina` is Reina's own runtime state (sessions, notes, tool output,
 * conversation history). Unlike codex / Claude Code / pi, whose state lives in
 * the HOME directory out of the model's sight, Reina keeps it inside the
 * workspace — the model constantly sees `.reina/...` paths in tool-output
 * pointers and treats the directory as a scratch area, risking corruption of
 * live session state. The mutation tools (write_file / edit_file / multi_edit
 * / apply_patch) therefore refuse to write there. The user-facing config files
 * directly under `.reina/` stay editable (e.g. "add an MCP server" edits
 * `.reina/mcp.json`). */
const REINA_STATE_DIR = ".reina";
const REINA_EDITABLE_CONFIG_FILES = new Set(["mcp.json", "models.json", "config.json"]);

export function assertWritableWorkspacePath(cwd: string, requested: string): string {
  const target = resolveWorkspacePath(cwd, requested);
  const segments = path.relative(path.resolve(cwd), target).split(path.sep);
  if (segments[0] === REINA_STATE_DIR && !(segments.length === 2 && REINA_EDITABLE_CONFIG_FILES.has(segments[1]!))) {
    throw new Error(
      `refusing to write inside .reina/ — Reina's internal state directory (sessions, notes, tool output, conversation history): ${segments.join("/")}. ` +
        `Use the note tools for notes and keep scratch/temp files elsewhere in the workspace. ` +
        `Only the config files .reina/mcp.json, .reina/models.json and .reina/config.json are editable.`,
    );
  }
  return target;
}

export async function saveToolOutput(cwd: string, content: string): Promise<string> {
  const dir = path.join(resolveWorkspacePath(cwd, ".reina"), "tool-output");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `tool_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}.txt`);
  await fs.writeFile(file, content, "utf8");
  return path.relative(cwd, file);
}

export async function truncateToolOutput(
  cwd: string,
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): Promise<{ content: string; truncated: boolean; outputPath?: string }> {
  return truncateToolOutputWith(truncateText, cwd, content, maxBytes, maxLines);
}

/** Tail-strategy variant of {@link truncateToolOutput}. Keeps the LAST
 * lines/bytes of `content`, which is what shell commands need — exit codes,
 * stderr, and final summaries cluster at the end of long outputs. The full
 * untruncated body is still saved under `.reina/tool-output` for recall. */
export async function truncateToolOutputTail(
  cwd: string,
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): Promise<{ content: string; truncated: boolean; outputPath?: string }> {
  return truncateToolOutputWith(truncateTextTail, cwd, content, maxBytes, maxLines);
}

async function truncateToolOutputWith(
  strategy: (content: string, maxBytes: number, maxLines: number) => string,
  cwd: string,
  content: string,
  maxBytes: number,
  maxLines: number,
): Promise<{ content: string; truncated: boolean; outputPath?: string }> {
  const truncated = strategy(content, maxBytes, maxLines);
  if (truncated === content) return { content, truncated: false };
  const outputPath = await saveToolOutput(cwd, content);
  return {
    content:
      `${truncated}\n\nThe output above was truncated to fit context, but the complete verbatim copy was saved to disk. ` +
      `If the part you need is in the dropped section, call read_file on the path below to recover it — do not re-run the tool or seek another route.\n` +
      `...[full output saved to ${outputPath}]`,
    truncated: true,
    outputPath,
  };
}

/** Result shape for {@link truncateHead} / {@link truncateTail}. Carries
 * enough metadata for callers (renderers, tests) to describe exactly what
 * was dropped without re-scanning the input. */
export interface TruncationResult {
  content: string;
  truncated: boolean;
  /** Which limit fired first, or null when nothing was dropped. */
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  /** Tail-mode only: the first kept line is a UTF-8-safe byte slice of a
   * single oversized last line that consumed the whole budget by itself. */
  firstLinePartial: boolean;
}

/** Head truncation: keep the FIRST whole lines that fit within `maxBytes`
 * and `maxLines`. Suitable for file reads where the model wants to see
 * the beginning. Never returns a partial line; UTF-8 safe by construction
 * (we slice on line boundaries, which are single-byte `\n`).
 *
 * Byte accounting: each kept line costs its UTF-8 byte length plus one
 * byte for the `\n` separator (the first kept line has no leading newline).
 * This matches what the joined output actually serializes to, so the
 * model sees a consistent "X bytes kept" claim. */
export function truncateHead(
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return passthrough(content, totalLines, totalBytes);
  }
  const kept: string[] = [];
  let usedBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length; i++) {
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const line = lines[i]!;
    const lineCost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (usedBytes + lineCost > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    usedBytes += lineCost;
  }
  const outputContent = kept.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    firstLinePartial: false,
  };
}

/** Tail truncation: keep the LAST whole lines that fit within the budget.
 * Suitable for shell output where errors and exit messages live at the
 * end. UTF-8 safe; if a single oversized last line consumes the whole
 * byte budget, the result begins at the next valid UTF-8 boundary
 * (`firstLinePartial=true`) rather than mid-codepoint. */
export function truncateTail(
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return passthrough(content, totalLines, totalBytes);
  }
  const kept: string[] = [];
  let usedBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let firstLinePartial = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const line = lines[i]!;
    const lineCost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (usedBytes + lineCost > maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        const sliced = sliceTailBytes(line, maxBytes);
        kept.unshift(sliced);
        usedBytes = Buffer.byteLength(sliced, "utf8");
        firstLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    usedBytes += lineCost;
  }
  const outputContent = kept.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    firstLinePartial,
  };
}

function passthrough(content: string, totalLines: number, totalBytes: number): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
    firstLinePartial: false,
  };
}

function sliceTailBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  // Start `maxBytes` from the end, then walk forward to the next valid
  // UTF-8 start byte (continuation bytes have the top two bits `10`).
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** Head-strategy text helper. Preserves the legacy "trailing marker" shape
 * so existing callers that splice the return value into XML envelopes
 * keep their layout. */
export function truncateText(
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): string {
  const result = truncateHead(content, maxBytes, maxLines);
  if (!result.truncated) return content;
  return `${result.content}\n${formatTruncationMarker(result, "tail")}`;
}

/** Tail-strategy text helper. The marker goes at the HEAD so the model
 * sees "...[truncated …]" before the kept content — useful when reading
 * shell output, where the kept block is the tail. */
export function truncateTextTail(
  content: string,
  maxBytes = defaultMaxOutputBytes,
  maxLines = defaultMaxOutputLines,
): string {
  const result = truncateTail(content, maxBytes, maxLines);
  if (!result.truncated) return content;
  return `${formatTruncationMarker(result, "head")}\n${result.content}`;
}

function formatTruncationMarker(result: TruncationResult, dropped: "head" | "tail"): string {
  if (result.truncatedBy === "lines") {
    const droppedLines = result.totalLines - result.outputLines;
    return `...[truncated ${droppedLines} lines from ${dropped}]`;
  }
  const droppedBytes = result.totalBytes - result.outputBytes;
  return `...[truncated ${droppedBytes} bytes from ${dropped}]`;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
