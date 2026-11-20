// Workspace window — React port of the legacy workspace pane.
// Scope: Git tab (changes list + diff view) and Files tab (lazy file tree + file viewer).
// Other tabs (Terminal, Agent Team, Notes, DAG, Conversation) are left as
// "coming soon" stubs since their full port is out of scope here.
//
// Bridge events subscribed:
//   "open-workspace" — fired when another window switches workspace; reload cwd + panels.
//   "view-settings-changed" — handled by subscribeViewSettingsBroadcast (imported).
//
// Persistence (via bridge().storeGet/storeSet "view-settings"):
//   "diffMode"              — "unified" | "split"
//   "gitSidebarCollapsed"   — "1" | "0"

import { useCallback, useEffect, useRef, useState } from "react";
import { TitleBar } from "~/components/TitleBar";
import { ResizeHandle } from "~/components/ResizeHandle";
import { useResizableSidebar } from "~/lib/useResizableSidebar";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";
import { loadViewSettings, subscribeViewSettingsBroadcast } from "~/lib/viewSettings";
import { FileTree, type FileEntry } from "./FileTree";
import { GitChanges, type GitChange } from "./GitChanges";
import { DiffView, type DiffResult, type DiffMode } from "./DiffView";
import { FileViewer, FileViewerEmpty, type FileResult } from "./FileViewer";
import { NotesTab, type NoteMeta } from "./NotesTab";
import { TerminalTab } from "./TerminalTab";
import { BackgroundTasksTab } from "./BackgroundTasksTab";
import { ConversationTab } from "./ConversationTab";
import { AgentTeamTab } from "./AgentTeamTab";
import { ContextTab } from "./ContextTab";
import { DagTab } from "./DagTab";
import { SideChatTab } from "./SideChatTab";
import { initWorkspaceEngineStore, setWorkspaceSession, useWorkspaceEngine } from "./workspaceEngineStore";
import { readWorkspaceFrameContext, type WorkspaceFrameContext } from "./workspaceFrameContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceTab =
  | "git"
  | "files"
  | "notes"
  | "terminal"
  | "tasks"
  | "sideChat"
  | "conversation"
  | "agentTeam"
  | "context"
  | "dag";

const WORKSPACE_TABS: readonly WorkspaceTab[] = [
  "git",
  "files",
  "notes",
  "terminal",
  "tasks",
  "sideChat",
  "conversation",
  "agentTeam",
  "context",
  "dag",
];

function asWorkspaceTab(value: unknown): WorkspaceTab | null {
  return typeof value === "string" && (WORKSPACE_TABS as readonly string[]).includes(value)
    ? (value as WorkspaceTab)
    : null;
}

// Initial tab from the load query (?tab=…). Another window can deep-link the
// workspace to a specific tab. Defaults to Git.
function initialTab(): WorkspaceTab {
  return asWorkspaceTab(new URLSearchParams(location.search).get("tab")) ?? "git";
}

function initialSideChatDraft(): string | null {
  const draft = new URLSearchParams(location.search).get("sideChatDraft");
  return draft?.trim() ? draft : null;
}

// ── Icon helpers ──────────────────────────────────────────────────────────────

function GitBranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 01-9 9" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  );
}

function ContextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
      <path d="M3 3v18h18M7 15v-4m5 4V7m5 8V4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function RevealIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

// Faceted-gem glyph for the "open notebook in Obsidian" action.
function ObsidianIcon() {
  return (
    // official Obsidian mark (Simple Icons), brand purple so it reads as Obsidian
    <svg width="13" height="13" viewBox="0 0 24 24" fill="#7c3aed" aria-hidden>
      <path d="M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function OpenMainIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

// Unified sidebar-collapse glyph (panel-left). Shared across the Git, Files
// and Notes sub-toolbars; Terminal / Agent Team render the same shape.
function SidebarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

// Tab-strip glyphs for the inter-agent tabs (sized to match Git/Files/Notes).

function TerminalTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function TasksTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 2 2 3-3M14 10h3M7 15h10" />
    </svg>
  );
}

function AgentTeamTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function ConversationTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

function SideChatTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

function DagTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <path d="M6 9v3a3 3 0 0 0 3 3h3" />
      <path d="M18 9v6" />
    </svg>
  );
}

const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
  git: "Git",
  files: "Files",
  notes: "Notes",
  terminal: "Terminal",
  tasks: "Tasks",
  sideChat: "Side Chat",
  conversation: "Team Messages",
  agentTeam: "Agent Team",
  context: "Context",
  dag: "DAG",
};

const WORKSPACE_TAB_DESCRIPTIONS: Record<WorkspaceTab, string> = {
  git: "Review changes and diffs",
  files: "Browse and edit project files",
  notes: "Workspace and global notes",
  terminal: "Run commands in your project",
  tasks: "Monitor background commands",
  sideChat: "Ask a follow-up in parallel",
  conversation: "Messages between agents",
  agentTeam: "Agent activity and results",
  context: "Request trends, contents and compaction history",
  dag: "Task dependencies and progress",
};

function WorkspaceTabIcon({ tab }: { tab: WorkspaceTab }) {
  switch (tab) {
    case "git": return <GitBranchIcon />;
    case "files": return <FolderIcon />;
    case "notes": return <NotesIcon />;
    case "terminal": return <TerminalTabIcon />;
    case "tasks": return <TasksTabIcon />;
    case "sideChat": return <SideChatTabIcon />;
    case "conversation": return <ConversationTabIcon />;
    case "agentTeam": return <AgentTeamTabIcon />;
    case "context": return <ContextIcon />;
    case "dag": return <DagTabIcon />;
  }
}

// ── Small reusable icon button ────────────────────────────────────────────────

function IconButton({
  title,
  onClick,
  children,
  active,
  disabled,
  buttonRef,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-fast) disabled:pointer-events-none disabled:opacity-40 " +
        (active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

// ── Segmented diff-mode toggle ────────────────────────────────────────────────

function DiffModeToggle({
  mode,
  onChange,
}: {
  mode: DiffMode;
  onChange: (m: DiffMode) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-(--surface-divider) bg-secondary/40">
      {(["unified", "split"] as DiffMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={
            "h-[22px] px-2.5 text-[11px] capitalize transition-colors duration-(--motion-fast) first:rounded-l-md last:rounded-r-md " +
            (mode === m
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// ── Sort workspace files (mirrors legacy compareFileEntries) ──────────────────

function normPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function compareFileEntries(a: FileEntry, b: FileEntry): number {
  const aParts = normPath(a.path).split("/");
  const bParts = normPath(b.path).split("/");
  const min = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < min; i++) {
    if (aParts[i] === bParts[i]) continue;
    const aIsDir = a.type === "directory" || i < aParts.length - 1;
    const bIsDir = b.type === "directory" || i < bParts.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return aParts[i].localeCompare(bParts[i]);
  }
  return aParts.length - bParts.length;
}

// Merge newly-loaded dir children into the existing file list (dedup + re-sort).
function mergeFiles(existing: FileEntry[], incoming: FileEntry[]): FileEntry[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((f) => normPath(f.path)));
  const next = [...existing];
  for (const entry of incoming) {
    const key = normPath(entry.path);
    if (!seen.has(key)) {
      seen.add(key);
      next.push(entry);
    }
  }
  return next.sort(compareFileEntries);
}

// ── Main component ────────────────────────────────────────────────────────────

export function WorkspaceApp({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const workspaceTabLabels = { ...WORKSPACE_TAB_LABELS, context: t("context.title") };
  const workspaceTabDescriptions = { ...WORKSPACE_TAB_DESCRIPTIONS, context: t("context.description") };
  // ── Workspace cwd resolution
  const [cwd, setCwd] = useState<string | null>(null);
  const activeWorkspaceCwdRef = useRef<string | null>(null);
  const [initDone, setInitDone] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const appMenuTriggerRef = useRef<HTMLButtonElement>(null);

  // ── Tab state (seeded from the load query for deep-links — see initialTab)
  const [activeTab, setActiveTab] = useState<WorkspaceTab | null>(() => embedded ? null : initialTab());
  const [openWorkspaceTabs, setOpenWorkspaceTabs] = useState<WorkspaceTab[]>(() => embedded ? [] : [...WORKSPACE_TABS]);
  const [embeddedContext, setEmbeddedContext] = useState<WorkspaceFrameContext | null>(null);
  const [sideChatQuoteRequest, setSideChatQuoteRequest] = useState<{ text: string; seq: number } | null>(() => {
    const text = embedded ? null : initialSideChatDraft();
    return text ? { text, seq: 1 } : null;
  });
  const [sideChatResetRequest, setSideChatResetRequest] = useState(0);
  const [contextSelection, setContextSelection] = useState<{ taskId: string | null; seq: number }>({ taskId: null, seq: 0 });

  const openWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setOpenWorkspaceTabs((tabs) => tabs.includes(tab) ? tabs : [...tabs, tab]);
    setActiveTab(tab);
  }, []);

  const openContext = useCallback((taskId: string | null = null) => {
    setContextSelection((current) => ({ taskId, seq: current.seq + 1 }));
    openWorkspaceTab("context");
  }, [openWorkspaceTab]);

  const closeWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    const index = openWorkspaceTabs.indexOf(tab);
    const nextTabs = openWorkspaceTabs.filter((openTab) => openTab !== tab);
    setOpenWorkspaceTabs(nextTabs);
    if (activeTab === tab) {
      setActiveTab(nextTabs[Math.min(index, nextTabs.length - 1)] ?? null);
    }
    setAppMenuOpen(false);
  }, [activeTab, openWorkspaceTabs]);

  useEffect(() => {
    if (!embedded) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const context = readWorkspaceFrameContext(event.data);
      if (context) {
        setEmbeddedContext(context);
        return;
      }
      const message = event.data as { type?: unknown; tab?: unknown; draft?: unknown } | null;
      if (message?.type === "reina:focus-workspace-tab") {
        const tab = asWorkspaceTab(message.tab);
        if (tab === "context") openContext();
        else if (tab) openWorkspaceTab(tab);
        else if (message.tab == null) setActiveTab(null);
        return;
      }
      if (message?.type === "reina:side-chat-draft" && typeof message.draft === "string") {
        setSideChatQuoteRequest((current) => ({
          text: message.draft as string,
          seq: (current?.seq ?? 0) + 1,
        }));
        openWorkspaceTab("sideChat");
        return;
      }
      if (message?.type === "reina:new-side-chat") {
        setSideChatResetRequest((current) => current + 1);
        openWorkspaceTab("sideChat");
      }
    };
    window.addEventListener("message", onMessage);
    // The parent may have tried to focus a tab before this iframe's React
    // effects were mounted. A ready handshake lets it replay the pending tab.
    window.parent.postMessage({ type: "reina:workspace-ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [embedded, openWorkspaceTab, openContext]);

  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActionsMenuOpen(false);
      actionsMenuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsMenuOpen]);

  useEffect(() => {
    if (!appMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!appMenuRef.current?.contains(event.target as Node)) {
        setAppMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAppMenuOpen(false);
      appMenuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [appMenuOpen]);

  // ── Git tab state
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMode, setDiffModeState] = useState<DiffMode>("unified");
  const [gitSidebarCollapsed, setGitSidebarCollapsed] = useState(false);
  const [changesLoading, setChangesLoading] = useState(false);

  // ── Files tab state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [loadedDirs, setLoadedDirs] = useState<Set<string>>(new Set([""]));
  const [activeFile, setActiveFile] = useState<FileResult | null>(null);
  // Open-file tab strip (mirror legacy openFileTabs): paths of files opened in
  // the viewer, capped at the 8 most recent. Tab switch re-reads via
  // handleFileClick so content stays fresh.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

  // ── Notes tab state
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesFolderOpening, setNotesFolderOpening] = useState(false);
  const notesLoadedCwd = useRef<string | null>(null);
  // Which notebook the tab shows: this project's audit dossier (`workspace`,
  // `.reina/notes`) or the cross-project self-evolve memory (`global`,
  // `<REINA_HOME>/notes`). Global is what the self-evolve loop writes to.
  const [notesScope, setNotesScope] = useState<"workspace" | "global">("workspace");
  const notesScopeRef = useRef(notesScope);
  notesScopeRef.current = notesScope;

  // Track latest requested file/diff to handle races
  const pendingFile = useRef<string | null>(null);
  const pendingDiff = useRef<string | null>(null);

  // ── Resizable inner sidebars (drag-to-resize + persisted width). Git keeps
  // its own collapse state below (persisted to view-settings); the Files tree
  // uses the hook's own collapse. ──────────────────────────────────────────
  const gitSidebar = useResizableSidebar({
    storageKey: "reina.workspace.gitSidebarWidth",
    defaultWidth: 224,
    minWidth: 180,
    maxWidth: 460,
  });
  const filesSidebar = useResizableSidebar({
    storageKey: "reina.workspace.filesSidebar",
    defaultWidth: 224,
    minWidth: 180,
    maxWidth: 460,
  });
  const notesSidebar = useResizableSidebar({
    storageKey: "reina.workspace.notesSidebar",
    defaultWidth: 256,
    minWidth: 200,
    maxWidth: 460,
  });

  // ── Persist diffMode to view-settings ────────────────────────────────────

  const setDiffMode = useCallback((next: DiffMode) => {
    setDiffModeState(next);
    void bridge().storeSet("view-settings", "diffMode", next).catch(() => undefined);
    // Re-fetch if a change is selected
    if (selectedChange && cwd) {
      pendingDiff.current = selectedChange;
      setDiffLoading(true);
      bridge()
        .getGitDiff(cwd, selectedChange, next)
        .then((result) => {
          if (pendingDiff.current !== selectedChange) return;
          setDiff(result as DiffResult);
        })
        .catch(() => setDiff(null))
        .finally(() => setDiffLoading(false));
    }
  }, [selectedChange, cwd]);

  // ── Persist gitSidebarCollapsed ───────────────────────────────────────────

  const toggleGitSidebar = useCallback(() => {
    setGitSidebarCollapsed((prev) => {
      const next = !prev;
      void bridge().storeSet("view-settings", "gitSidebarCollapsed", next ? "1" : "0").catch(() => undefined);
      return next;
    });
  }, []);

  // ── Load git changes ──────────────────────────────────────────────────────

  const loadChanges = useCallback(async (workspaceCwd: string) => {
    setChangesLoading(true);
    setStatusMsg("");
    try {
      const result = await bridge().listGitChanges(workspaceCwd);
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      setChanges((result as GitChange[] | null) ?? []);
    } catch {
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      setChanges([]);
      setStatusMsg("Could not load git changes.");
    } finally {
      if (activeWorkspaceCwdRef.current === workspaceCwd) setChangesLoading(false);
    }
  }, []);

  // ── Load file list ────────────────────────────────────────────────────────

  const loadFiles = useCallback(async (workspaceCwd: string) => {
    try {
      const result = await bridge().listWorkspace(workspaceCwd);
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      const entries = ((result as FileEntry[] | null) ?? []).sort(compareFileEntries);
      setFiles(entries);
      setLoadedDirs(new Set([""]));
      setExpandedDirs(new Set());
    } catch {
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      setFiles([]);
    }
  }, []);

  // ── Load notes (shared notebook) ──────────────────────────────────────────

  // Monotonic load counter: any newer loadNotes call invalidates in-flight
  // ones, so a slow response from the OTHER scope (or an old cwd) can never
  // commit over the list the user is looking at now.
  const notesLoadSeq = useRef(0);
  const loadNotes = useCallback(async (workspaceCwd: string) => {
    const seq = ++notesLoadSeq.current;
    const scope = notesScopeRef.current;
    // A commit is stale once a newer load started, the scope flipped under
    // us, or (per-workspace notebook only) the workspace changed.
    const stale = () =>
      seq !== notesLoadSeq.current ||
      scope !== notesScopeRef.current ||
      (scope === "workspace" && notesLoadedCwd.current !== workspaceCwd);
    setNotesLoading(true);
    try {
      const result = (await bridge().listNotes(
        scope === "global" ? undefined : workspaceCwd,
        scope,
      )) as { notes?: NoteMeta[] } | null;
      if (stale()) return;
      setNotes(result?.notes ?? []);
    } catch {
      if (stale()) return;
      setNotes([]);
    } finally {
      // A newer load owns notesLoading now; only the freshest call clears it.
      if (!stale()) setNotesLoading(false);
    }
  }, []);

  // readNote bound to the active scope — returns the note body string. Global
  // notes read by id alone (no cwd); workspace notes need the active cwd.
  const readNoteBody = useCallback(async (noteId: string): Promise<string> => {
    if (notesScopeRef.current === "global") {
      const result = await bridge().readNote(undefined, noteId, "global") as { body?: string } | null;
      return result?.body ?? "";
    }
    if (!cwd) return "";
    const result = await bridge().readNote(cwd, noteId) as { body?: string } | null;
    return result?.body ?? "";
  }, [cwd]);

  // Reload when the user flips workspace ⇄ global while the Notes tab is open.
  // The cwd guard also skips the mount run: a ?tab=notes deep-link renders
  // before cwd resolves, and loading "" would just scan the wrong (default)
  // workspace and be discarded as stale — the lazy-load effect below does the
  // real first load once cwd lands.
  useEffect(() => {
    if (activeTab !== "notes" || cwd == null) return;
    void loadNotes(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesScope]);

  // ── Refresh both panels ───────────────────────────────────────────────────

  const refreshPanels = useCallback(async (workspaceCwd: string) => {
    await Promise.all([loadChanges(workspaceCwd), loadFiles(workspaceCwd)]);
  }, [loadChanges, loadFiles]);

  const switchWorkspaceView = useCallback(async (nextCwd: string | null) => {
    if (activeWorkspaceCwdRef.current === nextCwd) return;
    activeWorkspaceCwdRef.current = nextCwd;
    pendingFile.current = null;
    pendingDiff.current = null;
    notesLoadSeq.current += 1;
    setCwd(nextCwd);
    setStatusMsg("");
    setChanges([]);
    setFiles([]);
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    setLoadedDirs(new Set([""]));
    setActiveFile(null);
    setOpenTabs([]);
    setSelectedChange(null);
    setDiff(null);
    setDiffLoading(false);
    setFileLoading(false);
    setNotes([]);
    setNotesLoading(false);
    notesLoadedCwd.current = null;
    if (!nextCwd) {
      setChangesLoading(false);
      return;
    }
    await refreshPanels(nextCwd);
  }, [refreshPanels]);

  useEffect(() => {
    if (!embedded || !embeddedContext) return;
    setWorkspaceSession(embeddedContext.sessionId);
    void switchWorkspaceView(embeddedContext.cwd);
  }, [embedded, embeddedContext, switchWorkspaceView]);

  // ── Dir toggle ────────────────────────────────────────────────────────────

  const handleDirToggle = useCallback(async (dirPath: string) => {
    const norm = normPath(dirPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(norm)) {
        next.delete(norm);
        return next;
      }
      next.add(norm);
      return next;
    });

    // Already loaded — just toggling expand state, no fetch needed
    if (loadedDirs.has(norm)) return;

    if (!cwd) return;
    const workspaceCwd = cwd;
    setLoadingDirs((prev) => new Set([...prev, norm]));
    try {
      const children = await bridge().listWorkspaceDir(workspaceCwd, dirPath);
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      setFiles((prev) => mergeFiles(prev, (children as FileEntry[] | null) ?? []));
      setLoadedDirs((prev) => new Set([...prev, norm]));
    } catch {
      if (activeWorkspaceCwdRef.current !== workspaceCwd) return;
      // collapse on error
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.delete(norm);
        return next;
      });
    } finally {
      if (activeWorkspaceCwdRef.current === workspaceCwd) {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(norm);
          return next;
        });
      }
    }
  }, [cwd, loadedDirs]);

  // ── Open file ─────────────────────────────────────────────────────────────

  const handleFileClick = useCallback(async (filePath: string) => {
    if (!cwd) return;
    pendingFile.current = filePath;
    setFileLoading(true);
    setActiveTab("files");
    try {
      const result = await bridge().readWorkspaceFile(cwd, filePath);
      if (pendingFile.current !== filePath) return;
      const typed = result as FileResult & { kind?: string } | null;
      if (!typed || typed.kind === "directory" || typed.kind === "not_found") return;
      setActiveFile(typed);
      // Track in the tab strip (append if new, keep the 8 most recent).
      setOpenTabs((prev) => (prev.includes(filePath) ? prev : [...prev, filePath].slice(-8)));
    } catch {
      // silently ignore
    } finally {
      if (pendingFile.current === filePath) setFileLoading(false);
    }
  }, [cwd]);

  // Close a file tab. When closing the active file, fall back to the neighbour
  // tab (next, else previous), or clear the viewer when none remain.
  const handleCloseTab = useCallback(
    (filePath: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(filePath);
        const next = prev.filter((p) => p !== filePath);
        if (activeFile?.path === filePath) {
          const fallback = next[idx] ?? next[idx - 1] ?? null;
          if (fallback) void handleFileClick(fallback);
          else setActiveFile(null);
        }
        return next;
      });
    },
    [activeFile, handleFileClick],
  );

  // ── Open diff ─────────────────────────────────────────────────────────────

  const handleChangeSelect = useCallback(async (filePath: string) => {
    if (!cwd) return;
    setSelectedChange(filePath);
    setDiff(null);
    pendingDiff.current = filePath;
    setDiffLoading(true);
    try {
      const result = await bridge().getGitDiff(cwd, filePath, diffMode);
      if (pendingDiff.current !== filePath) return;
      setDiff(result as DiffResult);
    } catch {
      setDiff(null);
    } finally {
      if (pendingDiff.current === filePath) setDiffLoading(false);
    }
  }, [cwd, diffMode]);

  // ── File save callback ────────────────────────────────────────────────────

  const handleFileSaved = useCallback((updated: FileResult) => {
    setActiveFile(updated);
    // Refresh git changes after save (file may now appear as modified)
    if (cwd) void loadChanges(cwd);
  }, [cwd, loadChanges]);

  // ── Toolbar actions ───────────────────────────────────────────────────────

  const handleReveal = useCallback(() => {
    if (!cwd) return;
    const targetPath = activeFile?.path
      ? `${cwd}/${activeFile.path}`.replaceAll("\\\\", "/")
      : cwd;
    void bridge().revealInFolder(targetPath).catch(() => undefined);
  }, [cwd, activeFile]);

  const handleOpenShell = useCallback(() => {
    if (!cwd) return;
    void bridge().openShellIn(cwd).catch(() => undefined);
  }, [cwd]);

  const handleOpenInMain = useCallback(() => {
    if (!cwd) return;
    void bridge().openWorkspaceInMain(cwd).catch(() => undefined);
  }, [cwd]);

  const handleOpenDetached = useCallback(() => {
    void bridge().openWorkspaceWindow({ tab: activeTab ?? undefined, detached: true }).catch(() => undefined);
  }, [activeTab]);

  const handleOpenWorkspace = useCallback(async () => {
    const picked = await bridge().openDirectoryPicker().catch(() => null);
    if (!picked) return;
    await bridge().touchWorkspace(picked).catch(() => undefined);
    await switchWorkspaceView(picked);
  }, [switchWorkspaceView]);

  // ── Mount: resolve cwd, load persisted settings, subscribe events ─────────

  useEffect(() => {
    // StrictMode-safe: init subscribes only after several awaits, so the first
    // mount's cleanup can run BEFORE those assignments land — without the
    // cancelled flag the subscriptions taken after that point would leak
    // permanently and keep calling setState against an unmounted tree.
    let cancelled = false;
    let unsubWs: (() => void) | undefined;
    let unsubVs: (() => void) | undefined;
    let unsubFocus: (() => void) | undefined;
    let unsubSideChatDraft: (() => void) | undefined;

    async function init() {
      // Subscribe ONCE to the broadcast "agent" engine stream so the
      // Conversation / Agent Team / DAG tabs receive live data
      // (subtasks, async tasks, notes) regardless of which tab is
      // active. Idempotent — safe to call on every mount.
      initWorkspaceEngineStore();
      // Cold-load: the store only fills from the broadcast "agent" feed forward
      // of this subscription, and the host emits session_snapshot only on
      // main-window-initiated requests + turn boundaries. So a Workspace window
      // opened (or reloaded) mid-turn would show empty Agent Team / DAG until the
      // next live event. Ask the main process to replay the cached active-session
      // snapshot now that we're subscribed — this is what populates the tabs when
      // async tasks were dispatched before this window came up.
      void bridge().invoke("replay_engine_snapshot").catch(() => undefined);

      // Load appearance settings
      await loadViewSettings().catch(() => undefined);
      if (cancelled) return;
      unsubVs = subscribeViewSettingsBroadcast();

      // Load persisted workspace preferences
      const api = bridge();
      const [storedDiffMode, storedSidebarCollapsed] = await Promise.all([
        api.storeGet("view-settings", "diffMode").catch(() => null),
        api.storeGet("view-settings", "gitSidebarCollapsed").catch(() => null),
      ]);
      if (cancelled) return;
      if (storedDiffMode === "unified" || storedDiffMode === "split") {
        setDiffModeState(storedDiffMode);
      }
      setGitSidebarCollapsed(storedSidebarCollapsed === "1");

      // Resolve active workspace from desktop state
      const desktopState = await api.getDesktopState().catch(() => null) as {
        workspaces?: Array<{ id: string; cwd: string }>;
        activeWorkspaceId?: string;
        activeSessionId?: string;
      } | null;
      if (cancelled) return;

      // Bind the engine store to the user's foreground session so background
      // sessions can't bleed into the DAG / Agent Team / Conversation / Notes
      // tabs (mirrors the main window's per-session isolation). Detached
      // windows use desktop broadcasts; the embedded frame uses parent context.
      if (!embedded && desktopState?.activeSessionId) setWorkspaceSession(desktopState.activeSessionId);

      const workspaceCwd = embedded
        ? null
        : desktopState?.workspaces?.find((w) => w.id === desktopState.activeWorkspaceId)?.cwd ?? null;

      if (workspaceCwd) {
        await switchWorkspaceView(workspaceCwd);
        if (cancelled) return;
      }

      setInitDone(true);

      // Another window asking this (already-open) workspace to focus a tab —
      // the fresh-window case is handled by initialTab() from the load query.
      unsubFocus = api.events.on("focus-workspace-tab", (payload) => {
        const tab = asWorkspaceTab((payload as { tab?: unknown } | null)?.tab);
        if (tab === "context") openContext();
        else if (tab) openWorkspaceTab(tab);
      });
      unsubSideChatDraft = api.events.on("side-chat-draft", (payload) => {
        const draft = (payload as { draft?: unknown } | null)?.draft;
        if (typeof draft !== "string" || !draft.trim()) return;
        setSideChatQuoteRequest((current) => ({
          text: draft,
          seq: (current?.seq ?? 0) + 1,
        }));
        openWorkspaceTab("sideChat");
      });

      // Subscribe to workspace switches from other windows
      if (!embedded) {
        unsubWs = api.events.on("open-workspace", (payload) => {
          const newCwd = typeof payload === "string" ? payload : null;
          if (newCwd) void switchWorkspaceView(newCwd);
        });
      }
    }

    void init();

    return () => {
      cancelled = true;
      unsubWs?.();
      unsubVs?.();
      unsubFocus?.();
      unsubSideChatDraft?.();
    };
  }, [embedded, openWorkspaceTab, openContext, switchWorkspaceView]);

  // ── Lazy-load notes when the Notes tab is active (or cwd changes) ──────────
  // Mirrors how Git/Files load, but deferred to first activation so the
  // notebook isn't fetched for workspaces the user never opens it on.
  useEffect(() => {
    if (activeTab !== "notes" || !cwd) return;
    if (notesLoadedCwd.current === cwd) return;
    notesLoadedCwd.current = cwd;
    void loadNotes(cwd);
  }, [activeTab, cwd, loadNotes]);

  // ── Live refresh: re-read the notebook when a notes-updated event fires ─────
  // The engine store bumps notesVersion on every notes-updated delta; if this
  // cwd's notebook has already been cold-loaded, re-listNotes so the Notes tab
  // updates in real time instead of staying stale until manual Refresh.
  const workspaceSessionId = useWorkspaceEngine((s) => s.sessionId);
  const notesVersion = useWorkspaceEngine((s) => s.notesVersion);
  useEffect(() => {
    if (!cwd || notesVersion === 0) return;
    if (notesLoadedCwd.current !== cwd) return; // not cold-loaded yet — lazy-load handles it
    // Workspace deltas can't change the global list — skip while the Global
    // tab is showing (the scope-flip effect reloads on the way back anyway).
    if (notesScopeRef.current !== "workspace") return;
    void loadNotes(cwd);
  }, [notesVersion, cwd, loadNotes]);

  // Same live refresh for the GLOBAL notebook: bumped by global-notes-updated
  // (self-evolve reviews / note(scope:"global") writes from any session).
  const globalNotesVersion = useWorkspaceEngine((s) => s.globalNotesVersion);
  useEffect(() => {
    if (globalNotesVersion === 0) return;
    if (notesScopeRef.current !== "global") return;
    void loadNotes(cwd ?? "");
  }, [globalNotesVersion, cwd, loadNotes]);

  // ── No workspace state ────────────────────────────────────────────────────

  if (initDone && !cwd) {
    return (
      <div className="flex h-full flex-col bg-background">
        {!embedded && <TitleBar title="Workspace" />}
        <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <FolderOpenIcon />
          <div>
            <p className="text-sm font-medium text-foreground">No workspace open</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Open a folder to browse files, view git changes, and run a shell.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleOpenWorkspace()}
            className="mt-2 h-8 rounded-md border border-(--surface-divider) px-4 text-[12.5px] transition-colors duration-(--motion-fast) hover:bg-secondary"
          >
            Open workspace...
          </button>
        </main>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────────────

  // Workspace folder display name
  const cwdName = cwd ? normPath(cwd).split("/").filter(Boolean).at(-1) ?? cwd : "Workspace";

  return (
    <div className="flex h-full flex-col bg-background">
      {!embedded && <TitleBar title={`Workspace — ${cwdName}`} />}

      {/* ── Tab strip + toolbar ── */}
      <div
        className={
          "relative z-20 flex h-8 shrink-0 items-center border-b border-(--surface-divider) px-2 " +
          (embedded ? "bg-background" : "bg-card")
        }
      >
        {/* mode tabs */}
        <div className={
          "flex min-w-0 flex-1 items-center gap-1 " +
          (embedded
            ? "overflow-visible"
            : "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden")
        }>
        {embedded ? (
          <>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Open Workspace apps">
              {openWorkspaceTabs.map((tab) => {
                const active = tab === activeTab;
                return (
                  <div
                    key={tab}
                    className={
                      "flex h-6 min-w-0 shrink-0 items-center rounded-md text-[12px] transition-colors " +
                      (active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                    }
                  >
                    <button
                      type="button"
                      className="flex h-6 min-w-0 max-w-40 items-center gap-1.5 pl-2"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveTab(tab)}
                    >
                      <WorkspaceTabIcon tab={tab} />
                      <span className="truncate">{workspaceTabLabels[tab]}</span>
                      {tab === "git" && changes.length > 0 && (
                        <span className="rounded-full bg-background/50 px-1 text-[10px] text-muted-foreground">
                          {changes.length}
                        </span>
                      )}
                      {tab === "notes" && notes.length > 0 && (
                        <span className="rounded-full bg-background/50 px-1 text-[10px] text-muted-foreground">
                          {notes.length}
                        </span>
                      )}
                    </button>
                    <IconButton
                      title={tab === "context" ? t("context.close") : `Close ${workspaceTabLabels[tab]}`}
                      onClick={() => closeWorkspaceTab(tab)}
                    >
                      <CloseIcon />
                    </IconButton>
                  </div>
                );
              })}
            </div>
            <div ref={appMenuRef} className="relative shrink-0">
              <IconButton
                title="Open Workspace app"
                onClick={() => {
                  setActionsMenuOpen(false);
                  setAppMenuOpen((open) => !open);
                }}
                active={appMenuOpen}
                buttonRef={appMenuTriggerRef}
              >
                <PlusIcon />
              </IconButton>
              {appMenuOpen && (
                <div
                  role="menu"
                  aria-label="Open Workspace app"
                  className="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-lg border border-(--surface-divider) bg-popover p-1 text-popover-foreground shadow-lg"
                >
                  {WORKSPACE_TABS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        openWorkspaceTab(tab);
                        setAppMenuOpen(false);
                      }}
                      className={
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-secondary " +
                        (tab === activeTab ? "bg-secondary text-foreground" : "text-muted-foreground")
                      }
                    >
                      <WorkspaceTabIcon tab={tab} />
                      <span>{workspaceTabLabels[tab]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
        <button
          type="button"
          title="Git changes"
          aria-label="Git changes"
          onClick={() => setActiveTab("git")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "git"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <GitBranchIcon />
          <span>Git</span>
          {changes.length > 0 && (
            <span className="rounded-full bg-secondary px-1 text-[10px] text-muted-foreground">
              {changes.length}
            </span>
          )}
        </button>

        <button
          type="button"
          title="Files"
          aria-label="Files"
          onClick={() => setActiveTab("files")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "files"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <FolderIcon />
          <span>Files</span>
        </button>

        <button
          type="button"
          title="Notes"
          aria-label="Notes"
          onClick={() => setActiveTab("notes")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "notes"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <NotesIcon />
          <span>Notes</span>
          {notes.length > 0 && (
            <span className="rounded-full bg-secondary px-1 text-[10px] text-muted-foreground">
              {notes.length}
            </span>
          )}
        </button>

        <button
          type="button"
          title="Terminal"
          aria-label="Terminal"
          onClick={() => setActiveTab("terminal")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "terminal"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <TerminalTabIcon />
          <span>Terminal</span>
        </button>

        <button
          type="button"
          title="Background tasks"
          aria-label="Background tasks"
          onClick={() => setActiveTab("tasks")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "tasks"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <TasksTabIcon />
          <span>Tasks</span>
        </button>

        <button
          type="button"
          title="Conversation"
          aria-label="Conversation"
          onClick={() => setActiveTab("conversation")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "conversation"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <ConversationTabIcon />
          <span>Conversation</span>
        </button>

        <button
          type="button"
          title="Agent Team"
          aria-label="Agent Team"
          onClick={() => setActiveTab("agentTeam")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "agentTeam"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <AgentTeamTabIcon />
          <span>Agent Team</span>
        </button>

        <button
          type="button"
          title="Team DAG"
          aria-label="Team DAG"
          onClick={() => setActiveTab("dag")}
          className={
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " +
            (activeTab === "dag"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <DagTabIcon />
          <span>DAG</span>
        </button>
        <button
          type="button"
          aria-label={t("context.title")}
          title={t("context.open")}
          onClick={() => openWorkspaceTab("context")}
          className={"flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-(--motion-fast) " + (activeTab === "context" ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}
        >
          <ContextIcon />
          <span>{t("context.title")}</span>
        </button>
          </>
        )}
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-(--surface-divider) pl-1">
          {/* status */}
          {statusMsg && (
            <span className="max-w-24 truncate text-[11px] text-muted-foreground/70">{statusMsg}</span>
          )}

          {/* Secondary workspace actions stay available without crowding the tab strip. */}
          <div ref={actionsMenuRef} className="relative">
            <button
              ref={actionsMenuTriggerRef}
              type="button"
              title="More Workspace actions"
              aria-label="More Workspace actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
              onClick={() => {
                setAppMenuOpen(false);
                setActionsMenuOpen((open) => !open);
              }}
              className={
                "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-fast) " +
                (actionsMenuOpen
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
              }
            >
              <MoreIcon />
            </button>
            {actionsMenuOpen && (
              <div
                role="menu"
                aria-label="Workspace actions"
                className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-lg border border-(--surface-divider) bg-popover p-1 text-popover-foreground shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!cwd}
                  onClick={() => {
                    setActionsMenuOpen(false);
                    if (cwd) void refreshPanels(cwd);
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
                >
                  <RefreshIcon />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!cwd}
                  onClick={() => {
                    setActionsMenuOpen(false);
                    handleReveal();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
                >
                  <RevealIcon />
                  <span>Reveal in folder</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!cwd}
                  onClick={() => {
                    setActionsMenuOpen(false);
                    handleOpenShell();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
                >
                  <TerminalIcon />
                  <span>Open shell here</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!cwd}
                  onClick={() => {
                    setActionsMenuOpen(false);
                    if (embedded) handleOpenDetached();
                    else handleOpenInMain();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
                >
                  <OpenMainIcon />
                  <span>{embedded ? "Open in separate window" : "Open in main window"}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {embedded && activeTab === null && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-5">
            <div className="m-auto w-full max-w-xl py-3">
              <div className="mb-5">
                <h1 className="text-sm font-medium text-foreground">Workspace</h1>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={cwd ?? undefined}>
                  Tools for {cwdName}
                </p>
              </div>
              <nav className="grid grid-cols-1 gap-2 min-[300px]:grid-cols-2 min-[560px]:grid-cols-3" aria-label="Workspace apps">
                {WORKSPACE_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    aria-label={workspaceTabLabels[tab]}
                    aria-describedby={`workspace-launcher-${tab}-description`}
                    onClick={() => openWorkspaceTab(tab)}
                    className="flex min-h-24 min-w-0 flex-col items-start gap-2 rounded-xl border border-(--surface-divider) p-3 text-left hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <span className="text-muted-foreground"><WorkspaceTabIcon tab={tab} /></span>
                    <span className="text-[12px] font-medium leading-4 text-foreground">{workspaceTabLabels[tab]}</span>
                    <span id={`workspace-launcher-${tab}-description`} className="text-[11px] leading-4 text-muted-foreground">
                      {workspaceTabDescriptions[tab]}
                    </span>
                  </button>
                ))}
              </nav>
            </div>
          </div>
        )}

        {/* ── GIT TAB ── */}
        {activeTab === "git" && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* context bar */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* git sub-toolbar */}
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
                <IconButton
                  title={gitSidebarCollapsed ? "Show changes list" : "Hide changes list"}
                  onClick={toggleGitSidebar}
                  active={gitSidebarCollapsed}
                >
                  <SidebarIcon />
                </IconButton>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
                  Review{" "}
                  {changesLoading ? (
                    <span className="text-muted-foreground">…</span>
                  ) : (
                    <span className="text-muted-foreground">{changes.length}</span>
                  )}
                </span>
                <DiffModeToggle mode={diffMode} onChange={setDiffMode} />
                <IconButton
                  title="Refresh changes"
                  onClick={() => cwd ? void loadChanges(cwd) : undefined}
                  disabled={!cwd}
                >
                  <RefreshIcon />
                </IconButton>
              </div>

              {/* git body: sidebar + diff pane */}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* changes sidebar */}
                {!gitSidebarCollapsed && (
                  <>
                    <div
                      style={{ width: gitSidebar.width }}
                      className="shrink-0 overflow-hidden bg-card"
                    >
                      <GitChanges
                        changes={changes}
                        selectedPath={selectedChange}
                        onSelect={(path) => void handleChangeSelect(path)}
                      />
                    </div>
                    <ResizeHandle onPointerDown={gitSidebar.startResize} active={gitSidebar.resizing} ariaLabel="Resize changes list" />
                  </>
                )}

                {/* diff pane */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                  <DiffView diff={diff} mode={diffMode} loading={diffLoading} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── FILES TAB ── */}
        {activeTab === "files" && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* files sub-toolbar */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
                <IconButton
                  title={filesSidebar.collapsed ? "Show file tree" : "Hide file tree"}
                  onClick={filesSidebar.toggleCollapsed}
                  active={filesSidebar.collapsed}
                >
                  <SidebarIcon />
                </IconButton>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
                  {activeFile
                    ? normPath(activeFile.path).split("/").slice(-2).join("/")
                    : cwdName}
                </span>
                <IconButton
                  title="Refresh files"
                  onClick={() => cwd ? void loadFiles(cwd) : undefined}
                  disabled={!cwd}
                >
                  <RefreshIcon />
                </IconButton>
              </div>

              {/* files body: tree + viewer */}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* explorer sidebar */}
                {!filesSidebar.collapsed && (
                  <>
                    <div
                      style={{ width: filesSidebar.width }}
                      className="shrink-0 overflow-hidden bg-card"
                    >
                      <div className="h-full overflow-auto">
                        <FileTree
                          files={files}
                          activeFilePath={activeFile?.path ?? null}
                          expandedDirs={expandedDirs}
                          loadingDirs={loadingDirs}
                          onFileClick={(path) => void handleFileClick(path)}
                          onDirToggle={(path) => void handleDirToggle(path)}
                        />
                      </div>
                    </div>
                    <ResizeHandle onPointerDown={filesSidebar.startResize} active={filesSidebar.resizing} ariaLabel="Resize file tree" />
                  </>
                )}

                {/* file viewer */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                  {/* open-file tab strip */}
                  {openTabs.length > 0 && (
                    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-(--surface-divider) bg-card/60 px-1">
                      {openTabs.map((path) => {
                        const name = normPath(path).split("/").pop() || path;
                        const active = activeFile?.path === path;
                        return (
                          <div
                            key={path}
                            className={
                              "group flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] " +
                              (active
                                ? "bg-secondary text-foreground"
                                : "text-muted-foreground hover:bg-secondary/50")
                            }
                          >
                            <button
                              type="button"
                              className="max-w-[12rem] truncate"
                              title={path}
                              onClick={() => void handleFileClick(path)}
                            >
                              {name}
                            </button>
                            <button
                              type="button"
                              className="rounded p-0.5 leading-none text-muted-foreground/60 opacity-0 transition-opacity duration-(--motion-fast) hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                              title="Close"
                              aria-label={`Close ${name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCloseTab(path);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fileLoading ? (
                    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                      Loading…
                    </div>
                  ) : activeFile ? (
                    <FileViewer
                      file={activeFile}
                      cwd={cwd ?? undefined}
                      onSaved={handleFileSaved}
                    />
                  ) : (
                    <FileViewerEmpty />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── NOTES TAB ── */}
        {activeTab === "notes" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* notes sub-toolbar */}
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--surface-divider) bg-card/60 px-2">
              <IconButton
                title={notesSidebar.collapsed ? "Show notes list" : "Hide notes list"}
                onClick={notesSidebar.toggleCollapsed}
                active={notesSidebar.collapsed}
              >
                <SidebarIcon />
              </IconButton>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-foreground/80">
                Shared notebook{" "}
                {notesLoading ? (
                  <span className="text-muted-foreground">…</span>
                ) : (
                  <span className="text-muted-foreground">{notes.length}</span>
                )}
              </span>
              <IconButton
                title={notesScope === "global" ? "Open global notes folder" : "Open workspace notes folder"}
                onClick={() => {
                  setNotesFolderOpening(true);
                  void bridge().openNotesFolder(cwd ?? undefined, notesScope)
                    .catch((error: unknown) => window.alert(`Could not open notes folder: ${error instanceof Error ? error.message : String(error)}`))
                    .finally(() => setNotesFolderOpening(false));
                }}
                disabled={notesFolderOpening || (!cwd && notesScope !== "global")}
              >
                <FolderIcon />
              </IconButton>
              <IconButton
                title="Open in Obsidian (first time: open the notes folder as a vault in Obsidian once)"
                onClick={() => {
                  void (async () => {
                    // Scope-aware: the Global tab's vault is <REINA_HOME>/notes,
                    // not the workspace's .reina/notes — only main knows the path.
                    const notesDir = await bridge()
                      .getNotesDir(cwd ?? undefined, notesScope)
                      .catch(() => null);
                    if (!notesDir) return;
                    // ponytail: Obsidian has no URL to register a vault, so first
                    // click per notebook guides the one-time manual setup instead.
                    // (Workspace keys stay `:${cwd}` so existing hints survive.)
                    const hintKey = notesScope === "global" ? "obsidian-vault-hint:global" : `obsidian-vault-hint:${cwd}`;
                    if (!localStorage.getItem(hintKey)) {
                      localStorage.setItem(hintKey, "1");
                      if (
                        window.confirm(
                          "首次使用:Obsidian 需要先把这个笔记文件夹添加为 vault(仅一次)。\n\n点「确定」打开该文件夹 → 在 Obsidian 里选「打开其他仓库 / Open folder as vault」并选中它。之后此按钮即可直接打开。\n\n(已经添加过?点「取消」直接打开 Obsidian)",
                        )
                      ) {
                        void bridge().openPath(notesDir);
                        return;
                      }
                    }
                    bridge().openLink(`obsidian://open?path=${encodeURIComponent(notesDir)}`);
                  })();
                }}
                disabled={!cwd && notesScope !== "global"}
              >
                <ObsidianIcon />
              </IconButton>
              <IconButton
                title="Refresh notes"
                onClick={() => void loadNotes(cwd ?? "")}
                disabled={!cwd && notesScope !== "global"}
              >
                <RefreshIcon />
              </IconButton>
            </div>

            {/* notes body: sidebar + detail */}
            <NotesTab notes={notes} loading={notesLoading} readNote={readNoteBody} sidebar={notesSidebar} scope={notesScope} onScopeChange={setNotesScope} />
          </div>
        )}

        {/* ── TERMINAL TAB ── */}
        {activeTab === "terminal" && (
          <TerminalTab key={cwd ?? "no-workspace"} cwd={cwd} active={activeTab === "terminal"} />
        )}

        {/* ── BACKGROUND TASKS TAB ── */}
        {activeTab === "tasks" && (
          <BackgroundTasksTab key={cwd ?? "no-workspace"} cwd={cwd} active={activeTab === "tasks"} />
        )}

        {/* ── SIDE CHAT TAB ── */}
        {activeTab === "sideChat" && (
          <SideChatTab
            sessionId={workspaceSessionId}
            quoteRequest={sideChatQuoteRequest}
            resetRequest={sideChatResetRequest}
          />
        )}

        {/* ── TEAM MESSAGES TAB ── */}
        {activeTab === "conversation" && (
          <ConversationTab cwd={cwd} active={activeTab === "conversation"} />
        )}

        {/* ── AGENT TEAM TAB ── */}
        {activeTab === "agentTeam" && (
          <AgentTeamTab cwd={cwd} active={activeTab === "agentTeam"} onOpenContext={openContext} />
        )}

        {activeTab === "context" && (
          <ContextTab
            cwd={cwd}
            sessionId={workspaceSessionId}
            active={activeTab === "context"}
            initialTaskId={contextSelection.taskId}
            selectionKey={contextSelection.seq}
          />
        )}

        {/* ── TEAM DAG TAB ── */}
        {activeTab === "dag" && (
          <DagTab cwd={cwd} active={activeTab === "dag"} />
        )}
      </div>
    </div>
  );
}
