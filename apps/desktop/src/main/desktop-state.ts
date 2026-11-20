import crypto from "node:crypto";
import { statSync } from "node:fs";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionState } from "@reina/protocol";
import { execFilePromise } from "./apps.js";
import { readStoreValue, writeStoreValue } from "./store.js";

export type DesktopProject = {
  id: string;
  root: string;
  name: string;
  gitRoot?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

export type DesktopWorkspace = {
  id: string;
  projectId: string;
  cwd: string;
  branch?: string;
  type: "local";
  createdAt: string;
  lastUsedAt: string;
};

export type DesktopSessionIndex = {
  id: string;
  projectId: string;
  workspaceId: string;
  cwd: string;
  title: string;
  agent: string;
  model: string;
  permissionMode: string;
  messageCount: number;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
  /** Latest targeted/manual title waiting for an authoritative session snapshot
   * to observe it. While set, older snapshots cannot roll the title back. */
  pendingObservedTitle?: string;
  parentId?: string;
  /** ISO timestamp set when the user pins the session to the top of its
   * project group. Absent = not pinned. */
  pinnedAt?: string;
  /** ISO timestamp set when the user archives the session. Archived sessions
   * are hidden from the main list (shown under a collapsed "Archived" group).
   * Absent = active. */
  archivedAt?: string;
  /** Manual sidebar position, expressed as an effective timestamp the sort +
   * time-bucketing use INSTEAD of `updatedAt`. Drag-to-reorder writes the
   * midpoint of the drop target's neighbours here, so the session settles into
   * the bucket it was dropped into and never snaps back on the next refresh.
   * Absent = follow recency (`updatedAt`). The age chip still reflects the real
   * `updatedAt`, not this. */
  orderTs?: string;
};

export type DesktopState = {
  version: 1;
  activeProjectId?: string;
  activeWorkspaceId?: string;
  activeSessionId?: string;
  projects: DesktopProject[];
  workspaces: DesktopWorkspace[];
  sessions: DesktopSessionIndex[];
  /** User-controlled display order of project groups in the sidebar (project
   * ids). Drag-to-reorder writes this; the list renders projects in this order
   * instead of by recency, so opening/clicking never reshuffles the groups. */
  projectOrder: string[];
};

const STORE_NAME = "desktop-state";
const STORE_KEY = "index";

export function loadDesktopState(): DesktopState {
  const raw = readStoreValue(STORE_NAME, STORE_KEY);
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopState>;
    return sanitizeState({
      version: 1,
      activeProjectId: parsed.activeProjectId,
      activeWorkspaceId: parsed.activeWorkspaceId,
      activeSessionId: parsed.activeSessionId,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      projectOrder: Array.isArray(parsed.projectOrder) ? parsed.projectOrder.filter((id) => typeof id === "string") : [],
    });
  } catch {
    return emptyState();
  }
}

export function saveDesktopState(state: DesktopState): void {
  writeStoreValue(STORE_NAME, STORE_KEY, JSON.stringify(sanitizeState(state)));
}

export function clearActiveWorkspace(): DesktopState {
  const state = loadDesktopState();
  state.activeProjectId = undefined;
  state.activeWorkspaceId = undefined;
  state.activeSessionId = undefined;
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

/** Drop a workspace from the recent list. sanitizeState (run by both save and
 * load) cascades the removal: session index entries under the workspace, any
 * project left with no references, and stale active pointers all disappear
 * with it. This only trims the index — the agent-host's `remove_workspace`
 * request owns the on-disk side (closing the store and, when asked, deleting
 * `<cwd>/.reina`); the renderer calls that first. */
export function removeWorkspace(workspaceId: string): DesktopState {
  const state = loadDesktopState();
  state.workspaces = state.workspaces.filter((item) => item.id !== workspaceId);
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

/** Persist which session the user is currently viewing so the next launch
 * reopens it. Called from the renderer's setActiveSession path (every
 * loadSession / openSessionInMain / draft switch). A null id — a fresh draft
 * or the Welcome screen — clears the pointer so the app reopens to a draft
 * instead of snapping back to a stale session. Unlike recordSession this
 * writes NOTHING but the active pointers: it never creates or reorders index
 * entries, so merely *viewing* a session can't bump it in the sidebar. */
export function setActiveSession(sessionId: string | null): DesktopState {
  const state = loadDesktopState();
  if (!sessionId) {
    state.activeSessionId = undefined;
  } else {
    state.activeSessionId = sessionId;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session) {
      state.activeProjectId = session.projectId;
      state.activeWorkspaceId = session.workspaceId;
    }
  }
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

export async function touchWorkspace(cwd: string): Promise<{ state: DesktopState; project: DesktopProject; workspace: DesktopWorkspace }> {
  const now = new Date().toISOString();
  const absoluteCwd = await resolveWorkspaceDirectory(cwd);
  const gitRoot = await gitRootFor(absoluteCwd);
  const root = gitRoot ?? absoluteCwd;
  const projectId = stableId(root);
  const workspaceId = stableId(`${projectId}:${absoluteCwd}`);
  const branch = gitRoot ? await gitBranchFor(absoluteCwd) : undefined;
  const state = loadDesktopState();

  let project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    project = {
      id: projectId,
      root,
      name: path.basename(root) || root,
      gitRoot,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
    state.projects.unshift(project);
  } else {
    project.root = root;
    project.name ||= path.basename(root) || root;
    project.gitRoot = gitRoot;
    project.updatedAt = now;
    project.lastOpenedAt = now;
  }

  let workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    workspace = {
      id: workspaceId,
      projectId,
      cwd: absoluteCwd,
      branch,
      type: "local",
      createdAt: now,
      lastUsedAt: now,
    };
    state.workspaces.unshift(workspace);
  } else {
    workspace.cwd = absoluteCwd;
    workspace.branch = branch;
    workspace.lastUsedAt = now;
  }

  state.activeProjectId = projectId;
  state.activeWorkspaceId = workspaceId;
  saveDesktopState(sortState(state));
  return { state: loadDesktopState(), project, workspace };
}

export async function recordSession(session: SessionState, title?: string): Promise<{ state: DesktopState; session: DesktopSessionIndex }> {
  const { state, project, workspace } = await touchWorkspace(session.cwd);
  const existing = state.sessions.find((item) => item.id === session.id);
  const next = sessionIndexFromSnapshot(session, project.id, workspace.id, existing, title);

  if (existing) Object.assign(existing, next);
  else state.sessions.unshift(next);
  state.activeProjectId = project.id;
  state.activeWorkspaceId = workspace.id;
  state.activeSessionId = session.id;
  saveDesktopState(sortState(state));
  return { state: loadDesktopState(), session: next };
}

/** Refresh an existing sidebar row from an authoritative host snapshot without
 * changing which project/workspace/session the user is viewing. Agent-host
 * snapshots can belong to background sessions, so reusing recordSession here
 * would incorrectly move the active pointers to whichever task emitted last. */
export function syncSessionIndexFromSnapshot(session: SessionState): DesktopState {
  const state = loadDesktopState();
  const existing = state.sessions.find((item) => item.id === session.id);
  if (!existing) return state;
  Object.assign(
    existing,
    sessionIndexFromSnapshot(session, existing.projectId, existing.workspaceId, existing),
  );
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

/** Apply the host's dedicated title notification without changing active or
 * manual sidebar state. expectedTitle is a compare-and-swap guard: a slow title
 * model cannot overwrite a rename that landed while generation was in flight.
 * The optional snapshot closes the tiny session_created -> renderer-registration
 * race by creating a row only when its workspace is already known. */
export function syncSessionTitle(
  sessionId: string,
  title: string,
  expectedTitle: string,
  snapshot?: SessionState,
): { state: DesktopState; applied: boolean } {
  const state = loadDesktopState();
  let existing = state.sessions.find((item) => item.id === sessionId);
  const nextTitle = title.trim();
  if (!existing && snapshot?.id === sessionId && snapshot.title.trim() === expectedTitle) {
    const cwdKey = path.normalize(snapshot.cwd).toLowerCase();
    const workspace = state.workspaces.find(
      (item) => path.normalize(item.cwd).toLowerCase() === cwdKey,
    );
    if (workspace) {
      existing = sessionIndexFromSnapshot(snapshot, workspace.projectId, workspace.id);
      state.sessions.unshift(existing);
    }
  }
  if (!existing || !nextTitle || existing.title !== expectedTitle) {
    return { state, applied: false };
  }
  existing.title = nextTitle;
  existing.pendingObservedTitle = nextTitle;
  saveDesktopState(sortState(state));
  return { state: loadDesktopState(), applied: true };
}

function sessionIndexFromSnapshot(
  session: SessionState,
  projectId: string,
  workspaceId: string,
  existing?: DesktopSessionIndex,
  title?: string,
): DesktopSessionIndex {
  const createdAt = session.createdAt ?? new Date().toISOString();
  const titleState = sessionIndexTitle(session, existing, title);
  // Sort key for the sidebar: time of the most recent user↔assistant exchange.
  // Tool calls, background events, and session loads don't bump it — only a
  // real conversation message does. Falls back to createdAt for fresh sessions
  // that haven't been spoken to yet.
  const updatedAt = lastConversationAt(session) ?? createdAt;
  return {
    id: session.id,
    projectId,
    workspaceId,
    cwd: session.cwd,
    title: titleState.title,
    agent: session.agent,
    model: `${session.model.provider}/${session.model.model}`,
    permissionMode: session.permissionMode,
    messageCount: session.messages.length,
    toolCount: session.toolCalls.length,
    createdAt,
    updatedAt,
    pendingObservedTitle: titleState.pendingObservedTitle,
    // Forked sessions ("创建分支") carry their source id on the SessionState;
    // preserve it across re-records once set so the sidebar branch marker sticks.
    parentId: session.parentSessionId ?? existing?.parentId,
  };
}

function sessionIndexTitle(
  session: SessionState,
  existing?: DesktopSessionIndex,
  title?: string,
): { title: string; pendingObservedTitle?: string } {
  const explicit = title?.trim();
  if (explicit) return { title: explicit };
  const snapshot = session.title?.trim();
  const current = existing?.title?.trim();
  const pending = existing?.pendingObservedTitle?.trim();
  if (pending) {
    if (snapshot === pending) return { title: pending };
    return { title: current || pending, pendingObservedTitle: pending };
  }
  // A stale initial placeholder can arrive after a useful snapshot. Other
  // non-placeholder snapshots remain authoritative so a cold reload heals a
  // provisional index when the final title event was missed.
  if (snapshot === "Reina" && current && current !== "Reina") return { title: current };
  return { title: snapshot || current || titleFromSession(session) };
}

export async function deleteSession(sessionId: string): Promise<DesktopState> {
  const state = loadDesktopState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const cwd = session?.cwd;
  // Mutate + persist the index in one synchronous span (no await between load
  // and save) so a concurrent index writer — setSessionFlags / setSessionSortTs
  // pinning or reordering another session — can't be clobbered by this delete
  // saving stale in-memory state after an await. The session-file removal below
  // doesn't touch the index, so it runs after the atomic save.
  state.sessions = state.sessions.filter((item) => item.id !== sessionId);
  if (state.activeSessionId === sessionId) state.activeSessionId = undefined;
  saveDesktopState(sortState(state));
  if (cwd) {
    // Drop both the append-only event log and the legacy whole-file snapshot.
    // Either may be missing depending on whether the session has migrated
    // (or was deleted while never having been written), so we ignore errors.
    const jsonlPath = path.join(cwd, ".reina", "sessions", `${sessionId}.jsonl`);
    const jsonPath = path.join(cwd, ".reina", "sessions", `${sessionId}.json`);
    await Promise.all([
      rm(jsonlPath, { force: true }).catch(() => undefined),
      rm(jsonPath, { force: true }).catch(() => undefined),
    ]);
  }
  return loadDesktopState();
}

export async function renameSession(sessionId: string, title: string): Promise<DesktopState> {
  const state = loadDesktopState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const cleanTitle = title.trim().slice(0, 120);
  const cwd = session && cleanTitle ? session.cwd : undefined;
  if (session && cleanTitle) {
    session.title = cleanTitle;
    session.pendingObservedTitle = cleanTitle;
    session.updatedAt = new Date().toISOString();
  }
  // Persist the index synchronously (no await between load and save) so a
  // concurrent index writer isn't clobbered by this rename saving stale state
  // after the rollout/legacy writes. Those side files are independent of the
  // index, so they run after the atomic save.
  saveDesktopState(sortState(state));
  if (cwd) {
    // Append a `config` event to the session's rollout JSONL. This is what
    // the engine reads on the next cold load — appending here is atomic
    // and never races with concurrent writers. The legacy .json snapshot is
    // patched too for backward compat with un-migrated sessions.
    await appendTitleEventToRollout(cwd, sessionId, cleanTitle).catch(() => undefined);
    await mirrorTitleToLegacyJson(cwd, sessionId, cleanTitle).catch(() => undefined);
  }
  return loadDesktopState();
}

/** Toggle the pinned / archived flags on a session index entry. Each flag is
 * optional — only the ones present in `flags` are changed. Stored as ISO
 * timestamps so we can sort/age them later; `recordSession` preserves these
 * because it merges with Object.assign and never names these keys. */
export async function setSessionFlags(
  sessionId: string,
  flags: { pinned?: boolean; archived?: boolean },
): Promise<DesktopState> {
  const state = loadDesktopState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) {
    const now = new Date().toISOString();
    if (flags.pinned !== undefined) session.pinnedAt = flags.pinned ? now : undefined;
    if (flags.archived !== undefined) session.archivedAt = flags.archived ? now : undefined;
  }
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

/** Persist a session's manual sidebar position. `orderTs` is an effective
 * timestamp (the midpoint of the drop target's neighbours, computed by the
 * renderer) that the sort + time-bucketing use instead of `updatedAt`. Passing
 * null clears the override so the session falls back to recency. Like the pin /
 * archive flags, `recordSession`'s Object.assign merge never names `orderTs`, so
 * a later re-record can't wipe it. */
export async function setSessionSortTs(
  sessionId: string,
  orderTs: string | null,
): Promise<DesktopState> {
  const state = loadDesktopState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) session.orderTs = orderTs ?? undefined;
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

/** Persist a new manual project order (drag-to-reorder in the sidebar). Unknown
 * ids are dropped; any current project the caller omits is re-added at the front
 * by reconcileProjectOrder, so a partial list can't lose a project. */
export function setProjectOrder(orderedIds: string[]): DesktopState {
  const state = loadDesktopState();
  const existing = new Set(state.projects.map((project) => project.id));
  state.projectOrder = orderedIds.filter((id) => typeof id === "string" && existing.has(id));
  saveDesktopState(sortState(state));
  return loadDesktopState();
}

async function appendTitleEventToRollout(cwd: string, sessionId: string, title: string): Promise<void> {
  const file = path.join(cwd, ".reina", "sessions", `${sessionId}.jsonl`);
  // Use 'a' for atomic append; on POSIX this is one syscall and concurrent
  // appenders can't clobber each other. On Windows it's similarly safe at
  // the OS level. We don't check whether the file exists first — appending
  // to a nonexistent file in 'a' mode creates it.
  const handle = await open(file, "a").catch(() => null);
  if (!handle) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: "config",
      changes: { title },
    });
    await handle.write(`${line}\n`);
  } finally {
    await handle.close();
  }
}

async function mirrorTitleToLegacyJson(cwd: string, sessionId: string, title: string): Promise<void> {
  const file = path.join(cwd, ".reina", "sessions", `${sessionId}.json`);
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return;
  let parsed: { title?: string; updatedAt?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed.title === title) return;
  parsed.title = title;
  parsed.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
}

function emptyState(): DesktopState {
  return {
    version: 1,
    projects: [],
    workspaces: [],
    sessions: [],
    projectOrder: [],
  };
}

/**
 * Drop session index entries whose on-disk files no longer exist.
 *
 * The sidebar's session list lives in `desktop-state.json` under Electron's
 * userData directory — *not* under the project's `.reina/`. If the user
 * (or some external cleanup) deletes `.reina/sessions/`, the index keeps
 * pointing at files that aren't there and clicking a session yields the
 * "Session has no saved data on disk" error.
 *
 * Run this on app startup, before the renderer asks for the state. Each
 * surviving session is verified to have either `<id>.jsonl` (rollout
 * stream) or `<id>.json` (legacy snapshot). A missing project root or
 * unreachable cwd also counts as missing — there's nothing useful to
 * resume from. If `activeSessionId` referenced a pruned entry, clear it.
 */
export async function pruneMissingSessions(): Promise<{ removed: string[] }> {
  const state = loadDesktopState();
  const removed: string[] = [];
  const survivors: DesktopSessionIndex[] = [];
  for (const session of state.sessions) {
    const exists = await sessionHasOnDiskData(session.cwd, session.id);
    if (exists) survivors.push(session);
    else removed.push(session.id);
  }
  state.sessions = survivors;
  if (state.activeSessionId && removed.includes(state.activeSessionId)) {
    state.activeSessionId = undefined;
  }
  saveDesktopState(sortState(state));
  return { removed };
}

async function resolveWorkspaceDirectory(cwd: string): Promise<string> {
  const absoluteCwd = path.resolve(cwd);
  if (isPackagedAppPath(absoluteCwd)) {
    throw new Error(`Invalid workspace directory: ${absoluteCwd}`);
  }
  const info = await stat(absoluteCwd).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${absoluteCwd}`);
  }
  return absoluteCwd;
}

async function sessionHasOnDiskData(cwd: string, sessionId: string): Promise<boolean> {
  const dir = path.join(cwd, ".reina", "sessions");
  const jsonl = path.join(dir, `${sessionId}.jsonl`);
  const json = path.join(dir, `${sessionId}.json`);
  // We accept either file as evidence the session is still recoverable.
  // stat is cheap; we don't need to read or parse the contents here.
  if (await fileExists(jsonl)) return true;
  if (await fileExists(json)) return true;
  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** The timestamp the sidebar sorts + buckets a session by: the manual
 * drag-order override when present, otherwise its recency (`updatedAt`). */
function effectiveSessionTs(session: DesktopSessionIndex): string {
  return session.orderTs || session.updatedAt || session.createdAt || "";
}

function sortState(state: DesktopState): DesktopState {
  // Projects follow the user's manual order (projectOrder), NOT recency — so
  // opening or clicking a session never reshuffles the sidebar groups.
  reconcileProjectOrder(state);
  const orderIndex = new Map(state.projectOrder.map((id, i) => [id, i]));
  state.projects.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
  // Workspaces (recent-list popover) still sort by recency.
  state.workspaces.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  // Sessions sort by their effective position: a manually-dragged session uses
  // its `orderTs` override, everything else falls back to `updatedAt`. The
  // renderer buckets by the same effective timestamp, so a dragged row keeps
  // both its order and its time-group header after the move.
  state.sessions.sort((a, b) =>
    effectiveSessionTs(b).localeCompare(effectiveSessionTs(a)),
  );
  return state;
}

/** Keep projectOrder in sync with the known projects without disturbing the
 * user's arrangement: drop ids for projects that vanished, de-dupe, and add
 * brand-new projects at the FRONT so a freshly opened project surfaces on top.
 * On first run (empty projectOrder) this seeds the current order verbatim, so
 * upgrading doesn't visibly reshuffle anything. */
function reconcileProjectOrder(state: DesktopState): void {
  const existing = new Set(state.projects.map((project) => project.id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of state.projectOrder ?? []) {
    if (existing.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  const prepend: string[] = [];
  for (const project of state.projects) {
    if (!seen.has(project.id)) {
      prepend.push(project.id);
      seen.add(project.id);
    }
  }
  state.projectOrder = [...prepend, ...ordered];
}

function sanitizeState(state: DesktopState): DesktopState {
  const workspaces = state.workspaces.filter((workspace) => isSafeWorkspaceDirectory(workspace.cwd));
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const projectIds = new Set(workspaces.map((workspace) => workspace.projectId));
  const sessions = state.sessions.filter(
    (session) => workspaceIds.has(session.workspaceId) && isSafeWorkspaceDirectory(session.cwd),
  );
  const sessionProjectIds = new Set(sessions.map((session) => session.projectId));
  const projects = state.projects.filter(
    (project) => (projectIds.has(project.id) || sessionProjectIds.has(project.id)) && !isPackagedAppPath(project.root),
  );
  if (state.activeWorkspaceId && !workspaceIds.has(state.activeWorkspaceId)) state.activeWorkspaceId = undefined;
  if (state.activeProjectId && !projects.some((project) => project.id === state.activeProjectId)) state.activeProjectId = undefined;
  if (state.activeSessionId && !sessions.some((session) => session.id === state.activeSessionId)) state.activeSessionId = undefined;
  return sortState({
    ...state,
    projects,
    workspaces,
    sessions,
  });
}

function isSafeWorkspaceDirectory(cwd: string): boolean {
  if (!cwd || isPackagedAppPath(cwd)) return false;
  try {
    return statSync(path.resolve(cwd)).isDirectory();
  } catch {
    return false;
  }
}

function isPackagedAppPath(value: string): boolean {
  const normalized = path.resolve(value).replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith("/app.asar") ||
    normalized.includes("/app.asar/") ||
    normalized.endsWith("/app.asar.unpacked") ||
    normalized.includes("/app.asar.unpacked/")
  );
}

function stableId(input: string): string {
  return crypto.createHash("sha1").update(path.normalize(input).toLowerCase()).digest("hex").slice(0, 16);
}

async function gitRootFor(cwd: string): Promise<string | undefined> {
  try {
    return (await execFilePromise("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitBranchFor(cwd: string): Promise<string | undefined> {
  try {
    return (await execFilePromise("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

function titleFromSession(session: SessionState): string {
  const firstUser = session.messages.find((message) => message.role === "user")?.content.trim();
  if (firstUser) return firstUser.replace(/\s+/g, " ").slice(0, 80);
  return `Session ${session.id.slice(0, 8)}`;
}

function lastConversationAt(session: SessionState): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user" || m.role === "assistant") return m.createdAt;
  }
  return undefined;
}
