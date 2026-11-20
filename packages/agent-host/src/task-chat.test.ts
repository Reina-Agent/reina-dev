import { describe, expect, it, vi } from "vitest";
import type { DesktopOutbound } from "@reina/desktop-protocol";
import { AgentHost } from "./index.js";

describe("direct subagent chat requests", () => {
  it("routes to the selected parent and child without starting a parent turn", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const observation = { callId: "message", name: "update_async_task", output: "Update queued" };
    const selected = {
      session: { id: "parent-b" },
      updateAsyncTaskExternal: vi.fn(() => observation),
      runTurn: vi.fn(),
    };
    const other = { updateAsyncTaskExternal: vi.fn(), runTurn: vi.fn() };
    const sessions = (host as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("parent-a", { engine: other });
    sessions.set("parent-b", { engine: selected });

    const response = await host.handle({
      type: "update_async_task_external", sessionId: "parent-b", taskId: "worker-2", message: "requirements changed",
    });
    expect(response).toMatchObject({ success: true, data: observation });
    expect(selected.updateAsyncTaskExternal).toHaveBeenCalledWith("worker-2", "requirements changed");
    expect(other.updateAsyncTaskExternal).not.toHaveBeenCalled();
    expect(selected.runTurn).not.toHaveBeenCalled();
    expect(other.runTurn).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "session_snapshot", sessionId: "parent-b", session: selected.session }]);
  });

  it("returns rejected sends as errors and does not emit an accepted snapshot", async () => {
    const events: DesktopOutbound[] = [];
    const host = new AgentHost((event) => events.push(event));
    const sessions = (host as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("parent", { engine: {
      updateAsyncTaskExternal: () => ({ callId: "message", name: "update_async_task", error: "no such task: missing" }),
    } });
    const request = { type: "update_async_task_external" as const, sessionId: "parent", taskId: "missing", message: "hi" };
    expect(await host.handle(request)).toMatchObject({ success: false, error: "no such task: missing" });
    expect(await host.handle({ ...request, sessionId: "unknown" })).toMatchObject({ success: false, error: "Unknown session: unknown" });
    expect(events).toEqual([]);
  });
});
