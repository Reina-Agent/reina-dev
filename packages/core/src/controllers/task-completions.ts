import path from "node:path";
import type { ChatMessage, ModelStreamEvent, SessionState } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import {
  acknowledgeBackgroundShellCompletion,
  listPendingBackgroundShellCompletions,
  subscribeBackgroundShellCompletions,
  type BackgroundShellTaskRecord,
} from "@reina/tools";
import type { SubagentManager } from "../subagent/manager.js";
import { formatCompletionInjection } from "../subagent/injector.js";
import { escapeXml } from "../subagent/format.js";
import { pushTrace } from "../trace.js";

interface TaskCompletionsHost {
  readonly session: SessionState;
  readonly subagent: Pick<SubagentManager, "injector" | "upsertAsyncTask">;
  onStream(listener: (event: ModelStreamEvent) => void): () => void;
  appendMessage(message: ChatMessage): Promise<void>;
  reportError(error: unknown): void;
}

/** One session's completion inbox. Producers retain their task records; this
 * controller owns delivery, wake signals and acknowledgement at model boundaries. */
export class TaskCompletionsController {
  private readonly shells = new Map<string, BackgroundShellTaskRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private restoreGeneration = 0;
  revision = 0;

  constructor(private readonly host: TaskCompletionsHost) {
    const shellUnsubscribe = subscribeBackgroundShellCompletions((task) => this.acceptShell(task));
    const agentUnsubscribe = host.onStream((event) => {
      if (event.type === "async-task-injected") this.notify();
    });
    this.unsubscribe = () => {
      shellUnsubscribe();
      agentUnsubscribe();
    };
  }

  hasPending(): boolean {
    this.prune();
    return !this.disposed && (this.shells.size > 0 || this.host.subagent.injector.hasPending());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (!this.hasPending()) return;
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private owns(task: BackgroundShellTaskRecord): boolean {
    const session = this.host.session;
    return task.sessionId === session.id && samePath(task.workspaceRoot, session.cwd) &&
      (!task.toolCallId || session.toolCalls.some((call) => call.id === task.toolCallId));
  }

  private acceptShell(task: BackgroundShellTaskRecord): void {
    if (this.disposed || !this.owns(task) || task.injectedAt || task.status === "running" || this.shells.has(task.id)) return;
    this.shells.set(task.id, task);
    this.notify();
  }

  /** Rollback can retain the session id while removing a command's initiating call. */
  prune(): void {
    for (const [id, task] of this.shells) {
      if (!this.owns(task)) this.shells.delete(id);
    }
  }

  async restore(): Promise<void> {
    const generation = ++this.restoreGeneration;
    const { id, cwd } = this.host.session;
    this.shells.clear();
    const tasks = await listPendingBackgroundShellCompletions(cwd, id);
    if (this.disposed || generation !== this.restoreGeneration || this.host.session.id !== id) return;
    for (const task of tasks) this.acceptShell(task);
  }

  /** Call only between model/tool iterations. Never mutate an in-flight request. */
  async drain(): Promise<boolean> {
    if (!this.hasPending()) return false;
    const session = this.host.session;
    const tasks = this.host.subagent.injector.drainAtSafeBoundary();
    const dropped = this.host.subagent.injector.drainDropped();
    // Bound each model update; remaining shell completions stay pending.
    const shells = [...this.shells.values()].slice(0, 8);
    for (const task of shells) this.shells.delete(task.id);
    const content = [formatCompletionInjection(tasks, dropped), formatShellCompletions(shells)].filter(Boolean).join("\n\n");
    if (!content) return false;
    const createdAt = nowIso();
    try {
      // The notice must be durable before task metadata claims it was delivered.
      await this.host.appendMessage({ id: createId("msg"), role: "user", content, createdAt, origin: "task-notify" });
    } catch (error) {
      // Leave failed deliveries available for a user retry/restart. Do not
      // emit a new wake signal for the same failed batch.
      const droppedTasks = (session.asyncTasks ?? []).filter((task) => dropped.ids.includes(task.id));
      for (const task of [...droppedTasks, ...tasks]) {
        delete task.injectedAt;
        this.host.subagent.injector.enqueue(task);
      }
      for (const task of shells) this.shells.set(task.id, task);
      throw error;
    }
    pushTrace(session, "async_task.injected", {
      count: tasks.length, dropped: dropped.count, taskIds: tasks.map((task) => task.id),
      shellTaskIds: shells.map((task) => task.id),
    });
    for (const task of tasks) this.host.subagent.upsertAsyncTask(task);
    for (const id of dropped.ids) {
      const task = session.asyncTasks?.find((item) => item.id === id);
      if (task) this.host.subagent.upsertAsyncTask(task);
    }
    await Promise.all(shells.map((task) =>
      acknowledgeBackgroundShellCompletion(session.cwd, task.id, createdAt).catch((error) => this.host.reportError(error)),
    ));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.restoreGeneration++;
    this.unsubscribe();
    this.listeners.clear();
    this.shells.clear();
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function formatShellCompletions(tasks: BackgroundShellTaskRecord[]): string {
  if (tasks.length === 0) return "";
  const lines = [`<shell-task-notifications count="${tasks.length}">`];
  for (const task of tasks) {
    lines.push(`  <shell-task id="${escapeXml(task.id)}" status="${task.status}">`);
    lines.push(`    <command>${escapeXml(task.command.slice(0, 1024))}</command>`);
    if (task.exitCode !== undefined) lines.push(`    <exit_code>${task.exitCode}</exit_code>`);
    if (task.error) lines.push(`    <error>${escapeXml(task.error.slice(0, 1024))}</error>`);
    lines.push("  </shell-task>");
  }
  lines.push("  <hint>These background commands have settled. Use task_output with the task id to inspect their saved output. A lost task could not be reattached after restart; inspect it before deciding whether to rerun.</hint>");
  lines.push("</shell-task-notifications>");
  return lines.join("\n");
}
