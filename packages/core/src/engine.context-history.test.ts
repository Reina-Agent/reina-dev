import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelRequest, ModelStreamEvent, ModelTurn } from "@reina/protocol";

const provider = vi.hoisted(() => ({
  respond: undefined as ((request: ModelRequest, signal?: AbortSignal) => Promise<ModelTurn>) | undefined,
}));
vi.mock("@reina/providers", async (importActual) => ({
  ...await importActual<typeof import("@reina/providers")>(),
  nextModelTurnStream: (_config: unknown, request: ModelRequest, _emit?: unknown, signal?: AbortSignal) => provider.respond!(request, signal),
}));
import { AgentEngine } from "./engine.js";
import { ContextHistoryStore } from "./context-history.js";
import { SubagentManager } from "./subagent/manager.js";
import { testHost, testSession } from "./subagent/test-helpers.js";

let cwd: string;
let engines: AgentEngine[];
let oldConfigHome: string | undefined;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-engine-context-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  engines = [];
  provider.respond = async () => ({ content: "finished", toolCalls: [], usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } });
  await writeFile(path.join(cwd, "README.md"), "tool evidence survives in request detail");
});
afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.dispose()));
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rm(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
});
async function engine(): Promise<AgentEngine> {
  const created = await AgentEngine.create({ cwd, agent: "default", permissionMode: "bypass", model: { provider: "deterministic", model: "test", apiKey: "never-inspect-this-key" } });
  engines.push(created);
  return created;
}

describe("real engine context request lifecycle", () => {
  it("records real tool rounds, delivered reminders and actual usage separately from estimates", async () => {
    const live = await engine();
    const events: ModelStreamEvent[] = [];
    live.onStream((event) => events.push(event));
    let count = 0;
    provider.respond = async () => ++count === 1
      ? { toolCalls: [{ id: "call-evidence", name: "read_file", summary: "Read evidence", input: { path: "README.md" } }] }
      : { content: "finished", toolCalls: [], usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } };
    await live.runTurn("inspect the readme", { reminders: ["request-specific-reminder"] });
    const history = await live.getContextHistory();
    expect(history.requests).toHaveLength(2);
    expect(history.requests.map((request) => request.status)).toEqual(["completed", "completed"]);
    expect(new Set(history.requests.map((request) => request.turnId)).size).toBe(1);
    const second = history.requests[1]!;
    expect(second.breakdown.estimatedInputTokens).toBeGreaterThan(120);
    for (const entry of history.requests) {
      expect(Object.values(entry.breakdown.composition!).reduce((sum, count) => sum + count, 0)).toBe(entry.breakdown.estimatedInputTokens);
    }
    expect(second.breakdown.composition!.toolResults).toBe(second.breakdown.observationsTokens);
    expect(second.breakdown.composition!.injected).toBeGreaterThan(0);
    expect(second.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128 });
    const detail = await live.getContextRequest(second.id);
    const pendingTool = JSON.parse(detail!.sections.find((section) => section.id === "observations")!.items[0]!.content);
    expect(pendingTool).toMatchObject({ name: "read_file", input: { path: "README.md" } });
    const text = JSON.stringify(detail);
    expect(text).toContain("tool evidence survives in request detail");
    expect(text).toContain("request-specific-reminder");
    expect(text).toContain("inputSchema");
    expect(text).not.toContain("never-inspect-this-key");
    expect(events.filter((event) => event.type === "context-request").map((event) => event.request.status)).toEqual(["running", "completed", "running", "completed"]);
    expect(JSON.stringify(events.filter((event) => event.type === "context-request"))).not.toContain("tool evidence survives in request detail");
  });

  it("retains a failed attempt and records its retry with a distinct id and matching turn", async () => {
    const live = await engine();
    let count = 0;
    provider.respond = async () => {
      if (++count === 1) throw new Error("upstream overloaded never-inspect-this-key");
      return { content: "recovered", toolCalls: [] };
    };
    await live.runTurn("retry once");
    const { requests } = await live.getContextHistory();
    expect(requests.map((request) => [request.status, request.attempt])).toEqual([["failed", 1], ["completed", 2]]);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    expect(requests[0]!.turnId).toBe(requests[1]!.turnId);
    expect(requests[0]!.error).toContain("upstream overloaded [redacted]");
    expect(requests[0]!.completedAt).toBeTruthy();
  });

  it("makes the in-flight request readable then settles it as cancelled on a real interrupt", async () => {
    const live = await engine();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    provider.respond = async (_request, signal) => {
      entered();
      return new Promise<ModelTurn>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const running = live.runTurn("wait for interruption");
    await ready;
    const started = (await live.getContextHistory()).requests[0]!;
    expect(started.status).toBe("running");
    expect((await live.getContextHistory()).live?.request.breakdown.projectedInputTokens).toBeUndefined();
    const steerId = live.injectSteer("queued preview steer");
    expect(JSON.stringify((await live.getContextHistory()).live?.sections)).toContain("queued preview steer");
    expect(live.session.messages.some((entry) => entry.content === "queued preview steer")).toBe(false);
    expect(live.retractSteer({ steerId })).toBe(true);
    expect(await live.getContextRequest(started.id)).not.toBeNull();
    live.interrupt();
    await running;
    expect((await live.getContextHistory()).requests).toMatchObject([{ id: started.id, status: "cancelled", completedAt: expect.any(String) }]);
  });

  it("keeps inspection events from extending a silent provider's child watchdog deadline", async () => {
    const child = await engine();
    const { host } = testHost(testSession({ cwd }));
    const manager = new SubagentManager(host);
    provider.respond = async (_request, signal) => new Promise<ModelTurn>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("watchdog aborted")), { once: true });
    });
    const result = await manager.runChildWithWatchdog(child, "silent request", undefined, { timeoutMsOverride: 1_000 });
    expect(result.disposition).toBe("timeout");
    expect((await child.getContextHistory()).requests[0]!.status).toBe("cancelled");
  }, 5_000);

  it("uses the durable task owner across actual completed child replacements and rejects foreign task reads", async () => {
    const parent = await engine();
    let dispatched = false;
    let childTurns = 0;
    provider.respond = async (request) => {
      if (request.sessionId === parent.session.id) {
        if (!dispatched) {
          dispatched = true;
          return { toolCalls: [{ id: "dispatch", name: "task", summary: "Dispatch worker", input: { name: "context-worker", description: "original child brief" } }] };
        }
        return { content: "parent complete", toolCalls: [] };
      }
      return { content: "child complete " + (++childTurns), toolCalls: [] };
    };
    await parent.runTurn("dispatch child");
    const taskId = parent.session.asyncTasks![0]!.id;
    const first = await parent.getContextHistory(taskId);
    expect(first.requests).toHaveLength(1);
    expect(parent.updateAsyncTaskExternal(taskId, "continue child").error).toBeUndefined();
    await vi.waitFor(() => expect(parent.session.asyncTasks![0]!.result).toBe("child complete 2"));
    const later = await parent.getContextHistory(taskId);
    expect(later.requests).toHaveLength(2);
    expect(later.requests[0]!.sessionId).not.toBe(later.requests[1]!.sessionId);
    expect((await parent.getContextHistory()).requests.every((request) => request.sessionId === parent.session.id)).toBe(true);
    expect(JSON.stringify(await parent.getContextRequest(first.requests[0]!.id, taskId))).toContain("original child brief");
    expect(await parent.getContextRequest(first.requests[0]!.id)).toBeNull();
    await expect(parent.getContextHistory("foreign-task")).rejects.toThrow("does not belong");
    const reopened = new ContextHistoryStore({ cwd, sessionId: parent.session.id, taskId });
    expect((await reopened.history()).requests.map((request) => request.id)).toEqual(later.requests.map((request) => request.id));
  });

  it("persists real compaction boundaries and failure lifecycles without changing compaction behavior", async () => {
    const live = await engine();
    live.session.messages.push(...longHistory());
    const boundary = await live.compactNow("inspection success");
    expect(boundary).toBeTruthy();
    const successful = (await live.getContextHistory()).events;
    expect(successful).toHaveLength(1);
    expect(successful[0]).toMatchObject({ status: "completed", boundary });
    const failed = await engine();
    failed.session.messages.push(...longHistory());
    await rm(path.join(cwd, ".reina", "conversation_history"), { recursive: true, force: true });
    await writeFile(path.join(cwd, ".reina", "conversation_history"), "not a directory");
    await expect(failed.compactNow("inspection failure")).rejects.toThrow();
    expect((await failed.getContextHistory()).events.map((event) => event.status)).toEqual(["failed"]);
  });

  it("continues the model turn if inspection persistence fails", async () => {
    const live = await engine();
    await mkdir(path.join(cwd, ".reina"), { recursive: true });
    await writeFile(path.join(cwd, ".reina", "context-history"), "not a directory");
    await live.runTurn("still respond");
    await live.dispose();
    expect(live.session.messages.at(-1)?.content).toBe("finished");
    expect(live.session.trace.some((event) => event.type === "background.error")).toBe(true);
  });

  it("previews without freezing the live prompt, consuming reminders or persisting a fake request", async () => {
    const live = await engine();
    const before = JSON.stringify(live.session);
    const history = await live.getContextHistory();
    expect(JSON.stringify(live.session)).toBe(before);
    expect(history.requests).toEqual([]);
    expect(history.live?.request).toMatchObject({ id: "live", status: "preview", attempt: 0 });
    expect(history.live?.request.usage).toBeUndefined();
    expect(await live.getContextRequest("live")).toBe(history.live);
    const stored = await new ContextHistoryStore({ cwd, sessionId: live.session.id }).history();
    expect(stored.live).toBeUndefined();
    expect(stored.requests).toEqual([]);

    provider.respond = async (request) => {
      const snapshot = JSON.stringify(request);
      const preview = (await live.getContextHistory()).live!;
      expect(JSON.stringify(preview.sections)).toContain("do-not-consume-this-reminder");
      expect(JSON.stringify(request)).toBe(snapshot);
      return { content: "finished", toolCalls: [] };
    };
    await live.runTurn("preview this turn", { reminders: ["do-not-consume-this-reminder"] });
  });

  it("calibrates live input with the compatible provider input and resets after a model switch or compaction", async () => {
    const live = await engine();
    provider.respond = async () => ({ content: "a fresh assistant answer", toolCalls: [], usage: { inputTokens: 12_000, outputTokens: 8_000, totalTokens: 20_000 } });
    await live.runTurn("calibrate input only");
    const history = await live.getContextHistory();
    const last = history.requests.at(-1)!;
    const preview = history.live!.request;
    expect(preview.breakdown.projectedInputTokens).toBe(12_000 + preview.breakdown.estimatedInputTokens - last.breakdown.estimatedInputTokens);
    expect(preview.usage).toBeUndefined();
    expect(preview.breakdown.composition!.assistant).toBeGreaterThan(0);
    live.updateConfig({ model: { ...live.session.model, model: "different-model" } });
    expect((await live.getContextHistory()).live!.request.breakdown.projectedInputTokens).toBeUndefined();
    live.updateConfig({ model: { ...live.session.model, model: "test" } });
    live.session.messages.push(...longHistory());
    await live.compactNow("preview boundary");
    expect((await live.getContextHistory()).live!.request.breakdown.projectedInputTokens).toBeUndefined();
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not calibrate live input from an unusable provider input (%s)", async (inputTokens) => {
    const live = await engine();
    provider.respond = async () => ({ content: "finished", toolCalls: [], usage: inputTokens === undefined ? undefined : { inputTokens, outputTokens: 8 } });
    await live.runTurn("missing or invalid input usage");
    const preview = (await live.getContextHistory()).live!.request;
    expect(preview.breakdown.projectedInputTokens).toBeUndefined();
    expect(preview.breakdown.estimatedInputTokens).toBeGreaterThan(0);
  });
});

function longHistory(): ChatMessage[] {
  const filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ";
  return Array.from({ length: 28 }, (_, index) => ({
    id: "message-" + index, role: index % 2 ? "assistant" as const : "user" as const,
    content: "message " + index + " " + filler.repeat(40), createdAt: new Date().toISOString(),
  }));
}
