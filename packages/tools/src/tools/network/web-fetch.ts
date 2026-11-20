import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { truncateToolOutput } from "../../utils.js";
import { description } from "../../prompts/web-fetch.js";

const schema = z.object({
  url: z
    .string()
    .url()
    .describe("Absolute http:// or https:// URL. Follows redirects, returns the response body as text (HTML / JSON / text/plain). Not for binary content — PDFs and images must be attached by the user. Good for public docs, raw GitHub URLs, REST GETs without auth."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .describe("Request timeout in ms (1000-60000). Defaults to 15000."),
});

/** Hard cap on response BODY bytes web_fetch reads into memory. Plain
 * `response.text()` buffers the ENTIRE body before truncateToolOutput ever
 * runs, so a multi-hundred-MB page (or a hostile endless stream) would OOM
 * the process. Read the body as a stream and stop at the cap; the truncation
 * pipeline below then reports the cut through the usual marker, so the model
 * still learns the content was truncated. Sized well above
 * defaultMaxOutputBytes (50KB) — the memory guard, not the context budget. */
const maxWebFetchBodyBytes = 10 * 1024 * 1024;

/** Read `response` as UTF-8 text, stopping once `maxBytes` have been
 * consumed. Cancelling the reader propagates to the fetch socket so the
 * connection is torn down instead of draining to the end. A body-less
 * response (or an environment without streams) falls back to text(). */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // stream:true keeps a multi-byte character split across two chunks intact.
      chunks.push(decoder.decode(value, { stream: true }));
      if (received >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export const webFetchTool: ToolImplementation = {
  descriptor: {
    name: "web_fetch",
    description,
    permission: "network",
    requiresApproval: true,
    exposure: "deferred",
    catalogSummary: "Fetch a URL over HTTP/HTTPS (read-only). Use for docs / raw files / public JSON APIs.",
    inputSchema: schema,
    examples: [
      {
        description: "Read a documentation page",
        input: { url: "https://docs.anthropic.com/claude/docs/tool-use" },
      },
      {
        description: "Fetch a raw file from GitHub",
        input: { url: "https://raw.githubusercontent.com/vercel/ai/main/packages/ai/package.json" },
      },
      {
        description: "Hit a public JSON API with a tight timeout",
        input: { url: "https://api.github.com/repos/anthropics/anthropic-sdk-typescript", timeoutMs: 5000 },
      },
    ],
  },
  async preview(input) {
    const parsed = schema.parse(input);
    return `Fetch URL:\n${parsed.url}`;
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parsed.timeoutMs ?? 15000);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(parsed.url, { signal: controller.signal });
      const contentType = response.headers.get("content-type") ?? "";
      const text = await readBodyWithLimit(response, maxWebFetchBodyBytes);
      return JSON.stringify(
        {
          url: parsed.url,
          status: response.status,
          contentType,
          body: (await truncateToolOutput(options.cwd, text)).content,
        },
        null,
        2,
      );
    } finally {
      clearTimeout(timeout);
      // Remove the abort listener from the long-lived per-turn signal: { once:true }
      // only auto-detaches it when abort actually fires, so a normal completion
      // would otherwise leak one listener per web_fetch call.
      options.signal?.removeEventListener("abort", onAbort);
    }
  },
};
