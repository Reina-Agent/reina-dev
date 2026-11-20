import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBackgroundShellTasks, runTool, stopBackgroundShellTask } from "@reina/tools";
import { AgentEngine } from "./engine.js";

const lifecycle = ["task_output", "kill_shell", "monitor", "write_stdin"];
const engines: AgentEngine[] = [];
let cwd: string;
let oldConfigHome: string | undefined;
let taskId: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-background-tools-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  taskId = undefined;
});

afterEach(async () => {
  if (taskId && listBackgroundShellTasks().some((task) => task.id === taskId && task.status === "running")) {
    await stopBackgroundShellTask(cwd, taskId);
  }
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("background tool session scope", () => {
  it("retains lifecycle tools only for the session owning the real background shell", async () => {
    const owner = new AgentEngine({ cwd, agent: "default" });
    const other = new AgentEngine({ cwd, agent: "default" });
    engines.push(owner, other);
    const coldNames = (await other.availableTools()).map((tool) => tool.name);
    for (const name of lifecycle) expect(coldNames).not.toContain(name);
    await writeFile(
      path.join(cwd, "background-tool-cache.cjs"),
      "console.log('cache-test-ready'); process.stdin.resume(); process.stdin.once('data', () => process.exit(0));",
      "utf8",
    );
    const started = await runTool(
      "run_shell",
      { command: "node background-tool-cache.cjs", runInBackground: true, timeoutMs: 15000 },
      { cwd, sessionId: owner.session.id },
    );
    expect(started.error).toBeUndefined();
    taskId = started.output?.match(/"taskId":\s*"(shell_[^"]+)"/)?.[1];
    expect(taskId).toBeDefined();
    const ready = await runTool("monitor", { taskId, pattern: "cache-test-ready", timeoutMs: 5000 }, { cwd });
    expect(ready.error).toBeUndefined();
    expect(ready.output).toContain("<reason>matched</reason>");
    expect(listBackgroundShellTasks().find((task) => task.id === taskId)?.status).toBe("running");

    const warm = await owner.availableTools();
    for (const name of lifecycle) expect(warm.map((tool) => tool.name)).toContain(name);
    expect((await other.availableTools()).map((tool) => tool.name)).toEqual(coldNames);
    for (const name of lifecycle) expect(other.session.activeDeferredTools ?? []).not.toContain(name);

    const input = await runTool("write_stdin", { taskId, data: "done" }, { cwd });
    expect(input.error).toBeUndefined();
    const completed = await runTool("task_output", { taskId, block: true, timeoutMs: 5000 }, { cwd });
    expect(completed.error).toBeUndefined();
    expect(listBackgroundShellTasks().find((task) => task.id === taskId)?.status).toBe("completed");
    expect(await owner.availableTools()).toEqual(warm);
    expect((await other.availableTools()).map((tool) => tool.name)).toEqual(coldNames);
    for (const name of lifecycle) expect(owner.session.activeDeferredTools).toContain(name);
  });
});
