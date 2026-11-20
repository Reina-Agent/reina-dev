import { describe, expect, it, vi } from "vitest";
import type { DesktopOutbound } from "@reina/desktop-protocol";
import { AgentHost } from "./index.js";

describe("context history requests", () => {
  it("reads only the selected session and child without starting a model turn", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const history = { requests: [], events: [], retentionLimit: 100 };
    const selected = {
      getContextHistory: vi.fn(async () => history),
      getContextRequest: vi.fn(async () => null),
      runTurn: vi.fn(),
    };
    const other = { getContextHistory: vi.fn(), getContextRequest: vi.fn(), runTurn: vi.fn() };
    const sessions = (host as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("parent-a", { engine: other });
    sessions.set("parent-b", { engine: selected });

    expect(await host.handle({ type: "get_context_history", sessionId: "parent-b" }))
      .toMatchObject({ success: true, data: history });
    expect(selected.getContextHistory).toHaveBeenLastCalledWith(undefined);
    expect(await host.handle({ type: "get_context_history", sessionId: "parent-b", taskId: "worker" }))
      .toMatchObject({ success: true, data: history });
    expect(selected.getContextHistory).toHaveBeenLastCalledWith("worker");
    expect(await host.handle({ type: "get_context_request", sessionId: "parent-b", taskId: "worker", requestId: "old-request" }))
      .toMatchObject({ success: true, data: null });
    expect(selected.getContextRequest).toHaveBeenCalledWith("old-request", "worker");
    expect(other.getContextHistory).not.toHaveBeenCalled();
    expect(other.getContextRequest).not.toHaveBeenCalled();
    expect(selected.runTurn).not.toHaveBeenCalled();
    expect(other.runTurn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("returns unknown sessions and rejected child reads as errors", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const sessions = (host as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("parent", { engine: {
      getContextHistory: async () => { throw new Error("no such task: foreign-child"); },
    } });
    expect(await host.handle({ type: "get_context_history", sessionId: "missing" }))
      .toMatchObject({ success: false, error: "Unknown session: missing" });
    expect(await host.handle({ type: "get_context_history", sessionId: "parent", taskId: "foreign-child" }))
      .toMatchObject({ success: false, error: "no such task: foreign-child" });
    expect(events).toEqual([]);
  });
});
