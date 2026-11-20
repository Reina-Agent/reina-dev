import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWritableWorkspacePath,
  resolveWorkspacePath,
  sanitizeShellOutput,
  truncateHead,
  truncateTail,
  truncateText,
  truncateTextTail,
} from "./utils.js";

describe("assertWritableWorkspacePath", () => {
  const cwd = path.resolve("/workspace/project");

  it("allows normal workspace paths", () => {
    expect(assertWritableWorkspacePath(cwd, "src/index.ts")).toBe(path.join(cwd, "src", "index.ts"));
    expect(assertWritableWorkspacePath(cwd, "tmp/scratch.md")).toBe(path.join(cwd, "tmp", "scratch.md"));
  });

  it("rejects writes anywhere under .reina (engine-owned state)", () => {
    expect(() => assertWritableWorkspacePath(cwd, ".reina/scratch/repro.md")).toThrow(/\.reina/);
    expect(() => assertWritableWorkspacePath(cwd, ".reina/notes/n_001.md")).toThrow(/note tools/);
    expect(() => assertWritableWorkspacePath(cwd, ".reina/sessions/ses_x.jsonl")).toThrow(/\.reina/);
    expect(() => assertWritableWorkspacePath(cwd, ".reina/conversation_history/ses_x.md")).toThrow(/\.reina/);
    expect(() => assertWritableWorkspacePath(cwd, ".reina/anything.txt")).toThrow(/\.reina/);
  });

  it("still allows the user-facing config files directly under .reina", () => {
    expect(assertWritableWorkspacePath(cwd, ".reina/mcp.json")).toBe(path.join(cwd, ".reina", "mcp.json"));
    expect(assertWritableWorkspacePath(cwd, ".reina/models.json")).toBe(path.join(cwd, ".reina", "models.json"));
    expect(assertWritableWorkspacePath(cwd, ".reina/config.json")).toBe(path.join(cwd, ".reina", "config.json"));
    // ...but not files with those names nested deeper.
    expect(() => assertWritableWorkspacePath(cwd, ".reina/sub/mcp.json")).toThrow(/\.reina/);
  });

  it("does not block a sibling directory that merely starts with .reina", () => {
    expect(assertWritableWorkspacePath(cwd, ".reina-backup/file.txt")).toBe(path.join(cwd, ".reina-backup", "file.txt"));
  });

  it("keeps the workspace-escape check from resolveWorkspacePath", () => {
    expect(() => assertWritableWorkspacePath(cwd, "../outside.txt")).toThrow(/escapes workspace/);
  });
});

describe("truncateHead", () => {
  it("returns unchanged content when both limits are satisfied", () => {
    const r = truncateHead("a\nb\nc", 1024, 100);
    expect(r.truncated).toBe(false);
    expect(r.truncatedBy).toBeNull();
    expect(r.content).toBe("a\nb\nc");
    expect(r.outputLines).toBe(3);
  });

  it("drops trailing lines when the line limit fires first", () => {
    const lines = ["L1", "L2", "L3", "L4", "L5"];
    const r = truncateHead(lines.join("\n"), 1024, 2);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.content).toBe("L1\nL2");
    expect(r.outputLines).toBe(2);
    expect(r.totalLines).toBe(5);
  });

  it("drops trailing lines when the byte limit fires first", () => {
    // Each line is ~50 bytes; budget of 60 should keep one line only.
    const big = "x".repeat(50);
    const r = truncateHead(`${big}\n${big}\n${big}`, 60, 1000);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.outputLines).toBe(1);
    expect(r.content).toBe(big);
  });

  it("never returns a partial line — an oversized first line yields empty output", () => {
    const r = truncateHead("x".repeat(200), 50, 1000);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.content).toBe("");
    expect(r.outputLines).toBe(0);
  });
});

describe("truncateTail", () => {
  it("returns unchanged content when fits", () => {
    const r = truncateTail("a\nb\nc", 1024, 100);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("a\nb\nc");
  });

  it("drops leading lines when the line limit fires", () => {
    const r = truncateTail("L1\nL2\nL3\nL4\nL5", 1024, 2);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.content).toBe("L4\nL5");
    expect(r.outputLines).toBe(2);
  });

  it("drops leading lines when the byte limit fires", () => {
    const big = "x".repeat(50);
    const r = truncateTail(`${big}\n${big}\n${big}`, 60, 1000);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.outputLines).toBe(1);
    expect(r.content).toBe(big);
  });

  it("UTF-8 safe: slicing a CJK-heavy oversized line never produces U+FFFD", () => {
    // 你好 = 6 bytes in UTF-8 (3 each). 50 repeats = 300 bytes on one line.
    const line = "你好".repeat(50);
    const r = truncateTail(line, 40, 1000);
    expect(r.truncated).toBe(true);
    expect(r.firstLinePartial).toBe(true);
    // No replacement characters introduced by mid-codepoint slicing.
    expect(r.content.includes("�")).toBe(false);
    // Output bytes must not exceed the requested budget.
    expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(40);
  });

  it("preserves whole tail lines ahead of a partial first-line slice", () => {
    // Two short tail lines + one massive head line, budget keeps the tail.
    const head = "x".repeat(500);
    const r = truncateTail(`${head}\nend1\nend2`, 50, 1000);
    expect(r.outputLines).toBe(2);
    expect(r.content).toBe("end1\nend2");
    expect(r.firstLinePartial).toBe(false);
  });
});

describe("truncateText (head) / truncateTextTail (tail) markers", () => {
  it("truncateText puts the marker at the bottom and reports dropped lines", () => {
    const out = truncateText("L1\nL2\nL3\nL4", 1024, 2);
    expect(out.startsWith("L1\nL2")).toBe(true);
    expect(out).toMatch(/\[truncated 2 lines from tail\]$/);
  });

  it("truncateTextTail puts the marker at the top", () => {
    const out = truncateTextTail("L1\nL2\nL3\nL4", 1024, 2);
    expect(out.endsWith("L3\nL4")).toBe(true);
    expect(out.split("\n")[0]).toMatch(/\[truncated 2 lines from head\]/);
  });

  it("reports dropped BYTES when the byte limit fired", () => {
    const big = "x".repeat(200);
    const out = truncateText(`${big}\n${big}`, 50, 1000);
    expect(out).toMatch(/\[truncated \d+ bytes from tail\]$/);
  });

  it("returns content untouched when nothing was dropped", () => {
    const input = "small";
    expect(truncateText(input)).toBe(input);
    expect(truncateTextTail(input)).toBe(input);
  });
});

describe("resolveWorkspacePath — symlink/junction escape guard", () => {
  // A symlink/junction INSIDE the workspace pointing OUTSIDE must not be
  // reachable through the guard — the string-level resolve alone let
  // `write_file("link/evil.txt")` land outside the workspace.
  //
  // Windows privilege note: directory symlinks need SeCreateSymbolicLinkPrivilege
  // (admin / developer mode); junctions don't. Try symlink first, then junction
  // (same fallback as mcp-client.test.ts); skip with an explicit reason when
  // the environment allows neither. (The `type` arg is ignored on POSIX.)
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "reina-ws-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "reina-outside-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /** Link `workspace/link` → `outside`. Returns null when neither link kind
   * can be created in this environment. */
  async function makeEscapeLink(): Promise<"symlink" | "junction" | null> {
    const link = path.join(workspace, "link");
    try {
      await symlink(outside, link, "dir");
      return "symlink";
    } catch {
      try {
        await symlink(outside, link, "junction");
        return "junction";
      } catch {
        return null;
      }
    }
  }

  it("rejects a write through a link that points outside the workspace", async (ctx) => {
    if (!(await makeEscapeLink())) ctx.skip(); // no symlink/junction privilege in this environment
    expect(() => assertWritableWorkspacePath(workspace, "link/evil.txt")).toThrow(/escapes workspace/);
  });

  it("rejects a write of a NOT-yet-existing nested path through the link (ancestor realpath walk)", async (ctx) => {
    if (!(await makeEscapeLink())) ctx.skip(); // no symlink/junction privilege in this environment
    expect(() => assertWritableWorkspacePath(workspace, "link/sub/dir/evil.txt")).toThrow(/escapes workspace/);
  });

  it("rejects reads of an existing file through the link too", async (ctx) => {
    if (!(await makeEscapeLink())) ctx.skip(); // no symlink/junction privilege in this environment
    expect(() => resolveWorkspacePath(workspace, "link/existing.txt")).toThrow(/escapes workspace/);
  });

  it("still allows a link that points to another directory INSIDE the workspace", async () => {
    await mkdir(path.join(workspace, "real-inner"), { recursive: true });
    const link = path.join(workspace, "inner-link");
    try {
      await symlink(path.join(workspace, "real-inner"), link, "junction");
    } catch {
      await symlink(path.join(workspace, "real-inner"), link, "dir");
    }
    expect(assertWritableWorkspacePath(workspace, "inner-link/ok.txt")).toBe(
      path.join(workspace, "inner-link", "ok.txt"),
    );
  });

  it("still resolves ordinary not-yet-existing paths (no false positive from realpath normalisation)", () => {
    expect(assertWritableWorkspacePath(workspace, "newdir/newfile.txt")).toBe(
      path.join(workspace, "newdir", "newfile.txt"),
    );
  });
});

describe("sanitizeShellOutput", () => {
  // Build control bytes at runtime so the test source stays pure ASCII.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const NUL = String.fromCharCode(0x00);
  const TAB = String.fromCharCode(0x09);
  const LF = String.fromCharCode(0x0a);
  const CR = String.fromCharCode(0x0d);

  it("strips ANSI colour and cursor-control sequences", () => {
    expect(sanitizeShellOutput(`${ESC}[32mGREEN${ESC}[0m${ESC}[1Gx`)).toBe("GREENx");
  });

  it("drops stray control bytes but keeps tab, newline and carriage return", () => {
    const input = `a${TAB}b${LF}c${CR}d${NUL}${BEL}e`;
    expect(sanitizeShellOutput(input)).toBe(`a${TAB}b${LF}c${CR}de`);
  });

  it("leaves plain and multibyte text untouched", () => {
    expect(sanitizeShellOutput("hello world")).toBe("hello world");
    expect(sanitizeShellOutput("")).toBe("");
    expect(sanitizeShellOutput(`${ESC}[31m你好${ESC}[0m`)).toBe("你好");
  });
});
