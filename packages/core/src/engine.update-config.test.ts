import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Regression coverage for AgentEngine.updateConfig's model path.
 *
 * updateConfig rebuilds the target ModelConfig field-by-field from the
 * incoming partial (undefined → cleared — see the comment in engine.ts) and
 * only calls setModel when an explicit field comparison reports a change.
 * Both lists once drifted behind protocol's modelConfigSchema:
 *  - `subscriptionTools` / `offEffort` were missing from the rebuild, so ANY
 *    settings update to a Kimi subscription model silently stripped its
 *    server-side tools (kimi_web_search / kimi_web_fetch);
 *  - `authMode` / `accountId` / `subscriptionId` / `subscriptionUserAgent`
 *    were missing from the change detection, so an update that touched ONLY
 *    the OAuth identity was silently skipped (stale token → next turn 401).
 * The schema-key sweep below fails the moment a future schema field is added
 * without extending BOTH lists, so the drift cannot recur silently. */

import { AgentEngine } from "./engine.js";
import { modelConfigSchema, type ModelConfig } from "@reina/protocol";

let cwd: string;
let oldConfigHome: string | undefined;
const engines: AgentEngine[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-update-config-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  // Dispose settles the detached notes-service inits so the rm below doesn't
  // race their writes (EBUSY/ENOTEMPTY on Windows — same rationale as
  // engine.test.ts's closeEngineRecorder).
  for (const engine of engines.splice(0)) await engine.dispose();
  await rmTempDirWithRetry(cwd);
});

async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function makeEngine(): AgentEngine {
  const engine = new AgentEngine({ cwd, agent: "default" });
  engines.push(engine);
  return engine;
}

/** A ModelConfig with EVERY schema field populated. Kept in sync with
 * modelConfigSchema by the key sweep in the first test below. */
function fullModelConfig(): ModelConfig {
  return {
    provider: "openai-chat",
    model: "kimi-for-coding",
    baseUrl: "https://api.kimi.com/coding",
    apiKey: "sub-access-token",
    contextWindowTokens: 262_144,
    maxOutputTokens: 32_768,
    reasoningEffort: "high",
    thinkingMode: "adaptive",
    supportedEfforts: ["high", "xhigh"],
    reasoningLevels: ["low", "high", "xhigh"],
    reasoningDialect: "kimi",
    offEffort: "none",
    authMode: "bearer",
    headers: { "X-Test-Provider": "fixture" },
    accountId: "acct_123",
    subscriptionId: "kimi-sub-1",
    subscriptionUserAgent: "KimiCLI/1.2.3",
    subscriptionTools: ["kimi_web_search", "kimi_web_fetch"],
  };
}

describe("AgentEngine.updateConfig model rebuild", () => {
  it("preserves every modelConfigSchema field through an update (schema drift guard)", () => {
    const engine = makeEngine();
    const model = fullModelConfig();
    const result = engine.updateConfig({ model: { ...model } });

    // The sweep: every key the schema declares must survive onto the live
    // session model. A field missing from updateConfig's explicit rebuild
    // shows up here as undefined.
    for (const key of Object.keys(modelConfigSchema.shape)) {
      expect(engine.session.model, `field "${key}" dropped by updateConfig`).toHaveProperty(key);
    }
    expect(engine.session.model).toEqual(model);
    expect(result.changed.length).toBeGreaterThan(0);
  });

  it("applies an update that changes ONLY OAuth identity fields", () => {
    const engine = makeEngine();
    const prev = fullModelConfig();
    engine.setModel(prev);
    const setModelSpy = vi.spyOn(engine, "setModel");

    // Simulate the main process re-resolving a subscription: same model
    // entry, fresh token + identity fields only.
    const rotated = {
      ...prev,
      apiKey: "sub-access-token-rotated",
      authMode: "oauth" as const,
      accountId: "acct_456",
      subscriptionId: "kimi-sub-2",
      subscriptionUserAgent: "KimiCLI/1.2.4",
    };
    const result = engine.updateConfig({ model: rotated });

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(engine.session.model).toEqual(rotated);
    expect(result.changed).toContain("model settings updated");
  });

  it.each<[string, Partial<ModelConfig>]>([
    ["authMode", { authMode: "oauth" as const }],
    ["accountId", { accountId: "acct_999" }],
    ["subscriptionId", { subscriptionId: "kimi-sub-9" }],
    ["subscriptionUserAgent", { subscriptionUserAgent: "KimiCLI/9.9.9" }],
    ["offEffort", { offEffort: undefined }],
    ["subscriptionTools", { subscriptionTools: ["kimi_web_search"] }],
    ["reasoningLevels", { reasoningLevels: ["low", "high"] }],
    ["reasoningDialect", { reasoningDialect: "qwen" }],
    ["headers", { headers: { "X-Test-Provider": "updated" } }],
  ])("applies an update that changes ONLY %s", (_field, patch) => {
    const engine = makeEngine();
    const prev = fullModelConfig();
    engine.setModel(prev);
    const setModelSpy = vi.spyOn(engine, "setModel");

    engine.updateConfig({ model: { ...prev, ...patch } });

    // A single-field change must not be silently skipped.
    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(engine.session.model).toEqual({ ...prev, ...patch });
  });

  it.each(["reasoningLevels", "reasoningDialect", "headers"] as const)("clears an explicitly undefined %s", (field) => {
    const engine = makeEngine();
    const prev = fullModelConfig();
    engine.setModel(prev);
    const setModelSpy = vi.spyOn(engine, "setModel");

    const result = engine.updateConfig({ model: { ...prev, [field]: undefined } });

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(engine.session.model[field]).toBeUndefined();
    expect(result.changed).toContain("model settings updated");
  });

  it("clears omitted compatibility fields when replacing a model entry", () => {
    const engine = makeEngine();
    const prev = fullModelConfig();
    engine.setModel(prev);

    engine.updateConfig({ model: { provider: prev.provider, model: prev.model } });

    expect(engine.session.model.reasoningLevels).toBeUndefined();
    expect(engine.session.model.reasoningDialect).toBeUndefined();
    expect(engine.session.model.headers).toBeUndefined();
  });

  it("skips setModel when the incoming model is field-for-field identical", () => {
    const engine = makeEngine();
    const prev = fullModelConfig();
    engine.setModel(prev);
    const setModelSpy = vi.spyOn(engine, "setModel");

    const result = engine.updateConfig({
      model: { ...prev, reasoningLevels: [...prev.reasoningLevels!], headers: { ...prev.headers } },
    });

    expect(setModelSpy).not.toHaveBeenCalled();
    expect(result.changed).toEqual([]);
  });
});
