import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  access: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:fs", () => ({ readdirSync: mocks.readdirSync }));

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
let resolveExecutable: typeof import("./apps.js").resolveExecutable;
let now: number;
const firstPath = path.resolve("installed-editor", "editor.exe");
const updatedPath = path.resolve("updated-editor", "editor.exe");

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.access.mockResolvedValue(undefined);
  mocks.readdirSync.mockReturnValue([]);
  mocks.execFile.mockImplementation((_command, _args, _options, callback: ExecCallback) => {
    callback(null, firstPath, "");
  });
  ({ resolveExecutable } = await import("./apps.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveExecutable caching", () => {
  it("shares an in-flight lookup across callers", async () => {
    let complete!: ExecCallback;
    mocks.execFile.mockImplementation((_command, _args, _options, callback: ExecCallback) => {
      complete = callback;
    });

    const first = resolveExecutable("editor");
    const second = resolveExecutable("editor");
    expect(second).toBe(first);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    complete(null, firstPath, "");

    await expect(Promise.all([first, second])).resolves.toEqual([firstPath, firstPath]);
  });

  it("reuses an existing path for 60 seconds without extending its expiry on hits", async () => {
    await expect(resolveExecutable("editor")).resolves.toBe(firstPath);
    now += 59_999;
    await expect(resolveExecutable("editor")).resolves.toBe(firstPath);
    expect(mocks.access).toHaveBeenCalledWith(firstPath);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    mocks.execFile.mockImplementation((_command, _args, _options, callback: ExecCallback) => {
      callback(null, updatedPath, "");
    });
    now += 1;
    await expect(resolveExecutable("editor")).resolves.toBe(updatedPath);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("retries a missing app after five seconds", async () => {
    mocks.access.mockRejectedValue(new Error("ENOENT"));
    mocks.execFile.mockImplementationOnce((_command, _args, _options, callback: ExecCallback) => {
      callback(new Error("not found"), "", "");
    });
    await expect(resolveExecutable("missing-editor")).resolves.toBeNull();
    now += 4_999;
    await expect(resolveExecutable("missing-editor")).resolves.toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(resolveExecutable("missing-editor")).resolves.toBe(firstPath);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("re-resolves an uninstalled cached path immediately before launch", async () => {
    await resolveExecutable("editor");
    mocks.access.mockRejectedValueOnce(new Error("ENOENT"));
    mocks.execFile.mockImplementation((_command, _args, _options, callback: ExecCallback) => {
      callback(null, updatedPath, "");
    });

    await expect(resolveExecutable("editor")).resolves.toBe(updatedPath);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("keeps separate app lookups independent", async () => {
    await Promise.all([resolveExecutable("editor-one"), resolveExecutable("editor-two")]);

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.execFile.mock.calls.map((call) => call[1])).toEqual([["editor-one"], ["editor-two"]]);
  });
});
