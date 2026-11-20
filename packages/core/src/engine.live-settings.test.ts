import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as providers from "@reina/providers";
import type { ReinaConfig } from "@reina/protocol";
import { AgentEngine } from "./engine.js";
import * as hooks from "./hooks.js";

let cwd: string;
let configFile: string;
const engines: AgentEngine[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-live-settings-"));
  const home = path.join(cwd, "home");
  vi.stubEnv("REINA_CONFIG_HOME", home);
  vi.stubEnv("REINA_HOME", home);
  await mkdir(home);
  configFile = path.join(home, "config.json");
  await writeFile(path.join(cwd, "README.md"), "workspace", "utf8");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

async function save(config: ReinaConfig, file = configFile): Promise<void> {
  await writeFile(file, JSON.stringify(config), "utf8");
}

async function create(input: Parameters<typeof AgentEngine.create>[0] = {}): Promise<AgentEngine> {
  const engine = await AgentEngine.create({ cwd, ...input });
  engines.push(engine);
  return engine;
}

describe("live runtime settings", () => {
  it("does not confuse missing fields in an existing config with changed defaults", async () => {
    await save({});
    const engine = await create({
      autoTitle: { enabled: false },
      toolLoop: { hardMaxSteps: 5 },
      subagent: { forkEnabled: false },
      selfEvolve: { enabled: true, everyTurns: 20 },
    });
    await engine.refreshRuntimeConfig();
    const runtime = engine as unknown as Record<string, unknown>;
    expect(runtime.toolLoopConfig).toEqual({ hardMaxSteps: 5 });
    expect(runtime.forkEnabledFlag).toBe(false);
    expect(runtime.selfEvolveConfig).toEqual({ enabled: true, everyTurns: 20 });
    const model = vi.spyOn(providers, "nextModelTurnStream");
    engine.setModel({ provider: "openai-chat", model: "title-test" });
    engine.session.messages = [
      { id: "user", role: "user", content: "hello", createdAt: new Date().toISOString() },
      { id: "assistant", role: "assistant", content: "hello", createdAt: new Date().toISOString() },
    ];
    await engine.generateAutoTitle();
    expect(model).not.toHaveBeenCalled();
  });

  it("refreshes a custom agent's prompt and tool permissions within the active turn", async () => {
    const agentFile = path.join(path.dirname(configFile), "agents.json");
    const agent = { name: "live-agent", description: "Live agent", mode: "all", prompt: "Initial agent instructions", tools: ["read_file"] };
    await writeFile(agentFile, JSON.stringify([agent]), "utf8");
    const before = (await stat(agentFile)).mtimeMs;
    const engine = await create({ agent: "live-agent" });
    const requests: Array<{ prompt: string; tools: string[] }> = [];
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests.push({ prompt: request.systemPrompt, tools: request.tools.map((tool) => tool.name) });
      if (requests.length > 1) return { content: "done", toolCalls: [] };
      await writeFile(agentFile, JSON.stringify([{ ...agent, prompt: "Updated agent instructions", tools: ["read_file", "write_file"] }]), "utf8");
      await utimes(agentFile, new Date(), new Date(before + 2000));
      return { toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" }, summary: "Read" }] };
    });

    await engine.runTurn("Read the workspace");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.prompt).toContain("Initial agent instructions");
    expect(requests[0]?.tools).not.toContain("write_file");
    expect(requests[1]?.prompt).toContain("Updated agent instructions");
    expect(requests[1]?.tools).toContain("write_file");
  });

  it("adopts settings saved during a stream before its next tool and model request", async () => {
    await save({ autoTitle: { enabled: true }, subagent: { forkEnabled: true } });
    const engine = await create({ model: { provider: "deterministic", model: "chosen-session-model" } });
    const runHooks = vi.spyOn(hooks, "runHooks").mockImplementation(async (config, event) =>
      event === "preToolUse" && config?.preToolUse?.length ? { block: true, message: "live hook" } : {},
    );
    const newSettings: ReinaConfig = {
      hooks: { preToolUse: [{ command: "exit 2" }] },
      autoTitle: { enabled: false },
      compactionModel: { model: "summary-after-save" },
      goal: { verify: { enabled: false }, maxContinuationRounds: 7 },
      selfEvolve: { enabled: false, everyTurns: 12 },
      memory: { dream: false },
      subagent: { forkEnabled: false, secondaryModel: { model: "worker-after-save" } },
      toolLoop: { consecutiveErrorLimit: 9 },
      permissionMode: "bypass",
      model: { provider: "deterministic", model: "other-default" },
    };
    let requests = 0;
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (model, _request, _onEvent, signal) => {
      expect(model.model).toBe("chosen-session-model");
      requests++;
      if (requests === 1) {
        await save(newSettings);
        expect(signal?.aborted).not.toBe(true);
        expect(engine.session.permissionMode).toBe("default");
        return { toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" }, summary: "Read" }] };
      }
      expect(engine.session.permissionMode).toBe("bypass");
      return { content: "done", toolCalls: [] };
    });

    await engine.runTurn("Read the workspace");

    expect(requests).toBe(2);
    expect(engine.session.toolCalls[0]?.status).toBe("rejected");
    expect(runHooks).toHaveBeenCalledWith(newSettings.hooks, "preToolUse", expect.anything());
    const runtime = engine as unknown as Record<string, unknown>;
    expect(runtime.compactionModel).toEqual(newSettings.compactionModel);
    expect(runtime.goalConfig).toEqual(newSettings.goal);
    expect(runtime.selfEvolveConfig).toEqual(newSettings.selfEvolve);
    expect(runtime.memoryDreamConfig).toEqual(newSettings.memory);
    expect(runtime.forkEnabledFlag).toBe(false);
    expect(runtime.subagentSecondaryModel).toEqual(newSettings.subagent?.secondaryModel);
    expect(runtime.toolLoopConfig).toEqual(newSettings.toolLoop);
    const modelCalls = requests;
    await engine.generateAutoTitle();
    expect(requests).toBe(modelCalls);
  });

  it("preserves explicit overrides until that setting changes, respects workspace scope, and clears removed overrides", async () => {
    await save({ compactionModel: { model: "global" }, permissionMode: "default" });
    const workspaceFile = path.join(cwd, ".reina", "config.json");
    await mkdir(path.dirname(workspaceFile), { recursive: true });
    await save({ compactionModel: { model: "workspace" } }, workspaceFile);
    const engine = await create({ compactionModel: { model: "explicit" }, permissionMode: "bypass" });
    const runtime = engine as unknown as { compactionModel?: { model?: string } };

    await save({ compactionModel: { model: "new-global" }, permissionMode: "default", hooks: {} });
    await engine.compactNow("manual");
    expect(runtime.compactionModel?.model).toBe("explicit");
    expect(engine.session.permissionMode).toBe("bypass");
    await save({}, workspaceFile);
    await engine.compactNow("manual");
    expect(runtime.compactionModel?.model).toBe("new-global");
    await save({});
    await engine.compactNow("manual");
    expect(runtime.compactionModel).toBeUndefined();
  });

  it("retains the last valid settings through an incomplete file write", async () => {
    await save({ compactionModel: { model: "before" } });
    const engine = await create();
    await writeFile(configFile, '{"compactionModel":');
    await engine.compactNow("manual");
    const runtime = engine as unknown as { compactionModel?: { model?: string } };
    expect(runtime.compactionModel?.model).toBe("before");
    await save({ compactionModel: { model: "after" } });
    await engine.compactNow("manual");
    expect(runtime.compactionModel?.model).toBe("after");
  });

  it("passes current runtime settings to new children and refreshes existing children", async () => {
    await save({ compactionModel: { model: "first" }, hooks: { preToolUse: [{ command: "first" }] } });
    const parent = await create();
    const internal = parent as unknown as { spawnChildEngine(input: { cwd: string; agent: string }): AgentEngine };
    const child = internal.spawnChildEngine({ cwd, agent: "default" });
    engines.push(child);
    const runtime = child as unknown as { compactionModel?: { model?: string }; hooksConfig?: ReinaConfig["hooks"] };
    expect(runtime.compactionModel?.model).toBe("first");
    await save({ compactionModel: { model: "second" }, hooks: {} });
    await child.compactNow("manual");
    expect(runtime.compactionModel?.model).toBe("second");
    expect(runtime.hooksConfig).toEqual({});
  });
});
