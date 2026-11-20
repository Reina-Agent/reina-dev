const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Resolve a markdown link/image path without allowing it to leave the workspace. */
export function resolveWorkspaceRelativePath(basePath: string, target: string): string | null {
  const pathOnly = target.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!pathOnly || pathOnly.startsWith("#") || pathOnly.startsWith("/") || pathOnly.startsWith("\\")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (!decoded || SCHEME_RE.test(decoded) || decoded.startsWith("//") || decoded.includes("\0")) return null;

  const base = basePath.replace(/\\/g, "/").split("/").filter(Boolean);
  base.pop();
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(part);
  }
  return base.length > 0 ? base.join("/") : null;
}

export function workspaceAbsolutePath(cwd: string, relativePath: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + separator + relativePath.replace(/[\\/]/g, separator);
}

/** Convert a verified workspace-relative asset into a file URL for Chromium. */
export function workspaceFileUrl(cwd: string, basePath: string, target: string): string | null {
  const relative = resolveWorkspaceRelativePath(basePath, target);
  if (!relative) return null;

  const slashCwd = cwd.replace(/\\/g, "/");
  const root = new URL("file:///");
  root.pathname = `${slashCwd.startsWith("/") ? slashCwd : `/${slashCwd}`.replace(/\/{2,}/g, "/")}/`;
  const encodedRelative = relative.split("/").map(encodeURIComponent).join("/");
  return new URL(encodedRelative, root).href;
}
