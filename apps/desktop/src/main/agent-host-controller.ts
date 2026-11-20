import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import {
  parseJsonLine,
  serializeJsonLine,
  type DesktopEvent,
  type DesktopRequest,
  type DesktopRequestWithout,
  type DesktopResponse,
} from "@reina/desktop-protocol";
import type { ModelStreamEvent } from "@reina/protocol";
import type { DesktopReadyData, InitState, InitStep, LogFn, PendingRequest } from "./types.js";
import { readStoreValue } from "./store.js";
import { loadDesktopState, syncSessionIndexFromSnapshot, syncSessionTitle } from "./desktop-state.js";

type AgentHostControllerInput = {
  repoRoot: string;
  hostCwd?: string;
  defaultCwd?: string;
  log: LogFn;
  /** Called when the child emits a host_request event — e.g. notify,
   * schedule_wakeup. The handler resolves with the data the
   * tool should observe; the controller wraps it in a host_response and
   * sends it back over stdin. Optional so tests can omit it. */
  onHostRequest?: (
    kind: string,
    params: unknown,
    sessionId: string | undefined,
  ) => Promise<{ success: true; data: unknown } | { success: false; error: string }>;
};

export class AgentHostController {
  private host: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly init: InitState = {
    step: { phase: "agent_waiting" },
    waiters: new Set(),
  };
  // Auto-restart bookkeeping. shuttingDown is set in shutdown() so a clean
  // exit (user quit, IPC shutdown) doesn't trigger a respawn. restartAttempts
  // tracks timestamps of recent crash-driven restarts; we give up once the
  // window fills, on the assumption that something is structurally broken
  // (missing dist, dependency conflict, repeated panic on boot).
  private shuttingDown = false;
  private restartAttempts: number[] = [];
  private static readonly RESTART_WINDOW_MS = 60_000;
  private static readonly MAX_RESTARTS_PER_WINDOW = 3;
  private static readonly SHUTDOWN_GRACE_MS = 5_000;

  constructor(private readonly input: AgentHostControllerInput) {}

  get isRunning(): boolean {
    return Boolean(this.host);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get initStep(): InitStep {
    return this.init.step;
  }

  awaitInitialization(): Promise<DesktopReadyData> | DesktopReadyData {
    if (this.ready) return this.readyData();
    return new Promise<DesktopReadyData>((resolve) => {
      this.init.waiters.add(resolve);
    });
  }

  start(): void {
    if (this.host) return;
    const hostEntry = this.resolveEntry();
    const hostCwd = this.input.hostCwd ?? this.input.repoRoot;
    this.input.log(`Starting agent host: ${hostEntry} cwd=${hostCwd}`);
    this.setInitStep({ phase: "agent_waiting" });
    this.host = spawn(process.execPath, [hostEntry], {
      cwd: hostCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...subagentConcurrencyEnv(),
        ...compactionEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.host.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.handleLine(line);
    });

    this.host.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      // Drop Node's experimental-feature warnings (e.g. node:sqlite) from the
      // log — they fire on every launch and are pure noise. Real stderr
      // diagnostics still pass through, and the renderer channel sees it all.
      const meaningful = text
        .split("\n")
        .filter((l: string) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l))
        .join("\n");
      if (meaningful.trim()) this.input.log(`agent-host stderr: ${meaningful.trimEnd()}`);
      sendRendererEvent("host-stderr", text);
    });

    this.host.once("error", (error) => {
      this.input.log(`agent-host spawn error: ${error.message}`);
      sendRendererEvent("host-exit", { code: null, signal: null, error: error.message });
    });

    this.host.once("exit", (code, signal) => {
      this.input.log(`agent-host exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.host = null;
      this.ready = false;
      for (const request of this.pending.values()) {
        request.reject(new Error(`Agent host exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
      }
      this.pending.clear();
      sendRendererEvent("host-exit", { code, signal });
      // Auto-respawn the child unless we exited because the user is quitting.
      // The renderer learns about the restart through host-restarting /
      // host-restart-gave-up events and can decide whether to retry the
      // request that just got rejected.
      if (!this.shuttingDown) {
        this.tryAutoRestart(code, signal);
      }
    });
  }

  private tryAutoRestart(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now();
    this.restartAttempts = this.restartAttempts.filter(
      (timestamp) => now - timestamp < AgentHostController.RESTART_WINDOW_MS,
    );
    if (this.restartAttempts.length >= AgentHostController.MAX_RESTARTS_PER_WINDOW) {
      this.input.log(
        `agent-host auto-restart abandoned: ${this.restartAttempts.length} crashes within ${AgentHostController.RESTART_WINDOW_MS / 1000}s. Manual restart required.`,
      );
      sendRendererEvent("host-restart-gave-up", {
        crashes: this.restartAttempts.length,
        windowMs: AgentHostController.RESTART_WINDOW_MS,
        lastCode: code,
        lastSignal: signal,
      });
      return;
    }
    this.restartAttempts.push(now);
    this.input.log(
      `agent-host crashed (code=${code ?? "null"} signal=${signal ?? "null"}); auto-restarting (attempt ${this.restartAttempts.length}/${AgentHostController.MAX_RESTARTS_PER_WINDOW} in window).`,
    );
    sendRendererEvent("host-restarting", { attempt: this.restartAttempts.length, code, signal });
    try {
      this.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.input.log(`agent-host restart failed: ${message}`);
      sendRendererEvent("host-restart-failed", { error: message });
    }
  }

  send(request: DesktopRequestWithout<"id">): Promise<unknown> {
    // Never (re)spawn once shutdown began: a stray IPC or timer firing in the
    // window between shutdown() and app.exit() would otherwise revive a child
    // that outlives the app (holding SQLite handles and MCP subprocesses).
    // The shutdown request itself still goes out — the child is alive then.
    if (!this.shuttingDown) this.start();
    if (!this.host?.stdin.writable) {
      return Promise.reject(new Error("Agent host is not writable."));
    }
    const id = `desktop-${this.nextRequestId++}`;
    const payload = { ...request, id } as DesktopRequest;
    this.host.stdin.write(serializeJsonLine(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.host) return;
    this.shuttingDown = true;
    // Bound the graceful handshake: the child settles in-flight turns and
    // closes MCP clients with no timeout of its own, so a stuck provider
    // request or an MCP subprocess ignoring SIGTERM would leave this await
    // pending forever — and before-quit already preventDefault()ed, so the
    // app would linger headless after "Quit". After the grace period, kill.
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), AgentHostController.SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });
    const result = await Promise.race([
      this.send({ type: "shutdown" }).then(
        () => "ok" as const,
        // The host's own exit handler may have already nulled this.host before
        // the buffered shutdown response surfaced (which is exactly why send
        // rejected) — treat as settled and let the guarded kill below no-op.
        () => "dead" as const,
      ),
      timeout,
    ]);
    if (result !== "ok") this.host?.kill();
  }

  private resolveEntry(): string {
    const roots = [this.asarUnpackedRoot(), this.input.repoRoot].filter((root, index, all) => root && all.indexOf(root) === index);
    const candidates = roots.flatMap((root) => [
      path.resolve(root, "dist/packages/agent-host/stdio.cjs"),
      path.resolve(root, "dist/packages/agent-host/src/stdio.js"),
      path.resolve(root, "dist/packages/agent-host/packages/agent-host/src/stdio.js"),
    ]);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      const message = `Agent host entry not found. Tried: ${candidates.join(", ")}`;
      this.input.log(message);
      throw new Error(message);
    }
    return found;
  }

  private asarUnpackedRoot(): string {
    return this.input.repoRoot.replace(/app\.asar(?=([\\/]|$))/, "app.asar.unpacked");
  }

  private handleLine(line: string): void {
    let message: DesktopEvent | DesktopResponse;
    try {
      message = parseJsonLine(line) as DesktopEvent | DesktopResponse;
    } catch {
      this.input.log(`host parse error: ${line}`);
      sendRendererEvent("host-parse-error", line);
      return;
    }

    if (message.type === "response") {
      const id = message.id;
      if (!id) return;
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (message.success) request.resolve(message.data);
      else request.reject(new Error(message.error));
      return;
    }

    if (message.type === "host_ready") {
      this.ready = true;
      this.setInitStep({ phase: "done" });
      this.resolveInitialization();
    }
    if (message.type === "host_request") {
      // Reverse RPC from the child. Handle out of band so the renderer
      // never sees a half-formed event, then send the result back over
      // stdin as a host_response request. If no handler is registered we
      // reply with an error so the tool fails fast.
      void this.dispatchHostRequest(message);
      return;
    }
    // Maintain a cached, LIVE-FRESH session snapshot so a window that opens or
    // reloads MID-SESSION can cold-load engine state (async tasks,
    // subtasks, DAG) on demand. The host only emits session_snapshot in
    // response to main-window-initiated requests + turn boundaries, so the
    // separate Workspace window — which subscribes to the broadcast "agent"
    // feed but never drove those requests — otherwise has no way to populate
    // its Agent Team / DAG tabs until the next live event. A full snapshot
    // re-seeds the cache; the model_stream engine deltas below are folded in so
    // the cache stays current between snapshots (e.g. async tasks dispatched in
    // the CURRENT, still-running turn). See replayEngineSnapshotTo.
    if (
      (message.type === "session_snapshot" || message.type === "session_created") &&
      message.session
    ) {
      lastSnapshotBySession.set(message.sessionId, {
        type: "session_snapshot",
        sessionId: message.sessionId,
        session: message.session,
      });
      if (message.type === "session_snapshot") {
        try {
          // Keep the durable sidebar index current before renderers observe the
          // snapshot. This updater deliberately preserves active/pin/order state,
          // which matters when the snapshot belongs to a background session.
          syncSessionIndexFromSnapshot(message.session);
        } catch (error) {
          this.input.log(
            `session snapshot index sync failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else if (message.type === "model_stream") {
      foldEngineDeltaIntoSnapshot(message.sessionId, message.event);
    }
    let shouldBroadcast = true;
    if (message.type === "session_title_updated") {
      try {
        // Title changes are first-class metadata. Persist the targeted row before
        // renderers observe the event; the CAS guard preserves a concurrent rename.
        const cached = lastSnapshotBySession.get(message.sessionId);
        const result = syncSessionTitle(
          message.sessionId,
          message.title,
          message.expectedTitle,
          cached?.session,
        );
        shouldBroadcast = result.applied;
        if (result.applied && cached?.session.title === message.expectedTitle) {
          lastSnapshotBySession.set(message.sessionId, {
            ...cached,
            session: { ...cached.session, title: message.title },
          });
        }
      } catch (error) {
        shouldBroadcast = false;
        this.input.log(
          `session title index sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (shouldBroadcast) sendRendererEvent("agent", message);
  }

  private async dispatchHostRequest(message: Extract<DesktopEvent, { type: "host_request" }>): Promise<void> {
    const handler = this.input.onHostRequest;
    const result = handler
      ? await handler(message.kind, message.params, message.sessionId).catch((error) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error),
        }))
      : ({ success: false as const, error: `host_request not supported in this environment: ${message.kind}` });
    try {
      await this.send({
        type: "host_response",
        hostRequestId: message.id,
        success: result.success,
        ...(result.success ? { data: result.data } : { error: result.error }),
      });
    } catch (error) {
      this.input.log(`host_response send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private setInitStep(step: InitStep): void {
    this.init.step = step;
    sendRendererEvent("init-step", step);
  }

  private resolveInitialization(): void {
    const data = this.readyData();
    for (const resolve of this.init.waiters) resolve(data);
    this.init.waiters.clear();
  }

  private readyData(): DesktopReadyData {
    return { transport: "stdio", cwd: this.input.defaultCwd ?? this.input.repoRoot, agentReady: this.ready };
  }
}

export function sendRendererEvent(event: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      // The reusable menu has its own state channel; forwarding agent streams
      // would keep its hidden renderer busy between opens.
      if (win.webContents.getURL().endsWith("/conversation-menu.html")) continue;
      win.webContents.send(`reina:event:${event}`, payload);
    } catch {
      // Windows can disappear while child process exit events are still being delivered.
    }
  }
}

// Latest full-session snapshot per session (normalized to a session_snapshot
// envelope). Populated in handleLine; replayed to a single window on demand so a
// freshly-opened/reloaded Workspace window can cold-load engine state instead of
// waiting for the next live event. Keyed by session so a switch (or a background
// session emitting) can't make the replay return the WRONG session's snapshot —
// replayEngineSnapshotTo serves the desktop's ACTIVE session specifically.
const lastSnapshotBySession = new Map<string, Extract<DesktopEvent, { type: "session_snapshot" }>>();

/** Re-send the active session's cached snapshot to ONE window (the requester).
 * Called when the Workspace window mounts/subscribes AND whenever it re-binds to
 * a newly-foreground session — guarantees its Agent Team / DAG tabs hydrate even
 * when it opened mid-turn or just switched. Resolves the target session from
 * desktop-state's `activeSessionId` so a background session's snapshot can't be
 * served by mistake. No-op until that session has emitted a snapshot. */
export function replayEngineSnapshotTo(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const activeId = loadDesktopState().activeSessionId;
  const snapshot = activeId ? lastSnapshotBySession.get(activeId) : null;
  if (!snapshot) return;
  try {
    win.webContents.send("reina:event:agent", snapshot);
  } catch {
    // Window vanished between the request and the send — harmless.
  }
}

/** Drop a closed/deleted session's cached snapshot so the map doesn't grow for
 * the app's lifetime (each entry retains a full session). Called when the
 * renderer closes a session (the precursor to deleting it). */
export function forgetSessionSnapshot(sessionId: string): void {
  lastSnapshotBySession.delete(sessionId);
}

/** Fold a live `model_stream` engine delta into the cached snapshot so it
 * stays current between full snapshots — the case that matters: async tasks
 * dispatched in the CURRENT, still-running turn (the host emits no full
 * snapshot mid-turn, only per-task `async-task-updated` deltas). Only folds
 * deltas for the cached session; a different active session re-seeds the cache
 * via its own snapshot. Mutates the retained snapshot in place (nothing else
 * references it). Mirrors the Workspace store's upsert reducers. */
function foldEngineDeltaIntoSnapshot(sessionId: string, event: ModelStreamEvent): void {
  const snap = lastSnapshotBySession.get(sessionId);
  if (!snap) return;
  const session = snap.session as {
    asyncTasks?: Array<{ id: string }>;
    subtasks?: Array<{ id: string }>;
    phase?: unknown;
    goal?: unknown;
  };
  const upsert = <T extends { id: string }>(list: T[] | undefined, item: T): T[] => {
    const next = list ? list.slice() : [];
    const idx = next.findIndex((e) => e.id === item.id);
    if (idx === -1) next.push(item);
    else next[idx] = item;
    return next;
  };
  switch (event.type) {
    case "async-task-updated":
      if (event.task) session.asyncTasks = upsert(session.asyncTasks, event.task as { id: string });
      return;
    case "subtask-updated":
      if (event.subtask) {
        if (event.change === "removed") {
          session.subtasks = (session.subtasks ?? []).filter((s) => s.id !== (event.subtask as { id: string }).id);
        } else {
          session.subtasks = upsert(session.subtasks, event.subtask as { id: string });
        }
      }
      return;
    case "phase-changed":
      session.phase = event.phase;
      return;
    case "goal-state-changed":
      session.goal = event.state;
      return;
    default:
      return;
  }
}

/** Seed the host's concurrency limit at startup. Settings saves also update
 * the running host through update_subagent_concurrency. */
function subagentConcurrencyEnv(): NodeJS.ProcessEnv {
  const raw = readStoreValue("view-settings", "subagentConcurrency");
  if (raw === null || raw === undefined) return {};
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) return {};
  return { REINA_MAX_CONCURRENT_ASYNC_SUBAGENTS: String(parsed) };
}

/** Seed the host's compaction preferences at startup. Settings saves also
 * update the running host through update_compaction_settings. */
export function compactionEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const boolFlag = (storeKey: string, envKey: string): void => {
    const raw = readStoreValue("view-settings", storeKey);
    if (raw === null) return;
    out[envKey] = raw === "true" || raw === "1" ? "1" : "0";
  };
  // fallbackWhenUnset applies ONLY when the key was never configured (store is
  // null) — not when the user explicitly entered an out-of-range value like 0,
  // which stays unprojected so the engine falls back to buffer-token mode. This
  // is how a cleared "trigger percent" (0) differs from a fresh install.
  const intFlag = (storeKey: string, envKey: string, min: number, max: number, fallbackWhenUnset?: number): void => {
    const raw = readStoreValue("view-settings", storeKey);
    if (raw === null || raw === undefined) {
      if (fallbackWhenUnset !== undefined) out[envKey] = String(fallbackWhenUnset);
      return;
    }
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return;
    out[envKey] = String(parsed);
  };
  boolFlag("compactionOffload", "REINA_COMPACTION_OFFLOAD");
  boolFlag("compactionAuto", "REINA_COMPACTION_AUTO");
  intFlag("compactionTriggerPercent", "REINA_COMPACTION_TRIGGER_PERCENT", 30, 95, 70);
  // A cleared percentage explicitly selects the buffer, even when the desktop
  // process inherited a percentage override from its launch environment.
  const triggerPercent = readStoreValue("view-settings", "compactionTriggerPercent");
  if (triggerPercent !== null && triggerPercent !== undefined && Number(triggerPercent) === 0) {
    out.REINA_COMPACTION_TRIGGER_PERCENT = undefined;
  }
  intFlag("compactionBufferTokens", "REINA_COMPACTION_BUFFER_TOKENS", 1_000, 500_000);
  intFlag("compactionKeepRecent", "REINA_COMPACTION_KEEP_RECENT", 2, 64);
  return out;
}
