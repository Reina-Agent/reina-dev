import type { ToolDescriptor, ToolName } from "@reina/protocol";
import {
  cancelAsyncTaskTool,
  checkAsyncTaskTool,
  checkTaskBatchTool,
  consolidateMemoryTool,
  gatherAsyncTasksTool,
  getAsyncTasksTool,
  listAsyncTasksTool,
  listMemoryChunksTool,
  planTool,
  questionTool,
  recallMemoryChunkTool,
  searchMemoryTool,
  sendTaskMessageTool,
  startAsyncTaskTool,
  startTaskBatchTool,
  taskTool,
  updateAsyncTaskTool,
  waitAsyncTasksTool,
  writeTodosTool,
} from "./tools/agent/agent-state.js";
import { exitPlanModeTool } from "./tools/agent/exit-plan-mode.js";
import { notifyTool } from "./tools/agent/notify.js";
import { scheduleWakeupTool } from "./tools/agent/schedule-wakeup.js";
import { searchToolTool, setDeferredCatalogProvider } from "./tools/agent/search-tool.js";
import { sessionGoalTools } from "./tools/agent/goals.js";
import { teamCoordinatorTools } from "./tools/agent/team.js";
import { killShellTool, monitorTool, taskOutputTool, writeStdinTool } from "./tools/execution/background-shell.js";
import { shellTool } from "./tools/execution/shell.js";
import { applyPatchTool } from "./tools/files/apply-patch.js";
import { editFileTool } from "./tools/files/edit-file.js";
import { globTool } from "./tools/files/glob.js";
import { grepTool } from "./tools/files/grep.js";
import { multiEditTool } from "./tools/files/multi-edit.js";
import { readFileTool } from "./tools/files/read-file.js";
import { writeFileTool } from "./tools/files/write-file.js";
import { listSkillsTool } from "./tools/knowledge/list-skills.js";
import { readSkillTool } from "./tools/knowledge/read-skill.js";
import { mcpListResourcesTool, mcpReadResourceTool, mcpStatusTool } from "./tools/mcp/mcp.js";
import { kimiWebFetchTool, kimiWebSearchTool } from "./tools/network/kimi-web.js";
import { webFetchTool } from "./tools/network/web-fetch.js";
import {
  declareAuditDoneTool,
  deleteNoteTool,
  noteTool,
  readNoteTool,
  listNotesTool,
  updateNoteTool,
} from "./tools/notes/notes.js";
import { findJavaChainsTool, searchJavaGadgetsTool } from "./tools/security/java-chains.js";
import { summarizeToolSchema } from "./schema-summary.js";
import type { ToolImplementation } from "./types.js";

export const toolImplementations: ToolImplementation[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  grepTool,
  globTool,
  shellTool,
  taskOutputTool,
  killShellTool,
  monitorTool,
  writeStdinTool,
  applyPatchTool,
  writeTodosTool,
  questionTool,
  planTool,
  exitPlanModeTool,
  taskTool,
  recallMemoryChunkTool,
  listMemoryChunksTool,
  searchMemoryTool,
  consolidateMemoryTool,
  listSkillsTool,
  readSkillTool,
  searchToolTool,
  webFetchTool,
  kimiWebSearchTool,
  kimiWebFetchTool,
  mcpListResourcesTool,
  mcpReadResourceTool,
  mcpStatusTool,
  notifyTool,
  scheduleWakeupTool,
  startAsyncTaskTool,
  checkAsyncTaskTool,
  cancelAsyncTaskTool,
  updateAsyncTaskTool,
  listAsyncTasksTool,
  gatherAsyncTasksTool,
  getAsyncTasksTool,
  waitAsyncTasksTool,
  sendTaskMessageTool,
  startTaskBatchTool,
  checkTaskBatchTool,
  noteTool,
  listNotesTool,
  readNoteTool,
  updateNoteTool,
  deleteNoteTool,
  declareAuditDoneTool,
  searchJavaGadgetsTool,
  findJavaChainsTool,
  ...teamCoordinatorTools,
  ...sessionGoalTools,
];

export const toolRegistry = new Map<ToolName, ToolImplementation>(
  toolImplementations.map((tool) => [tool.descriptor.name, tool]),
);

export const toolDescriptors = toolImplementations.map((tool) => tool.descriptor);
export const publicToolDescriptors = toolImplementations
  .map((tool) => tool.descriptor)
  .filter((tool) => !tool.internal);

const defaultDeferredToolNames = new Set<ToolName>([
  "apply_patch",
  "task",
  "get_async_tasks",
  "wait_async_tasks",
  // Keep notebook discovery/read operations direct, but defer mutations in
  // ordinary sessions. list_notes + read_note keep the memory surface visible;
  // note + update_note + delete_note remain discoverable through search_tool
  // and are explicitly promoted by the self-review / memory-consolidate
  // profiles. Their current schemas cost ~1.2k tokens on every default request,
  // even when the task never writes memory.
  "note",
  "update_note",
  "delete_note",
  "declare_audit_done",
  "create_subtask",
  "update_subtask",
  "get_dag",
  "set_phase",
  "send_to_worker",
  "get_goal",
  "create_goal",
  "update_goal",
  // Java gadget-chain audit kit. Deferred so the general-purpose agent's
  // cold-start array stays lean — these two only matter for security /
  // deserialization audits. Discoverable via search_tool + the hidden-tools
  // roster; the user's on-demand `security-audit` skill drives them.
  "find_java_chains",
  "search_java_gadgets",
]);

function isDeferredByDefault(tool: ToolDescriptor): boolean {
  return tool.exposure === "deferred" || defaultDeferredToolNames.has(tool.name);
}

/** Descriptors for every deferred tool — used by the engine to render the
 * system-prompt "Discoverable tools" catalog and to unmask tools by name
 * when the model calls a deferred tool whose definition was matched by
 * `search_tool`. */
export const deferredToolDescriptors: ToolDescriptor[] = publicToolDescriptors.filter((tool) =>
  isDeferredByDefault(tool),
);

/** Cold-start descriptors. Discovered tools and profile/mode promotions
 * are added per session without changing this shared array. */
export const directToolDescriptors: ToolDescriptor[] = publicToolDescriptors.filter(
  (tool) => !isDeferredByDefault(tool),
);

/** Wire the deferred-tools catalog into `search_tool`. Lazy provider so
 * search-tool.ts has zero imports from registry.ts (avoids a cycle —
 * registry imports search_tool, search_tool would otherwise import back). */
setDeferredCatalogProvider(() =>
  deferredToolDescriptors.map((tool) => ({
    name: tool.name,
    summary: tool.catalogSummary ?? firstSentence(tool.description),
    params: summarizeToolSchema(tool),
    examples: tool.examples,
  })),
);

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const newlineCut = trimmed.indexOf("\n");
  const candidate = newlineCut === -1 ? trimmed : trimmed.slice(0, newlineCut);
  if (candidate.length <= 120) return candidate;
  return candidate.slice(0, 117) + "...";
}

/** Send full definitions only for direct or discovered tools. Discovery can
 * change the cached prefix once; an unchanged active set has stable ordering. */
export function resolveExposedTools(activeDeferred?: ReadonlyArray<string>): ToolDescriptor[] {
  if (!activeDeferred?.length) return directToolDescriptors;
  const active = new Set(activeDeferred);
  const discovered = deferredToolDescriptors
    .filter((tool) => active.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...directToolDescriptors, ...discovered];
}
