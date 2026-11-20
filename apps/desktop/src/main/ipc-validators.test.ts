import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CustomAgent, isAllowedExternalUrl, parseCustomAgents, quotePowerShellSingleQuoted, safeRelativePath } from "./ipc-validators.js";

// Resolve through `path` so the fixture is a valid absolute path on whatever
// platform the test runs (win32 locally + in CI, posix otherwise).
const CWD = path.resolve(path.sep === "\\" ? "C:\\workspace\\project" : "/workspace/project");

describe("safeRelativePath", () => {
  it("returns the relative path for a file inside the workspace", () => {
    expect(safeRelativePath(CWD, "src/index.ts")).toBe(path.join("src", "index.ts"));
  });

  it("returns the bare filename for a top-level file", () => {
    expect(safeRelativePath(CWD, "README.md")).toBe("README.md");
  });

  it("allows an absolute path that stays inside the workspace", () => {
    const inside = path.join(CWD, "src", "a.ts");
    expect(safeRelativePath(CWD, inside)).toBe(path.join("src", "a.ts"));
  });

  it("rejects parent-directory traversal", () => {
    expect(() => safeRelativePath(CWD, "../secret.txt")).toThrow(/Invalid workspace file path/);
    expect(() => safeRelativePath(CWD, "../../etc/passwd")).toThrow(/Invalid workspace file path/);
    expect(() => safeRelativePath(CWD, "src/../../escape.txt")).toThrow(/Invalid workspace file path/);
  });

  it("rejects the empty path and the workspace root itself", () => {
    expect(() => safeRelativePath(CWD, "")).toThrow(/Invalid workspace file path/);
    expect(() => safeRelativePath(CWD, ".")).toThrow(/Invalid workspace file path/);
  });

  it("rejects an absolute path that escapes the workspace", () => {
    const outside = path.resolve(path.sep === "\\" ? "C:\\elsewhere\\file.txt" : "/elsewhere/file.txt");
    expect(() => safeRelativePath(CWD, outside)).toThrow(/Invalid workspace file path/);
  });

  it("rejects a cross-drive absolute path on Windows", () => {
    if (path.sep !== "\\") return; // win32-only: path.relative across drives is absolute
    expect(() => safeRelativePath("C:\\workspace", "D:\\loot.txt")).toThrow(/Invalid workspace file path/);
  });
});

describe("parseCustomAgents", () => {
  const valid = { name: "reviewer", description: "Reviews code", mode: "subagent", prompt: "You review." };

  it("returns [] for null, empty, malformed, or non-array input", () => {
    expect(parseCustomAgents(null)).toEqual([]);
    expect(parseCustomAgents("")).toEqual([]);
    expect(parseCustomAgents("{not json")).toEqual([]);
    expect(parseCustomAgents(JSON.stringify({ name: "x" }))).toEqual([]);
    expect(parseCustomAgents(JSON.stringify("a string"))).toEqual([]);
  });

  it("parses a valid agent and trims name/description", () => {
    const out = parseCustomAgents(JSON.stringify([{ ...valid, name: "  reviewer  ", description: "  Reviews code  " }]));
    expect(out).toEqual<CustomAgent[]>([{ name: "reviewer", description: "Reviews code", mode: "subagent", prompt: "You review." }]);
  });

  it("strips a leading UTF-8 BOM before parsing", () => {
    const out = parseCustomAgents(`﻿${JSON.stringify([valid])}`);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("reviewer");
  });

  it("drops entries whose name fails the allowlist", () => {
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: "1bad" }]))).toEqual([]); // starts with a digit
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: "bad name" }]))).toEqual([]); // space
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: "../etc" }]))).toEqual([]); // path chars
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: "" }]))).toEqual([]);
  });

  it("enforces the 64-char name length cap", () => {
    const ok = "a".repeat(64);
    const tooLong = "a".repeat(65);
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: ok }]))).toHaveLength(1);
    expect(parseCustomAgents(JSON.stringify([{ ...valid, name: tooLong }]))).toEqual([]);
  });

  it("defaults an invalid mode to 'subagent' and keeps valid modes", () => {
    expect(parseCustomAgents(JSON.stringify([{ ...valid, mode: "bogus" }]))[0].mode).toBe("subagent");
    expect(parseCustomAgents(JSON.stringify([{ ...valid, mode: "primary" }]))[0].mode).toBe("primary");
    expect(parseCustomAgents(JSON.stringify([{ ...valid, mode: "all" }]))[0].mode).toBe("all");
  });

  it("drops entries missing a description or prompt", () => {
    expect(parseCustomAgents(JSON.stringify([{ ...valid, description: "" }]))).toEqual([]);
    expect(parseCustomAgents(JSON.stringify([{ ...valid, prompt: "" }]))).toEqual([]);
  });

  it("only keeps a positive, finite, floored maxSteps", () => {
    expect(parseCustomAgents(JSON.stringify([{ ...valid, maxSteps: 12.9 }]))[0].maxSteps).toBe(12);
    expect(parseCustomAgents(JSON.stringify([{ ...valid, maxSteps: 0 }]))[0].maxSteps).toBeUndefined();
    expect(parseCustomAgents(JSON.stringify([{ ...valid, maxSteps: -3 }]))[0].maxSteps).toBeUndefined();
    expect(parseCustomAgents(JSON.stringify([{ ...valid, maxSteps: "5" }]))[0].maxSteps).toBeUndefined();
  });

  it("filters a mixed list, keeping only valid entries", () => {
    const out = parseCustomAgents(
      JSON.stringify([valid, { ...valid, name: "1bad" }, null, "string", { ...valid, name: "second" }]),
    );
    expect(out.map((a) => a.name)).toEqual(["reviewer", "second"]);
  });
});

describe("quotePowerShellSingleQuoted", () => {
  it("leaves a quote-free string unchanged", () => {
    expect(quotePowerShellSingleQuoted("C:\\Users\\me\\project")).toBe("C:\\Users\\me\\project");
  });

  it("doubles single quotes", () => {
    expect(quotePowerShellSingleQuoted("it's")).toBe("it''s");
    expect(quotePowerShellSingleQuoted("'a'b'")).toBe("''a''b''");
  });

  it("neutralizes a single-quote breakout injection attempt", () => {
    // The only escape vector for a PS single-quoted literal is the quote
    // itself; doubling it keeps the rest as inert literal text.
    expect(quotePowerShellSingleQuoted("'; Remove-Item -Recurse C:\\ #")).toBe("''; Remove-Item -Recurse C:\\ #");
  });
});

describe("isAllowedExternalUrl", () => {
  it("allows http, https, and mailto URLs", () => {
    expect(isAllowedExternalUrl("https://example.com/docs?q=1")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedExternalUrl("mailto:user@example.com")).toBe(true);
  });

  it("is case-insensitive on the scheme", () => {
    expect(isAllowedExternalUrl("HTTPS://example.com")).toBe(true);
  });

  it("rejects file:, custom-protocol, and script-execution schemes", () => {
    expect(isAllowedExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedExternalUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isAllowedExternalUrl("reina:open-settings")).toBe(false);
  });

  it("rejects malformed, empty, and non-string input", () => {
    expect(isAllowedExternalUrl("")).toBe(false);
    expect(isAllowedExternalUrl("   ")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
  });
});
