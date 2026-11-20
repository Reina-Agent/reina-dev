import type { ToolUseExample } from "@reina/protocol";
import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { description } from "../../prompts/search-tool.js";
import {
  formatParamLine,
  summarizeToolSchema,
  synthesizeExampleFromJsonSchema,
  type ParamInfo,
} from "../../schema-summary.js";
import { loadMcpRuntimeTools } from "../../mcp-runtime.js";

export type { ParamInfo } from "../../schema-summary.js";

/** A row in the deferred-tools catalog. Built by the registry from each
 * deferred tool's `name` + (`catalogSummary` or first-line of `description`)
 * + a structural summary of its top-level input parameters. `search_tool`
 * matches the user's query against name + summary (params don't affect
 * ranking — a query for "string" shouldn't surface every tool that takes a
 * string), then renders the params (and, for MCP entries, a synthesised
 * shape example) alongside each match so the model can dispatch directly by
 * name on its next turn. */
export type DeferredCatalogEntry = {
  name: string;
  summary: string;
  /** Top-level input parameters. `undefined` means the catalog provider
   * hasn't filled this in (older test fixtures); `[]` means the tool takes
   * no parameters. */
  params?: ParamInfo[];
  /** Optional canonical-invocation examples (Phase 3). Rendered inside the
   * `<tool>` block as `<examples>` so the model sees ready-to-use argument
   * shapes the moment a tool surfaces — addresses the "right tool, wrong
   * args" failure mode that the Anthropic article calls out. Omitted from
   * MCP entries today (MCP tool authors don't supply examples). */
  examples?: ToolUseExample[];
};

/** Lazy provider set by the registry at boot. Lives here (not in the
 * registry) so this file has zero imports from registry.ts — search_tool
 * still needs to live in the same registry, which imports this file. */
let provider: (() => DeferredCatalogEntry[]) | null = null;

export function setDeferredCatalogProvider(fn: () => DeferredCatalogEntry[]): void {
  provider = fn;
}

export function getDeferredCatalog(): DeferredCatalogEntry[] {
  return provider ? provider() : [];
}

// ─── Ranking ───────────────────────────────────────────────────────────────
//
// Hybrid scorer = TF-IDF cosine (semantic-ish, handles partial/multi-word
// queries and field weighting) blended with a keyword score (exact substring
// + token overlap, which subsumes the old fallback so recall never regresses).
// Self-contained, zero deps, provider-neutral — same shape Claude Code uses.
// CJK is handled with char uni/bi-grams because there is no whitespace to
// split on; a Chinese query/description tokenises into matchable grams.

/** Field weights — a hit in the tool *name* counts far more than the summary. */
const NAME_WEIGHT = 3;
const SUMMARY_WEIGHT = 1;
/** Hybrid blend, mirroring Claude Code's defaults (tfidf 0.6 / keyword 0.4). */
const TFIDF_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

// CJK ideographs + Japanese kana + Hangul + CJK compat. Anything matched here
// has no word boundaries, so we n-gram it instead of camel/snake splitting.
const CJK_CLASS = "\\u3400-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\uf900-\\ufaff";
const CJK_RE = new RegExp(`[${CJK_CLASS}]`);
// One pass: capture either a run of CJK chars or a run of ASCII alphanumerics.
// Everything else (`_`, `-`, `/`, spaces, brackets like `[MCP:server]`) is a
// separator and dropped.
const SEGMENT_RE = new RegExp(`[${CJK_CLASS}]+|[A-Za-z0-9]+`, "g");

/** Split an ASCII run on camelCase / CAPS boundaries: `taskOutput` ->
 * [task, output], `MCPTool` -> [mcp, tool]. */
function splitCamel(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

/** Light, uniform plural stem so `tasks`/`notes`/`goals` match `task`/`note`/
 * `goal`. Applied to both query and corpus, so linguistic correctness doesn't
 * matter — only that the same transform lands on both sides. */
function stem(token: string): string {
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Tokenise free text into match terms. ASCII -> lowercased camel/snake parts
 * (stemmed); CJK -> unigrams + bigrams. Exported for tests. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const segments = text.match(SEGMENT_RE) ?? [];
  for (const seg of segments) {
    if (CJK_RE.test(seg)) {
      const chars = [...seg];
      for (const ch of chars) out.push(ch);
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    for (const part of splitCamel(seg)) out.push(stem(part.toLowerCase()));
  }
  return out;
}

function addTerms(tf: Map<string, number>, tokens: string[], weight: number): void {
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
}

/** Sublinear TF scaling so a term repeated many times doesn't dominate. */
function tfScale(weight: number): number {
  return 1 + Math.log(weight);
}

type IndexedDoc = {
  entry: DeferredCatalogEntry;
  tf: Map<string, number>;
  hay: string;
  tokens: Set<string>;
};

/** Rank the catalog against `query`, best first. Returns at most `limit`
 * entries, dropping anything with no signal at all. Exported for tests. */
export function searchCatalog(
  catalog: ReadonlyArray<DeferredCatalogEntry>,
  query: string,
  limit: number,
): DeferredCatalogEntry[] {
  const trimmed = query.trim();
  if (catalog.length === 0 || trimmed === "") return [];

  const total = catalog.length;
  const df = new Map<string, number>();
  const docs: IndexedDoc[] = catalog.map((entry) => {
    const tf = new Map<string, number>();
    addTerms(tf, tokenize(entry.name), NAME_WEIGHT);
    addTerms(tf, tokenize(entry.summary), SUMMARY_WEIGHT);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return {
      entry,
      tf,
      hay: `${entry.name} ${entry.summary}`.toLowerCase(),
      tokens: new Set(tf.keys()),
    };
  });

  const idf = (term: string): number => Math.log(1 + total / (df.get(term) ?? total));
  const docNorms = docs.map((doc) => {
    let sum = 0;
    for (const [term, weight] of doc.tf) {
      const value = tfScale(weight) * idf(term);
      sum += value * value;
    }
    return Math.sqrt(sum) || 1;
  });

  // Query vector — skip terms absent from the corpus so an unknown word doesn't
  // deflate cosine; keyword overlap can't match them either.
  const queryTokens = tokenize(trimmed);
  const queryTf = new Map<string, number>();
  addTerms(queryTf, queryTokens, 1);
  const queryVec = new Map<string, number>();
  let queryNorm = 0;
  for (const [term, weight] of queryTf) {
    if (!df.has(term)) continue;
    const value = tfScale(weight) * idf(term);
    queryVec.set(term, value);
    queryNorm += value * value;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  const queryLower = trimmed.toLowerCase();
  const queryTokenSet = new Set(queryTokens);

  const scored = docs.map((doc, index) => {
    let dot = 0;
    for (const [term, queryValue] of queryVec) {
      const weight = doc.tf.get(term);
      if (weight === undefined) continue;
      dot += queryValue * tfScale(weight) * idf(term);
    }
    const cosine = dot / (queryNorm * docNorms[index]);

    let keyword = 0;
    if (doc.hay.includes(queryLower)) {
      keyword = 1; // exact substring — the old behaviour, still the strongest signal
    } else if (queryTokenSet.size > 0) {
      let hits = 0;
      for (const term of queryTokenSet) if (doc.tokens.has(term)) hits += 1;
      keyword = hits / queryTokenSet.size;
    }

    return { entry: doc.entry, score: TFIDF_WEIGHT * cosine + KEYWORD_WEIGHT * keyword };
  });

  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}

const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "English keyword or phrase describing the capability you need (the catalog is in English). Ranked with a hybrid TF-IDF + keyword matcher; also CJK-aware for non-English tool descriptions. Examples: 'notify', 'mcp', 'background shell wait'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max matches to return. Defaults to 5 (aligned with Anthropic's tool_search_tool default of 3-5)."),
});

export const searchToolTool: ToolImplementation = {
  descriptor: {
    name: "search_tool",
    description,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: schema,
    examples: [
      {
        description: "Find a single capability by keyword",
        input: { query: "notify" },
      },
      {
        description: "Discover an MCP tool by server-name fragment",
        input: { query: "github issue" },
      },
      {
        description: "Multi-word capability search with a tighter cap",
        input: { query: "background shell wait", limit: 5 },
      },
      {
        description: "Look up by exact tool name (also auto-unmasks for next-turn direct call)",
        input: { query: "schedule_wakeup" },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input);
    const limit = parsed.limit ?? 5;
    const catalog = await buildCombinedCatalog(options.cwd, options.allowedMcpServers);
    const matches = searchCatalog(catalog, parsed.query, limit);

    if (matches.length === 0) {
      return {
        output: `<search_tool><query>${parsed.query}</query><matches count="0"/><hint>No deferred tools matched. Try a broader capability word, an exact hidden tool name, or use your existing direct tools.</hint></search_tool>`,
      };
    }

    const body = [
      `<search_tool>`,
      `<query>${parsed.query}</query>`,
      `<matches count="${matches.length}">`,
      ...matches.flatMap((m) => renderMatch(m)),
      `</matches>`,
      `<hint>Call an allowed tool by name on your NEXT turn, e.g. \`${matches[0]!.name}({...})\`. Available definitions are added to the next request, subject to the active profile's permissions. MCP runtime tools (\`mcp__<server>__<tool>\`) work the same way.</hint>`,
      `</search_tool>`,
    ].join("\n");

    return {
      output: body,
      metadata: { unmaskTools: matches.map((m) => m.name) },
    };
  },
};

/** Compose the per-call catalog by appending the cwd-resolved MCP runtime
 * tools to the static native catalog. MCP tools are dynamic (depend on cwd
 * + mcp.json), so search_tool reloads them per call rather than relying on
 * a static registry snapshot — `loadMcpRuntimeTools` is cached per-cwd by
 * config key (see mcp-runtime.ts), so this stays cheap turn-to-turn.
 *
 * MCP server filtering is applied before schema details enter the searchable
 * catalog, so a profile-scoped server boundary is also a discovery boundary.
 * Undefined or empty allow-lists preserve the unrestricted legacy behavior. */
async function buildCombinedCatalog(
  cwd: string,
  allowedMcpServers: ReadonlyArray<string> | undefined,
): Promise<DeferredCatalogEntry[]> {
  const native = getDeferredCatalog();
  let mcp: DeferredCatalogEntry[] = [];
  try {
    const runtimeTools = await loadMcpRuntimeTools(cwd);
    const allowed = allowedMcpServers?.length ? new Set(allowedMcpServers) : undefined;
    mcp = runtimeTools
      .filter((tool) => !allowed || allowed.has(tool.mcpServer))
      .map((tool) => {
        // MCP authors don't ship `examples` in the MCP tool spec, so we
        // synthesise a minimal required-only placeholder from the JSON schema.
        // The shape (not the values) is what saves the model from the
        // "right tool, wrong args" round-trip the Anthropic tool-design
        // article flags. Skipped when there are no required fields — an empty
        // `{}` example adds no signal over the rendered `<input>` list.
        const synthetic = tool.inputJsonSchema ? synthesizeExampleFromJsonSchema(tool.inputJsonSchema) : undefined;
        return {
          name: tool.name,
          // `tool.description` already begins with the `[MCP:<server>]` prefix
          // set by mcp-runtime, which gives the ranker a strong server-name
          // signal without us re-adding it here.
          summary: tool.description,
          params: summarizeToolSchema(tool),
          examples: synthetic
            ? [{ description: "Minimal shape (required fields only; values are placeholders)", input: synthetic }]
            : undefined,
        };
      });
  } catch {
    // mcp.json missing or unparseable: just return native — the model's
    // search shouldn't fail because MCP config has a typo.
  }
  return [...native, ...mcp];
}

/** Render one catalog match as a `<tool>` block with name, summary, and (if
 * the registry filled it in) top-level parameters. Older test fixtures that
 * pre-date Phase 1.2 won't carry `params`, so we degrade to the legacy
 * one-line format rather than emit an empty `<input/>`. */
function renderMatch(entry: DeferredCatalogEntry): string[] {
  if (!entry.params) {
    return [`  - ${entry.name}: ${entry.summary}`];
  }
  const lines = [`  <tool name="${entry.name}">`, `    <summary>${entry.summary}</summary>`];
  if (entry.params.length === 0) {
    lines.push(`    <input>(no parameters)</input>`);
  } else {
    lines.push(`    <input>`);
    for (const param of entry.params) lines.push(`      ${formatParamLine(param)}`);
    lines.push(`    </input>`);
  }
  if (entry.examples && entry.examples.length > 0) {
    lines.push(`    <examples>`);
    for (const example of entry.examples) {
      // JSON.stringify(value) gives the model a shape that's directly
      // copy-pasteable into a tool_use block. Single-line keeps the result
      // compact; if the JSON is huge the model still gets the structural
      // signal without us paginating across multiple lines.
      lines.push(`      - ${example.description}: ${JSON.stringify(example.input)}`);
    }
    lines.push(`    </examples>`);
  }
  lines.push(`  </tool>`);
  return lines;
}
