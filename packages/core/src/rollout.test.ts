import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  RolloutRecorder,
  ROLLOUT_SCHEMA_VERSION,
  archiveSession,
  decomposeSessionToItems,
  destroySession,
  listSessionHeads,
  loadRolloutAsSession,
  migrateJsonSnapshotToJsonl,
  reduceRolloutItems,
  rolloutPathFor,
  unarchiveSession,
} from "./rollout.js";
import type { RolloutRecorderOptions } from "./rollout.js";
import type { RolloutItem, SessionState } from "@reina/protocol";

let workDir: string;
let recorders: RolloutRecorder[] = [];

beforeEach(async () => {
  recorders = [];
  workDir = path.join(tmpdir(), `reina-rollout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  const openRecorders = recorders;
  recorders = [];
  await Promise.all(openRecorders.map((recorder) => recorder.close()));
  await rm(workDir, { recursive: true, force: true });
});

async function openTestRecorder(filePath: string, opts: RolloutRecorderOptions = {}): Promise<RolloutRecorder> {
  const recorder = await RolloutRecorder.open(filePath, opts);
  recorders.push(recorder);
  return recorder;
}

/** Force the deferred-materialization recorder to create its file on disk:
 * append one no-op config line (+ flush). For tests that need the .jsonl to
 * exist (listSessionHeads / archive / destroy) but don't care what's in it —
 * names the incantation once instead of copy-pasting a fake title append. */
async function materialize(recorder: RolloutRecorder): Promise<void> {
  await recorder.append({ type: "config", changes: {} });
  await recorder.flush();
}

function baseSession(): SessionState {
  return {
    id: "ses_test",
    title: "Initial",
    agent: "default",
    cwd: workDir,
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

describe("RolloutRecorder", () => {
  test("durable append preserves queue order and can be read back immediately", async () => {
    const filePath = path.join(workDir, "durable.jsonl");
    const recorder = await openTestRecorder(filePath, { firstMeta: baseSession() });
    const first = recorder.append({ type: "config", changes: { title: "before" } });
    await recorder.appendDurable({ type: "config", changes: { title: "durable" } });
    await first;
    expect((await loadRolloutAsSession(filePath))?.title).toBe("durable");
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["session_meta", "config", "config"]);
  });

  test("durable write failure rejects while later ordinary appends can recover", async () => {
    const blockedPath = path.join(workDir, "blocked");
    await writeFile(blockedPath, "not a directory");
    const filePath = path.join(blockedPath, "durable.jsonl");
    const recorder = await openTestRecorder(filePath, { firstMeta: baseSession(), logger: () => {} });
    await expect(recorder.appendDurable({ type: "config", changes: { title: "lost" } })).rejects.toBeTruthy();
    await rm(blockedPath);
    await recorder.append({ type: "config", changes: { title: "recovered" } });
    await recorder.flush();
    expect((await loadRolloutAsSession(filePath))?.title).toBe("recovered");
  });

  test("durable fsync failure rejects without poisoning subsequent writes", async () => {
    const filePath = path.join(workDir, "sync-failure.jsonl");
    const recorder = await openTestRecorder(filePath, { firstMeta: baseSession(), logger: () => {} });
    await recorder.append({ type: "config", changes: {} });
    const handle = (recorder as unknown as { handle: FileHandle }).handle;
    const sync = vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("fsync fixture failed"));
    try {
      await expect(recorder.appendDurable({ type: "config", changes: { title: "unconfirmed" } })).rejects.toThrow("fsync fixture failed");
      await recorder.append({ type: "config", changes: { title: "after failure" } });
      await recorder.flush();
      expect((await loadRolloutAsSession(filePath))?.title).toBe("after failure");
    } finally {
      sync.mockRestore();
    }
  });

  test("durable append rejects when the recorder is closed", async () => {
    const recorder = await openTestRecorder(path.join(workDir, "closed.jsonl"));
    await recorder.close();
    await expect(recorder.appendDurable({ type: "config", changes: {} })).rejects.toThrow("closed");
  });

  test("defers file creation until the first append; meta line lands first", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    // No append yet — the file must not exist (untouched sessions leave no
    // ghost file on disk).
    await recorder.flush();
    await expect(stat(filePath)).rejects.toBeTruthy();
    // First real append materializes the file with session_meta first.
    await recorder.append({ type: "config", changes: { title: "Initial" } });
    await recorder.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("session_meta");
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("ses_test");
    expect(loaded?.title).toBe("Initial");
  });

  test("untouched recorder leaves no file after flush + close", async () => {
    const filePath = path.join(workDir, "ses_untouched.jsonl");
    const recorder = await openTestRecorder(filePath, {
      firstMeta: { ...baseSession(), id: "ses_untouched" },
    });
    await recorder.flush();
    await recorder.close();
    await expect(stat(filePath)).rejects.toBeTruthy();
  });

  test("rename via config events: last write wins", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    await recorder.append({ type: "config", changes: { title: "MyName" } });
    await recorder.append({ type: "config", changes: { title: "AutoTitle" } });
    await recorder.append({ type: "config", changes: { title: "Final" } });
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.title).toBe("Final");
  });

  test("interleaved appends preserve order via the serialized queue", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    // Fire 50 renames "in parallel" — they all share the recorder's chain
    // so they end up appended in call order.
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(recorder.append({ type: "config", changes: { title: `T${i}` } }));
    }
    await Promise.all(promises);
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.title).toBe("T49");
  });

  test("message events accumulate", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    await recorder.append({
      type: "message",
      message: { id: "m1", role: "user", content: "hi", createdAt: "2026-01-01T00:01:00.000Z" },
    });
    await recorder.append({
      type: "message",
      message: { id: "m2", role: "assistant", content: "hello", createdAt: "2026-01-01T00:01:01.000Z" },
    });
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.role).toBe("user");
    expect(loaded?.messages[1]?.content).toBe("hello");
  });

  test("provider_state_clear removes replay state", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    await recorder.append({ type: "provider_state", state: { provider: "openai-chat", data: { assistantMessage: {} } } });
    await recorder.append({ type: "provider_state_clear" });
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.providerState).toBeUndefined();
  });

  test("session_replace resets replayed conversation state", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    const kept = { id: "m1", role: "user" as const, content: "keep", createdAt: "2026-01-01T00:01:00.000Z" };
    await recorder.append({ type: "message", message: kept });
    await recorder.append({
      type: "message",
      message: { id: "m2", role: "assistant", content: "remove", createdAt: "2026-01-01T00:01:01.000Z" },
    });
    await recorder.append({ type: "session_replace", session: { ...base, messages: [kept], updatedAt: "2026-01-01T00:02:00.000Z" } });
    await recorder.flush();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.messages.map((m) => m.content)).toEqual(["keep"]);
    expect(loaded?.toolCalls).toEqual([]);
  });

  test("partial last line (crash mid-write) does not nuke previous history", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    await recorder.append({ type: "config", changes: { title: "Persisted" } });
    await recorder.flush();
    await recorder.close();
    // Simulate a torn final write: append a bogus partial line.
    await writeFile(filePath, await readFile(filePath, "utf8") + '{"ts":"2026', { flag: "w" });
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.title).toBe("Persisted");
  });

  test("torn final line logs info while mid-file corruption logs warn with line numbers", async () => {
    const filePath = path.join(workDir, "ses_test.jsonl");
    const base = baseSession();
    const recorder = await openTestRecorder(filePath, {
      firstMeta: {
        id: base.id,
        title: base.title,
        agent: base.agent,
        cwd: base.cwd,
        permissionMode: base.permissionMode,
        model: base.model,
        createdAt: base.createdAt,
      },
    });
    await recorder.append({ type: "config", changes: { title: "Persisted" } });
    await recorder.flush();
    await recorder.close();

    // Torn final write (no trailing newline): expected crash artifact → info.
    await writeFile(filePath, (await readFile(filePath, "utf8")) + '{"ts":"2026', { flag: "w" });
    const tornLogs: Array<{ level: string; message: string }> = [];
    const torn = await loadRolloutAsSession(filePath, { logger: (level, message) => tornLogs.push({ level, message }) });
    expect(torn?.title).toBe("Persisted");
    expect(tornLogs.map((l) => l.level)).toEqual(["info"]);
    expect(tornLogs[0]!.message).toContain("torn final line");

    // Mid-file corruption (garbage line followed by valid, newline-terminated
    // lines): real damage → warn naming the line.
    const good = (await readFile(filePath, "utf8")).split("\n").filter((l) => l.trim() && l !== '{"ts":"2026');
    const corrupted = [good[0]!, "%%% not json %%%", ...good.slice(1)].join("\n") + "\n";
    await writeFile(filePath, corrupted, { flag: "w" });
    const corruptLogs: Array<{ level: string; message: string }> = [];
    const loaded = await loadRolloutAsSession(filePath, { logger: (level, message) => corruptLogs.push({ level, message }) });
    expect(loaded?.title).toBe("Persisted");
    expect(corruptLogs.map((l) => l.level)).toEqual(["warn"]);
    expect(corruptLogs[0]!.message).toContain("corrupt mid-file line(s) at 2");
  });
});

describe("migration", () => {
  test("legacy .json gets decomposed into jsonl events", async () => {
    const jsonPath = path.join(workDir, "ses_test.json");
    const jsonlPath = path.join(workDir, "ses_test.jsonl");
    const session: SessionState = {
      ...baseSession(),
      title: "LegacyTitle",
      messages: [
        { id: "m1", role: "user", content: "hi", createdAt: "2026-01-01T00:01:00.000Z" },
      ],
    };
    await writeFile(jsonPath, JSON.stringify(session));
    const migrated = await migrateJsonSnapshotToJsonl(jsonPath, jsonlPath);
    expect(migrated).toBe(true);
    const loaded = await loadRolloutAsSession(jsonlPath);
    expect(loaded?.title).toBe("LegacyTitle");
    expect(loaded?.messages).toHaveLength(1);
  });
});

describe("decompose round-trip", () => {
  test("decompose then reduce reconstructs the snapshot", () => {
    const session: SessionState = {
      ...baseSession(),
      title: "RT",
      messages: [{ id: "m1", role: "user", content: "x", createdAt: "2026-01-01T00:01:00.000Z" }],
      todos: [{ id: "t1", content: "do thing", activeForm: "doing thing", status: "pending" }],
    };
    const items = decomposeSessionToItems(session);
    const restored = reduceRolloutItems(items);
    expect(restored?.title).toBe("RT");
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.todos[0]?.content).toBe("do thing");
  });
});

describe("rollout reducer — self-evolve log", () => {
  // The review runs detached AFTER the turn's store flush, so its rollout
  // line is the ONLY thing that makes the 💾 notice survive an app quit —
  // relaunch rebuilds the session by replaying the jsonl, not from SQLite.
  test("self_evolve items append to selfEvolveLog and survive a disk round-trip", async () => {
    const filePath = path.join(workDir, "ses_se.jsonl");
    const recorder = await openTestRecorder(filePath, {
      firstMeta: { ...baseSession() },
    });
    await recorder.append({ type: "self_evolve", entry: { summary: "记忆 +2(偏好中文回复)", at: "2026-01-01T00:05:00.000Z" } });
    await recorder.append({ type: "self_evolve", entry: { summary: "技能 1(debug-electron)", at: "2026-01-01T00:10:00.000Z" } });
    await recorder.flush();
    const restored = await loadRolloutAsSession(filePath);
    expect(restored?.selfEvolveLog).toEqual([
      { summary: "记忆 +2(偏好中文回复)", at: "2026-01-01T00:05:00.000Z" },
      { summary: "技能 1(debug-electron)", at: "2026-01-01T00:10:00.000Z" },
    ]);
  });

  test("replay caps the log at the most recent 50 (same cap as the engine push)", () => {
    const items: RolloutItem[] = [
      { type: "session_meta", meta: { ...baseSession() } } as RolloutItem,
      ...Array.from({ length: 60 }, (_, i) =>
        ({ type: "self_evolve", entry: { summary: `review ${i}`, at: "2026-01-01T00:00:00.000Z" } }) as RolloutItem,
      ),
    ];
    const restored = reduceRolloutItems(items);
    expect(restored?.selfEvolveLog).toHaveLength(50);
    expect(restored?.selfEvolveLog?.[0]?.summary).toBe("review 10");
    expect(restored?.selfEvolveLog?.[49]?.summary).toBe("review 59");
  });

  test("decompose emits self_evolve items so snapshot rewrites keep the log", () => {
    const session: SessionState = {
      ...baseSession(),
      selfEvolveLog: [{ summary: "s1", at: "2026-01-01T00:01:00.000Z" }],
    };
    const restored = reduceRolloutItems(decomposeSessionToItems(session));
    expect(restored?.selfEvolveLog).toEqual([{ summary: "s1", at: "2026-01-01T00:01:00.000Z" }]);
  });
});

describe("schema", () => {
  test("ROLLOUT_SCHEMA_VERSION is exported and stable", () => {
    expect(ROLLOUT_SCHEMA_VERSION).toBe(1);
  });
});

describe("config model reduction", () => {
  test("a provider switch replaces the model wholesale and does NOT inherit the old baseUrl", () => {
    // Regression for the cold-start 404: switching kimi (baseUrl api.kimi.com)
    // → codex (no baseUrl) used to shallow-merge, leaking kimi's baseUrl onto
    // the codex config so its Responses request hit the wrong host and 404'd.
    const restored = reduceRolloutItems([
      { type: "session_meta", meta: { ...baseSession() } } as RolloutItem,
      {
        type: "config",
        changes: { model: { provider: "anthropic-messages", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/" } },
      },
      {
        type: "config",
        changes: { model: { provider: "openai-codex-responses", model: "gpt-5.5", baseUrl: undefined } },
      },
    ]);
    expect(restored?.model.provider).toBe("openai-codex-responses");
    expect(restored?.model.model).toBe("gpt-5.5");
    expect(restored?.model.baseUrl).toBeUndefined();
  });

  test("heals a session_replace snapshot that baked in a leaked subscription baseUrl", () => {
    // The user's already-corrupted session: a session_replace snapshot persisted
    // model = codex (subscriptionId) + the leaked kimi baseUrl. Reloading must
    // strip the baseUrl so the Codex request hits its canonical host, not the
    // leaked one — without requiring the user to re-select the model.
    const corrupted: SessionState = {
      ...baseSession(),
      model: {
        provider: "openai-codex-responses",
        model: "gpt-5.5",
        baseUrl: "https://api.kimi.com/coding/",
        subscriptionId: "openai-codex-abc",
      },
    };
    const restored = reduceRolloutItems([
      { type: "session_meta", meta: { ...baseSession() } } as RolloutItem,
      { type: "session_replace", session: corrupted },
    ]);
    expect(restored?.model.baseUrl).toBeUndefined();
    expect(restored?.model.subscriptionId).toBe("openai-codex-abc");
  });

  test("preserves baseUrl on a non-subscription (proxy) model", () => {
    // A third-party proxy model (no subscriptionId) legitimately carries a
    // baseUrl — normalization must not touch it.
    const restored = reduceRolloutItems([
      { type: "session_meta", meta: { ...baseSession() } } as RolloutItem,
      {
        type: "config",
        changes: { model: { provider: "openai-chat", model: "glm-5", baseUrl: "https://api.example.com/v1" } },
      },
    ]);
    expect(restored?.model.baseUrl).toBe("https://api.example.com/v1");
  });
});

describe("durability", () => {
  test("flush() fsyncs and survives close+reopen", async () => {
    const filePath = path.join(workDir, "ses_durable.jsonl");
    const recorder1 = await openTestRecorder(filePath, {
      firstMeta: {
        ...baseSession(),
        id: "ses_durable",
      },
    });
    await recorder1.append({ type: "message", message: { id: "m1", role: "user", content: "hi", createdAt: "2026-01-01T00:01:00.000Z" } });
    await recorder1.flush();
    await recorder1.close();
    // Reopen and append more — the prior writes must still be there.
    const recorder2 = await openTestRecorder(filePath);
    await recorder2.append({ type: "config", changes: { title: "Resumed" } });
    await recorder2.flush();
    await recorder2.close();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.title).toBe("Resumed");
  });

  test("append after close is a silent no-op", async () => {
    const filePath = path.join(workDir, "ses_closed.jsonl");
    const recorder = await openTestRecorder(filePath, { firstMeta: { ...baseSession(), id: "ses_closed" } });
    await materialize(recorder);
    await recorder.close();
    await recorder.append({ type: "config", changes: { title: "ShouldNotPersist" } });
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.title).toBe("Initial");
  });
});

describe("listSessionHeads", () => {
  test("reads title and meta from each session", async () => {
    const sessionsDir = path.join(workDir, ".reina", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const idA = "ses_alpha";
    const idB = "ses_beta";
    const recA = await openTestRecorder(rolloutPathFor(workDir, idA), {
      firstMeta: { ...baseSession(), id: idA, title: "Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    await recA.append({ type: "config", changes: { title: "Alpha renamed" } });
    await recA.flush();
    await recA.close();
    const recB = await openTestRecorder(rolloutPathFor(workDir, idB), {
      firstMeta: { ...baseSession(), id: idB, title: "Beta", createdAt: "2026-01-02T00:00:00.000Z" },
    });
    await materialize(recB);
    await recB.close();

    const heads = await listSessionHeads(workDir);
    expect(heads).toHaveLength(2);
    const a = heads.find((h) => h.sessionId === idA);
    const b = heads.find((h) => h.sessionId === idB);
    expect(a?.title).toBe("Alpha renamed");
    expect(b?.title).toBe("Beta");
    expect(a?.byteSize).toBeGreaterThan(0);
    expect(a?.modifiedMs).toBeGreaterThan(0);
  });

  test("ignores non-jsonl files and malformed jsonl", async () => {
    const sessionsDir = path.join(workDir, ".reina", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "stray.txt"), "ignore me");
    await writeFile(path.join(sessionsDir, "broken.jsonl"), "{not valid json\n");
    const rec = await openTestRecorder(rolloutPathFor(workDir, "ok"), {
      firstMeta: { ...baseSession(), id: "ok", title: "OK", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    await materialize(rec);
    await rec.close();
    const heads = await listSessionHeads(workDir);
    // broken.jsonl has no session_meta so it's filtered; stray.txt has wrong extension.
    expect(heads.map((h) => h.sessionId)).toEqual(["ok"]);
  });
});

describe("archive / destroy", () => {
  test("archiveSession moves jsonl to archived_sessions/ and unarchive flips back", async () => {
    const id = "ses_archive";
    const rec = await openTestRecorder(rolloutPathFor(workDir, id), {
      firstMeta: { ...baseSession(), id, title: "Archivable", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    await materialize(rec);
    await rec.close();
    expect((await listSessionHeads(workDir)).map((h) => h.sessionId)).toContain(id);

    const archived = await archiveSession(workDir, id);
    expect(archived).toBe(true);
    expect((await listSessionHeads(workDir)).map((h) => h.sessionId)).not.toContain(id);
    expect((await listSessionHeads(workDir, { archived: true })).map((h) => h.sessionId)).toContain(id);

    const restored = await unarchiveSession(workDir, id);
    expect(restored).toBe(true);
    expect((await listSessionHeads(workDir)).map((h) => h.sessionId)).toContain(id);
  });

  test("destroySession removes both active and archived copies", async () => {
    const id = "ses_destroy";
    const rec = await openTestRecorder(rolloutPathFor(workDir, id), {
      firstMeta: { ...baseSession(), id, title: "ToDelete", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    await materialize(rec);
    await rec.close();
    await destroySession(workDir, id);
    await expect(stat(rolloutPathFor(workDir, id))).rejects.toBeTruthy();
    expect(await listSessionHeads(workDir)).toEqual([]);
  });
});

describe("recovery", () => {
  test("two-line append, drop file handle externally, next append reopens", async () => {
    const filePath = path.join(workDir, "ses_reopen.jsonl");
    const recorder = await openTestRecorder(filePath, {
      firstMeta: { ...baseSession(), id: "ses_reopen" },
    });
    await recorder.append({ type: "config", changes: { title: "Before" } });
    await recorder.flush();
    // Force the recorder into recovery mode by closing its handle behind its
    // back (simulating fs.close from a signal handler or similar). The next
    // append should detect handle is null and reopen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = recorder as unknown as { handle: { close: () => Promise<void> } | null };
    if (internal.handle) {
      await internal.handle.close();
      internal.handle = null;
    }
    await recorder.append({ type: "config", changes: { title: "After" } });
    await recorder.flush();
    await recorder.close();
    const loaded = await loadRolloutAsSession(filePath);
    expect(loaded?.title).toBe("After");
  });
});

describe("rollout reducer — team mode (Phase C)", () => {
  test("subtask event seeds session.subtasks", () => {
    const meta = baseSession();
    const subtask = {
      id: "sub_abc",
      title: "Plan auth",
      description: "Outline",
      owner: "",
      status: "pending" as const,
      blockedBy: [],
      blocks: [],
      asyncTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const state = reduceRolloutItems([
      {
        type: "session_meta",
        meta: {
          id: meta.id,
          title: meta.title,
          agent: meta.agent,
          cwd: meta.cwd,
          permissionMode: meta.permissionMode,
          model: meta.model,
          createdAt: meta.createdAt,
        },
      },
      { type: "subtask", subtask },
    ]);
    expect(state?.subtasks).toHaveLength(1);
    expect(state?.subtasks?.[0]?.id).toBe("sub_abc");
  });

  test("subtask_update replaces an existing record by id", () => {
    const meta = baseSession();
    const base = {
      id: "sub_abc",
      title: "Plan auth",
      description: "Outline",
      owner: "",
      blockedBy: [],
      blocks: [],
      asyncTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const state = reduceRolloutItems([
      {
        type: "session_meta",
        meta: {
          id: meta.id,
          title: meta.title,
          agent: meta.agent,
          cwd: meta.cwd,
          permissionMode: meta.permissionMode,
          model: meta.model,
          createdAt: meta.createdAt,
        },
      },
      { type: "subtask", subtask: { ...base, status: "pending" } },
      { type: "subtask_update", subtask: { ...base, status: "completed", resultSummary: "done" } },
    ]);
    expect(state?.subtasks).toHaveLength(1);
    expect(state?.subtasks?.[0]?.status).toBe("completed");
    expect(state?.subtasks?.[0]?.resultSummary).toBe("done");
  });

  test("phase event sets session.phase, null clears", () => {
    const meta = baseSession();
    const state = reduceRolloutItems([
      {
        type: "session_meta",
        meta: {
          id: meta.id,
          title: meta.title,
          agent: meta.agent,
          cwd: meta.cwd,
          permissionMode: meta.permissionMode,
          model: meta.model,
          createdAt: meta.createdAt,
        },
      },
      { type: "phase", phase: "exec" },
    ]);
    expect(state?.phase).toBe("exec");
    const cleared = reduceRolloutItems([
      {
        type: "session_meta",
        meta: {
          id: meta.id,
          title: meta.title,
          agent: meta.agent,
          cwd: meta.cwd,
          permissionMode: meta.permissionMode,
          model: meta.model,
          createdAt: meta.createdAt,
        },
      },
      { type: "phase", phase: "exec" },
      { type: "phase", phase: null },
    ]);
    expect(cleared?.phase).toBeUndefined();
  });

  test("decomposeSessionToItems emits subtask + phase items", () => {
    const session: SessionState = {
      ...baseSession(),
      phase: "exec",
      subtasks: [
        {
          id: "sub_abc",
          title: "Plan",
          description: "x",
          owner: "",
          status: "pending",
          blockedBy: [],
          blocks: [],
          asyncTaskIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const items = decomposeSessionToItems(session);
    const types = items.map((i) => i.type);
    expect(types).toContain("subtask");
    expect(types).toContain("phase");
  });
});
