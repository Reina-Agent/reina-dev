import type { ModelStreamEvent, RolloutItem, SessionState } from "@reina/protocol";
import type { SubagentHost } from "./types.js";

/** Shared SubagentManager test fixtures. The manager.*.test.ts files each
 * carried a near-verbatim copy of these stubs; keeping the single source here
 * makes a SubagentHost interface change a one-file edit. Not a test file
 * itself (no .test. in the name), so vitest never collects it. */

export function testSession(over: Partial<SessionState> = {}): SessionState {
  return {
    id: "sess_test",
    cwd: "/tmp/sess",
    agent: "default",
    model: "claude-opus-4-7",
    permissionMode: "auto",
    messages: [],
    toolCalls: [],
    skills: [],
    asyncTasks: [],
    trace: [],
    ...over,
  } as unknown as SessionState;
}

/** Inert SubagentHost. `emitted`/`recorded` collect the live-stream and
 * rollout traffic for tests that assert on it; `over` swaps individual
 * members (e.g. a spawnChild that proves it was never reached). */
export function testHost(session: SessionState, over: Partial<SubagentHost> = {}): {
  host: SubagentHost;
  emitted: ModelStreamEvent[];
  recorded: RolloutItem[];
} {
  const emitted: ModelStreamEvent[] = [];
  const recorded: RolloutItem[] = [];
  const host: SubagentHost = {
    session,
    cwd: session.cwd,
    spawnChild: () => {
      throw new Error("spawnChild not used in this test");
    },
    record: (item) => recorded.push(item),
    emitStream: (event) => emitted.push(event),
    reportBackgroundError: () => undefined,
    onStream: () => () => undefined,
    rollupChildUsage: () => undefined,
    fireCompletionHooks: () => undefined,
    notifyCoordinatorIdle: () => undefined,
    awaitRequiredMcp: async () => undefined,
    requestBubbleApproval: async () => ({ approved: false }),
    requestUserQuestion: async () => ({ cancelled: true }),
    ...over,
  };
  return { host, emitted, recorded };
}
