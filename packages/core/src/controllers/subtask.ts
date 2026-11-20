import type { AsyncTaskRecord, ModelStreamEvent, RolloutItem, SessionState, SubtaskRecord, TeamPhase, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { errorMessage } from "@reina/protocol";
import type { SubtaskStore } from "../subtasks.js";

/** Pipeline phases where a stage's decisions accumulate and must be handed
 * off before moving on. Leaving one of these for a DIFFERENT real phase is
 * gated on a fresh `kind:handoff` note (see `handoffGate`). `complete` /
 * `failed` are terminal (not working phases); the empty/undeclared state
 * isn't one either — entering the pipeline has nothing to hand off yet. */
const WORKING_PHASES: ReadonlySet<TeamPhase> = new Set<TeamPhase>(["plan", "prd", "exec", "verify", "fix"]);

/** Max entries into the `fix` phase per pipeline run (see `fixCycleGate`). */
const MAX_FIX_ENTRIES = 3;

/** Minimal host surface the SubtaskController needs. The DAG itself lives
 * on SubtaskStore — wired top-level-only (subagents don't own one), so the
 * store handle is nullable and every accessor throws if missing. Phase
 * lives on session.phase; mutations also emit a phase-changed stream
 * event + rollout item via the host. */
export interface SubtaskHost {
  readonly session: SessionState;
  readonly subtasksStore: SubtaskStore | null;
  record(item: RolloutItem): void;
  emitStream(event: ModelStreamEvent): void;
  touch(): void;
}

/** Owns the team-mode (Phase C) coordinator tools (create_subtask /
 * update_subtask / get_dag / set_phase). All four delegate to the
 * SubtaskStore + emit lifecycle events. The store's own onChange
 * forwarder handles the per-mutation rollout + stream emission; this
 * controller just translates tool payloads to store calls and back. */
export class SubtaskController {
  /** Baseline for the handoff gate: the set of `kind:handoff` note ids that
   * existed when the current phase was entered. A transition is allowed only
   * if a handoff note OUTSIDE this baseline exists (i.e. written during the
   * current stage). Id-based rather than timestamp-based so two transitions
   * in the same millisecond can't share one stale note. `null` until the
   * first phase entry (or after a rollout-replayed phase that bypassed
   * `setPhase`) — the gate re-baselines lazily against the current phase,
   * which forces one fresh handoff after a mid-phase reload (re-grounding). */
  private handoffBaseline: { phase: TeamPhase; ids: ReadonlySet<string> } | null = null;

  /** verify↔fix churn counter: how many times this pipeline run has entered
   * the `fix` phase. In-memory like `handoffBaseline` (a reload resets the
   * budget — same tradeoff: re-grounding beats a false refusal). Reset when
   * the pipeline closes (complete / failed / null) or is re-planned (plan). */
  private fixEntries = 0;

  constructor(private readonly host: SubtaskHost) {}

  create(record: ToolCallRecord): ToolObservation {
    try {
      const input = record.input as {
        title: string;
        description: string;
        owner?: string;
        blockedBy?: string[];
        phase?: TeamPhase;
        tags?: string[];
      };
      const node = this.requireStore().create({
        title: input.title,
        description: input.description,
        owner: input.owner,
        blockedBy: input.blockedBy,
        phase: input.phase,
        tags: input.tags,
      });
      return {
        callId: record.id,
        name: record.name,
        output: JSON.stringify(node, null, 2),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  update(record: ToolCallRecord): ToolObservation {
    try {
      const input = record.input as {
        id: string;
        title?: string;
        description?: string;
        owner?: string;
        status?: SubtaskRecord["status"];
        addBlockedBy?: string[];
        removeBlockedBy?: string[];
        bindAsyncTaskId?: string;
        phase?: TeamPhase;
        tags?: string[];
        resultSummary?: string;
      };
      const id = input.id?.trim();
      if (!id) throw new Error("update_subtask requires an id");
      const node = this.requireStore().update(id, {
        title: input.title,
        description: input.description,
        owner: input.owner,
        status: input.status,
        addBlockedBy: input.addBlockedBy,
        removeBlockedBy: input.removeBlockedBy,
        bindAsyncTaskId: input.bindAsyncTaskId,
        phase: input.phase,
        tags: input.tags,
        resultSummary: input.resultSummary,
      });
      if (!node) throw new Error(`unknown subtask: ${id}`);
      return {
        callId: record.id,
        name: record.name,
        output: JSON.stringify(node, null, 2),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  getDag(record: ToolCallRecord): ToolObservation {
    try {
      const input = record.input as { owner?: string };
      const owner = input.owner?.trim();
      const subtasks = this.list();
      const ready = this.ready(owner);
      // Surface dead-locked bindings where the coordinator already looks
      // every round: an in_progress node whose ACTIVE bound task is no
      // longer live (lost to a process restart, evicted, …) would otherwise
      // hang forever — settle-time sync deliberately skips non-terminal
      // task states, and reconcile-on-load only touches tasks, not nodes.
      const tasks = this.host.session.asyncTasks ?? [];
      const stalled = subtasks.flatMap((node) => {
        if (node.status !== "in_progress" || node.asyncTaskIds.length === 0) return [];
        const taskId = node.asyncTaskIds.at(-1)!;
        const task = tasks.find((t) => t.id === taskId);
        if (task && (task.status === "running" || task.status === "resuming")) return [];
        return [{ id: node.id, title: node.title, taskId, taskStatus: task?.status ?? "missing" }];
      });
      const payload = {
        phase: this.host.session.phase ?? null,
        nodeCount: subtasks.length,
        ready: ready.map((node) => ({ id: node.id, title: node.title, owner: node.owner })),
        ...(stalled.length > 0
          ? {
              stalled,
              stalledHint:
                "These in_progress nodes' bound worker task is no longer live (e.g. lost to a process restart). Deal with them THIS turn: resume via update_async_task, re-dispatch via task with subtaskId (re-binds the node), or settle the node via update_subtask.",
            }
          : {}),
        subtasks,
      };
      return {
        callId: record.id,
        name: record.name,
        output: JSON.stringify(payload, null, 2),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  setPhaseFromTool(record: ToolCallRecord): ToolObservation {
    try {
      const input = record.input as { phase?: TeamPhase | null };
      const next = input.phase ?? null;
      const current = this.host.session.phase ?? null;
      const gate = this.completenessGate(next) ?? this.fixCycleGate(current, next) ?? this.handoffGate(current, next);
      if (gate) return { callId: record.id, name: record.name, error: gate };
      this.setPhase(next);
      return {
        callId: record.id,
        name: record.name,
        output: JSON.stringify({ phase: this.host.session.phase ?? null }, null, 2),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  /** Gate entering `complete` on the DAG actually being finished: every node
   * must carry a settled disposition — `completed`, or explicitly `cancelled`.
   * pending / blocked / in_progress nodes mean work is still outstanding, and
   * a `failed` node needs a deliberate call (re-dispatch it, or cancel it with
   * a resultSummary) before the pipeline may close. The evidence here is
   * engine-held DAG state, not the coordinator's (or a worker's) say-so —
   * same pattern as the goal gate and the handoff gate below. Checked BEFORE
   * the handoff gate: when work is still open, writing the closing handoff
   * would be premature anyway. No store / an empty DAG passes — phases are
   * usable without a DAG (light fan-out), and `failed` stays exempt as the
   * abort hatch. */
  private completenessGate(next: TeamPhase | null): string | null {
    if (next !== "complete") return null;
    const store = this.host.subtasksStore;
    if (!store) return null;
    const unsettled = store.list().filter((node) => node.status !== "completed" && node.status !== "cancelled");
    if (unsettled.length === 0) return null;
    const preview = unsettled
      .slice(0, 8)
      .map((node) => `${node.id} [${node.status}] ${node.title}`)
      .join("; ");
    return [
      `Refusing set_phase("complete"): ${unsettled.length} subtask(s) in the DAG are not settled yet — ${preview}${unsettled.length > 8 ? "; …" : ""}.`,
      `Every node must end up completed or explicitly cancelled before the pipeline can close. Re-dispatch outstanding/failed nodes (task with subtaskId), or mark dead ends cancelled via update_subtask (with a resultSummary saying why), then retry.`,
      `If the whole effort is being abandoned instead, use set_phase("failed") — that path is not gated.`,
    ].join("\n");
  }

  /** Gate re-entering `fix` once the pipeline has already churned through
   * MAX_FIX_ENTRIES fix rounds. Convergence can't be judged from free-text
   * worker results, but the round count is engine-held truth: past the
   * budget, another identical round is thrashing, not progress (OMC caps its
   * team fix loop the same way). The coordinator must close out honestly
   * (cancel + complete, or `failed` — both ungated here) or genuinely
   * change approach — entering `plan` resets the budget, so a re-plan is
   * the sanctioned "try differently" path. Checked before the handoff gate:
   * no point writing a handoff for a refused transition. */
  private fixCycleGate(current: TeamPhase | null, next: TeamPhase | null): string | null {
    if (next !== "fix" || current === "fix") return null;
    if (this.fixEntries < MAX_FIX_ENTRIES) return null;
    return [
      `Refusing set_phase("fix"): this pipeline has already been through ${this.fixEntries} fix rounds without converging — another round of the same is thrashing, not progress.`,
      `Close out honestly instead: cancel the nodes that keep failing (update_subtask status:"cancelled" + a resultSummary of what was tried), set_phase("complete"), and report the remaining failures — or abandon via set_phase("failed") (not gated).`,
      `If a genuinely different approach exists, set_phase("plan") and restructure the DAG first — re-entering plan resets the fix budget.`,
    ].join("\n");
  }

  /** Gate a phase transition on a handoff note when leaving a working stage.
   * Returns an error string to refuse the transition, or null to allow it.
   *
   * `set_phase`'s tool description marks the handoff note REQUIRED before
   * every transition, and the engine pins `kind:handoff` notes into the
   * prompt's anchor section — this enforces that stated contract at the tool
   * boundary (mirrors how the goal gate enforces declare_audit_done). Exempt:
   * no-op transitions, clearing the indicator (→ null), aborting (→ failed),
   * and entering the pipeline from a non-working state (nothing to hand off
   * yet). The required note must be NEWER than the current phase's entry so a
   * stale handoff from an earlier stage doesn't satisfy the gate. */
  private handoffGate(current: TeamPhase | null, next: TeamPhase | null): string | null {
    if (next === current) return null;
    if (next === null || next === "failed") return null;
    if (current === null || !WORKING_PHASES.has(current)) return null;
    // Lazily baseline against the current phase when we have none (fresh
    // construction, or a phase restored via rollout replay that bypassed
    // setPhase): every existing handoff counts as already-spent, so advancing
    // requires a new one.
    if (!this.handoffBaseline || this.handoffBaseline.phase !== current) {
      this.handoffBaseline = { phase: current, ids: this.handoffNoteIds() };
    }
    const baseline = this.handoffBaseline.ids;
    const hasFreshHandoff = (this.host.session.notes ?? []).some(
      (note) => note.tags.includes("kind:handoff") && !baseline.has(note.id),
    );
    if (hasFreshHandoff) return null;
    return [
      `Refusing to advance phase ${current} → ${next}: no handoff note written for the "${current}" stage yet.`,
      `Before this transition, call note(...) with tags: ["kind:handoff"] and a body covering — Decided / Rejected / Risks / Files / Remaining — then retry set_phase.`,
      `(Handoff notes pin into the notebook index and survive compaction, so the next stage's workers and your future self can read the decisions via list_notes.)`,
    ].join("\n");
  }

  // ─── Direct API (no tool wrapper) ──────────────────────────────────
  //
  // The four methods below mirror the SubtaskStore surface but add the
  // missing handle for callers that don't go through the tool dispatch
  // (e.g. the engine itself when reconciling state). They were public
  // on AgentEngine before the controller split — keeping them here keeps
  // the surface intact so internal callers don't break.

  remove(id: string): boolean {
    return this.requireStore().remove(id);
  }

  list(): SubtaskRecord[] {
    return this.host.subtasksStore ? this.host.subtasksStore.list() : [];
  }

  ready(owner?: string): SubtaskRecord[] {
    return this.host.subtasksStore ? this.host.subtasksStore.ready(owner) : [];
  }

  /** Push the team-mode pipeline to a new phase. Emits a phase-changed
   * stream event + a `phase` rollout item so the renderer & replay see
   * the transition. Idempotent — repeating the current phase is a no-op. */
  setPhase(phase: TeamPhase | null): void {
    const current = this.host.session.phase ?? null;
    const next = phase ?? null;
    if (current === next) return;
    if (next === "fix") this.fixEntries += 1;
    else if (next === "plan" || next === "complete" || next === "failed" || next === null) this.fixEntries = 0;
    this.host.session.phase = next ?? undefined;
    // Re-baseline the handoff gate at every entry into a real phase so the
    // NEXT transition needs its own fresh handoff. Terminal / cleared states
    // aren't gated, so no baseline is kept for them.
    this.handoffBaseline = next && WORKING_PHASES.has(next) ? { phase: next, ids: this.handoffNoteIds() } : null;
    this.host.touch();
    this.host.emitStream({ type: "phase-changed", phase: next });
    this.host.record({ type: "phase", phase: next });
  }

  /** Ids of all `kind:handoff` notes currently in the session index. */
  private handoffNoteIds(): ReadonlySet<string> {
    return new Set(
      (this.host.session.notes ?? [])
        .filter((note) => note.tags.includes("kind:handoff"))
        .map((note) => note.id),
    );
  }

  /** Team mode: bind a DAG node to a freshly-dispatched worker task. Marks
   * the node in_progress + records the async task id so it drops out of the
   * `ready` list and can't be double-dispatched. Best-effort — returns
   * `{ ok: false }` for an unknown id rather than throwing, so a coordinator
   * typo surfaces in the dispatch observation without discarding the worker
   * that already spawned. Wired from the SubagentHost bridge. */
  bindOnDispatch(subtaskId: string, taskId: string): { ok: boolean; error?: string } {
    const store = this.host.subtasksStore;
    if (!store) return { ok: false, error: "Subtask DAG is not available in this session." };
    if (!store.get(subtaskId)) {
      return { ok: false, error: `unknown subtask id "${subtaskId}" — check get_dag for valid node ids.` };
    }
    store.update(subtaskId, { status: "in_progress", bindAsyncTaskId: taskId });
    return { ok: true };
  }

  /** Team mode: mirror a settled worker's terminal status onto its bound DAG
   * node so downstream `blockedBy` edges cascade-unblock without a manual
   * update_subtask. No-ops unless the task carries a `subtaskId`, the node
   * still exists, and this task is the node's ACTIVE binding (a later retry
   * that re-bound the node must not be clobbered by an older attempt
   * settling). Wired from the SubagentHost bridge at settle time. */
  syncFromSettledTask(task: AsyncTaskRecord): void {
    const subtaskId = task.subtaskId;
    if (!subtaskId) return;
    const store = this.host.subtasksStore;
    if (!store) return;
    const node = store.get(subtaskId);
    if (!node) return;
    if (node.asyncTaskIds.at(-1) !== task.id) return;
    const status =
      task.status === "completed"
        ? "completed"
        : task.status === "cancelled"
          ? "cancelled"
          : task.status === "failed" || task.status === "failed_unrecoverable"
            ? "failed"
            : null;
    // Non-terminal task states (running / recoverable / orphaned / …) leave
    // the node as-is — the coordinator decides how to handle a stuck worker.
    if (!status) return;
    const summary = task.error
      ? task.error.slice(0, 200)
      : task.result
        ? task.result.slice(0, 200)
        : undefined;
    store.update(subtaskId, { status, resultSummary: summary });
  }

  private requireStore(): SubtaskStore {
    if (!this.host.subtasksStore) {
      throw new Error(
        "Subtask DAG is not available — team-mode coordinator tools require a top-level session.",
      );
    }
    return this.host.subtasksStore;
  }
}
