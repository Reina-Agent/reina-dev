import { z } from "zod";
import { engineHandledExecute } from "../../engine-handled.js";
import type { ToolImplementation } from "../../types.js";

const getGoalTool: ToolImplementation = {
  descriptor: {
    name: "get_goal",
    description: "Read the current host-owned Goal, its state revision, completion criterion, usage, budget and verification state. Use this before updating a Goal when your snapshot may be stale.",
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    inputSchema: z.object({}),
  },
  execute: engineHandledExecute("get_goal"),
};

const createGoalTool: ToolImplementation = {
  descriptor: {
    name: "create_goal",
    description: "Create a Goal only when the user explicitly asked to start one and no unfinished Goal exists. `/goal` is created directly by the host before the first model request, so never call this merely because a Goal appears in context. Repeated creation of the current Goal is unnecessary.",
    permission: "state",
    requiresApproval: true,
    exposure: "deferred",
    inputSchema: z.object({
      objective: z.string().min(1).max(4000).describe("The user's concrete objective."),
      completionCriterion: z.string().min(1).max(4000).optional().describe("Optional explicit evidence-based completion criterion."),
      tokenBudget: z.number().int().positive().optional().describe("Set only when the user explicitly requested a token budget."),
      turnBudget: z.number().int().positive().optional().describe("Set only when the user explicitly requested a turn budget."),
      wallClockBudgetMs: z.number().int().positive().optional().describe("Set only when the user explicitly requested a wall-clock budget."),
      expectedRevision: z.number().int().nonnegative().optional().describe("Goal-state revision from get_goal; stale revisions are rejected."),
    }),
  },
  execute: engineHandledExecute("create_goal"),
};

const updateGoalTool: ToolImplementation = {
  descriptor: {
    name: "update_goal",
    description: "Submit a completion claim with concrete evidence, or report a genuine blocker. Completion is not final until the independent verifier accepts it. Pause, resume, edit, replace and clear are user-only operations.",
    permission: "state",
    requiresApproval: false,
    exposure: "deferred",
    inputSchema: z.object({
      goalId: z.string().min(1).optional().describe("Current Goal id. Defaults to the current Goal."),
      status: z.enum(["complete", "blocked"]).describe("Use complete only with concrete evidence; use blocked only for a genuine repeated blocker."),
      evidence: z.string().min(1).optional().describe("Concrete proof required for status=complete."),
      reason: z.string().min(1).optional().describe("Specific repeated blocker required for status=blocked."),
      expectedRevision: z.number().int().nonnegative().optional().describe("Goal-state revision from get_goal; stale revisions are rejected."),
    }),
  },
  execute: engineHandledExecute("update_goal"),
};

export const sessionGoalTools: ToolImplementation[] = [
  getGoalTool,
  createGoalTool,
  updateGoalTool,
];
