import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolExecutionResult, ToolImplementation } from "../../types.js";
import { defaultMaxOutputBytes, truncateToolOutput } from "../../utils.js";
import { description } from "../../prompts/read-file.js";

/** Image extensions Reina can hand back to a vision-capable model as an inline
 * image block. Restricted to the four media types Anthropic accepts in a
 * `tool_result` (png/jpeg/gif/webp) — other raster/vector formats fall through
 * to the normal binary refusal. */
const imageMimeByExt = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

// Cap the image we inline. Base64 inflates bytes ~33%, and the payload is
// re-sent every turn until compaction, so a large screenshot would balloon the
// context. 5 MiB covers real screenshots/diagrams; bigger files are
// auto-downsampled (see downsampleImage) rather than refused outright.
const maxImageBytes = 5 * 1024 * 1024;

// Anthropic auto-resizes any image whose long edge exceeds ~1568px (and bills
// at the resized size), so downsampling to this edge before sending loses no
// fidelity the model would have seen anyway while shrinking the payload. Used
// only on the oversized-image path.
const maxImageEdge = 1568;

// Cap the PDF we inline. Same re-ship-every-turn concern as images, and the
// Anthropic request ceiling is 32 MB total (base64 inflates ~33%). 10 MiB
// (~13 MB encoded) keeps headroom for the rest of the request while covering
// most papers/reports; bigger files get a split/compress hint.
const maxPdfBytes = 10 * 1024 * 1024;

const defaultLimit = 2000;
const maxLineLength = 2000;
const sampleBytes = 4096;
const markdownExtensions = new Set([".md", ".markdown", ".mdx"]);
const outlineMinHeadings = 2;
const outlinePreviewLines = 60;
// A markdown file longer than this (or over the byte cap) gets a section
// outline instead of its full body. Set below the 2000-line read default so
// medium-sized docs benefit, not just files that would be truncated outright.
const outlineLineThreshold = 1000;

const schema = z.object({
  path: z.string().describe("Relative or absolute file path"),
  offset: z.number().int().min(1).optional().describe("1-based line offset"),
  limit: z.number().int().min(1).max(5000).optional().describe("Maximum lines to return"),
  pages: z
    .string()
    .optional()
    .describe("PDF only: page(s) to VIEW as a document (e.g. `3`, `2-5`, `1,4,7`). Omit to get the full extracted text without the heavy document payload; pass this to also attach just those pages for layout/figures/scans."),
});

export const readFileTool: ToolImplementation = {
  descriptor: {
    name: "read_file",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: schema,
    examples: [
      {
        description: "Read a whole file (defaults to lines 1-2000; large files come back with a truncation note)",
        input: { path: "packages/core/src/engine.ts" },
      },
      {
        description: "Window into a known section — line 450 through 549",
        input: { path: "packages/core/src/engine.ts", offset: 450, limit: 100 },
      },
      {
        description: "Continue past a previously-truncated read (the prior output ended with 'Showing lines 1-2000 of 5400. Use offset=2001 to continue.')",
        input: { path: "docs/file-navigation.md", offset: 2001 },
      },
      {
        description: "PDF: get the full extracted text first (no heavy payload)",
        input: { path: "docs/spec.pdf" },
      },
      {
        description: "PDF: then view specific pages as a document (figures/scans/layout)",
        input: { path: "docs/spec.pdf", pages: "3-4" },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    // Pi-style read semantics: relative paths resolve from the session cwd,
    // while absolute paths are used as-is. Unlike mutation/search tools,
    // read_file intentionally has no workspace containment boundary.
    const target = path.resolve(options.cwd, parsed.path);
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!stat) return missingPathResponse(target, parsed.path);

    if (stat.isDirectory()) {
      throw new Error(
        `path is a directory: ${parsed.path}\n`
        + `read_file only reads files. To list entries, run_shell with \`ls\` (POSIX) or \`Get-ChildItem\` (PowerShell).`,
      );
    }
    if (!stat.isFile()) throw new Error(`path is not a regular file: ${parsed.path}`);

    const ext = path.extname(target).toLowerCase();

    // Images: hand the bytes back as an inline image block so a vision-capable
    // model can actually SEE the file (screenshots, diagrams, UI mockups),
    // rather than the old "cannot read binary file" dead-end. The text output
    // is a short note — on text-only model paths that note is all the model
    // gets, since only Anthropic tool_result blocks carry inline images.
    const imageMime = imageMimeByExt.get(ext);
    if (imageMime) {
      return readImage(parsed.path, target, imageMime, stat.size);
    }

    // PDFs (progressive disclosure): by default return the extracted TEXT only
    // (small, readable by every model, no heavy base64 — this is what fixes the
    // request-size blowups). When the model needs to SEE specific pages
    // (layout/figures/scans), it passes `pages` and we attach ONLY those pages
    // sliced into a small sub-PDF. The document block renders natively on
    // Anthropic; elsewhere the text carries the content.
    if (ext === ".pdf") {
      return readPdf(parsed.path, target, stat.size, options.cwd, parsed.pages);
    }

    const sample = await readSample(target);
    if (isBinary(target, sample)) throw new Error(`cannot read binary file: ${parsed.path} (not UTF-8 text). Don't retry read_file on it; inspect bytes with a shell tool (e.g. \`Format-Hex\` / \`xxd\`) if you need them.`);

    const content = await fs.readFile(target, "utf8");

    // Large markdown files: hand back a navigable section outline instead of a
    // blind first-2000-lines slice, so the model can pick the section it needs
    // and read just that (via offset/limit). Only on a naive full read — an
    // explicit offset/limit means the caller is already windowing on purpose,
    // so respect it and fall through to the normal read.
    if (
      markdownExtensions.has(path.extname(target).toLowerCase())
      && parsed.offset === undefined
      && parsed.limit === undefined
    ) {
      const outline = formatMarkdownOutline(parsed.path, content);
      if (outline) {
        return {
          output: (await truncateToolOutput(options.cwd, outline)).content,
          metadata: { readFiles: [{ path: target, mtimeMs: stat.mtimeMs }] },
        };
      }
    }

    // No truncateToolOutput here: the source file is already on disk and
    // offset-addressable, so persisting a byte-capped copy under
    // `.reina/tool-output` would only duplicate content — and reading that
    // copy back can itself exceed the cap and persist AGAIN (a
    // persist→read→persist loop). formatFileContent enforces the byte cap
    // itself and points continuation at offset/limit on the original file.
    const output = formatFileContent(parsed.path, content, parsed.offset ?? 1, parsed.limit ?? defaultLimit);
    return {
      output,
      metadata: {
        readFiles: [{ path: target, mtimeMs: stat.mtimeMs }],
      },
    };
  },
};

// No <path>/<type>/<content> envelope: the model already knows the path (it
// passed it, and tool outputs join their call by call_id), so the echo only
// burned tokens on every read — bare numbered lines + the range note carry
// everything (matches Claude Code / codex CLI read output).
//
// Byte-capped inline: emits whole numbered lines until `defaultMaxOutputBytes`
// is spent, then stops with an accurate continuation offset. Always shows at
// least one line (each already capped by truncateLine), so the cap can never
// produce an empty read.
function formatFileContent(requested: string, content: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/);
  if (offset > lines.length && !(lines.length === 1 && lines[0] === "" && offset === 1)) {
    throw new Error(`offset ${offset} is out of range for ${requested} (${lines.length} lines)`);
  }

  const start = offset - 1;
  const stopAt = Math.min(lines.length, start + limit);
  const out: string[] = [];
  let bytes = 0;
  let index = start;
  let byteCapped = false;
  while (index < stopAt) {
    const row = `${index + 1}: ${truncateLine(lines[index]!)}`;
    const rowBytes = Buffer.byteLength(row, "utf8") + 1;
    if (out.length > 0 && bytes + rowBytes > defaultMaxOutputBytes) {
      byteCapped = true;
      break;
    }
    out.push(row);
    bytes += rowBytes;
    index += 1;
  }
  const end = index;
  const footer =
    end < lines.length
      ? byteCapped
        ? `(Showing lines ${offset}-${end} of ${lines.length} — stopped at the ${Math.round(defaultMaxOutputBytes / 1024)} KB byte cap. Use offset=${end + 1} to continue.)`
        : `(Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.)`
      : `(End of file - total ${lines.length} lines)`;
  return [out.join("\n"), footer].join("\n");
}

/** Read an image file and return it as a tool result carrying an inline image
 * attachment plus a one-line text note. The model sees the image natively on
 * vision-capable Anthropic models; on text-only paths it sees the note. Refuses
 * oversized files (the base64 payload re-ships every turn) with a downscale
 * hint. */
async function readImage(
  requested: string,
  target: string,
  mime: string,
  size: number,
): Promise<ToolExecutionResult> {
  const name = path.basename(target);
  // Widen to Buffer (ArrayBufferLike) so the downsampled jimp buffer — which is
  // typed Buffer<ArrayBufferLike>, not fs.readFile's NonSharedBuffer — assigns
  // back cleanly.
  let bytes: Buffer = await fs.readFile(target);
  let outMime = mime;
  let note = "";

  if (size > maxImageBytes) {
    // Too big to inline verbatim. Rather than reject (the old behavior), try to
    // downsample it to fit — resize to the max edge + re-encode as JPEG. Falls
    // back to a clear error only when decoding fails (corrupt, or a format jimp
    // can't read such as some webp) or it stays over-cap even shrunk.
    const shrunk = await downsampleImage(bytes).catch(() => null);
    if (!shrunk) {
      throw new Error(
        `image too large to inline and could not be downsampled: ${requested} is ${(size / 1024 / 1024).toFixed(1)} MiB (cap ${(maxImageBytes / 1024 / 1024).toFixed(0)} MiB).\n`
        + `Downscale it yourself (e.g. a run_shell image tool) then read the smaller copy.`,
      );
    }
    bytes = shrunk.buffer;
    outMime = "image/jpeg";
    note = ` — downsampled from ${(size / 1024 / 1024).toFixed(1)} MiB to ${(bytes.length / 1024).toFixed(0)} KiB at ${shrunk.width}×${shrunk.height} (JPEG) to fit the inline cap`;
  }

  return {
    output: `Read image ${requested} (${outMime}, ${(bytes.length / 1024).toFixed(0)} KiB)${note}. Attached below as an image — view it directly. (Text-only models receive this note instead of the pixels.)`,
    attachments: [{ kind: "image", mime: outMime, dataBase64: bytes.toString("base64"), name }],
  };
}

/** Shrink an oversized image to fit `maxImageBytes`: scale its long edge down
 * to `maxImageEdge`, then re-encode as JPEG at descending quality (and, if
 * still too big, a smaller edge). Returns null when the bytes can't be decoded
 * (corrupt / unsupported format like some webp) or stay over-cap at the floor —
 * the caller then surfaces a clear error. `jimp` is pure-JS (no native module),
 * dynamically imported so it only loads on the rare oversized-image path. */
async function downsampleImage(
  bytes: Buffer,
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const { Jimp, JimpMime } = await import("jimp");
  const img = await Jimp.read(bytes);
  img.scaleToFit({ w: maxImageEdge, h: maxImageEdge });
  for (const quality of [80, 60, 45, 30]) {
    const out = Buffer.from(await img.getBuffer(JimpMime.jpeg, { quality }));
    if (out.length <= maxImageBytes) return { buffer: out, width: img.width, height: img.height };
  }
  // Still over-cap at low quality: halve the edge once more and retry.
  img.scaleToFit({ w: Math.round(maxImageEdge / 2), h: Math.round(maxImageEdge / 2) });
  const out = Buffer.from(await img.getBuffer(JimpMime.jpeg, { quality: 40 }));
  if (out.length <= maxImageBytes) return { buffer: out, width: img.width, height: img.height };
  return null;
}

/** Shape of the incoming user attachment this module normalizes — kept
 * structural (mirror of protocol's MessageAttachment) so the helper works on
 * both the engine's typed attachments and the host's wire payloads. */
type IncomingImageAttachment = {
  kind?: string;
  mime?: string;
  dataBase64?: string;
  name?: string;
  [key: string]: unknown;
};

/** Normalize a pasted/dragged user attachment the same way read_file treats an
 * on-disk image: over the inline byte cap → downsample (long edge 1568px, JPEG
 * quality ladder) so a 4K screenshot doesn't ship megabytes of base64 into the
 * model request, the rollout log, and every session snapshot. GIFs pass
 * through (jimp would flatten the animation), as does anything that fails to
 * decode — normalization must never block a send. Under-cap images ride
 * unchanged, matching read_file's behavior. */
export async function downsampleOversizedImageAttachment<T extends IncomingImageAttachment>(att: T): Promise<T> {
  if (att.kind !== "image" || !att.dataBase64 || att.mime === "image/gif") return att;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(att.dataBase64, "base64");
  } catch {
    return att;
  }
  if (bytes.length <= maxImageBytes) return att;
  const shrunk = await downsampleImage(bytes).catch(() => null);
  if (!shrunk) return att;
  return { ...att, mime: "image/jpeg", dataBase64: shrunk.buffer.toString("base64") };
}

/** Read a PDF file and return it as a tool result carrying an inline document
 * attachment plus a one-line text note. PDF-capable Anthropic models read the
 * file natively (text + rendered pages); text-only paths get the note. Refuses
 * oversized files (the base64 payload re-ships every turn and the request has a
 * hard size ceiling) with a split/compress hint. */
async function readPdf(
  requested: string,
  target: string,
  size: number,
  cwd: string,
  pagesSpec?: string,
): Promise<ToolExecutionResult> {
  if (size > maxPdfBytes) {
    throw new Error(
      `PDF too large to inline: ${requested} is ${(size / 1024 / 1024).toFixed(1)} MiB (cap ${(maxPdfBytes / 1024 / 1024).toFixed(0)} MiB).\n`
      + `Split it into smaller PDFs or extract the text you need (e.g. a pdftotext run_shell), then read that.`,
    );
  }
  const bytes = await fs.readFile(target);
  const name = path.basename(target);
  const kib = (size / 1024).toFixed(0);

  // Per-page text via unpdf (pure-JS pdf.js). Best-effort: a scanned PDF yields
  // empty strings; a parse failure (encrypted/corrupt) throws.
  const extracted = await extractPdfPages(bytes).catch((error: unknown) => {
    throw new Error(
      `could not read PDF ${requested}: ${error instanceof Error ? error.message : String(error)}. `
      + `It may be encrypted or corrupt; extract text with a shell tool if you have one.`,
    );
  });
  const total = extracted.pages.length;
  const pageText = (i: number): string => extracted.pages[i]?.trim() || "(no extractable text on this page)";

  // Targeted view: attach ONLY the requested pages, sliced into a small sub-PDF
  // (progressive disclosure — keeps the payload bounded by the page range).
  if (pagesSpec) {
    const indices = parsePageSpec(pagesSpec, total);
    const text = indices.map((i) => `=== Page ${i + 1}/${total} ===\n${pageText(i)}`).join("\n\n");
    const sliced = await slicePdf(bytes, indices).catch(() => null);
    const header = sliced
      ? `Read PDF ${requested}, page(s) ${pagesSpec} of ${total}. Text below; those pages are also attached as a document for PDF-capable models (layout/figures/scans).\n\n${text}`
      : `Read PDF ${requested}, page(s) ${pagesSpec} of ${total} (could not slice the document for a visual — text only).\n\n${text}`;
    return {
      output: (await truncateToolOutput(cwd, header)).content,
      ...(sliced
        ? { attachments: [{ kind: "pdf", mime: "application/pdf", dataBase64: sliced.toString("base64"), name: `${name} (p.${pagesSpec})` }] }
        : {}),
    };
  }

  // Default: full extracted text, page-marked, NO document attachment. Text is
  // small and universally readable; the model asks for `pages` only when it
  // needs to SEE a page. This is what keeps PDFs from blowing the request size.
  const hasText = extracted.pages.some((p) => p.trim().length > 0);
  const body = hasText
    ? extracted.pages.map((t, i) => `=== Page ${i + 1}/${total} ===\n${t.trim() || "(no extractable text)"}`).join("\n\n")
    : "(No extractable text — likely a scanned/image PDF.)";
  const note =
    `Read PDF ${requested} (${kib} KiB, ${total} page(s)). Extracted text below — readable by every model. `
    + `To VIEW page(s) as a document (layout/figures/scans, Anthropic), re-read with pages="N" or pages="2-5".\n\n${body}`;
  return { output: (await truncateToolOutput(cwd, note)).content };
}

/** Per-page plain text from a PDF via `unpdf` (pure-JS pdf.js, no native
 * module), dynamically imported so it only loads when a PDF is read. Throws on
 * a parse failure (encrypted/corrupt). Scanned pages come back as empty
 * strings. */
async function extractPdfPages(bytes: Buffer): Promise<{ pages: string[] }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pages: Array.isArray(text) ? text : [text] };
}

/** Slice the given 0-based page indices out of a PDF into a new, smaller PDF.
 * Uses `pdf-lib` (pure JS), dynamically imported. Returns the sub-PDF bytes. */
async function slicePdf(bytes: Buffer, indices: number[]): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  copied.forEach((page) => out.addPage(page));
  return Buffer.from(await out.save());
}

/** Parse a 1-based page spec (`3`, `2-5`, `1,4,7`, or a mix) into sorted,
 * unique, in-range 0-based indices. Throws a corrective error on a malformed
 * spec or out-of-range page so the model can retry with a valid range. */
function parsePageSpec(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const single = /^(\d+)$/.exec(part);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (lo < 1 || hi > total || lo > hi) {
        throw new Error(`pages "${part}" is out of range for a ${total}-page PDF (valid: 1-${total}).`);
      }
      for (let p = lo; p <= hi; p += 1) out.add(p - 1);
    } else if (single) {
      const p = Number(single[1]);
      if (p < 1 || p > total) throw new Error(`page ${p} is out of range for a ${total}-page PDF (valid: 1-${total}).`);
      out.add(p - 1);
    } else {
      throw new Error(`could not parse pages "${part}". Use forms like 3, 2-5, or 1,4,7.`);
    }
  }
  if (out.size === 0) throw new Error(`empty pages spec "${spec}". Use forms like 3, 2-5, or 1,4,7.`);
  return [...out].sort((a, b) => a - b);
}

type MarkdownHeading = { level: number; text: string; line: number };

/** When a markdown file is large enough that a naive read would be truncated,
 * return a navigable section outline (heading tree + per-section line ranges)
 * plus a short preview of the document head, instead of the head-truncated
 * body. The model then reads the section it wants with offset/limit. Returns
 * null when the file is small enough to read whole or has too little structure
 * to be worth an outline — the caller falls back to a normal read. */
function formatMarkdownOutline(requested: string, content: string): string | null {
  const lines = content.split(/\r?\n/);
  const tooLarge =
    lines.length > outlineLineThreshold || Buffer.byteLength(content, "utf8") > defaultMaxOutputBytes;
  if (!tooLarge) return null;

  const headings = parseMarkdownHeadings(lines);
  if (headings.length < outlineMinHeadings) return null;

  const outlineRows = headings.map((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1]!.line - 1 : lines.length;
    const indent = "  ".repeat(Math.max(0, heading.level - 1));
    return `${heading.line}: ${indent}${"#".repeat(heading.level)} ${heading.text}  (lines ${heading.line}-${end})`;
  });

  // Preview the document head (preamble + first section) so the model gets
  // orientation — what the doc is about — without a second call. Bounded so a
  // huge first section can't blow the token budget.
  const firstSectionEnd = headings.length > 1 ? headings[1]!.line - 1 : lines.length;
  const previewCount = Math.min(firstSectionEnd, outlinePreviewLines);
  const preview = lines.slice(0, previewCount);

  return [
    `<note>Large markdown file (${lines.length} lines). Showing a section outline + a short preview instead of the full body to save tokens. `
    + `Read a section with offset (and limit), e.g. read_file(path="${requested}", offset=${headings[0]!.line}). `
    + `Pass an explicit limit to force a full read.</note>`,
    "<outline>",
    outlineRows.join("\n"),
    "</outline>",
    "<preview>",
    preview.map((line, index) => `${index + 1}: ${truncateLine(line)}`).join("\n"),
    previewCount < lines.length
      ? `(Preview of lines 1-${previewCount}. Use the outline above to read further.)`
      : "(End of file)",
    "</preview>",
  ].join("\n");
}

/** Extract ATX markdown headings (`#`..`######`) with their 1-based line
 * numbers, skipping fenced code blocks so a commented `# foo` inside a fence
 * isn't mistaken for a heading. Closing fences match the opening fence char. */
function parseMarkdownHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      headings.push({ level: headingMatch[1]!.length, text: headingMatch[2]!.trim(), line: i + 1 });
    }
  }
  return headings;
}

/** Build a recovery-oriented response for a missing path. Returned as a
 * normal (non-error) tool result so the model doesn't see a red tool_error
 * for what is really an exploration step — the response lists the parent
 * directory's contents (capped at 20 entries) plus fuzzy-match suggestions,
 * which is everything the model needs to pick a real name without retrying.
 *
 * Both the parent dir and (when distinct) the nearest existing ancestor
 * are considered, in case the path is wrong at multiple levels
 * (e.g. `packages/reina-core/src/engin.ts` — neither `reina-core` nor
 * `engin.ts` exists). The ancestor walk costs at most 5 stat calls. */
async function missingPathResponse(target: string, requested: string): Promise<string> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const baseLower = base.toLowerCase();
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .then((items) =>
      items.map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
      })),
    )
    .catch(() => null);

  // No parent dir → walk up to find the nearest ancestor that does exist
  // and list THAT, so we still hand the model something useful.
  if (!entries) {
    const ancestor = await findExistingAncestor(dir);
    if (!ancestor) {
      return `<note>'${requested}' does not exist; no part of the path could be resolved</note>`;
    }
    const ancestorEntries = await fs
      .readdir(ancestor.path, { withFileTypes: true })
      .then((items) => items.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })))
      .catch(() => [] as Array<{ name: string; isDir: boolean }>);
    return [
      `<note>'${requested}' does not exist; showing nearest existing ancestor</note>`,
      `<nearest_ancestor>${ancestor.relative}</nearest_ancestor>`,
      "<entries>",
      formatDirListing(ancestorEntries),
      "</entries>",
    ].join("\n");
  }

  const suggestions = entries
    .filter(
      (entry) =>
        entry.name.toLowerCase().includes(baseLower) || baseLower.includes(entry.name.toLowerCase()),
    )
    .slice(0, 3);

  const parentLabel = path.basename(dir) || ".";
  const lines = [
    `<note>'${requested}' does not exist; showing parent directory '${parentLabel}'</note>`,
  ];
  if (suggestions.length > 0) {
    lines.push("<suggestions>");
    for (const s of suggestions) lines.push(`  ${s.name}${s.isDir ? "/" : ""}`);
    lines.push("</suggestions>");
  }
  lines.push("<entries>");
  lines.push(formatDirListing(entries));
  lines.push("</entries>");
  // Prompt-shape: spell out the recovery options for the model so it
  // doesn't fall into a "try another variant of the same wrong path" loop.
  lines.push("<next_step>Pick a name from the entries above, or call read_file on a higher directory. Do not retry the same path.</next_step>");
  return lines.join("\n");
}

function formatDirListing(entries: Array<{ name: string; isDir: boolean }>): string {
  if (entries.length === 0) return "  (empty)";
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, 20).map((entry) => `  ${entry.name}${entry.isDir ? "/" : ""}`);
  if (sorted.length > 20) shown.push(`  ... (${sorted.length - 20} more)`);
  return shown.join("\n");
}

async function findExistingAncestor(start: string): Promise<{ path: string; relative: string } | null> {
  let current = start;
  for (let step = 0; step < 5; step += 1) {
    const stat = await fs.stat(current).catch(() => null);
    if (stat?.isDirectory()) {
      return { path: current, relative: path.basename(current) || current };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function readSample(target: string): Promise<Buffer> {
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const result = await handle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function isBinary(filePath: string, sample: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) return true;
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

function truncateLine(line: string): string {
  return line.length <= maxLineLength ? line : `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`;
}

const binaryExtensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
]);
