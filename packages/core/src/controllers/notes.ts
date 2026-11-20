import type { NoteIndexEntry, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { errorMessage } from "@reina/protocol";
import type { NotesService } from "../notes.js";
import { escapeXml } from "../subagent/format.js";
import { isBroadcastRecipient, normalizeRecipient } from "../subagent/index.js";

/** Minimal host surface the NotesController needs. The disk-backed
 * NotesService is async-init (scans the notes directory), so the host
 * exposes an async resolver instead of the raw handle — the controller
 * awaits it on every call. Subagents share the parent's instance and
 * report a different author tag via `noteAuthor()`. */
export type NoteScope = "workspace" | "global";

export interface NotesHost {
  readonly session: SessionState;
  resolveNotesService(scope?: NoteScope): Promise<NotesService | null>;
  noteAuthor(): string;
}

/** Owns the shared-notebook tools (note / list_notes / read_note /
 * update_note / delete_note). The disk-backed NotesService is owned by
 * the engine because subagents share their parent's instance — the
 * controller is the thin tool-handler bridge between dispatch and that
 * service, plus the directed-note recipient filtering policy. */
export class NotesController {
  constructor(private readonly host: NotesHost) {}

  /** Route the tool to the workspace (default) or global notebook. */
  private scopeOf(input: { scope?: string }): NoteScope {
    return input.scope === "global" ? "global" : "workspace";
  }

  /** The in-memory index for a scope (workspace dossier vs global memory). */
  private indexFor(scope: NoteScope): NoteIndexEntry[] {
    return (scope === "global" ? this.host.session.globalNotes : this.host.session.notes) ?? [];
  }

  async append(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      const input = record.input as {
        title?: string;
        body?: string;
        tags?: string[];
        refs?: string[];
        status?: "open" | "confirmed" | "dead" | "todo";
        scope?: "workspace" | "global";
      };
      const scope = this.scopeOf(input);
      const title = input.title?.trim();
      const body = input.body;
      if (!title) throw new Error("note requires a non-empty title");
      if (!body || !body.trim()) throw new Error("note requires a non-empty body");
      const service = await this.host.resolveNotesService(scope);
      if (!service) throw new Error("Notes service is not available in this session");
      // Validate refs target existing notes — guards against the model
      // hallucinating ids that don't exist yet. Cheap: index is in memory.
      const known = new Set(this.indexFor(scope).map((entry) => entry.id));
      const refs = (input.refs ?? []).map((r) => r.trim()).filter(Boolean);
      const unknown = refs.filter((r) => !known.has(r));
      if (unknown.length > 0) {
        throw new Error(
          `refs reference unknown note ids: ${unknown.join(", ")}. Call list_notes first to find real ids.`,
        );
      }
      const entry = await service.append({
        title,
        body,
        tags: input.tags,
        refs,
        status: input.status,
        author: this.host.noteAuthor(),
      });
      // Soft, principle-level quality nudges. Never block the write — just
      // echo warnings so the model self-corrects over time. This is the
      // write-boundary feedback the notebook relies on: untyped, oversized,
      // or unsupported notes are what make the dossier unreadable and cause
      // re-runs down the line.
      const warnings = validateNoteQuality({ body, tags: input.tags, refs, status: entry.status });
      return {
        callId: record.id,
        name: record.name,
        output: [
          `<note>`,
          `<id>${entry.id}</id>`,
          `<status>${entry.status}</status>`,
          ...(warnings.length > 0
            ? [`<warnings>`, ...warnings.map((w) => `- ${w}`), `</warnings>`]
            : []),
          `<hint>Recorded. Do not re-read your own note this turn — the body is already in your context above.</hint>`,
          `</note>`,
        ].join("\n"),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  list(record: ToolCallRecord): ToolObservation {
    try {
      const input = record.input as {
        tags?: string[];
        status?: "open" | "confirmed" | "dead" | "todo";
        refs_any?: string[];
        since?: string;
        limit?: number;
        recipient?: string;
        includeDirected?: boolean;
        scope?: "workspace" | "global";
      };
      const all = this.indexFor(this.scopeOf(input));
      const tagFilter = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
      const refsAny = new Set((input.refs_any ?? []).map((r) => r.trim()).filter(Boolean));
      const since = input.since;
      const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
      const recipientFilter = input.recipient?.trim();
      // Directed-note default policy:
      //  - Coordinator (non-subagent) sees everything (it's the orchestrator)
      //  - Subagents see only their addressed notes + un-addressed ones
      //  - `recipient` explicitly named: match exactly + un-addressed shown
      //  - `includeDirected: true` bypasses filtering entirely
      const callerAuthor = this.host.noteAuthor();
      let filtered = all;
      if (tagFilter.length > 0) {
        filtered = filtered.filter((entry) => tagFilter.every((tag) => entry.tags.includes(tag)));
      }
      if (input.status) {
        filtered = filtered.filter((entry) => entry.status === input.status);
      }
      if (refsAny.size > 0) {
        filtered = filtered.filter((entry) => entry.refs.some((r) => refsAny.has(r)));
      }
      if (since) {
        filtered = filtered.filter((entry) => entry.createdAt >= since);
      }
      if (!input.includeDirected) {
        if (recipientFilter) {
          filtered = filtered.filter(
            (entry) => !entry.recipient || entry.recipient === recipientFilter || isBroadcastRecipient(entry.recipient),
          );
        } else if (this.host.session.isSubagent) {
          filtered = filtered.filter(
            (entry) => !entry.recipient || entry.recipient === callerAuthor || isBroadcastRecipient(entry.recipient),
          );
        }
        // Non-subagent coordinator/parent without an explicit recipient filter:
        // see everything (including broadcasts). The coordinator is the
        // supervisor — hiding directed notes from it would defeat the point.
      }
      // Newest first (audit usage prioritizes recent observations).
      filtered = filtered.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      // Group by reasoning role so the on-demand listing reads the same way as
      // the auto-injected index and the desktop panel. groupKey mirrors
      // noteGroupKey in engine-prompt.ts / renderer notes.js — keep in sync.
      const groupKey = (entry: NoteIndexEntry): string =>
        entry.status === "confirmed" ? "confirmed"
        : entry.status === "dead" ? "dead"
        : entry.tags.includes("kind:hypothesis") ? "hypothesis"
        : entry.tags.includes("kind:goal") || entry.tags.includes("kind:handoff") ? "anchor"
        : "open";
      const groupOrder: ReadonlyArray<readonly [string, string]> = [
        ["confirmed", "Confirmed findings & chains"],
        ["hypothesis", "Hypotheses — verify or refute"],
        ["dead", "Dead ends"],
        ["open", "Open leads"],
        ["anchor", "Goals & handoffs"],
      ];
      const body: string[] = [];
      for (const [key, heading] of groupOrder) {
        const rows = filtered.filter((entry) => groupKey(entry) === key);
        if (rows.length === 0) continue;
        body.push(`<group name="${heading}" count="${rows.length}">`);
        for (const entry of rows) body.push(formatNoteIndexLine(entry));
        body.push(`</group>`);
      }
      return {
        callId: record.id,
        name: record.name,
        output: [
          `<notes>`,
          `<total>${all.length}</total>`,
          `<shown>${filtered.length}</shown>`,
          ...body,
          `</notes>`,
        ].join("\n"),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  async read(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      const input = record.input as { id?: string; scope?: "workspace" | "global" };
      const id = input.id?.trim();
      if (!id) throw new Error("read_note requires an id");
      const service = await this.host.resolveNotesService(this.scopeOf(input));
      if (!service) throw new Error("Notes service is not available in this session");
      const note = await service.read(id);
      if (!note) {
        return { callId: record.id, name: record.name, error: `no such note: ${id}` };
      }
      const { meta, body } = note;
      return {
        callId: record.id,
        name: record.name,
        output: [
          `<note id="${meta.id}" status="${meta.status}" author="${meta.author}" createdAt="${meta.createdAt}">`,
          `<title>${escapeXml(meta.title)}</title>`,
          meta.tags.length > 0 ? `<tags>${meta.tags.map(escapeXml).join(", ")}</tags>` : "",
          meta.refs.length > 0 ? `<refs>${meta.refs.join(", ")}</refs>` : "",
          `<body>`,
          body,
          `</body>`,
          `</note>`,
        ].filter(Boolean).join("\n"),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  async update(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      const input = record.input as {
        id?: string;
        title?: string;
        body?: string;
        tags?: string[];
        refs?: string[];
        status?: "open" | "confirmed" | "dead" | "todo";
        scope?: "workspace" | "global";
      };
      const scope = this.scopeOf(input);
      const id = input.id?.trim();
      if (!id) throw new Error("update_note requires an id");
      const hasPatch =
        input.title !== undefined ||
        input.body !== undefined ||
        input.tags !== undefined ||
        input.refs !== undefined ||
        input.status !== undefined;
      if (!hasPatch) {
        throw new Error("update_note requires at least one of: title, body, tags, refs, status");
      }
      if (input.title !== undefined && !input.title.trim()) {
        throw new Error("title cannot be empty");
      }
      if (input.body !== undefined && !input.body.trim()) {
        throw new Error("body cannot be empty");
      }
      const service = await this.host.resolveNotesService(scope);
      if (!service) throw new Error("Notes service is not available in this session");
      // Same refs-existence guard as `note` — guards against id hallucinations.
      // Self-reference is allowed (rare but legal): a note can cite itself
      // if it's an amendment to its own earlier statement.
      const patchRefs = input.refs;
      if (patchRefs !== undefined) {
        const known = new Set(this.indexFor(scope).map((entry) => entry.id));
        const cleaned = patchRefs.map((r) => r.trim()).filter(Boolean);
        const unknown = cleaned.filter((r) => !known.has(r));
        if (unknown.length > 0) {
          throw new Error(
            `refs reference unknown note ids: ${unknown.join(", ")}. Call list_notes first to find real ids.`,
          );
        }
      }
      const updated = await service.update(id, {
        title: input.title !== undefined ? input.title.trim() : undefined,
        body: input.body,
        tags: input.tags,
        refs: input.refs,
        status: input.status,
      });
      if (!updated) {
        return { callId: record.id, name: record.name, error: `no such note: ${id}` };
      }
      return {
        callId: record.id,
        name: record.name,
        output: [
          `<note>`,
          `<id>${updated.id}</id>`,
          `<status>${updated.status}</status>`,
          `<change>modified</change>`,
          `<hint>Patched on disk. Do not re-read this note this turn — your patch is in your context above.</hint>`,
          `</note>`,
        ].join("\n"),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  /** send_to_worker — a directed note with a recipient tag. Semantically a
   * targeted message in team mode, mechanically just a note.append() with a
   * recipient field + a `dm` tag (plus `broadcast` for `*`, plus
   * `subtask:<id>` when the message scopes to a DAG node). */
  async sendToWorker(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      const input = record.input as {
        recipient: string;
        subject: string;
        body: string;
        subtaskId?: string;
      };
      const recipient = normalizeRecipient(input.recipient);
      const subject = input.subject?.trim();
      const body = input.body;
      if (!recipient) throw new Error("send_to_worker requires a recipient (use \"*\" to broadcast to all workers)");
      if (!subject) throw new Error("send_to_worker requires a subject");
      if (!body || !body.trim()) throw new Error("send_to_worker requires a body");
      const service = await this.host.resolveNotesService();
      if (!service) throw new Error("Notes service is not available — directed messages require an initialized workspace");
      const tags = ["dm"];
      if (isBroadcastRecipient(recipient)) tags.push("broadcast");
      const subtaskId = input.subtaskId?.trim();
      if (subtaskId) tags.push(`subtask:${subtaskId}`);
      const entry = await service.append({
        title: subject,
        body,
        tags,
        refs: [],
        status: "open",
        author: this.host.noteAuthor(),
        recipient,
      });
      return {
        callId: record.id,
        name: record.name,
        output: JSON.stringify(
          {
            id: entry.id,
            recipient: entry.recipient,
            subject: entry.title,
          },
          null,
          2,
        ),
      };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }

  async delete(record: ToolCallRecord): Promise<ToolObservation> {
    try {
      const input = record.input as { id?: string; scope?: "workspace" | "global" };
      const scope = this.scopeOf(input);
      const id = input.id?.trim();
      if (!id) throw new Error("delete_note requires an id");
      const service = await this.host.resolveNotesService(scope);
      if (!service) throw new Error("Notes service is not available in this session");
      // Snapshot dependents BEFORE the delete fires so we can warn the
      // model about now-dangling refs. We don't cascade — explicit cleanup
      // by the model is safer than silent collateral damage.
      const dependents = this.indexFor(scope)
        .filter((entry) => entry.id !== id && entry.refs.includes(id))
        .map((entry) => entry.id);
      const removed = await service.delete(id);
      if (!removed) {
        return { callId: record.id, name: record.name, error: `no such note: ${id}` };
      }
      const lines: string[] = [
        `<note>`,
        `<id>${removed.id}</id>`,
        `<change>deleted</change>`,
      ];
      if (dependents.length > 0) {
        lines.push(`<orphaned-refs>${dependents.join(", ")}</orphaned-refs>`);
        lines.push(
          `<hint>The notes above had refs:[${id}] — now dangling. Call update_note on them if the link still matters, or leave the dangle if the merge is intentional.</hint>`,
        );
      }
      lines.push(`</note>`);
      return { callId: record.id, name: record.name, output: lines.join("\n") };
    } catch (error) {
      return { callId: record.id, name: record.name, error: errorMessage(error) };
    }
  }
}

/** Soft, principle-level note-quality checks. Returns human-readable
 * warnings (never throws, never blocks) that `note` echoes back so the model
 * converges on a readable dossier. Intentionally generic — no target-specific
 * names — so the guidance stays principle-level rather than over-fit:
 *  - no `kind:*`  → the note can't join the pinned working set and silently
 *    falls off the recency window (the "forgot my own note, re-ran it" bug).
 *  - `confirmed` without refs → a claimed fact with no cited support.
 *  - oversized body → an analysis dump; expensive to re-read, crowds the
 *    notebook. Long material belongs in a file, referenced by path. */
export function validateNoteQuality(input: {
  body: string;
  tags?: string[];
  refs?: string[];
  status?: "open" | "confirmed" | "dead" | "todo";
}): string[] {
  const warnings: string[] = [];
  const tags = input.tags ?? [];
  if (!tags.some((t) => t.trim().startsWith("kind:"))) {
    warnings.push(
      "No kind:* tag. Add one (e.g. kind:finding | kind:candidate | kind:hypothesis | kind:decision | kind:dead) so this note joins the pinned working set instead of scrolling out of context.",
    );
  }
  if ((input.status ?? "open") === "confirmed" && (input.refs ?? []).length === 0) {
    warnings.push(
      "status:confirmed but no refs. A confirmed finding should cite the note(s) or evidence it rests on, or be left as status:open until verified.",
    );
  }
  const body = input.body ?? "";
  if (body.length > 6000 || body.split("\n").length > 120) {
    warnings.push(
      "Large note — looks like an analysis dump. Keep one note to a single finding / lead / decision; move long material into a file and reference its path. Oversized notes are costly to re-read and push other notes out of the notebook.",
    );
  }
  return warnings;
}

/** Render one note as the compact index row list_notes returns. Status +
 * tags + refs + recipient are inline so the model can scan many rows in a
 * narrow window. Body is NOT included — the model pulls it explicitly via
 * read_note(id). */
function formatNoteIndexLine(entry: NoteIndexEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
  const refs = entry.refs.length > 0 ? ` ←${entry.refs.join(",")}` : "";
  const recipient = entry.recipient ? ` →${entry.recipient}` : "";
  return `  ${entry.id} (${entry.status}) ${escapeXml(entry.title)}${tags}${refs}${recipient}`;
}
