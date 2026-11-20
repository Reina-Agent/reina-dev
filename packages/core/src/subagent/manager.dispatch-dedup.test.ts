import { describe, expect, it } from "vitest";
import type {
  AsyncTaskRecord,
  SessionState,
  ToolCallRecord,
} from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import type { SubagentHost } from "./types.js";
import { SubagentManager } from "./manager.js";
import { testHost, testSession } from "./test-helpers.js";

/** Re-issuing a brief that already has a LIVE child (running or resuming)
 * must collapse onto the original instead of spawning a duplicate. This is
 * the deterministic backstop for weaker coordinator models that replay
 * prior tool output and re-dispatch already-in-flight work. The sync
 * `task` path had no dedup at all before this; start_async_task only
 * caught `running` (not `resuming`). */

function session(): SessionState {
  return testSession({ id: "sess_dispatch_dedup", cwd: "/tmp/dd" });
}

function host(s: SessionState): SubagentHost {
  return testHost(s, {
    // A deduped dispatch must return BEFORE spawning — this throws to prove it.
    spawnChild: () => {
      throw new Error("spawnChild should not run for a deduped dispatch");
    },
  }).host;
}

function liveTask(id: string, status: AsyncTaskRecord["status"]): AsyncTaskRecord {
  return {
    id,
    agent: "default",
    description: "build the full-stack env",
    status,
    startedAt: nowIso(),
    isolation: "none",
  } as AsyncTaskRecord;
}

function dispatchCall(name: "task" | "start_async_task", input: Record<string, unknown>): ToolCallRecord {
  return {
    id: `call_${createId("call").slice(-6)}`,
    name: name as ToolCallRecord["name"],
    input,
    summary: name,
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  } as unknown as ToolCallRecord;
}

describe("dispatch dedup — re-issuing a live brief merges instead of spawning", () => {
  it("start_async_task merges onto a still-running same-brief task", async () => {
    const s = session();
    s.asyncTasks = [liveTask("sub_orig", "running")];
    const mgr = new SubagentManager(host(s));
    const obs = await mgr.startAsync(
      dispatchCall("start_async_task", { description: "build the full-stack env", agent: "default" }),
    );
    expect(obs.output).toContain("<status>merged</status>");
    expect(obs.output).toContain("sub_orig");
    expect(obs.error).toBeUndefined();
  });

  it("start_async_task also merges onto a resuming same-brief task", async () => {
    const s = session();
    s.asyncTasks = [liveTask("sub_resume", "resuming")];
    const mgr = new SubagentManager(host(s));
    const obs = await mgr.startAsync(dispatchCall("start_async_task", { description: "build the full-stack env" }));
    expect(obs.output).toContain("<status>merged</status>");
    expect(obs.output).toContain("sub_resume");
  });

  it("sync task merges onto a live same-brief child (previously had no dedup)", async () => {
    const s = session();
    s.asyncTasks = [liveTask("sub_sync", "running")];
    const mgr = new SubagentManager(host(s));
    // The throwing spawnChild mock proves the merge path returns before spawn.
    const obs = await mgr.runSync(dispatchCall("task", { description: "build the full-stack env", subagentType: "default" }));
    expect(obs.output).toContain("<status>merged</status>");
    expect(obs.output).toContain("sub_sync");
    expect(obs.error).toBeUndefined();
  });

  it("a genuinely different brief is NOT merged (no false positive)", async () => {
    const s = session();
    s.asyncTasks = [liveTask("sub_orig", "running")];
    const mgr = new SubagentManager(host(s));
    // Different brief → must NOT merge → falls through to spawnChild, which
    // the mock throws; runSync catches and surfaces it as an error observation.
    const obs = await mgr.runSync(dispatchCall("task", { description: "audit the SSTI sinks", subagentType: "default" }));
    expect(obs.output ?? "").not.toContain("merged");
    expect(obs.error).toContain("spawnChild");
  });
});
