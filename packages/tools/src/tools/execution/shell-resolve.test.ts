import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultShellChoice, isWithinDirectory, ptyCommandSpec, shellCommandSpec } from "./shell-resolve.js";

const isWindows = process.platform === "win32";

describe("defaultShellChoice", () => {
  const previous = process.env.REINA_SHELL;
  afterEach(() => {
    if (previous === undefined) delete process.env.REINA_SHELL;
    else process.env.REINA_SHELL = previous;
  });

  it("defaults to auto when unset", () => {
    delete process.env.REINA_SHELL;
    expect(defaultShellChoice()).toBe("auto");
  });

  it("honors a valid REINA_SHELL value (case-insensitive)", () => {
    process.env.REINA_SHELL = "BASH";
    expect(defaultShellChoice()).toBe("bash");
  });

  it("falls back to auto for an unrecognized value", () => {
    process.env.REINA_SHELL = "fish";
    expect(defaultShellChoice()).toBe("auto");
  });
});

describe("shellCommandSpec", () => {
  it("auto on Unix defers to the system shell (/bin/sh via shell:true)", () => {
    if (isWindows) return;
    const spec = shellCommandSpec("echo hi", "auto");
    expect(spec).toEqual({ file: "echo hi", args: [], shell: true, resolved: "sh" });
  });

  it("auto on Windows defaults to bash (cmd.exe fallback), never PowerShell", () => {
    if (!isWindows) return;
    const spec = shellCommandSpec("echo hi", "auto");
    // bash preferred (Git Bash/WSL); cmd.exe is the guaranteed fallback. PowerShell
    // is opt-in only and must never be the auto default.
    expect(["bash", "cmd"]).toContain(spec.resolved);
    expect(spec.resolved).not.toBe("powershell");
    expect(spec.file).toBeTruthy();
    expect(spec.shell).toBe(false);
  });

  it("explicit powershell builds a -Command invocation with UTF-8 setup", () => {
    if (!isWindows) return;
    const spec = shellCommandSpec("Get-ChildItem", "powershell");
    expect(spec.resolved).toBe("powershell");
    expect(spec.file.toLowerCase()).toContain("powershell");
    expect(spec.args).toContain("-Command");
    expect(spec.args.at(-1)).toContain("Get-ChildItem");
    expect(spec.args.at(-1)).toContain("UTF8Encoding");
  });

  it("explicit cmd builds a /d /s /c invocation", () => {
    if (!isWindows) return;
    const spec = shellCommandSpec("echo hi", "cmd");
    expect(spec.resolved).toBe("cmd");
    expect(spec.args).toEqual(["/d", "/s", "/c", "echo hi"]);
    expect(spec.shell).toBe(false);
  });

  it("cmd is Windows-only — throws elsewhere", () => {
    if (isWindows) return;
    expect(() => shellCommandSpec("echo hi", "cmd")).toThrow();
  });

  it("explicit bash builds `bash -c` when bash is available, else throws with guidance", () => {
    try {
      const spec = shellCommandSpec("echo hi", "bash");
      expect(spec.resolved).toBe("bash");
      expect(spec.args).toEqual(["-c", "echo hi"]);
      expect(spec.shell).toBe(false);
    } catch (error) {
      expect(String(error)).toContain("git-scm.com");
    }
  });

  it("honors the REINA_GIT_BASH_PATH override for explicit bash", () => {
    const previous = process.env.REINA_GIT_BASH_PATH;
    process.env.REINA_GIT_BASH_PATH = process.execPath; // a guaranteed-existing executable
    try {
      const spec = shellCommandSpec("echo hi", "bash");
      expect(spec.resolved).toBe("bash");
      expect(spec.file).toBe(process.execPath);
      expect(spec.args).toEqual(["-c", "echo hi"]);
    } finally {
      if (previous === undefined) delete process.env.REINA_GIT_BASH_PATH;
      else process.env.REINA_GIT_BASH_PATH = previous;
    }
  });
});

describe("ptyCommandSpec (node-pty has no system-shell pass-through)", () => {
  it("never returns a shell:true form — it has no `shell` field at all", () => {
    // node-pty spawns a program directly; a spec with shell:true would be
    // spawned literally as a file named after the whole command string.
    const spec = ptyCommandSpec("echo hi", "auto") as Record<string, unknown>;
    expect(spec.shell).toBeUndefined();
    expect(typeof spec.file).toBe("string");
    expect(Array.isArray(spec.args)).toBe(true);
  });

  it("auto on Unix wraps the command in /bin/sh -c (the only shell:true case)", () => {
    if (isWindows) return;
    const spec = ptyCommandSpec("ssh user@host", "auto");
    expect(spec).toEqual({ file: "/bin/sh", args: ["-c", "ssh user@host"], resolved: "sh" });
  });

  it("auto on Windows passes through the concrete bash/cmd spec unchanged", () => {
    if (!isWindows) return;
    const shellSpec = shellCommandSpec("echo hi", "auto");
    const spec = ptyCommandSpec("echo hi", "auto");
    // shellCommandSpec already yields a concrete file+args (shell:false) on
    // Windows auto, so ptyCommandSpec must forward it verbatim (sans `shell`).
    expect(spec).toEqual({ file: shellSpec.file, args: shellSpec.args, resolved: shellSpec.resolved });
  });

  it("explicit cmd passes through its /d /s /c invocation (already shell:false)", () => {
    if (!isWindows) return;
    const spec = ptyCommandSpec("echo hi", "cmd");
    expect(spec).toEqual({ file: shellCommandSpec("echo hi", "cmd").file, args: ["/d", "/s", "/c", "echo hi"], resolved: "cmd" });
  });
});

describe("isWithinDirectory (cwd-injection guard)", () => {
  const cwd = process.cwd();

  it("flags an executable directly in the directory", () => {
    expect(isWithinDirectory(path.join(cwd, "git.exe"), cwd)).toBe(true);
  });

  it("flags an executable nested in a subdirectory", () => {
    expect(isWithinDirectory(path.join(cwd, "node_modules", ".bin", "bash.exe"), cwd)).toBe(true);
  });

  it("does not flag an executable outside the directory", () => {
    const outside = path.join(cwd, "..", "reina-definitely-outside-zzz", "git.exe");
    expect(isWithinDirectory(outside, cwd)).toBe(false);
  });

  it("treats the directory itself as within", () => {
    expect(isWithinDirectory(cwd, cwd)).toBe(true);
  });
});
