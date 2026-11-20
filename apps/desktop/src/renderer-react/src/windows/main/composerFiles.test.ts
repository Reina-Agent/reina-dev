import { describe, expect, it } from "vitest";
import { buildSelectedFileReminder, decodeSelectedTextFile } from "./composerFiles";

describe("Composer selected files", () => {
  it("decodes an extensionless UTF-8 code file", () => {
    const source = "FROM node:22\nCOPY . /app\n";
    expect(decodeSelectedTextFile(new TextEncoder().encode(source))).toBe(source);
  });

  it("rejects binary file data", () => {
    expect(decodeSelectedTextFile(new Uint8Array([0x50, 0x4b, 0x00, 0x04]))).toBeNull();
  });

  it("marks selected file contents as one-shot reference data", () => {
    const reminder = buildSelectedFileReminder({
      name: "Dockerfile",
      content: "FROM node:22",
      truncated: true,
    });

    expect(reminder).toContain('"name":"Dockerfile"');
    expect(reminder).toContain("FROM node:22");
    expect(reminder).toContain("[truncated]");
    expect(reminder).toContain("user-provided data");
  });
});
