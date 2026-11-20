import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@reina/protocol";

const store = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("./store.js", () => ({
  readStoreValue: vi.fn(() => store.value),
  writeStoreValue: vi.fn((_name: string, _key: string, value: string) => {
    store.value = value;
  }),
}));
vi.mock("./apps.js", () => ({ execFilePromise: vi.fn() }));

import {
  loadDesktopState,
  saveDesktopState,
  syncSessionIndexFromSnapshot,
  syncSessionTitle,
  type DesktopState,
} from "./desktop-state.js";

const cwd = process.cwd();

beforeEach(() => {
  store.value = null;
});

describe("syncSessionIndexFromSnapshot", () => {
  it("updates a background session without stealing active or manual sidebar state", () => {
    const state: DesktopState = {
      version: 1,
      activeProjectId: "project-active",
      activeWorkspaceId: "workspace-active",
      activeSessionId: "session-active",
      projects: [project("project-active"), project("project-background")],
      workspaces: [
        workspace("workspace-active", "project-active"),
        workspace("workspace-background", "project-background"),
      ],
      sessions: [
        indexedSession("session-active", "project-active", "workspace-active", "Active"),
        {
          ...indexedSession("session-background", "project-background", "workspace-background", "Reina"),
          pinnedAt: "2026-01-02T00:00:00.000Z",
          archivedAt: "2026-01-03T00:00:00.000Z",
          orderTs: "2026-01-04T00:00:00.000Z",
        },
      ],
      projectOrder: ["project-active", "project-background"],
    };
    saveDesktopState(state);

    const updated = syncSessionIndexFromSnapshot(sessionSnapshot());
    const background = updated.sessions.find((session) => session.id === "session-background");

    expect(background).toMatchObject({
      title: "Generated title",
      messageCount: 2,
      toolCount: 1,
      updatedAt: "2026-01-01T00:00:02.000Z",
      pinnedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: "2026-01-03T00:00:00.000Z",
      orderTs: "2026-01-04T00:00:00.000Z",
    });
    expect(updated.activeProjectId).toBe("project-active");
    expect(updated.activeWorkspaceId).toBe("workspace-active");
    expect(updated.activeSessionId).toBe("session-active");
    expect(loadDesktopState()).toEqual(updated);

    const afterStaleCreation = syncSessionIndexFromSnapshot({
      ...sessionSnapshot(),
      title: "Reina",
    });
    expect(afterStaleCreation.sessions.find((session) => session.id === "session-background")?.title).toBe(
      "Generated title",
    );
  });
});

describe("syncSessionTitle", () => {
  it("conditionally updates only the target row and rejects stale follow-ups", () => {
    const state: DesktopState = {
      version: 1,
      activeProjectId: "project-active",
      activeWorkspaceId: "workspace-active",
      activeSessionId: "session-active",
      projects: [project("project-active"), project("project-background")],
      workspaces: [
        workspace("workspace-active", "project-active"),
        workspace("workspace-background", "project-background"),
      ],
      sessions: [
        indexedSession("session-active", "project-active", "workspace-active", "Active"),
        {
          ...indexedSession("session-background", "project-background", "workspace-background", "Reina"),
          pinnedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      projectOrder: ["project-active", "project-background"],
    };
    saveDesktopState(state);

    syncSessionTitle("session-background", "Fix automatic naming", "Reina");
    const generated = syncSessionTitle("session-background", "Repair sidebar titles", "Fix automatic naming").state;
    expect(generated.sessions.find((session) => session.id === "session-background")).toMatchObject({
      title: "Repair sidebar titles",
      pinnedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(generated.activeSessionId).toBe("session-active");

    const afterStaleSnapshot = syncSessionIndexFromSnapshot({
      ...sessionSnapshot(),
      title: "Fix automatic naming",
    });
    expect(afterStaleSnapshot.sessions.find((session) => session.id === "session-background")?.title).toBe(
      "Repair sidebar titles",
    );

    const afterStaleGeneratedEvent = syncSessionTitle(
      "session-background",
      "Late generated title",
      "Fix automatic naming",
    ).state;
    expect(afterStaleGeneratedEvent.sessions.find((session) => session.id === "session-background")?.title).toBe(
      "Repair sidebar titles",
    );

    const afterAuthoritativeSnapshot = syncSessionIndexFromSnapshot({
      ...sessionSnapshot(),
      title: "Repair sidebar titles",
    });
    const observed = afterAuthoritativeSnapshot.sessions.find((session) => session.id === "session-background");
    expect(observed?.title).toBe("Repair sidebar titles");
    expect(observed?.pendingObservedTitle).toBeUndefined();
  });

  it("registers a title event that wins the session-created registration race", () => {
    const state: DesktopState = {
      version: 1,
      activeProjectId: "project-active",
      activeWorkspaceId: "workspace-active",
      activeSessionId: "session-active",
      projects: [project("project-active")],
      workspaces: [workspace("workspace-active", "project-active")],
      sessions: [indexedSession("session-active", "project-active", "workspace-active", "Active")],
      projectOrder: ["project-active"],
    };
    saveDesktopState(state);
    const snapshot = { ...sessionSnapshot(), id: "session-new", title: "Reina" };

    const result = syncSessionTitle("session-new", "Name the new branch", "Reina", snapshot);

    expect(result.applied).toBe(true);
    expect(result.state.sessions.find((session) => session.id === "session-new")?.title).toBe("Name the new branch");
    expect(result.state.activeSessionId).toBe("session-active");
  });

  it("heals a stale provisional row from a final title after a cold reload", () => {
    const state: DesktopState = {
      version: 1,
      activeProjectId: "project-active",
      activeWorkspaceId: "workspace-active",
      activeSessionId: "session-active",
      projects: [project("project-active"), project("project-background")],
      workspaces: [
        workspace("workspace-active", "project-active"),
        workspace("workspace-background", "project-background"),
      ],
      sessions: [
        indexedSession("session-active", "project-active", "workspace-active", "Active"),
        indexedSession("session-background", "project-background", "workspace-background", "Fix automatic naming"),
      ],
      projectOrder: ["project-active", "project-background"],
    };
    saveDesktopState(state);

    const repaired = syncSessionIndexFromSnapshot({
      ...sessionSnapshot(),
      title: "Persisted generated title",
    });

    expect(repaired.sessions.find((session) => session.id === "session-background")?.title).toBe(
      "Persisted generated title",
    );
  });
});

function project(id: string) {
  return {
    id,
    root: cwd,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
}

function workspace(id: string, projectId: string) {
  return {
    id,
    projectId,
    cwd,
    type: "local" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };
}

function indexedSession(id: string, projectId: string, workspaceId: string, title: string) {
  return {
    id,
    projectId,
    workspaceId,
    cwd,
    title,
    agent: "default",
    model: "deterministic/reina-deterministic",
    permissionMode: "default",
    messageCount: 0,
    toolCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sessionSnapshot(): SessionState {
  return {
    id: "session-background",
    title: "Generated title",
    agent: "default",
    cwd,
    permissionMode: "default",
    model: { provider: "deterministic", model: "reina-deterministic" },
    messages: [
      { id: "msg-user", role: "user", content: "Fix the title", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "msg-assistant", role: "assistant", content: "Done", createdAt: "2026-01-01T00:00:02.000Z" },
    ],
    toolCalls: [
      {
        id: "tool-1",
        name: "read_file",
        input: { path: "README.md" },
        permission: "read",
        status: "completed",
        summary: "Read README.md",
        createdAt: "2026-01-01T00:00:01.500Z",
      },
    ],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
  };
}
