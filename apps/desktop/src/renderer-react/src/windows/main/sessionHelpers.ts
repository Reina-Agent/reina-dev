// Pure helpers ported from the legacy renderer's session-helpers.js and format.js.
// These are stateless, side-effect-free functions consumed by SessionList.tsx.
// Keep this file in sync with:
//   apps/desktop/src/renderer/actions/session-helpers.js
//   apps/desktop/src/renderer/format.js (shortPath)

import type { DesktopState, SessionListItem } from "./protocol";

// ---------------------------------------------------------------------------
// shortPath — ported from renderer/format.js
// ---------------------------------------------------------------------------

export function shortPath(value: string): string {
  return value.replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// sessionListAgeLabel — relative time chip text
// ---------------------------------------------------------------------------

export function sessionListAgeLabel(item: SessionListItem, now = Date.now()): string {
  const timestamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

// ---------------------------------------------------------------------------
// sessionListAgeTitle — tooltip text for the age chip
// ---------------------------------------------------------------------------

export function sessionListAgeTitle(item: SessionListItem): string {
  const timestamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
  const updated = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Unknown";
  return [`Updated: ${updated}`, `Model: ${item.model ?? ""}`]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Session group — the shape returned by groupSessionsByProject
// ---------------------------------------------------------------------------

export interface SessionGroup {
  /** Stable id: projectId or `orphan:<title>`. */
  id: string;
  title: string;
  sessions: SessionListItem[];
}

// ---------------------------------------------------------------------------
// groupSessionsByProject — bucket sessions under their project heading
// ---------------------------------------------------------------------------

export function groupSessionsByProject(
  snapshot: DesktopState,
  sessions: SessionListItem[],
  { includeEmpty = false }: { includeEmpty?: boolean } = {},
): SessionGroup[] {
  const workspaces = new Map(
    snapshot.workspaces.map((ws) => [ws.id, ws]),
  );
  const knownProjectIds = new Set(snapshot.projects.map((p) => p.id));
  const byProject = new Map<string, SessionListItem[]>();
  const orphans = new Map<string, SessionListItem[]>();

  for (const session of sessions) {
    const ws = workspaces.get(session.workspaceId ?? "");
    const projectId = session.projectId ?? ws?.projectId;
    if (projectId && knownProjectIds.has(projectId)) {
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId)!.push(session);
    } else {
      const title = shortPath(session.cwd) || "Home";
      if (!orphans.has(title)) orphans.set(title, []);
      orphans.get(title)!.push(session);
    }
  }

  const groups: SessionGroup[] = [];
  for (const project of snapshot.projects) {
    const groupSessions = byProject.get(project.id) ?? [];
    if (groupSessions.length === 0 && !includeEmpty) continue;
    groups.push({
      id: project.id,
      title: project.name || shortPath(project.root) || "Home",
      sessions: groupSessions,
    });
  }
  for (const [title, groupSessions] of orphans) {
    groups.push({ id: `orphan:${title}`, title, sessions: groupSessions });
  }

  const tier = (s: SessionListItem): number =>
    s.draft ? 0 : s.pinnedAt ? 1 : 2;
  for (const group of groups) {
    group.sessions.sort((a, b) => tier(a) - tier(b));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// DRAFT_SESSION_ID / ARCHIVED_GROUP_ID — sentinel constants (mirrored from
// session.js so SessionList can reference the same values).
// ---------------------------------------------------------------------------

export const DRAFT_SESSION_ID = "__draft__";
export const ARCHIVED_GROUP_ID = "__archived__";
export const COLLAPSED_GROUPS_KEY = "reina:desktop:collapsed-projects";

// ---------------------------------------------------------------------------
// Collapsed-groups persistence (localStorage) — mirrors loadCollapsedGroups /
// persistCollapsedGroups from session.js, kept as a simple module singleton so
// SessionList can treat it as a plain Set.
// ---------------------------------------------------------------------------

export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw === null) return new Set([ARCHIVED_GROUP_ID]);
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set([ARCHIVED_GROUP_ID]);
  }
}

export function persistCollapsedGroups(groups: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // localStorage unavailable (private mode / quota) — collapse state is
    // cosmetic convenience, silently skip.
  }
}

// The timestamp the sidebar sorts a session by: a manual drag-order override
// (orderTs) when present, otherwise its recency. Mirrors effectiveSessionTs in
// desktop-state.ts so a dragged row lands where it was dropped. The age chip
// (sessionListAgeLabel) deliberately stays on updatedAt to reflect real
// activity, not the manual position.
export function effectiveSessionTs(item: SessionListItem): string {
  return item.orderTs || item.updatedAt || item.createdAt || "";
}
