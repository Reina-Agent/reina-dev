import path from "node:path";
import { statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { AgentEngine, SessionStore, loadMcpResidencyPolicy, migrateWorkspaceJsonl, type CreateSessionInput } from "@reina/core";
import type { AgentRunResult, MessageAttachment, UserGoalCommand } from "@reina/protocol";
import { errorMessage } from "@reina/protocol";
import type { DesktopEvent, DesktopRequest, DesktopResponse, TurnSource } from "@reina/desktop-protocol";
import {
  closeMcpClients,
  downsampleOversizedImageAttachment,
  getBackgroundShellTaskSnapshot,
  getMcpStatusForCwd,
  isServerEnabled,
  listBackgroundShellTaskRecords,
  listMcpToolDefs,
  loadMcpServerSources,
  loadMcpServers,
  resolveMcpServer,
  stopBackgroundShellTask,
  type McpServerSource,
} from "@reina/tools";

export type AgentHostSend = (message: DesktopEvent | DesktopResponse) => void;

type HostSession = {
  engine: AgentEngine;
  active: boolean;
  turnPromise: Promise<void> | null;
  lastCompletionWakeRevision?: number;
  activeSettled?: Promise<void>;
  resolveActiveSettled?: () => void;
  interrupting: boolean;
  // Wall-clock start of the current active work span (set in markActive,
  // cleared in markInactive). Surfaced to renderers so the "thinking" spinner's
  // elapsed counter reflects the real turn duration and stays continuous when
  // the user switches away from and back to a running session.
  turnStartedAt?: number;
  queuedAfterInterrupt: PendingTurn[];
  /** First-message title currently eligible for replacement by the slower
   * model-generated title. Kept outside SessionState so a manual rename remains
   * distinguishable from the optimistic placeholder during this host lifetime. */
  provisionalTitle?: string;
  unsubscribe: () => void;
};

type PendingTurn = {
  message: string;
  attachments?: MessageAttachment[];
  reminders?: string[];
  source?: TurnSource;
};

type BridgePending = {
  resolve(data: unknown): void;
  reject(err: Error): void;
  sessionId?: string;
};

/** Synthetic user prompt used to wake an idle session when a background
 * task settles. The actual result rides in the `<task-notification>` that
 * `runTurn` injects ahead of this prompt (see
 * `AgentEngine.injectCompletionNotifications`); this is just the
 * continuation cue, mirroring the autopilot round-1+ cue and
 * `schedule_wakeup`'s synthetic message. Works for single-agent and team
 * mode alike — a woken coordinator advances the DAG. */
const BACKGROUND_COMPLETION_WAKE_PROMPT =
  "A background task you dispatched finished while you were idle — its result is in the task-notification above. Pick up where you left off: act on the result, dispatch any now-unblocked follow-up work, or finish if nothing remains.";

// The goal-continuation cue itself is built per-round by
// `engine.goalContinuationPrompt()` (objective + live budget + audit
// discipline, mirroring codex's goals/continuation.md steering item). It is
// model-only (`ephemeral`), so the dynamic content never bloats the visible
// transcript or the compaction summary.

export class AgentHost {
  private readonly sessions = new Map<string, HostSession>();
  /** One SessionStore per workspace cwd. Opened lazily when an engine is
   * created in that workspace (or explicitly via open_workspace IPC), kept
   * alive until close_workspace / AgentHost shutdown. Multiple engines in
   * the same workspace share one store. */
  private readonly stores = new Map<string, SessionStore>();
  private nextBridgeId = 1;
  private readonly bridgePending = new Map<string, BridgePending>();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly closingSessionIds = new Set<string>();

  constructor(private readonly send: AgentHostSend) {}

  private callHost(kind: string, params: unknown, sessionId?: string): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Agent host shutting down."));
    if (sessionId !== undefined && this.closingSessionIds.has(sessionId)) {
      return Promise.reject(new Error("Agent session closing."));
    }
    const id = `host-${this.nextBridgeId++}`;
    return new Promise((resolve, reject) => {
      this.bridgePending.set(id, { resolve, reject, sessionId });
      this.send({ type: "host_request", id, kind, params, sessionId });
    });
  }

  private async createEngine(input: Partial<CreateSessionInput>): Promise<AgentEngine> {
    const engineRef: { current?: AgentEngine } = {};
    const engine = await AgentEngine.create({
      ...input,
      hostBridge: (kind, params) => this.callHost(kind, params, engineRef.current?.session.id),
    });
    engineRef.current = engine;
    return engine;
  }

  private resolveHostResponse(hostRequestId: string, success: boolean, data: unknown, error: string | undefined): void {
    const pending = this.bridgePending.get(hostRequestId);
    if (!pending) return;
    this.bridgePending.delete(hostRequestId);
    if (success) pending.resolve(data);
    else pending.reject(new Error(error ?? "host_response missing error"));
  }

  private rejectBridgePending(error: Error, sessionId?: string): void {
    for (const [id, pending] of this.bridgePending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      this.bridgePending.delete(id);
      pending.reject(error);
    }
  }

  /** Inject a synthetic user message into a live session. Used by the main
   * process when a `schedule_wakeup` timer fires — the wakeup needs to
   * reach the same engine that scheduled it, but the renderer/main side
   * doesn't speak engine-internals, so it round-trips through the AgentHost.
   * Returns true when the session is currently registered; false otherwise. */
  triggerWakeup(sessionId: string, message: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.startTurn(sessionId, message, undefined, undefined, "scheduled_wakeup");
    return true;
  }

  async handle(request: DesktopRequest): Promise<DesktopResponse | void> {
    try {
      switch (request.type) {
        case "refresh_session_settings": {
          const session = this.requireSession(request.sessionId);
          // Active sessions already refresh at request/action boundaries.
          // Avoid mutating the model while an outgoing request is in flight.
          if (!session.active) await session.engine.refreshRuntimeConfig();
          this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
          return ok(request, { applied: !session.active });
        }
        case "patch_agent_settings": {
          if (!request.sessionId) return ok(request, { applied: true });
          const session = this.requireSession(request.sessionId);
          const { effort, ...patch } = request.patch;
          session.engine.updateConfig({
            ...patch,
            ...(effort !== undefined ? { model: { ...session.engine.session.model, reasoningEffort: effort } } : {}),
          });
          this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
          return ok(request, { applied: true });
        }
        case "update_compaction_settings": {
          const settings = request.settings;
          process.env.REINA_COMPACTION_AUTO = settings.compactionAuto ? "1" : "0";
          process.env.REINA_COMPACTION_OFFLOAD = settings.compactionOffload ? "1" : "0";
          if (settings.compactionTriggerPercent === 0) delete process.env.REINA_COMPACTION_TRIGGER_PERCENT;
          else process.env.REINA_COMPACTION_TRIGGER_PERCENT = String(settings.compactionTriggerPercent);
          process.env.REINA_COMPACTION_BUFFER_TOKENS = String(settings.compactionBufferTokens);
          process.env.REINA_COMPACTION_KEEP_RECENT = String(settings.compactionKeepRecent);
          return ok(request, { applied: true });
        }
        case "update_subagent_concurrency":
          process.env.REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS = String(request.concurrency);
          return ok(request, { applied: true });
        case "create_session":
          return await this.createSession(request);
        case "send_message":
          // Normalize pasted/dragged images BEFORE the turn starts: an
          // oversized paste (4K screenshot) is downsampled here the same way
          // read_file downsamples on-disk images, so full-resolution base64
          // never reaches the model request, the rollout log, or session
          // snapshots. One choke point covers fresh turns, steers, and the
          // queued-after-interrupt path (all flow through startTurn below).
          this.startTurn(
            request.sessionId,
            request.message,
            await normalizeIncomingAttachments(request.attachments),
            request.reminders,
            "user",
            request.intent ?? "fresh",
            request.steerId,
          );
          return ok(request, { accepted: true });
        case "update_session_config":
          return this.updateSessionConfig(request);
        case "approve_tool":
          this.approveTool(request);
          return ok(request, { accepted: true });
        case "answer_question":
          this.answerQuestion(request);
          return ok(request, { accepted: true });
        case "answer_question_group":
          this.answerQuestionGroup(request);
          return ok(request, { accepted: true });
        case "interrupt":
          this.interrupt(request.sessionId);
          return ok(request, { accepted: true });
        case "side_chat":
          return this.sideChat(request);
        case "retract_steer":
          return ok(request, {
            retracted: this.requireSession(request.sessionId).engine.retractSteer({
              steerId: request.steerId,
              message: request.message,
            }),
          });
        case "goal_command":
          return this.goalCommand(request);
        case "compact_session":
          return await this.compactSession(request);
        case "rollback_session":
          return await this.rollbackSession(request);
        case "fork_session":
          return await this.forkSession(request);
        case "delete_message":
          return await this.deleteMessage(request);
        case "cancel_async_task_external":
          this.cancelAsyncTaskExternal(request.sessionId, request.taskId);
          return ok(request, { accepted: true });
        case "update_async_task_external": {
          const session = this.requireSession(request.sessionId);
          const observation = session.engine.updateAsyncTaskExternal(request.taskId, request.message);
          if (observation.error) return fail(request, observation.error);
          this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
          return ok(request, observation);
        }
        case "save_session":
          return await this.saveSession(request);
        case "get_context_history":
          return ok(request, await this.requireSession(request.sessionId).engine.getContextHistory(request.taskId));
        case "get_context_request":
          return ok(request, await this.requireSession(request.sessionId).engine.getContextRequest(request.requestId, request.taskId));
        case "list_sessions":
          return await this.listSessions(request);
        case "load_session":
          return await this.loadSession(request);
        case "close_session":
          return await this.closeSession(request);
        case "list_workspaces":
          return this.listWorkspaces(request);
        case "open_workspace":
          return this.openWorkspace(request);
        case "close_workspace":
          return this.closeWorkspace(request);
        case "remove_workspace":
          return await this.removeWorkspace(request);
        case "list_workspace_sessions":
          return this.listWorkspaceSessions(request);
        case "search_workspace_messages":
          return this.searchWorkspaceMessages(request);
        case "delete_workspace_session":
          return this.deleteWorkspaceSession(request);
        case "rename_workspace_session":
          return this.renameWorkspaceSession(request);
        case "list_background_shell_tasks":
          return ok(request, { tasks: await listBackgroundShellTaskRecords(request.cwd) });
        case "get_background_shell_task_output":
          return ok(request, await getBackgroundShellTaskSnapshot(request.cwd, request.taskId));
        case "stop_background_shell_task":
          return ok(request, { task: await stopBackgroundShellTask(request.cwd, request.taskId) });
        case "list_mcp_status":
          return await this.listMcpStatus(request);
        case "shutdown":
          await this.close();
          return ok(request, { accepted: true });
        case "host_response":
          this.resolveHostResponse(request.hostRequestId, request.success, request.data, request.error);
          return ok(request, { accepted: true });
      }
    } catch (error) {
      return fail(request, errorMessage(error));
    }
  }

  /** Get or create the SessionStore for a workspace cwd. The store is
   * cached by canonical absolute path; subsequent opens of the same
   * workspace reuse the connection. The first open of a workspace also
   * runs a JSONL → SQLite import for any legacy session files left under
   * `.reina/sessions/`. The migration runs in the background; the store
   * is usable immediately. */
  private storeFor(cwd: string): SessionStore {
    const canonical = resolveWorkspaceDirectory(cwd);
    const existing = this.stores.get(canonical);
    if (existing) return existing;
    const store = SessionStore.open(canonical);
    store.setWorkspaceMeta("last_opened_at", new Date().toISOString());
    this.stores.set(canonical, store);
    // Best-effort migration of any old JSONL sessions in this workspace.
    // Runs in the background so opening a workspace is never blocked by
    // history scans. Imported sessions show up in the sidebar within
    // ~hundreds of ms of the workspace opening.
    void migrateWorkspaceJsonl(canonical, store).catch(() => {
      // Migration errors are individual-file scoped (the helper catches
      // them per-file). A top-level reject means the readdir itself
      // failed, which we can safely swallow — `migrateWorkspaceJsonl`
      // already treats missing directories as "nothing to migrate".
    });
    return store;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    // Snapshot the settle promises up front (they're cleared the moment a
    // turn settles). turnPromise covers startTurn-driven turns; activeSettled
    // additionally covers approval/answer-resumed loops (approveTool /
    // answerQuestion drive continueLoop without ever setting turnPromise).
    const settles = sessions.map((session) => session.turnPromise ?? session.activeSettled);
    for (const session of sessions) {
      session.unsubscribe();
      if (session.turnPromise || session.active) session.engine.interrupt();
    }
    // Reject outstanding host bridge calls before waiting for turns: a turn may
    // itself be blocked on one of these promises and cannot settle otherwise.
    this.rejectBridgePending(new Error("Agent host shutting down."));
    await Promise.all(settles.map((settled) => settled?.catch(() => undefined)));
    // Quiesce the engines' background work (notes-service init writes,
    // rollout recorder stream) so shutdown leaves no dangling writers
    // racing whatever touches the directories next.
    await Promise.all(sessions.map((session) => session.engine.dispose().catch(() => undefined)));
    // Close every workspace store. Idempotent — stores set a `closed` flag
    // internally so a double-close is safe.
    for (const store of this.stores.values()) {
      try {
        store.close();
      } catch {
        // Best-effort; close errors here would only delay process exit.
      }
    }
    this.stores.clear();
    // Tear down MCP child processes (and their descendants on Unix). The MCP
    // SDK only SIGTERMs the direct child, which leaves grandchildren orphaned
    // — kill the whole tree before we exit.
    await closeMcpClients().catch(() => undefined);
  }

  // ─── Workspace lifecycle handlers ──────────────────────────────────────

  private listWorkspaces(request: Extract<DesktopRequest, { type: "list_workspaces" }>): DesktopResponse {
    const cwds = [...this.stores.keys()].sort();
    const workspaces = cwds.map((cwd) => {
      const store = this.stores.get(cwd)!;
      return {
        cwd,
        name: store.getWorkspaceMeta("name") ?? path.basename(cwd),
        lastOpenedAt: store.getWorkspaceMeta("last_opened_at") ?? null,
      };
    });
    return ok(request, { workspaces });
  }

  private openWorkspace(request: Extract<DesktopRequest, { type: "open_workspace" }>): DesktopResponse {
    const store = this.storeFor(request.cwd);
    if (request.name) store.setWorkspaceMeta("name", request.name);
    return ok(request, {
      cwd: path.resolve(request.cwd),
      name: store.getWorkspaceMeta("name") ?? path.basename(request.cwd),
    });
  }

  private closeWorkspace(request: Extract<DesktopRequest, { type: "close_workspace" }>): DesktopResponse {
    const canonical = path.resolve(request.cwd);
    // Refuse to close while any session in this workspace is still loaded —
    // would orphan the engine's sessionStore reference.
    const stillLoaded = [...this.sessions.values()].some((s) => path.resolve(s.engine.session.cwd) === canonical);
    if (stillLoaded) {
      throw new Error(
        `Cannot close workspace ${canonical}: ${[...this.sessions.values()].filter((s) => path.resolve(s.engine.session.cwd) === canonical).length} session(s) still loaded. Close them first.`,
      );
    }
    const store = this.stores.get(canonical);
    if (store) {
      store.close();
      this.stores.delete(canonical);
    }
    return ok(request, { closed: Boolean(store) });
  }

  private async removeWorkspace(request: Extract<DesktopRequest, { type: "remove_workspace" }>): Promise<DesktopResponse> {
    const canonical = path.resolve(request.cwd);
    // Unlike close_workspace, removal force-closes the workspace's IDLE loaded
    // sessions (a merely-loaded session shouldn't block dropping the
    // workspace) — but still refuses while any turn is running: never yank a
    // live agent's store, let alone delete data under it.
    const loaded = [...this.sessions.entries()].filter(([, s]) => path.resolve(s.engine.session.cwd) === canonical);
    const busy = loaded.filter(([, s]) => s.turnPromise || s.active);
    if (busy.length > 0) {
      throw new Error(`Cannot remove workspace ${canonical}: ${busy.length} session(s) still working. Stop them first.`);
    }
    for (const [sessionId] of loaded) {
      await this.closeSession({ type: "close_session", sessionId });
    }
    const store = this.stores.get(canonical);
    if (store) {
      store.close();
      this.stores.delete(canonical);
    }
    // Optionally delete the workspace's on-disk Reina data. Done in THIS
    // process right after the store close so the SQLite handle is guaranteed
    // released first (Windows file locks). Only `<cwd>/.reina` — the join
    // can't resolve to the project folder itself. maxRetries absorbs
    // transient EBUSY/EPERM from AV scanners on Windows.
    let deletedData = false;
    if (request.deleteData) {
      await rm(path.join(canonical, ".reina"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      deletedData = true;
    }
    return ok(request, { closed: Boolean(store), deletedData });
  }

  // ─── SessionStore-backed query handlers ────────────────────────────────

  private listWorkspaceSessions(request: Extract<DesktopRequest, { type: "list_workspace_sessions" }>): DesktopResponse {
    const store = this.storeFor(request.cwd);
    const sessions = store.listSessions({
      includeArchived: request.includeArchived,
      includeSubagents: request.includeSubagents,
      limit: request.limit,
    });
    return ok(request, { sessions });
  }

  private searchWorkspaceMessages(request: Extract<DesktopRequest, { type: "search_workspace_messages" }>): DesktopResponse {
    const store = this.storeFor(request.cwd);
    const hits = store.searchMessages(request.query, request.limit ?? 50);
    return ok(request, { hits });
  }

  private deleteWorkspaceSession(request: Extract<DesktopRequest, { type: "delete_workspace_session" }>): DesktopResponse {
    // If the session is hot, drop the engine first so its sessionStore
    // reference doesn't try to flush a phantom session after we delete.
    const live = this.sessions.get(request.savedSessionId);
    if (live) {
      live.engine.interrupt();
      live.unsubscribe();
      this.sessions.delete(request.savedSessionId);
      // Same unblock closeSession does: a turn parked on a hostBridge call
      // can't observe the interrupt — reject its pending bridge promises so
      // the turn can settle, then quiesce the engine's writers off-path
      // (deletion stays synchronous; nothing here awaits the turn).
      this.rejectBridgePending(new Error("Agent session closing."), request.savedSessionId);
      const settled = live.turnPromise ?? live.activeSettled;
      void (settled ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => live.engine.dispose().catch(() => undefined));
    }
    const store = this.storeFor(request.cwd);
    store.deleteSession(request.savedSessionId);
    return ok(request, { deleted: true });
  }

  private renameWorkspaceSession(request: Extract<DesktopRequest, { type: "rename_workspace_session" }>): DesktopResponse {
    const live = this.sessions.get(request.savedSessionId);
    if (live) {
      // Hot path: update the engine; its setTitle flushes the store too.
      live.provisionalTitle = undefined;
      live.engine.setTitle(request.title);
      this.send({ type: "session_snapshot", sessionId: request.savedSessionId, session: live.engine.session });
    } else {
      // Cold path: bypass the engine and update the store row directly.
      const store = this.storeFor(request.cwd);
      store.renameSession(request.savedSessionId, request.title.trim().slice(0, 120), new Date().toISOString());
    }
    return ok(request, { renamed: true });
  }

  private async listMcpStatus(request: Extract<DesktopRequest, { type: "list_mcp_status" }>): Promise<DesktopResponse> {
    const configs = await loadMcpServers(request.cwd).catch(() => ({}));
    const sources = await loadMcpServerSources(request.cwd).catch((): Record<string, McpServerSource> => ({}));
    // Residency policy lives in reina.json (not the portable mcp.json) so
    // the UI can render the "Resident vs Deferred" toggle without re-reading
    // the engine config on every render. Empty set when no config / parse
    // failure (loader swallows errors).
    const residencyPolicy = await loadMcpResidencyPolicy(request.cwd).catch(() => ({ deferredServers: new Set<string>() }));
    const toolEntries = await Promise.all(
      Object.entries(configs).map(async ([name, config]) => {
        const enabled = isServerEnabled(config);
        const disabledTools = new Set(config.disabledTools ?? []);
        const source = sources[name];
        const deferred = residencyPolicy.deferredServers.has(name);
        if (!enabled) return [name, { enabled, deferred, status: "disabled", tools: [], source }] as const;
        const probe = await Promise.race([
          listMcpToolDefs(name, resolveMcpServer(request.cwd, name, configs)).then((defs) => ({ status: "connected" as const, defs })),
          new Promise<{ status: "timeout"; error: string; defs: [] }>(resolve => setTimeout(() => resolve({ status: "timeout", error: "MCP list_tools probe timed out after 2500ms", defs: [] }), 2500)),
        ]).catch((error) => ({ status: "failed" as const, error: errorMessage(error), defs: [] }));
        const tools = probe.defs.map((def) => ({
          name: def.name,
          description: def.description ?? "",
          enabled: !disabledTools.has(def.name),
        }));
        return [name, { enabled, deferred, status: probe.status, error: "error" in probe ? probe.error : undefined, tools, checked: true, source }] as const;
      }),
    );
    const status = await getMcpStatusForCwd(request.cwd);
    const servers = Object.fromEntries(
      toolEntries.map(([name, entry]) => [name, { ...(status[name] ?? { status: entry.status }), ...entry }]),
    );
    return ok(request, { servers });
  }

  private async createSession(request: Extract<DesktopRequest, { type: "create_session" }>): Promise<DesktopResponse> {
    const sessionStore = this.storeFor(request.cwd);
    const input: Partial<CreateSessionInput> = {
      cwd: request.cwd,
      agent: request.agent,
      permissionMode: request.permissionMode,
      model: request.model as CreateSessionInput["model"],
      outputStyle: request.outputStyle,
      outputStyleCustom: request.outputStyleCustom,
      toolLoop: request.toolLoop,
      hooks: request.hooks,
      sessionStore,
    };
    const engine = await this.createEngine(input);
    this.registerEngine(engine);
    // Seed the store with the brand-new session row so the sidebar sees it
    // before any turn has run. Without this, a session you create and
    // immediately switch away from wouldn't appear in the workspace list.
    sessionStore.upsertSession(engine.session);
    this.send({ type: "session_created", sessionId: engine.session.id, session: engine.session });
    return ok(request, { sessionId: engine.session.id, session: engine.session });
  }

  private startTurn(
    sessionId: string,
    message: string,
    attachments?: MessageAttachment[],
    reminders?: string[],
    source: TurnSource = "user",
    intent: "fresh" | "steer" = "fresh",
    steerId?: string,
  ): void {
    const session = this.requireSession(sessionId);
    if (session.active) {
      // Explicit steer (slash directives like `/verify`, `/team`): inject into
      // the running turn so the engine picks it up at the next loop boundary.
      // The renderer has already rendered the user bubble client-side. Honored
      // only for a normally-running turn — once an interrupt is in flight we
      // always queue so the restart is one clean fresh turn.
      if (intent === "steer" && !session.interrupting) {
        session.engine.injectSteer(message, attachments, reminders, steerId);
        return;
      }
      // Default ("fresh"), or anything arriving mid-interrupt: queue to run as
      // its OWN turn once the current one settles (the turn's `finally` drains
      // this regardless of how it ended). The renderer keeps fresh user
      // messages local while busy, so reaching here with intent "fresh" means a
      // race — the host turn was still active when the renderer thought it was
      // idle. The safe resolution is "run next", never silently steer the
      // model mid-output. This is the single authoritative guard; no renderer
      // mis-detection can turn a typed message into a steer.
      session.queuedAfterInterrupt.push({ message, attachments, reminders, source });
      return;
    }
    // Codex-style optimistic naming: make the task identifiable as soon as its
    // first real user turn is accepted, while the higher-quality model title is
    // still pending. Synthetic wake/continuation turns must never name a task.
    if (source === "user") {
      const expectedTitle = session.engine.session.title;
      const provisionalTitle = session.engine.ensureTitleFromFirstUserMessage(message);
      if (provisionalTitle) {
        session.provisionalTitle = provisionalTitle;
        this.send({
          type: "session_title_updated",
          sessionId,
          title: provisionalTitle,
          expectedTitle,
          source: "provisional",
        });
      }
    }

    this.markActive(sessionId, session);
    this.send({ type: "turn_started", sessionId, source });
    const runOptions: { attachments?: MessageAttachment[]; reminders?: string[]; ephemeral?: boolean } = {};
    if (attachments && attachments.length > 0) runOptions.attachments = attachments;
    if (reminders && reminders.length > 0) runOptions.reminders = reminders;
    // A goal-continuation turn's synthetic cue is model-only: mark it ephemeral
    // so the engine hides it from the visible transcript (no fake user bubbles).
    if (source === "goal_continuation") runOptions.ephemeral = true;
    session.turnPromise = session.engine
      .runTurn(message, Object.keys(runOptions).length > 0 ? runOptions : undefined)
      .then((result) => {
        if (this.sessions.get(sessionId) !== session) return;
        this.emitRunResult(sessionId, result);
        this.send({ type: "turn_completed", sessionId, result, source });
      })
      .catch((error) => {
        if (this.sessions.get(sessionId) !== session) return;
        this.send({ type: "turn_failed", sessionId, error: errorMessage(error) });
      })
      .finally(() => {
        session.turnPromise = null;
        session.interrupting = false;
        this.markInactive(sessionId, session);
        const queued = mergePendingTurns(session.queuedAfterInterrupt.splice(0));
        if (this.sessions.get(sessionId) !== session) return;
        this.send({ type: "session_snapshot", sessionId, session: session.engine.session });
        // Auto-title runs in the background: it's a side request that doesn't
        // gate the turn, and any failure is swallowed by the engine. Title
        // finalization uses its own event instead of depending on snapshot timing.
        void this.maybeAutoTitle(sessionId);
        // Catch a completion arriving after the final model boundary.
        this.wakeForBackgroundCompletions(sessionId);
        // Turn-boundary goal continuation: if an active goal is still
        // unresolved and the session is idle, keep going on the user's behalf.
        // Deferred (queueMicrotask) like the wake above, so the synchronous
        // queued-user-input drain below wins the idle slot — typed input always
        // takes precedence over autonomous continuation.
        this.maybeContinueGoalIfIdle(sessionId);
        if (queued && this.sessions.get(sessionId) === session) {
          this.startTurn(sessionId, queued.message, queued.attachments, queued.reminders, queued.source);
        }
      });
  }

  /** Whether an idle session should be woken to drain settled background-task
   * completions. Pure predicate (no side effects) so the gate is unit-testable.
   * No-op cases: a turn is already running (it drains at its own boundary), or
   * autopilot owns the loop (it drains every round and `session.active` does
   * not track its turns), or nothing is actually pending. */
  private shouldWakeForCompletions(session: HostSession): boolean {
    if (session.active) return false;
    if (session.queuedAfterInterrupt.length > 0 || session.engine.hasPendingUserGate()) return false;
    // Respect an explicit stop. interrupt()/pauseAutopilot set
    // session.interrupted and it stays set until the next user-driven
    // runTurn resets it. Queued completions are NOT lost — they surface via
    // injectCompletionNotifications at the start of that next turn — we just
    // don't auto-resume on the user's behalf after they hit Stop.
    if (session.engine.session.interrupted) return false;
    if (session.engine.session.autopilot?.running) return false;
    return session.engine.hasPendingCompletionNotifications() &&
      session.lastCompletionWakeRevision !== session.engine.taskCompletionRevision();
  }

  /** Wake an idle session with a synthetic continuation turn so the engine
   * surfaces settled background-task results to the model without the
   * supervisor having to poll. Mirrors `schedule_wakeup`'s idle-wake path
   * (synthetic message -> `startTurn`), reusing the `session.active` mutex.
   * Safe to call unconditionally — the gate decides whether anything runs. */
  /** Wake an idle session to keep pursuing its active goal — the host-driven,
   * turn-boundary continuation that replaces the bolt-on autopilot loop.
   * Mirrors `wakeForBackgroundCompletions`: defer past the current stack so we
   * re-read the freshest state, re-check the gate, and fire ONE bounded
   * continuation turn. `engine.maybeAdvanceGoalRuntime` owns the whole
   * goal-side decision + round bookkeeping; the host only supplies the idle
   * mutex (`session.active`) and whether a user message is queued. The
   * `session.active` set by any turn we (or the queued-input drain) start makes
   * the other deferred wakers no-op, so they serialize for free. */
  private maybeContinueGoalIfIdle(sessionId: string): void {
    queueMicrotask(() => {
      void (async () => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        if (session.active) return;
        const advance = await session.engine.maybeAdvanceGoalRuntime({
          hasQueuedInput: session.queuedAfterInterrupt.length > 0,
        });
        if (!advance) return;
        // The completion judge awaited above can take seconds — a typed user
        // turn (or the queued-input drain) may have claimed the idle slot
        // meanwhile. Never race it: the reopened goal re-arms at that turn's
        // own boundary.
        if (this.sessions.get(sessionId) !== session || session.active) return;
        this.startTurn(sessionId, session.engine.goalContinuationPrompt(), undefined, undefined, "goal_continuation");
      })();
    });
  }

  private wakeForBackgroundCompletions(sessionId: string): void {
    // Defer past the current stack. The settle path emits async-task-injected
    // synchronously (mid-driveAsyncChild teardown), and the turn-completion
    // callers run inside a .finally — deferring avoids re-entering the engine
    // from within its own emit and lets us re-read the freshest gate state
    // (active/interrupted/pending) at the moment we'd actually start the turn.
    queueMicrotask(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      if (!this.shouldWakeForCompletions(session)) return;
      // A hook/provider failure can leave the same inbox pending. One automatic
      // attempt per revision prevents finally->wake from spinning indefinitely.
      session.lastCompletionWakeRevision = session.engine.taskCompletionRevision();
      this.startTurn(sessionId, BACKGROUND_COMPLETION_WAKE_PROMPT, undefined, undefined, "background_completion");
    });
  }

  private async maybeAutoTitle(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const expectedTitle = session.provisionalTitle ?? session.engine.session.title;
    const generated = await session.engine.generateAutoTitle(session.provisionalTitle);
    if (this.sessions.get(sessionId) !== session) return;
    const fallback = generated ? null : session.engine.ensureTitleFromFirstUserMessage();
    const next = generated ?? fallback;
    if (!next) return;
    if (generated) session.provisionalTitle = undefined;
    // Flush the finalized title to disk immediately. Without this the title
    // only lives in engine memory + the sidebar index until the next turn.
    await session.engine.saveSession().catch(() => undefined);
    if (this.sessions.get(sessionId) !== session) return;
    this.send({
      type: "session_title_updated",
      sessionId,
      title: next,
      expectedTitle,
      source: generated ? "generated" : "fallback",
    });
  }

  private updateSessionConfig(request: Extract<DesktopRequest, { type: "update_session_config" }>): DesktopResponse {
    const session = this.requireSession(request.sessionId);
    if (request.title !== undefined) session.provisionalTitle = undefined;
    const result = session.engine.updateConfig({
      agent: request.agent,
      model: request.model,
      permissionMode: request.permissionMode,
      outputStyle: request.outputStyle,
      outputStyleCustom: request.outputStyleCustom,
      title: request.title,
      sessionModes: request.sessionModes,
    });
    // When the title changed, flush the session JSON so a reload picks up the
    // new title from disk. Other config changes don't need an immediate save
    // because they get persisted on the next turn boundary.
    if (request.title !== undefined && result.changed.some((entry) => entry.startsWith("title"))) {
      void session.engine.saveSession().catch(() => undefined);
    }
    // Push a fresh snapshot so renderers re-render chips, system prompt is rebuilt at next turn.
    this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
    return ok(request, { changed: result.changed });
  }

  private approveTool(request: Extract<DesktopRequest, { type: "approve_tool" }>): void {
    const session = this.requireSession(request.sessionId);
    if (session.active) {
      // A bubbled approval (subagent tool gated mid-run) arrives while the
      // parent run() is still active — often blocked inside the dispatch tool
      // awaiting this very decision — so the active-guard below would
      // deadlock it. Route it straight into the engine resolver and emit no
      // turn result: resolveApproval's bubble branch only forwards the
      // verdict to the awaiting child, and the original run() emits its own
      // turn_completed once the unblocked loop ends. (Mirrors the
      // bubbled-question bypass in answerQuestion.)
      const bubbled = session.engine.session.toolCalls.find(
        (call) => call.id === request.callId && call.bubbledFromTask && call.status === "pending_approval",
      );
      if (bubbled) {
        void session.engine
          .resolveApproval(request.callId, request.approved, {
            remember: request.remember,
            updatedInput: request.updatedInput,
            reason: request.reason,
          })
          .catch((error) => {
            if (this.sessions.get(request.sessionId) !== session) return;
            this.send({ type: "turn_failed", sessionId: request.sessionId, error: errorMessage(error) });
          });
        return;
      }
      this.send({
        type: "turn_failed",
        sessionId: request.sessionId,
        error: "Cannot approve a tool while another session operation is active.",
      });
      return;
    }
    this.markActive(request.sessionId, session);
    void session.engine
      .resolveApproval(request.callId, request.approved, {
        remember: request.remember,
        updatedInput: request.updatedInput,
        reason: request.reason,
      })
      .then((result) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        session.active = false;
        this.emitRunResult(request.sessionId, result);
        this.send({ type: "turn_completed", sessionId: request.sessionId, result });
      })
      .catch((error) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "turn_failed", sessionId: request.sessionId, error: errorMessage(error) });
      })
      .finally(() => {
        this.markInactive(request.sessionId, session);
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
        // A background task may have settled while this approval/answer
        // resumed the turn (these paths drive continueLoop, which never
        // drains the injector). Now idle, wake to surface it — same gate
        // (and Stop-respecting interrupt check) as the startTurn path.
        this.wakeForBackgroundCompletions(request.sessionId);
      });
  }

  private answerQuestion(request: Extract<DesktopRequest, { type: "answer_question" }>): void {
    const session = this.requireSession(request.sessionId);
    // A bubbled question (subagent escalation) is
    // raised mid-run: the parent run() is still active and blocked inside the
    // tool awaiting this answer. Route it straight into the engine resolver —
    // skipping the active-guard — and do NOT emit a turn result. The engine
    // short-circuits via its question resolver (no continueLoop), and the
    // original run() emits its own turn_completed once the unblocked loop ends.
    const bubbled = session.engine.session.pendingQuestions.find((q) => q.id === request.questionId);
    if (bubbled?.bubbledFromTask) {
      void session.engine.answerQuestion(request.questionId, request.answer).catch((error) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "turn_failed", sessionId: request.sessionId, error: errorMessage(error) });
      });
      return;
    }
    if (session.active) {
      this.send({
        type: "turn_failed",
        sessionId: request.sessionId,
        error: "Cannot answer a question while another session operation is active.",
      });
      return;
    }
    this.markActive(request.sessionId, session);
    void session.engine
      .answerQuestion(request.questionId, request.answer)
      .then((result) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        session.active = false;
        this.emitRunResult(request.sessionId, result);
        this.send({ type: "turn_completed", sessionId: request.sessionId, result });
      })
      .catch((error) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "turn_failed", sessionId: request.sessionId, error: errorMessage(error) });
      })
      .finally(() => {
        this.markInactive(request.sessionId, session);
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
        // A background task may have settled while this approval/answer
        // resumed the turn (these paths drive continueLoop, which never
        // drains the injector). Now idle, wake to surface it — same gate
        // (and Stop-respecting interrupt check) as the startTurn path.
        this.wakeForBackgroundCompletions(request.sessionId);
      });
  }

  private answerQuestionGroup(request: Extract<DesktopRequest, { type: "answer_question_group" }>): void {
    const session = this.requireSession(request.sessionId);
    if (session.active) {
      this.send({
        type: "turn_failed",
        sessionId: request.sessionId,
        error: "Cannot answer a question while another session operation is active.",
      });
      return;
    }
    this.markActive(request.sessionId, session);
    void session.engine
      .answerQuestionGroup(request.groupId, request.answers)
      .then((result) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        session.active = false;
        this.emitRunResult(request.sessionId, result);
        this.send({ type: "turn_completed", sessionId: request.sessionId, result });
      })
      .catch((error) => {
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "turn_failed", sessionId: request.sessionId, error: errorMessage(error) });
      })
      .finally(() => {
        this.markInactive(request.sessionId, session);
        if (this.sessions.get(request.sessionId) !== session) return;
        this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
        // A background task may have settled while this approval/answer
        // resumed the turn (these paths drive continueLoop, which never
        // drains the injector). Now idle, wake to surface it — same gate
        // (and Stop-respecting interrupt check) as the startTurn path.
        this.wakeForBackgroundCompletions(request.sessionId);
      });
  }

  private goalCommand(request: Extract<DesktopRequest, { type: "goal_command" }>): DesktopResponse {
    const session = this.requireSession(request.sessionId);
    const input = request.command;
    let command: UserGoalCommand;
    if (input.type === "create" || input.type === "replace") {
      command = {
        type: input.type,
        objective: input.objective,
        ...(input.completionCriterion ? { completionCriterion: input.completionCriterion } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
        ...(
          input.tokenBudget !== undefined || input.turnBudget !== undefined || input.wallClockBudgetMs !== undefined
            ? {
                budgetLimits: {
                  ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
                  ...(input.turnBudget !== undefined ? { turnBudget: input.turnBudget } : {}),
                  ...(input.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: input.wallClockBudgetMs } : {}),
                },
              }
            : {}
        ),
      };
    } else if (input.type === "edit") {
      command = {
        type: "edit",
        goalId: input.goalId,
        objective: input.objective,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      };
    } else if (input.type === "clear") {
      command = {
        type: "clear",
        goalId: input.goalId,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      };
    } else {
      command = {
        type: input.type,
        goalId: input.goalId,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      };
    }

    const result = session.engine.executeGoalCommand(command);
    if (!result.ok) return fail(request, result.message, result.code);

    if (result.changed && (input.type === "create" || input.type === "replace")) {
      this.startTurn(
        request.sessionId,
        `/goal ${input.objective}`,
        undefined,
        undefined,
        "goal_initial",
        session.active ? "steer" : "fresh",
      );
    } else if (result.changed && (input.type === "resume" || input.type === "edit")) {
      this.maybeContinueGoalIfIdle(request.sessionId);
    }
    this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
    return ok(request, { accepted: true, changed: result.changed, state: result.state });
  }

  private interrupt(sessionId: string): void {
    const session = this.requireSession(sessionId);
    // Stop is an explicit user suspension of autonomous Goal pursuit. Record
    // that in GoalState before aborting the turn so the runtime cannot wake
    // itself again at the next idle boundary; resuming is an explicit UI
    // command. Pausing also invalidates any verifier claim in flight.
    const goal = session.engine.session.goal?.current;
    if (goal?.status === "active") {
      session.engine.executeGoalCommand({
        type: "pause",
        goalId: goal.id,
        expectedRevision: session.engine.session.goal!.revision,
      });
    }
    // Idempotency guard, but qualified by host turn state. A freshly-loaded
    // previously-interrupted session still reads engine.session.interrupted ===
    // true until runTurn clears it AFTER awaiting loadSkills; gating on the
    // engine flag ALONE would early-return there and swallow a Stop on an
    // actually-running turn (e.g. runaway autopilot). So only treat a repeat
    // interrupt as a no-op when the engine already recorded one AND no turn is
    // active/interrupting — leaving an active turn (even with a stale flag) and
    // a first interrupt on an idle session to proceed.
    if (session.engine.session.interrupted && !session.active && !session.interrupting) return;
    if (session.active) {
      session.interrupting = true;
      this.emitSessionActivity(sessionId, session);
    }
    session.engine.interrupt();
    this.send({ type: "turn_interrupted", sessionId });
    this.send({ type: "session_snapshot", sessionId, session: session.engine.session });
  }

  /** Side chat ("/btw") control — thin forwarder onto the engine's side-chat
   * subsystem. A thrown prompt error (busy / empty / subagent session) rides
   * the handle() catch back to the caller as a structured failure. */
  private sideChat(request: Extract<DesktopRequest, { type: "side_chat" }>): DesktopResponse {
    const session = this.requireSession(request.sessionId);
    switch (request.action) {
      case "prompt":
        session.engine.sideChatPrompt(request.message ?? "");
        return ok(request, { accepted: true });
      case "interrupt":
        session.engine.interruptSideChat();
        return ok(request, { accepted: true });
      case "close":
        // Fire-and-forget: teardown awaits the child's settlement, which can
        // take a moment; the caller only needs the acknowledgement.
        void session.engine.closeSideChat().catch(() => undefined);
        return ok(request, { accepted: true });
    }
  }

  /** Deterministic manual compaction (the `/compact` control op). Drives the
   * engine's compaction directly without a synthetic prompt or an extra
   * agent turn. Requires the session to be idle, mirroring
   * `rollbackSession`: if a turn is running the caller must Stop first (the
   * renderer interrupts before invoking this), and we wait for the
   * interrupted turn to settle before compacting the now-quiescent history. */
  private async compactSession(request: Extract<DesktopRequest, { type: "compact_session" }>): Promise<DesktopResponse> {
    const session = this.requireSession(request.sessionId);
    if (session.active) {
      if (!session.interrupting) throw new Error("Cannot compact while the session is running. Stop the turn first.");
      // A compaction is a stronger intent than any prompt queued after Stop:
      // drop the pending restart, wait for the interrupted turn to finish its
      // finally cleanup, then compact the idle session.
      session.queuedAfterInterrupt.splice(0);
      await session.activeSettled;
      if (this.sessions.get(request.sessionId) !== session) throw new Error(`Unknown session: ${request.sessionId}`);
    }
    if (session.active) throw new Error("Cannot compact while the session is running.");
    const boundary = await session.engine.compactNow("user requested manual compaction");
    this.send({ type: "session_snapshot", sessionId: request.sessionId, session: session.engine.session });
    return ok(request, { compacted: Boolean(boundary) });
  }

  private async rollbackSession(request: Extract<DesktopRequest, { type: "rollback_session" }>): Promise<DesktopResponse> {
    const session = this.requireSession(request.sessionId);
    if (session.active) {
      if (!session.interrupting) throw new Error("Cannot roll back while the session is running.");
      // Rollback is a stronger user intent than any prompt queued after Stop:
      // discard the pending restart, wait for the interrupted turn to finish
      // its finally cleanup, then roll back the now-idle session.
      session.queuedAfterInterrupt.splice(0);
      await session.activeSettled;
      if (this.sessions.get(request.sessionId) !== session) throw new Error(`Unknown session: ${request.sessionId}`);
    }
    if (session.active) throw new Error("Cannot roll back while the session is running.");
    const result = await session.engine.rollbackToMessage(request.messageId);
    this.send({ type: "session_snapshot", sessionId: request.sessionId, session: result.session });
    return ok(request, result);
  }

  /** Non-destructive branch (assistant menu "创建分支"). Forks the source
   * session up to and including the clicked message into a new persisted
   * session, loads it into a fresh engine, and returns its snapshot so the
   * renderer can switch to the branch. The source session is untouched, so —
   * unlike rollback/delete — this is safe to run while a turn is active. */
  private async forkSession(request: Extract<DesktopRequest, { type: "fork_session" }>): Promise<DesktopResponse> {
    const session = this.requireSession(request.sessionId);
    const forked = await session.engine.forkToMessage(request.messageId, { inclusive: request.inclusive });
    const sessionStore = this.storeFor(forked.cwd);
    const engine = await this.createEngine({ cwd: forked.cwd, sessionStore });
    await engine.loadSession(forked.id);
    this.registerEngine(engine, "fork");
    sessionStore.upsertSession(engine.session);
    this.send({ type: "session_created", sessionId: engine.session.id, session: engine.session });
    return ok(request, { sessionId: engine.session.id, session: engine.session });
  }

  /** Truncate-from-here (assistant menu "删除消息"). Deletes the clicked message
   * and everything after it. Like rollback, the engine rejects this while a turn
   * is active, so interrupt + settle first when needed. */
  private async deleteMessage(request: Extract<DesktopRequest, { type: "delete_message" }>): Promise<DesktopResponse> {
    const session = this.requireSession(request.sessionId);
    if (session.active) {
      if (!session.interrupting) throw new Error("Cannot delete a message while the session is running.");
      session.queuedAfterInterrupt.splice(0);
      await session.activeSettled;
      if (this.sessions.get(request.sessionId) !== session) throw new Error(`Unknown session: ${request.sessionId}`);
    }
    if (session.active) throw new Error("Cannot delete a message while the session is running.");
    const result = await session.engine.deleteFromMessage(request.messageId);
    this.send({ type: "session_snapshot", sessionId: request.sessionId, session: result.session });
    return ok(request, result);
  }

  /** Forwarded from the renderer's Agent Team panel. Reaches the engine's
   * external-cancel hook and re-emits a session snapshot so the UI roster
   * updates promptly (the AsyncTaskRecord status flip happens in the
   * driveAsyncChild observer a tick or two later — we send the snapshot
   * proactively so the user gets immediate feedback). */
  private cancelAsyncTaskExternal(sessionId: string, taskId: string): void {
    const session = this.requireSession(sessionId);
    session.engine.cancelAsyncTaskExternal(taskId);
    this.send({ type: "session_snapshot", sessionId, session: session.engine.session });
  }

  private async saveSession(request: Extract<DesktopRequest, { type: "save_session" }>): Promise<DesktopResponse> {
    const session = this.requireSession(request.sessionId);
    const path = await session.engine.saveSession();
    return ok(request, { path });
  }

  private async listSessions(request: Extract<DesktopRequest, { type: "list_sessions" }>): Promise<DesktopResponse> {
    const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    if (session) return ok(request, { sessions: await session.engine.listSessions() });
    if (!request.cwd) return ok(request, { sessions: [] });
    // Cold path: read the sessions directory directly (same source
    // engine.listSessions reads). Constructing a throwaway engine here would
    // mint a ghost session + rollout file and leave a recorder stream and
    // notes writers the host never disposes.
    const sessions = await readdir(path.join(request.cwd, ".reina", "sessions")).catch(() => [] as string[]);
    return ok(request, { sessions });
  }

  private async loadSession(request: Extract<DesktopRequest, { type: "load_session" }>): Promise<DesktopResponse> {
    // Warm switch: if the saved session is already loaded in memory (running or
    // idle), just rebroadcast its snapshot. Crucially, we do NOT touch any
    // other engine — a turn running in a different session keeps going.
    const existing = this.sessions.get(request.savedSessionId);
    if (existing) {
      this.send({
        type: "session_snapshot",
        sessionId: existing.engine.session.id,
        session: existing.engine.session,
      });
      this.emitSessionActivity(existing.engine.session.id, existing);
      // Report the live turn state so the renderer can reconcile its cached
      // `working`/`stopping` flags against ground truth instead of trusting a
      // stale guess (a dropped terminal event would otherwise leave a phantom
      // spinner on switch). `active` is flipped off in runTurn's `finally`
      // regardless of whether turn_completed/turn_failed reached the renderer.
      return ok(request, {
        sessionId: existing.engine.session.id,
        session: existing.engine.session,
        active: existing.active,
        interrupting: existing.interrupting,
        turnStartedAt: existing.turnStartedAt,
      });
    }
    // Cold open: spin up a fresh engine bound to the saved session's workspace
    // and hydrate it from disk. `cwd` is required for the cold path; fall back
    // to a sibling engine's cwd if the caller passed legacy sessionId only.
    const fallbackCwd = request.sessionId ? this.sessions.get(request.sessionId)?.engine.session.cwd : undefined;
    const cwd = request.cwd ?? fallbackCwd;
    if (!cwd) throw new Error("load_session requires cwd when the saved session is not already loaded");
    const sessionStore = this.storeFor(cwd);
    const engine = await this.createEngine({ cwd, sessionStore });
    await engine.loadSession(request.savedSessionId);
    this.registerEngine(engine, "resume");
    this.send({
      type: "session_snapshot",
      sessionId: engine.session.id,
      session: engine.session,
    });
    this.emitSessionActivity(engine.session.id, this.requireSession(engine.session.id));
    // Freshly hydrated from disk — no turn is running yet. Report idle so the
    // renderer never resurrects a spinner from a persisted (sticky) `interrupted`
    // flag on a session that has actually finished.
    return ok(request, { sessionId: engine.session.id, session: engine.session, active: false, interrupting: false });
  }

  private async closeSession(request: Extract<DesktopRequest, { type: "close_session" }>): Promise<DesktopResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return ok(request, { closed: false });
    this.sessions.delete(request.sessionId);
    this.closingSessionIds.add(request.sessionId);
    try {
      // turnPromise covers startTurn-driven turns; activeSettled additionally
      // covers approval/answer-resumed loops (approveTool / answerQuestion
      // drive continueLoop without ever setting turnPromise).
      const settled = session.turnPromise ?? session.activeSettled;
      session.unsubscribe();
      if (session.turnPromise || session.active) session.engine.interrupt();
      this.rejectBridgePending(new Error("Agent session closing."), request.sessionId);
      await settled?.catch(() => undefined);
      session.engine.fireSessionEnd("close");
      await session.engine.dispose().catch(() => undefined);
      return ok(request, { closed: true });
    } finally {
      this.closingSessionIds.delete(request.sessionId);
    }
  }

  private registerEngine(engine: AgentEngine, source = "startup"): void {
    const unsubscribeStream = engine.onStream((event) => {
      // Real-time bubbled approval: translate to the top-level
      // permission_request the renderer already handles (dock + badge +
      // background-session attention). Not forwarded as model_stream — the
      // mirror also rides emitRunResult at turn end, and the renderer
      // dedupes permission_request by call id, so this stays idempotent.
      if (event.type === "permission-request") {
        this.send({ type: "permission_request", sessionId: engine.session.id, toolCall: event.toolCall });
        return;
      }
      this.send({ type: "model_stream", sessionId: engine.session.id, event });
    });
    const unsubscribeCompletion = engine.onTaskCompletion(() => this.wakeForBackgroundCompletions(engine.session.id));
    const unsubscribe = () => { unsubscribeStream(); unsubscribeCompletion(); };
    this.sessions.set(engine.session.id, { engine, active: false, turnPromise: null, interrupting: false, queuedAfterInterrupt: [], unsubscribe });
    // Lifecycle hook: the session is now live and listed. Source tells the hook
    // whether this was a fresh start, a fork, or a resume of a saved session.
    engine.fireSessionStart(source);
    // Recovery may have queued completions before the host subscribed.
    this.wakeForBackgroundCompletions(engine.session.id);
  }

  private requireSession(sessionId: string): HostSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private markActive(sessionId: string, session: HostSession): void {
    session.active = true;
    session.turnStartedAt = Date.now();
    this.emitSessionActivity(sessionId, session);
    if (session.activeSettled) return;
    session.activeSettled = new Promise<void>((resolve) => {
      session.resolveActiveSettled = resolve;
    });
  }

  private markInactive(sessionId: string, session: HostSession): void {
    session.active = false;
    session.turnStartedAt = undefined;
    const resolve = session.resolveActiveSettled;
    session.activeSettled = undefined;
    session.resolveActiveSettled = undefined;
    resolve?.();
    if (this.sessions.get(sessionId) === session) this.emitSessionActivity(sessionId, session);
  }

  private emitSessionActivity(sessionId: string, session: HostSession): void {
    this.send({
      type: "session_activity",
      sessionId,
      active: session.active,
      interrupting: session.interrupting,
      turnStartedAt: session.turnStartedAt,
    });
  }

  private emitRunResult(sessionId: string, result: AgentRunResult): void {
    this.send({ type: "session_snapshot", sessionId, session: result.session });
    for (const toolCall of result.pendingApprovals) {
      this.send({ type: "permission_request", sessionId, toolCall });
    }
    for (const question of result.pendingQuestions) {
      this.send({ type: "question_request", sessionId, question });
    }
  }
}

function mergePendingTurns(turns: PendingTurn[]): PendingTurn | undefined {
  if (turns.length === 0) return undefined;
  if (turns.length === 1) return turns[0];
  const attachments = turns.flatMap((turn) => turn.attachments ?? []);
  const reminders = turns.flatMap((turn) => turn.reminders ?? []);
  return {
    message: turns.map((turn) => turn.message).join("\n\n"),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reminders.length > 0 ? { reminders } : {}),
    source: turns[0]?.source ?? "user",
  };
}

function resolveWorkspaceDirectory(cwd: string): string {
  const canonical = path.resolve(cwd);
  if (isPackagedAppPath(canonical)) {
    throw new Error(`Invalid workspace directory: ${canonical}`);
  }
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(canonical);
  } catch {
    throw new Error(`Workspace is not a directory: ${canonical}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${canonical}`);
  }
  return canonical;
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

function ok(request: DesktopRequest, data?: unknown): DesktopResponse {
  return { id: request.id, type: "response", command: request.type, success: true, data };
}

/** Downsample oversized pasted images before a turn starts (see the
 * send_message handler). Best-effort per attachment — a decode failure keeps
 * the original bytes; non-image attachments pass through untouched. */
async function normalizeIncomingAttachments(
  attachments: MessageAttachment[] | undefined,
): Promise<MessageAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return attachments;
  return Promise.all(attachments.map((att) => downsampleOversizedImageAttachment(att)));
}

function fail(request: DesktopRequest, error: string, code?: string): DesktopResponse {
  return { id: request.id, type: "response", command: request.type, success: false, error, ...(code ? { code } : {}) };
}
