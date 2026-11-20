import { BrowserWindow } from "electron";
import { spawn as ptySpawn, type IPty } from "node-pty";
import os from "node:os";

type TerminalSession = {
  id: string;
  pty: IPty;
  windowId: number;
};

const sessions = new Map<string, TerminalSession>();

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: [] };
  }
  const file = process.env.SHELL || "/bin/bash";
  return { file, args: ["--login"] };
}

/** Normalise a user-configured shell name for node-pty. On Windows, ConPTY's
 * CreateProcess does NOT auto-append ".exe": a bare name like "cmd" or
 * "powershell" fails with "File not found: ". So for a bare name (no path
 * separator, no extension) we append ".exe" — turning "cmd" → "cmd.exe". Names
 * that already carry an extension or a path are used verbatim. No-op off Windows. */
function resolveShellFile(shell: string): string {
  if (process.platform !== "win32") return shell;
  const hasSeparator = /[\\/]/.test(shell);
  const hasExtension = /\.[a-z0-9]+$/i.test(shell);
  if (!hasSeparator && !hasExtension) return `${shell}.exe`;
  return shell;
}

function sanitizeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  return env;
}

export type CreateTerminalInput = {
  id: string;
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
};

export function createTerminalSession(
  win: BrowserWindow,
  input: CreateTerminalInput,
): { id: string; pid: number; shell: string } {
  const { file, args } = input.shell ? { file: resolveShellFile(input.shell), args: [] } : defaultShell();
  const cwd = input.cwd && input.cwd.trim().length > 0 ? input.cwd : os.homedir();
  const pty = ptySpawn(file, args, {
    name: "xterm-256color",
    cols: input.cols ?? 100,
    rows: input.rows ?? 30,
    cwd,
    env: sanitizeEnv(),
  });

  const session: TerminalSession = { id: input.id, pty, windowId: win.id };
  sessions.set(input.id, session);

  pty.onData((data) => {
    if (win.isDestroyed()) return;
    win.webContents.send("reina:event:terminal-data", { id: input.id, data });
  });

  pty.onExit(({ exitCode, signal }) => {
    if (!win.isDestroyed()) {
      win.webContents.send("reina:event:terminal-exit", { id: input.id, exitCode, signal });
    }
    sessions.delete(input.id);
  });

  return { id: input.id, pid: pty.pid, shell: file };
}

export function writeToTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
  try {
    session.pty.resize(Math.floor(cols), Math.floor(rows));
  } catch {
    // pty may have exited
  }
}

export function disposeTerminal(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.pty.kill();
  } catch {
    // already dead
  }
}

export function disposeAllTerminalsForWindow(windowId: number): void {
  for (const [id, session] of sessions) {
    if (session.windowId !== windowId) continue;
    try {
      session.pty.kill();
    } catch {
      // ignore
    }
    sessions.delete(id);
  }
}
