import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { modelConfigSchema, type ModelConfig } from "@reina/protocol";
import { reinaConfigHome } from "@reina/tools";

type CatalogEntry = { id: string; model: ModelConfig };

/** A session follows its configured model entry without adopting another
 * session's default. File metadata avoids reparsing an unchanged catalog at
 * every tool/request boundary. Subscription models have a separate resolver. */
export class RuntimeModelCatalog {
  private signature?: string;
  private entries: CatalogEntry[] = [];
  private boundId?: string;
  private boundIdentity?: string;
  private boundEntry?: ModelConfig;

  async resolve(cwd: string, current: ModelConfig): Promise<ModelConfig | undefined> {
    if (current.subscriptionId) return undefined;
    const files = [path.join(reinaConfigHome(), "models.json"), path.join(cwd, ".reina", "models.json")];
    const metadata = await Promise.all(files.map(async (file) => {
      try {
        const info = await stat(file);
        return `${file}:${info.mtimeMs}:${info.size}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${file}:missing`;
        throw error;
      }
    }));
    const signature = metadata.join("|");
    if (signature !== this.signature) {
      const catalogs = await Promise.all(files.map(async (file) => {
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (!Array.isArray(parsed)) throw new Error(`Invalid model catalog: ${file}`);
        return parsed.flatMap((entry): CatalogEntry[] => {
          if (!entry || typeof entry !== "object" || typeof entry.id !== "string"
            || typeof entry.provider !== "string" || typeof entry.model !== "string") return [];
          const result = modelConfigSchema.safeParse(entry);
          return result.success ? [{ id: entry.id, model: result.data }] : [];
        });
      }));
      const merged = new Map<string, CatalogEntry>();
      for (const entries of catalogs) for (const entry of entries) merged.set(entry.id, entry);
      this.entries = [...merged.values()];
      this.signature = signature;
    }

    const identity = modelIdentity(current);
    let selected: CatalogEntry | undefined;
    if (this.boundId && this.boundIdentity === identity) {
      selected = this.entries.find((entry) => entry.id === this.boundId);
      // Removing a configured entry must not silently select another account.
      if (!selected) return undefined;
    } else {
      const candidates = this.entries.filter((entry) => entry.model.provider === current.provider && entry.model.model === current.model);
      const exact = candidates.filter((entry) => modelIdentity(entry.model) === identity);
      // Never infer account/endpoint ownership from a model name. Hand-written
      // session and secondary-model overrides may use the same provider/model.
      selected = exact.length === 1 ? exact[0] : undefined;
    }
    if (!selected) {
      this.boundId = undefined;
      this.boundIdentity = undefined;
      this.boundEntry = undefined;
      return undefined;
    }
    const previous = this.boundId === selected.id && this.boundIdentity === identity ? this.boundEntry : undefined;
    this.boundId = selected.id;
    this.boundEntry = selected.model;
    this.boundIdentity = identity;
    // Binding is observational. It must not erase explicit per-session limits
    // or capabilities before the user has actually edited this catalog entry.
    if (!previous) return undefined;
    const next = { ...current };
    const fields = new Set([...Object.keys(previous), ...Object.keys(selected.model)]);
    for (const field of fields) {
      const key = field as keyof ModelConfig;
      if (key === "reasoningEffort" || JSON.stringify(previous[key]) === JSON.stringify(selected.model[key])) continue;
      if (selected.model[key] === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = selected.model[key];
    }
    this.boundIdentity = modelIdentity(next);
    return JSON.stringify(modelConfigSchema.parse(current)) === JSON.stringify(modelConfigSchema.parse(next)) ? undefined : next;
  }
}

function modelIdentity(model: ModelConfig): string {
  return JSON.stringify([model.provider, model.model, model.baseUrl, model.apiKey, model.authMode, model.headers]);
}
