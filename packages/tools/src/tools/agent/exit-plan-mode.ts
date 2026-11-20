import { z } from "zod";
import { engineHandledExecute } from "../../engine-handled.js";
import type { ToolImplementation } from "../../types.js";
import { description } from "../../prompts/exit-plan-mode.js";

/** The actual `exit_plan_mode` execution happens inside AgentEngine — the
 * tool needs to flip session.plan, create a HITL question with two predefined
 * options, and pause the run loop until the user picks one. That can't be
 * done from inside `runTool` because runTool has no access to the engine's
 * mutable session. The descriptor lives here so the registry knows the tool
 * exists, but execute() just emits a sentinel that the engine swaps out. */
export const exitPlanModeTool: ToolImplementation = {
  descriptor: {
    name: "exit_plan_mode",
    description,
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    catalogSummary: "Submit the current plan for user approval and exit plan mode (plan-mode only).",
    inputSchema: z.object({
      plan: z
        .string()
        .min(1)
        .describe("The final plan, as markdown. Will be shown to the user inside an approval card."),
    }),
  },
  execute: engineHandledExecute("exit_plan_mode"),
};
