import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Which interpreter a shell command runs under.
 *
 * Reina is both a coding agent and a security-research tool, so it does NOT pin
 * a single shell (unlike a pure coding agent). Instead the caller — usually the
 * model — picks the dialect that fits the task: PowerShell for Windows offensive
 * one-liners, `cmd` for LOLBins, `bash`/`sh` for POSIX tooling. `auto` defaults
 * to bash on Windows (Git Bash / WSL), falling back to `cmd.exe` when bash is
 * absent, and `/bin/sh` on Unix — a POSIX-leaning default that never
 * hard-depends on PowerShell (which can be locked down via AppLocker /
 * Constrained Language Mode). PowerShell is opt-in via shell:'powershell'.
 */
export type ShellChoice = "auto" | "powershell" | "pwsh" | "cmd" | "bash" | "sh";

/** The concrete interpreter actually selected (never "auto"). */
export type ResolvedShell = Exclude<ShellChoice, "auto">;

export type ShellCommandSpec = {
  file: string;
  args: string[];
  shell: boolean;
  resolved: ResolvedShell;
};

const VALID_CHOICES: readonly ShellChoice[] = ["auto", "powershell", "pwsh", "cmd", "bash", "sh"];

/**
 * Default shell choice, read once from the `REINA_SHELL` env var. Lets a user
 * (or the host) override the per-call default without touching the tool call.
 * Anything unrecognized falls back to "auto".
 */
export function defaultShellChoice(): ShellChoice {
  const raw = process.env.REINA_SHELL?.trim().toLowerCase();
  return raw && (VALID_CHOICES as readonly string[]).includes(raw) ? (raw as ShellChoice) : "auto";
}

/**
 * Environment for pipe-mode (non-PTY) shells. The child has no terminal, so
 * tell tools up front instead of letting them guess or hang:
 *   - NO_COLOR / FORCE_COLOR=0: don't emit ANSI color — it's stripped later
 *     anyway (sanitizeShellOutput) but suppressing it at the source keeps the
 *     bytes out of progress tails, buffers, and saved outputs.
 *   - GIT_TERMINAL_PROMPT=0: a git command that needs credentials fails
 *     immediately instead of waiting on a prompt no one can answer (the
 *     prompt reads the terminal, not stdin, so write_stdin can't unblock it).
 * PTY sessions are exempt on purpose — they exist to be interactive, and
 * prompts/colors are the point there.
 */
export function nonInteractiveShellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Locating an interpreter shells out to `where`/`which`, which is comparatively
// slow — cache per binary for the life of the process. Shells don't appear or
// disappear mid-session, so a single probe is enough.
const locateCache = new Map<string, string[]>();

/** A trusted directory to run `where`/`which` from, so the probe never searches
 * — and resolves binaries out of — an untrusted current working directory. */
function safeProbeCwd(): string {
  return process.platform === "win32" ? windowsRoot() : "/";
}

/**
 * True if `filePath` resolves to inside `dir` (or is `dir` itself).
 *
 * Used to reject executables discovered in an untrusted CWD: `where.exe`
 * searches the current directory before PATH, so a malicious `git.exe` /
 * `bash.exe` dropped into a target repo (security research routinely operates
 * inside untrusted repos) could otherwise be picked up and executed. Mirrors
 * Claude Code's findExecutable cwd guard.
 */
export function isWithinDirectory(filePath: string, dir: string): boolean {
  const normalize = (s: string): string => {
    const resolved = path.resolve(s);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const f = normalize(filePath);
  const d = normalize(dir);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** All `where`/`which` hits for a binary (in PATH order), cached. Probes from a
 * trusted cwd and drops any result inside the live working directory. */
function locateAll(bin: string): string[] {
  const cached = locateCache.get(bin);
  if (cached) return cached;
  let results: string[] = [];
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(finder, [bin], { encoding: "utf-8", timeout: 5000, windowsHide: true, cwd: safeProbeCwd() });
    if (result.status === 0 && result.stdout) {
      const liveCwd = process.cwd();
      results = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((p) => !isWithinDirectory(p, liveCwd));
    }
  } catch {
    // ignore — treated as "not found"
  }
  locateCache.set(bin, results);
  return results;
}

function locate(bin: string): string | null {
  for (const p of locateAll(bin)) {
    // `where` can return stale paths — verify on Windows. `which` is trusted
    // (handles Termux / special filesystems where existsSync lies).
    if (process.platform !== "win32" || existsSync(p)) return p;
  }
  return null;
}

function firstExisting(paths: Array<string | undefined>): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function windowsRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

/** Windows PowerShell (5.x) on Windows; PowerShell 7+ (`pwsh`) elsewhere. */
function powerShellPath(): string | null {
  if (process.platform !== "win32") return pwshPath();
  return (
    firstExisting([path.join(windowsRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]) ??
    locate("powershell.exe") ??
    locate("powershell")
  );
}

/** Cross-platform PowerShell 7+. */
function pwshPath(): string | null {
  return locate("pwsh.exe") ?? locate("pwsh");
}

function cmdPath(): string | null {
  if (process.platform !== "win32") return null;
  return process.env.ComSpec ?? firstExisting([path.join(windowsRoot(), "System32", "cmd.exe")]) ?? "cmd.exe";
}

/**
 * Derive Git Bash from `git.exe` on PATH. git.exe is far more likely than
 * bash.exe to be on PATH (and survives non-standard installs like E:\...\Git
 * that the ProgramFiles probe misses). Git layout: <root>\cmd\git.exe (or
 * <root>\bin\git.exe), with bash at <root>\bin\bash.exe and <root>\usr\bin\bash.exe.
 */
function bashFromGit(): string | null {
  for (const gitPath of locateAll("git.exe")) {
    const root = path.dirname(path.dirname(gitPath));
    const candidate = firstExisting([path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe")]);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * bash.exe on PATH, EXCLUDING the `…\WindowsApps\bash.exe` App Execution Alias
 * — that stub launches WSL, which uses a different filesystem (/mnt/c) and
 * fails outright when no distro is installed. A Windows-path-native MSYS2/Git
 * Bash is what this tool wants; WSL would silently break cwd and path args.
 */
function bashOnPath(): string | null {
  for (const p of locateAll("bash.exe")) {
    if (!/[\\/]WindowsApps[\\/]/i.test(p) && existsSync(p)) return p;
  }
  return null;
}

/** Locate a Windows-path-native bash (Git Bash / MSYS2 / Cygwin), never WSL. */
function bashPath(): string | null {
  // Explicit override (parallels Claude Code's CLAUDE_CODE_GIT_BASH_PATH) — an
  // escape hatch for hosts where bash/git aren't on PATH. Honored on all
  // platforms; ignored (falls through to detection) if the path doesn't exist.
  const override = process.env.REINA_GIT_BASH_PATH?.trim();
  if (override && existsSync(override)) return override;

  if (process.platform === "win32") {
    return (
      firstExisting([
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : undefined,
      ]) ??
      bashFromGit() ??
      bashOnPath()
    );
  }
  return firstExisting(["/bin/bash"]) ?? locate("bash");
}

const PS_PREFIX_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const PS_UTF8 = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ";

function powerShellSpec(file: string, command: string, resolved: ResolvedShell): ShellCommandSpec {
  return { file, args: [...PS_PREFIX_ARGS, `${PS_UTF8}${command}`], shell: false, resolved };
}

function shellNotFound(choice: string, label: string): Error {
  return new Error(
    `Requested shell '${choice}' (${label}) was not found on this host. ` +
      `Use shell:'auto' to pick an available interpreter, or install/PATH it.`,
  );
}

function bashNotFound(): Error {
  return new Error(
    "No Windows-native bash found (the WSL `…\\WindowsApps\\bash.exe` alias is ignored on purpose — it breaks cwd/path handling). Options:\n" +
      "  1. Install Git for Windows: https://git-scm.com/download/win\n" +
      "  2. Put Git Bash / MSYS2 / Cygwin bash on PATH (or just git.exe — bash is derived from it)\n" +
      "  3. Set REINA_GIT_BASH_PATH=C:\\path\\to\\bash.exe\n" +
      "  4. Use shell:'cmd' or shell:'powershell' instead.",
  );
}

/**
 * Build the execa invocation for a command under the chosen interpreter.
 *
 * Explicit choices are strict: if the requested interpreter is missing we throw
 * with guidance rather than silently running the command under the wrong shell
 * (a PowerShell payload under cmd would just break). `auto` never throws —
 * cmd.exe / `/bin/sh` are effectively always present.
 */
export function shellCommandSpec(command: string, choice: ShellChoice = "auto"): ShellCommandSpec {
  const win = process.platform === "win32";

  switch (choice) {
    case "powershell": {
      const file = powerShellPath();
      if (!file) throw shellNotFound("powershell", win ? "Windows PowerShell" : "PowerShell 7+ (pwsh)");
      return powerShellSpec(file, command, win ? "powershell" : "pwsh");
    }
    case "pwsh": {
      const file = pwshPath();
      if (!file) throw shellNotFound("pwsh", "PowerShell 7+ (pwsh)");
      return powerShellSpec(file, command, "pwsh");
    }
    case "cmd": {
      const file = cmdPath();
      if (!file) throw shellNotFound("cmd", "cmd.exe (Windows only)");
      return { file, args: ["/d", "/s", "/c", command], shell: false, resolved: "cmd" };
    }
    case "bash": {
      const file = bashPath();
      if (!file) throw bashNotFound();
      return { file, args: ["-c", command], shell: false, resolved: "bash" };
    }
    case "sh": {
      if (win) {
        // No POSIX `sh` on stock Windows — honor the POSIX intent via bash.
        const file = bashPath();
        if (!file) throw bashNotFound();
        return { file, args: ["-c", command], shell: false, resolved: "bash" };
      }
      return { file: "sh", args: ["-c", command], shell: false, resolved: "sh" };
    }
  }

  // choice === "auto"
  if (!win) {
    // Defer to the system default shell (`/bin/sh`) via execa's shell:true.
    return { file: command, args: [], shell: true, resolved: "sh" };
  }
  // Windows auto: bash first (Git Bash / WSL), then cmd.exe. PowerShell is
  // intentionally NOT the default — it stays reachable via shell:'powershell'
  // for offensive one-liners, but the default leans POSIX (one cross-platform
  // mental model) and never hard-depends on PowerShell, which can be locked
  // down on hardened hosts. cmd.exe is the always-present fallback.
  const bash = bashPath();
  if (bash) return { file: bash, args: ["-c", command], shell: false, resolved: "bash" };
  return { file: cmdPath() ?? "cmd.exe", args: ["/d", "/s", "/c", command], shell: false, resolved: "cmd" };
}

/**
 * Like {@link shellCommandSpec} but guarantees a concrete `file`+`args` form
 * (never `shell:true`) so it can be handed to node-pty, which spawns a program
 * directly and has no system-shell pass-through. The only `shell:true` case is
 * Unix `auto`; route it through `/bin/sh -c "<command>"` so the interactive
 * command still runs under a login-grade POSIX shell inside the PTY.
 */
export function ptyCommandSpec(command: string, choice: ShellChoice = "auto"): { file: string; args: string[]; resolved: ResolvedShell } {
  const spec = shellCommandSpec(command, choice);
  if (!spec.shell) return { file: spec.file, args: spec.args, resolved: spec.resolved };
  return { file: "/bin/sh", args: ["-c", command], resolved: spec.resolved };
}

/**
 * Kill a process and its entire child tree (cross-platform). Long-running
 * security tooling — scanners, fuzzers, C2 stagers — spawns descendants that a
 * plain SIGTERM to the shell leaves orphaned. Borrowed from pi.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    try {
      // Async + detached so killing the tree never blocks the caller
      // (kill_shell is on the interactive path). Best-effort, like pi.
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } catch {
      // ignore — best effort
    }
    return;
  }
  try {
    // Negative pid targets the process group (requires a detached leader).
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already dead
    }
  }
}
