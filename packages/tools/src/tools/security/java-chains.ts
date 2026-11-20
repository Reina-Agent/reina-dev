import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { description as searchDescription } from "../../prompts/search-java-gadgets.js";
import { description as findChainsDescription } from "../../prompts/find-java-chains.js";
import gadgetRaw from "./gadget.json" with { type: "json" };

type GadgetParam = {
  name: string;
  fieldName: string;
  value: unknown;
  type: string;
  choices: Record<string, string>;
  description: string;
  required: boolean;
};

type Gadget = {
  name: string;
  key: string;
  description: string;
  alias?: string;
  thirdLib?: string;
  priority?: number;
  dependencies: string[];
  authors?: string[];
  tags: string[];
  nextTags: string[];
  preTags?: string[];
  excludes?: string[];
  expression?: string;
  nextGadgets?: unknown;
  params?: GadgetParam[];
  status?: boolean;
};

type GadgetData = { data: Gadget[] };

const gadgets: Gadget[] = (gadgetRaw as GadgetData).data ?? [];

// Indices built once at module load.
const tagIndex = new Map<string, number[]>();
const depIndex = new Map<string, number[]>();
const tagMap = new Map<string, Gadget[]>();

for (let i = 0; i < gadgets.length; i += 1) {
  const g = gadgets[i];
  for (const tag of g.tags ?? []) {
    if (!tagIndex.has(tag)) tagIndex.set(tag, []);
    tagIndex.get(tag)!.push(i);
    if (!tagMap.has(tag)) tagMap.set(tag, []);
    tagMap.get(tag)!.push(g);
  }
  for (const dep of g.dependencies ?? []) {
    const key = dep.toLowerCase();
    if (!depIndex.has(key)) depIndex.set(key, []);
    depIndex.get(key)!.push(i);
  }
}

function formatGadget(g: Gadget, verbose: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: g.key ?? "",
    name: g.name ?? "",
    description: g.description ?? "",
    tags: g.tags ?? [],
    nextTags: g.nextTags ?? [],
    dependencies: g.dependencies ?? [],
  };
  if (verbose) {
    out.params = g.params ?? [];
    out.thirdLib = g.thirdLib ?? "";
  }
  return out;
}

function keywordMatch(g: Gadget, kwLower: string): boolean {
  return (
    (g.name ?? "").toLowerCase().includes(kwLower) ||
    (g.key ?? "").toLowerCase().includes(kwLower) ||
    (g.description ?? "").toLowerCase().includes(kwLower) ||
    (g.thirdLib ?? "").toLowerCase().includes(kwLower)
  );
}

function parseLibs(input: string): string[] {
  return input
    .split(/[,\n;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function depSatisfied(dep: string, availableLibs: string[]): boolean {
  const depLower = dep.toLowerCase().trim();

  if (
    depLower === "jdk" ||
    depLower === "jdk原生" ||
    depLower === "all jdk" ||
    depLower === "only jdk"
  ) {
    return true;
  }
  if (depLower.startsWith("jdk:")) return true;
  if (depLower.startsWith("jdk") && /[<>=]/.test(depLower)) return true;

  const depParts = depLower.split(":");
  const depArtifact = depParts.length >= 2 ? depParts[1] : depParts[0];

  for (const lib of availableLibs) {
    const libParts = lib.split(":");
    const libArtifact = libParts.length >= 2 ? libParts[1] : libParts[0];

    if (depParts.length >= 2 && libParts.length >= 2) {
      if (depParts.slice(0, 2).join(":") === libParts.slice(0, 2).join(":")) return true;
    }
    if (depArtifact && libArtifact) {
      if (depArtifact && lib.includes(depArtifact)) return true;
      if (libArtifact && depLower.includes(libArtifact)) return true;
    }
    if (depLower.includes(lib) || lib.includes(depLower)) return true;
  }
  return false;
}

function allDepsSatisfied(g: Gadget, availableLibs: string[]): boolean {
  const deps = g.dependencies ?? [];
  if (deps.length === 0) return true;
  return deps.every((d) => depSatisfied(d, availableLibs));
}

function isBlacklisted(g: Gadget, blacklist: string[]): boolean {
  if (blacklist.length === 0) return false;
  const haystack = [
    g.key ?? "",
    g.name ?? "",
    g.thirdLib ?? "",
    (g.dependencies ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return blacklist.some((b) => haystack.includes(b.toLowerCase()));
}

function findChains(
  entryTag: string,
  availableLibs: string[] | null,
  blacklist: string[],
  maxDepth: number,
  maxChains: number,
): Gadget[][] {
  const chains: Gadget[][] = [];
  const queue: Gadget[][] = [];
  const visitedPaths = new Set<string>();

  const entryGadgets = tagMap.get(entryTag) ?? [];
  for (const g of entryGadgets) {
    if (availableLibs !== null && !allDepsSatisfied(g, availableLibs)) continue;
    if (isBlacklisted(g, blacklist)) continue;
    queue.push([g]);
  }

  while (queue.length > 0 && chains.length < maxChains) {
    const path = queue.shift()!;
    const current = path[path.length - 1];

    if ((current.tags ?? []).includes("END")) {
      const key = path.map((p) => p.key).join("->");
      if (!visitedPaths.has(key)) {
        visitedPaths.add(key);
        chains.push(path);
      }
      continue;
    }

    const nextTags = current.nextTags ?? [];
    if (nextTags.length === 0 || path.length >= maxDepth) continue;

    const pathKeys = new Set(path.map((p) => p.key));
    for (const nt of nextTags) {
      const nextGadgets = tagMap.get(nt) ?? [];
      for (const nextG of nextGadgets) {
        if (pathKeys.has(nextG.key)) continue;
        if (availableLibs !== null && !allDepsSatisfied(nextG, availableLibs)) continue;
        if (isBlacklisted(nextG, blacklist)) continue;
        queue.push([...path, nextG]);
      }
    }
  }

  return chains;
}

// ── Tool: search_java_gadgets ────────────────────────────────────────────

const searchSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe(
      "Substring search across each gadget's name/key/description/thirdLib (case-insensitive). E.g. 'commonscollections', 'TemplatesImpl', 'rce'.",
    ),
  dependency: z
    .string()
    .optional()
    .describe(
      "Library coordinate substring matched against gadget dependencies[]. E.g. 'commons-collections', 'fastjson', 'c3p0:c3p0', 'org.springframework:spring-core'.",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Exact tag string from the catalog's tag set. E.g. 'JavaNativeDeserialize', 'Getter', 'ToString', 'END'. If you're not sure what tags exist, try list_meta='tags' first.",
    ),
  list_meta: z
    .enum(["tags", "dependencies", "deps"])
    .optional()
    .describe(
      "Discovery helper: returns the full set of valid tags or dependency strings in the catalog so you know what to filter by next. Pass 'tags' to list every tag, 'dependencies' (or 'deps') to list every dep string. Other filters are ignored when this is set.",
    ),
  verbose: z
    .boolean()
    .optional()
    .describe("When true, each result also includes params[] and thirdLib. Defaults to false for compact output."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max gadgets to return (1-50). Defaults to 20."),
});

export const searchJavaGadgetsTool: ToolImplementation = {
  descriptor: {
    name: "search_java_gadgets",
    description: searchDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    catalogSummary:
      "Search the offline Java deserialization gadget catalog by dep/keyword/tag (Chinese pentest aid).",
    inputSchema: searchSchema,
    examples: [
      {
        description: "Enumerate every tag in the catalog (run this FIRST when you don't know what tags exist)",
        input: { list_meta: "tags" },
      },
      {
        description: "Enumerate every dependency string in the catalog",
        input: { list_meta: "dependencies" },
      },
      {
        description: "List gadgets reachable through a specific library",
        input: { dependency: "commons-collections", limit: 20 },
      },
      {
        description: "Fuzzy keyword match across name / key / description",
        input: { keyword: "deserialize" },
      },
      {
        description: "Filter by an exact entry-point tag, verbose for params details",
        input: { tag: "JavaNativeDeserialize", verbose: true, limit: 10 },
      },
    ],
  },
  async execute(input) {
    const parsed = searchSchema.parse(input);

    if (parsed.list_meta) {
      const meta = parsed.list_meta.toLowerCase();
      if (meta === "tags") {
        const data: Record<string, number> = {};
        for (const [t, idxs] of [...tagIndex.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          data[t] = idxs.length;
        }
        return JSON.stringify({ type: "tags", total: tagIndex.size, data }, null, 2);
      }
      if (meta === "dependencies" || meta === "deps") {
        const allDeps = new Set<string>();
        for (const g of gadgets) for (const d of g.dependencies ?? []) allDeps.add(d);
        return JSON.stringify(
          { type: "dependencies", total: allDeps.size, data: [...allDeps].sort() },
          null,
          2,
        );
      }
    }

    const limit = parsed.limit ?? 20;
    let candidates: Set<number> | null = null;

    if (parsed.tag) {
      candidates = new Set(tagIndex.get(parsed.tag) ?? []);
    }
    if (parsed.dependency) {
      const dl = parsed.dependency.toLowerCase();
      const matched = new Set<number>();
      for (const [dk, idxs] of depIndex.entries()) {
        if (dk.includes(dl)) for (const i of idxs) matched.add(i);
      }
      candidates = candidates === null ? matched : new Set([...candidates].filter((i) => matched.has(i)));
    }
    if (candidates === null) {
      candidates = new Set(gadgets.map((_, i) => i));
    }
    if (parsed.keyword) {
      const kwLower = parsed.keyword.toLowerCase();
      candidates = new Set([...candidates].filter((i) => keywordMatch(gadgets[i], kwLower)));
    }

    // Count how many extra hits the tag filter rejected, so the model can see it might be over-filtering.
    let tagExcluded = 0;
    if (parsed.tag && (parsed.dependency || parsed.keyword)) {
      let noTagCandidates = new Set(gadgets.map((_, i) => i));
      if (parsed.dependency) {
        const dl = parsed.dependency.toLowerCase();
        const matched = new Set<number>();
        for (const [dk, idxs] of depIndex.entries()) {
          if (dk.includes(dl)) for (const i of idxs) matched.add(i);
        }
        noTagCandidates = new Set([...noTagCandidates].filter((i) => matched.has(i)));
      }
      if (parsed.keyword) {
        const kwLower = parsed.keyword.toLowerCase();
        noTagCandidates = new Set([...noTagCandidates].filter((i) => keywordMatch(gadgets[i], kwLower)));
      }
      for (const i of noTagCandidates) if (!candidates.has(i)) tagExcluded += 1;
    }

    const sorted = [...candidates].sort(
      (a, b) => (gadgets[a].priority ?? 100) - (gadgets[b].priority ?? 100),
    );
    const verbose = parsed.verbose ?? false;
    const results = sorted.slice(0, limit).map((i) => formatGadget(gadgets[i], verbose));

    const output: Record<string, unknown> = {
      total: sorted.length,
      showing: results.length,
      results,
    };
    if (parsed.tag) {
      output.note = `Filtered by tag='${parsed.tag}'. Tag is an incomplete index — consider re-searching without the tag and judging applicability from the target's actual deserialization triggers (put/toString/hashCode/equals/getter).`;
    }
    if (parsed.tag && tagExcluded > 0) {
      output.warning = `${tagExcluded} additional matching gadgets were excluded by tag='${parsed.tag}'. Re-run without the tag filter to see them.`;
    }
    return JSON.stringify(output, null, 2);
  },
};

// ── Tool: find_java_chains ────────────────────────────────────────────────

const findChainsSchema = z.object({
  available_libs: z
    .string()
    .optional()
    .describe(
      "Dep list available on the target classpath. Comma / newline / semicolon separated. Accepts plain artifactIds or 'groupId:artifactId' pairs. E.g. 'commons-collections, fastjson, c3p0' or 'org.apache.commons:commons-collections4\\norg.springframework:spring-core'. Omit to return every chain for the entry_tag (useful for catalog exploration).",
    ),
  entry_tag: z
    .string()
    .optional()
    .describe(
      "Deserialization entry-point tag. Defaults to 'JavaNativeDeserialize'. Other common values: 'HessianDeserialize', 'FastjsonPayload', 'Getter', 'ToString', 'JdkProxy'. If you need the full list, search_java_gadgets({list_meta:'tags'}).",
    ),
  blacklist: z
    .string()
    .optional()
    .describe(
      "Comma-separated substrings; any chain that mentions one is dropped. E.g. 'TemplatesImpl, InvokerTransformer' to skip the two most-detected sinks.",
    ),
  max_chains: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max chains to return (1-100). Defaults to 30. Sorted by length ascending, so the cap drops the longest chains first.",
    ),
});

export const findJavaChainsTool: ToolImplementation = {
  descriptor: {
    name: "find_java_chains",
    description: findChainsDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    catalogSummary:
      "BFS the offline Java deserialization catalog for chains reachable through a given dep list.",
    inputSchema: findChainsSchema,
    examples: [
      {
        description: "Triage a target with commons-collections + fastjson on classpath",
        input: { available_libs: "commons-collections, fastjson" },
      },
      {
        description: "Explore every chain for an entry tag without dep constraints",
        input: { entry_tag: "JavaNativeDeserialize", max_chains: 50 },
      },
      {
        description: "Same but skip well-detected gadgets",
        input: {
          available_libs: "commons-collections, fastjson, c3p0",
          blacklist: "TemplatesImpl, InvokerTransformer",
        },
      },
    ],
  },
  async execute(input) {
    const parsed = findChainsSchema.parse(input);
    const libsRaw = parsed.available_libs?.trim() ?? "";
    const libs = libsRaw ? parseLibs(libsRaw) : null;
    const blacklist = (parsed.blacklist ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const maxChains = parsed.max_chains ?? 30;
    const entryTag = parsed.entry_tag?.trim() || "JavaNativeDeserialize";

    const chains = findChains(entryTag, libs, blacklist, 6, maxChains);

    if (chains.length === 0) {
      let msg = `No chains found (entry_tag: ${entryTag})`;
      if (libs) msg += `, libs: ${libs.join(", ")}`;
      return JSON.stringify({ total: 0, chains: [], message: msg }, null, 2);
    }

    const formatted = chains.map((chain) => {
      const allDeps = new Set<string>();
      for (const g of chain) for (const d of g.dependencies ?? []) allDeps.add(d);
      return {
        chain: chain.map((g) => g.key).join(" -> "),
        length: chain.length,
        steps: chain.map((g) => ({
          key: g.key,
          name: g.name,
          deps: g.dependencies ?? [],
        })),
        all_deps: [...allDeps].sort(),
      };
    });

    formatted.sort((a, b) => a.length - b.length);

    return JSON.stringify(
      { total: formatted.length, entry_tag: entryTag, libs, chains: formatted },
      null,
      2,
    );
  },
};
