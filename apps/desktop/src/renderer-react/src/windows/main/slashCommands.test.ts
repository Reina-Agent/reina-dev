import { describe, expect, it, vi } from "vitest";

vi.mock("./sessionStore", () => ({
  getMainState: () => ({
    working: false,
    stopping: false,
    sessionId: "test-session",
    workspaceCwd: "C:/workspace",
    pendingPermissions: [],
    pendingQuestions: [],
  }),
}));

import { resolveSlashCommandAcceptance } from "./slashCommands";

describe("slash command acceptance", () => {
  it("opens the dedicated Goal composer when /goal is selected", () => {
    expect(resolveSlashCommandAcceptance("/goal")).toEqual({ kind: "composer", mode: "goal" });
    expect(resolveSlashCommandAcceptance("/GOAL")).toEqual({ kind: "composer", mode: "goal" });
  });

  it("keeps other commands on the staged send path", () => {
    expect(resolveSlashCommandAcceptance("/plan")).toEqual({ kind: "prompt", value: "/plan " });
  });
});
