// Main chat window store (external store via useSyncExternalStore). Holds
// desktop state + session list, the active session + its committed transcript
// (host-projected TimelineParts), a streaming overlay for the in-flight turn,
// and the .app layout flags the legacy CSS keys off.
//
// Rendering strategy mirrors the proven approach: committed transcript =
// projectTimelineParts(activeSession); the overlay carries only in-flight
// assistant text/reasoning deltas, cleared on session_snapshot/turn_completed.

import { useSyncExternalStore } from "react";
import { bridge } from "~/lib/bridge";
import { isSidebarWindow } from "~/lib/windowKind";
import { getAgentSettingsState, loadAgentSettings, reflectSessionAgentMode, reflectSessionModel, reflectSessionModes } from "./agentSettings";
import { setTaskSession } from "./taskStore";
import { projectTimelineParts } from "./timelineProjection";
import type {
  AgentEvent,
  DesktopState,
  MessageAttachment,
  PendingQuestionItem,
  PermissionToolCall,
  SendMessagePayload,
  SessionListItem,
  SessionSnapshot,
  TimelinePart,
  TimelineTextPart,
  TimelineToolDetail,
  TimelineToolPart,
  ToolCallStatus,
} from "./protocol";

export type TurnStatus =
  | "idle"
  | "working"
  | "stopping"
  | "waiting approval"
  | "waiting answer"
  | "compacting"
  | "error";

export interface StreamOverlay {
  assistantText: string;
  reasoning: string;
}

// Live subagent activity for one async task (mirror legacy renderSubagentActivity):
// rolling text/reasoning tails + one row per child tool call + misc notices.
export interface SubagentActivity {
  text: string;
  reasoning: string;
  tools: { key: string; name: string; target: string; status: string }[];
  misc: string[];
  count: number;
}

// Slim mirror of the engine's AsyncTaskRecord — enough for the transcript's
// subagent chips to (a) attach live activity by taskId (the tool events only
// carry the tool-call id + input; matching goes through `description`, which
// dispatch dedup keeps unique among live tasks) and (b) show an async child's
// TRUE status after its dispatch tool part settled ("completed" instantly
// while the child still works). Fed by `async-task-updated` stream pings and
// re-hydrated from session snapshots; NOT cleared on turn boundaries — async
// children outlive the turn that spawned them.
export interface AsyncTaskLite {
  id: string;
  description: string;
  agent?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  sync?: boolean;
}

export interface LayoutFlags {
  // Mirror the legacy `.app` classes. Session pane is shown-by-default
  // (`session-collapsed` hides it); the task pane is open-on-demand
  // (`task-open` shows it — default hidden, matching legacy task-pane.css).
  sessionCollapsed: boolean;
  taskOpen: boolean;
  workspaceCollapsed: boolean;
}

export interface MainState {
  ready: boolean;
  desktop: DesktopState | null;
  workspaceCwd: string | null;
  sessionId: string | null;
  activeSession: SessionSnapshot | null;
  parts: TimelinePart[];
  overlay: StreamOverlay;
  status: TurnStatus;
  working: boolean;
  stopping: boolean;
  // Wall-clock anchor for the thinking spinner's elapsed counter. Re-anchored at
  // the START OF EACH TURN (the host's `turn_started`), matching Claude Code's
  // per-query reset (REPL.tsx resetTimingRefs on isQueryActive false→true) — so
  // the counter reflects the CURRENT model response, not the whole session.
  // turn_started fires once per runTurn: fresh sends, queued auto-continuations,
  // and autopilot continuations each re-anchor; steers and auto-compaction run
  // INSIDE a runTurn (no turn_started) so they preserve the anchor — no
  // "压缩后重置". null = no turn started yet (fall back to render time).
  turnStartedAt: number | null;
  // Wall-clock moment the clock was paused on a HITL prompt (permission/question),
  // or null when running. While a prompt is open the spinner is hidden, but the
  // user's deliberation time must NOT count toward the response timer — so on
  // resume we bank (now − turnPauseStartedAt) by shifting turnStartedAt forward
  // (mirrors Claude Code's totalPausedMs, REPL.tsx:2485-2491).
  turnPauseStartedAt: number | null;
  // In-flight tool cards streamed live from the engine's `tool-progress`
  // events (the host only sends a committed session_snapshot at turn END, so
  // without this tool cards wouldn't appear until the turn finishes / is
  // stopped). Keyed by tool-call id, appended in fire order. Cleared whenever a
  // committed snapshot arrives (turn_started / session_snapshot / turn_completed)
  // because the snapshot's projected parts then own those cards. Mirrors the
  // legacy renderer's renderToolProgress live-card path.
  liveTools: TimelineToolPart[];
  // Intermediate assistant text rounds streamed earlier in the SAME in-flight
  // turn, flushed out of `overlay` the moment a tool-progress arrives (a tool
  // call ends the round). Without this the renderer would pile every round's
  // text into one `overlay` block ABOVE all `liveTools`, inverting the real
  // order (final summary above the tools that produced it). Mirrors legacy
  // agent-events.js, where a text-delta after a tool card opens a fresh
  // assistant entry below it. Merged with `liveTools` by createdAt at render
  // time; cleared on every committed-snapshot / turn boundary like liveTools.
  liveText: TimelineTextPart[];
  // HITL dock — multiple permission prompts + questions can queue at once
  // (mirrors legacy state.pendingPermissions / pendingQuestions Maps). Stored
  // as arrays here (immutable replace) and converted to Maps when rendering.
  pendingPermissions: PermissionToolCall[];
  pendingQuestions: PendingQuestionItem[];
  hitlCollapsed: boolean;
  error: string | null;
  layout: LayoutFlags;
  // Composer draft-injection channel. Edit / undo-to-branch / rollback push the
  // user's message text back into the composer input. `seq` is bumped on every
  // request so the Composer effect re-fires even when the text is unchanged
  // (mirrors legacy actions.restoreDraft). null = nothing pending.
  draftRequest: { text: string; seq: number; mode?: "replace" | "prepend" } | null;
  // Client-side message queue (mirrors legacy state.queuedPrompts). Drafts typed
  // while a turn is running buffer here; manual-only flush via "Send now" (legacy
  // never auto-sends — drainQueuedPrompt/tryAutoFlushQueue only refresh chrome).
  queuedMessages: string[];
  // Skills staged via the /skill picker (mirror legacy state.pendingSkills):
  // rendered as inline composer tags, prepended as "Use the `x` skill."
  // directives on send, then cleared.
  pendingSkills: { name: string; description?: string }[];
  // Ephemeral client-side system notices (mirror legacy appendEntry("system", …)):
  // slash-command confirmations like "Agent → X" / "Unknown model: Y". NOT part of
  // the host transcript; rendered after committed parts, cleared on session switch.
  systemNotices: { id: string; text: string }[];
  // Compaction LIVE divider (mirror legacy appendCompactDivider). null = none.
  // phase:"running" pulses at the tail while the summary call runs; "settled"
  // is only used for ephemeral outcomes with no durable anchor ("Nothing to
  // compact", failures) and clears on the next turn. A SUCCESSFUL compaction
  // resolves into an anchoredNotice instead, pinned where it happened.
  compaction: { phase: "running" | "settled"; label: string } | null;
  // Timestamp-anchored transcript notices: settled compaction boundaries +
  // self-evolve "💾" memory lines. Unlike systemNotices (end-pinned chips) each
  // carries the ISO moment it happened, so the Timeline interleaves it into the
  // transcript at that point instead of pinning it after the last turn. Rebuilt
  // wholesale from the session's durable state (compactBoundaries /
  // selfEvolveLog) on load, snapshot, and history mutation; live stream events
  // upsert between snapshots for immediacy.
  anchoredNotices: AnchoredNotice[];
  // Steered user messages materialized from `user-message` stream events before
  // the host's next snapshot commits them (mirror legacy appendEntry on steer).
  // Cleared when a snapshot / turn_completed commits them to `parts`.
  // `attachments` carries the freshly-sent images so the optimistic bubble shows
  // the thumbnail immediately, instead of only after the end-of-turn snapshot
  // commits the real user message (the "图片输出完后才展示" regression).
  steerBubbles: { id: string; text: string; attachments?: MessageAttachment[] }[];
  // Steers submitted into the running turn but not yet drained by the engine
  // (codex's `pending_steers`, distinct from the not-yet-submitted `queuedMessages`
  // = codex's `queued_user_messages`). Shown in the queue panel as "waiting" until
  // the `user-message` boundary lands them inline; cleared when the turn settles.
  // `id` is renderer-generated, travels with the send_message request, and comes
  // back on the drain event — the row's identity across retract/drain, so two
  // same-text steers never cross-match.
  pendingSteers: PendingSteer[];
  // Per-session sidebar badges (mirror legacy refreshSessionBadges). `attention` =
  // a background session finished / needs input; `running` = a turn is active.
  // Keyed by session id; the visible session's running tracks `working` directly.
  sessionBadges: Record<string, { attention?: boolean; running?: boolean }>;
  // Live subagent activity keyed by async-task id (mirror legacy
  // renderSubagentActivity). Cleared on turn_completed / session switch.
  subagentActivity: Record<string, SubagentActivity>;
  // Subagent task roster keyed by task id (see AsyncTaskLite). Survives turn
  // boundaries; reset on session switch and re-hydrated from the snapshot.
  asyncTaskIndex: Record<string, AsyncTaskLite>;
}

/** One submitted-but-not-yet-drained steer in the queue panel. */
export type PendingSteer = { id: string; text: string };

/** One timestamp-anchored transcript notice (see MainState.anchoredNotices). */
export type AnchoredNotice = { id: string; at: string; kind: "compaction" | "memory"; text: string };

const EMPTY_OVERLAY: StreamOverlay = { assistantText: "", reasoning: "" };

let state: MainState = {
  ready: false,
  desktop: null,
  workspaceCwd: null,
  sessionId: null,
  activeSession: null,
  parts: [],
  overlay: EMPTY_OVERLAY,
  status: "idle",
  working: false,
  stopping: false,
  turnStartedAt: null,
  turnPauseStartedAt: null,
  liveTools: [],
  liveText: [],
  pendingPermissions: [],
  pendingQuestions: [],
  hitlCollapsed: false,
  error: null,
  // The main chat window starts with its inline session pane COLLAPSED: by
  // default the session list lives in the floating sidebar window (legacy
  // placement "floating"), so the main window shows only the chat until the user
  // pops the sidebar out (mirror legacy loadViewSettings: main window forces
  // sessionPaneCollapsed=true). The sidebar window itself always shows the pane.
  layout: { sessionCollapsed: !isSidebarWindow, taskOpen: false, workspaceCollapsed: true },
  draftRequest: null,
  queuedMessages: [],
  pendingSkills: [],
  systemNotices: [],
  compaction: null,
  anchoredNotices: [],
  steerBubbles: [],
  pendingSteers: [],
  sessionBadges: {},
  subagentActivity: {},
  asyncTaskIndex: {},
};

// ── Async-task roster upserts (subagent chips) ───────────────────────────────

function upsertAsyncTaskLite(
  index: Record<string, AsyncTaskLite>,
  task: unknown,
): Record<string, AsyncTaskLite> {
  const t = task as Partial<AsyncTaskLite> | null;
  if (!t || typeof t.id !== "string" || !t.id) return index;
  return {
    ...index,
    [t.id]: {
      id: t.id,
      description: typeof t.description === "string" ? t.description : "",
      agent: typeof t.agent === "string" ? t.agent : undefined,
      status: typeof t.status === "string" ? t.status : "running",
      startedAt: typeof t.startedAt === "string" ? t.startedAt : undefined,
      completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
      error: typeof t.error === "string" ? t.error : undefined,
      sync: t.sync === true ? true : undefined,
    },
  };
}

// Merge a committed snapshot's asyncTasks into the roster. Snapshot records are
// authoritative for the tasks they carry, but the sweep DROPS settled tasks from
// session.asyncTasks after a grace period — so merge (keep known ids the
// snapshot no longer lists) instead of replacing.
function mergeAsyncIndexFromSession(
  session: SessionSnapshot | null | undefined,
  base: Record<string, AsyncTaskLite>,
): Record<string, AsyncTaskLite> {
  const tasks = (session as { asyncTasks?: unknown[] } | null | undefined)?.asyncTasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return base;
  let next = base;
  for (const task of tasks) next = upsertAsyncTaskLite(next, task);
  return next;
}

const listeners = new Set<() => void>();
let desktopRefreshSequence = 0;

function set(patch: Partial<MainState>): void {
  const prevSessionId = state.sessionId;
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
  // Foreground session changed → re-bind the task pane (Goal/Progress) to it.
  // This is the single chokepoint every switch/create/draft path flows through
  // (loadSession, ensureSession, newDraftSession, session_created adoption), so
  // the Goal card always tracks the visible session and a background goal loop
  // can't bleed into it.
  if ("sessionId" in patch && patch.sessionId !== prevSessionId) {
    setTaskSession(state.sessionId, state.activeSession as unknown as Record<string, unknown> | null);
  }
}

// TEMP-VERIFY: CDP-driven UI seam for visual verification. Remove before commit.
if (typeof window !== "undefined") {
  (window as unknown as { __verify?: unknown }).__verify = { set, state: () => state };
}

export function getMainState(): MainState {
  return state;
}

// HITL pause bookkeeping for the turn clock, shared by the foreground state
// and the background session cache (both carry {turnStartedAt, turnPauseStartedAt}).
// Every prompt surface (permission, question, subagent question) must stamp the
// pause the same way, or the spinner silently counts the user's deliberation.

// Stamp the start of a HITL pause. Idempotent: only the first prompt of an
// open turn starts the pause; a second prompt keeps the original stamp.
function pauseStamp(startedAt: number | null, pausedAt: number | null): number | null {
  return startedAt !== null && pausedAt === null ? Date.now() : pausedAt;
}

// Bank a finished pause: the elapsed anchor shifted forward by (now − pause
// start), so the counter excludes the deliberation span. Null when not paused.
function bankPausedSpan(startedAt: number | null, pausedAt: number | null): number | null {
  if (startedAt === null || pausedAt === null) return null;
  return startedAt + (Date.now() - pausedAt);
}

// Bank the time the foreground turn spent paused on a HITL prompt, then clear
// the pause. Returns a `set()` patch (empty when not paused) so resume sites
// can spread it unconditionally. Mirrors Claude Code's totalPausedMs
// accumulation (REPL.tsx:2488-2491).
function resumeTurnClockPatch(): Partial<MainState> {
  const banked = bankPausedSpan(state.turnStartedAt, state.turnPauseStartedAt);
  if (banked === null) return {};
  return { turnStartedAt: banked, turnPauseStartedAt: null };
}

/** Imperative subscription for subsystems that drive DOM directly (e.g. the
 * HITL dock, which reuses the legacy renderer and must not re-render via React).
 * Returns an unsubscribe fn. */
export function subscribeMainStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useMainStore<T>(selector: (s: MainState) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => selector(state),
  );
}

export function setLayout(patch: Partial<LayoutFlags>): void {
  set({ layout: { ...state.layout, ...patch } });
}

const api = () => bridge();

async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  return (await api().invoke(command, args)) as T;
}

// Project the committed transcript locally instead of round-tripping the whole
// session to the main process (reina:project-timeline-parts) and back. The
// projection is pure data shaping (see timelineProjection.ts), so running it in
// the renderer on the snapshot load_session already returned removes a second
// full-session IPC hop on every switch — the dominant cost when sessions are
// large. Stays async so its callers (which `await`) are untouched.
async function projectParts(session: SessionSnapshot | null): Promise<TimelinePart[]> {
  if (!session) return [];
  try {
    return projectTimelineParts(session);
  } catch {
    return [];
  }
}

// Derive the pending HITL state from a session snapshot — mirrors legacy
// actions/hitl.js syncHitlFromSession: tool calls awaiting approval and
// questions still pending. The source of truth on (re)load and snapshots.
function hitlFromSession(session: SessionSnapshot | null): {
  pendingPermissions: PermissionToolCall[];
  pendingQuestions: PendingQuestionItem[];
} {
  if (!session) return { pendingPermissions: [], pendingQuestions: [] };
  const toolCalls = Array.isArray(session.toolCalls) ? (session.toolCalls as PermissionToolCall[]) : [];
  const rawQuestions = (session as Record<string, unknown>).pendingQuestions;
  const questions = Array.isArray(rawQuestions) ? (rawQuestions as PendingQuestionItem[]) : [];
  return {
    pendingPermissions: toolCalls.filter((t) => t && t.status === "pending_approval"),
    pendingQuestions: questions.filter((q) => q && q.status === "pending"),
  };
}

export async function initMainStore(): Promise<void> {
  api().events.on("agent", (payload) => {
    void handleAgentEvent(payload as AgentEvent);
  });
  await api().awaitInitialization().catch(() => undefined);
  const desktop = (await api().getDesktopState().catch(() => null)) as DesktopState | null;
  set({ desktop });
  const activeId = desktop?.activeSessionId;
  const active = desktop?.sessions?.find((s) => s.id === activeId);
  // The floating sidebar window is a session *picker*, not a chat surface: it
  // never loads a transcript. It only needs the session list + which row is
  // active (for the highlight), so we skip loadSession entirely and just mirror
  // the active id. Selecting a row delegates to openSessionInMain (SessionList),
  // and the active highlight tracks the main window via the active-session event
  // (subscribed in MainApp). Mirrors the legacy sidebar window, which forces
  // sessionPaneCollapsed=false and drives the main window over IPC.
  if (isSidebarWindow) {
    set({ sessionId: activeId ?? null, workspaceCwd: active?.cwd ?? (await defaultCwd()), ready: true });
    return;
  }
  if (active) await loadSession(active);
  else set({ workspaceCwd: await defaultCwd() });
  set({ ready: true });
  api().events.on("active-session", () => void refreshDesktopState());
}

/** Sidebar window only: update which session row is highlighted as active,
 * without loading its transcript (the sidebar has no chat surface). Driven by
 * the main window's `active-session` broadcast and by an optimistic set on
 * click. Mirrors the legacy sidebar's setActiveSession/markPendingSessionActive. */
export function setSidebarActiveSession(id: string | null): void {
  // The sidebar never renders a transcript, so it must hold no activeSession.
  // A stale one — set by a background `session_created` the sidebar also
  // processes — keeps isDraft (`!sessionId && !activeSession`) false and so
  // hides the "New session" draft row after "New Agent". Clear it in lockstep
  // with the highlight, and don't early-return while it's still dirty.
  if (state.sessionId === id && !state.activeSession) return;
  set({ sessionId: id, activeSession: null });
}

async function defaultCwd(): Promise<string | null> {
  try {
    return (await invoke<string>("default_cwd")) ?? null;
  } catch {
    return null;
  }
}

export async function refreshDesktopState(): Promise<void> {
  const sequence = ++desktopRefreshSequence;
  const desktop = (await api().getDesktopState().catch(() => null)) as DesktopState | null;
  if (desktop && sequence === desktopRefreshSequence) set({ desktop });
}

export async function loadSession(item: SessionListItem): Promise<void> {
  if (item.id === state.sessionId) return;
  // Park the outgoing session's volatile UI before switching away.
  captureCurrentSession();
  set({ status: "idle", error: null, overlay: EMPTY_OVERLAY });
  try {
    const data = await invoke<{ sessionId: string; session: SessionSnapshot }>("load_session", {
      cwd: item.cwd,
      savedSessionId: item.id,
    });
    void api().setActiveSession(data.sessionId).catch(() => undefined);
    const projected = await projectParts(data.session);
    const committed = new Set(
      projected.flatMap((p) => (p.type === "tool" ? (p as TimelineToolPart).callIds : [])),
    );
    set({
      sessionId: data.sessionId,
      activeSession: data.session,
      workspaceCwd: item.cwd,
      parts: projected,
      systemNotices: [],
      anchoredNotices: seedAnchoredNotices(data.session),
      compaction: null,
      steerBubbles: [],
      queuedMessages: [],
      pendingSteers: [],
      liveTools: [],
      liveText: [],
      subagentActivity: {},
      // Restore the in-flight overlay / working / pending HITL / live cards+rounds
      // streamed while this session was in the background (falls back to the
      // snapshot's HITL on a cold load). Overrides the defaults above +
      // hitlFromSession inside.
      ...restoreSessionPatch(data.sessionId, data.session, committed),
    });
    // Mirror the loaded session's actual bound model onto the composer's model
    // button (display-only). A resumed session keeps the model — incl. any
    // subscription/OAuth binding — from its rollout, so without this the button
    // keeps showing the new-session default and a subscription-bound session's
    // 401 looks like a config error. Must run after the set() above so it reads
    // the freshly loaded snapshot.
    reflectSessionModel((data.session as { model?: unknown }).model);
    // Same idea for the Goal/Team toggles: the composer "Modes" badge is global,
    // but session modes are session-scoped on the engine. Mirror THIS session's
    // real toggles so the badge can't keep lying that Team is on after we've
    // switched into a session whose engine never got it.
    reflectSessionModes((data.session as { sessionModes?: unknown }).sessionModes);
    // …and the agent + permission mode, so a session created/last-run as e.g.
    // `lead` / Bypass doesn't display the persisted new-session default (the
    // composer would otherwise show the wrong agent and a permission halo that
    // doesn't match the approvals the engine actually enforces).
    reflectSessionAgentMode(data.session);
    // The user is now looking at this session — clear its attention badge.
    clearBadge(data.sessionId);
  } catch (err) {
    set({ error: errMsg(err) });
  }
}

export async function newDraftSession(cwd?: string): Promise<void> {
  // Park the outgoing session's volatile UI — it keeps running in the background.
  captureCurrentSession();
  const targetCwd = cwd ?? state.workspaceCwd ?? (await defaultCwd());
  set({
    sessionId: null,
    activeSession: null,
    parts: [],
    overlay: EMPTY_OVERLAY,
    workspaceCwd: targetCwd,
    status: "idle",
    // A fresh draft must NOT inherit the outgoing session's live turn. The
    // previous session keeps running in the background (captured above), but the
    // draft is empty — without resetting these it shows the old turn's
    // "Simmering… 9s" timer and a running halo for a turn that isn't its own.
    working: false,
    stopping: false,
    turnStartedAt: null,
    turnPauseStartedAt: null,
    error: null,
    pendingPermissions: [],
    pendingQuestions: [],
    systemNotices: [],
    compaction: null,
    anchoredNotices: [],
    steerBubbles: [],
    queuedMessages: [],
    pendingSteers: [],
    liveTools: [],
    liveText: [],
    subagentActivity: {},
    asyncTaskIndex: {},
  });
  // Broadcast the draft as the active session so the floating sidebar window
  // drops its row highlight onto the "New session" draft. Without this the
  // sidebar keeps highlighting the previous session even though the main chat
  // is now a fresh draft (the two windows desync). Mirrors loadSession's
  // setActiveSession call; the main process relays it to the sidebar only.
  void api()
    .setActiveSession({ sessionId: null, draft: true, cwd: targetCwd ?? undefined })
    .catch(() => undefined);
}

/** Reset to the "no workspace open" state so the Welcome overlay shows. Unlike
 * newDraftSession (which keeps workspaceCwd so a draft can run), this nulls
 * workspaceCwd — Welcome is gated on `Boolean(workspaceCwd)`. Used by
 * close-workspace, mirroring the legacy renderer's showWelcome(). */
export function clearWorkspaceToWelcome(): void {
  set({
    sessionId: null,
    activeSession: null,
    parts: [],
    overlay: EMPTY_OVERLAY,
    workspaceCwd: null,
    status: "idle",
    error: null,
    pendingPermissions: [],
    pendingQuestions: [],
    systemNotices: [],
    compaction: null,
    anchoredNotices: [],
    steerBubbles: [],
    subagentActivity: {},
    asyncTaskIndex: {},
  });
}

async function ensureSession(): Promise<string | null> {
  if (state.sessionId) return state.sessionId;
  const cwd = state.workspaceCwd ?? (await defaultCwd());
  if (!cwd) {
    set({ error: "No workspace selected" });
    return null;
  }
  try {
    // Carry the composer's selected model / agent / permission-mode / effort /
    // output-style into the new session. Without this, create_session runs on
    // the host's default (deterministic) model, so the picker's choice (e.g.
    // kimi-for-coding) is ignored and a plain "你好" hits the deterministic
    // fallback. Mirrors the legacy createEngineSession payload; effort rides on
    // the model config exactly as the live update (setModel/setEffort) sends it.
    //
    // Guard the startup race: agentSettings.model starts as the `deterministic`
    // placeholder and only flips to the real model once loadAgentSettings()'s
    // async fetch lands (it's fire-and-forget on composer mount). A first send
    // that beats that load would bind the session to deterministic on the host —
    // and the picker's later-resolved model is display-only, so it never rebinds
    // an already-created session (the "切换模型没第一时间变" symptom). If we're
    // still on the placeholder, force the settings to resolve before creating so
    // the FIRST turn binds to a real model. No-op cost once already loaded.
    let settings = getAgentSettingsState().agentSettings;
    if (settings.model.provider === "deterministic") {
      await loadAgentSettings().catch(() => undefined);
      settings = getAgentSettingsState().agentSettings;
    }
    const createPayload: Record<string, unknown> = {
      cwd,
      agent: settings.agent,
      permissionMode: settings.permissionMode,
      model: { ...settings.model, reasoningEffort: settings.effort },
      outputStyle: settings.outputStyle,
    };
    if (settings.outputStyleCustom) createPayload.outputStyleCustom = settings.outputStyleCustom;
    const data = await invoke<{ sessionId: string; session: SessionSnapshot }>("create_session", createPayload);
    void api().setActiveSession(data.sessionId).catch(() => undefined);
    // The host can emit the provisional title as soon as send_message is
    // accepted. Register the row first so main can apply that targeted event.
    await api().recordSession(data.session as unknown as Record<string, unknown>).catch(() => undefined);
    set({ sessionId: data.sessionId, activeSession: data.session, workspaceCwd: cwd, parts: await projectParts(data.session), ...hitlFromSession(data.session) });
    // A draft has no live session, so a Team toggle flipped on the "New
    // session" screen can't be pushed at toggle time (applyLiveSessionUpdate
    // no-ops without a sessionId) and create_session starts every mode OFF.
    // Apply the composer's currently-ON modes to the just-created session BEFORE
    // the first turn runs, so a task typed right after toggling Team actually
    // coordinates instead of silently running plain `default`.
    const pendingModes = getAgentSettingsState().sessionModes ?? {};
    const onModes = Object.fromEntries(Object.entries(pendingModes).filter(([, on]) => on === true));
    if (Object.keys(onModes).length > 0) {
      await invoke("update_session_config", { sessionId: data.sessionId, sessionModes: onModes }).catch(
        () => undefined,
      );
    }
    void refreshDesktopState();
    return data.sessionId;
  } catch (err) {
    set({ error: errMsg(err) });
    return null;
  }
}

/** Create/replace a Goal through the host-owned state machine before the
 * model's first request. Unlike sendMessage, this never relies on a reminder
 * or asks the model to register state. */
export async function startGoal(objective: string, replace = false): Promise<void> {
  const clean = objective.trim();
  if (!clean) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  const previous = {
    working: state.working,
    status: state.status,
    turnStartedAt: state.turnStartedAt,
    turnPauseStartedAt: state.turnPauseStartedAt,
    overlay: state.overlay,
  };
  const wasWorking = previous.working;
  const bubble = !wasWorking ? { id: `sent-${++steerSeq}`, text: `/goal ${clean}` } : null;
  set({
    working: true,
    status: "working",
    error: null,
    ...(!wasWorking ? { turnStartedAt: Date.now(), turnPauseStartedAt: null, overlay: EMPTY_OVERLAY } : {}),
    ...(bubble ? { steerBubbles: [...state.steerBubbles, bubble] } : {}),
  });
  try {
    const result = await invoke<{ changed?: boolean }>("goal_command", {
      sessionId,
      command: { type: replace ? "replace" : "create", objective: clean },
    });
    if (result.changed === false) {
      set({
        ...previous,
        steerBubbles: bubble ? state.steerBubbles.filter((entry) => entry.id !== bubble.id) : state.steerBubbles,
      });
    }
  } catch (err) {
    set({
      ...previous,
      error: errMsg(err),
      status: wasWorking ? previous.status : "error",
      steerBubbles: bubble ? state.steerBubbles.filter((entry) => entry.id !== bubble.id) : state.steerBubbles,
    });
  }
}

export async function sendMessage(
  text: string,
  attachments: SendMessagePayload["attachments"] = [],
  reminders: string[] = [],
  // `intent: "steer"` tells the host to interject into an in-flight turn rather
  // than run a fresh turn. Slash directives (/verify, /team, /cancel) pass
  // it; plain messages omit it (host defaults to "fresh"). Mirrors legacy
  // submitUserMessage's options.intent.
  intent?: "steer",
  // `continuation`: this send continues an existing work span (the one-at-a-time
  // queue auto-drain) rather than the user kicking off fresh work. Continuations
  // must NOT re-anchor the elapsed clock, so it stays continuous across the
  // auto-send boundary (and any compaction that fires in the continued turn).
  // `steerId`: renderer-minted identity for an intent:"steer" send (see
  // PendingSteer) — travels to injectSteer and back on the drain event.
  opts?: { continuation?: boolean; steerId?: string },
): Promise<void> {
  const message = text.trim();
  if (!message && (!attachments || attachments.length === 0)) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  // Re-anchor the work-span clock ONLY for a fresh user-initiated turn. Steers
  // join the in-flight turn and continuations chain the previous span — both
  // keep the existing anchor so the spinner's elapsed counter runs continuously
  // (this is what stops the "压缩后重置": compaction never starts a fresh span).
  const freshSpan = intent !== "steer" && !opts?.continuation;
  const spanStartedAt = freshSpan ? Date.now() : null;
  if (freshSpan) ensureSessionCache(sessionId).turnStartedAt = spanStartedAt;
  // Optimistically render the user's message right away (legacy did this via
  // appendEntry("user", …)). The host only commits a session_snapshot at turn
  // END, so without this the bubble wouldn't appear until the assistant finished
  // — the "发的消息答完才显示" the user hit. steerBubbles render ABOVE the whole
  // live block, which is correct ONLY for a fresh send's leading user bubble.
  //
  // A STEER is different: it interrupts text already on screen, so its bubble must
  // land BELOW that text and ABOVE the continuation (codex's 断一下 → 引导 → 继续
  // ordering). That can't be a steerBubble (wrong position) — instead the engine's
  // `user-message` drain inserts it INLINE into the live stream at the clean loop
  // boundary. So skip the optimistic bubble for steer here.
  steerSeq += 1;
  // Show the bubble for any fresh send that carries text OR attachments — an
  // image-only send (empty message) must still render its thumbnail right away.
  const hasAttachments = !!attachments && attachments.length > 0;
  const optimisticBubble =
    intent !== "steer" && (message || hasAttachments)
      ? { id: `sent-${steerSeq}`, text: message, ...(hasAttachments ? { attachments } : {}) }
      : null;
  set({
    working: true,
    status: "working",
    error: null,
    ...(freshSpan && spanStartedAt !== null ? { turnStartedAt: spanStartedAt, turnPauseStartedAt: null } : {}),
    // Fresh send → reset the overlay (this is a new turn). Steer → the turn is
    // mid-stream, so KEEP the overlay (wiping it would blank the assistant text
    // the user is steering against). The real drain (`user-message` handler)
    // flushes the partial into a committed round at the right boundary.
    ...(intent === "steer" ? {} : { overlay: EMPTY_OVERLAY }),
    pendingPermissions: [],
    pendingQuestions: [],
    ...(optimisticBubble ? { steerBubbles: [...state.steerBubbles, optimisticBubble] } : {}),
  });
  try {
    const payload: SendMessagePayload = {
      sessionId,
      message,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      // @-mentioned file contents ride as one-shot system reminders so the model
      // sees them without polluting the user's message bubble (mirrors how the
      // legacy renderer passes slash-directive context via `reminders`).
      ...(reminders && reminders.length > 0 ? { reminders } : {}),
      ...(intent ? { intent } : {}),
      ...(intent === "steer" && opts?.steerId ? { steerId: opts.steerId } : {}),
    };
    await invoke("send_message", payload as unknown as Record<string, unknown>);
  } catch (err) {
    set({ error: errMsg(err), working: false, status: "error" });
  }
}

export async function interrupt(): Promise<void> {
  if (!state.sessionId) return;
  set({ stopping: true, status: "stopping" });
  await invoke("interrupt", { sessionId: state.sessionId }).catch((err) => set({ error: errMsg(err) }));
}

/** Deterministic manual compaction (`/compact`). Sends the `compact_session`
 * control op straight to the host (same path auto-compaction uses). Shows the
 * pulsing divider immediately; on success the host's `context-compacted` stream
 * event resolves it into the real counts — here we only resolve the no-op case.
 * Interrupts a running turn first so the host compacts a settled history (mirror
 * legacy sendCompactRequest). */
export async function compactSession(): Promise<void> {
  if (!state.sessionId) return;
  set({ status: "compacting", compaction: { phase: "running", label: "Compacting context…" } });
  try {
    if (state.working) {
      // Mirror interrupt(): flag `stopping` so steer-capable UI (the queue
      // row's Steer button gates on it) disables while the host interrupts.
      // Without it a steer clicked in this window reaches the host mid-
      // interrupt and falls into queuedAfterInterrupt, where the pending-row
      // Retract can never reach it. Cleared by turn_completed/session_activity.
      set({ stopping: true });
      await invoke("interrupt", { sessionId: state.sessionId });
    }
    const result = await invoke<{ compacted?: boolean }>("compact_session", { sessionId: state.sessionId });
    if (result && result.compacted === false) {
      set({ compaction: { phase: "settled", label: "Nothing to compact" } });
    }
    // compacted === true → the context-compacted stream event resolves the divider.
  } catch (err) {
    set({ compaction: { phase: "settled", label: "Nothing to compact" }, error: errMsg(err) });
  } finally {
    if (!state.working) set({ status: "idle" });
  }
}

// ── Composer draft channel ──────────────────────────────────────────────────
// Edit / undo-to-branch / rollback restore a user message into the composer.
// The Composer watches draftRequest.seq and applies the text. Monotonic seq so
// identical text still re-fires (mirrors legacy actions.restoreDraft).

let draftSeq = 0;

// Codex's queue autosend is one-at-a-time on turn completion. We can't fire the
// send straight from `turn_completed` because the host emits a trailing
// `session_snapshot` right after it (in runTurn's finally) that clears
// `steerBubbles` — wiping the new send's optimistic user bubble (the "答完才显示"
// regression). So `turn_completed` only RECORDS the draft to send here, and the
// trailing `session_snapshot` handler fires it AFTER its own clear, so the bubble
// survives. Null when there's nothing queued / the turn was interrupted. Carries
// the sessionId so a session switch between the two events can't misfire the draft
// into a different session's snapshot.
let pendingAutoSend: { sessionId: string; text: string } | null = null;

export function requestComposerDraft(text: string, mode: "replace" | "prepend" = "replace"): void {
  draftSeq += 1;
  set({ draftRequest: { text, seq: draftSeq, mode } });
}

// ── Message queue (mirror legacy actions/prompt.js queuedPrompts) ────────────
// A turn-busy buffer. The composer enqueues a draft when sending while a turn is
// active. On a NORMAL turn end the queue auto-flushes one draft at a time (codex's
// `maybe_send_next_queued_input`: exactly one per completion, the next drains when
// THAT turn ends). On an INTERRUPT (Stop/Esc/budget) the unsent drafts are instead
// restored into the composer (codex's `on_interrupted_turn`), never auto-sent. Both
// are driven by the `turn_completed` handler. Manual paths: the per-row Steer/Send
// button + sendQueuedNow.

// Mirrors codex's `on_interrupted_turn` → `restore_user_message_to_composer`: an
// interrupted turn drains the not-yet-submitted drafts back into the composer
// (joined by blank lines, prepended before whatever the user has since typed)
// instead of auto-sending them. Clears the queue panel. `undrainedSteers` are
// the pending-steer texts the engine never drained before the interrupt wiped
// its queue (engine.interrupt clears pendingSteers) — without restoring them
// here, a Steer immediately followed by Stop silently discards the message.
// They precede the queued drafts: they were submitted earlier.
export function restoreQueuedToComposer(undrainedSteers: string[] = []): void {
  const drafts = [...undrainedSteers, ...state.queuedMessages];
  if (drafts.length === 0) return;
  set({ queuedMessages: [] });
  requestComposerDraft(drafts.join("\n\n"), "prepend");
}

export function enqueueMessage(text: string): void {
  const msg = text.trim();
  if (!msg) return;
  set({ queuedMessages: [...state.queuedMessages, msg] });
}

export function removeQueuedMessage(index: number): void {
  set({ queuedMessages: state.queuedMessages.filter((_, i) => i !== index) });
}

export function clearQueuedMessages(): void {
  if (state.queuedMessages.length === 0) return;
  set({ queuedMessages: [] });
}

export function moveQueuedMessageUp(index: number): void {
  if (index <= 0 || index >= state.queuedMessages.length) return;
  const next = [...state.queuedMessages];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  set({ queuedMessages: next });
}

/** Drag-reorder a queued draft from one slot to another (codex's draggable
 * pending list). No-op on out-of-range / same-slot. */
export function reorderQueuedMessage(from: number, to: number): void {
  const arr = state.queuedMessages;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as string);
  set({ queuedMessages: next });
}

/** Drop only the first array element equal to `value` (vs `filter`, which drops
 * every equal element). Used where two identical drafts can coexist and only one
 * should be removed. */
function dropFirstEqual(arr: string[], value: string): string[] {
  const i = arr.indexOf(value);
  return i < 0 ? arr : arr.filter((_, idx) => idx !== i);
}

/** Drop the pending steer the drain event names: by id when the event carries
 * one (exact row), else the first text match (id-less steers, e.g. replayed
 * or legacy events). Mirrors dropFirstEqual's first-only semantics. */
function dropFirstSteer(arr: PendingSteer[], steerId: string | undefined, text: string): PendingSteer[] {
  let i = steerId ? arr.findIndex((s) => s.id === steerId) : -1;
  if (i < 0) i = arr.findIndex((s) => s.text === text);
  return i < 0 ? arr : arr.filter((_, idx) => idx !== i);
}

/** Pop a queued draft back into the composer for editing (mirror legacy Edit). */
export function editQueuedMessage(index: number): void {
  const text = state.queuedMessages[index];
  if (text == null) return;
  set({ queuedMessages: state.queuedMessages.filter((_, i) => i !== index) });
  // Prepend (like restoreQueuedToComposer) so editing a queued draft doesn't
  // clobber whatever the user has since typed into the composer.
  requestComposerDraft(text, "prepend");
}

/** Steer a single queued draft into the LIVE turn (codex-style): inject it at the
 * running turn's next loop boundary, where the `user-message` drain renders it
 * inline (断一下 → 引导 → 继续). When the turn is already idle there's nothing to
 * steer, so send it as a normal fresh turn instead (which shows its own optimistic
 * bubble). Drops it from the panel on click; the brief gap until it reappears
 * inline is the boundary pause. */
export function steerQueuedMessage(index: number): void {
  const text = state.queuedMessages[index];
  if (text == null) return;
  if (state.working) {
    // Move it from "queued" (not submitted) to "pending steer" (submitted, awaiting
    // the boundary): the panel shows it as waiting until the `user-message` drain
    // lands it inline and removes it. Mirrors codex's two-queue split. The id is
    // minted HERE and rides the send_message request, so the row keeps one
    // identity across drain (user-message.steerId) and retract (retract_steer).
    const steerId = `steer_${crypto.randomUUID()}`;
    set({
      queuedMessages: state.queuedMessages.filter((_, i) => i !== index),
      pendingSteers: [...state.pendingSteers, { id: steerId, text }],
    });
    void sendMessage(text, [], [], "steer", { steerId });
  } else {
    // Idle → nothing to steer; send as a normal fresh turn (shows its own bubble).
    set({ queuedMessages: state.queuedMessages.filter((_, i) => i !== index) });
    void sendMessage(text, [], []);
  }
}

/** Withdraw a pending steer (submitted, awaiting the loop boundary) back into
 * the queued list — the inverse of steerQueuedMessage's working branch. The
 * engine only honors this while the steer is still in its pendingSteers queue;
 * once drained it's committed transcript and `retracted` comes back false —
 * then we leave the row alone (the `user-message` drain removes it and renders
 * the message inline, which is the truth). */
export async function retractPendingSteer(index: number): Promise<void> {
  const steer = state.pendingSteers[index];
  const sid = state.sessionId;
  if (steer == null || !sid) return;
  const result = await invoke<{ retracted?: boolean }>("retract_steer", {
    sessionId: sid,
    steerId: steer.id,
    message: steer.text,
  }).catch(() => null);
  if (!result?.retracted) return;
  // The await raced a possible session switch. Two hazards: (1) state now
  // belongs to a DIFFERENT session — mutating it would leak the text into that
  // session's queue; (2) a switch is mid-flight — captureCurrentSession already
  // parked sid's arrays, so a state-only patch gets clobbered when
  // restoreSessionPatch re-installs the stale cache later. Patch BOTH: the
  // cache entry (authoritative across switches; overwritten by the next
  // capture when we're still foreground, so the duplicate is harmless) and,
  // only when sid is still the visible session, the live state.
  const entry = sessionCache.get(sid);
  if (entry) {
    entry.pendingSteers = entry.pendingSteers.filter((s) => s.id !== steer.id);
    entry.queuedMessages = [...entry.queuedMessages, steer.text];
  }
  if (state.sessionId === sid) {
    set({
      pendingSteers: state.pendingSteers.filter((s) => s.id !== steer.id),
      queuedMessages: [...state.queuedMessages, steer.text],
    });
  }
}

// ── Pending skills (mirror legacy state.pendingSkills) ───────────────────────

export function addPendingSkill(skill: { name: string; description?: string }): void {
  if (!skill?.name) return;
  if (state.pendingSkills.some((s) => s.name === skill.name)) return;
  set({ pendingSkills: [...state.pendingSkills, { name: skill.name, description: skill.description }] });
}

export function removePendingSkill(name: string): void {
  set({ pendingSkills: state.pendingSkills.filter((s) => s.name !== name) });
}

export function clearPendingSkills(): void {
  if (state.pendingSkills.length === 0) return;
  set({ pendingSkills: [] });
}

// ── System notices (mirror legacy appendEntry("system", …)) ──────────────────
// Client-side confirmations for slash commands (/agent, /use) and their "unknown
// X" errors. Ephemeral: never sent to the host, cleared on session switch. The
// Timeline renders them as system chips after the committed transcript.

let noticeSeq = 0;

export function appendSystemNotice(text: string): void {
  const msg = text.trim();
  if (!msg) return;
  noticeSeq += 1;
  set({ systemNotices: [...state.systemNotices, { id: `notice-${noticeSeq}`, text: msg }] });
}

/** Rebuild the timestamp-anchored transcript notices from a session's durable
 * state: the self-evolve log ("💾 …" memory lines, each stamped `at`) and the
 * settled compaction boundaries (stamped `createdAt`). Both persist on the
 * session (snapshot / state blob), so a reload restores every notice at the
 * position it happened instead of pinning them after the last turn. Live
 * reviews/compactions during the active session upsert via handleModelStream
 * between snapshots; the next snapshot's wholesale re-seed supersedes them. */
function seedAnchoredNotices(session: unknown): AnchoredNotice[] {
  const s = session as {
    selfEvolveLog?: { summary?: string; at?: string }[];
    compactBoundaries?: { id?: string; createdAt?: string; messagesCompacted?: number; estimatedTokensAfter?: number }[];
  } | null;
  const out: AnchoredNotice[] = [];
  const log = s?.selfEvolveLog;
  if (Array.isArray(log)) {
    log.forEach((e, i) => {
      // Guard blanks on the summary itself, BEFORE prefixing — 💾 is a surrogate
      // pair, so a length check on the formatted text is an off-by-one trap.
      const summary = (e?.summary ?? "").trim();
      if (!summary) return;
      out.push({ id: `se-${i}`, at: e?.at ?? "", kind: "memory", text: `💾 ${summary}` });
    });
  }
  const boundaries = s?.compactBoundaries;
  if (Array.isArray(boundaries)) {
    boundaries.forEach((b, i) => {
      if (!b) return;
      out.push({
        id: `cb-${b.id ?? i}`,
        at: b.createdAt ?? "",
        kind: "compaction",
        text: compactedLabel(b.messagesCompacted, b.estimatedTokensAfter),
      });
    });
  }
  return sortAnchored(out);
}

/** Shared label for a settled compaction boundary (seed + live event paths). */
function compactedLabel(count?: number, tokensAfter?: number): string {
  const n = count ?? 0;
  const tokens = typeof tokensAfter === "number" ? tokensAfter.toLocaleString() : "?";
  return `Compacted ${n} message${n === 1 ? "" : "s"} → ${tokens} tokens`;
}

// Chronological; stampless entries sink to the end (the same place the old
// end-pinned rendering put everything).
function sortAnchored(list: AnchoredNotice[]): AnchoredNotice[] {
  return [...list].sort((a, b) => (a.at || "￿").localeCompare(b.at || "￿"));
}

/** Insert-or-replace one anchored notice from a live stream event. Keyed by id
 * so an event replayed after its snapshot already seeded the entry can't dup. */
function upsertAnchoredNotice(notice: AnchoredNotice): void {
  set({ anchoredNotices: sortAnchored([...state.anchoredNotices.filter((n) => n.id !== notice.id), notice]) });
}

/** Flush the queue as one fresh turn (mirror legacy sendQueueNow): joins drafts
 * with blank lines, interrupting a live turn first so the host runs them next. */
export async function sendQueuedNow(): Promise<void> {
  if (!state.sessionId || state.stopping) return;
  if (state.pendingPermissions.length > 0 || state.pendingQuestions.length > 0) return;
  const snapshot = state.queuedMessages.slice();
  if (snapshot.length === 0) return;
  set({ queuedMessages: [] });
  if (state.working) {
    try {
      await invoke("interrupt", { sessionId: state.sessionId });
    } catch (err) {
      // Restore so the user can retry (prepend — newer drafts may have queued).
      set({ queuedMessages: [...snapshot, ...state.queuedMessages], error: errMsg(err) });
      return;
    }
  }
  const combined = snapshot.length === 1 ? snapshot[0] : snapshot.join("\n\n");
  await sendMessage(combined);
}

// ── Message actions (mirror legacy actions/session.js + timeline.js) ─────────
// Edit / undo (fork-before) / branch (fork-from) / delete / rollback. The host
// owns the history mutation; the renderer reloads the resulting snapshot.

/** True once the session is idle again (interrupting a live turn first when
 * needed — the backend rejects history mutations mid-turn). */
async function settleBeforeMutation(): Promise<boolean> {
  const busy = state.working || state.pendingPermissions.length > 0 || state.pendingQuestions.length > 0;
  if (!busy) return true;
  try {
    set({ stopping: true, status: "stopping" });
    await invoke("interrupt", { sessionId: state.sessionId });
    return true;
  } catch (err) {
    set({ error: errMsg(err), stopping: false, status: "idle" });
    return false;
  }
}

/** Replace the active session with a host-mutated snapshot (rollback / delete —
 * same or new id, truncated history). Re-projects the transcript and re-anchors
 * HITL + desktop index. */
async function applyMutatedSession(session: SessionSnapshot): Promise<void> {
  set({
    sessionId: session.id,
    activeSession: session,
    parts: await projectParts(session),
    overlay: EMPTY_OVERLAY,
    working: false,
    stopping: false,
    status: "idle",
    // Clear volatile UI the same way loadSession does — a rollback/delete
    // re-projects the transcript, and any live compaction divider or
    // slash-command system notices belong to the pre-mutation history and would
    // otherwise persist as stale chips. Anchored notices (compaction
    // boundaries, self-evolve memory lines) are NOT volatile though: re-seed
    // them from the mutated session's durable state (same as loadSession) so an
    // edit/rollback doesn't swallow them.
    compaction: null,
    systemNotices: [],
    anchoredNotices: seedAnchoredNotices(session),
    ...hitlFromSession(session),
  });
  void api().recordSession(session as unknown as Record<string, unknown>).catch(() => undefined);
  void refreshDesktopState();
}

function sessionCwd(session: { cwd?: string } | null | undefined): string {
  return session?.cwd ?? state.workspaceCwd ?? "";
}

/** Truncate history to just before `messageId` and pre-fill the composer with
 * the removed message. Used directly by edit-and-resend. */
export async function rollbackSessionToMessage(messageId: string): Promise<void> {
  if (!state.sessionId || !messageId) return;
  if (!(await settleBeforeMutation())) return;
  try {
    const data = await invoke<{ session: SessionSnapshot; restoredMessage?: { content?: string } }>("rollback_session", {
      sessionId: state.sessionId,
      messageId,
    });
    await applyMutatedSession(data.session);
    requestComposerDraft(data.restoredMessage?.content ?? "");
  } catch (err) {
    set({ error: errMsg(err), stopping: false, status: "idle" });
  }
}

/** Assistant "创建分支": fork the conversation up to and including `messageId`
 * into a new session and switch to it. Original session is untouched. */
export async function forkSessionFromMessage(messageId: string): Promise<void> {
  if (!state.sessionId || !messageId) return;
  try {
    const data = await invoke<{ session?: SessionSnapshot & { cwd?: string } }>("fork_session", {
      sessionId: state.sessionId,
      messageId,
    });
    const forked = data?.session;
    if (!forked?.id) return;
    await loadSession({ id: forked.id, cwd: sessionCwd(forked) } as SessionListItem);
  } catch (err) {
    set({ error: errMsg(err) });
  }
}

/** User "撤回 ↩": non-destructive — fork a NEW session resuming from just BEFORE
 * this message (original kept intact), switch to it, and pre-fill the composer
 * with the message text so it can be edited and re-sent. */
export async function undoToBranch(messageId: string, draftText: string): Promise<void> {
  if (!state.sessionId || !messageId) return;
  try {
    const data = await invoke<{ session?: SessionSnapshot & { cwd?: string } }>("fork_session", {
      sessionId: state.sessionId,
      messageId,
      inclusive: false,
    });
    const forked = data?.session;
    if (!forked?.id) return;
    await loadSession({ id: forked.id, cwd: sessionCwd(forked) } as SessionListItem);
    if (draftText) requestComposerDraft(draftText);
  } catch (err) {
    set({ error: errMsg(err) });
  }
}

/** Assistant "删除消息": destructive truncate-from-here. Confirms, interrupts a
 * live turn if needed, then rebuilds from the truncated snapshot. */
export async function deleteMessagesFrom(messageId: string): Promise<void> {
  if (!state.sessionId || !messageId) return;
  if (!window.confirm("删除这条消息及其之后的全部内容？此操作不可撤销。")) return;
  if (!(await settleBeforeMutation())) return;
  try {
    const data = await invoke<{ session: SessionSnapshot }>("delete_message", {
      sessionId: state.sessionId,
      messageId,
    });
    await applyMutatedSession(data.session);
  } catch (err) {
    set({ error: errMsg(err), stopping: false, status: "idle" });
  }
}

/** User "编辑 ✎" save path: truncate to just before `messageId`, then re-send the
 * edited text as a fresh turn (mirrors legacy editAndResend). */
export async function editAndResend(messageId: string, text: string): Promise<void> {
  if (!state.sessionId || !messageId || !text) return;
  await rollbackSessionToMessage(messageId);
  await sendMessage(text);
  requestComposerDraft("");
}

// ── HITL actions (mirror legacy actions/hitl.js) ────────────────────────────

export interface ApproveOpts {
  remember?: "session";
  updatedInput?: unknown;
  reason?: string;
}

export function toggleHitlDock(): void {
  set({ hitlCollapsed: !state.hitlCollapsed });
}

/** Approve or reject one tool call. Optimistic: removes it from the pending
 * list and resumes "working" before the IPC resolves; restores on failure. */
export async function approvePermission(callId: string, approved: boolean, opts: ApproveOpts = {}): Promise<void> {
  if (!state.sessionId) return;
  const previous = state.pendingPermissions.find((t) => t.id === callId);
  set({
    pendingPermissions: state.pendingPermissions.filter((t) => t.id !== callId),
    working: true,
    status: approved ? "working" : "idle",
    ...resumeTurnClockPatch(),
  });
  const payload: Record<string, unknown> = { sessionId: state.sessionId, callId, approved };
  if (opts.remember) payload.remember = opts.remember;
  if (opts.updatedInput !== undefined) payload.updatedInput = opts.updatedInput;
  if (opts.reason) payload.reason = opts.reason;
  try {
    await invoke("approve_tool", payload);
  } catch (err) {
    if (previous) set({ pendingPermissions: [...state.pendingPermissions, previous], working: false, error: errMsg(err) });
    else set({ working: false, error: errMsg(err) });
  }
}

export async function approveAllPermissions(approved: boolean): Promise<void> {
  if (!state.sessionId) return;
  // Snapshot the session id alongside ids/snapshot: the loop awaits one IPC
  // round-trip per call, and a sidebar click could switch sessions in that
  // window. Re-reading state.sessionId mid-loop would route the remaining
  // approvals at the NEW session (with the OLD session's call ids), silently
  // failing them and leaving the original turn stuck waiting for approval.
  const sessionId = state.sessionId;
  const ids = state.pendingPermissions.map((t) => t.id);
  if (ids.length === 0) return;
  const snapshot = state.pendingPermissions;
  set({ pendingPermissions: [], working: true, status: approved ? "working" : "idle", ...resumeTurnClockPatch() });
  let i = 0;
  try {
    for (; i < ids.length; i++) {
      await invoke("approve_tool", { sessionId, callId: ids[i], approved });
    }
  } catch (err) {
    // Restore only the call that failed + the ones after it. The earlier ids were
    // already approved on the host; re-adding them (the full snapshot) would
    // resurrect resolved prompts. ids mirrors snapshot order, so slice(i) is exact.
    set({ pendingPermissions: snapshot.slice(i), working: false, error: errMsg(err) });
  }
}

/** Persist a permission rule to the workspace, then approve the call. */
export async function persistAlwaysAllow(callId: string, rule: Record<string, unknown>): Promise<void> {
  try {
    await api().addPermissionRule(state.workspaceCwd ?? undefined, "workspace", rule);
  } catch (err) {
    set({ error: errMsg(err) });
    return;
  }
  await approvePermission(callId, true);
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  if (!state.sessionId) return;
  const previous = state.pendingQuestions.find((q) => q.id === questionId);
  set({
    pendingQuestions: state.pendingQuestions.filter((q) => q.id !== questionId),
    working: true,
    status: "working",
    ...resumeTurnClockPatch(),
  });
  try {
    await invoke("answer_question", { sessionId: state.sessionId, questionId, answer });
  } catch (err) {
    if (previous) set({ pendingQuestions: [...state.pendingQuestions, previous], working: false, error: errMsg(err) });
    else set({ working: false, error: errMsg(err) });
  }
}

/** Atomic submission for a batched question group — removes all members and
 * fires one IPC call (mirrors legacy answerQuestionGroup). */
export async function answerQuestionGroup(groupId: string, answers: Record<string, string>): Promise<void> {
  if (!state.sessionId) return;
  const snapshot = state.pendingQuestions.filter((q) => q.groupId === groupId);
  if (snapshot.length === 0) return;
  set({
    pendingQuestions: state.pendingQuestions.filter((q) => q.groupId !== groupId),
    working: true,
    status: "working",
    ...resumeTurnClockPatch(),
  });
  try {
    await invoke("answer_question_group", { sessionId: state.sessionId, groupId, answers });
  } catch (err) {
    set({ pendingQuestions: [...state.pendingQuestions, ...snapshot], working: false, error: errMsg(err) });
  }
}

// ── Per-session UI cache (mirror legacy session-store.js) ────────────────────
// The host keeps multiple engines alive at once, so off-screen sessions keep
// streaming events. We park each background session's volatile UI here (overlay,
// working/stopping, pending HITL, turn anchor, attention marker) so switching
// back restores a coherent in-flight view instead of a stale snapshot. The
// VISIBLE session's canonical state lives on `state`; captureCurrentSession copies
// state→cache before a switch, restore reads cache→state after.

interface SessionUiCache {
  snapshot: SessionSnapshot | null;
  active: boolean;
  working: boolean;
  stopping: boolean;
  overlay: StreamOverlay;
  pendingPermissions: PermissionToolCall[];
  pendingQuestions: PendingQuestionItem[];
  needsAttention: boolean;
  turnStartedAt: number | null;
  turnPauseStartedAt: number | null;
  // The composer queue panel is session-scoped: not-yet-submitted drafts
  // (queuedMessages) + submitted-but-awaiting-boundary steers (pendingSteers).
  // Parked here on switch-away so they don't leak into the next session's panel
  // (and aren't lost when switching back).
  queuedMessages: string[];
  pendingSteers: PendingSteer[];
  // The in-flight live transcript of a turn running while this session sits in
  // the background: tool cards (liveTools), the intermediate assistant text
  // rounds flushed ahead of them (liveText), and subagent activity. The host
  // only commits a session_snapshot at turn END, so without parking + restoring
  // (and accumulating in applyBackgroundEvent) these, switching away from a
  // running session and back blanks its tool cards / rounds until the next
  // snapshot — the cards "vanish" mid-turn. Cleared on a committed snapshot /
  // turn boundary, exactly like the foreground `state` fields.
  liveTools: TimelineToolPart[];
  liveText: TimelineTextPart[];
  subagentActivity: Record<string, SubagentActivity>;
  asyncTaskIndex: Record<string, AsyncTaskLite>;
}

const sessionCache = new Map<string, SessionUiCache>();

function ensureSessionCache(id: string): SessionUiCache {
  let entry = sessionCache.get(id);
  if (!entry) {
    entry = {
      snapshot: null,
      active: false,
      working: false,
      stopping: false,
      overlay: EMPTY_OVERLAY,
      pendingPermissions: [],
      pendingQuestions: [],
      needsAttention: false,
      turnStartedAt: null,
      turnPauseStartedAt: null,
      queuedMessages: [],
      pendingSteers: [],
      liveTools: [],
      liveText: [],
      subagentActivity: {},
      asyncTaskIndex: {},
    };
    sessionCache.set(id, entry);
  }
  return entry;
}

// Push the visible session's volatile state into its cache entry. Call right
// before switching away (mirror legacy captureCurrentSessionUi).
function captureCurrentSession(): void {
  const id = state.sessionId;
  if (!id) return;
  const entry = ensureSessionCache(id);
  entry.active = state.working || state.stopping;
  entry.working = state.working;
  entry.stopping = state.stopping;
  // Mirror the foreground running state into the sidebar badge before we switch
  // away. The active session's turn events only update global `working` (never
  // setBadge), so without this the green dot reads badge.running === false the
  // instant it goes to the background and dies even though the turn is live.
  // Later background events (turn_completed/…) clear it correctly.
  setBadge(id, { running: state.working || state.stopping });
  entry.turnStartedAt = state.turnStartedAt;
  entry.turnPauseStartedAt = state.turnPauseStartedAt;
  entry.overlay = state.overlay;
  entry.pendingPermissions = state.pendingPermissions;
  entry.pendingQuestions = state.pendingQuestions;
  entry.queuedMessages = state.queuedMessages;
  entry.pendingSteers = state.pendingSteers;
  entry.liveTools = state.liveTools;
  entry.liveText = state.liveText;
  entry.subagentActivity = state.subagentActivity;
  entry.asyncTaskIndex = state.asyncTaskIndex;
  entry.snapshot = state.activeSession ?? entry.snapshot;
  // Rescue an in-flight queue autosend. `turn_completed` dequeues one draft into
  // `pendingAutoSend` and the trailing `session_snapshot` fires it. If the user
  // switches away in that window, that snapshot arrives as a BACKGROUND event and
  // never fires the send — the dequeued draft would be lost. Park it back at the
  // front of this session's queue so switching in re-queues it instead.
  if (pendingAutoSend && pendingAutoSend.sessionId === id) {
    entry.queuedMessages = [pendingAutoSend.text, ...entry.queuedMessages];
    pendingAutoSend = null;
  }
}

// Volatile fields to restore onto `state` when returning to a session. Reads the
// cache (in-flight values streamed while it was in the background); falls back to
// the freshly-loaded snapshot's HITL when no cache exists (cold load). Clears the
// attention marker because the user is now looking at it.
function restoreSessionPatch(id: string, snapshot: SessionSnapshot, committed: Set<string>): Partial<MainState> {
  const entry = sessionCache.get(id);
  if (!entry) return { overlay: EMPTY_OVERLAY, working: false, stopping: false, status: "idle", turnStartedAt: null, turnPauseStartedAt: null, queuedMessages: [], pendingSteers: [], liveTools: [], liveText: [], subagentActivity: {}, asyncTaskIndex: mergeAsyncIndexFromSession(snapshot, {}), ...hitlFromSession(snapshot) };
  entry.needsAttention = false;
  const working = entry.active && entry.working;
  return {
    overlay: entry.overlay,
    working,
    stopping: working && entry.stopping,
    turnStartedAt: entry.turnStartedAt,
    turnPauseStartedAt: entry.turnPauseStartedAt,
    status: working ? "working" : entry.pendingPermissions.length > 0 ? "waiting approval" : entry.pendingQuestions.length > 0 ? "waiting answer" : "idle",
    pendingPermissions: entry.pendingPermissions,
    pendingQuestions: entry.pendingQuestions,
    queuedMessages: entry.queuedMessages,
    pendingSteers: entry.pendingSteers,
    // Restore the in-flight live cards/rounds streamed while this session was in
    // the background. Drop any card the freshly-loaded snapshot already committed
    // (matched by call id) so a tool lives in exactly one of parts/liveTools — no
    // duplicate React key.
    liveTools: entry.liveTools.filter((t) => !committed.has(t.id)),
    liveText: entry.liveText,
    subagentActivity: entry.subagentActivity,
    // Snapshot records first, then the fresher in-flight pings parked while
    // this session ran in the background.
    asyncTaskIndex: { ...mergeAsyncIndexFromSession(snapshot, {}), ...entry.asyncTaskIndex },
  };
}

// Update a session's sidebar badge (mirror legacy refreshSessionBadges). Skips
// the set when nothing changed so background text-deltas don't thrash React.
function setBadge(id: string, patch: { attention?: boolean; running?: boolean }): void {
  const cur = state.sessionBadges[id] ?? {};
  const next = { attention: cur.attention, running: cur.running, ...patch };
  if (cur.attention === next.attention && cur.running === next.running) return;
  set({ sessionBadges: { ...state.sessionBadges, [id]: next } });
}

function clearBadge(id: string): void {
  if (!state.sessionBadges[id]) return;
  const nextBadges = { ...state.sessionBadges };
  delete nextBadges[id];
  set({ sessionBadges: nextBadges });
}

/** Drop every trace of a session the user just deleted. Without this the parked
 * per-session UI cache (each entry holds a full session snapshot) and its
 * sidebar badge leak for the lifetime of the window — a long-lived window that
 * creates and deletes many sessions accumulates them indefinitely. Also drops a
 * pending autosend still aimed at the gone session so it can't fire later. */
export function forgetSession(id: string): void {
  if (!id) return;
  sessionCache.delete(id);
  clearBadge(id);
  if (pendingAutoSend && pendingAutoSend.sessionId === id) pendingAutoSend = null;
}

// Fire an OS notification only when the app window is unfocused (mirror legacy
// notifyIfUnfocused) — no point notifying about a session the user is watching.
function notifyIfUnfocused(title: string, body?: string): void {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  try {
    bridge().showNotification(title, body);
  } catch {
    /* notifications are best-effort */
  }
}

// Apply an event for a session that is NOT in the foreground into its cache, so
// the dock/transcript are coherent on switch-back (mirror legacy
// applyBackgroundEvent). Also drives the sidebar attention/running badges + OS
// notifications off the same state transitions.
function applyBackgroundEvent(sessionId: string, event: AgentEvent): void {
  const entry = ensureSessionCache(sessionId);
  switch (event.type) {
    case "session_title_updated": {
      const update = event as { title: string; expectedTitle: string };
      if (entry.snapshot?.title === update.expectedTitle) {
        entry.snapshot = { ...entry.snapshot, title: update.title };
      }
      return;
    }
    case "session_snapshot": {
      const session = (event as { session?: SessionSnapshot }).session ?? null;
      entry.snapshot = session;
      // The snapshot's parts now own the committed text rounds (mirror foreground);
      // the live cards are deduped against the snapshot at restore time.
      entry.liveText = [];
      if (session?.interrupted && entry.active && entry.working) entry.stopping = true;
      return;
    }
    case "session_activity": {
      const active = (event as { active?: boolean }).active ?? false;
      const stopping = (event as { stopping?: boolean }).stopping ?? false;
      entry.active = active;
      entry.working = active && !stopping ? true : active && stopping ? entry.working : false;
      entry.stopping = active && stopping;
      // Resuming work after a HITL pause → bank the paused span (foreground parity).
      if (active && !stopping) {
        const banked = bankPausedSpan(entry.turnStartedAt, entry.turnPauseStartedAt);
        if (banked !== null) {
          entry.turnStartedAt = banked;
          entry.turnPauseStartedAt = null;
        }
      }
      setBadge(sessionId, { running: active && !stopping });
      return;
    }
    case "turn_started":
      entry.active = true;
      entry.working = true;
      entry.stopping = false;
      entry.overlay = EMPTY_OVERLAY;
      entry.liveTools = [];
      entry.liveText = [];
      entry.subagentActivity = {};
      entry.needsAttention = true;
      // Re-anchor the elapsed clock for this turn (foreground parity).
      entry.turnStartedAt = Date.now();
      entry.turnPauseStartedAt = null;
      setBadge(sessionId, { running: true, attention: true });
      return;
    case "model_stream": {
      const sub = (event as {
        event?: {
          type?: string;
          text?: string;
          question?: PendingQuestionItem;
          id?: string;
          name?: string;
          input?: unknown;
          command?: string;
          message?: string;
          output?: string;
          status?: ToolCallStatus;
          taskId?: string;
          event?: { type?: string; text?: string; id?: string; name?: string; input?: unknown; status?: string; reason?: string };
        };
      }).event;
      if (!sub) return;
      if (sub.type === "text-delta") entry.overlay = { ...entry.overlay, assistantText: entry.overlay.assistantText + (sub.text ?? "") };
      else if (sub.type === "reasoning-delta") entry.overlay = { ...entry.overlay, reasoning: entry.overlay.reasoning + (sub.text ?? "") };
      else if (sub.type === "stream-reset") entry.overlay = EMPTY_OVERLAY;
      else if (sub.type === "tool-progress") {
        // Mirror the foreground handler: write_todos goes to the task pane, every
        // other tool becomes a live card. Flush the current overlay into a round
        // first so the card sorts below its text, exactly as foreground does.
        if (sub.id && sub.name && sub.name !== "write_todos") {
          const flushed = flushOverlayInto(entry.overlay, entry.liveText);
          if (flushed) {
            entry.liveText = flushed.liveText;
            entry.overlay = flushed.overlay;
          }
          entry.liveTools = upsertLiveTool(entry.liveTools, sub as LiveToolEvent);
        }
      } else if (sub.type === "subagent-event") {
        if (sub.taskId && sub.event) {
          entry.subagentActivity = applySubagentEvent(entry.subagentActivity, sub.taskId, sub.event);
        }
      } else if (sub.type === "async-task-updated" || sub.type === "async-task-injected") {
        entry.asyncTaskIndex = upsertAsyncTaskLite(entry.asyncTaskIndex, (sub as { task?: unknown }).task);
      } else if (sub.type === "async-task-evicted-batch") {
        const tasks = (sub as { tasks?: unknown[] }).tasks;
        if (Array.isArray(tasks)) for (const t of tasks) entry.asyncTaskIndex = upsertAsyncTaskLite(entry.asyncTaskIndex, t);
      } else if (sub.type === "user-message") {
        // The engine drained a steer at a loop boundary while this session ran
        // in the background. The committed bubble arrives via load_session on
        // switch-back; what must happen NOW is dropping the "waiting" row from
        // the parked cache — background turn_completed can't tell drained from
        // undrained, so a row left here resurrects on restore as a ghost
        // ↳/Retract row on an idle session (真实踩过：steer 后切走再切回).
        const steerText = ((sub as { text?: string }).text ?? "").trim();
        const drainedSteerId = (sub as { steerId?: string }).steerId;
        if (steerText || drainedSteerId) entry.pendingSteers = dropFirstSteer(entry.pendingSteers, drainedSteerId, steerText);
      } else if (sub.type === "question-request" && sub.question?.id) {
        entry.pendingQuestions = [...entry.pendingQuestions.filter((q) => q.id !== sub.question!.id), sub.question];
        entry.active = false;
        entry.working = false;
        entry.stopping = false;
        entry.needsAttention = true;
        entry.turnPauseStartedAt = pauseStamp(entry.turnStartedAt, entry.turnPauseStartedAt);
        setBadge(sessionId, { running: false, attention: true });
        notifyIfUnfocused("Reina has a question (background session)", sub.question.question);
      }
      return;
    }
    case "permission_request": {
      const tc = (event as { toolCall?: PermissionToolCall }).toolCall;
      if (!tc?.id) return;
      entry.pendingPermissions = [...entry.pendingPermissions.filter((t) => t.id !== tc.id), tc];
      entry.active = false;
      entry.working = false;
      entry.stopping = false;
      entry.needsAttention = true;
      entry.turnPauseStartedAt = pauseStamp(entry.turnStartedAt, entry.turnPauseStartedAt);
      setBadge(sessionId, { running: false, attention: true });
      notifyIfUnfocused("Reina needs approval (background session)", tc.summary || tc.name);
      return;
    }
    case "question_request": {
      const q = (event as { question?: PendingQuestionItem }).question;
      if (!q?.id) return;
      entry.pendingQuestions = [...entry.pendingQuestions.filter((p) => p.id !== q.id), q];
      entry.active = false;
      entry.working = false;
      entry.stopping = false;
      entry.needsAttention = true;
      entry.turnPauseStartedAt = pauseStamp(entry.turnStartedAt, entry.turnPauseStartedAt);
      setBadge(sessionId, { running: false, attention: true });
      notifyIfUnfocused("Reina has a question (background session)", q.question);
      return;
    }
    case "turn_completed": {
      const session = (event as { result?: { session?: SessionSnapshot } }).result?.session;
      // Queue semantics, foreground parity (see the foreground turn_completed):
      // rows still in pendingSteers never drained — on an interrupt the engine
      // discarded them, so park the texts as queued drafts (the composer belongs
      // to the foreground session; the panel resurfaces them on switch-back
      // instead of losing them). On normal completion mirror the foreground
      // wipe — drained steers were already dropped by their user-message events.
      const interrupted = entry.stopping || !!session?.interrupted;
      if (interrupted && entry.pendingSteers.length > 0) {
        entry.queuedMessages = [...entry.pendingSteers.map((s) => s.text), ...entry.queuedMessages];
      }
      entry.pendingSteers = [];
      entry.active = false;
      entry.working = false;
      entry.stopping = false;
      entry.overlay = EMPTY_OVERLAY;
      entry.liveTools = [];
      entry.liveText = [];
      entry.subagentActivity = {};
      entry.needsAttention = true;
      if (session) entry.snapshot = session;
      setBadge(sessionId, { running: false, attention: true });
      notifyIfUnfocused(
        "Reina finished (background session)",
        typeof entry.snapshot?.title === "string" ? entry.snapshot.title : sessionId,
      );
      return;
    }
    case "turn_failed":
      entry.active = false;
      entry.working = false;
      entry.stopping = false;
      // Foreground parity: a failed turn drops its undrained steers too.
      entry.pendingSteers = [];
      entry.liveTools = [];
      entry.liveText = [];
      entry.subagentActivity = {};
      entry.needsAttention = true;
      setBadge(sessionId, { running: false, attention: true });
      return;
    case "turn_interrupted":
      entry.active = true;
      entry.working = true;
      entry.stopping = true;
      setBadge(sessionId, { running: true });
      return;
    default:
      return;
  }
}

async function handleAgentEvent(event: AgentEvent): Promise<void> {
  if (event.type === "session_created") {
    const e = event as { sessionId: string; session: SessionSnapshot };
    if (state.sessionId && e.sessionId !== state.sessionId && !state.activeSession) return;
    set({ sessionId: e.sessionId, activeSession: e.session, parts: await projectParts(e.session), asyncTaskIndex: mergeAsyncIndexFromSession(e.session, {}), ...hitlFromSession(e.session) });
    // Register the host-created session with the desktop so it shows up in the
    // sidebar (mirror legacy agent-events.js session_created → persistSession).
    // Host-initiated creations — most visibly "创建分支"/undo-to-branch forks —
    // otherwise get created and switched-to but never listed, so the user sees
    // no new branch and the feature looks dead. recordSession upserts by id, so
    // it's a harmless no-op for sessions the renderer already recorded itself.
    // Await before refreshing or getDesktopState races the unrecorded write.
    await api().recordSession(e.session as unknown as Record<string, unknown>).catch(() => undefined);
    void api().setActiveSession(e.sessionId).catch(() => undefined);
    await refreshDesktopState();
    return;
  }

  const evSessionId = (event as { sessionId?: string }).sessionId;
  // Park any event that isn't for the foreground session in its per-session
  // cache so switching back restores a coherent in-flight view (overlay,
  // pending HITL, working). Crucially this also fires on a DRAFT
  // (state.sessionId === null): a just-parked previous session keeps running
  // and emits session_snapshot/model_stream/turn_completed — without isolating
  // those here they'd fall through to the foreground handler and repaint the
  // blank "New session" view with the old transcript (the "新建 session 主页面
  // 没切换" bug). `session_created` (draft→real adoption + forks) is handled
  // above and returns before this guard, so it still switches correctly.
  if (evSessionId && evSessionId !== state.sessionId) {
    applyBackgroundEvent(evSessionId, event);
    if (
      event.type === "session_title_updated" ||
      event.type === "session_snapshot" ||
      event.type === "turn_completed"
    ) {
      void refreshDesktopState();
    }
    return;
  }

  switch (event.type) {
    case "host_ready":
      return;
    case "turn_started":
      // Re-anchor the elapsed clock at every turn start (Claude Code per-query
      // reset). Compaction/steers don't fire turn_started, so they keep the
      // anchor; a new runTurn (fresh/queued/autopilot) restarts it.
      // A settled compaction divider ("Compacted N messages → …") is turn-scoped
      // UI: it floats BELOW the committed transcript, so left alone it trails
      // every later message looking like a fresh compaction. Dismiss it when the
      // next turn begins; keep a running one (manual /compact racing a send).
      set({ working: true, stopping: false, status: "working", overlay: EMPTY_OVERLAY, error: null, liveTools: [], liveText: [], subagentActivity: {}, turnStartedAt: Date.now(), turnPauseStartedAt: null, ...(state.compaction?.phase === "settled" ? { compaction: null } : {}) });
      return;
    case "session_activity": {
      const active = (event as { active?: boolean }).active ?? false;
      const stopping = (event as { stopping?: boolean }).stopping ?? false;
      if (stopping) set({ stopping: true, status: "stopping" });
      else if (!active) set({ working: false, stopping: false, status: state.status === "error" ? "error" : "idle" });
      // Bank any HITL pause on resume (no-op if not paused — optimistic approve/
      // answer already banked it; this covers host-driven resumes).
      else set({ working: true, status: "working", ...resumeTurnClockPatch() });
      return;
    }
    case "session_title_updated": {
      const update = event as { sessionId: string; title: string; expectedTitle: string };
      if (state.activeSession?.id === update.sessionId && state.activeSession.title === update.expectedTitle) {
        set({ activeSession: { ...state.activeSession, title: update.title } });
      }
      void refreshDesktopState();
      return;
    }
    case "session_snapshot": {
      const session = (event as { session: SessionSnapshot }).session;
      const projected = await projectParts(session);
      // Drop only the live tool cards the snapshot now OWNS (matched by
      // call id). A snapshot can arrive mid-turn — e.g. update_session_config
      // when the user changes model/effort while a tool is still running — and
      // unconditionally clearing would make that in-flight card vanish until
      // the next tool-progress re-creates it. Keeping the uncommitted ones also
      // guarantees a tool lives in exactly one of parts/liveTools (no dup key).
      const committed = new Set(
        projected.flatMap((p) => (p.type === "tool" ? (p as TimelineToolPart).callIds : [])),
      );
      set({
        activeSession: session,
        parts: projected,
        overlay: EMPTY_OVERLAY,
        steerBubbles: [],
        // The snapshot's durable state (compactBoundaries / selfEvolveLog) is
        // the source of truth for anchored notices — rebuild wholesale, which
        // also supersedes the live-upserted entries with their seeded twins.
        anchoredNotices: seedAnchoredNotices(session),
        asyncTaskIndex: mergeAsyncIndexFromSession(session, state.asyncTaskIndex),
        liveTools: state.liveTools.filter((t) => !committed.has(t.id)),
        // The snapshot's projected parts now own this turn's committed text
        // rounds, so drop the in-flight live rounds (same fidelity as clearing
        // `overlay` above — uncommitted tail text was never persisted anyway).
        liveText: [],
        ...hitlFromSession(session),
        ...(session.interrupted && state.working ? { stopping: true } : {}),
      });
      // Fire the queue autosend the prior `turn_completed` recorded, now that this
      // trailing snapshot has cleared steerBubbles — sendMessage's optimistic
      // bubble lands after the clear and survives (the whole reason it's deferred
      // here instead of running inline in `turn_completed`). One draft per turn;
      // the next turn's completion drains the next (codex one-at-a-time).
      if (pendingAutoSend && pendingAutoSend.sessionId === session.id && !state.working && !session.interrupted) {
        const next = pendingAutoSend.text;
        pendingAutoSend = null;
        // Continuation: chain the prior span's clock instead of re-anchoring it.
        void sendMessage(next, [], [], undefined, { continuation: true });
      }
      reflectSessionModel(session.model);
      reflectSessionAgentMode(session);
      // Main keeps non-title sidebar metadata in sync from authoritative
      // snapshots; title finalization has its own targeted event above.
      void refreshDesktopState();
      return;
    }
    case "model_stream":
      handleModelStream((event as { event: { type: string; text?: string; question?: PendingQuestionItem; usage?: unknown } }).event);
      return;
    case "permission_request": {
      // Add the FULL tool call (input, allowedDecisions, summary) — the dock
      // renders a yes/no question + diff preview + decision options from it.
      const tc = (event as { toolCall: PermissionToolCall }).toolCall;
      if (!tc || !tc.id) return;
      set({
        working: false,
        status: "waiting approval",
        pendingPermissions: [...state.pendingPermissions.filter((t) => t.id !== tc.id), tc],
        // Pause the elapsed clock while the prompt is open (banked on resume).
        turnPauseStartedAt: pauseStamp(state.turnStartedAt, state.turnPauseStartedAt),
      });
      return;
    }
    case "question_request": {
      const q = (event as { question: PendingQuestionItem }).question;
      if (!q || !q.id) return;
      set({
        working: false,
        status: "waiting answer",
        pendingQuestions: [...state.pendingQuestions.filter((p) => p.id !== q.id), q],
        // Pause the elapsed clock while the prompt is open (banked on resume).
        turnPauseStartedAt: pauseStamp(state.turnStartedAt, state.turnPauseStartedAt),
      });
      return;
    }
    case "turn_completed": {
      const session = (event as { result?: { session?: SessionSnapshot } }).result?.session ?? state.activeSession;
      // Mirror codex's turn-end queue handling. `interrupted` covers any abort
      // (Stop/Esc → state.stopping; budget/review → session.interrupted): runTurn
      // resolves even on interrupt, so this `turn_completed` fires either way.
      //   • Normal completion → autosend exactly ONE queued draft (codex
      //     `maybe_send_next_queued_input`). Recorded synchronously here (see
      //     pendingAutoSend); the trailing `session_snapshot` actually fires it so
      //     its optimistic bubble survives the snapshot's steerBubbles clear.
      //   • Interrupted → restore the unsent drafts into the composer (codex
      //     `on_interrupted_turn`), never autosend.
      const interrupted = state.stopping || !!session?.interrupted;
      // Captured BEFORE the set() below wipes pendingSteers: entries still here
      // never drained (drained ones were removed by their user-message event),
      // and the engine's interrupt discarded them — restore, don't lose.
      const undrainedSteers = interrupted ? state.pendingSteers.map((s) => s.text) : [];
      const autoSend = !interrupted && state.queuedMessages.length > 0;
      const autoSendSessionId = session?.id ?? state.sessionId;
      pendingAutoSend = autoSend && autoSendSessionId
        ? { sessionId: autoSendSessionId, text: state.queuedMessages[0] }
        : null;
      // resetHitlDock — a completed turn clears any pending prompts.
      set({
        working: false,
        stopping: false,
        status: "idle",
        activeSession: session,
        parts: await projectParts(session),
        // Same wholesale re-seed as session_snapshot — this branch commits the
        // turn's parts, so the anchored notices must track the same session.
        anchoredNotices: seedAnchoredNotices(session),
        overlay: EMPTY_OVERLAY,
        steerBubbles: [],
        pendingSteers: [],
        liveTools: [],
        liveText: [],
        subagentActivity: {},
        asyncTaskIndex: mergeAsyncIndexFromSession(session, state.asyncTaskIndex),
        pendingPermissions: [],
        pendingQuestions: [],
        // Drop the drained draft from the panel so it can't double-send.
        ...(autoSend ? { queuedMessages: state.queuedMessages.slice(1) } : {}),
      });
      void refreshDesktopState();
      // Interrupt path drains the remaining drafts back into the composer.
      if (interrupted) restoreQueuedToComposer(undrainedSteers);
      return;
    }
    case "turn_failed": {
      // The host clears working/stopping via the session_activity{active:false}
      // it emits from runTurn's finally, but the error itself would otherwise be
      // swallowed (legacy showError). Surface it; session_activity preserves the
      // "error" status (it only downgrades to "idle" when status isn't error).
      const failError = (event as { error?: string }).error;
      set({ working: false, stopping: false, status: "error", error: failError ?? "Turn failed", liveTools: [], liveText: [], subagentActivity: {}, pendingSteers: [] });
      return;
    }
    case "turn_interrupted":
      set({ stopping: true, status: "stopping" });
      return;
    default:
      return;
  }
}

interface LiveToolEvent {
  id: string;
  name: string;
  status?: ToolCallStatus;
  input?: unknown;
  command?: string;
  message?: string;
  output?: string;
}

let liveRoundSeq = 0;

// Flush the in-flight `overlay` (the assistant text/reasoning streamed for the
// CURRENT round) into a committed `liveText` round and clear the overlay. Called
// at a round boundary (a tool call, or a drained steer) so the round's text is
// pinned in order ABOVE the work that follows it. Returns a `set()` patch —
// `{}` when there is nothing to flush, so callers can spread it unconditionally.
// Pure form: flush an arbitrary overlay/liveText pair into a committed round.
// Returns null when there's nothing to flush. Used both for the foreground
// `state` (via flushOverlayRound) and for a background session's cache entry.
function flushOverlayInto(
  overlay: StreamOverlay,
  liveText: TimelineTextPart[],
): { liveText: TimelineTextPart[]; overlay: StreamOverlay } | null {
  if (!overlay.assistantText.trim() && !overlay.reasoning.trim()) return null;
  liveRoundSeq += 1;
  const round: TimelineTextPart = {
    id: `live-round-${liveRoundSeq}`,
    type: "text",
    role: "assistant",
    // Stamped at flush time (≈ when this round's first tool fired). Sorts before
    // those tools via the stable-sort + text-first concat in the renderer even
    // on a millisecond tie, and before the NEXT round's later text/tools.
    createdAt: new Date().toISOString(),
    content: overlay.assistantText,
    ...(overlay.reasoning.trim() ? { reasoning: overlay.reasoning } : {}),
  };
  return { liveText: [...liveText, round], overlay: EMPTY_OVERLAY };
}

function flushOverlayRound(): Partial<MainState> {
  return flushOverlayInto(state.overlay, state.liveText) ?? {};
}

// Fold a `tool-progress` event into the live tool-card list, building a minimal
// TimelineToolPart the ToolCard component can render (it derives title/icon from
// `name` and reads `detail[0]`). Upserts by tool-call id so a "running" card
// becomes "completed"/"failed" in place; createdAt is preserved across updates
// so the elapsed meta is stable.
function upsertLiveTool(current: TimelineToolPart[], ev: LiveToolEvent): TimelineToolPart[] {
  const status: ToolCallStatus = ev.status ?? "running";
  const nowIso = new Date().toISOString();
  const existing = current.find((t) => t.id === ev.id);
  const createdAt = existing?.createdAt ?? nowIso;
  const completedAt = status === "running" ? undefined : existing?.completedAt ?? nowIso;

  // run_shell's card reads the command off detail.input.command — fold the
  // event's separate `command` field in when the input doesn't carry it.
  let input = ev.input ?? existing?.detail[0]?.input;
  if (ev.command && (!input || typeof input !== "object" || !("command" in (input as object)))) {
    input = { ...(input && typeof input === "object" ? (input as object) : {}), command: ev.command };
  }

  const detail: TimelineToolDetail = {
    id: ev.id,
    name: ev.name,
    status,
    summary: ev.message ?? existing?.detail[0]?.summary ?? "",
    input,
    output: ev.output ?? existing?.detail[0]?.output,
    error: status === "failed" ? ev.message ?? ev.output ?? existing?.detail[0]?.error : undefined,
    createdAt,
    completedAt,
  };
  const part: TimelineToolPart = {
    id: ev.id,
    type: "tool",
    name: ev.name,
    status,
    title: "",
    summary: ev.message ?? "",
    count: 1,
    callIds: [ev.id],
    createdAt,
    completedAt,
    detail: [detail],
  };
  return existing ? current.map((t) => (t.id === ev.id ? part : t)) : [...current, part];
}

function handleModelStream(sub: { type: string; text?: string; question?: PendingQuestionItem; usage?: unknown }): void {
  switch (sub.type) {
    case "text-delta":
      if (sub.text) set({ overlay: { ...state.overlay, assistantText: state.overlay.assistantText + sub.text } });
      return;
    case "reasoning-delta":
      if (sub.text) set({ overlay: { ...state.overlay, reasoning: state.overlay.reasoning + sub.text } });
      return;
    case "tool-progress": {
      // Live tool card. The host only commits a session_snapshot at turn END,
      // so without folding these in, tool cards wouldn't appear until the turn
      // finishes / is stopped. Mirror legacy renderToolProgress: route
      // write_todos to the task checklist (taskStore), everything else to a
      // live chat card keyed by tool-call id.
      const ev = sub as unknown as {
        id?: string;
        name?: string;
        status?: ToolCallStatus;
        input?: unknown;
        command?: string;
        message?: string;
        output?: string;
      };
      if (!ev.id || !ev.name || ev.name === "write_todos") return;
      // A tool call ends the current text round: flush whatever assistant text
      // streamed into `overlay` so far into `liveText` (an ordered, static round)
      // BEFORE adding the tool card. This keeps the tool below its round's text
      // and lets the NEXT round's deltas start a fresh overlay below the tool —
      // mirroring legacy's "text-delta after a tool opens a new entry". Without
      // it the final summary renders above the tools that produced it.
      set({ ...flushOverlayRound(), liveTools: upsertLiveTool(state.liveTools, ev as LiveToolEvent) });
      return;
    }
    case "background-error": {
      // Engine-side background failure (engine.reportBackgroundError). Only the
      // `rollout` category gets the error banner — a dropped rollout write means
      // the transcript is silently NOT being persisted (deferred materialization
      // moved open/mkdir failures out of the loud create_session path, so this
      // stream event is the only user-visible signal left). Other categories
      // (title, notes, store.persist…) are routine background noise: console only.
      const ev = sub as unknown as { category?: string; message?: string };
      console.error(`[background:${ev.category ?? "?"}] ${ev.message ?? ""}`);
      if (ev.category === "rollout") {
        set({ error: `Session persistence failed — the transcript is NOT being saved: ${ev.message ?? "unknown error"}` });
      }
      return;
    }
    case "usage-updated":
      // Mid-turn authoritative usage push (mirror legacy applyUsageUpdate): merge
      // onto the active snapshot so the composer usage ring tracks the engine
      // without waiting for the end-of-turn session_snapshot.
      if (sub.usage && state.activeSession) {
        set({ activeSession: { ...state.activeSession, usage: sub.usage } as SessionSnapshot });
      }
      return;
    case "question-request": {
      // Real-time HITL question bubbled from a subagent worker — route it into
      // the same dock (mirrors legacy agent-events.js). Answering forwards down.
      const q = sub.question;
      if (q && q.id) {
        set({
          working: false,
          status: "waiting answer",
          pendingQuestions: [...state.pendingQuestions.filter((p) => p.id !== q.id), q],
          // Pause the elapsed clock while the prompt is open (banked on
          // resume) — same as the top-level question_request handler, or a
          // subagent's question silently counts the user's deliberation.
          turnPauseStartedAt: pauseStamp(state.turnStartedAt, state.turnPauseStartedAt),
        });
      }
      return;
    }
    case "stream-reset":
      // A dropped stream is re-issued whole (Codex model). Discard the partial we
      // streamed so the retry's fresh deltas replace it instead of appending.
      set({ overlay: EMPTY_OVERLAY });
      return;
    case "user-message": {
      // The engine drained a queued steer at a clean loop boundary — this is the
      // codex "断一下" pause. Render it the way codex does:
      //   1. flushOverlayRound() commits the partial assistant text streamed so
      //      far as a finished live round (the text the user interrupted), and
      //   2. the steer is inserted INLINE into the live stream as a user bubble,
      //      stamped just after that round so it sorts BELOW the interrupted text
      //      and ABOVE the continuation (the next deltas form a fresh overlay).
      // It must be a liveText part, NOT a steerBubble: steerBubbles render above
      // the whole live block, which would put the steer above the text it follows.
      const steerText = (sub.text ?? "").trim();
      const drainedSteerId = (sub as { steerId?: string }).steerId;
      const flushed = flushOverlayRound();
      const baseLiveText = flushed.liveText ?? state.liveText;
      steerSeq += 1;
      set({
        ...flushed,
        ...(steerText
          ? {
              liveText: [
                ...baseLiveText,
                { id: `steer-${steerSeq}`, type: "text", role: "user", createdAt: new Date().toISOString(), content: steerText },
              ],
              // Remove only the FIRST matching draft, not every equal string:
              // queued drafts are bare strings, so a value-based filter would
              // also delete an unrelated, never-submitted duplicate ("continue"
              // twice).
              queuedMessages: dropFirstEqual(state.queuedMessages, steerText),
              // It just landed inline — drop it from the "waiting" pending list.
              // The drain event carries the steer's id, so this removes exactly
              // the row that landed; text is the fallback for id-less steers.
              pendingSteers: dropFirstSteer(state.pendingSteers, drainedSteerId, steerText),
            }
          : {}),
      });
      return;
    }
    case "self-evolve-review": {
      // A background self-evolve review folded learnings into global memory /
      // skills. Surface it as a persistent transcript notice anchored at the
      // moment it ran — it stays at that point as later turns append below,
      // instead of trailing the whole transcript forever. The summary is
      // already Chinese/neutral from summarizeSelfReview.
      const summary = (sub as { summary?: string }).summary?.trim();
      if (!summary) return;
      const at = (sub as { at?: string }).at ?? new Date().toISOString();
      upsertAnchoredNotice({ id: `se-${at}`, at, kind: "memory", text: `💾 ${summary}` });
      return;
    }
    case "context-compaction-started": {
      const auto = (sub as { compactType?: string }).compactType === "auto";
      set({
        status: "compacting",
        compaction: { phase: "running", label: auto ? "Auto-compacting context…" : "Compacting context…" },
      });
      return;
    }
    case "context-compacted": {
      // Compaction finished (manual /compact OR auto). Resolve the pulsing tail
      // divider into a boundary notice ANCHORED at the compaction's timestamp —
      // without this the multi-second summary call is silent, and without the
      // anchor the settled divider would trail the transcript instead of
      // marking where the history was folded.
      const b = (sub as { boundary?: { id?: string; createdAt?: string; messagesCompacted?: number; estimatedTokensAfter?: number } }).boundary ?? {};
      const at = b.createdAt ?? new Date().toISOString();
      set({
        status: state.working ? "working" : "idle",
        compaction: null,
      });
      upsertAnchoredNotice({
        id: `cb-${b.id ?? at}`,
        at,
        kind: "compaction",
        text: compactedLabel(b.messagesCompacted, b.estimatedTokensAfter),
      });
      return;
    }
    case "context-compaction-failed": {
      const err = (sub as { error?: string }).error ?? "?";
      set({
        status: state.working ? "working" : "idle",
        compaction: { phase: "settled", label: `Compaction failed: ${err}` },
      });
      return;
    }
    case "subagent-event": {
      // Live activity from an async-task child — buffer it under its taskId so the
      // main window shows what the subagent is doing (mirror renderSubagentEvent).
      const ev = sub as { taskId?: string; event?: { type?: string; text?: string; id?: string; name?: string; input?: unknown; status?: string; reason?: string } };
      if (ev.taskId && ev.event) {
        set({ subagentActivity: applySubagentEvent(state.subagentActivity, ev.taskId, ev.event) });
      }
      return;
    }
    case "async-task-updated":
    case "async-task-injected": {
      // Roster ping from the subagent manager (fires for sync `task` dispatches
      // too — the manager registers a sync:true record up-front). The chips row
      // uses it to resolve taskId (live-activity attach) and to keep showing an
      // async child as running after its dispatch tool card settled.
      set({ asyncTaskIndex: upsertAsyncTaskLite(state.asyncTaskIndex, (sub as { task?: unknown }).task) });
      return;
    }
    case "async-task-evicted-batch": {
      const tasks = (sub as { tasks?: unknown[] }).tasks;
      if (Array.isArray(tasks)) {
        let index = state.asyncTaskIndex;
        for (const t of tasks) index = upsertAsyncTaskLite(index, t);
        set({ asyncTaskIndex: index });
      }
      return;
    }
    default:
      return;
  }
}

let steerSeq = 0;

// Fold one child event into a task's subagent activity (mirror legacy
// appendSubagentRow): text/reasoning accumulate into rolling tails; each child
// tool call gets one row (updated in place on status change); loop notices append.
function applySubagentEvent(
  current: Record<string, SubagentActivity>,
  taskId: string,
  ev: { type?: string; text?: string; id?: string; name?: string; input?: unknown; status?: string; reason?: string },
): Record<string, SubagentActivity> {
  const prev = current[taskId] ?? { text: "", reasoning: "", tools: [], misc: [], count: 0 };
  const next: SubagentActivity = { ...prev, tools: [...prev.tools], misc: [...prev.misc] };
  if (ev.type === "text-delta") {
    next.text = (next.text + (ev.text ?? "")).slice(-240);
  } else if (ev.type === "reasoning-delta") {
    next.reasoning = (next.reasoning + (ev.text ?? "")).slice(-200);
  } else if (ev.type === "tool-progress") {
    const key = `tool-${ev.id || ev.name}`;
    const row = { key, name: ev.name ?? "", target: subagentToolTarget(ev.input), status: ev.status ?? "running" };
    const idx = next.tools.findIndex((t) => t.key === key);
    if (idx >= 0) next.tools[idx] = row;
    else next.tools.push(row);
  } else if (ev.type === "loop-limit" || ev.type === "loop-repair") {
    next.misc.push(`⚠ ${ev.type}: ${ev.reason ?? ""}`);
  } else {
    return current; // ignore other child event types
  }
  next.count = next.tools.length + next.misc.length + (next.text ? 1 : 0) + (next.reasoning ? 1 : 0);
  return { ...current, [taskId]: next };
}

function subagentToolTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  return String(i.path ?? i.command ?? i.pattern ?? i.url ?? i.taskId ?? "").slice(0, 60);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
