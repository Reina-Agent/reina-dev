import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewTool, publicToolDescriptors, runTool } from "./index.js";
import { listBackgroundShellTaskRecords, startBackgroundShell } from "./tools/execution/background-shell.js";
import { shouldAutoBackgroundCommand } from "./tools/execution/shell.js";

let cwd: string;

async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-tools-"));
  await writeFile(path.join(cwd, "README.md"), "hello reina", "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "main.ts"), "function hello() {\n  return 'reina'\n}\n", "utf8");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // A failed assertion must not leave a background shell holding the fixture directory.
  for (const task of await listBackgroundShellTaskRecords(cwd)) {
    if (task.status === "running") await runTool("kill_shell", { taskId: task.id }, { cwd });
  }
  await rmTempDirWithRetry(cwd);
});

async function waitForShellCompletion(result: Awaited<ReturnType<typeof runTool>>) {
  expect(result.error).toBeUndefined();
  if (!result.output?.startsWith("{")) return result;
  const { taskId } = JSON.parse(result.output);
  if (!taskId) return result;
  // Windows CI's first PowerShell invocation can take over 18s before producing output.
  const completed = await runTool("task_output", { taskId, block: true, timeoutMs: 45000 }, { cwd });
  expect(completed.error).toBeUndefined();
  expect(completed.output).toMatch(/<status>(completed|failed)<\/status>/);
  return completed;
}

describe("runTool", () => {
  it("keeps public tool schemas focused on canonical arguments", () => {
    const publicNames = publicToolDescriptors.map((tool) => tool.name);
    const shell = publicToolDescriptors.find((tool) => tool.name === "run_shell")!;
    const taskOutput = publicToolDescriptors.find((tool) => tool.name === "task_output")!;
    const task = publicToolDescriptors.find((tool) => tool.name === "task")!;
    const readSkill = publicToolDescriptors.find((tool) => tool.name === "read_skill")!;

    expect(publicNames).not.toContain("list_files");
    // `grep` (content) and `glob` (filename, ripgrep-backed) are both
    // first-class read tools now. `code_search` remains intentionally absent —
    // codegraph covers structural search without widening the tool surface.
    expect(publicNames).toContain("grep");
    expect(publicNames).toContain("glob");
    expect(publicNames).not.toContain("code_search");
    expect(publicNames).not.toContain("git_status");
    expect(publicNames).not.toContain("git_diff");
    expect(publicNames).not.toContain("repo_overview");
    expect(publicNames).not.toContain("compact_conversation");
    expect(schemaKeys(shell)).toEqual(["command", "shell", "workdir", "timeoutMs", "runInBackground", "pty"]);
    expect(schemaKeys(taskOutput)).toEqual(["taskId", "block", "timeoutMs"]);
    expect(schemaKeys(task)).toEqual(["description", "agent", "isolate", "background", "name", "fork", "skill", "subtaskId"]);
    expect(schemaKeys(readSkill)).toEqual(["name"]);
    expect(publicNames).toContain("get_async_tasks");
    expect(publicNames).not.toContain("start_async_task");
    expect(publicNames).not.toContain("check_async_task");
    expect(publicNames).not.toContain("list_async_tasks");
    expect(publicNames).not.toContain("gather_async_tasks");
  });

  it("reads files inside workspace", async () => {
    const result = await runTool("read_file", { path: "README.md" }, { cwd });
    expect(result.output).toContain("hello reina");
  });

  it("returns precise validation errors that a model can repair", async () => {
    const result = await runTool("run_shell", { cmd: "echo hello", timeoutMs: "soon" }, { cwd });

    expect(result.error).toContain('<tool_error tool="run_shell" phase="input_validation">');
    expect(result.error).toContain("command");
    expect(result.error).toContain(
      '<accepted_fields path="(root)">command, shell, workdir, timeoutMs, runInBackground, pty</accepted_fields>',
    );
    expect(result.error).toContain("<required_fields>command</required_fields>");
    expect(result.error).toContain('"cmd": "echo hello"');
    expect(result.error).toContain("Retry run_shell with corrected JSON arguments");
  });

  it("surfaces accepted_fields for the nested container when a nested key is wrong", async () => {
    // The "right tool, wrong nested arg" failure mode: a typo inside a
    // multi_edit edit (`olText` for `oldText`) used to land on the inner
    // object's required-key error with only the TOP-LEVEL accepted_fields
    // listed, leaving the model without sibling keys to self-correct from.
    // Now the error names both the (root) shape AND `edits.[]` so the
    // model sees `oldText, newText, replaceAll` and can pick the right key.
    const result = await runTool(
      "multi_edit",
      { path: "README.md", edits: [{ olText: "hello", newText: "world" }] },
      { cwd },
    );
    expect(result.error).toContain('<tool_error tool="multi_edit" phase="input_validation">');
    expect(result.error).toContain('<accepted_fields path="(root)">path, edits</accepted_fields>');
    expect(result.error).toContain(
      '<accepted_fields path="edits.[]">oldText, newText, replaceAll</accepted_fields>',
    );
    // The Zod issue path tells the model exactly which slot in the array
    // is wrong, so the fix is mechanical.
    expect(result.error).toMatch(/edits\.0\.oldText: Required/);
  });

  it("reads absolute and parent-relative paths outside the workspace", async () => {
    const externalName = `${path.basename(cwd)}-outside.txt`;
    const externalPath = path.join(path.dirname(cwd), externalName);
    await writeFile(externalPath, "outside content", "utf8");
    try {
      const absolute = await runTool("read_file", { path: externalPath }, { cwd });
      expect(absolute.error).toBeUndefined();
      expect(absolute.output).toContain("outside content");

      const relative = await runTool("read_file", { path: `../${externalName}` }, { cwd });
      expect(relative.error).toBeUndefined();
      expect(relative.output).toContain("outside content");
    } finally {
      await rm(externalPath, { force: true });
    }
  });

  it("keeps mutation tools confined to the workspace", async () => {
    const externalName = `${path.basename(cwd)}-write-outside.txt`;
    const externalPath = path.join(path.dirname(cwd), externalName);
    try {
      const result = await runTool(
        "write_file",
        { path: `../${externalName}`, content: "must not be written" },
        { cwd },
      );
      expect(result.error).toContain("escapes workspace");
      await expect(stat(externalPath)).rejects.toThrow();
    } finally {
      await rm(externalPath, { force: true });
    }
  });

  it("reads files with line offsets", async () => {
    const result = await runTool("read_file", { path: "src/main.ts", offset: 2, limit: 1 }, { cwd });
    expect(result.output).toContain("2:   return 'reina'");
  });

  it("read_file byte-caps a huge text read inline and points continuation at offset, not a disk copy", async () => {
    // ~120 KB over 3000 lines: over the 50 KB byte cap while under the 5000-line
    // schema max. The old path persisted a duplicate copy under
    // .reina/tool-output and pointed the model at THAT file — whose read-back
    // could itself exceed the cap and persist again (persist→read→persist
    // loop). The source file is offset-addressable; continuation must use it.
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"padding ".repeat(4)}`).join("\n");
    await writeFile(path.join(cwd, "big.txt"), big, "utf8");

    const result = await runTool("read_file", { path: "big.txt", limit: 5000 }, { cwd });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("byte cap");
    const match = result.output!.match(/Showing lines 1-(\d+) of 3000 — stopped at the 50 KB byte cap\. Use offset=(\d+) to continue\./);
    expect(match).not.toBeNull();
    // The continuation offset is exact: last shown line + 1.
    expect(Number(match![2])).toBe(Number(match![1]) + 1);
    expect(result.output).not.toContain("full output saved to");
    // No duplicate copy written to disk.
    await expect(stat(path.join(cwd, ".reina", "tool-output"))).rejects.toThrow();
  });

  it("grep lists files with matches by default", async () => {
    const result = await runTool("grep", { pattern: "reina" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("README.md");
    expect(result.output).toContain("src/main.ts");
    expect(result.output).toContain("file(s) with matches");
  });

  it("grep content mode returns matching lines with line numbers", async () => {
    const result = await runTool(
      "grep",
      { pattern: "function", output_mode: "content" },
      { cwd },
    );
    expect(result.output).toContain("src/main.ts:1:function hello() {");
  });

  it("grep honours glob filters", async () => {
    const result = await runTool("grep", { pattern: "reina", glob: "*.md" }, { cwd });
    expect(result.output).toContain("README.md");
    expect(result.output).not.toContain("src/main.ts");
  });

  it("grep count mode reports per-file counts", async () => {
    const result = await runTool(
      "grep",
      { pattern: "reina", path: "src", output_mode: "count" },
      { cwd },
    );
    expect(result.output).toMatch(/main\.ts.*1/s);
  });

  it("grep content+context keeps forward-slash paths and preserves backslashes in matched text", async () => {
    await mkdir(path.join(cwd, "a-b", "deep"), { recursive: true });
    // A dash in the dir name + a backslash in the matched text are the two
    // things the path-prefix normalizer must NOT corrupt.
    await writeFile(
      path.join(cwd, "a-b", "deep", "esc.ts"),
      "const head = 1\nconst x = \"\\\\d+\"\nconst tail = 2\n",
      "utf8",
    );
    const result = await runTool(
      "grep",
      { pattern: "\\\\d\\+", output_mode: "content", "-C": 1 },
      { cwd },
    );
    expect(result.error).toBeUndefined();
    // Forward-slash path even though the dir name contains a dash and rg ran
    // on Windows (where it emits backslash separators + a `-` context sep).
    expect(result.output).toContain("a-b/deep/esc.ts:");
    expect(result.output).not.toContain("a-b\\deep");
    // The literal backslashes inside the matched source line survive.
    expect(result.output).toContain('"\\\\d+"');
    // Context line (the preceding `const head = 1`) is present.
    expect(result.output).toContain("const head = 1");
  });

  it("grep skips ignored paths by default but finds them with no_ignore", async () => {
    // Use `.ignore` (ripgrep honours it whether or not the dir is a git repo;
    // `.gitignore` only applies inside a git repo). Same ignore code path that
    // hides a gitignored scratch/ in a real workspace — and the same one
    // `--no-ignore` turns off.
    await writeFile(path.join(cwd, ".ignore"), "scratch/\n", "utf8");
    await mkdir(path.join(cwd, "scratch"), { recursive: true });
    await writeFile(path.join(cwd, "scratch", "testgrep.txt"), "checkAutoType here\n", "utf8");

    // Default: traversal honours .gitignore, so the scratch file is invisible —
    // and the no-match note must point at the no_ignore retry (the real footgun
    // the user hit: rg finds it directly, the tool's default traversal doesn't).
    const skipped = await runTool("grep", { pattern: "checkAutoType" }, { cwd });
    expect(skipped.output).toContain("No matches");
    expect(skipped.output).toContain("no_ignore");

    // no_ignore: true reaches into the gitignored scratch dir.
    const found = await runTool("grep", { pattern: "checkAutoType", no_ignore: true }, { cwd });
    expect(found.output).toContain("scratch/testgrep.txt");
  });

  it("grep returns a clean no-match result rather than an error", async () => {
    const result = await runTool("grep", { pattern: "zzz_no_such_token_zzz" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("No matches");
  });

  it("grep blocks path escapes", async () => {
    const result = await runTool("grep", { pattern: "x", path: "../.." }, { cwd });
    expect(result.error).toContain("escapes workspace");
  });

  it("grep surfaces a real ripgrep error (invalid regex) when there is no output", async () => {
    // Unclosed group => rg exits 2 with a regex-parse error and no matches.
    // This is the genuinely-fatal exit-2 path that must still throw (as
    // opposed to exit-2-with-partial-output, which returns results).
    const result = await runTool("grep", { pattern: "foo(" }, { cwd });
    expect(result.error).toContain("ripgrep error");
  });

  it("rejects directories and points to run_shell", async () => {
    const result = await runTool("read_file", { path: "src" }, { cwd });
    expect(result.error).toContain("path is a directory");
    expect(result.error).toContain("run_shell");
  });

  it("rejects binary files", async () => {
    await writeFile(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await runTool("read_file", { path: "blob.bin" }, { cwd });
    expect(result.error).toContain("cannot read binary file");
  });

  it("read_file returns an image as an inline attachment", async () => {
    // 1x1 transparent PNG. Bytes are binary, so the old isBinary() guard would
    // have rejected it — images must be intercepted before that check.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(cwd, "shot.png"), png);
    const result = await runTool("read_file", { path: "shot.png" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("image/png");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png" });
    expect(result.attachments![0]!.dataBase64).toBe(png.toString("base64"));
  });

  it("downsampleOversizedImageAttachment shrinks an over-cap pasted image and passes small/non-image through", async () => {
    const { downsampleOversizedImageAttachment } = await import("./index.js");
    // Small image: untouched, same object semantics as read_file's under-cap path.
    const tiny = { kind: "image", mime: "image/png", dataBase64: "iVBORw0KGgo=", name: "t.png" };
    expect(await downsampleOversizedImageAttachment(tiny)).toBe(tiny);
    // Non-image: untouched.
    const doc = { kind: "document", mime: "application/pdf", dataBase64: "AAAA" };
    expect(await downsampleOversizedImageAttachment(doc)).toBe(doc);
    // Oversized noise PNG (same recipe as the read_file test below): shrunk to
    // an under-cap JPEG, name preserved.
    const { Jimp, JimpMime } = await import("jimp");
    const img = new Jimp({ width: 1600, height: 1600, color: 0x000000ff });
    randomBytes(img.bitmap.data.length).copy(img.bitmap.data);
    const png = Buffer.from(await img.getBuffer(JimpMime.png));
    expect(png.length).toBeGreaterThan(5 * 1024 * 1024);
    const big = { kind: "image", mime: "image/png", dataBase64: png.toString("base64"), name: "paste.png" };
    const out = await downsampleOversizedImageAttachment(big);
    expect(out.mime).toBe("image/jpeg");
    expect(out.name).toBe("paste.png");
    const bytes = Buffer.from(out.dataBase64!, "base64");
    expect(bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG magic
    // Undecodable oversized junk: passes through unchanged (never blocks a send).
    const junk = { kind: "image", mime: "image/jpeg", dataBase64: Buffer.alloc(6 * 1024 * 1024, 1).toString("base64") };
    expect(await downsampleOversizedImageAttachment(junk)).toBe(junk);
  }, 30000);

  it("read_file downsamples an oversized image instead of rejecting", async () => {
    const { Jimp, JimpMime } = await import("jimp");
    // 1600×1600 of random noise → an incompressible PNG well over the 5 MiB cap.
    const img = new Jimp({ width: 1600, height: 1600, color: 0x000000ff });
    randomBytes(img.bitmap.data.length).copy(img.bitmap.data);
    const png = Buffer.from(await img.getBuffer(JimpMime.png));
    expect(png.length).toBeGreaterThan(5 * 1024 * 1024);
    await writeFile(path.join(cwd, "big.png"), png);

    const result = await runTool("read_file", { path: "big.png" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("downsampled");
    expect(result.attachments?.[0]?.mime).toBe("image/jpeg");
    const out = Buffer.from(result.attachments![0]!.dataBase64, "base64");
    expect(out.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(out.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG magic
  }, 20000);

  it("read_file errors when an oversized image cannot be decoded for downsampling", async () => {
    // Junk bytes with an image extension: too big to inline, and jimp can't
    // decode it → falls back to a clear error (not a silent pass).
    await writeFile(path.join(cwd, "huge.jpg"), Buffer.alloc(6 * 1024 * 1024, 1));
    const result = await runTool("read_file", { path: "huge.jpg" }, { cwd });
    expect(result.error).toContain("could not be downsampled");
  });

  async function makePdf(cwd: string, name: string, pages: number): Promise<void> {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      doc.addPage([300, 144]).drawText(`Page ${i + 1} content`, { x: 20, y: 100, size: 18 });
    }
    await writeFile(path.join(cwd, name), Buffer.from(await doc.save()));
  }

  it("read_file PDF default returns page-marked text and NO document attachment", async () => {
    await makePdf(cwd, "report.pdf", 3);
    const result = await runTool("read_file", { path: "report.pdf" }, { cwd });
    expect(result.error).toBeUndefined();
    // Full extracted text, page-marked, readable by every model.
    expect(result.output).toContain("Page 1/3");
    expect(result.output).toContain("Page 3/3");
    expect(result.output).toContain("Page 1 content");
    // Progressive disclosure: no heavy base64 by default.
    expect(result.attachments).toBeUndefined();
  });

  it("read_file PDF with pages attaches only those pages as a sliced document", async () => {
    await makePdf(cwd, "report.pdf", 5);
    const full = (await readFile(path.join(cwd, "report.pdf"))).length;
    const result = await runTool("read_file", { path: "report.pdf", pages: "2-3" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("page(s) 2-3 of 5");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    // The sliced sub-PDF is a real PDF and smaller than the full document.
    const sliced = Buffer.from(result.attachments![0]!.dataBase64, "base64");
    expect(sliced.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(sliced.length).toBeLessThan(full);
  });

  it("read_file PDF rejects an out-of-range pages spec with a corrective hint", async () => {
    await makePdf(cwd, "report.pdf", 2);
    const result = await runTool("read_file", { path: "report.pdf", pages: "5" }, { cwd });
    expect(result.error).toContain("out of range");
    expect(result.error).toContain("1-2");
  });

  it("read_file refuses an oversized PDF with a split/extract hint", async () => {
    await writeFile(path.join(cwd, "huge.pdf"), Buffer.alloc(11 * 1024 * 1024, 1));
    const result = await runTool("read_file", { path: "huge.pdf" }, { cwd });
    expect(result.error).toContain("too large to inline");
    expect(result.error).toContain("extract the text");
  });

  it("glob lists files by name pattern, newest first", async () => {
    await mkdir(path.join(cwd, "pkg"), { recursive: true });
    await writeFile(path.join(cwd, "pkg", "a.test.ts"), "test('a', () => {})\n", "utf8");
    await writeFile(path.join(cwd, "src", "b.test.ts"), "test('b', () => {})\n", "utf8");
    const result = await runTool("glob", { pattern: "**/*.test.ts" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("pkg/a.test.ts");
    expect(result.output).toContain("src/b.test.ts");
    // Forward-slash, workspace-relative paths (no leading ./ or backslashes).
    expect(result.output).not.toContain("\\");
    expect(result.output).not.toContain("./");
  });

  it("glob returns a clean no-match result rather than an error", async () => {
    const result = await runTool("glob", { pattern: "**/*.nope" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("No files match");
  });

  it("glob skips ignored paths by default but finds them with no_ignore", async () => {
    await writeFile(path.join(cwd, ".ignore"), "scratch/\n", "utf8");
    await mkdir(path.join(cwd, "scratch"), { recursive: true });
    await writeFile(path.join(cwd, "scratch", "hidden.ts"), "export const x = 1\n", "utf8");

    const skipped = await runTool("glob", { pattern: "**/hidden.ts" }, { cwd });
    expect(skipped.output).toContain("No files match");
    expect(skipped.output).toContain("no_ignore");

    const found = await runTool("glob", { pattern: "**/hidden.ts", no_ignore: true }, { cwd });
    expect(found.output).toContain("scratch/hidden.ts");
  });

  it("glob blocks path escapes", async () => {
    const result = await runTool("glob", { pattern: "*", path: "../.." }, { cwd });
    expect(result.error).toContain("escapes workspace");
  });

  it("edits files with indentation-flexible matching", async () => {
    const result = await runTool(
      "edit_file",
      { path: "src/main.ts", oldText: "return 'reina'", newText: "return 'agent'" },
      { cwd },
    );
    const edited = await readFile(path.join(cwd, "src", "main.ts"), "utf8");

    expect(result.output).toContain("Replacement strategy");
    expect(edited).toContain("return 'agent'");
  });

  it("context-anchor refuses a block far larger than oldText (disproportionate-match guard)", async () => {
    // The first/last anchor lines bracket SIX lines, oldText has three. All
    // three oldText lines appear in the block, so the 0.5 line-overlap
    // similarity check alone would accept it and the edit would silently
    // wipe the unrelated lines in between. The guard must refuse instead.
    const target = path.join(cwd, "src", "anchor.ts");
    const content = ["if (x) {", '  log("a")', "  cleanup()", "  other()", "  danger()", "}", ""].join("\n");
    await writeFile(target, content, "utf8");

    const result = await runTool(
      "edit_file",
      { path: "src/anchor.ts", oldText: "if (x) {\n  cleanup()\n}", newText: "if (x) { cleanup() }" },
      { cwd },
    );

    expect(result.error).toContain("not found");
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("context-anchor still matches a proportionate block", async () => {
    // Same anchor shape, but the block is only one line larger than oldText —
    // well inside the guard's threshold, so the fuzzy match still lands.
    const target = path.join(cwd, "src", "anchor-ok.ts");
    const content = ["if (x) {", '  log("a")', "  cleanup()", "}", ""].join("\n");
    await writeFile(target, content, "utf8");

    const result = await runTool(
      "edit_file",
      { path: "src/anchor-ok.ts", oldText: "if (x) {\n  cleanup()\n}", newText: "cleanupGuarded()" },
      { cwd },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("context-anchor");
    expect(await readFile(target, "utf8")).toContain("cleanupGuarded()");
  });

  it("applies multiple edits atomically", async () => {
    const result = await runTool(
      "multi_edit",
      {
        path: "src/main.ts",
        edits: [
          { oldText: "function hello", newText: "function greet" },
          { oldText: "return 'reina'", newText: "return 'agent'" },
        ],
      },
      { cwd },
    );
    const edited = await readFile(path.join(cwd, "src", "main.ts"), "utf8");

    expect(result.output).toContain("Edit 1");
    expect(edited).toContain("function greet");
    expect(edited).toContain("return 'agent'");
  });

  it("rejects edits when a previously read file changed", async () => {
    const target = path.join(cwd, "src", "main.ts");
    const readAt = (await stat(target)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(target, "function changed() {\n  return 'reina'\n}\n", "utf8");

    const result = await runTool(
      "edit_file",
      { path: "src/main.ts", oldText: "reina", newText: "agent" },
      { cwd, readFileTimestamps: { [target]: readAt } },
    );

    expect(result.error).toContain("file changed since last read");
  });

  it("preserves BOM and CRLF when editing files", async () => {
    const target = path.join(cwd, "src", "windows.ts");
    await writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const value = 'reina'\r\n", "utf8")]));

    const result = await runTool(
      "edit_file",
      { path: "src/windows.ts", oldText: "const value = 'reina'\n", newText: "const value = 'agent'\n" },
      { cwd },
    );
    const edited = await readFile(target);

    expect(result.output).toContain("Replacement strategy");
    expect([...edited.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(edited.toString("utf8")).toContain("const value = 'agent'\r\n");
  });

  it("runs shell commands in a workspace subdirectory", async () => {
    const result = await runTool("run_shell", { command: "node -e \"console.log(process.cwd())\"", workdir: "src" }, { cwd, signal: new AbortController().signal });
    // Success emits just the output — no status marker.
    expect(result.output).not.toContain("<exit_code>");
    expect(result.output).toContain("src");
  });

  it("runs shell commands from an absolute workdir outside the workspace", async () => {
    const external = await mkdtemp(path.join(os.tmpdir(), "reina-shell-external-"));
    await writeFile(path.join(external, "marker.txt"), "external workdir", "utf8");
    try {
      const result = await runTool(
        "run_shell",
        { command: "node -e \"console.log(require('node:fs').readFileSync('marker.txt', 'utf8'))\"", workdir: external },
        { cwd, signal: new AbortController().signal },
      );
      expect(result.error).toBeUndefined();
      expect(result.output).toContain("external workdir");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.each([8000, 0])("runs PowerShell semantics when shell:'powershell' is requested on Windows (foreground wait %i ms)", async (foregroundWaitMs) => {
    if (process.platform !== "win32") return;
    vi.stubEnv("REINA_SHELL_AUTO_BACKGROUND_AFTER_MS", String(foregroundWaitMs));
    const result = await waitForShellCompletion(await runTool("run_shell", { command: "Get-ChildItem README.md | Select-Object -First 1", shell: "powershell" }, { cwd }));

    expect(result.output).not.toMatch(/<exit_code>(?!0<)/);
    const stdout = result.output?.startsWith("<task_id>")
      ? result.output.match(/<stdout>([\s\S]*?)<\/stdout>/)?.[1] ?? ""
      : result.output;
    expect(stdout).toContain("README.md");
  }, 60000);

  it("defaults to a non-PowerShell shell on Windows (bash or cmd)", async () => {
    if (process.platform !== "win32") return;
    const preview = await previewTool("run_shell", { command: "echo hi" }, { cwd, signal: new AbortController().signal });

    expect(preview).toMatch(/Shell: (bash|cmd)/);
    expect(preview).not.toContain("Shell: powershell");
  });

  it.each([8000, 0])("keeps localized Windows shell errors readable under PowerShell (foreground wait %i ms)", async (foregroundWaitMs) => {
    if (process.platform !== "win32") return;
    vi.stubEnv("REINA_SHELL_AUTO_BACKGROUND_AFTER_MS", String(foregroundWaitMs));
    const result = await waitForShellCompletion(await runTool("run_shell", { command: "reina_missing_command_12345", shell: "powershell" }, { cwd }));

    expect(result.output).toContain("<exit_code>1</exit_code>");
    expect(result.output).not.toContain("�");
  }, 60000);

  it("adds a hint for Unix-style shell commands on Windows", async () => {
    if (process.platform !== "win32") return;
    // This hint belongs to the foreground result; handoff is covered separately.
    vi.stubEnv("REINA_SHELL_AUTO_BACKGROUND_AFTER_MS", "60000");
    // The hint only fires on FAILED Unix-looking commands (see
    // `shellFailureHint`). Pick a `grep` invocation against a guaranteed-
    // missing path so the command exits non-zero whether the test runner has
    // pure PowerShell or Git Bash's coreutils on PATH. The earlier
    // `find . -maxdepth 2 -type f` variant accidentally succeeded on
    // Git-Bash-equipped machines (PATH-resolved to Git's `find`), which
    // suppressed the hint and made the test flake.
    const result = await runTool(
      "run_shell",
      { command: "grep needle /__reina_does_not_exist_zzz__", shell: "powershell" },
      { cwd },
    );

    expect(result.output).not.toContain("<exit_code>0</exit_code>");
    expect(result.output).toContain("<hint>");
    expect(result.output).toContain("Windows PowerShell");
  });

  it("previews commands that will auto-run in background", async () => {
    const preview = await previewTool("run_shell", { command: "npm run dev" }, { cwd, signal: new AbortController().signal });
    expect(preview).toContain("Run in background: auto");
  });

  it("preview surfaces the interpreter the command will run under", async () => {
    const preview = await previewTool("run_shell", { command: "echo hi" }, { cwd, signal: new AbortController().signal });
    expect(preview).toContain("Shell:");
  });

  it("runs a command under an explicitly requested shell (cmd on Windows)", async () => {
    if (process.platform !== "win32") return;
    const result = await runTool("run_shell", { command: "echo cmd-shell-ok", shell: "cmd" }, { cwd });
    expect(result.output).not.toContain("<exit_code>");
    expect(result.output).toContain("cmd-shell-ok");
  });

  it("streams shell command progress while running", async () => {
    const progress: Array<{ status: string; output?: string; totalBytes?: number }> = [];
    const result = await runTool(
      "run_shell",
      { command: "node -e \"console.log('progress-ok')\"" },
      {
        cwd,
        onProgress: (item) => progress.push(item),
      },
    );

    expect(result.output).toContain("progress-ok");
    expect(progress.some((item) => item.status === "running")).toBe(true);
    expect(progress.at(-1)?.status).toBe("completed");
    expect(progress.some((item) => item.output?.includes("progress-ok"))).toBe(true);
  });

  it("runs shell commands in background and reads output", async () => {
    const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('background-ok'), 50)\"", runInBackground: true }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, block: true, timeoutMs: 1000 }, { cwd });

    expect(taskId).toBeTruthy();
    expect(output.output).toContain("background-ok");
  });

  it("captures background output exactly once (no stream/result duplication)", async () => {
    const started = await runTool("run_shell", { command: "node -e \"process.stdout.write('UNIQ_MARK_42')\"", runInBackground: true }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, block: true, timeoutMs: 2000 }, { cwd });

    // Count inside <stdout> only — the marker also appears in the echoed
    // <command>, which is not output duplication.
    const stdout = output.output?.match(/<stdout>([\s\S]*?)<\/stdout>/)?.[1] ?? "";
    const matches = stdout.match(/UNIQ_MARK_42/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("moves slow foreground shell commands to background after a threshold", async () => {
    const previous = process.env.REINA_SHELL_AUTO_BACKGROUND_AFTER_MS;
    process.env.REINA_SHELL_AUTO_BACKGROUND_AFTER_MS = "100";
    try {
      const before = Date.now();
      const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('timed-background-ok'), 300)\"" }, { cwd });
      const elapsed = Date.now() - before;
      const task = JSON.parse(started.output ?? "{}");
      const output = await runTool("task_output", { taskId: task.taskId, block: true, timeoutMs: 1000 }, { cwd });

      expect(elapsed).toBeLessThan(500);
      expect(task.background).toBe("timed");
      expect(task.reason).toBe("foreground-timeout");
      expect(output.output).toContain("timed-background-ok");
    } finally {
      if (previous === undefined) delete process.env.REINA_SHELL_AUTO_BACKGROUND_AFTER_MS;
      else process.env.REINA_SHELL_AUTO_BACKGROUND_AFTER_MS = previous;
    }
  });

  it("accepts string booleans for shell background mode", async () => {
    const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('background-ok'), 50)\"", runInBackground: "true" }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, block: true, timeoutMs: 1000 }, { cwd });

    expect(taskId).toBeTruthy();
    expect(output.output).toContain("background-ok");
  });

  it("accepts string booleans for blocking task output reads", async () => {
    const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('background-ok'), 50)\"", runInBackground: true }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, block: "true", timeoutMs: 1000 }, { cwd });

    expect(taskId).toBeTruthy();
    expect(output.output).toContain("background-ok");
  });

  it("accepts string timeoutMs for blocking task output reads", async () => {
    const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('background-ok'), 50)\"", runInBackground: true }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, block: true, timeoutMs: "1000" }, { cwd });

    expect(taskId).toBeTruthy();
    expect(output.output).toContain("background-ok");
  });

  it("reads background task output without blocking by default", async () => {
    const started = await runTool("run_shell", { command: "node -e \"setTimeout(() => console.log('later'), 300)\"", runInBackground: true }, { cwd });
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const output = await runTool("task_output", { taskId, timeoutMs: 1000 }, { cwd });
    await runTool("kill_shell", { taskId }, { cwd });

    // A blocking read would observe the command's completion. Do not include
    // platform-dependent process-tree teardown time in this assertion.
    expect(output.output).toContain("<status>running</status>");
  });

  it("honors an explicit blocking wait for auto-background task output", async () => {
    const taskId = startBackgroundShell({
      command: "node -e \"setTimeout(() => {}, 5000)\"",
      cwd,
      workdir: cwd,
      background: "auto",
    });
    const output = await runTool("task_output", { taskId, block: true, timeoutMs: 30 }, { cwd });
    await runTool("kill_shell", { taskId }, { cwd });

    expect(output.output).toContain("<wake_reason>timeout</wake_reason>");
    expect(output.output).toContain("<status>running</status>");
  });

  it("detects commands that should not block the TUI", () => {
    expect(shouldAutoBackgroundCommand("calc")).toBe(true);
    expect(shouldAutoBackgroundCommand("start calc")).toBe(true);
    expect(shouldAutoBackgroundCommand("cmd /c calc")).toBe(true);
    expect(shouldAutoBackgroundCommand('powershell -Command "Start-Process calc"')).toBe(true);
    expect(shouldAutoBackgroundCommand("npm run dev")).toBe(true);
    expect(shouldAutoBackgroundCommand("python -m http.server 8000")).toBe(true);
    expect(shouldAutoBackgroundCommand("uvicorn app:app --reload")).toBe(true);
    expect(shouldAutoBackgroundCommand("docker compose up")).toBe(true);
    expect(shouldAutoBackgroundCommand("tail -f app.log")).toBe(true);
    expect(shouldAutoBackgroundCommand("echo calc")).toBe(false);
    expect(shouldAutoBackgroundCommand("echo hello")).toBe(false);
  });

  it("saves full shell output when truncated", async () => {
    const result = await runTool("run_shell", { command: "node -e \"console.log('x'.repeat(70000))\"" }, { cwd });
    const match = result.output?.match(/full output saved to ([^\]]+)/);

    expect(result.output).not.toContain("<exit_code>");
    expect(match?.[1]).toBeTruthy();
    expect(await readFile(path.join(cwd, match![1]!), "utf8")).toContain("x".repeat(100));
  });

  it.each([false, true])("preserves shell failure headers and full output after tail truncation (timeout=%s)", async (timedOut) => {
    const oldCompress = process.env.REINA_LOG_COMPRESS;
    process.env.REINA_LOG_COMPRESS = "0";
    try {
      const body = `first-line\n${"x".repeat(70000)}\nlast-line`;
      const script = path.join(cwd, "long-failure.cjs");
      await writeFile(script, `process.stdout.write(${JSON.stringify(body)}); ${timedOut ? "setTimeout(() => {}, 4000);" : "process.exitCode = 7;"}`);
      const result = await runTool("run_shell", {
        command: "node long-failure.cjs",
        shell: process.platform === "win32" ? "cmd" : "sh",
        ...(timedOut ? { timeoutMs: 1000 } : {}),
      }, { cwd });
      const output = result.output ?? "";
      expect(result.error).toBeUndefined();
      expect(output).toMatch(/^<exit_code>[^<]+<\/exit_code>\n/);
      expect(output.match(/<exit_code>/g)).toHaveLength(1);
      expect(output.match(/<hint>/g)).toHaveLength(1);
      expect(output).toContain("last-line");
      expect(output).not.toContain("first-line");
      if (timedOut) expect(output).toContain("<timed_out>1000</timed_out>");
      else expect(output).toContain("<exit_code>7</exit_code>");
      const match = output.match(/full output saved to ([^\]]+)/);
      expect(match?.[1]).toBeTruthy();
      const saved = await readFile(path.join(cwd, match![1]!), "utf8");
      expect(saved).toMatch(/^<exit_code>/);
      expect(saved.match(/<exit_code>/g)).toHaveLength(1);
      expect(saved).toContain(body);
      if (timedOut) expect(saved).toContain("<timed_out>1000</timed_out>");
    } finally {
      if (oldCompress === undefined) delete process.env.REINA_LOG_COMPRESS;
      else process.env.REINA_LOG_COMPRESS = oldCompress;
    }
  });

  it("saves full skill body when truncated so the dropped tail stays recoverable", async () => {
    const body = `# Big Skill\n${"y".repeat(70000)}\n## tail-marker`;
    await mkdir(path.join(cwd, ".claude", "skills", "big-skill"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "skills", "big-skill", "SKILL.md"), body, "utf8");

    const result = await runTool("read_skill", { name: "big-skill" }, { cwd });
    // The in-context copy is truncated, but it points at the offloaded file...
    const match = result.output?.match(/full output saved to ([^\]]+)/);
    expect(match?.[1]).toBeTruthy();
    expect(result.output).not.toContain("tail-marker");
    // ...and that file holds the verbatim full body, including the dropped tail.
    expect(await readFile(path.join(cwd, match![1]!), "utf8")).toBe(body);
  });

  it("monitor blocks until a regex matches a background task's output", async () => {
    const started = await runTool(
      "run_shell",
      {
        command:
          "node -e \"let n=0;const t=setInterval(()=>{console.log('tick '+(++n));if(n===4){console.log('Server ready on 4321');clearInterval(t);setTimeout(()=>{},500);}},40)\"",
        runInBackground: true,
      },
      { cwd },
    );
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    expect(taskId).toBeTruthy();
    const before = Date.now();
    const output = await runTool("monitor", { taskId, pattern: "Server ready on (\\d+)", timeoutMs: 5000 }, { cwd });
    await runTool("kill_shell", { taskId }, { cwd });

    expect(Date.now() - before).toBeLessThan(5000);
    expect(output.output).toContain("<reason>matched</reason>");
    expect(output.output).toContain("Server ready on 4321");
    expect(output.output).toContain('["4321"]');
  });

  it("monitor returns timeout reason when pattern is not seen", async () => {
    const started = await runTool(
      "run_shell",
      {
        command: "node -e \"console.log('only-this-line');setTimeout(()=>{},500)\"",
        runInBackground: true,
      },
      { cwd },
    );
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    const before = Date.now();
    const output = await runTool("monitor", { taskId, pattern: "never-matches-this", timeoutMs: 150 }, { cwd });
    const elapsedMs = Date.now() - before;
    await runTool("kill_shell", { taskId }, { cwd });

    expect(elapsedMs).toBeLessThan(1500);
    expect(output.output).toMatch(/<reason>(timeout|exited)<\/reason>/);
  });

  it("monitor matches output that was buffered before the call", async () => {
    const started = await runTool(
      "run_shell",
      {
        command: "node -e \"console.log('already-here')\"",
        runInBackground: true,
      },
      { cwd },
    );
    const taskId = JSON.parse(started.output ?? "{}").taskId;
    // Wait for the node process to fully exit and stdout to be drained into
    // the task's buffer — otherwise scanBufferedForPattern can race with the
    // pipe and miss the match.
    await runTool("task_output", { taskId, block: true, timeoutMs: 2000 }, { cwd });
    const output = await runTool("monitor", { taskId, pattern: "already-here" }, { cwd });

    expect(output.output).toContain("<reason>matched</reason>");
    expect(output.output).toContain("already-here");
  });

  it("notify forwards title/body to the host bridge and reports delivery", async () => {
    const calls: Array<{ kind: string; params: unknown }> = [];
    const hostBridge = async (kind: string, params: unknown): Promise<unknown> => {
      calls.push({ kind, params });
      return { delivered: true };
    };
    const result = await runTool(
      "notify",
      { title: "Build done", body: "All tests passing" },
      { cwd, hostBridge },
    );
    expect(result.output).toContain("<delivered>true</delivered>");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("notify");
    expect((calls[0]!.params as { title: string }).title).toBe("Build done");
  });

  it("notify reports a clean error when the host bridge is missing", async () => {
    const result = await runTool("notify", { title: "Hi", body: "There" }, { cwd });
    expect(result.error).toContain("no host bridge");
  });

  it("notify surfaces non-delivery from the host without throwing", async () => {
    const hostBridge = async (): Promise<unknown> => ({ delivered: false, reason: "platform not supported" });
    const result = await runTool("notify", { title: "Hi", body: "There" }, { cwd, hostBridge });
    expect(result.output).toContain("<delivered>false</delivered>");
    expect(result.output).toContain("platform not supported");
  });

  it("schedule_wakeup passes session + prompt + reason to the host bridge", async () => {
    const calls: Array<{ kind: string; params: unknown }> = [];
    const hostBridge = async (kind: string, params: unknown): Promise<unknown> => {
      calls.push({ kind, params });
      return { wakeupId: "wake-abc123", firesAt: new Date(Date.now() + 60_000).toISOString() };
    };
    const result = await runTool(
      "schedule_wakeup",
      { delaySeconds: 60, prompt: "check the build", reason: "ci is still running" },
      { cwd, hostBridge, sessionId: "ses-test" },
    );
    expect(result.output).toContain("<wakeup_id>wake-abc123</wakeup_id>");
    expect(result.output).toContain("<delay_seconds>60</delay_seconds>");
    expect(calls).toHaveLength(1);
    const p = calls[0]!.params as { sessionId: string; delaySeconds: number; prompt: string; reason: string };
    expect(p.sessionId).toBe("ses-test");
    expect(p.delaySeconds).toBe(60);
    expect(p.reason).toBe("ci is still running");
  });

  it("schedule_wakeup rejects out-of-range delays at the schema layer", async () => {
    const hostBridge = async (): Promise<unknown> => ({ wakeupId: "x", firesAt: "" });
    const tooLow = await runTool(
      "schedule_wakeup",
      { delaySeconds: 0, prompt: "x", reason: "y" },
      { cwd, hostBridge, sessionId: "s" },
    );
    expect(tooLow.error).toContain("input_validation");
    const tooHigh = await runTool(
      "schedule_wakeup",
      { delaySeconds: 99999, prompt: "x", reason: "y" },
      { cwd, hostBridge, sessionId: "s" },
    );
    expect(tooHigh.error).toContain("input_validation");
  });

  it("read_file miss returns a non-error response with suggestions + parent listing + recovery guidance", async () => {
    await mkdir(path.join(cwd, "packages", "core"), { recursive: true });
    await mkdir(path.join(cwd, "packages", "tools"), { recursive: true });
    await writeFile(path.join(cwd, "packages", "core", "engine.ts"), "// engine", "utf8");

    const result = await runTool("read_file", { path: "packages/reina-core" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("does not exist");
    expect(result.output).toContain("<suggestions>");
    expect(result.output).toContain("core");
    // The parent listing should also be present so the model has full
    // visibility without making a second tool call.
    expect(result.output).toContain("tools/");
    // Recovery guidance should be visible.
    expect(result.output).toMatch(/<next_step>/);
  });

  it("read_file miss walks up to the nearest existing ancestor when the parent dir is also missing", async () => {
    const result = await runTool("read_file", { path: "src/missing/deeply/nested.ts" }, { cwd });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("does not exist");
    expect(result.output).toContain("<nearest_ancestor>");
  });

  it("returns a section outline for large markdown files, then reads a section with offset", async () => {
    // ~1265 lines: over the 1000-line outline threshold but under the 2000-line
    // read default, so this exercises the lowered threshold specifically.
    const parts: string[] = ["# Big Doc", "", "Intro paragraph about the doc.", ""];
    for (let s = 0; s < 5; s++) {
      parts.push(`## Section ${s}`, "");
      for (let l = 0; l < 250; l++) parts.push(`line ${s}-${l}`);
      parts.push("");
    }
    expect(parts.length).toBeGreaterThan(1000);
    expect(parts.length).toBeLessThan(2000);
    await writeFile(path.join(cwd, "big.md"), parts.join("\n"), "utf8");

    const outline = await runTool("read_file", { path: "big.md" }, { cwd });
    expect(outline.error).toBeUndefined();
    expect(outline.output).toContain("<outline>");
    expect(outline.output).toContain("# Big Doc");
    expect(outline.output).toContain("## Section 0");
    expect(outline.output).toMatch(/\(lines \d+-\d+\)/);

    // An explicit offset bypasses outline mode and reads the actual section.
    const section = await runTool("read_file", { path: "big.md", offset: 1, limit: 1 }, { cwd });
    expect(section.output).not.toContain("<outline>");
    expect(section.output).toContain("Showing lines 1-1 of");
    expect(section.output).toContain("1: # Big Doc");
  });

  it("does not outline small markdown files or fenced-code headings", async () => {
    // Small file → read whole, never outlined.
    const small = await runTool("read_file", { path: "README.md" }, { cwd });
    expect(small.output).toContain("hello reina");
    expect(small.output).not.toContain("<outline>");

    // Large file whose only "#" lines live inside a code fence has no real
    // structure → falls back to a normal (head-truncated) read.
    const parts: string[] = ["```bash"];
    for (let l = 0; l < 2100; l++) parts.push(`# not a heading ${l}`);
    parts.push("```");
    await writeFile(path.join(cwd, "fenced.md"), parts.join("\n"), "utf8");

    const fenced = await runTool("read_file", { path: "fenced.md" }, { cwd });
    expect(fenced.output).not.toContain("<outline>");
  });

  it("reads workspace skills by name", async () => {
    await mkdir(path.join(cwd, ".claude", "skills", "reviewer"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "skills", "reviewer", "SKILL.md"), "review instructions", "utf8");

    const result = await runTool("read_skill", { name: "reviewer" }, { cwd });
    expect(result.output).toContain("review instructions");
  });

  it("lists workspace skills from Claude Code's skills directory", async () => {
    await mkdir(path.join(cwd, ".claude", "skills", "reviewer"), { recursive: true });
    await writeFile(path.join(cwd, ".claude", "skills", "reviewer", "SKILL.md"), "review instructions", "utf8");

    const result = await runTool("list_skills", {}, { cwd });
    expect(result.output).toContain("reviewer");
  });

  it("list_skills hides disable-model-invocation skills and includes built-ins", async () => {
    await mkdir(path.join(cwd, ".claude", "skills", "secret-skill"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "skills", "secret-skill", "SKILL.md"),
      "---\nname: secret-skill\ndescription: user-only\ndisable-model-invocation: true\n---\nBody.",
      "utf8",
    );

    const result = await runTool("list_skills", {}, { cwd });
    // User-triggered-only skills stay invisible to the model — same rule as
    // the system-prompt roster.
    expect(result.output).not.toContain("secret-skill");
    // Built-ins are readable via read_skill, so they must be discoverable too.
    expect(result.output).toContain("subagent-delegation");
  });

  it("resolves skills by frontmatter name when it differs from the directory", async () => {
    await mkdir(path.join(cwd, ".claude", "skills", "dir-name"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "skills", "dir-name", "SKILL.md"),
      "---\nname: pretty-name\ndescription: mismatch demo\n---\nActual body.",
      "utf8",
    );

    // list_skills advertises the frontmatter name (the roster's name space)…
    const listed = await runTool("list_skills", {}, { cwd });
    expect(listed.output).toContain("pretty-name");
    expect(listed.output).not.toContain("dir-name");
    // …and read_skill resolves that same name back to the file.
    const byFrontmatterName = await runTool("read_skill", { name: "pretty-name" }, { cwd });
    expect(byFrontmatterName.output).toContain("Actual body.");
    // Directory-name lookup remains available as a compatibility alias.
    const byDirName = await runTool("read_skill", { name: "dir-name" }, { cwd });
    expect(byDirName.output).toContain("Actual body.");
  });
});

function schemaKeys(tool: (typeof publicToolDescriptors)[number]): string[] {
  const shape = tool.inputSchema._def.typeName === "ZodObject" ? tool.inputSchema._def.shape() : {};
  return Object.keys(shape);
}
