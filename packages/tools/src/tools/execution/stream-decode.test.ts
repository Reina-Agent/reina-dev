import { describe, expect, it } from "vitest";
import { createStreamDecoder } from "./stream-decode.js";

describe("createStreamDecoder", () => {
  it("joins a 3-byte CJK character split across two chunks", () => {
    const d = createStreamDecoder();
    const bytes = Buffer.from("中"); // E4 B8 AD
    expect(d.push(bytes.subarray(0, 2))).toBe(""); // incomplete — held
    expect(d.push(bytes.subarray(2))).toBe("中"); // completed by the next chunk
  });

  it("joins a 4-byte emoji split across chunks", () => {
    const d = createStreamDecoder();
    const bytes = Buffer.from("😀"); // F0 9F 98 80
    expect(d.push(bytes.subarray(0, 3))).toBe("");
    expect(d.push(bytes.subarray(3))).toBe("😀");
  });

  it("decodes a full multibyte string in one chunk", () => {
    const d = createStreamDecoder();
    expect(d.push(Buffer.from("中文abc"))).toBe("中文abc");
  });

  it("passes through already-decoded strings unchanged", () => {
    const d = createStreamDecoder();
    expect(d.push("already text")).toBe("already text");
  });

  it("flush emits a replacement char for a dangling partial sequence", () => {
    const d = createStreamDecoder();
    expect(d.push(Buffer.from([0xe4, 0xb8]))).toBe(""); // 2 of 3 bytes
    expect(d.flush()).toBe("�");
  });

  it("keeps independent streams from corrupting each other", () => {
    const out = createStreamDecoder();
    const err = createStreamDecoder();
    const a = Buffer.from("文"); // E6 96 87
    // Interleave the two streams mid-character — each decoder holds its own.
    expect(out.push(a.subarray(0, 1))).toBe("");
    expect(err.push(Buffer.from("ERR"))).toBe("ERR");
    expect(out.push(a.subarray(1))).toBe("文");
  });
});
