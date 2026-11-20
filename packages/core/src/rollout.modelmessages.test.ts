import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { RolloutRecorder, loadRolloutAsSession } from "./rollout.js";
import type { ChatMessage, SessionState } from "@reina/protocol";

/** A message appended AFTER a compaction must replay into BOTH messages and
 * modelMessages. The live engine's appendMessage double-pushes; the rollout
 * `message` reducer must mirror that, or reload freezes modelMessages at the
 * compaction boundary and the model silently loses every turn spoken between
 * the compaction and the reload (they survive only in the visible transcript). */

let workDir: string;
let recorders: RolloutRecorder[] = [];

beforeEach(async () => {
  recorders = [];
  workDir = path.join(tmpdir(), `reina-rollout-mm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  const open = recorders;
  recorders = [];
  await Promise.all(open.map((r) => r.close()));
  await rm(workDir, { recursive: true, force: true });
});

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

async function openRecorder(id: string): Promise<{ recorder: RolloutRecorder; filePath: string }> {
  const filePath = path.join(workDir, `${id}.jsonl`);
  const recorder = await RolloutRecorder.open(filePath, {
    firstMeta: {
      id,
      title: "t",
      agent: "default",
      cwd: workDir,
      permissionMode: "default",
      model: { provider: "deterministic", model: "reina-deterministic" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  recorders.push(recorder);
  return { recorder, filePath };
}

describe("rollout replay preserves post-compaction modelMessages", () => {
  test("a message appended AFTER a compaction session_replace lands in modelMessages on reload", async () => {
    const { recorder, filePath } = await openRecorder("ses_mm");

    // Pre-compaction user turn.
    await recorder.append({ type: "message", message: msg("m1", "user", "original question") });

    // Compaction: modelMessages collapses to [summary]; messages keeps m1.
    // This is exactly what recordCompaction persists (session_replace with the
    // freshly-set session.modelMessages).
    const compacted: SessionState = {
      id: "ses_mm",
      title: "t",
      agent: "default",
      cwd: workDir,
      permissionMode: "default",
      model: { provider: "deterministic", model: "reina-deterministic" },
      messages: [msg("m1", "user", "original question")],
      modelMessages: [msg("sum1", "user", "[post-compact] summary of earlier turns")],
      toolCalls: [],
      todos: [],
      pendingQuestions: [],
      skills: [],
      trace: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as SessionState;
    await recorder.append({ type: "session_replace", session: compacted });

    // Post-compaction turns. The live engine double-pushes each into messages
    // AND modelMessages, but records each as a plain "message" event.
    await recorder.append({ type: "message", message: msg("m2", "user", "follow-up the model must still see") });
    await recorder.append({ type: "message", message: msg("m3", "assistant", "answer to the follow-up") });

    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);

    // Durable transcript always keeps everything — never the failing side.
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);

    // The model view MUST advance past the compaction boundary. Freezing at
    // [sum1] is the bug: the model would forget m2/m3 after a reload.
    const mmIds = loaded?.modelMessages?.map((m) => m.id);
    expect(mmIds).toContain("m2");
    expect(mmIds).toContain("m3");
    expect(mmIds).toEqual(["sum1", "m2", "m3"]);
  });

  test("never-compacted sessions keep modelMessages undefined (falls back to messages)", async () => {
    const { recorder, filePath } = await openRecorder("ses_plain");
    await recorder.append({ type: "message", message: msg("m1", "user", "hi") });
    await recorder.append({ type: "message", message: msg("m2", "assistant", "hello") });
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);

    // No compaction happened → no modelMessages view; modelMessages() falls
    // back to messages. The fix must NOT synthesize an empty view here.
    expect(loaded?.modelMessages).toBeUndefined();
    expect(loaded?.messages).toHaveLength(2);
  });
});
