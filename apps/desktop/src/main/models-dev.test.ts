import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomModel } from "./custom-models.js";
import {
  enrichCustomModels,
  fillMissingModelFields,
  inferThinkingMode,
  loadModelsDevCatalog,
  lookupModelsDevMeta,
  mapEffortValues,
  mapReasoningLevels,
  type ModelsDevCatalog,
  type ModelsDevMeta,
} from "./models-dev.js";

const catalog: ModelsDevCatalog = {
  anthropic: {
    models: {
      "claude-opus-4": {
        id: "claude-opus-4",
        limit: { context: 200000, output: 32000 },
        reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32000 }],
      },
    },
  },
  openai: {
    models: {
      "gpt-5.1": {
        id: "gpt-5.1",
        limit: { context: 400000, output: 128000 },
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", null] }],
      },
    },
  },
  deepseek: {
    models: {
      "deepseek-chat": { id: "deepseek-chat", limit: { context: 128000, output: 8000 } },
    },
  },
};

describe("models.dev mapping", () => {
  it("intersects effort values with Reina's tiers, dropping none/default/null/unknown", () => {
    expect(mapEffortValues(["none", "minimal", "low", "high", "default", null, "max"])).toEqual(["low", "high", "max"]);
    // Canonical ascending order regardless of catalog order.
    expect(mapEffortValues(["max", "low"])).toEqual(["low", "max"]);
    expect(mapEffortValues(["none", "default", null])).toBeUndefined();
    expect(mapEffortValues([])).toBeUndefined();
  });

  it("infers thinkingMode from reasoning_options shape (effort→adaptive, budget→budget, toggle→unset)", () => {
    expect(inferThinkingMode([{ type: "effort", values: ["low"] }])).toBe("adaptive");
    expect(inferThinkingMode([{ type: "budget_tokens", min: 1024 }])).toBe("budget");
    // effort wins when both are present.
    expect(inferThinkingMode([{ type: "budget_tokens" }, { type: "effort", values: ["low"] }])).toBe("adaptive");
    expect(inferThinkingMode([{ type: "toggle" }])).toBeUndefined();
    expect(inferThinkingMode([])).toBeUndefined();
  });

  it("maps explicit none to off without confusing provider defaults with off", () => {
    expect(mapReasoningLevels(["none", "low", "high", null])).toEqual(["off", "low", "high"]);
    expect(mapReasoningLevels(["default", null])).toBeUndefined();
  });

  it("maps Reina provider ids onto models.dev provider ids", () => {
    expect(lookupModelsDevMeta(catalog, "anthropic-messages", "claude-opus-4")).toEqual({
      contextWindowTokens: 200000,
      maxOutputTokens: 32000,
      thinkingMode: "budget",
    });
    for (const provider of ["openai-responses", "openai-chat", "openai-codex-responses"]) {
      expect(lookupModelsDevMeta(catalog, provider, "gpt-5.1")).toEqual({
        contextWindowTokens: 400000,
        maxOutputTokens: 128000,
        thinkingMode: "adaptive",
        supportedEfforts: ["low", "medium", "high", "xhigh"],
        reasoningLevels: ["off", "low", "medium", "high", "xhigh"],
        offEffort: "none",
      });
    }
  });

  it("falls back to an exact model-id match across all providers for compat buckets", () => {
    // openai-chat pointed at a DeepSeek base URL: no hit under "openai",
    // exact-id search finds it under "deepseek".
    expect(lookupModelsDevMeta(catalog, "openai-chat", "deepseek-chat")).toEqual({
      contextWindowTokens: 128000,
      maxOutputTokens: 8000,
    });
    expect(lookupModelsDevMeta(catalog, "openai-chat", "no-such-model")).toBeNull();
  });
});

describe("models.dev never-overwrite merge", () => {
  const meta: ModelsDevMeta = {
    contextWindowTokens: 200000,
    maxOutputTokens: 32000,
    thinkingMode: "budget",
    supportedEfforts: ["low", "high"],
    reasoningLevels: ["off", "low", "high"],
  };

  it("fills only missing fields and reports filled", () => {
    const entry: Partial<CustomModel> = { id: "m", provider: "anthropic-messages", model: "claude-opus-4" };
    const { entry: next, filled } = fillMissingModelFields(entry, meta);
    expect(filled).toBe(true);
    expect(next.contextWindowTokens).toBe(200000);
    expect(next.maxOutputTokens).toBe(32000);
    expect(next.thinkingMode).toBe("budget");
    expect(next.supportedEfforts).toEqual(["low", "high"]);
    expect(next.reasoningLevels).toEqual(["off", "low", "high"]);
  });

  it("never overwrites user-set values (dirty-baseline iron rule)", () => {
    const entry: Partial<CustomModel> = {
      id: "m",
      provider: "anthropic-messages",
      model: "claude-opus-4",
      contextWindowTokens: 100000,
      maxOutputTokens: 4096,
      thinkingMode: "adaptive",
      supportedEfforts: ["max"],
    };
    const { entry: next, filled } = fillMissingModelFields(entry, meta);
    expect(filled).toBe(false);
    expect(next).toBe(entry); // untouched object when nothing was filled
    expect(next.contextWindowTokens).toBe(100000);
    expect(next.maxOutputTokens).toBe(4096);
    expect(next.thinkingMode).toBe("adaptive");
    expect(next.supportedEfforts).toEqual(["max"]);
    expect(next.reasoningLevels).toBeUndefined();
  });

  it("treats empty supportedEfforts as unset but keeps partial user values elsewhere", () => {
    const entry: Partial<CustomModel> = {
      id: "m",
      provider: "anthropic-messages",
      model: "claude-opus-4",
      contextWindowTokens: 100000,
      supportedEfforts: [],
    };
    const { entry: next, filled } = fillMissingModelFields(entry, meta);
    expect(filled).toBe(true);
    expect(next.contextWindowTokens).toBe(100000); // user value preserved
    expect(next.supportedEfforts).toEqual(["low", "high"]); // empty → filled
  });
});

describe("models.dev catalog cache", () => {
  let dir: string;
  let cacheFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "reina-models-dev-"));
    cacheFile = path.join(dir, "cache", "models-dev.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fetches on cache miss and persists checkedAt + catalog", async () => {
    let fetches = 0;
    const result = await loadModelsDevCatalog({
      cacheFile,
      now: () => 1000,
      fetchJson: async () => {
        fetches += 1;
        return catalog;
      },
    });
    expect(fetches).toBe(1);
    expect(result).toEqual(catalog);
    const written = JSON.parse(await readFile(cacheFile, "utf8"));
    expect(written.checkedAt).toBe(1000);
    expect(written.catalog).toEqual(catalog);
  });

  it("serves a fresh cache without fetching; refetches after the 24h TTL", async () => {
    await loadModelsDevCatalog({ cacheFile, now: () => 1000, fetchJson: async () => catalog });
    let fetches = 0;
    const fresh = await loadModelsDevCatalog({
      cacheFile,
      now: () => 1000 + 23 * 60 * 60 * 1000,
      fetchJson: async () => {
        fetches += 1;
        return {};
      },
    });
    expect(fetches).toBe(0);
    expect(fresh).toEqual(catalog);
    const stale = await loadModelsDevCatalog({
      cacheFile,
      now: () => 1000 + 25 * 60 * 60 * 1000,
      fetchJson: async () => {
        fetches += 1;
        return catalog;
      },
    });
    expect(fetches).toBe(1);
    expect(stale).toEqual(catalog);
  });

  it("serves the stale cache when the fetch fails, and null with no cache at all", async () => {
    await loadModelsDevCatalog({ cacheFile, now: () => 1000, fetchJson: async () => catalog });
    const stale = await loadModelsDevCatalog({
      cacheFile,
      now: () => 1000 + 48 * 60 * 60 * 1000,
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    expect(stale).toEqual(catalog);
    const nothing = await loadModelsDevCatalog({
      cacheFile: path.join(dir, "missing", "cache.json"),
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    expect(nothing).toBeNull();
  });

  it("rejects a corrupt cache file and non-object payloads", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "not json", "utf8");
    const result = await loadModelsDevCatalog({ cacheFile: bad, fetchJson: async () => [1, 2, 3] });
    expect(result).toBeNull();
  });
});

describe("enrichCustomModels", () => {
  it("fills missing fields per entry and reports filledIds only for changed entries", async () => {
    const entries: CustomModel[] = [
      { id: "a", label: "Opus", provider: "anthropic-messages", model: "claude-opus-4" },
      { id: "b", label: "GPT", provider: "openai-responses", model: "gpt-5.1", contextWindowTokens: 123000, maxOutputTokens: 1, thinkingMode: "budget", supportedEfforts: ["max"] },
      { id: "c", label: "Mystery", provider: "openai-chat", model: "unknown-model" },
    ];
    const { models, filledIds } = await enrichCustomModels(entries, {
      cacheFile: path.join(os.tmpdir(), `reina-models-dev-enrich-${Date.now()}.json`),
      fetchJson: async () => catalog,
    });
    expect(filledIds).toEqual(["a"]);
    expect(models[0]).toMatchObject({ contextWindowTokens: 200000, maxOutputTokens: 32000, thinkingMode: "budget" });
    // Fully user-configured entry and unknown model pass through untouched.
    expect(models[1]).toBe(entries[1]);
    expect(models[2]).toBe(entries[2]);
  });

  it("degrades to a no-op when no catalog is available", async () => {
    const entries: CustomModel[] = [{ id: "a", label: "Opus", provider: "anthropic-messages", model: "claude-opus-4" }];
    const { models, filledIds } = await enrichCustomModels(entries, {
      cacheFile: path.join(os.tmpdir(), `reina-models-dev-none-${Date.now()}.json`),
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    expect(filledIds).toEqual([]);
    expect(models).toEqual(entries);
  });
});
