import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@reina/protocol";

const mocks = vi.hoisted(() => ({
  activeSessionId: "session-cache",
  syncSessionTitle: vi.fn(() => ({ state: {}, applied: true })),
  getAllWindows: vi.fn((): unknown[] => []),
  readStoreValue: vi.fn((_name: string, _key: string): string | null => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));
vi.mock("./store.js", () => ({ readStoreValue: mocks.readStoreValue }));
vi.mock("./desktop-state.js", () => ({
  loadDesktopState: () => ({ activeSessionId: mocks.activeSessionId }),
  syncSessionIndexFromSnapshot: vi.fn(),
  syncSessionTitle: mocks.syncSessionTitle,
}));

import { AgentHostController, compactionEnv, forgetSessionSnapshot, replayEngineSnapshotTo, sendRendererEvent } from "./agent-host-controller.js";

afterEach(() => {
  forgetSessionSnapshot("session-cache");
  mocks.syncSessionTitle.mockClear();
  mocks.getAllWindows.mockReset().mockReturnValue([]);
  mocks.readStoreValue.mockReset().mockReturnValue(null);
});

describe("compaction startup preferences", () => {
  it("preserves unconfigured environment settings and defaults the percentage to 70", () => {
    expect(compactionEnv()).toEqual({ REINA_COMPACTION_TRIGGER_PERCENT: "70" });
  });

  it("removes an inherited percentage when the user saved buffer mode", () => {
    mocks.readStoreValue.mockImplementation((_name, key) => key === "compactionTriggerPercent" ? "0" : null);
    const env = { REINA_COMPACTION_TRIGGER_PERCENT: "90", ...compactionEnv() };
    expect(env.REINA_COMPACTION_TRIGGER_PERCENT).toBeUndefined();
  });

  it("projects all configured compaction preferences into a new host", () => {
    const settings: Record<string, string> = {
      compactionAuto: "false",
      compactionOffload: "true",
      compactionTriggerPercent: "80",
      compactionBufferTokens: "24000",
      compactionKeepRecent: "16",
    };
    mocks.readStoreValue.mockImplementation((_name, key) => settings[key] ?? null);
    expect(compactionEnv()).toEqual({
      REINA_COMPACTION_AUTO: "0",
      REINA_COMPACTION_OFFLOAD: "1",
      REINA_COMPACTION_TRIGGER_PERCENT: "80",
      REINA_COMPACTION_BUFFER_TOKENS: "24000",
      REINA_COMPACTION_KEEP_RECENT: "16",
    });
  });
});

describe("sendRendererEvent", () => {
  it.each(["model_stream", "session_snapshot"])("sends %s to chat and workspace but excludes the reusable menu", (type) => {
    const windows = ["main.html", "workspace.html", "conversation-menu.html"].map((page) => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        getURL: () => `file:///reina/renderer-react/${page}`,
        send: vi.fn(),
      },
    }));
    mocks.getAllWindows.mockReturnValue(windows);
    const payload = { type, sessionId: "session-cache" };

    sendRendererEvent("agent", payload);

    expect(windows[0].webContents.send).toHaveBeenCalledWith("reina:event:agent", payload);
    expect(windows[1].webContents.send).toHaveBeenCalledWith("reina:event:agent", payload);
    expect(windows[2].webContents.send).not.toHaveBeenCalled();
  });
});

describe("AgentHostController title cache", () => {
  it("folds an accepted title event into the snapshot replayed to a new window", () => {
    const controller = new AgentHostController({
      repoRoot: process.cwd(),
      log: () => undefined,
    });
    const handleLine = (controller as unknown as { handleLine(line: string): void }).handleLine.bind(controller);
    handleLine(
      JSON.stringify({
        type: "session_snapshot",
        sessionId: "session-cache",
        session: sessionSnapshot(),
      }),
    );
    handleLine(
      JSON.stringify({
        type: "session_title_updated",
        sessionId: "session-cache",
        title: "Generated title",
        expectedTitle: "Reina",
        source: "generated",
      }),
    );

    const send = vi.fn();
    replayEngineSnapshotTo({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    } as never);

    expect(mocks.syncSessionTitle).toHaveBeenCalledWith(
      "session-cache",
      "Generated title",
      "Reina",
      expect.objectContaining({ id: "session-cache", title: "Reina" }),
    );
    expect(send).toHaveBeenCalledWith(
      "reina:event:agent",
      expect.objectContaining({
        sessionId: "session-cache",
        session: expect.objectContaining({ title: "Generated title" }),
      }),
    );
  });
});

function sessionSnapshot(): SessionState {
  return {
    id: "session-cache",
    title: "Reina",
    agent: "default",
    cwd: process.cwd(),
    permissionMode: "default",
    model: { provider: "deterministic", model: "reina-deterministic" },
    messages: [],
    toolCalls: [],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
