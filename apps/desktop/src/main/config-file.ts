import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Live readers must see either the previous config or the complete new one. */
export async function writeConfigFile(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
