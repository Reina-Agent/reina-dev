import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "./index.js";
import type { DesktopOutbound } from "@reina/desktop-protocol";
import { runTool } from "@reina/tools";

// Isolate the global config home so create_session never reads the dev's real
// ~/.reina/mcp.json. Otherwise AgentEngine creation kicks off an MCP cold-start
// in the background and host.close() then awaits closeMcpClients() on a
// still-connecting transport — which stalls the "host closes" test on machines
// that have MCP servers configured. CI has none, so this only bites locally,
// but the isolation keeps the suite deterministic everywhere.
let configHome: string;
let oldConfigHome: string | undefined;

beforeEach(async () => {
  configHome = await mkdtemp(path.join(os.tmpdir(), "reina-agent-host-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = configHome;
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(configHome);
});

/** Engines created by these tests kick off detached async work under
 * REINA_CONFIG_HOME (global NotesService init writes index/schema/log files)
 * that nothing awaits — under full-suite load it can straddle the teardown
 * boundary and make a plain rm race the writer (ENOTEMPTY on Windows).
 * Same retry shape as bubble.test.ts / engine.test.ts. */
async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe("AgentHost", () => {
  test("creates a session and emits a snapshot", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));

    const response = await host.handle({
      id: "create-1",
      type: "create_session",
      cwd: process.cwd(),
    });

    expect(response).toMatchObject({ success: true, command: "create_session" });
    expect(events.some((event) => event.type === "session_created")).toBe(true);
  });

  test("emits a provisional title before the first real user turn starts", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-title", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn(): Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
        active: boolean;
        provisionalTitle?: string;
      }>;
    };
    const live = internals.sessions.get(sessionId)!;
    let release!: () => void;
    live.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { session: live.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    await host.handle({
      id: "m-title",
      type: "send_message",
      sessionId,
      message: "Fix automatic task naming",
    });

    const titleEvent = events.find(
      (event): event is Extract<DesktopOutbound, { type: "session_title_updated" }> =>
        event.type === "session_title_updated",
    );
    expect(titleEvent).toMatchObject({
      sessionId,
      title: "Fix automatic task naming",
      expectedTitle: "Reina",
      source: "provisional",
    });
    expect(events.indexOf(titleEvent!)).toBeLessThan(events.findIndex((event) => event.type === "turn_started"));
    expect(live.provisionalTitle).toBe("Fix automatic task naming");

    await host.handle({
      id: "rename-title",
      type: "update_session_config",
      sessionId,
      title: "Manual title",
    });
    expect(live.provisionalTitle).toBeUndefined();

    release();
    await waitUntil(() => live.active === false);
    await host.close();
  });

  test("goal_command creates Goal state before the first model turn and deduplicates repeats", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-goal", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: { goal?: { current: { id: string; objective: string; status: string } | null; history: unknown[] } };
          executeGoalCommand(command: { type: "pause"; goalId: string }): unknown;
          runTurn(prompt: string): Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
        active: boolean;
      }>;
    };
    const live = internals.sessions.get(sessionId)!;
    const prompts: string[] = [];
    let stateAtFirstRequest: unknown;
    live.engine.runTurn = async (prompt) => {
      prompts.push(prompt);
      stateAtFirstRequest = { ...live.engine.session.goal?.current };
      const goalId = live.engine.session.goal!.current!.id;
      live.engine.executeGoalCommand({ type: "pause", goalId });
      return { session: live.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    const response = await host.handle({
      id: "g-1",
      type: "goal_command",
      sessionId,
      command: { type: "create", objective: "ship the host-owned goal" },
    });
    expect(response).toMatchObject({ success: true, data: { changed: true } });
    await waitUntil(() => live.active === false);
    expect(stateAtFirstRequest).toMatchObject({ objective: "ship the host-owned goal", status: "active" });
    expect(prompts).toEqual(["/goal ship the host-owned goal"]);

    const repeated = await host.handle({
      id: "g-2",
      type: "goal_command",
      sessionId,
      command: { type: "create", objective: "  SHIP the host-owned goal " },
    });
    expect(repeated).toMatchObject({ success: true, data: { changed: false } });
    expect(prompts).toHaveLength(1);
    expect(live.engine.session.goal?.history).toHaveLength(0);
    await host.close();
  });

  test("interrupt pauses an active Goal so idle continuation cannot restart it", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-stop-goal", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    let release!: () => void;
    const blockedTurn = new Promise<void>((resolve) => { release = resolve; });
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: { goal?: { current: { status: string } | null } };
          runTurn(): Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
      }>;
    };
    const live = internals.sessions.get(sessionId)!;
    live.engine.runTurn = async () => {
      await blockedTurn;
      return { session: live.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    await host.handle({
      id: "g-stop",
      type: "goal_command",
      sessionId,
      command: { type: "create", objective: "keep working until stopped" },
    });
    await host.handle({ id: "i-stop-goal", type: "interrupt", sessionId });
    expect(live.engine.session.goal?.current?.status).toBe("paused");
    release();
    await host.close();
  });

  test("host bridge round-trip: host_request emits, host_response resolves the pending promise", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));

    // Reach into the private bridge via the same surface engines use. We
    // construct a session so AgentHost wires up its bridge.
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: { hostBridge?: (kind: string, params: unknown) => Promise<unknown> };
      }>;
    };
    const callPromise = internals.sessions.get(sessionId)!.engine.hostBridge!("notify", { title: "Hi", body: "There" });

    // The bridge call should have emitted a host_request event.
    const requestEvent = events.find((event) => event.type === "host_request") as
      | { type: "host_request"; id: string; kind: string }
      | undefined;
    expect(requestEvent).toBeDefined();
    expect(requestEvent!.kind).toBe("notify");

    // Now feed back a host_response. The pending promise should resolve.
    const ack = await host.handle({
      id: "ack-1",
      type: "host_response",
      hostRequestId: requestEvent!.id,
      success: true,
      data: { delivered: true },
    });
    expect(ack).toMatchObject({ success: true });
    await expect(callPromise).resolves.toEqual({ delivered: true });
  });

  test("host close rejects bridge calls before waiting for the active turn", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    type TestBridge = (kind: string, params: unknown) => Promise<unknown>;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          hostBridge?: TestBridge;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
      bridgePending: Map<string, unknown>;
    };
    const session = internals.sessions.get(sessionId)!;
    const bridge = session.engine.hostBridge!;
    session.engine.runTurn = async () => {
      await bridge("notify", { scope: "host" });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.interrupt = () => undefined;

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "wait on host" });
    const requestEvent = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "host",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    expect(requestEvent).toBeDefined();

    const closePromise = host.close();
    const pendingAfterCloseStarted = internals.bridgePending.size;
    if (pendingAfterCloseStarted > 0) {
      await host.handle({
        id: "ack-host",
        type: "host_response",
        hostRequestId: requestEvent!.id,
        success: true,
        data: { delivered: true },
      });
    }
    await closePromise;

    expect(pendingAfterCloseStarted).toBe(0);
  });

  test("close_session rejects only bridge calls owned by that session before waiting", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const createdA = await host.handle({ id: "c-a", type: "create_session", cwd: process.cwd() });
    const createdB = await host.handle({ id: "c-b", type: "create_session", cwd: process.cwd() });
    const sessionAId = (createdA as { data: { sessionId: string } }).data.sessionId;
    const sessionBId = (createdB as { data: { sessionId: string } }).data.sessionId;
    type TestBridge = (kind: string, params: unknown) => Promise<unknown>;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          hostBridge?: TestBridge;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
      bridgePending: Map<string, unknown>;
    };
    const sessionA = internals.sessions.get(sessionAId)!;
    const sessionB = internals.sessions.get(sessionBId)!;
    const bridgeA = sessionA.engine.hostBridge!;
    const bridgeB = sessionB.engine.hostBridge!;
    sessionA.engine.runTurn = async () => {
      await bridgeA("notify", { scope: "session-a" });
      return { session: sessionA.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    sessionA.engine.interrupt = () => undefined;

    await host.handle({ id: "m-a", type: "send_message", sessionId: sessionAId, message: "wait on host" });
    const pendingB = bridgeB("notify", { scope: "session-b" });
    let bridgeBSettled = false;
    const bridgeBOutcome = pendingB.then(
      (value) => {
        bridgeBSettled = true;
        return { status: "resolved" as const, value };
      },
      (error: unknown) => {
        bridgeBSettled = true;
        return { status: "rejected" as const, error };
      },
    );
    const requestA = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "session-a",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    const requestB = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "session-b",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    expect(requestA).toBeDefined();
    expect(requestB).toBeDefined();

    const closePromise = host.handle({ id: "close-a", type: "close_session", sessionId: sessionAId });
    const pendingAfterCloseStarted = internals.bridgePending.size;
    if (pendingAfterCloseStarted > 1) {
      await host.handle({
        id: "ack-a",
        type: "host_response",
        hostRequestId: requestA!.id,
        success: true,
        data: { delivered: "a" },
      });
    }
    const closeResponse = await closePromise;
    await Promise.resolve();
    const bridgeBSettledBeforeResponse = bridgeBSettled;
    await host.handle({
      id: "ack-b",
      type: "host_response",
      hostRequestId: requestB!.id,
      success: true,
      data: { delivered: "b" },
    });
    const outcomeB = await bridgeBOutcome;
    await host.close();

    expect(closeResponse).toMatchObject({ success: true, command: "close_session", data: { closed: true } });
    expect(pendingAfterCloseStarted).toBe(1);
    expect(requestA).toMatchObject({ sessionId: sessionAId });
    expect(requestB).toMatchObject({ sessionId: sessionBId });
    expect(bridgeBSettledBeforeResponse).toBe(false);
    expect(outcomeB).toEqual({ status: "resolved", value: { delivered: "b" } });
  });

  test("host close rejects bridge calls created after interruption begins", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    type TestBridge = (kind: string, params: unknown) => Promise<unknown>;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          hostBridge?: TestBridge;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
      bridgePending: Map<string, unknown>;
    };
    const session = internals.sessions.get(sessionId)!;
    const bridge = session.engine.hostBridge!;
    let releaseTurn!: () => void;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      await bridge("notify", { scope: "late-host" });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.interrupt = () => releaseTurn();

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "bridge after interrupt" });
    const closePromise = host.close();
    await Promise.resolve();
    const lateRequest = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "late-host",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    const pendingAfterLateCall = internals.bridgePending.size;
    if (lateRequest) {
      await host.handle({
        id: "ack-late-host",
        type: "host_response",
        hostRequestId: lateRequest.id,
        success: true,
        data: { delivered: true },
      });
    }
    await closePromise;

    expect(pendingAfterLateCall).toBe(0);
    expect(lateRequest).toBeUndefined();
  });

  test("close_session rejects late bridge calls without disturbing another session", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const createdA = await host.handle({ id: "c-a", type: "create_session", cwd: process.cwd() });
    const createdB = await host.handle({ id: "c-b", type: "create_session", cwd: process.cwd() });
    const sessionAId = (createdA as { data: { sessionId: string } }).data.sessionId;
    const sessionBId = (createdB as { data: { sessionId: string } }).data.sessionId;
    type TestBridge = (kind: string, params: unknown) => Promise<unknown>;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          hostBridge?: TestBridge;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
      bridgePending: Map<string, unknown>;
    };
    const sessionA = internals.sessions.get(sessionAId)!;
    const sessionB = internals.sessions.get(sessionBId)!;
    const bridgeA = sessionA.engine.hostBridge!;
    const bridgeB = sessionB.engine.hostBridge!;
    let releaseTurn!: () => void;
    sessionA.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      await bridgeA("notify", { scope: "late-session-a" });
      return { session: sessionA.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    sessionA.engine.interrupt = () => releaseTurn();

    await host.handle({ id: "m-a", type: "send_message", sessionId: sessionAId, message: "bridge after interrupt" });
    const pendingB = bridgeB("notify", { scope: "late-session-b" });
    let bridgeBSettled = false;
    const bridgeBOutcome = pendingB.then(
      (value) => {
        bridgeBSettled = true;
        return { status: "resolved" as const, value };
      },
      (error: unknown) => {
        bridgeBSettled = true;
        return { status: "rejected" as const, error };
      },
    );
    const requestB = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "late-session-b",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    expect(requestB).toBeDefined();

    const closePromise = host.handle({ id: "close-a", type: "close_session", sessionId: sessionAId });
    await Promise.resolve();
    const lateRequestA = events.find(
      (event) => event.type === "host_request" && (event.params as { scope?: string }).scope === "late-session-a",
    ) as Extract<DesktopOutbound, { type: "host_request" }> | undefined;
    const pendingAfterLateCall = internals.bridgePending.size;
    if (lateRequestA) {
      await host.handle({
        id: "ack-late-a",
        type: "host_response",
        hostRequestId: lateRequestA.id,
        success: true,
        data: { delivered: "a" },
      });
    }
    const closeResponse = await closePromise;
    await Promise.resolve();
    const bridgeBSettledBeforeResponse = bridgeBSettled;
    await host.handle({
      id: "ack-late-b",
      type: "host_response",
      hostRequestId: requestB!.id,
      success: true,
      data: { delivered: "b" },
    });
    const outcomeB = await bridgeBOutcome;
    await host.close();

    expect(closeResponse).toMatchObject({ success: true, command: "close_session", data: { closed: true } });
    expect(pendingAfterLateCall).toBe(1);
    expect(lateRequestA).toBeUndefined();
    expect(bridgeBSettledBeforeResponse).toBe(false);
    expect(outcomeB).toEqual({ status: "resolved", value: { delivered: "b" } });
  });

  test("answering a bubbled question mid-run routes to the engine without the active-guard", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, { engine: { session: { pendingQuestions: Array<{ id: string; bubbledFromTask?: unknown }> }; requestUserQuestion: (input: { taskId: string; taskName?: string; prompt: string; options?: string[] }) => Promise<{ answer: string } | { cancelled: true }> }; active: boolean }>;
    };
    const session = internals.sessions.get(sessionId)!;

    // Simulate a bubbled question (e.g. a subagent escalation): the parent
    // run() is still active and blocked inside the tool awaiting the answer.
    session.active = true;
    const answerPromise = session.engine.requestUserQuestion({
      taskId: "q_test",
      taskName: "question",
      prompt: "Approve or override",
      options: ["Approve"],
    });
    const bubbled = session.engine.session.pendingQuestions.find((q) => q.bubbledFromTask);
    expect(bubbled).toBeDefined();

    events.length = 0;
    await host.handle({
      id: "a-1",
      type: "answer_question",
      sessionId,
      questionId: bubbled!.id,
      answer: "Approve",
    });

    // The old active-guard would have rejected this with a turn_failed.
    const rejected = events.some(
      (event) => event.type === "turn_failed" && /another session operation is active/.test((event as { error: string }).error),
    );
    expect(rejected).toBe(false);
    // The blocked tool receives the answer and the run stays active (it
    // continues; its own run() will emit turn_completed later).
    await expect(answerPromise).resolves.toEqual({ answer: "Approve" });
    expect(session.active).toBe(true);
  });

  test("bubbled approval mid-run: real-time permission_request + approve_tool bypasses the active-guard", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, { engine: unknown; active: boolean }>;
    };
    const session = internals.sessions.get(sessionId)!;
    // Simulate a sync `task` in flight: the parent run() is active and
    // blocked inside the tool awaiting the child, which just bubbled a
    // write approval up.
    session.active = true;

    const engineSeam = session.engine as unknown as {
      createSubagentHost: () => {
        requestBubbleApproval: (input: { taskId: string; taskName?: string; childRecord: unknown }) => Promise<{ approved: boolean }>;
      };
      session: { toolCalls: Array<{ id: string; bubbledFromTask?: { id: string }; status: string }> };
    };
    const subHost = engineSeam.createSubagentHost.call(session.engine);
    const pending = subHost.requestBubbleApproval({
      taskId: "sub_host",
      taskName: "writer",
      childRecord: {
        id: "call_child_1",
        name: "write_file",
        input: { path: "x.txt", content: "z" },
        summary: "write_file",
        permission: "write",
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      },
    });
    const mirror = engineSeam.session.toolCalls.find((c) => c.bubbledFromTask?.id === "sub_host")!;

    // 1. The mirror surfaces IMMEDIATELY as a top-level permission_request —
    //    the turn-end emitRunResult can never fire while the parent is blocked.
    const surfaced = events.find(
      (event) => event.type === "permission_request" && (event as { toolCall?: { id?: string } }).toolCall?.id === mirror.id,
    );
    expect(surfaced).toBeDefined();

    // 2. approve_tool routes to the engine resolver despite session.active
    //    (mirrors the bubbled-question bypass; the guarded path would emit
    //    turn_failed and strand the child forever).
    events.length = 0;
    await host.handle({ id: "a-1", type: "approve_tool", sessionId, callId: mirror.id, approved: true });
    const rejected = events.some(
      (event) => event.type === "turn_failed" && /another session operation is active/.test((event as { error: string }).error),
    );
    expect(rejected).toBe(false);
    await expect(pending).resolves.toMatchObject({ approved: true });
    // The parent run stays active — its own run() emits turn_completed later.
    expect(session.active).toBe(true);
  });

  test("queues a fresh turn after interrupt until the aborted turn settles", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
          injectSteer: (prompt: string) => void;
        };
        active: boolean;
        interrupting: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const prompts: string[] = [];
    let resolveFirst!: () => void;
    session.engine.runTurn = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let steers = 0;
    session.engine.injectSteer = () => {
      steers += 1;
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "first" });
    expect(prompts).toEqual(["first"]);

    await host.handle({ id: "i-1", type: "interrupt", sessionId });
    expect(session.active).toBe(true);
    expect(session.interrupting).toBe(true);

    await host.handle({ id: "m-2", type: "send_message", sessionId, message: "after interrupt" });
    expect(prompts).toEqual(["first"]);
    expect(steers).toBe(0);

    resolveFirst();
    await waitUntil(() => prompts.length === 2 && session.active === false);
    expect(prompts).toEqual(["first", "after interrupt"]);
    expect(events.filter((event) => event.type === "turn_started").map((event) => event.source)).toEqual(["user", "user"]);
  });

  test("a fresh message during a running turn queues as its own turn and never steers", async () => {
    // Regression guard: the host is the sole authority for mid-turn intent. A
    // plain `send_message` (intent defaults to "fresh") that arrives while a
    // turn is genuinely running must NOT be injected into the in-flight turn —
    // even with no interrupt pending — or the model would get steered
    // mid-output. It runs as the next turn once the current one settles.
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          injectSteer: (prompt: string) => void;
        };
        active: boolean;
        interrupting: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const prompts: string[] = [];
    let resolveFirst!: () => void;
    session.engine.runTurn = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let steers = 0;
    session.engine.injectSteer = () => {
      steers += 1;
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "first" });
    expect(session.active).toBe(true);
    expect(session.interrupting).toBe(false);

    // Running, NOT interrupting, intent defaults to "fresh".
    await host.handle({ id: "m-2", type: "send_message", sessionId, message: "typed while busy" });
    expect(steers).toBe(0);
    expect(prompts).toEqual(["first"]);

    resolveFirst();
    await waitUntil(() => prompts.length === 2 && session.active === false);
    expect(prompts).toEqual(["first", "typed while busy"]);
  });

  test("an explicit steer intent injects into the running turn", async () => {
    // The escape hatch: slash directives (/verify, /team, …) pass
    // intent: "steer" to interject into the in-flight turn. This is the ONLY
    // path that reaches injectSteer for a running, non-interrupting turn.
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          injectSteer: (prompt: string) => void;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const prompts: string[] = [];
    const steered: string[] = [];
    let resolveFirst!: () => void;
    session.engine.runTurn = async (prompt: string) => {
      prompts.push(prompt);
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.injectSteer = (prompt: string) => {
      steered.push(prompt);
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "first" });
    expect(session.active).toBe(true);

    await host.handle({ id: "m-2", type: "send_message", sessionId, message: "/verify", intent: "steer" });
    expect(steered).toEqual(["/verify"]);
    expect(prompts).toEqual(["first"]);

    resolveFirst();
    await waitUntil(() => session.active === false);
  });

  test("retract_steer withdraws a pending steer and reports false once it's gone", async () => {
    // The queue panel's 撤回: a steer injected into the running turn can be
    // pulled back out as long as it hasn't drained into the transcript. The
    // second attempt (already withdrawn — same shape as already drained)
    // reports retracted: false so the renderer doesn't restore stale text.
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    let resolveFirst!: () => void;
    // Stub ONLY runTurn (so the steer never drains); injectSteer/retractSteer
    // stay the real engine implementations under test.
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "first" });
    expect(session.active).toBe(true);
    await host.handle({ id: "m-2", type: "send_message", sessionId, message: "oops, take it back", intent: "steer" });

    const first = await host.handle({ id: "r-1", type: "retract_steer", sessionId, message: "oops, take it back" });
    expect(first).toMatchObject({ success: true, data: { retracted: true } });
    const second = await host.handle({ id: "r-2", type: "retract_steer", sessionId, message: "oops, take it back" });
    expect(second).toMatchObject({ success: true, data: { retracted: false } });

    resolveFirst();
    await waitUntil(() => session.active === false);
  });

  test("compact_session drives engine compaction directly without running a model turn", async () => {
    // The `/compact` control op must be deterministic: it calls the engine's
    // compaction machinery (same path auto-compaction uses) and never sends a
    // synthetic "please call the compact tool" user message — so no extra
    // runTurn fires and nothing enters the transcript as a user turn.
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          compactNow: (reason: string) => Promise<unknown>;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const prompts: string[] = [];
    session.engine.runTurn = async (prompt: string) => {
      prompts.push(prompt);
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let compactReason = "";
    session.engine.compactNow = async (reason: string) => {
      compactReason = reason;
      return { messagesCompacted: 3 };
    };

    const response = await host.handle({ id: "k-1", type: "compact_session", sessionId });

    expect(response).toMatchObject({ success: true, command: "compact_session", data: { compacted: true } });
    expect(compactReason).toBe("user requested manual compaction");
    // No model turn ran — the old `/compact` would have pushed a synthetic prompt.
    expect(prompts).toEqual([]);
  });

  test("compact_session on an idle session returns compacted:false when nothing to compact", async () => {
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, { engine: { compactNow: (reason: string) => Promise<unknown> } }>;
    };
    const session = internals.sessions.get(sessionId)!;
    session.engine.compactNow = async () => undefined;

    const response = await host.handle({ id: "k-2", type: "compact_session", sessionId });
    expect(response).toMatchObject({ success: true, command: "compact_session", data: { compacted: false } });
  });

  test("emits authoritative activity state around stop and settle", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    let resolveRun!: () => void;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.interrupt = () => undefined;

    events.length = 0;
    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "running" });
    expect(events.find((event) => event.type === "session_activity")).toMatchObject({
      type: "session_activity",
      sessionId,
      active: true,
      interrupting: false,
    });

    await host.handle({ id: "i-1", type: "interrupt", sessionId });
    expect(events.filter((event) => event.type === "session_activity").at(-1)).toMatchObject({
      type: "session_activity",
      sessionId,
      active: true,
      interrupting: true,
    });

    resolveRun();
    await waitUntil(() =>
      events.some((event) =>
        event.type === "session_activity" &&
        event.sessionId === sessionId &&
        event.active === false &&
        event.interrupting === false
      )
    );
  });

  test("host close settles a running turn before disposing it without late events", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
          dispose: () => Promise<void>;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const order: string[] = [];
    let resolveRun!: () => void;
    let settled = false;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      settled = true;
      order.push("settled");
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let interruptCalls = 0;
    let detachedAtInterrupt = false;
    session.engine.interrupt = () => {
      interruptCalls += 1;
      detachedAtInterrupt = !internals.sessions.has(sessionId);
      order.push("interrupt");
      resolveRun();
    };
    let disposeCalls = 0;
    const dispose = session.engine.dispose.bind(session.engine);
    session.engine.dispose = async () => {
      disposeCalls += 1;
      order.push("dispose");
      await dispose();
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "still running" });
    events.length = 0;
    await host.close();
    if (!settled) {
      resolveRun();
      await waitUntil(() => settled);
    }

    expect(internals.sessions.has(sessionId)).toBe(false);
    expect(detachedAtInterrupt).toBe(true);
    expect(interruptCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(order).toEqual(["interrupt", "settled", "dispose"]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });

  test("concurrent host close waits for the same turn barrier before closing stores", async () => {
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: () => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
        };
      }>;
      stores: Map<string, { close: () => void }>;
    };
    const session = internals.sessions.get(sessionId)!;
    let resolveRun!: () => void;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.interrupt = () => undefined;
    const store = [...internals.stores.values()][0]!;
    const closeStore = store.close.bind(store);
    let storeCloseCalls = 0;
    store.close = () => {
      storeCloseCalls += 1;
      closeStore();
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "still running" });
    const firstClose = host.close();
    const secondClose = host.close();
    await Promise.resolve();
    const storeClosedBeforeTurnSettled = storeCloseCalls > 0;
    resolveRun();
    await Promise.all([firstClose, secondClose]);

    expect(storeClosedBeforeTurnSettled).toBe(false);
    expect(storeCloseCalls).toBe(1);
  });

  test("close_session settles a running turn before disposing it without late events", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          interrupt: () => void;
          dispose: () => Promise<void>;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const order: string[] = [];
    let resolveRun!: () => void;
    let settled = false;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      settled = true;
      order.push("settled");
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let interruptCalls = 0;
    let detachedAtInterrupt = false;
    session.engine.interrupt = () => {
      interruptCalls += 1;
      detachedAtInterrupt = !internals.sessions.has(sessionId);
      order.push("interrupt");
      resolveRun();
    };
    let disposeCalls = 0;
    const dispose = session.engine.dispose.bind(session.engine);
    session.engine.dispose = async () => {
      disposeCalls += 1;
      order.push("dispose");
      await dispose();
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "still running" });
    events.length = 0;
    const response = await host.handle({ id: "close-1", type: "close_session", sessionId });
    if (!settled) await waitUntil(() => settled);

    expect(response).toMatchObject({ success: true, command: "close_session", data: { closed: true } });
    expect(internals.sessions.has(sessionId)).toBe(false);
    expect(detachedAtInterrupt).toBe(true);
    expect(interruptCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(order).toEqual(["interrupt", "settled", "dispose"]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });

  test("close_session settles an approval-resumed loop (no turnPromise) before disposing", async () => {
    // approveTool/answerQuestion drive continueLoop via resolveApproval and
    // never set turnPromise — close must still interrupt and await them
    // (via activeSettled) instead of disposing a running engine.
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          resolveApproval: (callId: string, approved: boolean, options?: unknown) => Promise<unknown>;
          interrupt: () => void;
          dispose: () => Promise<void>;
        };
        active: boolean;
        turnPromise: Promise<void> | null;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    const order: string[] = [];
    let releaseApproval!: () => void;
    session.engine.resolveApproval = async () => {
      await new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      order.push("settled");
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    let interruptCalls = 0;
    session.engine.interrupt = () => {
      interruptCalls += 1;
      order.push("interrupt");
      releaseApproval();
    };
    const dispose = session.engine.dispose.bind(session.engine);
    session.engine.dispose = async () => {
      order.push("dispose");
      await dispose();
    };

    await host.handle({ id: "a-1", type: "approve_tool", sessionId, callId: "call-1", approved: true });
    expect(session.active).toBe(true);
    expect(session.turnPromise).toBeNull();

    const response = await host.handle({ id: "close-1", type: "close_session", sessionId });

    expect(response).toMatchObject({ success: true, command: "close_session", data: { closed: true } });
    expect(interruptCalls).toBe(1);
    expect(order).toEqual(["interrupt", "settled", "dispose"]);
    await host.close();
  });

  test("cold list_sessions reads the directory without minting a ghost session", async () => {
    const host = new AgentHost(() => undefined);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "reina-list-cold-"));
    try {
      const response = await host.handle({ id: "l-1", type: "list_sessions", cwd: workspace });
      expect(response).toMatchObject({ success: true, command: "list_sessions" });
      expect((response as { data: { sessions: string[] } }).data.sessions).toEqual([]);
      // The old cold path constructed a throwaway engine, which minted a
      // brand-new session rollout under .reina/sessions on every listing.
      const leftovers = await readdir(path.join(workspace, ".reina", "sessions")).catch(() => []);
      expect(leftovers).toEqual([]);
    } finally {
      await host.close();
      await rmTempDirWithRetry(workspace);
    }
  });

  test("lists, reads, and stops a real background shell through desktop requests", async () => {
    const host = new AgentHost(() => undefined);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "reina-host-shell-task-"));
    let taskId: string | undefined;
    try {
      const started = await runTool(
        "run_shell",
        {
          command: "node -e \"process.stdout.write('HOST_TASK_READY');setInterval(() => {}, 1000)\"",
          runInBackground: true,
        },
        { cwd: workspace },
      );
      if (!started.output) throw new Error("run_shell did not return a task payload");
      const liveTaskId = (JSON.parse(started.output) as { taskId: string }).taskId;
      taskId = liveTaskId;
      await runTool("monitor", { taskId: liveTaskId, pattern: "HOST_TASK_READY", timeoutMs: 8000 }, { cwd: workspace });

      const listed = await host.handle({
        id: "tasks-1",
        type: "list_background_shell_tasks",
        cwd: workspace,
      });
      expect(listed).toMatchObject({
        success: true,
        command: "list_background_shell_tasks",
        data: { tasks: [{ id: liveTaskId, status: "running" }] },
      });

      const output = await host.handle({
        id: "tasks-2",
        type: "get_background_shell_task_output",
        cwd: workspace,
        taskId: liveTaskId,
      });
      expect((output as { data: { output: string } }).data.output).toContain("HOST_TASK_READY");

      const stopped = await host.handle({
        id: "tasks-3",
        type: "stop_background_shell_task",
        cwd: workspace,
        taskId: liveTaskId,
      });
      expect(stopped).toMatchObject({
        success: true,
        command: "stop_background_shell_task",
        data: { task: { id: liveTaskId, status: "killed" } },
      });
    } finally {
      if (taskId) await runTool("kill_shell", { taskId }, { cwd: workspace }).catch(() => undefined);
      await host.close();
      await rmTempDirWithRetry(workspace);
    }
  });

  test("interrupt is idempotent while the session is already interrupted", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, { engine: { session: { messages: Array<{ content: string }> } } }>;
    };

    events.length = 0;
    await host.handle({ id: "i-1", type: "interrupt", sessionId });
    await host.handle({ id: "i-2", type: "interrupt", sessionId });

    const interruptedMessages = internals.sessions
      .get(sessionId)!
      .engine.session.messages.filter((message) => message.content === "Current turn was interrupted.");
    expect(interruptedMessages).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_interrupted")).toHaveLength(1);
  });

  test("rollback still rejects while a non-interrupted turn is running", async () => {
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
        active: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    let resolveRun!: () => void;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "running" });
    const response = await host.handle({ id: "r-1", type: "rollback_session", sessionId, messageId: "msg-1" });

    expect(response).toMatchObject({
      success: false,
      error: "Cannot roll back while the session is running.",
    });
    resolveRun();
    await waitUntil(() => session.active === false);
  });

  test("rollback waits for an interrupted turn to settle before mutating history", async () => {
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;
    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
          rollbackToMessage: (messageId: string) => Promise<{ session: unknown; restoredMessage?: unknown }>;
        };
        active: boolean;
        interrupting: boolean;
      }>;
    };
    const session = internals.sessions.get(sessionId)!;
    let resolveRun!: () => void;
    let rollbackCalled = false;
    session.engine.runTurn = async () => {
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };
    session.engine.rollbackToMessage = async () => {
      rollbackCalled = true;
      expect(session.active).toBe(false);
      return { session: session.engine.session };
    };

    await host.handle({ id: "m-1", type: "send_message", sessionId, message: "running" });
    await host.handle({ id: "i-1", type: "interrupt", sessionId });
    expect(session.active).toBe(true);
    expect(session.interrupting).toBe(true);

    const rollbackPromise = host.handle({ id: "r-1", type: "rollback_session", sessionId, messageId: "msg-1" });
    await Promise.resolve();
    expect(rollbackCalled).toBe(false);

    resolveRun();
    const response = await rollbackPromise;

    expect(response).toMatchObject({ success: true, command: "rollback_session" });
    expect(rollbackCalled).toBe(true);
  });

  test("shouldWakeForCompletions wakes only when idle, not in autopilot, and a completion is pending", async () => {
    const host = new AgentHost(() => undefined);
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    type FakeSession = {
      active: boolean;
      engine: {
        hasPendingCompletionNotifications: () => boolean;
        session: { autopilot?: { running: boolean }; interrupted?: boolean };
      };
    };
    const internals = host as unknown as {
      sessions: Map<string, FakeSession>;
      shouldWakeForCompletions: (session: FakeSession) => boolean;
    };
    const session = internals.sessions.get(sessionId)!;
    const shouldWake = (s: FakeSession): boolean => internals.shouldWakeForCompletions(s);

    // Stub the engine's pending-completion signal so the gate is the only variable.
    let pending = false;
    session.engine.hasPendingCompletionNotifications = () => pending;

    // Idle + nothing pending -> no wake.
    expect(shouldWake(session)).toBe(false);

    // Idle + a settled background task pending -> wake.
    pending = true;
    expect(shouldWake(session)).toBe(true);

    // A turn is already running -> it will drain at its own boundary, no wake.
    session.active = true;
    expect(shouldWake(session)).toBe(false);
    session.active = false;

    // Autopilot owns the loop (and doesn't set session.active) -> no competing wake.
    session.engine.session.autopilot = { running: true };
    expect(shouldWake(session)).toBe(false);

    // Autopilot stopped -> idle wake resumes.
    session.engine.session.autopilot = { running: false };
    expect(shouldWake(session)).toBe(true);

    // User hit Stop (or paused autopilot): interrupted stays set until the
    // next user-driven turn, so we do NOT auto-resume. The queued completion
    // is not lost — it surfaces when the user next acts.
    session.engine.session.interrupted = true;
    expect(shouldWake(session)).toBe(false);

    // Next user turn clears the flag -> idle wake resumes for later settles.
    session.engine.session.interrupted = false;
    expect(shouldWake(session)).toBe(true);
  });

  test("marks background completion wakes as internal turn events", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const created = await host.handle({ id: "c-1", type: "create_session", cwd: process.cwd() });
    const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

    const internals = host as unknown as {
      sessions: Map<string, {
        engine: {
          hasPendingCompletionNotifications: () => boolean;
          session: unknown;
          runTurn: (prompt: string) => Promise<{ session: unknown; pendingApprovals: []; pendingQuestions: [] }>;
        };
        active: boolean;
      }>;
      wakeForBackgroundCompletions: (sessionId: string) => void;
    };
    const session = internals.sessions.get(sessionId)!;
    let pendingCompletion = true;
    session.engine.hasPendingCompletionNotifications = () => pendingCompletion;
    session.engine.runTurn = async () => {
      pendingCompletion = false;
      return { session: session.engine.session, pendingApprovals: [], pendingQuestions: [] };
    };

    internals.wakeForBackgroundCompletions(sessionId);
    await waitUntil(() => events.some((event) => event.type === "turn_completed"));

    expect(events.filter((event) => event.type === "turn_started").at(-1)?.source).toBe("background_completion");
    expect(events.filter((event) => event.type === "turn_completed").at(-1)?.source).toBe("background_completion");
  });
});
