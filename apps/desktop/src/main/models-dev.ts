// models.dev pre-fill: fetch the community model catalog (https://models.dev)
// once a day, cache it under $REINA_HOME/cache/, and map its metadata onto
// Reina's models.json capability fields (contextWindowTokens / maxOutputTokens
// / thinkingMode / supportedEfforts). Electron-free so it stays unit-testable
// like custom-models.ts.
//
// IRON RULE: models.dev data is a dirty baseline, not an authority (known
// wrong context/output entries). Enrichment ONLY fills fields the user has
// not set — it must never overwrite an existing value.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelConfig, ReasoningEffort } from "@reina/protocol";
import { reasoningEfforts } from "@reina/protocol";
import type { CustomModel } from "./custom-models.js";

// === models.dev api.json shapes (only the fields we consume) ===

export type ModelsDevReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values?: Array<string | null> }
  | { type: "budget_tokens"; min?: number; max?: number };

export type ModelsDevModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  limit?: { context?: number; output?: number };
};

export type ModelsDevCatalog = Record<string, { models?: Record<string, ModelsDevModel> }>;

/** The subset of CustomModel that models.dev can pre-fill. */
export type ModelsDevMeta = {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  thinkingMode?: ModelConfig["thinkingMode"];
  supportedEfforts?: ReasoningEffort[];
  reasoningLevels?: ReasoningEffort[];
  offEffort?: ModelConfig["offEffort"];
};

// === Catalog cache ($REINA_HOME/cache/models-dev.json, 24h TTL) ===

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

/** Mirrors `reinaConfigHome` in ipc.ts (models.json lives beside this cache). */
function reinaConfigHome(): string {
  return process.env.REINA_CONFIG_HOME
    ? path.resolve(process.env.REINA_CONFIG_HOME)
    : path.join(os.homedir(), ".reina");
}

function defaultCachePath(): string {
  return path.join(reinaConfigHome(), "cache", "models-dev.json");
}

type CacheFile = { checkedAt: number; catalog: ModelsDevCatalog };

export type LoadCatalogOptions = {
  /** Injectable fetch for tests; default hits https://models.dev/api.json. */
  fetchJson?: () => Promise<unknown>;
  cacheFile?: string;
  now?: () => number;
};

async function readCatalogCache(file: string): Promise<CacheFile | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile> | null;
    if (!parsed || typeof parsed.checkedAt !== "number" || !parsed.catalog || typeof parsed.catalog !== "object") return null;
    return { checkedAt: parsed.checkedAt, catalog: parsed.catalog };
  } catch {
    return null;
  }
}

async function fetchCatalogJson(): Promise<unknown> {
  const response = await fetch(MODELS_DEV_URL, {
    headers: { "User-Agent": "reina/0.1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  return response.json();
}

/** Load the models.dev catalog: fresh cache → cache, stale/missing → refetch
 * (persisting the result), fetch failure → stale cache if present, else null. */
export async function loadModelsDevCatalog(opts: LoadCatalogOptions = {}): Promise<ModelsDevCatalog | null> {
  const file = opts.cacheFile ?? defaultCachePath();
  const now = opts.now ?? Date.now;
  const cached = await readCatalogCache(file);
  if (cached && now() - cached.checkedAt < CACHE_TTL_MS) return cached.catalog;
  try {
    const fetched = opts.fetchJson ? await opts.fetchJson() : await fetchCatalogJson();
    if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) throw new Error("Unexpected models.dev payload shape");
    const catalog = fetched as ModelsDevCatalog;
    // Cache write is best-effort — a read-only home dir must not block lookups.
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ checkedAt: now(), catalog } satisfies CacheFile), "utf8");
    } catch {
      // ignore
    }
    return catalog;
  } catch {
    return cached?.catalog ?? null;
  }
}

// === Mapping (models.dev model → Reina capability fields) ===

/** Reina provider ids → models.dev provider ids to try first. */
const PROVIDER_ID_MAP: Record<string, string[]> = {
  "anthropic-messages": ["anthropic"],
  "openai-responses": ["openai"],
  "openai-chat": ["openai"],
  "openai-codex-responses": ["openai"],
};

/** Intersect models.dev effort values with Reina's effort vocabulary.
 * "none" / "default" / null / unknown tiers ("minimal") are dropped; "off" is
 * Reina-internal and never asserted from catalog data. Order follows Reina's
 * canonical ascending tiers. */
export function mapEffortValues(values: Array<string | null>): ReasoningEffort[] | undefined {
  const present = new Set(values.filter((v): v is string => typeof v === "string"));
  const tiers = reasoningEfforts.filter((tier) => tier !== "off" && present.has(tier));
  return tiers.length > 0 ? tiers : undefined;
}

/** Complete selectable levels use an explicit catalog none/off as off. A
 * default/null entry is not evidence that a provider can disable thinking. */
export function mapReasoningLevels(values: Array<string | null>): ReasoningEffort[] | undefined {
  const present = new Set(values.map((value) => value === "none" ? "off" : value));
  const levels = reasoningEfforts.filter((level) => present.has(level));
  return levels.length > 0 ? levels : undefined;
}

/** effort-type options → "adaptive"; budget_tokens-type → "budget"; a bare
 * toggle (or no reasoning options) is too ambiguous to assert — leave unset. */
export function inferThinkingMode(options: ModelsDevReasoningOption[]): ModelConfig["thinkingMode"] | undefined {
  if (options.some((o) => o?.type === "effort")) return "adaptive";
  if (options.some((o) => o?.type === "budget_tokens")) return "budget";
  return undefined;
}

export function mapModelsDevModel(model: ModelsDevModel): ModelsDevMeta {
  const meta: ModelsDevMeta = {};
  const context = model.limit?.context;
  if (typeof context === "number" && Number.isFinite(context) && context > 0) meta.contextWindowTokens = Math.floor(context);
  const output = model.limit?.output;
  if (typeof output === "number" && Number.isFinite(output) && output > 0) meta.maxOutputTokens = Math.floor(output);
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const effortValues = options.flatMap((o) => (o?.type === "effort" && Array.isArray(o.values) ? o.values : []));
  const efforts = mapEffortValues(effortValues);
  if (efforts) meta.supportedEfforts = efforts;
  const levels = mapReasoningLevels(effortValues);
  if (levels) meta.reasoningLevels = levels;
  if (effortValues.includes("none")) meta.offEffort = "none";
  const thinkingMode = inferThinkingMode(options);
  if (thinkingMode) meta.thinkingMode = thinkingMode;
  return meta;
}

/** Find catalog metadata for a Reina (provider, model id) pair. Mapped
 * providers are tried first; custom/compat buckets (any baseUrl, unmapped
 * provider) fall back to an exact model-id match across ALL catalog providers. */
export function lookupModelsDevMeta(catalog: ModelsDevCatalog, provider: string, modelId: string): ModelsDevMeta | null {
  const preferred = PROVIDER_ID_MAP[provider] ?? [];
  for (const pid of preferred) {
    const model = catalog[pid]?.models?.[modelId];
    if (model) return mapModelsDevModel(model);
  }
  for (const pid of Object.keys(catalog)) {
    if (preferred.includes(pid)) continue;
    const model = catalog[pid]?.models?.[modelId];
    if (model) return mapModelsDevModel(model);
  }
  return null;
}

// === Never-overwrite merge ===

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Fill ONLY fields the entry doesn't already carry (the IRON RULE above).
 * Returns the original object untouched when nothing was filled. */
export function fillMissingModelFields<T extends Partial<CustomModel>>(entry: T, meta: ModelsDevMeta): { entry: T; filled: boolean } {
  const next = { ...entry };
  let filled = false;
  if (!hasPositiveNumber(next.contextWindowTokens) && meta.contextWindowTokens !== undefined) {
    next.contextWindowTokens = meta.contextWindowTokens;
    filled = true;
  }
  if (!hasPositiveNumber(next.maxOutputTokens) && meta.maxOutputTokens !== undefined) {
    next.maxOutputTokens = meta.maxOutputTokens;
    filled = true;
  }
  if (next.thinkingMode !== "adaptive" && next.thinkingMode !== "budget" && meta.thinkingMode !== undefined) {
    next.thinkingMode = meta.thinkingMode;
    filled = true;
  }
  const hasEfforts = Array.isArray(next.supportedEfforts) && next.supportedEfforts.length > 0;
  if (!hasEfforts && meta.supportedEfforts !== undefined) {
    next.supportedEfforts = meta.supportedEfforts;
    filled = true;
  }
  // A user's legacy top-tier override must not be narrowed by a newly inferred
  // complete set. Only brand-new/missing capability data receives this field.
  if (next.reasoningLevels === undefined && !hasEfforts && meta.reasoningLevels !== undefined) {
    next.reasoningLevels = meta.reasoningLevels;
    filled = true;
  }
  if (next.offEffort === undefined && !hasEfforts && meta.offEffort !== undefined) {
    next.offEffort = meta.offEffort;
    filled = true;
  }
  return { entry: filled ? next : entry, filled };
}

/** Batch pre-fill: enrich each entry from the catalog (missing fields only).
 * A failed/absent catalog degrades to a no-op. */
export async function enrichCustomModels(
  entries: CustomModel[],
  opts: LoadCatalogOptions = {},
): Promise<{ models: CustomModel[]; filledIds: string[] }> {
  const catalog = await loadModelsDevCatalog(opts);
  if (!catalog) return { models: entries, filledIds: [] };
  const filledIds: string[] = [];
  const models = entries.map((model) => {
    const meta = lookupModelsDevMeta(catalog, model.provider, model.model);
    if (!meta) return model;
    const { entry, filled } = fillMissingModelFields(model, meta);
    if (filled) filledIds.push(model.id);
    return entry;
  });
  return { models, filledIds };
}
