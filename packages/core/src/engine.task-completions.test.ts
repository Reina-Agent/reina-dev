import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncTaskRecord, ModelToolCall } from "@reina/protocol";
import { listBackgroundShellTaskRecords, stopBackgroundShellTask } from "@reina/tools";
import { AgentEngine } from "./engine.js";
import type { SubagentManager } from "./subagent/manager.js";
import type { RolloutRecorder } from "./rollout.js";

type WireMessage = { role: string; content?: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string };
type WireRequest = { messages: WireMessage[] };

let cwd: string;
let oldConfigHome: string | undefined;
let server: Server;
let baseUrl: string;
let engine: AgentEngine;
let requests: WireRequest[];
let useTool: boolean;
let toolPlan: ((index: number, request: WireRequest) => ModelToolCall[]) | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-completion-loop-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "config");
  await writeFile(path.join(cwd, "README.md"), "completion fixture");
  requests = [];
  useTool = true;
  toolPlan = undefined;
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body) as WireRequest);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const calls = toolPlan?.(requests.length, requests.at(-1)!) ??
      (useTool && requests.length === 1 ? [{ id: "call_read", name: "read_file", input: { path: "README.md" } }] : []);
    const tool = calls.length > 0;
    const delta = tool
      ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }
      : { role: "assistant", content: "Finished." };
    res.write(`data: ${JSON.stringify({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  engine = await AgentEngine.create({
    cwd,
    permissionMode: "bypass",
    model: { provider: "openai-chat", model: "fixture", apiKey: "fixture", baseUrl },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of await listBackgroundShellTaskRecords(cwd)) {
    if (task.status === "running") await stopBackgroundShellTask(cwd, task.id);
  }
  await listBackgroundShellTaskRecords(cwd);
  await engine?.dispose();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true });
});

function completeTask(): AsyncTaskRecord {
  const task: AsyncTaskRecord = {
    id: "sub_completion_fixture", agent: "default", description: "background check", background: true,
    status: "completed", isolation: "none", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    result: "background result is ready",
  };
  const manager = (engine as unknown as { subagent: SubagentManager }).subagent;
  manager.upsertAsyncTask(task);
  manager.injector.enqueue(task);
  return task;
}

describe("task completions at model boundaries", () => {
  it("does not revive an automatic turn stopped during context refresh", async () => {
    completeTask();
    const context = (engine as unknown as { turnContext: { refreshContext(): Promise<void> } }).turnContext;
    vi.spyOn(context, "refreshContext").mockImplementationOnce(async () => { engine.interrupt(); });
    await engine.runTurn("Handle the completed task.");
    expect(requests).toHaveLength(0);
    expect(engine.session.interrupted).toBe(true);
    expect(engine.hasPendingCompletionNotifications()).toBe(true);
  });

  it("keeps a completion unacknowledged when its notice cannot be persisted", async () => {
    const task = completeTask();
    const recorder = (engine as unknown as { recorder: RolloutRecorder }).recorder;
    vi.spyOn(recorder, "appendDurable").mockRejectedValueOnce(new Error("notification disk write failed"));
    await expect(engine.runTurn("Continue after the task.")).rejects.toThrow("notification disk write failed");
    expect(task.injectedAt).toBeUndefined();
    expect(engine.hasPendingCompletionNotifications()).toBe(true);
    expect(engine.session.messages.some((message) => message.origin === "task-notify")).toBe(false);
    await engine.runTurn("Retry after storage recovers.");
    expect(task.injectedAt).toBeTruthy();
    expect(engine.session.messages.filter((message) => message.origin === "task-notify")).toHaveLength(1);
  });

  it("delivers a mid-tool completion in the same turn without duplicating native tool pairs, then persists its acknowledgement", async () => {
    let task: AsyncTaskRecord | undefined;
    const unsubscribe = engine.onStream((event) => {
      if (event.type === "tool-progress" && event.status === "completed" && !task) task = completeTask();
    });
    await engine.runTurn("Read README.md and report the result.");
    unsubscribe();
    expect(requests).toHaveLength(2);
    const second = requests[1]!.messages;
    expect(JSON.stringify(second)).toContain("background result is ready");
    const calls = second.flatMap((message) => message.tool_calls ?? []);
    const results = second.filter((message) => message.role === "tool");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_call_id).toBe(calls[0]!.id);
    expect(task?.injectedAt).toBeTruthy();
    expect(engine.session.messages.filter((message) => message.origin === "task-notify")).toHaveLength(1);
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
    const sessionId = engine.session.id;
    await engine.saveSession();
    await engine.loadSession(sessionId);
    expect(engine.session.asyncTasks?.find((item) => item.id === task?.id)?.injectedAt).toBeTruthy();
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
  });

  it("continues when a completion arrives during the final text response", async () => {
    useTool = false;
    let arrived = false;
    const unsubscribe = engine.onStream((event) => {
      if (event.type === "text-delta" && !arrived) {
        arrived = true;
        completeTask();
      }
    });
    await engine.runTurn("Summarize the work.");
    unsubscribe();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("background result is ready");
    expect(engine.hasPendingCompletionNotifications()).toBe(false);
  });

  it("wakes a real shell wait when another command completes and delivers that result to the same model loop", async () => {
    await writeFile(path.join(cwd, "slow.cjs"), "setTimeout(()=>process.exit(0),15000)");
    await writeFile(path.join(cwd, "fast.cjs"), "setTimeout(()=>{console.log('fast result');process.exit(0)},700)");
    let slowId = "";
    toolPlan = (index, request) => {
      if (index === 1) {
        return ["slow", "fast"].map((name) => ({
          id: `call_${name}`, name: "run_shell", summary: `Start ${name}`,
          input: { command: `node ${name}.cjs`, shell: process.platform === "win32" ? "cmd" : "sh", runInBackground: true },
        }));
      }
      if (index === 2) {
        const output = request.messages.find((message) => message.role === "tool" && String(message.content).includes("slow.cjs"));
        slowId = (JSON.parse(String(output?.content)) as { taskId: string }).taskId;
        return [{ id: "call_wait", name: "task_output", summary: "Wait for slow command", input: { taskId: slowId, block: true, timeoutMs: 10000 } }];
      }
      return [];
    };
    await engine.runTurn("Start both commands; wait for the slow command, but handle other completed work promptly.");
    expect(requests).toHaveLength(3);
    const third = requests[2]!.messages;
    expect(JSON.stringify(third)).toContain("<shell-task-notifications");
    const waited = third.find((message) => message.role === "tool" && String(message.content).includes("<wake_reason>task_event</wake_reason>"));
    expect(waited?.content).toContain("<status>running</status>");
    expect(waited?.content).toContain(slowId);
    const slow = (await listBackgroundShellTaskRecords(cwd)).find((task) => task.id === slowId);
    expect(slow?.status).toBe("running");
  });
});
