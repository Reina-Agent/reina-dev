import crypto from "node:crypto";
import {
  loadPersistedWakeups,
  savePersistedWakeups,
  type PersistedWakeup,
} from "./wakeup-store.js";
import type { HostHandlerEnv, HostRequestResult } from "./host-handlers.js";

type ScheduledWakeup = {
  id: string;
  sessionId: string;
  prompt: string;
  reason: string;
  firesAt: number;
  timer: NodeJS.Timeout;
};

/** Wakeups are session-scoped and persisted to `$REINA_HOME/wakeups.json` so
 * they survive app restart / Electron crash / OS reboot. The in-memory `wakeups`
 * Map holds the live timers; the disk file is the durable mirror. On boot,
 * `rehydrateWakeups` re-arms timers from disk. `clearAllWakeups` only kills
 * in-memory timers (does NOT delete the disk file) so a graceful shutdown does
 * not lose pending wakeups. */
const wakeups = new Map<string, ScheduledWakeup>();

function snapshotForPersist(): PersistedWakeup[] {
  return [...wakeups.values()].map(({ id, sessionId, prompt, reason, firesAt }) => ({
    id,
    sessionId,
    prompt,
    reason,
    firesAt,
  }));
}

function persistAsync(env: HostHandlerEnv): void {
  void savePersistedWakeups(snapshotForPersist()).catch((error) => {
    env.log(`wakeup persist failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Stop all in-memory wakeup timers without touching disk. Called at shutdown
 * so the timers don't fire mid-teardown; the disk file is left intact for the
 * next launch's rehydrate pass. */
export function clearAllWakeups(): void {
  for (const w of wakeups.values()) clearTimeout(w.timer);
  wakeups.clear();
}

/** Re-arm timers from `$REINA_HOME/wakeups.json` after the host has started.
 * Past-due wakeups (firesAt <= now) are fired after a short delay so the host
 * has a moment to settle. Future-due wakeups are armed for their remaining
 * delay. Safe to call before any sessions are loaded — the eventual
 * `send_message` will fail gracefully if its target session is unavailable. */
export async function rehydrateWakeups(env: HostHandlerEnv): Promise<{ armed: number; pastDue: number }> {
  const persisted = await loadPersistedWakeups();
  if (persisted.length === 0) return { armed: 0, pastDue: 0 };
  const now = Date.now();
  const PAST_DUE_DELAY_MS = 2000;
  let armed = 0;
  let pastDue = 0;
  for (const entry of persisted) {
    if (wakeups.has(entry.id)) continue;
    const remaining = Math.max(0, entry.firesAt - now);
    const delay = remaining === 0 ? PAST_DUE_DELAY_MS : remaining;
    const wakeup = armWakeup(entry, delay, env);
    wakeups.set(entry.id, wakeup);
    if (remaining === 0) pastDue += 1;
    else armed += 1;
  }
  env.log(`wakeup rehydrate: armed=${armed} pastDue=${pastDue}`);
  // Snapshot back to disk so the file reflects what we actually loaded
  // (drops malformed entries that loadPersistedWakeups silently filtered).
  persistAsync(env);
  return { armed, pastDue };
}

/** Node's setTimeout stores the delay as a signed 32-bit int; a larger value
 * silently overflows and the timer fires almost immediately (delay ~1ms). */
const TIMEOUT_MAX = 2_147_483_647;

/** Arm a single timer for a wakeup record. Shared between fresh schedules and
 * rehydration so the firing path is identical in both cases. A delay beyond
 * TIMEOUT_MAX (~24.8 days) — reachable from a corrupted `firesAt` or a large
 * backward clock change on rehydrate — is armed in <=TIMEOUT_MAX chunks that
 * re-arm for the remainder, so it can't truncate into an immediate fire. */
function armWakeup(
  entry: PersistedWakeup,
  delayMs: number,
  env: HostHandlerEnv,
): ScheduledWakeup {
  const fire = (): void => {
    wakeups.delete(entry.id);
    persistAsync(env);
    const wakeMessage = `[scheduled wakeup] ${entry.reason}\n\n${entry.prompt}`;
    env.log(`schedule_wakeup fired: id=${entry.id} session=${entry.sessionId}`);
    void Promise.resolve(env.sendHostRequest({
      type: "send_message",
      sessionId: entry.sessionId,
      message: wakeMessage,
    })).catch((error) => {
      env.log(`schedule_wakeup send_message rejected: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const scheduled = { ...entry } as ScheduledWakeup;
  const armChunk = (remaining: number): void => {
    scheduled.timer =
      remaining > TIMEOUT_MAX
        ? setTimeout(() => armChunk(remaining - TIMEOUT_MAX), TIMEOUT_MAX)
        : setTimeout(fire, Math.max(0, remaining));
  };
  armChunk(delayMs);
  return scheduled;
}

export async function handleScheduleWakeup(
  params: unknown,
  sessionId: string | undefined,
  env: HostHandlerEnv,
): Promise<HostRequestResult> {
  const p = params as { sessionId?: string; delaySeconds?: number; prompt?: string; reason?: string };
  const targetSession = p.sessionId ?? sessionId;
  if (!targetSession) return { success: false, error: "schedule_wakeup requires a sessionId" };
  const delay = typeof p.delaySeconds === "number" ? Math.max(1, Math.min(3600, Math.floor(p.delaySeconds))) : NaN;
  if (!Number.isFinite(delay)) return { success: false, error: "schedule_wakeup requires numeric delaySeconds in [1, 3600]" };
  if (!p.prompt || !p.prompt.trim()) return { success: false, error: "schedule_wakeup requires prompt" };
  const reason = (p.reason ?? "").trim().slice(0, 200) || "scheduled wakeup";
  const id = `wake-${crypto.randomBytes(6).toString("hex")}`;
  const firesAt = Date.now() + delay * 1000;
  const entry: PersistedWakeup = {
    id,
    sessionId: targetSession,
    prompt: p.prompt,
    reason,
    firesAt,
  };
  wakeups.set(id, armWakeup(entry, delay * 1000, env));
  persistAsync(env);
  return { success: true, data: { wakeupId: id, firesAt: new Date(firesAt).toISOString() } };
}
