import type { MessageAttachment, ToolDescriptor } from "@reina/protocol";

export type ToolProgress = {
  status: "running" | "completed" | "failed";
  command?: string;
  message?: string;
  output?: string;
  elapsedMs?: number;
  totalLines?: number;
  totalBytes?: number;
  taskId?: string;
};

/** Bridge to host-side capabilities (Electron Notification, desktopCapturer,
 * persistent wake-up timers). Undefined in environments without an Electron
 * main process (tests, headless agent-host). Tools that need it should fail
 * with a clear error rather than crash when undefined. */
export type ToolHostBridge = (kind: string, params: unknown) => Promise<unknown>;

export type ToolRuntimeOptions = {
  cwd: string;
  signal?: AbortSignal;
  readFileTimestamps?: Record<string, number>;
  onProgress?: (progress: ToolProgress) => void;
  hostBridge?: ToolHostBridge;
  /** MCP server allow-list from the active agent profile. Undefined or empty
   * preserves the legacy unrestricted behavior. MCP discovery and meta-tools
   * use this to constrain schemas, explicit access, fan-out, and status. */
  allowedMcpServers?: ReadonlyArray<string>;
  /** The current session's id, for tools that need to identify themselves
   * to the host (e.g. schedule_wakeup needs this so the wakeup dispatches
   * to the right engine). */
  sessionId?: string;
  toolCallId?: string;
  /** Session-scoped task notifications that can interrupt a passive wait. */
  taskEvents?: {
    hasPending(): boolean;
    subscribe(listener: () => void): () => void;
  };
};

export type ToolExecutionResult = {
  output: string;
  /** Visual payloads (images) the tool produced alongside its text output —
   * e.g. read_file on a PNG returns a short text note here in `output` plus
   * the decoded image in `attachments`. The engine threads these onto the
   * ToolObservation so the model can see them in the tool_result (Anthropic
   * path) instead of only reading about them. */
  attachments?: MessageAttachment[];
  metadata?: {
    readFiles?: Array<{ path: string; mtimeMs: number }>;
    /** Tool names that should be unmasked for the rest of the session. Set
     * by `search_tool` when it returns matches; consumed by the engine,
     * which adds them to `session.activeDeferredTools` and emits a
     * rollout event so the unmask persists across reload. */
    unmaskTools?: string[];
  };
};

export type ToolImplementation = {
  descriptor: ToolDescriptor;
  execute(input: unknown, options: ToolRuntimeOptions): Promise<string | ToolExecutionResult>;
  preview?(input: unknown, options: ToolRuntimeOptions): Promise<string | undefined>;
};
