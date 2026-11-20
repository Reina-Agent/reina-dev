import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "./engine.js";

/** Same-batch tool dedup (kimi tool-dedup's same-step layer): two IDENTICAL
 * (name, canonical-args) calls in ONE assistant response execute once — the
 * twin mirrors a short pointer instead of re-running the tool. The
 * deterministic provider's `dup_read <path>` directive plans exactly that
 * shape. */

let cwd: string;
let oldConfigHome: string | undefined;

async function rmTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-tool-dedup-"));
  oldConfigHome = process.env.REINA_CONFIG_HOME;
  process.env.REINA_CONFIG_HOME = path.join(cwd, "home-config");
  await writeFile(path.join(cwd, "target.txt"), "file body for dedup test", "utf8");
});

afterEach(async () => {
  if (oldConfigHome === undefined) delete process.env.REINA_CONFIG_HOME;
  else process.env.REINA_CONFIG_HOME = oldConfigHome;
  await rmTempDirWithRetry(cwd);
});

describe("same-batch tool dedup", () => {
  it("executes an identical twin call once and mirrors a pointer for the duplicate", async () => {
    const engine = await AgentEngine.create({ cwd, agent: "default" });
    await engine.runTurn("dup_read target.txt");

    const reads = engine.session.toolCalls.filter((call) => call.name === "read_file");
    expect(reads.length).toBe(2);

    const [original, twin] = reads;
    // The original ran for real.
    expect(original!.status).toBe("completed");
    expect(original!.output).toContain("file body for dedup test");
    // The twin did NOT re-execute: short pointer at the original, no file body.
    expect(twin!.status).toBe("completed");
    expect(twin!.output).toContain("Duplicate tool call");
    expect(twin!.output).toContain(original!.id);
    expect(twin!.output).not.toContain("file body for dedup test");

    expect(
      engine.session.trace.some(
        (e) => e.type === "tool.deduplicated" && (e.data as { duplicateOf?: string }).duplicateOf === original!.id,
      ),
    ).toBe(true);

    await engine.dispose();
  });
});
