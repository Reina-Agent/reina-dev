// Kimi (Moonshot) server-side web tools — the search/fetch services a Kimi
// subscription grants alongside its models. Execution is a host-bridge hop:
// the OAuth access token lives only in the desktop main process, which does
// the authorized POST (see apps/desktop/src/main/host-handlers.ts) and hands
// back plain data. Without a connected Kimi account the handlers return a
// clear "connect it in Settings" error.
//
// Both are `deferred`: they surface via search_tool when the model looks for
// web capability, instead of occupying prompt space in every session.

import { z } from "zod";
import type { ToolImplementation } from "../../types.js";

const searchSchema = z.object({
  query: z.string().min(1).max(500).describe("Web search query (natural language or keywords)."),
});

type BridgeSearchResult = {
  results?: Array<{ title?: string; url?: string; snippet?: string; siteName?: string; date?: string }>;
};

export const kimiWebSearchTool: ToolImplementation = {
  descriptor: {
    name: "kimi_web_search",
    description:
      "Search the live web via the Kimi (Moonshot) search service. Returns titles, URLs and snippets. Requires a connected Kimi subscription (Settings → 订阅账号). Prefer this over guessing at fresh facts — news, versions, docs, prices.",
    permission: "network",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Live web search via the Kimi subscription's server-side search service.",
    inputSchema: searchSchema,
    examples: [
      {
        description: "Look up something current",
        input: { query: "electron 38 breaking changes" },
      },
    ],
  },
  async execute(input, options) {
    const parsed = searchSchema.parse(input ?? {});
    if (!options.hostBridge) {
      throw new Error("kimi_web_search is unavailable in this environment (no host bridge).");
    }
    const data = (await options.hostBridge("kimi_web_search", { query: parsed.query })) as BridgeSearchResult;
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
      return `<kimi_web_search><query>${parsed.query}</query><results count="0"/><hint>No results. Try different keywords.</hint></kimi_web_search>`;
    }
    const rows = results.map((r, i) =>
      [
        `<result rank="${i + 1}">`,
        `<title>${r.title ?? ""}</title>`,
        `<url>${r.url ?? ""}</url>`,
        r.siteName ? `<site>${r.siteName}</site>` : "",
        r.date ? `<date>${r.date}</date>` : "",
        `<snippet>${r.snippet ?? ""}</snippet>`,
        `</result>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return [
      `<kimi_web_search>`,
      `<query>${parsed.query}</query>`,
      `<results count="${results.length}">`,
      ...rows,
      `</results>`,
      `<hint>Use kimi_web_fetch({url}) to read a promising page in full.</hint>`,
      `</kimi_web_search>`,
    ].join("\n");
  },
};

const fetchSchema = z.object({
  url: z.string().url().describe("Absolute http(s) URL to fetch and extract."),
});

export const kimiWebFetchTool: ToolImplementation = {
  descriptor: {
    name: "kimi_web_fetch",
    description:
      "Fetch a web page through the Kimi (Moonshot) fetch service and return its extracted text content. Requires a connected Kimi subscription (Settings → 订阅账号). Server-side extraction handles JS-rendered pages better than a raw local fetch.",
    permission: "network",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Fetch + extract a web page via the Kimi subscription's server-side fetch service.",
    inputSchema: fetchSchema,
    examples: [
      {
        description: "Read a page found via kimi_web_search",
        input: { url: "https://www.electronjs.org/blog/electron-38-0" },
      },
    ],
  },
  async execute(input, options) {
    const parsed = fetchSchema.parse(input ?? {});
    if (!options.hostBridge) {
      throw new Error("kimi_web_fetch is unavailable in this environment (no host bridge).");
    }
    const data = (await options.hostBridge("kimi_web_fetch", { url: parsed.url })) as { content?: string };
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content.trim()) {
      return `<kimi_web_fetch><url>${parsed.url}</url><content/></kimi_web_fetch>`;
    }
    return `<kimi_web_fetch><url>${parsed.url}</url>\n${content}\n</kimi_web_fetch>`;
  },
};
