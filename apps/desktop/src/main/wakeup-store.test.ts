import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadPersistedWakeups,
  savePersistedWakeups,
  type PersistedWakeup,
} from "./wakeup-store.js";

async function tempFile(): Promise<string> {
  const dir = path.join(os.tmpdir(), `reina-wakeup-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return path.join(dir, "wakeups.json");
}

const sample = (overrides: Partial<PersistedWakeup> = {}): PersistedWakeup => ({
  id: "wake-abc",
  sessionId: "sess-1",
  prompt: "say hi",
  reason: "test",
  firesAt: 1_700_000_000_000,
  ...overrides,
});

describe("wakeup-store", () => {
  it("returns empty array when file is missing", async () => {
    const file = await tempFile();
    const loaded = await loadPersistedWakeups(file);
    expect(loaded).toEqual([]);
  });

  it("roundtrips saved entries", async () => {
    const file = await tempFile();
    const entries = [sample({ id: "wake-a" }), sample({ id: "wake-b", sessionId: "sess-2" })];
    await savePersistedWakeups(entries, file);
    const loaded = await loadPersistedWakeups(file);
    expect(loaded).toEqual(entries);
  });

  it("deletes the file when saving an empty array", async () => {
    const file = await tempFile();
    await savePersistedWakeups([sample()], file);
    expect(existsSync(file)).toBe(true);
    await savePersistedWakeups([], file);
    expect(existsSync(file)).toBe(false);
  });

  it("filters malformed entries on load", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify([
        sample({ id: "wake-good" }),
        { id: "wake-missing-fields" },
        "not-an-object",
        sample({ id: "wake-also-good" }),
      ]),
      "utf8",
    );
    const loaded = await loadPersistedWakeups(file);
    expect(loaded.map((w) => w.id)).toEqual(["wake-good", "wake-also-good"]);
  });

  it("returns empty when JSON is corrupt", async () => {
    const file = await tempFile();
    await writeFile(file, "{not json", "utf8");
    expect(await loadPersistedWakeups(file)).toEqual([]);
  });

  it("does not leave .tmp files behind on success", async () => {
    const file = await tempFile();
    await savePersistedWakeups([sample()], file);
    const dir = path.dirname(file);
    const stragglers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
    expect(stragglers).toEqual([]);
  });

  it("serializes concurrent writes (last call wins)", async () => {
    const file = await tempFile();
    await Promise.all([
      savePersistedWakeups([sample({ id: "wake-1" })], file),
      savePersistedWakeups([sample({ id: "wake-2" })], file),
      savePersistedWakeups([sample({ id: "wake-3" })], file),
    ]);
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as PersistedWakeup[];
    expect(parsed).toHaveLength(1);
    expect(["wake-1", "wake-2", "wake-3"]).toContain(parsed[0]!.id);
  });
});
