import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelConfig, PermissionMode } from "@reina/protocol";

export type DesktopPromptInputConfig = {
  historyLimit: number;
  enterToSend: boolean;
  enableSlashCommands: boolean;
  enableFileMentions: boolean;
};

export type DesktopPromptConfig = {
  id: string;
  title: string;
  description?: string;
  template: string;
  agent?: string;
  permissionMode?: PermissionMode;
  model?: Partial<ModelConfig>;
};

export type DesktopRuntimeConfig = {
  configPath: string;
  promptInput: DesktopPromptInputConfig;
  prompts: DesktopPromptConfig[];
  errors: string[];
};

export const defaultPromptInputConfig: DesktopPromptInputConfig = {
  historyLimit: 100,
  enterToSend: true,
  enableSlashCommands: true,
  enableFileMentions: true,
};

export const builtinPrompts: DesktopPromptConfig[] = [
  {
    id: "review",
    title: "Review current changes",
    description: "Review git changes and report risks first.",
    template: "Review the current git changes. Prioritize bugs, regressions, and missing tests. Keep the summary brief.",
    permissionMode: "plan",
  },
  {
    id: "explain",
    title: "Explain current project",
    description: "Summarize the project structure and important code paths.",
    template: "Explain the current project structure and the main code paths I should understand before making changes.",
  },
  {
    id: "fix",
    title: "Fix the current problem",
    description: "Investigate, patch, and verify a bug or failure.",
    template: "Investigate the current problem, make the smallest safe fix, and verify it with the relevant checks.",
  },
  {
    id: "test",
    title: "Add or run tests",
    description: "Find relevant tests, run them, and add focused coverage if needed.",
    template: "Find the relevant tests for the current change, run them, and add focused coverage if a behavior gap exists.",
  },
];

export async function readDesktopRuntimeConfig(cwd: string): Promise<DesktopRuntimeConfig> {
  const configPath = path.join(path.resolve(cwd), ".reina", "desktop.json");
  const errors: string[] = [];
  let raw: unknown = {};

  try {
    // trim() also strips a leading UTF-8 BOM (U+FEFF) — PowerShell-edited
    // files carry one, and JSON.parse rejects it.
    raw = JSON.parse((await readFile(configPath, "utf8")).trim()) as unknown;
  } catch (error) {
    if (!isMissingFileError(error)) errors.push(error instanceof Error ? error.message : String(error));
  }

  const parsed = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) errors.push("desktop.json must contain a JSON object.");

  const promptInput = parsePromptInput(parsed.promptInput, errors);
  const prompts = mergePrompts(builtinPrompts, parsePrompts(parsed.prompts, errors));
  return { configPath, promptInput, prompts, errors };
}

function parsePromptInput(input: unknown, errors: string[]): DesktopPromptInputConfig {
  if (input === undefined) return { ...defaultPromptInputConfig };
  if (!isRecord(input)) {
    errors.push("promptInput must be an object.");
    return { ...defaultPromptInputConfig };
  }

  return {
    historyLimit: numberOrDefault(input.historyLimit, defaultPromptInputConfig.historyLimit, 1, 1000),
    enterToSend: booleanOrDefault(input.enterToSend, defaultPromptInputConfig.enterToSend),
    enableSlashCommands: booleanOrDefault(input.enableSlashCommands, defaultPromptInputConfig.enableSlashCommands),
    enableFileMentions: booleanOrDefault(input.enableFileMentions, defaultPromptInputConfig.enableFileMentions),
  };
}

function parsePrompts(input: unknown, errors: string[]): DesktopPromptConfig[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    errors.push("prompts must be an array.");
    return [];
  }

  const prompts: DesktopPromptConfig[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      errors.push("prompt entries must be objects.");
      continue;
    }
    const id = stringValue(item.id);
    const title = stringValue(item.title);
    const template = stringValue(item.template);
    if (!id || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
      errors.push("prompt id must start with a letter and contain only letters, numbers, hyphen, or underscore.");
      continue;
    }
    if (!title || !template) {
      errors.push(`prompt ${id} requires title and template.`);
      continue;
    }
    prompts.push({
      id,
      title,
      description: stringValue(item.description),
      template,
      agent: stringValue(item.agent),
      permissionMode: permissionModeValue(item.permissionMode),
      model: isRecord(item.model) ? (item.model as Partial<ModelConfig>) : undefined,
    });
  }
  return prompts;
}

function mergePrompts(base: DesktopPromptConfig[], overrides: DesktopPromptConfig[]): DesktopPromptConfig[] {
  const byId = new Map<string, DesktopPromptConfig>();
  for (const prompt of base) byId.set(prompt.id, prompt);
  for (const prompt of overrides) byId.set(prompt.id, prompt);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function permissionModeValue(value: unknown): PermissionMode | undefined {
  return value === "plan" || value === "default" || value === "accept-edits" || value === "bypass" ? value : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
