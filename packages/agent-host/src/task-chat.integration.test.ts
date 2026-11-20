import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelStreamEvent, ModelTurn, SessionState } from "@reina/protocol";
import type { DesktopOutbound } from "@reina/desktop-protocol";

const provider = vi.hoisted(() => ({
  respond: undefined as ((request: ModelRequest, emit?: (event: ModelStreamEvent) => void, signal?: AbortSignal) => Promise<ModelTurn>) | undefined,
}));

// Keep the actual host, parent/child engines, tool dispatcher, interruption,
// and disk writers. Only replace model I/O; no credentials or network needed.
vi.mock("@reina/providers", async (importActual) => ({
  ...await importActual<typeof import("@reina/providers")>(),
  nextModelTurnStream: (_config: unknown, request: ModelRequest, emit?: (event: ModelStreamEvent) => void, signal?: AbortSignal) =>
    provider.respond!(request, emit, signal),
}));

import { AgentHost } from "./index.js";

let cwd: string;
let host: AgentHost | undefined;
let oldConfigHome: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-task-chat-integration-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "README.md"), "retained evidence from the original task", "utf8");
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  if (path.dirname(cwd) !== path.resolve(os.tmpdir()) || !path.basename(cwd).startsWith("reina-task-chat-integration-")) {
    throw new Error(`Unexpected temporary directory: ${cwd}`);
  }
  await rm(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
});

describe("subagent chat through the real AgentHost and AgentEngine", () => {
  it("aborts and steers a running child with its tool context, then persists human and supervisor follow-ups", async () => {
    const events: DesktopOutbound[] = [];
    const childRequests: Array<Pick<ModelRequest, "messages" | "observations" | "sessionId">> = [];
    let parentId = "";
    let dispatched = false;
    let supervisorSent = false;
    let waitingForAbort = false;
    let aborted = false;
    let taskId = "";

    provider.respond = async (request, emit, signal) => {
      if (request.sessionId === parentId) {
        if (!dispatched) {
          dispatched = true;
          return { toolCalls: [{ id: "dispatch-worker", name: "start_async_task", summary: "Dispatch worker", input: {
            name: "chat-worker", description: "original brief: inspect README.md", background: true,
          } }] };
        }
        if (!supervisorSent && request.messages.some((message) => message.role === "user" && message.content === "send supervisor follow-up")) {
          supervisorSent = true;
          return { toolCalls: [{ id: "supervisor-update", name: "update_async_task", summary: "Update worker", input: {
            taskId, message: "supervisor follow-up", sender: "user",
          } }] };
        }
        return { content: "parent acknowledged", toolCalls: [] };
      }

      childRequests.push(structuredClone({ messages: request.messages, observations: request.observations, sessionId: request.sessionId }));
      if (childRequests.length === 1) {
        return { toolCalls: [{ id: "inspect-original-evidence", name: "read_file", summary: "Read original evidence", input: { path: "README.md" } }] };
      }
      if (childRequests.length === 2) {
        emit?.({ type: "text-delta", text: "partial reply before changed requirements" });
        waitingForAbort = true;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(new DOMException("Interrupted", "AbortError"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      const content = childRequests.length === 3 ? "revised answer" : childRequests.length === 4 ? "human follow-up answer" : "supervisor follow-up answer";
      emit?.({ type: "text-delta", text: content });
      return { content, toolCalls: [] };
    };

    host = new AgentHost((event) => events.push(structuredClone(event)));
    const created = await host.handle({
      type: "create_session", cwd, agent: "default", permissionMode: "bypass", model: { provider: "deterministic" },
    });
    expect(created).toMatchObject({ success: true });
    parentId = (created as { data: { sessionId: string } }).data.sessionId;
    const snapshot = (): SessionState | undefined => events.flatMap((event) =>
      event.type === "session_snapshot" && event.sessionId === parentId ? [event.session] : [],
    ).at(-1);
    const taskStream = (): ModelStreamEvent[] => events.flatMap((event) =>
      event.type === "model_stream" && event.sessionId === parentId && event.event.type === "subagent-event" && event.event.taskId === taskId ? [event.event.event] : [],
    );
    const taskCompleted = (answer: string): boolean => events.some((event) =>
      event.type === "model_stream" && event.sessionId === parentId && event.event.type === "async-task-updated"
      && event.event.task.id === taskId && event.event.task.status === "completed" && event.event.task.result === answer,
    );

    expect(await host.handle({ type: "send_message", sessionId: parentId, message: "dispatch a worker" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(waitingForAbort).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(snapshot()?.asyncTasks?.[0]?.id).toBeTruthy());
    taskId = snapshot()!.asyncTasks![0]!.id;
    expect(await host.handle({ type: "update_async_task_external", sessionId: parentId, taskId, message: "requirements changed: use the original evidence" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(taskCompleted("revised answer")).toBe(true));
    expect(aborted).toBe(true);
    expect(childRequests.slice(0, 3).map((request) => request.sessionId)).toEqual(Array(3).fill(childRequests[0]!.sessionId));
    expect(JSON.stringify(childRequests[1]!.observations)).toContain("retained evidence from the original task");
    const steered = JSON.stringify({ messages: childRequests[2]!.messages, observations: childRequests[2]!.observations });
    expect(steered).toContain("original brief: inspect README.md");
    expect(steered).toContain("retained evidence from the original task");
    expect(steered).toContain("requirements changed: use the original evidence");
    expect(snapshot()?.messages.some((message) => message.role === "user" && message.content === "requirements changed: use the original evidence")).toBe(false);

    expect(await host.handle({ type: "update_async_task_external", sessionId: parentId, taskId, message: "human follow-up" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(taskCompleted("human follow-up answer")).toBe(true));
    expect(childRequests[3]!.sessionId).not.toBe(childRequests[2]!.sessionId);
    expect(JSON.stringify(childRequests[3])).toContain("original brief: inspect README.md");
    expect(JSON.stringify(childRequests[3])).toContain("revised answer");
    expect(JSON.stringify(childRequests[3])).toContain("human follow-up");

    expect(await host.handle({ type: "send_message", sessionId: parentId, message: "send supervisor follow-up" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(taskCompleted("supervisor follow-up answer")).toBe(true));
    const live = taskStream();
    expect(live.filter((event) => event.type === "task-message")).toMatchObject([
      { text: "requirements changed: use the original evidence", sender: "user" },
      { text: "human follow-up", sender: "user" },
      { text: "supervisor follow-up", sender: "supervisor" },
    ]);
    expect(live.filter((event) => event.type === "task-turn-started")).toHaveLength(4);
    expect(live.flatMap((event) => event.type === "task-turn-completed" && !event.id.startsWith("prior-") ? [event.text] : [])).toEqual([
      "revised answer", "human follow-up answer", "supervisor follow-up answer",
    ]);
    await vi.waitFor(async () => {
      const source = await readFile(path.join(cwd, ".reina", "tasks", taskId, "stream.jsonl"), "utf8");
      expect(source.trim().split("\n").map((line) => JSON.parse(line).event)).toEqual(live);
    });
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  });
});
