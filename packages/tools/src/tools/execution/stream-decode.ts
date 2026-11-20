/**
 * Incremental UTF-8 decoder for a SINGLE byte stream.
 *
 * `String(buffer)` (or `buffer.toString()`) decodes each chunk in isolation, so
 * any multibyte character — a 3-byte CJK glyph, an emoji — straddling a chunk
 * boundary (8K/64K read boundaries hit this constantly with Chinese output) is
 * torn into `�`. A streaming `TextDecoder` buffers the trailing partial
 * sequence until the next chunk completes it.
 *
 * Use ONE instance per stream: stdout and stderr must NOT share a decoder, or
 * interleaved bytes corrupt each other's multibyte sequences.
 *
 * Compared to Claude Code's "redirect to a file, read it back as utf8 at the
 * end" approach, this is correct for REAL-TIME streaming too (live progress,
 * background-task buffers, monitor matching) — not only whole-output-at-end.
 */
export type StreamDecoder = {
  /** Decode a chunk, holding any trailing partial multibyte sequence. */
  push(chunk: Buffer | string): string;
  /** Flush any held partial bytes at end-of-stream (emits `�` if incomplete). */
  flush(): string;
};

export function createStreamDecoder(): StreamDecoder {
  // Non-fatal (the default): invalid bytes become U+FFFD instead of throwing —
  // the same lenient behavior as Node's readFile(.., "utf8"), but stream-correct.
  const decoder = new TextDecoder("utf-8");
  return {
    push(chunk: Buffer | string): string {
      if (typeof chunk === "string") return chunk;
      return decoder.decode(chunk, { stream: true });
    },
    flush(): string {
      return decoder.decode();
    },
  };
}
