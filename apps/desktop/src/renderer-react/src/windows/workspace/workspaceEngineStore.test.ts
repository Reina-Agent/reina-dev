import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  readSubagentActivity: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("~/lib/bridge", () => ({
  bridge: () => ({
    invoke: mocks.invoke,
    readSubagentActivity: mocks.readSubagentActivity,
    events: {
      on: (name: string, callback: (payload: unknown) => void) => {
        mocks.listeners.set(name, callback);
        return () => mocks.listeners.delete(name);
      },
    },
  }),
}));

import {
  disposeWorkspaceEngineStore,
  getWorkspaceEngineState,
  hydrateTaskActivityFromDisk,
  initWorkspaceEngineStore,
  setWorkspaceSession,
} from "./workspaceEngineStore";

describe("subagent conversation hydration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T10:02:00.000Z"));
    setWorkspaceSession(null);
    mocks.readSubagentActivity.mockReset();
    initWorkspaceEngineStore();
  });
  afterEach(() => {
    disposeWorkspaceEngineStore();
    vi.useRealTimers();
  });

  it("keeps live human messages when disk history arrives after sending", async () => {
    setWorkspaceSession("parent-a");
    let finishRead!: (value: unknown) => void;
    mocks.readSubagentActivity.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const hydrating = hydrateTaskActivityFromDisk("/workspace", "child-a");
    mocks.listeners.get("agent")?.({
      type: "model_stream",
      sessionId: "parent-a",
      event: {
        type: "subagent-event",
        taskId: "child-a",
        event: {
          type: "task-message",
          id: "human-1",
          sender: "user",
          text: "New requirement",
          createdAt: "2026-09-09T10:01:00.000Z",
        },
      },
    });
    finishRead({
      events: [
        {
          timestamp: "2026-09-09T10:00:00.000Z",
          event: {
            type: "task-turn-completed",
            id: "first",
            text: "Previous reply",
            createdAt: "2026-09-09T10:00:00.000Z",
          },
        },
      ],
    });
    expect(await hydrating).toBe(true);
    expect(
      getWorkspaceEngineState()
        .activity.get("child-a")
        ?.map((entry) => entry.text),
    ).toEqual(["Previous reply", "New requirement"]);
  });

  it("discards a previous session's pending history read after switching sessions", async () => {
    setWorkspaceSession("parent-a");
    let finishRead!: (value: unknown) => void;
    mocks.readSubagentActivity.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const hydrating = hydrateTaskActivityFromDisk("/workspace", "child-a");
    setWorkspaceSession("parent-b");
    finishRead({ events: [{ event: { type: "text-delta", text: "Wrong session" } }] });
    expect(await hydrating).toBe(false);
    expect(getWorkspaceEngineState().activity.size).toBe(0);
  });
});
