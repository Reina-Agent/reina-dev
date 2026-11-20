import { bridge } from "./bridge";

/**
 * Minimal shape of the desktop-state snapshot returned by `getDesktopState()`.
 * The full type is `DesktopState` in apps/desktop/src/main/desktop-state.ts.
 *
 * IMPORTANT: there is no `activeWorkspace` object on the snapshot. The active
 * workspace's `cwd` lives inside the `workspaces` array, keyed by
 * `activeWorkspaceId`. Reading `state.activeWorkspace.cwd` (as every settings
 * panel originally did) always yields `undefined`, which silently degraded
 * every workspace-scoped panel to an empty list / "Open a workspace" state.
 */
interface DesktopStateSnapshot {
  activeWorkspaceId?: string;
  workspaces?: Array<{ id: string; cwd?: string }>;
}

/**
 * Resolve the cwd of the currently active workspace, or `undefined` when no
 * workspace is open.
 *
 * Shared by every settings panel: the settings window is a separate React
 * window with no session store of its own, so it must read the desktop-state
 * snapshot directly. This mirrors how the main window resolves cwd
 * (see windows/main/sessionStore.ts and SessionList.tsx) — find the workspace
 * whose id matches `activeWorkspaceId`.
 */
export async function getWorkspaceCwd(): Promise<string | undefined> {
  try {
    const state = (await bridge().getDesktopState()) as DesktopStateSnapshot | null;
    if (!state?.activeWorkspaceId) return undefined;
    return state.workspaces?.find((w) => w.id === state.activeWorkspaceId)?.cwd ?? undefined;
  } catch {
    return undefined;
  }
}
