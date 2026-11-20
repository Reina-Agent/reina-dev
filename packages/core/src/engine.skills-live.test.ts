import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as providers from "@reina/providers";
import { AgentEngine } from "./engine.js";

let cwd: string;
const engines: AgentEngine[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-skills-live-"));
  vi.stubEnv("REINA_CONFIG_HOME", path.join(cwd, "home-config"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(cwd, "home"));
  await writeFile(path.join(cwd, "README.md"), "test workspace", "utf8");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

async function writeSkill(name: string, description: string, extra = ""): Promise<string> {
  const dir = path.join(cwd, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${description}\n`, "utf8");
  return file;
}

describe("live skill discovery", () => {
  it("invalidates instructions loaded by read_skill after their body is edited", async () => {
    const file = await writeSkill("live-body", "follow the current procedure");
    const originalMtime = (await stat(file)).mtimeMs;
    const engine = new AgentEngine({ cwd, agent: "default" });
    engines.push(engine);
    let requests = 0;
    vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request) => {
      requests += 1;
      if (requests === 1) {
        return { toolCalls: [{ id: "skill", name: "read_skill", input: { name: "live-body" }, summary: "Load skill" }] };
      }
      if (requests === 2) {
        expect(request.observations[0]?.output).toContain("follow the current procedure");
        expect(engine.session.readFileTimestamps?.[file]).toBe(originalMtime);
        await writeFile(file, "---\nname: live-body\ndescription: follow the current procedure\n---\nUpdated body, same metadata.\n", "utf8");
        await utimes(file, new Date(), new Date(originalMtime + 2000));
        return { toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" }, summary: "Read workspace" }] };
      }
      expect(request.messages.some((message) => message.content.includes("These skill files changed or were removed"))).toBe(true);
      return { content: "done", toolCalls: [] };
    });

    await engine.runTurn("Load the procedure");
    expect(requests).toBe(3);
  });

  it.each([false, true])("refreshes an existing engine at the next request without interrupting its active stream (subagent: %s)", async (isSubagent) => {
    const edited = await writeSkill("live-edit", "original procedure");
    const removed = await writeSkill("live-remove", "obsolete procedure");
    await writeSkill("live-manual", "initially model visible");
    const engine = new AgentEngine({ cwd, agent: "default", isSubagent });
    engines.push(engine);
    const editedMtime = (await stat(edited)).mtimeMs;
    engine.session.readFileTimestamps = {
      [edited]: editedMtime,
      [removed]: (await stat(removed)).mtimeMs,
    };

    const prompts: string[] = [];
    const model = vi.spyOn(providers, "nextModelTurnStream").mockImplementation(async (_model, request, onEvent, signal) => {
      prompts.push(request.systemPrompt);
      if (prompts.length > 1) return { content: "done", toolCalls: [] };
      onEvent?.({ type: "text-delta", text: "Working" });
      // Saving while the first stream is in flight must not mutate its
      // request or abort it. The next tool-loop request adopts the edits.
      await writeSkill("live-edit", "updated procedure");
      await utimes(edited, new Date(), new Date(editedMtime + 2000));
      await writeSkill("live-added", "newly installed procedure");
      await writeSkill("live-manual", "manual procedure", "disable-model-invocation: true\n");
      await rm(removed);
      expect(signal?.aborted).not.toBe(true);
      expect(request.systemPrompt).toContain("original procedure");
      expect(request.systemPrompt).not.toContain("newly installed procedure");
      expect(engine.session.skills.find((skill) => skill.name === "live-edit")?.description).toBe("original procedure");
      return {
        toolCalls: [{ id: "read", name: "read_file", input: { path: "README.md" }, summary: "Read workspace" }],
      };
    });

    await engine.runTurn("Read the workspace and follow applicable skills");

    expect(model).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("updated procedure");
    expect(prompts[1]).toContain("newly installed procedure");
    expect(prompts[1]).not.toContain("obsolete procedure");
    expect(prompts[1]).not.toContain("manual procedure");
    expect(engine.session.skills.find((skill) => skill.name === "live-manual")?.disableModelInvocation).toBe(true);
    const stale = engine.session.messages.filter((message) => message.content.includes("These skill files changed or were removed"));
    expect(stale).toHaveLength(1);
    expect(stale[0]?.content).toContain("live-edit");
    expect(stale[0]?.content).toContain("live-remove");
    expect(engine.session.readFileTimestamps?.[removed]).toBeUndefined();

    await engine.runTurn("Continue");
    expect(engine.session.messages.filter((message) => message.content.includes("These skill files changed or were removed"))).toHaveLength(1);
  });
});
