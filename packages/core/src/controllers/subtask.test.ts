import { describe, expect, it } from "vitest";
import type { AsyncTaskRecord, ModelStreamEvent, NoteIndexEntry, RolloutItem, SessionState, TeamPhase, ToolCallRecord } from "@reina/protocol";
import { SubtaskController } from "./subtask.js";
import { SubtaskStore } from "../subtasks.js";

function makeHost(store: SubtaskStore | null): {
  host: ConstructorParameters<typeof SubtaskController>[0];
  session: { phase?: TeamPhase; notes: NoteIndexEntry[] };
  recorded: RolloutItem[];
  streamed: ModelStreamEvent[];
} {
  const session = { phase: undefined as TeamPhase | undefined, notes: [] as NoteIndexEntry[] };
  const recorded: RolloutItem[] = [];
  const streamed: ModelStreamEvent[] = [];
  const host = {
    session: session as unknown as SessionState,
    subtasksStore: store,
    record: (item: RolloutItem) => recorded.push(item),
    emitStream: (event: ModelStreamEvent) => streamed.push(event),
    touch: () => undefined,
  };
  return { host, session, recorded, streamed };
}

function note(overrides: Partial<NoteIndexEntry>): NoteIndexEntry {
  return {
    id: "n_001",
    title: "handoff",
    tags: ["kind:handoff"],
    refs: [],
    status: "open",
    author: "parent",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function settledTask(overrides: Partial<AsyncTaskRecord>): AsyncTaskRecord {
  return {
    id: "sub_task01",
    agent: "default",
    description: "work",
    status: "completed",
    startedAt: new Date().toISOString(),
    isolation: "none",
    ...overrides,
  };
}

function setPhaseCall(phase: TeamPhase | null): ToolCallRecord {
  return { id: "call1", name: "set_phase", input: { phase }, status: "running" } as unknown as ToolCallRecord;
}

describe("SubtaskController.bindOnDispatch", () => {
  it("marks the node in_progress and records the async task id", () => {
    const store = new SubtaskStore();
    const node = store.create({ title: "A", description: "do A" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);

    const result = ctl.bindOnDispatch(node.id, "sub_worker1");

    expect(result.ok).toBe(true);
    const after = store.get(node.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.asyncTaskIds).toEqual(["sub_worker1"]);
    // Bound + in_progress → drops out of the ready list (no double-dispatch).
    expect(store.ready().map((n) => n.id)).not.toContain(node.id);
  });

  it("returns ok:false for an unknown node id without throwing", () => {
    const store = new SubtaskStore();
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);

    const result = ctl.bindOnDispatch("sub_missing", "sub_worker1");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown subtask/);
  });
});

describe("SubtaskController.syncFromSettledTask", () => {
  it("mirrors a completed worker onto the node and cascade-unblocks downstream", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second", blockedBy: [a.id] });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_w1");
    expect(store.get(b.id)?.status).toBe("blocked");

    ctl.syncFromSettledTask(settledTask({ id: "sub_w1", subtaskId: a.id, status: "completed", result: "did it" }));

    expect(store.get(a.id)?.status).toBe("completed");
    expect(store.get(a.id)?.resultSummary).toBe("did it");
    // Downstream B auto-unblocks to pending.
    expect(store.get(b.id)?.status).toBe("pending");
  });

  it("maps failed / cancelled task statuses onto the node", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_wa");
    ctl.bindOnDispatch(b.id, "sub_wb");

    ctl.syncFromSettledTask(settledTask({ id: "sub_wa", subtaskId: a.id, status: "failed", error: "boom" }));
    ctl.syncFromSettledTask(settledTask({ id: "sub_wb", subtaskId: b.id, status: "cancelled" }));

    expect(store.get(a.id)?.status).toBe("failed");
    expect(store.get(a.id)?.resultSummary).toBe("boom");
    expect(store.get(b.id)?.status).toBe("cancelled");
  });

  it("no-ops when the task carries no subtaskId", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    ctlBindAndAssertUntouched(store, a.id, settledTask({ id: "sub_x", status: "completed" }));
  });

  it("no-ops when an older attempt settles after the node was re-bound", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_old"); // first attempt
    ctl.bindOnDispatch(a.id, "sub_new"); // retry re-binds; latest = sub_new

    // The OLD attempt settling must not clobber the node bound to the retry.
    ctl.syncFromSettledTask(settledTask({ id: "sub_old", subtaskId: a.id, status: "failed", error: "old" }));

    expect(store.get(a.id)?.status).toBe("in_progress");
  });

  it("leaves the node untouched for non-terminal task states", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_w1");

    ctl.syncFromSettledTask(settledTask({ id: "sub_w1", subtaskId: a.id, status: "recoverable" }));

    expect(store.get(a.id)?.status).toBe("in_progress");
  });
});

function ctlBindAndAssertUntouched(store: SubtaskStore, nodeId: string, task: AsyncTaskRecord): void {
  const { host } = makeHost(store);
  const ctl = new SubtaskController(host);
  ctl.bindOnDispatch(nodeId, "sub_bound");
  ctl.syncFromSettledTask(task);
  // Node keeps its bound-dispatch state; the unrelated task is ignored.
  expect(store.get(nodeId)?.status).toBe("in_progress");
}

describe("SubtaskController.getDag stalled surfacing", () => {
  function dagCall(): ToolCallRecord {
    return { id: "call_dag", name: "get_dag", input: {}, status: "running" } as unknown as ToolCallRecord;
  }

  it("lists in_progress nodes whose active bound task is no longer live", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_w1");
    // Process restart downgraded the worker task; the node stays in_progress.
    host.session.asyncTasks = [settledTask({ id: "sub_w1", subtaskId: a.id, status: "recoverable" })];

    const payload = JSON.parse(ctl.getDag(dagCall()).output!) as {
      stalled?: Array<{ id: string; taskId: string; taskStatus: string }>;
      stalledHint?: string;
    };

    expect(payload.stalled).toEqual([{ id: a.id, title: "A", taskId: "sub_w1", taskStatus: "recoverable" }]);
    expect(payload.stalledHint).toMatch(/update_async_task/);
  });

  it("omits stalled while the bound task is live, and flags a missing task record", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.bindOnDispatch(a.id, "sub_w1");

    host.session.asyncTasks = [settledTask({ id: "sub_w1", subtaskId: a.id, status: "running" })];
    expect(JSON.parse(ctl.getDag(dagCall()).output!).stalled).toBeUndefined();

    // No task record at all (e.g. pruned) — surfaced as missing.
    host.session.asyncTasks = [];
    const payload = JSON.parse(ctl.getDag(dagCall()).output!) as { stalled?: Array<{ taskStatus: string }> };
    expect(payload.stalled?.[0]?.taskStatus).toBe("missing");
  });
});

describe("SubtaskController set_phase handoff gate", () => {
  it("allows entering the pipeline (null → plan) with no handoff", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);

    const obs = ctl.setPhaseFromTool(setPhaseCall("plan"));

    expect(obs.error).toBeUndefined();
    expect(session.phase).toBe("plan");
  });

  it("refuses leaving a working phase without a fresh handoff note", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec")); // enter working phase

    const obs = ctl.setPhaseFromTool(setPhaseCall("verify"));

    expect(obs.error).toMatch(/Refusing to advance phase exec → verify/);
    expect(session.phase).toBe("exec"); // transition did not happen
  });

  it("allows the transition once a fresh handoff note exists", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    session.notes.push(note({ id: "n_h1", tags: ["kind:handoff"] }));

    const obs = ctl.setPhaseFromTool(setPhaseCall("verify"));

    expect(obs.error).toBeUndefined();
    expect(session.phase).toBe("verify");
  });

  it("does not accept a stale handoff left over from an earlier stage", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);
    // Stale handoff written before the current stage was entered.
    session.notes.push(note({ id: "n_stale", createdAt: "2000-01-01T00:00:00.000Z" }));
    ctl.setPhaseFromTool(setPhaseCall("exec"));

    const obs = ctl.setPhaseFromTool(setPhaseCall("verify"));

    expect(obs.error).toMatch(/no handoff note written/);
    expect(session.phase).toBe("exec");
  });

  it("requires a NEW handoff for each successive transition", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    session.notes.push(note({ id: "n_h1" }));
    expect(ctl.setPhaseFromTool(setPhaseCall("verify")).error).toBeUndefined();

    // The exec→verify handoff is now stale relative to the verify stage.
    const obs = ctl.setPhaseFromTool(setPhaseCall("complete"));

    expect(obs.error).toMatch(/Refusing to advance phase verify → complete/);
  });

  it("refuses complete while DAG nodes are unsettled, listing them", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host, session } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    ctl.bindOnDispatch(a.id, "sub_w1"); // in_progress
    session.notes.push(note({ id: "n_h1" })); // fresh handoff — only the completeness gate should fire

    const obs = ctl.setPhaseFromTool(setPhaseCall("complete"));

    expect(obs.error).toMatch(/Refusing set_phase\("complete"\)/);
    expect(obs.error).toContain(a.id);
    expect(obs.error).toContain("in_progress");
    expect(session.phase).toBe("exec");
  });

  it("refuses complete while a node is failed, until it is cancelled", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host, session } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    ctl.bindOnDispatch(a.id, "sub_w1");
    ctl.syncFromSettledTask(settledTask({ id: "sub_w1", subtaskId: a.id, status: "failed", error: "boom" }));
    session.notes.push(note({ id: "n_h1" }));

    expect(ctl.setPhaseFromTool(setPhaseCall("complete")).error).toMatch(/failed/);

    // Explicitly cancelling the dead end settles the DAG.
    store.update(a.id, { status: "cancelled", resultSummary: "abandoned" });
    expect(ctl.setPhaseFromTool(setPhaseCall("complete")).error).toBeUndefined();
    expect(session.phase).toBe("complete");
  });

  it("allows complete when every node is completed or cancelled (and with an empty DAG)", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const { host, session } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    ctl.bindOnDispatch(a.id, "sub_w1");
    ctl.syncFromSettledTask(settledTask({ id: "sub_w1", subtaskId: a.id, status: "completed", result: "done" }));
    session.notes.push(note({ id: "n_h1" }));

    expect(ctl.setPhaseFromTool(setPhaseCall("complete")).error).toBeUndefined();
    expect(session.phase).toBe("complete");

    // Empty DAG: the completeness gate passes, only the handoff gate applies.
    const empty = makeHost(new SubtaskStore());
    const ctlEmpty = new SubtaskController(empty.host);
    ctlEmpty.setPhaseFromTool(setPhaseCall("exec"));
    empty.session.notes.push(note({ id: "n_h2" }));
    expect(ctlEmpty.setPhaseFromTool(setPhaseCall("complete")).error).toBeUndefined();
  });

  it("still allows the failed abort hatch with an unsettled DAG", () => {
    const store = new SubtaskStore();
    store.create({ title: "A", description: "first" });
    const { host, session } = makeHost(store);
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));

    expect(ctl.setPhaseFromTool(setPhaseCall("failed")).error).toBeUndefined();
    expect(session.phase).toBe("failed");
  });

  it("refuses a 4th entry into fix, and re-entering plan resets the budget", () => {
    const { host, session } = makeHost(new SubtaskStore());
    const ctl = new SubtaskController(host);
    ctl.setPhaseFromTool(setPhaseCall("exec"));
    let n = 0;
    const freshHandoff = () => session.notes.push(note({ id: `n_fix${n++}` }));

    // Three verify→fix rounds are within budget.
    for (let round = 0; round < 3; round++) {
      freshHandoff();
      expect(ctl.setPhaseFromTool(setPhaseCall("fix")).error).toBeUndefined();
      freshHandoff();
      expect(ctl.setPhaseFromTool(setPhaseCall("verify")).error).toBeUndefined();
    }

    // Fourth entry is refused BEFORE the handoff gate (fresh note present).
    freshHandoff();
    const obs = ctl.setPhaseFromTool(setPhaseCall("fix"));
    expect(obs.error).toMatch(/Refusing set_phase\("fix"\)/);
    expect(session.phase).toBe("verify");

    // Re-planning resets the budget; fix is allowed again.
    expect(ctl.setPhaseFromTool(setPhaseCall("plan")).error).toBeUndefined();
    freshHandoff();
    expect(ctl.setPhaseFromTool(setPhaseCall("fix")).error).toBeUndefined();
    expect(session.phase).toBe("fix");
  });

  it("exempts aborting (→ failed) and clearing (→ null) from the gate", () => {
    const abort = makeHost(new SubtaskStore());
    const ctlAbort = new SubtaskController(abort.host);
    ctlAbort.setPhaseFromTool(setPhaseCall("exec"));
    expect(ctlAbort.setPhaseFromTool(setPhaseCall("failed")).error).toBeUndefined();
    expect(abort.session.phase).toBe("failed");

    const clear = makeHost(new SubtaskStore());
    const ctlClear = new SubtaskController(clear.host);
    ctlClear.setPhaseFromTool(setPhaseCall("exec"));
    expect(ctlClear.setPhaseFromTool(setPhaseCall(null)).error).toBeUndefined();
    expect(clear.session.phase).toBeUndefined();
  });
});
