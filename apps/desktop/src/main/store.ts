import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export type StoreData = Record<string, string>;

export function readStore(name: string): StoreData {
  const filePath = storePath(name);
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as StoreData;
  } catch (error) {
    // A torn/corrupt store must not silently read as {}: the very next
    // writeStoreValue would do a read-modify-write from that empty object and
    // destroy every other key permanently. Set the evidence aside (readers
    // still degrade to {} exactly as before) and log so this is diagnosable.
    try {
      renameSync(filePath, `${filePath}.corrupt`);
    } catch {
      // Best-effort — the backup is diagnostic, not load-bearing.
    }
    console.error(`[store] ${name} was unreadable and has been moved aside as .corrupt: ${String(error)}`);
    return {};
  }
}

export function writeStore(name: string, data: StoreData): void {
  const filePath = storePath(name);
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a half-written
  // store behind (rename replaces atomically on the same volume).
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

export function readStoreValue(name: string, key: string): string | null {
  return readStore(name)[key] ?? null;
}

export function writeStoreValue(name: string, key: string, value: string): void {
  const data = readStore(name);
  data[key] = value;
  writeStore(name, data);
}

export function deleteStoreValue(name: string, key: string): void {
  const data = readStore(name);
  delete data[key];
  writeStore(name, data);
}

function storePath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(app.getPath("userData"), "stores", `${safeName}.json`);
}
