import type { ModelStreamEvent, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { engineHandledToolNames, isMcpRuntimeTool, runMcpRuntimeTool, runTool, toolRegistry } from "@reina/tools";
import { BLOCKED_FOR_SUBAGENT, type SubagentManager } from "./subagent/index.js";
import { SIDE_CHAT_TOOL_DENIED } from "./side-chat.js";
import { resolveProfile } from "./profiles.js";
import type { HostBridge } from "./engine.js";
import type { TodosController } from "./controllers/todos.js";
import type { GoalService } from "./goal/service.js";
import type { SubmitResponseController } from "./controllers/submit-response.js";
import type { MemoryController } from "./controllers/memory.js";
import type { PlanController } from "./controllers/plan.js";
import type { AuditController } from "./controllers/audit.js";
import type { QuestionController } from "./controllers/question.js";
import type { NotesController } from "./controllers/notes.js";
import type { SubtaskController } from "./controllers/subtask.js";

/** Minimal host surface the tool dispatcher needs from AgentEngine. Mirrors
 * the controller-host contracts (TodosHost etc.): only the capabilities the
 * dispatch fallback actually uses, so the registry can be unit-tested with a
 * stub host and the engine dependencies stay documented.
 *
 * `session` and `signal` MUST be getter-backed at the wiring site:
 * loadSession/rollbackToMessage replace `this.session` with a fresh object,
 * and interrupt() swaps `this.abortController` — a value captured at
 * construction would silently strand dispatch on a dead reference (stale cwd
 * / readFileTimestamps, or an abort signal that never fires after the first
 * interrupt). */
export interface ToolDispatchHost {
  readonly session: SessionState;
  /** Live abort signal — read lazily per call, never captured. */
  readonly signal: AbortSignal;
  readonly taskEvents?: { hasPending(): boolean; subscribe(listener: () => void): () => void };
  readonly hostBridge: HostBridge | undefined;
  emitStream(event: ModelStreamEvent): void;
  /** Sibling channel (send_task_message): only meaningful on a child engine,
   * where the manager installs a parent-mediated delivery handler. */
  sendTaskMessage(record: ToolCallRecord): ToolObservation;
}

/** The engine-side handler owners the registry binds tool names to. Every one
 * of these is assigned exactly once at the end of the AgentEngine constructor
 * and never reassigned (unlike session/abortController), so the registry may
 * capture them by value — provided it is built AFTER those assignments. */
export interface ToolDispatchControllers {
  subagent: SubagentManager;
  todos: TodosController;
  submitResponse: SubmitResponseController;
  memory: MemoryController;
  question: QuestionController;
  plan: PlanController;
  notes: NotesController;
  audit: AuditController;
  subtasks: SubtaskController;
  goals: GoalService;
}

export type ToolHandler = (record: ToolCallRecord) => Promise<ToolObservation> | ToolObservation;

export interface ToolDispatch {
  /** Tool-name → handler map. Exposed (readonly) so the registry-consistency
   * test can assert every engineHandledToolNames() entry has a handler —
   * without it, a missing case only surfaces at runtime via the fail-loud
   * guard in run(). */
  readonly registry: ReadonlyMap<string, ToolHandler>;
  run(record: ToolCallRecord): Promise<ToolObservation>;
}

const EMPTY_TOOL_SET: ReadonlySet<string> = new Set();

/** Tools the active session is forbidden from invoking. Top-level sessions
 * get an empty set (no restrictions on top of profile-level permissions).
 * Subagents lose the spawn / HITL / memory family entirely.
 *
 * Pure function of the session, shared by the dispatcher's defense-in-depth
 * check below and by AgentEngine.resolveTools (which filters the advertised
 * tools array with the same set). */
export function blockedToolsForSession(session: SessionState): ReadonlySet<string> {
  return session.isSubagent ? BLOCKED_FOR_SUBAGENT : EMPTY_TOOL_SET;
}

/** Build the engine's tool dispatch: the name→handler registry for
 * engine-handled tools plus the fallback path (MCP runtime tools, then the
 * @reina/tools registry). Extracted verbatim from the former
 * AgentEngine.executeToolOrEngine switch — the engine keeps a thin same-named
 * delegate so the executeRecord call site and test seams are unchanged. */
export function createToolDispatch(host: ToolDispatchHost, controllers: ToolDispatchControllers): ToolDispatch {
  const { subagent, todos, submitResponse, memory, question, plan, notes, audit, subtasks, goals } = controllers;
  const registry = new Map<string, ToolHandler>([
    ["task", (record) => subagent.startAsync(record)],
    ["start_async_task", (record) => subagent.startAsync(record)],
    ["get_async_tasks", (record) => subagent.get(record)],
    ["check_async_task", (record) => subagent.check(record)],
    ["cancel_async_task", (record) => subagent.cancel(record)],
    ["update_async_task", (record) => subagent.update(record)],
    ["list_async_tasks", (record) => subagent.list(record)],
    ["gather_async_tasks", (record) => subagent.gather(record)],
    ["wait_async_tasks", (record) => subagent.wait(record)],
    ["send_task_message", (record) => host.sendTaskMessage(record)],
    ["start_task_batch", (record) => subagent.startBatch(record)],
    ["check_task_batch", (record) => subagent.checkBatch(record)],
    ["write_todos", (record) => todos.write(record)],
    ["submit_response", (record) => submitResponse.respond(record)],
    ["recall_memory_chunk", (record) => memory.recall(record)],
    ["list_memory_chunks", (record) => memory.list(record)],
    ["search_memory", (record) => memory.search(record)],
    ["consolidate_memory", (record) => memory.consolidate(record)],
    ["question", (record) => question.ask(record)],
    ["plan", (record) => plan.update(record)],
    ["exit_plan_mode", (record) => plan.exit(record)],
    ["note", (record) => notes.append(record)],
    ["list_notes", (record) => notes.list(record)],
    ["read_note", (record) => notes.read(record)],
    ["update_note", (record) => notes.update(record)],
    ["delete_note", (record) => notes.delete(record)],
    ["declare_audit_done", (record) => audit.declareDone(record)],
    ["create_subtask", (record) => subtasks.create(record)],
    ["update_subtask", (record) => subtasks.update(record)],
    ["get_dag", (record) => subtasks.getDag(record)],
    ["set_phase", (record) => subtasks.setPhaseFromTool(record)],
    ["send_to_worker", (record) => notes.sendToWorker(record)],
    ["get_goal", (record) => goals.get(record)],
    ["create_goal", (record) => goals.create(record)],
    ["update_goal", (record) => goals.update(record)],
  ]);
  return {
    registry,
    async run(record: ToolCallRecord): Promise<ToolObservation> {
      // Defense in depth: even if a blocked tool slipped through resolveTools
      // (e.g. the model emitted it from a stale schema), refuse at execution
      // time so a subagent can never recurse into another subagent via `task`.
      const blocked = blockedToolsForSession(host.session);
      if (blocked.has(record.name)) {
        return {
          callId: record.id,
          name: record.name,
          error: `Tool ${record.name} is not available to subagents. Return your findings to the parent agent instead.`,
        };
      }
      // Side chat ("/btw"): hard execution-layer veto of everything but
      // `read`-level registry tools. Tool DEFINITIONS stay in the request
      // (prompt-cache stability — kimi's trick), so a model may still emit
      // a mutating call; it must fail here, mechanically, not by prompt
      // compliance. MCP runtime tools and engine-handled tools whose
      // descriptor isn't read-level all fall through to the denial.
      if (host.session.isSideChat) {
        const permission = toolRegistry.get(record.name)?.descriptor.permission;
        if (permission !== "read") {
          return { callId: record.id, name: record.name, error: SIDE_CHAT_TOOL_DENIED };
        }
      }
      const handler = registry.get(record.name);
      if (handler) return handler(record);
      // Engine-handled tools (their descriptor lives in @reina/tools but
      // their behavior is one of the cases above) must never reach runTool —
      // that would execute the stub and return its "handled by AgentEngine"
      // sentinel to the model as if it were a real result. If one falls
      // through, a case went missing: fail loudly instead of silently.
      if (engineHandledToolNames().has(record.name)) {
        throw new Error(
          `Tool "${record.name}" is engine-handled but reached fallback dispatch — its case is missing from executeToolOrEngine (engine bug).`,
        );
      }
      if (isMcpRuntimeTool(record.name)) {
        return {
          callId: record.id,
          name: record.name,
          output: await runMcpRuntimeTool(
            record.name,
            record.input,
            {
              cwd: host.session.cwd,
              signal: host.signal,
            },
            record.mcpServer !== undefined && record.mcpTool !== undefined
              ? { mcpServer: record.mcpServer, mcpTool: record.mcpTool }
              : undefined,
          ),
        };
      }
      return runTool(record.name, record.input, {
        cwd: host.session.cwd,
        signal: host.signal,
        readFileTimestamps: host.session.readFileTimestamps,
        onProgress: (progress) =>
          host.emitStream({ type: "tool-progress", id: record.id, name: record.name, ...progress }),
        hostBridge: host.hostBridge,
        allowedMcpServers: resolveProfile(host.session.agent).mcpServers,
        sessionId: host.session.id,
        toolCallId: record.id,
        taskEvents: host.taskEvents,
      });
    },
  };
}
