import { describe, expect, it } from "vitest";
import type { SubtaskRecord } from "@reina/protocol";
import { SubtaskStore } from "./subtasks.js";

describe("SubtaskStore", () => {
  it("creates a subtask with sane defaults", () => {
    const store = new SubtaskStore();
    const node = store.create({ title: "Plan auth", description: "Outline" });
    expect(node.id).toMatch(/^sub_/);
    expect(node.title).toBe("Plan auth");
    expect(node.status).toBe("pending");
    expect(node.blockedBy).toEqual([]);
    expect(node.blocks).toEqual([]);
    expect(node.owner).toBe("");
    expect(store.list()).toHaveLength(1);
  });

  it("rejects blockedBy referencing unknown ids", () => {
    const store = new SubtaskStore();
    expect(() => store.create({ title: "x", description: "y", blockedBy: ["sub_missing"] }))
      .toThrow(/unknown blockedBy/);
  });

  it("marks newly-created nodes blocked when deps are not yet completed", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second", blockedBy: [a.id] });
    expect(b.status).toBe("blocked");
    // Patch reverse edge on A.
    const aAfter = store.get(a.id);
    expect(aAfter?.blocks).toContain(b.id);
  });

  it("auto-unblocks downstream nodes when an upstream completes", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second", blockedBy: [a.id] });
    const c = store.create({ title: "C", description: "third", blockedBy: [b.id] });
    expect(b.status).toBe("blocked");
    expect(c.status).toBe("blocked");
    store.update(a.id, { status: "completed" });
    // B is now pending; C is still blocked because B is non-terminal.
    expect(store.get(b.id)?.status).toBe("pending");
    expect(store.get(c.id)?.status).toBe("blocked");
    store.update(b.id, { status: "completed" });
    expect(store.get(c.id)?.status).toBe("pending");
  });

  it("refuses to add an edge that would create a cycle", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second", blockedBy: [a.id] });
    expect(() => store.update(a.id, { addBlockedBy: [b.id] })).toThrow(/cycle/);
  });

  it("refuses self-edges", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "x" });
    expect(() => store.update(a.id, { addBlockedBy: [a.id] })).toThrow(/self-edge/);
  });

  it("removes an isolated node and rejects removing one with downstream blocks", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "first" });
    const b = store.create({ title: "B", description: "second", blockedBy: [a.id] });
    expect(() => store.remove(a.id)).toThrow(/downstream/);
    // Cancel b first then remove.
    expect(store.remove(b.id)).toBe(true);
    expect(store.remove(a.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("emits change events for create / update / cascade", () => {
    const store = new SubtaskStore();
    const events: Array<{ id: string; change: string; status: SubtaskRecord["status"] }> = [];
    store.onChange(({ subtask, change }) => events.push({ id: subtask.id, change, status: subtask.status }));
    const a = store.create({ title: "A", description: "x" });
    const b = store.create({ title: "B", description: "y", blockedBy: [a.id] });
    store.update(a.id, { status: "completed" });
    // create A, create B (blocked), update A → completed, cascade B → pending
    expect(events.map((e) => `${e.change}:${e.status}`)).toEqual([
      "created:pending",
      "created:blocked",
      "updated:completed",
      "updated:pending",
    ]);
    expect(events[3]!.id).toBe(b.id);
  });

  it("ready() returns only pending nodes with all deps completed", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "x" });
    const b = store.create({ title: "B", description: "y" });
    const c = store.create({ title: "C", description: "z", blockedBy: [a.id, b.id] });
    expect(store.ready().map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    store.update(a.id, { status: "completed" });
    expect(store.ready().map((n) => n.id)).toEqual([b.id]);
    store.update(b.id, { status: "completed" });
    expect(store.ready().map((n) => n.id)).toEqual([c.id]);
  });

  it("ready(owner) filters by owner", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "x", owner: "worker-1" });
    const b = store.create({ title: "B", description: "y", owner: "worker-2" });
    expect(store.ready("worker-1").map((n) => n.id)).toEqual([a.id]);
    expect(store.ready("worker-2").map((n) => n.id)).toEqual([b.id]);
    expect(store.ready("worker-3")).toEqual([]);
  });

  it("treats failed/cancelled deps as not-blocking (coordinator decides)", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "x" });
    const b = store.create({ title: "B", description: "y", blockedBy: [a.id] });
    store.update(a.id, { status: "failed" });
    // B should auto-flip to pending — coordinator can decide whether to also fail B.
    expect(store.get(b.id)?.status).toBe("pending");
  });

  it("hydrate() rebuilds in-memory state and recomputes blocks edges", () => {
    const original = new SubtaskStore();
    const a = original.create({ title: "A", description: "x" });
    const b = original.create({ title: "B", description: "y", blockedBy: [a.id] });
    original.update(a.id, { status: "completed" });
    const snapshot = original.list();
    // Wipe blocks edges to simulate a session whose rollout didn't capture
    // them. hydrate() must repair from blockedBy.
    const corrupted = snapshot.map((node) => ({ ...node, blocks: [] }));
    const restored = new SubtaskStore();
    restored.hydrate(corrupted);
    expect(restored.get(a.id)?.blocks).toEqual([b.id]);
    expect(restored.get(b.id)?.blockedBy).toEqual([a.id]);
    expect(restored.get(b.id)?.status).toBe("pending");
  });

  it("update() returns null for unknown id without throwing", () => {
    const store = new SubtaskStore();
    expect(store.update("sub_nope", { status: "completed" })).toBeNull();
  });

  it("toMermaid() produces a valid-looking graph TD source", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "Read", description: "x" });
    const b = store.create({ title: "Write", description: "y", blockedBy: [a.id] });
    const src = store.toMermaid();
    expect(src.startsWith("graph TD")).toBe(true);
    expect(src).toContain(a.id);
    expect(src).toContain(b.id);
    expect(src).toContain(`${a.id} --> ${b.id}`);
  });

  it("bindAsyncTaskId appends without duplicates", () => {
    const store = new SubtaskStore();
    const a = store.create({ title: "A", description: "x" });
    store.update(a.id, { bindAsyncTaskId: "task_1" });
    store.update(a.id, { bindAsyncTaskId: "task_2" });
    store.update(a.id, { bindAsyncTaskId: "task_1" }); // dup
    expect(store.get(a.id)?.asyncTaskIds).toEqual(["task_1", "task_2"]);
  });
});
