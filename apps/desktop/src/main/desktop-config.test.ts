import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readDesktopRuntimeConfig } from "./desktop-config.js";

describe("readDesktopRuntimeConfig", () => {
  it("returns defaults when project config is missing", async () => {
    const cwd = await tempDir();

    const config = await readDesktopRuntimeConfig(cwd);

    expect(config.promptInput.historyLimit).toBe(100);
    expect(config.promptInput.enterToSend).toBe(true);
    expect(config.prompts.some((prompt) => prompt.id === "review")).toBe(true);
    expect(config.errors).toEqual([]);
  });

  it("merges project prompt input and prompt overrides", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".reina"), { recursive: true });
    await writeFile(
      path.join(cwd, ".reina", "desktop.json"),
      JSON.stringify({
        promptInput: {
          historyLimit: 12,
          enterToSend: false,
        },
        prompts: [
          {
            id: "review",
            title: "Custom Review",
            template: "Custom review prompt",
          },
          {
            id: "ship",
            title: "Ship it",
            template: "Prepare this change for shipping.",
            permissionMode: "plan",
          },
        ],
      }),
      "utf8",
    );

    const config = await readDesktopRuntimeConfig(cwd);

    expect(config.promptInput.historyLimit).toBe(12);
    expect(config.promptInput.enterToSend).toBe(false);
    expect(config.promptInput.enableSlashCommands).toBe(true);
    expect(config.prompts.find((prompt) => prompt.id === "review")?.title).toBe("Custom Review");
    expect(config.prompts.find((prompt) => prompt.id === "ship")?.template).toBe("Prepare this change for shipping.");
  });
});

async function tempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `reina-desktop-config-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
