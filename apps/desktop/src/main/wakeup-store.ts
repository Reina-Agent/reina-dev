import { readFile, rename, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type PersistedWakeup = {
  id: string;
  sessionId: string;
  prompt: string;
  reason: string;
  firesAt: number;
};

export function wakeupStorePath(): string {
  const base = process.env.REINA_HOME ?? path.join(homedir(), ".reina");
  return path.join(base, "wakeups.json");
}

export async function loadPersistedWakeups(filePath = wakeupStorePath()): Promise<PersistedWakeup[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistedWakeup);
  } catch {
    return [];
  }
}

let writeChain: Promise<void> = Promise.resolve();

export function savePersistedWakeups(
  wakeups: ReadonlyArray<PersistedWakeup>,
  filePath = wakeupStorePath(),
): Promise<void> {
  const next = writeChain.then(() => writeAtomic(filePath, wakeups));
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeAtomic(filePath: string, wakeups: ReadonlyArray<PersistedWakeup>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (wakeups.length === 0) {
    try {
      await unlink(filePath);
    } catch {
      // file may not exist; that's fine
    }
    return;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(wakeups, null, 2), "utf8");
  await rename(tmp, filePath);
}

function isPersistedWakeup(value: unknown): value is PersistedWakeup {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && typeof v.sessionId === "string"
    && typeof v.prompt === "string"
    && typeof v.reason === "string"
    && typeof v.firesAt === "number"
    && Number.isFinite(v.firesAt)
  );
}
