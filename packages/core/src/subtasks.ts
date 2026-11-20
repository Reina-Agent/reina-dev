import type { SubtaskRecord, TeamPhase } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";

/**
 * In-memory subtask DAG for team-mode (Phase C).
 *
 * The top-level session builds and mutates this DAG through coordinator tools
 * (create_subtask / update_subtask). Each mutation emits a change event
 * the engine forwards onto the model stream so the renderer can keep
 * the DAG visualization in sync without polling.
 *
 * Persistence model: SubtaskStore does NOT own a file. The owning engine
 * records every mutation as a `subtask` / `subtask_update` rollout item,
 * and the reducer materializes session.subtasks on replay. When a session
 * is loaded from disk we rebuild SubtaskStore in-memory from the
 * replayed list via `hydrate()`. This keeps SubtaskStore stateless on
 * disk — the rollout is the single source of truth.
 *
 * Concurrency: not thread-safe. Mutations come from the engine's single
 * model loop. The store is reentrant-safe though: `applyUpdate` can be
 * called from inside an `onChange` listener (the engine uses this to
 * cascade unblock notifications after a node completes).
 *
 * Terminal statuses: completed / failed / cancelled. A subtask in any of
 * these states does NOT block its downstream consumers; `isReady` treats
 * completed as "OK to start", and failed/cancelled as "permanently
 * unblock with coordinator awareness" — the coordinator can decide to skip vs.
 * retry, but the DAG view doesn't lock up.
 *
 * Cycle prevention: addBlockedBy refuses an edge that would close a
 * cycle. The check runs a DFS from the proposed new dependency back to
 * the subtask being added — O(V+E), fine for the DAGs we care about
 * (rarely > 50 nodes).
 */
export type SubtaskChangeKind = "created" | "updated" | "removed";

export type SubtaskChangeEvent = {
  subtask: SubtaskRecord;
  change: SubtaskChangeKind;
};

type Listener = (event: SubtaskChangeEvent) => void;

const TERMINAL_STATUSES = new Set<SubtaskRecord["status"]>(["completed", "failed", "cancelled"]);

export class SubtaskStore {
  /** Linear ordering preserved for stable DAG rendering (oldest first). */
  private readonly order: string[] = [];
  private readonly byId = new Map<string, SubtaskRecord>();
  private readonly listeners = new Set<Listener>();

  /** Rebuild the in-memory state from a persisted list (rollout replay).
   * Clears any existing state first. Does NOT emit change events — the
   * caller already has the final snapshot from the reducer. */
  hydrate(subtasks: ReadonlyArray<SubtaskRecord>): void {
    this.order.length = 0;
    this.byId.clear();
    for (const node of subtasks) {
      // Defensive copy + ensure blocks is recomputed from blockedBy so
      // a half-recorded rollout (e.g. older session that never wrote a
      // node's `blocks` field) still produces a consistent graph.
      const copy: SubtaskRecord = {
        ...node,
        blockedBy: [...node.blockedBy],
        blocks: [],
        asyncTaskIds: [...node.asyncTaskIds],
        tags: node.tags ? [...node.tags] : undefined,
      };
      this.byId.set(copy.id, copy);
      this.order.push(copy.id);
    }
    // Second pass: derive blocks edges from blockedBy.
    for (const node of this.byId.values()) {
      for (const depId of node.blockedBy) {
        const parent = this.byId.get(depId);
        if (!parent) continue;
        if (!parent.blocks.includes(node.id)) parent.blocks.push(node.id);
      }
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns deep-copied snapshots so callers can't mutate internal state.
   * Order is creation order (stable for rendering). */
  list(): SubtaskRecord[] {
    return this.order
      .map((id) => this.byId.get(id))
      .filter((node): node is SubtaskRecord => node !== undefined)
      .map((node) => cloneSubtask(node));
  }

  get(id: string): SubtaskRecord | null {
    const node = this.byId.get(id);
    return node ? cloneSubtask(node) : null;
  }

  /** Add a fresh subtask. Returns the canonical record (with id +
   * timestamps). Validates blockedBy ids exist and that no cycle is
   * introduced. Throws on either failure. */
  create(input: {
    title: string;
    description: string;
    owner?: string;
    blockedBy?: string[];
    phase?: TeamPhase;
    tags?: string[];
  }): SubtaskRecord {
    const id = createId("sub").replace("sub_", "sub_").slice(0, 14); // sub_<8 hex>
    if (this.byId.has(id)) {
      // Vanishingly rare but defensive: regenerate once.
      return this.create(input);
    }
    const blockedBy = dedupe(input.blockedBy ?? []);
    for (const depId of blockedBy) {
      if (!this.byId.has(depId)) {
        throw new Error(`SubtaskStore.create: unknown blockedBy id "${depId}"`);
      }
    }
    const now = nowIso();
    // Decide initial status: blocked if it has any non-completed deps,
    // pending otherwise.
    const initialStatus: SubtaskRecord["status"] = this.computeReadiness(blockedBy) === "ready" ? "pending" : "blocked";
    const node: SubtaskRecord = {
      id,
      title: input.title.trim(),
      description: input.description,
      owner: input.owner?.trim() ?? "",
      status: initialStatus,
      blockedBy,
      blocks: [],
      asyncTaskIds: [],
      phase: input.phase,
      tags: input.tags ? dedupe(input.tags) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, node);
    this.order.push(id);
    // Patch reverse edges.
    for (const depId of blockedBy) {
      const parent = this.byId.get(depId);
      if (parent && !parent.blocks.includes(id)) parent.blocks.push(id);
    }
    this.emit({ subtask: cloneSubtask(node), change: "created" });
    return cloneSubtask(node);
  }

  /** Apply a partial update by id. Validates status transitions are
   * meaningful (no-op updates are dropped to avoid stream spam).
   * Emits `updated` events for the target node AND for any downstream
   * nodes that became unblocked as a side-effect. Returns the final
   * canonical record (or null if id is unknown). */
  update(
    id: string,
    patch: {
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
    },
  ): SubtaskRecord | null {
    const current = this.byId.get(id);
    if (!current) return null;
    const next: SubtaskRecord = { ...current };
    let changed = false;
    if (patch.title !== undefined && patch.title.trim() !== current.title) {
      next.title = patch.title.trim();
      changed = true;
    }
    if (patch.description !== undefined && patch.description !== current.description) {
      next.description = patch.description;
      changed = true;
    }
    if (patch.owner !== undefined && (patch.owner.trim() || "") !== current.owner) {
      next.owner = patch.owner.trim();
      changed = true;
    }
    if (patch.phase !== undefined && patch.phase !== current.phase) {
      next.phase = patch.phase;
      changed = true;
    }
    if (patch.tags !== undefined) {
      const deduped = dedupe(patch.tags);
      if (!sameSet(deduped, current.tags ?? [])) {
        next.tags = deduped.length === 0 ? undefined : deduped;
        changed = true;
      }
    }
    if (patch.resultSummary !== undefined && patch.resultSummary !== current.resultSummary) {
      next.resultSummary = patch.resultSummary;
      changed = true;
    }
    if (patch.bindAsyncTaskId) {
      if (!current.asyncTaskIds.includes(patch.bindAsyncTaskId)) {
        next.asyncTaskIds = [...current.asyncTaskIds, patch.bindAsyncTaskId];
        changed = true;
      }
    }
    if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
      const additions: string[] = [];
      for (const depId of patch.addBlockedBy) {
        if (depId === id) throw new Error(`SubtaskStore.update: cannot add self-edge on ${id}`);
        if (!this.byId.has(depId)) throw new Error(`SubtaskStore.update: unknown blockedBy id "${depId}"`);
        if (current.blockedBy.includes(depId) || additions.includes(depId)) continue;
        if (this.wouldCreateCycle(id, depId)) {
          throw new Error(`SubtaskStore.update: adding edge ${depId}→${id} would create a cycle`);
        }
        additions.push(depId);
      }
      if (additions.length > 0) {
        next.blockedBy = [...current.blockedBy, ...additions];
        for (const depId of additions) {
          const parent = this.byId.get(depId);
          if (parent && !parent.blocks.includes(id)) parent.blocks.push(id);
        }
        changed = true;
      }
    }
    if (patch.removeBlockedBy && patch.removeBlockedBy.length > 0) {
      const toRemove = new Set(patch.removeBlockedBy);
      const filtered = current.blockedBy.filter((depId) => !toRemove.has(depId));
      if (filtered.length !== current.blockedBy.length) {
        next.blockedBy = filtered;
        // Remove reverse edge.
        for (const depId of toRemove) {
          const parent = this.byId.get(depId);
          if (parent) parent.blocks = parent.blocks.filter((cid) => cid !== id);
        }
        changed = true;
      }
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      next.status = patch.status;
      changed = true;
    } else if (patch.addBlockedBy || patch.removeBlockedBy) {
      // Auto-recompute the blocked/pending derived state when edges change.
      const ready = this.computeReadiness(next.blockedBy);
      if (current.status === "blocked" && ready === "ready") {
        next.status = "pending";
        changed = true;
      } else if (current.status === "pending" && ready === "blocked") {
        next.status = "blocked";
        changed = true;
      }
    }
    if (!changed) return cloneSubtask(current);
    next.updatedAt = nowIso();
    this.byId.set(id, next);
    this.emit({ subtask: cloneSubtask(next), change: "updated" });
    // Cascade: if this node just hit a terminal status, downstream
    // nodes whose blockedBy now resolves to ready may auto-unblock.
    if (TERMINAL_STATUSES.has(next.status) && !TERMINAL_STATUSES.has(current.status)) {
      this.cascadeUnblock(id);
    }
    return cloneSubtask(next);
  }

  /** Remove a node from the DAG. Refuses if any downstream subtask
   * still depends on it (would orphan blockedBy edges). Returns true on
   * success. Intended for fix-up after planning mistakes; the coordinator
   * usually prefers `cancelled` status over delete. */
  remove(id: string): boolean {
    const node = this.byId.get(id);
    if (!node) return false;
    if (node.blocks.length > 0) {
      throw new Error(`SubtaskStore.remove: ${id} still has ${node.blocks.length} downstream subtask(s); cancel instead`);
    }
    // Detach from upstream blocks lists.
    for (const depId of node.blockedBy) {
      const parent = this.byId.get(depId);
      if (parent) parent.blocks = parent.blocks.filter((cid) => cid !== id);
    }
    this.byId.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    this.emit({ subtask: cloneSubtask(node), change: "removed" });
    return true;
  }

  /** Subtasks that are `pending` AND have all blockedBy edges pointing
   * to completed nodes. Optionally filtered by owner. The coordinator uses
   * this to decide what worker to spawn next. */
  ready(owner?: string): SubtaskRecord[] {
    const out: SubtaskRecord[] = [];
    for (const id of this.order) {
      const node = this.byId.get(id);
      if (!node) continue;
      if (node.status !== "pending") continue;
      if (owner !== undefined && node.owner !== owner) continue;
      if (this.computeReadiness(node.blockedBy) !== "ready") continue;
      out.push(cloneSubtask(node));
    }
    return out;
  }

  /** Convenience: render the DAG as a Mermaid `graph TD` source string.
   * Used by the renderer if it wants a server-rendered fallback; the
   * renderer normally generates its own Mermaid from the JSON stream. */
  toMermaid(): string {
    const lines: string[] = ["graph TD"];
    if (this.order.length === 0) {
      lines.push('  empty["(no subtasks yet)"]');
      return lines.join("\n");
    }
    for (const id of this.order) {
      const node = this.byId.get(id);
      if (!node) continue;
      const label = escapeMermaidLabel(`${node.id.slice(4, 10)} ${node.title}`);
      lines.push(`  ${node.id}["${label}"]`);
    }
    for (const id of this.order) {
      const node = this.byId.get(id);
      if (!node) continue;
      for (const childId of node.blocks) lines.push(`  ${id} --> ${childId}`);
    }
    // Status classes.
    const classMap: Record<string, string[]> = {
      completed: [],
      in_progress: [],
      failed: [],
      cancelled: [],
      blocked: [],
    };
    for (const node of this.byId.values()) {
      if (node.status in classMap) classMap[node.status]!.push(node.id);
    }
    lines.push("  classDef completed fill:#86efac,stroke:#16a34a,color:#052e16");
    lines.push("  classDef in_progress fill:#93c5fd,stroke:#2563eb,color:#0c1e3a,stroke-dasharray:4 2");
    lines.push("  classDef failed fill:#fca5a5,stroke:#dc2626,color:#450a0a");
    lines.push("  classDef cancelled fill:#d4d4d8,stroke:#71717a,color:#27272a");
    lines.push("  classDef blocked fill:#fde68a,stroke:#d97706,color:#451a03");
    for (const [name, ids] of Object.entries(classMap)) {
      if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${name}`);
    }
    return lines.join("\n");
  }

  // ─── internals ──────────────────────────────────────────────────────

  private emit(event: SubtaskChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors must not poison subsequent listeners
      }
    }
  }

  private computeReadiness(blockedBy: ReadonlyArray<string>): "ready" | "blocked" {
    for (const depId of blockedBy) {
      const dep = this.byId.get(depId);
      if (!dep) continue; // unknown dep treated as resolved
      if (!TERMINAL_STATUSES.has(dep.status)) return "blocked";
      if (dep.status === "failed" || dep.status === "cancelled") {
        // failed/cancelled deps don't auto-block — the coordinator must decide
        // whether downstream work is still valid. We return "ready" so
        // the node shows up actionable; the coordinator can choose to mark the
        // downstream cancelled if appropriate.
        continue;
      }
    }
    return "ready";
  }

  private wouldCreateCycle(targetId: string, newDepId: string): boolean {
    // We're about to add edge newDep → target (newDep must complete
    // before target). A cycle exists iff target is already upstream of
    // newDep along the existing forward (blocks) edges — i.e. there's
    // a path target → ... → newDep already. Walking that path from
    // target detects it.
    const stack = [targetId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === newDepId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.byId.get(id);
      if (!node) continue;
      for (const downstream of node.blocks) stack.push(downstream);
    }
    return false;
  }

  private cascadeUnblock(completedId: string): void {
    const completed = this.byId.get(completedId);
    if (!completed) return;
    for (const downstreamId of completed.blocks) {
      const downstream = this.byId.get(downstreamId);
      if (!downstream) continue;
      if (downstream.status !== "blocked") continue;
      const ready = this.computeReadiness(downstream.blockedBy);
      if (ready === "ready") {
        const updated: SubtaskRecord = { ...downstream, status: "pending", updatedAt: nowIso() };
        this.byId.set(downstreamId, updated);
        this.emit({ subtask: cloneSubtask(updated), change: "updated" });
      }
    }
  }
}

function cloneSubtask(node: SubtaskRecord): SubtaskRecord {
  return {
    ...node,
    blockedBy: [...node.blockedBy],
    blocks: [...node.blocks],
    asyncTaskIds: [...node.asyncTaskIds],
    tags: node.tags ? [...node.tags] : undefined,
  };
}

function dedupe<T>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) if (!set.has(v)) return false;
  return true;
}

function escapeMermaidLabel(raw: string): string {
  // Mermaid breaks on `"` and `]`. Replace with safer chars.
  return raw.replace(/"/g, "'").replace(/]/g, ")").slice(0, 80);
}
