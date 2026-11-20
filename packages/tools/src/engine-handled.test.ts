import type { ToolName } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { engineHandledToolNames } from "./engine-handled.js";
import { toolRegistry } from "./registry.js";
import type { ToolRuntimeOptions } from "./types.js";

// These tests lock the engine-handled stub set to reality so the engine's
// fallback-dispatch guard (engine.ts:executeToolOrEngine default branch) can
// trust `engineHandledToolNames()`. Importing the registry loads every tool
// module, which is what populates the set.
describe("engine-handled tools", () => {
  it("registers exactly the known engine-handled stubs (bump when adding one)", () => {
    // 19 agent-state (+ get_async_tasks / send_task_message / start_task_batch / check_task_batch)
    // + 1 exit-plan-mode + 6 notes + 3 Goal + 5 team = 34.
    expect(engineHandledToolNames().size).toBe(34);
  });

  it("every engine-handled name is a registered tool whose execute returns its sentinel", async () => {
    const ctx = { cwd: process.cwd() } as ToolRuntimeOptions;
    for (const name of engineHandledToolNames()) {
      const tool = toolRegistry.get(name as ToolName);
      expect(tool, `"${name}" is in the engine-handled set but is not a registered tool`).toBeDefined();
      // Stubs ignore their arguments and have no side effects, so calling
      // execute() here is safe and confirms the sentinel the engine guards on.
      const out = await tool!.execute(undefined, ctx);
      expect(out).toBe(`${name} is handled by AgentEngine.`);
    }
  });
});
