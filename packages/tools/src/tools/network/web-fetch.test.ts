import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webFetchTool } from "./web-fetch.js";

/** Regression coverage for the web_fetch body-size guard. The old
 * `await response.text()` buffered the ENTIRE response before any truncation
 * ran, so a huge/endless body could OOM the process. The reader now stops at
 * maxWebFetchBodyBytes (10MB) and cancels the stream — these tests prove the
 * cut happens at the SOURCE (the stream stops being pulled), not just that
 * the output string looks truncated. */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-webfetch-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

/** A fetch Response whose body is a countable stream of 1MB chunks. */
function stubChunkedFetch(totalChunks: number): { pullCount: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let wasCancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(0x61); // "a" × 1MB
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls > totalChunks) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } })),
  );
  return { pullCount: () => pulls, cancelled: () => wasCancelled };
}

describe("web_fetch body byte cap", () => {
  it("stops reading at the cap and cancels an oversized stream instead of buffering it whole", async () => {
    const stream = stubChunkedFetch(20); // 20MB offered, cap is 10MB
    const result = await webFetchTool.execute({ url: "https://example.com/big" }, { cwd });
    const parsed = JSON.parse(result as string);

    expect(parsed.status).toBe(200);
    // The source stream was cancelled early — never drained to its 20MB end.
    expect(stream.cancelled()).toBe(true);
    expect(stream.pullCount()).toBeLessThanOrEqual(12);
    // What reaches the transcript is far below the offered 20MB (the normal
    // truncation pipeline caps model-visible output at 50KB).
    expect(Buffer.byteLength(parsed.body, "utf8")).toBeLessThan(1024 * 1024);
  });

  it("passes a small response through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello reina", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const result = await webFetchTool.execute({ url: "https://example.com/small" }, { cwd });
    const parsed = JSON.parse(result as string);
    expect(parsed.body).toBe("hello reina");
  });

  it("still rejects on timeout/abort while streaming (behaviour unchanged)", async () => {
    // A body that never yields a chunk: the abort must surface as an error,
    // exactly as response.text() did before. The mock wires the abort signal
    // to the stream the way undici does for a real fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            let ctrl!: ReadableStreamDefaultController<Uint8Array>;
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                ctrl = c;
              },
            });
            init?.signal?.addEventListener("abort", () => ctrl.error(new Error("aborted")));
            setTimeout(() => resolve(new Response(body, { status: 200 })), 5);
          }),
      ),
    );
    await expect(webFetchTool.execute({ url: "https://example.com/hang", timeoutMs: 1000 }, { cwd })).rejects.toThrow();
  }, 10_000);
});
