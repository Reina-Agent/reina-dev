import { stat } from "node:fs/promises";
import path from "node:path";
import type { AsyncTaskRecord, ChatMessage, MessageAttachment, RolloutItem, SessionState } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { filterSkillsByProfile, resolveProfile } from "../profiles.js";
import { loadSkills, type SkillFileCache } from "../skills.js";
import { pushTrace } from "../trace.js";
import { formatAsyncTaskSnapshotLine } from "../subagent/format.js";
import type { AsyncTaskActivitySnapshot } from "../subagent/types.js";

/** Minimal host surface the TurnContextController needs from AgentEngine.
 * Mirrors the TodosHost contract: the controller writes the session slices
 * it owns (skills, readFileTimestamps mtime sync, lastTurnTaskStatuses) and
 * calls back into the engine for message/rollout plumbing.
 *
 * `appendMessage` is forwarded (not reimplemented) because the engine's
 * helper dual-pushes into messages AND modelMessages — duplicating it here
 * would silently drop the modelMessages mirror if the two ever diverge. */
export interface TurnContextHost {
  readonly session: SessionState;
  /** The on-disk activity snapshot reader used by task-state deltas. */
  readonly subagent: {
    readActivity(taskId: string): Promise<AsyncTaskActivitySnapshot | undefined>;
  };
  record(item: RolloutItem): void;
  appendMessage(item: ChatMessage): void;
}

/** Owns the start-of-turn context weave runTurn performs before appending
 * the user prompt: skills refresh, stale-read notice, async-task delta
 * snapshot, and completion-notification injection. All state stays on
 * SessionState (skills, readFileTimestamps, lastTurnTaskStatuses) because
 * the system prompt, persistence, and rollout replay read it by name —
 * only the write paths live here. runTurn calls these in a fixed order
 * (notices BEFORE the user prompt so it stays the last message). */
export class TurnContextController {
  private readonly skillFiles: SkillFileCache = new Map();

  constructor(private readonly host: TurnContextHost) {}

  async refreshContext(): Promise<void> {
    // Skills are checked at each model-request boundary — they're a
    // function of `<cwd>/.claude/skills`, not user-driven state. Recording
    // them on every refreshContext would bloat the rollout log without
    // changing what `loadRolloutAsSession` returns (the engine recomputes
    // them on the next request anyway). Unchanged files reuse parsed metadata
    // so long tool loops do not reread every installed skill body. When the
    // active profile declares a `skills` allow-list, filter to those names so the renderer
    // and system-prompt builder don't see disallowed skills.
    const loaded = await loadSkills(this.host.session.cwd, this.skillFiles);
    this.host.session.skills = filterSkillsByProfile(loaded, resolveProfile(this.host.session.agent));
  }

  /** Detect files the agent previously read that have since changed on disk
   * (typically the user edited them in the IDE). When any are stale, sync
   * the recorded mtime to the current one and inject a one-shot system note
   * into the conversation so the agent re-reads before relying on cached
   * content. Mtime is synced even when we emit the notice so we don't
   * re-warn about the same change on every turn. */
  /** Progressive-disclosure snapshot: at the start of every supervisor
   * turn, push ONLY the task state changes since the last turn — new
   * dispatches and status flips. Quiet tasks (still running, or already
   * surfaced in a previous turn) stay out of the prompt, so the model
   * isn't paying for the full roster on every "hi" turn.
   *
   * The model pulls the full roster on demand via `get_async_tasks`
   * (recovery path after compaction, or when it wants to plan around
   * everything in flight). This handler only surfaces what's NEW.
   *
   * Diff key is `(taskId, status)`. A new task with id never seen before
   * counts as a change (and the previous "(none)" status appears as
   * "new"). Anything matching the previous snapshot is silent. */
  async injectAsyncTaskSnapshot(): Promise<void> {
    const tasks = this.host.session.asyncTasks ?? [];
    const previous = this.host.session.lastTurnTaskStatuses ?? {};
    const current: Record<string, AsyncTaskRecord["status"]> = {};
    const changed: Array<{ task: AsyncTaskRecord; from: AsyncTaskRecord["status"] | "new" }> = [];
    for (const task of tasks) {
      current[task.id] = task.status;
      const prev = previous[task.id];
      if (prev !== task.status) {
        changed.push({ task, from: prev ?? "new" });
      }
    }
    // Update the snapshot baseline AFTER computing the diff so the next
    // turn compares against THIS turn's state, not the previous one.
    this.host.session.lastTurnTaskStatuses = current;
    if (changed.length === 0) return;
    // Build per-task lines. For running tasks read the activity snapshot
    // from disk so the model can see "what" not just "still running".
    const lines: string[] = [];
    for (const entry of changed) {
      const transition = entry.from === "new" ? "(new)" : `(${entry.from} → ${entry.task.status})`;
      if (entry.task.status === "running") {
        const snapshot = await this.host.subagent.readActivity(entry.task.id);
        lines.push(`${formatAsyncTaskSnapshotLine(entry.task, snapshot)} ${transition}`);
      } else {
        lines.push(`${formatAsyncTaskSnapshotLine(entry.task)} ${transition}`);
      }
    }
    const note = message(
      "user",
      `(system) Subagent task state changes since last turn:\n${lines.join("\n")}\n\nUse get_async_tasks with detail \"activity\" for a deeper look, \"full\" for results, or \"headers\" for the roster. Tasks with no state change are NOT listed here.`,
    );
    note.origin = "task-delta";
    this.host.appendMessage(note);
    pushTrace(this.host.session, "stale_reads", { kind: "async_tasks_delta", count: changed.length });
  }

  async injectStaleReadNotice(options?: { skillsOnly?: boolean }): Promise<void> {
    const stamps = this.host.session.readFileTimestamps;
    if (!stamps) return;
    const entries = Object.entries(stamps).filter(([file]) => !options?.skillsOnly || path.basename(file) === "SKILL.md");
    if (entries.length === 0) return;
    const stale: string[] = [];
    for (const [file, knownMtime] of entries) {
      const current = await stat(file).then((s) => s.mtimeMs).catch(() => null);
      if (current === null) {
        if (options?.skillsOnly) {
          stale.push(file);
          delete stamps[file];
        }
        continue;
      }
      if (options?.skillsOnly ? current !== knownMtime : current > knownMtime + 1) {
        stale.push(file);
        stamps[file] = current;
        this.host.record({ type: "read_file", path: file, mtimeMs: current, readAt: nowIso() });
      }
    }
    if (stale.length === 0) return;
    const rel = stale.slice(0, 5).map((p) => path.relative(this.host.session.cwd, p).replaceAll("\\", "/"));
    const more = stale.length > rel.length ? ` (and ${stale.length - rel.length} more)` : "";
    const note = message(
      "user",
      options?.skillsOnly
        ? `(system) These skill files changed or were removed since you last read them: ${rel.join(", ")}${more}. Re-read available skills before applying their instructions; stop relying on removed skill files.`
        : `(system) These files changed on disk since you last read them: ${rel.join(", ")}${more}. Re-read them before relying on the cached content.`,
    );
    note.origin = "stale-read";
    this.host.appendMessage(note);
    pushTrace(this.host.session, "stale_reads", { count: stale.length, paths: rel });
  }
}

/** Local copy of the engine's message() helper (same shape compaction.ts
 * keeps): building a ChatMessage is a pure two-liner, and importing it from
 * engine.ts would create a controller→engine cycle. */
function message(role: ChatMessage["role"], content: string, attachments?: MessageAttachment[]): ChatMessage {
  const msg: ChatMessage = { id: createId("msg"), role, content, createdAt: nowIso() };
  if (attachments && attachments.length > 0) msg.attachments = attachments;
  return msg;
}
