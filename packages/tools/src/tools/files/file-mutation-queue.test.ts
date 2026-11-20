import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editFileTool } from "./edit-file.js";
import { writeFileTool } from "./write-file.js";
import { applyPatchTool } from "./apply-patch.js";
import { multiEditTool } from "./multi-edit.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "reina-file-queue-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("file mutation tools", () => {
  it("keeps write_file behind an edit_file that has already read the same file", async () => {
    const target = path.join(cwd, "shared.txt");
    await fs.writeFile(target, "alpha\n");
    const read = fs.readFile.bind(fs);
    const started = deferred();
    const resume = deferred();
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const content = await read(...args);
      if (String(args[0]) === target && args[1] === undefined) {
        started.resolve();
        await resume.promise;
      }
      return content;
    });

    const editing = editFileTool.execute({ path: "shared.txt", oldText: "alpha", newText: "beta" }, { cwd });
    await started.promise;
    const writing = writeFileTool.execute({ path: "shared.txt", content: "gamma\n" }, { cwd });
    try {
      await Promise.race([writing, delay(100)]);
      expect(await read(target, "utf8")).toBe("alpha\n");
    } finally {
      resume.resolve();
      await Promise.all([editing, writing]);
    }
    expect(await read(target, "utf8")).toBe("gamma\n");
  });

  it("holds an aborted in-flight write until it settles before multi_edit starts", async () => {
    const target = path.join(cwd, "shared.txt");
    await fs.writeFile(target, "alpha\n");
    const write = fs.writeFile.bind(fs);
    const started = deferred();
    const resume = deferred();
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]) === target && args[1] === "beta\n") {
        started.resolve();
        await resume.promise;
      }
      return write(...args);
    });
    const controller = new AbortController();
    const writing = writeFileTool.execute(
      { path: "shared.txt", content: "beta\n" },
      { cwd, signal: controller.signal },
    );
    const cancelled = expect(writing).rejects.toThrow("cancel writing");
    await started.promise;
    controller.abort(new Error("cancel writing"));
    const editing = multiEditTool.execute(
      { path: "shared.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
      { cwd },
    );
    const outcome = editing.then(
      () => "done",
      (error: unknown) => error,
    );
    try {
      await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
      expect(await fs.readFile(target, "utf8")).toBe("alpha\n");
    } finally {
      resume.resolve();
      await cancelled;
    }
    expect(await outcome).toBe("done");
    expect(await fs.readFile(target, "utf8")).toBe("gamma\n");
  });

  it("runs real multi-file git patches after write_file, including reversed path order", async () => {
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(cwd, "b.txt"), "alpha\n");
    const write = fs.writeFile.bind(fs);
    const started = deferred();
    const resume = deferred();
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(cwd, "a.txt") && args[1] === "beta\n") {
        started.resolve();
        await resume.promise;
      }
      return write(...args);
    });
    const writing = writeFileTool.execute({ path: "a.txt", content: "beta\n" }, { cwd });
    await started.promise;
    const firstPatch = patch("b.txt", "alpha", "beta") + patch("a.txt", "beta", "gamma");
    const secondPatch = patch("a.txt", "gamma", "delta") + patch("b.txt", "beta", "gamma");
    const patches = Promise.all([
      applyPatchTool.execute({ patch: firstPatch }, { cwd }),
      applyPatchTool.execute({ patch: secondPatch }, { cwd }),
    ]);
    const outcome = patches.then(
      () => "done",
      (error: unknown) => error,
    );
    try {
      await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
      expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\n");
      expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe("alpha\n");
    } finally {
      resume.resolve();
      await writing;
    }
    expect(await outcome).toBe("done");
    // git apply honors the user's platform/autocrlf setting.
    expect((await fs.readFile(path.join(cwd, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("delta\n");
    expect((await fs.readFile(path.join(cwd, "b.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("gamma\n");
  });

  it("releases every patch path after git apply fails", async () => {
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(cwd, "b.txt"), "alpha\n");
    await expect(
      applyPatchTool.execute({ patch: patch("a.txt", "missing", "beta") + patch("b.txt", "alpha", "beta") }, { cwd }),
    ).rejects.toThrow();
    await Promise.all(
      ["a.txt", "b.txt"].map((file) => writeFileTool.execute({ path: file, content: "gamma\n" }, { cwd })),
    );
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("gamma\n");
    expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe("gamma\n");
  });

  it.each(["shared.txt", "中文.txt"])("queues git-quoted paths for %s behind write_file", async (file) => {
    const target = path.join(cwd, file);
    await fs.writeFile(target, "alpha\n");
    const write = fs.writeFile.bind(fs);
    const started = deferred();
    const resume = deferred();
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]) === target && args[1] === "beta\n") {
        started.resolve();
        await resume.promise;
      }
      return write(...args);
    });
    const writing = writeFileTool.execute({ path: file, content: "beta\n" }, { cwd });
    await started.promise;
    const quoted = `--- ${gitQuote(`a/${file}`)}\n+++ ${gitQuote(`b/${file}`)}\n@@ -1 +1 @@\n-beta\n+gamma\n`;
    const patching = applyPatchTool.execute({ patch: quoted }, { cwd });
    const outcome = patching.then(
      () => "done",
      (error: unknown) => error,
    );
    try {
      await Promise.race([outcome, delay(100)]);
      expect(await fs.readFile(target, "utf8")).toBe("alpha\n");
    } finally {
      resume.resolve();
      await writing;
    }
    expect(await outcome).toBe("done");
    expect((await fs.readFile(target, "utf8")).replace(/\r\n/g, "\n")).toBe("gamma\n");
  });

  it.each([
    ["rename", "source"],
    ["rename", "destination"],
    ["copy", "source"],
    ["copy", "destination"],
  ])("locks the quoted %s %s path", async (kind, blocked) => {
    const source = "中文 source.txt";
    const destination = "目标 target.txt";
    await fs.writeFile(path.join(cwd, source), "alpha\n");
    const started = deferred();
    const resume = deferred();
    const holding = withFileMutationQueue([path.join(cwd, blocked === "source" ? source : destination)], async () => {
      started.resolve();
      await resume.promise;
    });
    await started.promise;
    const text = `diff --git ${gitQuote(`a/${source}`)} ${gitQuote(`b/${destination}`)}\nsimilarity index 100%\n${kind} from ${gitQuote(source)}\n${kind} to ${gitQuote(destination)}\n`;
    const patching = applyPatchTool.execute({ patch: text }, { cwd });
    const outcome = patching.then(
      () => "done",
      (error: unknown) => error,
    );
    try {
      await Promise.race([outcome, delay(100)]);
      expect(await fs.readFile(path.join(cwd, source), "utf8")).toBe("alpha\n");
      await expect(fs.stat(path.join(cwd, destination))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume.resolve();
      await holding;
    }
    expect(await outcome).toBe("done");
    expect((await fs.readFile(path.join(cwd, destination), "utf8")).replace(/\r\n/g, "\n")).toBe("alpha\n");
  });

  it("keeps the protected-path guard after decoding quoted octal bytes", async () => {
    await fs.mkdir(path.join(cwd, ".reina"));
    await fs.writeFile(path.join(cwd, ".reina", "state.json"), "alpha\n");
    const text = '--- "a/\\056reina/state.json"\n+++ "b/\\056reina/state.json"\n@@ -1 +1 @@\n-alpha\n+beta\n';
    await expect(applyPatchTool.execute({ patch: text }, { cwd })).rejects.toThrow(/\.reina/);
    expect(await fs.readFile(path.join(cwd, ".reina", "state.json"), "utf8")).toBe("alpha\n");
  });

  it("does not interpret header-looking file contents as patch paths", async () => {
    await fs.writeFile(path.join(cwd, "shared.txt"), "-- old content\n");
    const text = '--- "a/shared.txt"\n+++ "b/shared.txt"\n@@ -1 +1 @@\n--- old content\n+++ new content\n';
    await applyPatchTool.execute({ patch: text }, { cwd });
    expect((await fs.readFile(path.join(cwd, "shared.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("++ new content\n");
  });

  it.each([false, true])(
    "rejects an unsupported pathless section instead of applying it unlocked (mixed=%s)",
    async (mixed) => {
      await fs.writeFile(path.join(cwd, "a.txt"), "alpha\n");
      await fs.writeFile(path.join(cwd, "b.txt"), "alpha\n");
      const modeOnly = "diff --git a/b.txt b/b.txt\nold mode 100644\nnew mode 100755\n";
      const text = mixed ? `diff --git a/a.txt b/a.txt\n${patch("a.txt", "alpha", "beta")}${modeOnly}` : modeOnly;
      await expect(applyPatchTool.execute({ patch: text }, { cwd })).rejects.toThrow("Unsupported patch section");
      expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\n");
    },
  );

  it.each(["write_file", "edit_file", "multi_edit", "apply_patch"])(
    "does not start a queued %s after cancellation",
    async (name) => {
      const target = path.join(cwd, "shared.txt");
      await fs.writeFile(target, "alpha\n");
      const started = deferred();
      const resume = deferred();
      const holding = withFileMutationQueue([target], async () => {
        started.resolve();
        await resume.promise;
      });
      await started.promise;
      const controller = new AbortController();
      const options = { cwd, signal: controller.signal };
      const operation =
        name === "write_file"
          ? writeFileTool.execute({ path: "shared.txt", content: "beta\n" }, options)
          : name === "edit_file"
            ? editFileTool.execute({ path: "shared.txt", oldText: "alpha", newText: "beta" }, options)
            : name === "multi_edit"
              ? multiEditTool.execute({ path: "shared.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, options)
              : applyPatchTool.execute({ patch: patch("shared.txt", "alpha", "beta") }, options);
      const cancelled = expect(operation).rejects.toThrow("cancel queued");
      try {
        await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
        controller.abort(new Error("cancel queued"));
        await cancelled;
        expect(await fs.readFile(target, "utf8")).toBe("alpha\n");
      } finally {
        resume.resolve();
        await holding;
      }
      expect(await fs.readFile(target, "utf8")).toBe("alpha\n");
    },
  );
});

describe("withFileMutationQueue", () => {
  it.each(["shared.txt", "new/nested/shared.txt"])(
    "shares a queue through directory aliases for %s",
    async (relative) => {
      const real = path.join(cwd, "real");
      const alias = path.join(cwd, "alias");
      await fs.mkdir(real);
      await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
      if (relative === "shared.txt") await fs.writeFile(path.join(real, relative), "alpha\n");
      const started = deferred();
      const resume = deferred();
      const order: string[] = [];
      const first = withFileMutationQueue([path.join(real, relative)], async () => {
        started.resolve();
        await resume.promise;
        await fs.mkdir(path.dirname(path.join(real, relative)), { recursive: true });
        await fs.writeFile(path.join(real, relative), "first\n");
        order.push("first");
      });
      await started.promise;
      const second = withFileMutationQueue([path.join(alias, relative)], async () => {
        order.push("second");
        await fs.writeFile(path.join(alias, relative), "second\n");
      });
      try {
        await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
        expect(order).toEqual([]);
      } finally {
        resume.resolve();
        await Promise.all([first, second]);
      }
      expect(order).toEqual(["first", "second"]);
      expect(await fs.readFile(path.join(real, relative), "utf8")).toBe("second\n");
    },
  );

  it("lets unrelated files run concurrently and releases failed operations", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    const started = deferred();
    const resume = deferred();
    const first = withFileMutationQueue([a], async () => {
      started.resolve();
      await resume.promise;
      throw new Error("write failed");
    });
    const failed = expect(first).rejects.toThrow("write failed");
    await started.promise;
    try {
      await withFileMutationQueue([b], async () => {
        await fs.writeFile(b, "independent");
      });
      expect(await fs.readFile(b, "utf8")).toBe("independent");
    } finally {
      resume.resolve();
      await failed;
    }
    await withFileMutationQueue([a], async () => {
      await fs.writeFile(a, "recovered");
    });
    expect(await fs.readFile(a, "utf8")).toBe("recovered");
  });

  it("does not release a predecessor's reservation when a waiting operation is cancelled", async () => {
    const target = path.join(cwd, "shared.txt");
    const started = deferred();
    const resume = deferred();
    const first = withFileMutationQueue([target], async () => {
      started.resolve();
      await resume.promise;
    });
    await started.promise;
    const controller = new AbortController();
    const neverStarted = vi.fn(async () => {});
    const second = withFileMutationQueue([target], neverStarted, controller.signal);
    const cancelled = expect(second).rejects.toThrow("cancel queued");
    const lastStarted = vi.fn(async () => {});
    try {
      controller.abort(new Error("cancel queued"));
      await cancelled;
      const last = withFileMutationQueue([target], lastStarted);
      await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
      expect(neverStarted).not.toHaveBeenCalled();
      expect(lastStarted).not.toHaveBeenCalled();
      resume.resolve();
      await last;
    } finally {
      resume.resolve();
      await first;
    }
    expect(lastStarted).toHaveBeenCalledOnce();
  });

  it("releases idle paths from a cancelled multi-file waiter without overtaking busy predecessors", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    const started = deferred();
    const resume = deferred();
    const first = withFileMutationQueue([a], async () => {
      started.resolve();
      await resume.promise;
    });
    await started.promise;

    const controller = new AbortController();
    const neverStarted = vi.fn(async () => {});
    const waiting = withFileMutationQueue([a, b], neverStarted, controller.signal);
    const cancelled = expect(waiting).rejects.toThrow("cancel queued multi-file mutation");
    // Wait until the multi-file operation has reserved both paths.
    await withFileMutationQueue([path.join(cwd, "unrelated")], async () => {});
    controller.abort(new Error("cancel queued multi-file mutation"));
    await cancelled;

    const afterAStarted = vi.fn(async () => {});
    const afterA = withFileMutationQueue([a], afterAStarted);
    const afterBStarted = vi.fn(async () => {});
    const afterB = withFileMutationQueue([b], afterBStarted);
    try {
      expect(await Promise.race([afterB.then(() => "done"), delay(100, "timeout")])).toBe("done");
      expect(afterBStarted).toHaveBeenCalledOnce();
      expect(afterAStarted).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.all([first, afterA, afterB]);
    }
    expect(neverStarted).not.toHaveBeenCalled();
    expect(afterAStarted).toHaveBeenCalledOnce();
  });
});

function patch(file: string, before: string, after: string): string {
  return `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

function gitQuote(file: string): string {
  return `"${[...Buffer.from(file)].map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8)}`)).join("")}"`;
}
