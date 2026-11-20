import { execFile, type ExecFileOptions } from "node:child_process";
import { readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executableCache = new Map<string, { value: string | null; expiresAt: number }>();
const executableLookups = new Map<string, Promise<string | null>>();

export function resolveExecutable(appName: string): Promise<string | null> {
  const pending = executableLookups.get(appName);
  if (pending) return pending;
  const lookup = resolveCachedExecutable(appName).finally(() => executableLookups.delete(appName));
  executableLookups.set(appName, lookup);
  return lookup;
}

async function resolveCachedExecutable(appName: string): Promise<string | null> {
  const cached = executableCache.get(appName);
  if (cached && cached.expiresAt > Date.now()) {
    // This API also resolves paths immediately before launch. An uninstall or
    // update must invalidate a cached path without waiting for the TTL.
    if (cached.value === null || await fileExists(cached.value)) return cached.value;
  }
  const value = await lookupExecutable(appName);
  executableCache.set(appName, {
    value,
    // Avoid spawning where/which on every menu click, but retry missing apps
    // sooner so an installation becomes discoverable without restarting.
    expiresAt: Date.now() + (value === null ? 5_000 : 60_000),
  });
  return value;
}

async function lookupExecutable(appName: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  try {
    const output = await execFilePromise(command, [appName]);
    const matches = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === "win32") {
      return matches.find((line) => /\.(cmd|bat|exe)$/i.test(line)) ?? matches[0] ?? null;
    }
    return matches[0] ?? null;
  } catch {
    if (process.platform === "win32") return resolveKnownWindowsExecutable(appName);
    if (process.platform === "darwin") return resolveKnownMacExecutable(appName);
    return null;
  }
}

// On macOS the open-with catalog uses .app display names (e.g. "Visual Studio
// Code"), not PATH commands — and a GUI-launched Electron process doesn't
// inherit the user's shell PATH, so `which` finds nothing even when the editor
// is installed. Look for the bundle directly under the standard Applications
// roots instead. The returned .app path is launched via `open -a` by the
// open-path IPC, so we don't need the app's inner CLI shim.
async function resolveKnownMacExecutable(appName: string): Promise<string | null> {
  const name = appName.toLowerCase().endsWith(".app") ? appName.slice(0, -4) : appName;
  const roots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"];
  // Exact bundle first — the common case and the cheapest check.
  for (const root of roots) {
    const exact = path.join(root, `${name}.app`);
    if (await fileExists(exact)) return exact;
  }
  // Versioned / edition-suffixed bundles: JetBrains ships "IntelliJ IDEA CE.app",
  // "PyCharm Community Edition.app", etc., and Toolbox drops them under
  // ~/Applications. Match any *.app whose base name starts with the requested
  // name (case-insensitive).
  const prefix = name.toLowerCase();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const hit = entries.find(
      (entry) => entry.toLowerCase().endsWith(".app") && entry.slice(0, -4).toLowerCase().startsWith(prefix),
    );
    if (hit) return path.join(root, hit);
  }
  return null;
}

async function resolveKnownWindowsExecutable(appName: string): Promise<string | null> {
  const candidates = windowsExecutableCandidates(appName);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function windowsExecutableCandidates(appName: string): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const roots = [localAppData, programFiles, programFilesX86].filter(Boolean) as string[];
  const key = appName.toLowerCase();
  const candidates: string[] = [];

  if (key === "code" || key === "visual studio code") {
    for (const root of roots) {
      candidates.push(path.join(root, "Programs", "Microsoft VS Code", "bin", "code.cmd"));
      candidates.push(path.join(root, "Programs", "Microsoft VS Code", "Code.exe"));
      candidates.push(path.join(root, "Microsoft VS Code", "bin", "code.cmd"));
      candidates.push(path.join(root, "Microsoft VS Code", "Code.exe"));
    }
  }
  if (key === "cursor") {
    for (const root of roots) {
      candidates.push(path.join(root, "Programs", "Cursor", "resources", "app", "bin", "cursor.cmd"));
      candidates.push(path.join(root, "Cursor", "resources", "app", "bin", "cursor.cmd"));
    }
  }
  if (key === "antigravity") {
    for (const root of roots) {
      candidates.push(path.join(root, "Programs", "Antigravity", "bin", "antigravity.cmd"));
      candidates.push(path.join(root, "Programs", "Antigravity", "Antigravity.exe"));
      candidates.push(path.join(root, "Antigravity", "bin", "antigravity.cmd"));
      candidates.push(path.join(root, "Antigravity", "Antigravity.exe"));
    }
  }
  if (key === "idea64") {
    if (localAppData) {
      candidates.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts", "idea.cmd"));
      candidates.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts", "idea64.exe"));
    }
    for (const root of [programFiles, programFilesX86].filter(Boolean) as string[]) {
      candidates.push(path.join(root, "JetBrains", "IntelliJ IDEA", "bin", "idea64.exe"));
      candidates.push(path.join(root, "JetBrains", "IntelliJ IDEA Community Edition", "bin", "idea64.exe"));
      candidates.push(...jetBrainsProductCandidates(root, /^IntelliJ IDEA/i, "idea64.exe"));
    }
  }
  if (key === "pycharm64") {
    if (localAppData) {
      candidates.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts", "pycharm.cmd"));
      candidates.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts", "pycharm64.exe"));
    }
    for (const root of [programFiles, programFilesX86].filter(Boolean) as string[]) {
      candidates.push(path.join(root, "JetBrains", "PyCharm", "bin", "pycharm64.exe"));
      candidates.push(path.join(root, "JetBrains", "PyCharm Community Edition", "bin", "pycharm64.exe"));
      candidates.push(...jetBrainsProductCandidates(root, /^PyCharm/i, "pycharm64.exe"));
    }
  }
  if (key === "wsl.exe" || key === "wsl") {
    candidates.push(path.join(windir, "System32", "wsl.exe"));
  }
  if (key === "zed") {
    for (const root of roots) {
      candidates.push(path.join(root, "Programs", "Zed", "Zed.exe"));
      candidates.push(path.join(root, "Zed", "Zed.exe"));
    }
  }
  if (key === "subl") {
    for (const root of roots) {
      candidates.push(path.join(root, "Sublime Text", "subl.exe"));
      candidates.push(path.join(root, "Sublime Text", "sublime_text.exe"));
      candidates.push(path.join(root, "Programs", "Sublime Text", "subl.exe"));
    }
  }

  return [...new Set(candidates)];
}

function jetBrainsProductCandidates(root: string, productPattern: RegExp, executable: string): string[] {
  const jetBrainsRoot = path.join(root, "JetBrains");
  try {
    return readdirSync(jetBrainsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && productPattern.test(entry.name))
      .map((entry) => path.join(jetBrainsRoot, entry.name, "bin", executable));
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function execFilePromise(command: string, args: string[], options: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const stdoutText = String(stdout);
      const stderrText = String(stderr);
      if (error) {
        reject(new Error(stderrText.trim() || error.message));
        return;
      }
      resolve(stdoutText);
    });
  });
}
