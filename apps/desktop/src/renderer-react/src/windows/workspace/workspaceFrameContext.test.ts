import { describe, expect, it } from "vitest";
import { createWorkspaceFrameContextMessage, readWorkspaceFrameContext } from "./workspaceFrameContext";

describe("workspace frame context", () => {
  it("round-trips the active workspace and session", () => {
    const message = createWorkspaceFrameContextMessage("F:/projects/reina", "session-1");
    expect(readWorkspaceFrameContext(message)).toEqual({
      cwd: "F:/projects/reina",
      sessionId: "session-1",
    });
  });

  it("represents a draft or closed workspace with nulls", () => {
    expect(readWorkspaceFrameContext(createWorkspaceFrameContextMessage(null, null))).toEqual({
      cwd: null,
      sessionId: null,
    });
  });

  it("ignores unrelated or malformed frame messages", () => {
    expect(readWorkspaceFrameContext({ type: "reina:workspace-ready" })).toBeNull();
    expect(
      readWorkspaceFrameContext({
        type: "reina:workspace-context",
        cwd: 42,
        sessionId: "session-1",
      }),
    ).toBeNull();
  });
});
