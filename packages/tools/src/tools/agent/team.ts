import { z } from "zod";
import { engineHandledExecute } from "../../engine-handled.js";
import type { ToolImplementation } from "../../types.js";
import { description as createSubtaskDescription } from "../../prompts/create-subtask.js";
import { description as updateSubtaskDescription } from "../../prompts/update-subtask.js";
import { description as getDagDescription } from "../../prompts/get-dag.js";
import { description as setPhaseDescription } from "../../prompts/set-phase.js";
import { description as sendToWorkerDescription } from "../../prompts/send-to-worker.js";

/**
 * Team-mode coordinator tools (Phase C).
 *
 * These tools are no-op at the runtime layer — their `execute()` returns a
 * sentinel string. The AgentEngine intercepts them in its tool dispatch
 * switch and routes them to engine-side methods (createSubtask,
 * updateSubtask, etc.) so the tool can mutate engine state directly.
 * This mirrors how `note` / `plan` / `write_todos` are dispatched.
 *
 * Exposure: all five are tagged `permission: "state"` and are deferred by
 * default. `/team`, `search_tool`, or direct tool use can unmask them for
 * the current top-level session. Profiles can deny them via toolPermissions.
 */

const SubtaskStatus = z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "blocked"]);
const TeamPhaseEnum = z.enum(["plan", "prd", "exec", "verify", "fix", "complete", "failed"]);

export const createSubtaskTool: ToolImplementation = {
  descriptor: {
    name: "create_subtask",
    description: createSubtaskDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      description: z.string().min(1),
      owner: z.string().optional(),
      blockedBy: z.array(z.string().min(1)).optional(),
      phase: TeamPhaseEnum.optional(),
      tags: z.array(z.string().min(1)).optional(),
    }),
  },
  execute: engineHandledExecute("create_subtask"),
};

export const updateSubtaskTool: ToolImplementation = {
  descriptor: {
    name: "update_subtask",
    description: updateSubtaskDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      id: z.string().min(1).describe("Subtask id (sub_<short>)."),
      title: z.string().min(1).max(200).optional(),
      description: z.string().min(1).optional(),
      owner: z.string().optional(),
      status: SubtaskStatus.optional(),
      addBlockedBy: z.array(z.string().min(1)).optional(),
      removeBlockedBy: z.array(z.string().min(1)).optional(),
      bindAsyncTaskId: z.string().min(1).optional(),
      phase: TeamPhaseEnum.optional(),
      tags: z.array(z.string().min(1)).optional(),
      resultSummary: z.string().optional(),
    }),
  },
  execute: engineHandledExecute("update_subtask"),
};

export const getDagTool: ToolImplementation = {
  descriptor: {
    name: "get_dag",
    description: getDagDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({
      /** Optional owner filter for the `ready` derived list. The full
       * node list is always returned regardless. */
      owner: z.string().optional(),
    }),
  },
  execute: engineHandledExecute("get_dag"),
};

export const setPhaseTool: ToolImplementation = {
  descriptor: {
    name: "set_phase",
    description: setPhaseDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      phase: TeamPhaseEnum.nullable().optional(),
    }),
  },
  execute: engineHandledExecute("set_phase"),
};

export const sendToWorkerTool: ToolImplementation = {
  descriptor: {
    name: "send_to_worker",
    description: sendToWorkerDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      recipient: z.string().min(1),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
      subtaskId: z.string().min(1).optional(),
    }),
  },
  execute: engineHandledExecute("send_to_worker"),
};

export const teamCoordinatorTools: ToolImplementation[] = [
  createSubtaskTool,
  updateSubtaskTool,
  getDagTool,
  setPhaseTool,
  sendToWorkerTool,
];
