import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelConfig } from "@reina/protocol";
import { RuntimeModelCatalog } from "./runtime-model-catalog.js";

let cwd: string;
let revision = 0;
const original: ModelConfig = {
  provider: "openai-chat", model: "shared-name", baseUrl: "https://one.example/v1", apiKey: "first-key",
  reasoningEffort: "low", contextWindowTokens: 100_000,
};

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-model-catalog-"));
  vi.stubEnv("REINA_CONFIG_HOME", path.join(cwd, "global"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

async function writeCatalog(scope: "global" | "workspace", entries: unknown) {
  const folder = path.join(cwd, scope === "global" ? "global" : ".reina");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "models.json");
  await writeFile(file, JSON.stringify(entries));
  const changed = new Date(Date.now() + ++revision * 1000);
  await utimes(file, changed, changed);
}

describe("runtime model catalog", () => {
  test("a bound session follows connection and capability edits while preserving its effort", async () => {
    await writeCatalog("global", [{ id: "chosen", ...original, reasoningEffort: "high" }]);
    const catalog = new RuntimeModelCatalog();
    expect(await catalog.resolve(cwd, original)).toBeUndefined();
    const edited = { ...original, baseUrl: "https://new.example/v1", apiKey: "new-key", contextWindowTokens: 200_000, maxOutputTokens: 4096 };
    await writeCatalog("global", [{ id: "chosen", ...edited, reasoningEffort: "max" }]);
    const next = await catalog.resolve(cwd, original);
    expect(next).toMatchObject({ ...edited, reasoningEffort: "low" });
    expect(await catalog.resolve(cwd, next!)).toBeUndefined();
  });

  test("unbound manual connections and secondary-model overrides never inherit another account", async () => {
    await writeCatalog("global", [{ id: "configured", ...original }]);
    const catalog = new RuntimeModelCatalog();
    expect(await catalog.resolve(cwd, { ...original, baseUrl: "https://manual.example/v1" })).toBeUndefined();
    expect(await catalog.resolve(cwd, { ...original, apiKey: "secondary-agent-key" })).toBeUndefined();
    expect(await catalog.resolve(cwd, { ...original, headers: { "X-Account": "manual" } })).toBeUndefined();
    expect(await catalog.resolve(cwd, { ...original, subscriptionId: "oauth-account" })).toBeUndefined();
  });

  test("initial binding and unrelated catalog edits preserve explicit session capabilities", async () => {
    await writeCatalog("global", [{ id: "chosen", ...original, maxOutputTokens: 2000 }]);
    const catalog = new RuntimeModelCatalog();
    const explicit = { ...original, maxOutputTokens: 9000 };
    expect(await catalog.resolve(cwd, explicit)).toBeUndefined();
    await writeCatalog("global", [{ id: "chosen", ...original, maxOutputTokens: 2000, apiKey: "rotated-key" }]);
    expect(await catalog.resolve(cwd, explicit)).toMatchObject({ apiKey: "rotated-key", maxOutputTokens: 9000 });
  });

  test("workspace overrides win and removing the bound entry does not select a sibling", async () => {
    await writeCatalog("global", [{ id: "chosen", ...original, maxOutputTokens: 1000 }]);
    await writeCatalog("workspace", [{ id: "chosen", ...original, maxOutputTokens: 2000 }]);
    const catalog = new RuntimeModelCatalog();
    expect(await catalog.resolve(cwd, original)).toBeUndefined();
    await writeCatalog("workspace", [{ id: "chosen", ...original, maxOutputTokens: 3000 }]);
    const next = await catalog.resolve(cwd, original);
    expect(next?.maxOutputTokens).toBe(3000);
    await writeCatalog("global", []);
    await writeCatalog("workspace", [{ id: "other-account", ...original, apiKey: "another-key" }]);
    expect(await catalog.resolve(cwd, next!)).toBeUndefined();
  });

  test("an unfinished invalid edit does not replace the previous valid catalog", async () => {
    await writeCatalog("global", [{ id: "chosen", ...original }]);
    const catalog = new RuntimeModelCatalog();
    await catalog.resolve(cwd, original);
    await writeCatalog("global", {});
    await expect(catalog.resolve(cwd, original)).rejects.toThrow("Invalid model catalog");
    await writeCatalog("global", [{ id: "chosen", ...original, maxOutputTokens: 8000 }]);
    expect((await catalog.resolve(cwd, original))?.maxOutputTokens).toBe(8000);
  });
});
