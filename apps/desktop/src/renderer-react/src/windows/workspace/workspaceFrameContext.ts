export interface WorkspaceFrameContext {
  cwd: string | null;
  sessionId: string | null;
}

export interface WorkspaceFrameContextMessage extends WorkspaceFrameContext {
  type: "reina:workspace-context";
}

export function createWorkspaceFrameContextMessage(
  cwd: string | null,
  sessionId: string | null,
): WorkspaceFrameContextMessage {
  return { type: "reina:workspace-context", cwd, sessionId };
}

export function readWorkspaceFrameContext(message: unknown): WorkspaceFrameContext | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.type !== "reina:workspace-context") return null;
  if (value.cwd !== null && typeof value.cwd !== "string") return null;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return null;
  return {
    cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : null,
    sessionId: typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null,
  };
}
