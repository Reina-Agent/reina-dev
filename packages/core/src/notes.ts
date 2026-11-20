import { promises as fs } from "node:fs";
import path from "node:path";
import { fromObsidianTag, fromWikiRef, toObsidianTag, toWikiRef, type NoteIndexEntry, type NoteStatus } from "@reina/protocol";

/** Disk-backed shared audit notebook. Each note is a Markdown file with
 * YAML frontmatter at `<cwd>/.reina/notes/<id>.md`. The service holds
 * an in-memory index of all notes and offers append-only writes;
 * AgentEngine syncs the index into session.notes on every change. */

/** Derived, human/Obsidian-facing files the service maintains inside the
 * notes dir. They are NOT notes — skipped on scan, regenerated from the
 * index — so they must never be parsed back as findings. */
const RESERVED_FILES = new Set(["index.md", "log.md", "schema.md"]);

export type NoteBody = {
  meta: NoteIndexEntry;
  body: string;
};

export type AppendInput = {
  title: string;
  body: string;
  tags?: string[];
  refs?: string[];
  status?: NoteStatus;
  author: string;
  /** Optional directed recipient (team mode). When set, this note is a
   * direct message intended for the named worker / coordinator inbox. Regular
   * list_notes hides directed notes from non-recipients. */
  recipient?: string;
};

/** Patch fields for `update`. `id`, `author`, `createdAt`, and `recipient`
 * are immutable — the latter is a routing primitive, the rest are
 * identity / history. Any field present in the patch (even with an empty
 * array) overwrites; absent fields are preserved from the existing entry. */
export type UpdateInput = {
  title?: string;
  body?: string;
  tags?: string[];
  refs?: string[];
  status?: NoteStatus;
};

export type NotesChangeEvent = {
  note: NoteIndexEntry;
  change: "created" | "modified" | "deleted";
};

type Listener = (event: NotesChangeEvent) => void;

export class NotesService {
  private readonly notesDir: string;
  private readonly idPrefix: string;
  private readonly schemaSeed: string;
  private index: NoteIndexEntry[] = [];
  private initialized = false;
  /** Highest sequence number observed so far. New ids = nextSeq + 1. */
  private nextSeq = 0;
  private listeners = new Set<Listener>();

  /** `notesDir` is the full directory (workspace: `<cwd>/.reina/notes`,
   * global: `<REINA_HOME>/notes`). `idPrefix` namespaces the tier so ids
   * never collide across notebooks (`n_*` workspace, `g_*` global), and
   * `schemaSeed` is the tier's default schema.md prose. */
  constructor(notesDir: string, opts?: { idPrefix?: string; schemaSeed?: string }) {
    this.notesDir = notesDir;
    this.idPrefix = opts?.idPrefix ?? "n";
    this.schemaSeed = opts?.schemaSeed ?? WIKI_SCHEMA_SEED;
  }

  /** Subscribe to note changes. Returns an unsubscribe fn. The owning
   * AgentEngine uses this to forward notes-updated stream events. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: NotesChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not poison the writer.
      }
    }
  }

  /** Scan disk and rebuild the in-memory index. Idempotent. Called on
   * session boot. Tolerates a missing directory (empty dossier). */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.notesDir, { recursive: true });
      await this.seedSchema();
      const files = await fs.readdir(this.notesDir);
      const entries: NoteIndexEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        if (RESERVED_FILES.has(file)) continue;
        const fullPath = path.join(this.notesDir, file);
        try {
          const raw = await fs.readFile(fullPath, "utf-8");
          const parsed = parseNoteFile(raw);
          if (parsed) {
            entries.push(parsed.meta);
            const seq = idToSeq(parsed.meta.id);
            if (seq > this.nextSeq) this.nextSeq = seq;
          }
        } catch {
          // skip malformed files; surfacing here would crash the engine
        }
      }
      entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.index = entries;
      // Rebuild the landing page on boot so a crash mid-session can't leave a
      // stale index.md. Best-effort — a derived artifact never blocks boot.
      await this.writeIndex();
    } finally {
      this.initialized = true;
    }
  }

  /** Regenerate index.md and append to log.md after a mutation. Both are
   * derived Obsidian-facing artifacts — failures are swallowed so a full
   * disk or locked file can never poison a note write. */
  private async afterChange(change: NotesChangeEvent["change"], entry: NoteIndexEntry): Promise<void> {
    await this.writeIndex();
    await this.appendLog(change, entry);
  }

  /** Seed the wiki schema once. This is the llm-wiki "schema" layer — prose
   * the agent reads (never parsed by code) that says how THIS notebook is
   * organized. Default = the audit preset (matches the built-in prompt); the
   * user can edit it or switch to the general-wiki preset described inside.
   * Never overwrites an existing file — the user owns it after seeding. */
  private async seedSchema(): Promise<void> {
    try {
      const schemaPath = path.join(this.notesDir, "schema.md");
      try {
        await fs.access(schemaPath);
        return; // already seeded / user-owned
      } catch {
        // absent — seed the default
      }
      await fs.writeFile(schemaPath, this.schemaSeed, "utf-8");
    } catch {
      // best-effort — a missing schema never blocks the notebook
    }
  }

  private async writeIndex(): Promise<void> {
    try {
      await fs.writeFile(path.join(this.notesDir, "index.md"), buildIndexMd(this.index), "utf-8");
    } catch {
      // derived artifact — never surface
    }
  }

  private async appendLog(change: NotesChangeEvent["change"], entry: NoteIndexEntry): Promise<void> {
    try {
      const logPath = path.join(this.notesDir, "log.md");
      let head = "";
      try {
        await fs.access(logPath);
      } catch {
        head = "# Activity log\n\nAppend-only record of notebook changes (newest at the bottom).\n\n";
      }
      const stamp = new Date().toISOString();
      await fs.appendFile(logPath, `${head}- ${stamp} · **${change}** [[${entry.id}]] — ${entry.title}\n`, "utf-8");
    } catch {
      // derived artifact — never surface
    }
  }

  /** Append a new note. Writes the file, updates the in-memory index,
   * returns the index entry. Caller (engine) emits the stream event. */
  async append(input: AppendInput): Promise<NoteIndexEntry> {
    await this.init();
    const { id, file } = await this.nextFreeId();
    const recipient = input.recipient?.trim() || undefined;
    const entry: NoteIndexEntry = {
      id,
      title: input.title,
      tags: dedupe(input.tags ?? []),
      refs: dedupe(input.refs ?? []),
      status: input.status ?? "open",
      author: input.author,
      ...(recipient ? { recipient } : {}),
      createdAt: new Date().toISOString(),
    };
    const content = serializeNoteFile(entry, input.body);
    await fs.writeFile(file, content, "utf-8");
    this.index.push(entry);
    this.emit({ note: entry, change: "created" });
    await this.afterChange("created", entry);
    return entry;
  }

  /** Update fields on an existing note. Body and metadata are merged with
   * the on-disk copy; the original `id`, `author`, `createdAt`, and
   * `recipient` are preserved. Returns the new index entry, or null if
   * the note doesn't exist (caller maps that to a tool error). */
  async update(id: string, patch: UpdateInput): Promise<NoteIndexEntry | null> {
    await this.init();
    const file = path.join(this.notesDir, `${id}.md`);
    let existing: NoteBody | null;
    try {
      const raw = await fs.readFile(file, "utf-8");
      existing = parseNoteFile(raw);
    } catch {
      return null;
    }
    if (!existing) return null;
    const idx = this.index.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;
    const merged: NoteIndexEntry = {
      ...existing.meta,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.tags !== undefined ? { tags: dedupe(patch.tags) } : {}),
      ...(patch.refs !== undefined ? { refs: dedupe(patch.refs) } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    const nextBody = patch.body !== undefined ? patch.body : existing.body;
    await fs.writeFile(file, serializeNoteFile(merged, nextBody), "utf-8");
    const nextIndex = this.index.slice();
    nextIndex[idx] = merged;
    this.index = nextIndex;
    this.emit({ note: merged, change: "modified" });
    await this.afterChange("modified", merged);
    return merged;
  }

  /** Delete a note from disk and from the in-memory index. Sequence
   * numbers are NOT reused — `nextSeq` keeps growing so old refs in the
   * audit trail never get accidentally rebound to a different finding.
   * Returns the removed entry, or null if the id wasn't tracked. */
  async delete(id: string): Promise<NoteIndexEntry | null> {
    await this.init();
    const idx = this.index.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;
    const removed = this.index[idx]!;
    const file = path.join(this.notesDir, `${id}.md`);
    try {
      await fs.unlink(file);
    } catch (err) {
      // ENOENT means the file was already gone — still scrub the index
      // so the model's view matches reality.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw err;
    }
    const next = this.index.slice();
    next.splice(idx, 1);
    this.index = next;
    this.emit({ note: removed, change: "deleted" });
    await this.afterChange("deleted", removed);
    return removed;
  }

  /** Read a single note's full body from disk. Returns null if missing. */
  async read(id: string): Promise<NoteBody | null> {
    await this.init();
    const file = path.join(this.notesDir, `${id}.md`);
    try {
      const raw = await fs.readFile(file, "utf-8");
      return parseNoteFile(raw);
    } catch {
      return null;
    }
  }

  /** Allocate the next unused id. Normally `nextSeq + 1`, but we probe disk
   * so an existing note is never overwritten — covers a crash that left
   * `nextSeq` stale and low-contention concurrent writers on the shared
   * global notebook (two live sessions writing `g_*` at once).
   * ponytail: probe-until-free, not a lock; two writers in the same tick
   * could still pick the same id — add a lock if global writes get hot. */
  private async nextFreeId(): Promise<{ id: string; file: string }> {
    let seq = this.nextSeq;
    for (;;) {
      seq += 1;
      const id = `${this.idPrefix}_${String(seq).padStart(3, "0")}`;
      const file = path.join(this.notesDir, `${id}.md`);
      try {
        await fs.access(file);
        // exists — skip and try the next sequence number
      } catch {
        this.nextSeq = seq;
        return { id, file };
      }
    }
  }

  /** Index snapshot (a copy, safe for the caller to mutate). */
  list(): NoteIndexEntry[] {
    return this.index.map((entry) => ({ ...entry, tags: [...entry.tags], refs: [...entry.refs] }));
  }
}

// ─── frontmatter helpers (minimal, no js-yaml dependency) ──────────────

// Obsidian interop (toObsidianTag / fromObsidianTag / toWikiRef / fromWikiRef)
// lives in @reina/protocol — it is the shared on-disk contract between this
// writer and the desktop main-process reader (apps/desktop/src/main/ipc.ts),
// which must parse the same frontmatter without depending on core.

function serializeNoteFile(meta: NoteIndexEntry, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`title: ${quoteIfNeeded(meta.title)}`);
  // Obsidian's quick switcher only matches filenames (n_001) and aliases —
  // mirror the title as an alias so notes are findable by name. Write-only:
  // parseNoteFile ignores the key, and rewrites re-derive it from title.
  if (meta.title) lines.push(`aliases: [${quoteIfNeeded(meta.title)}]`);
  lines.push(`status: ${meta.status}`);
  lines.push(`author: ${meta.author}`);
  if (meta.recipient) lines.push(`recipient: ${quoteIfNeeded(meta.recipient)}`);
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`tags: ${serializeStringList(meta.tags.map(toObsidianTag))}`);
  lines.push(`refs: ${serializeStringList(meta.refs.map(toWikiRef))}`);
  lines.push("---");
  lines.push("");
  lines.push(body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

function serializeStringList(items: string[]): string {
  if (items.length === 0) return "[]";
  return `[${items.map(quoteIfNeeded).join(", ")}]`;
}

function quoteIfNeeded(s: string): string {
  // Quote when contains special chars, leading/trailing whitespace, or
  // would otherwise confuse the inline-array parser. Conservative: quote
  // anything that isn't pure [\w.:/-]+.
  if (s === "") return '""';
  if (/^[\w.:/+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** Strict, minimal frontmatter parser for our own file format. Returns
 * null if the file does not start with `---\n...---\n`. */
function parseNoteFile(raw: string): NoteBody | null {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;
  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s?(.*)$/);
    if (!m) continue;
    fm[m[1]!] = m[2] ?? "";
  }
  const id = fm.id?.trim();
  const title = parseScalar(fm.title);
  const status = fm.status?.trim();
  const author = fm.author?.trim();
  const createdAt = fm.createdAt?.trim();
  if (!id || !title || !status || !author || !createdAt) return null;
  const tags = parseStringList(fm.tags ?? "[]").map(fromObsidianTag);
  const refs = parseStringList(fm.refs ?? "[]").map(fromWikiRef);
  const recipientRaw = fm.recipient ? parseScalar(fm.recipient) : "";
  const recipient = recipientRaw.trim() || undefined;
  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return {
    meta: {
      id,
      title,
      status: status as NoteStatus,
      author,
      createdAt,
      tags,
      refs,
      ...(recipient ? { recipient } : {}),
    },
    body,
  };
}

function parseScalar(raw: string | undefined): string {
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseStringList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  // Split top-level commas; respect JSON-string quoting.
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  let inString = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inString) {
      buf += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        buf += inner[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      out.push(parseScalar(buf));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(parseScalar(buf));
  return out;
}

/** Default wiki schema, seeded once into `<cwd>/.reina/notes/schema.md`. It
 * is the llm-wiki "schema" layer: prose the agent reads (via read_file), not
 * config the code parses. Ships the audit preset as the default plus a
 * general-wiki preset the user can switch to by editing this file. */
const WIKI_SCHEMA_SEED = `# Wiki schema

How this notebook is organized. Knowledge **compounds** here: when you learn
something new, fold it into the relevant existing note (\`update_note\`) instead
of always appending a fresh one, and link related notes with \`refs\` so the
graph and \`index.md\` stay connected.

Auto-maintained for you (do not hand-edit): \`index.md\` (grouped landing page)
and \`log.md\` (activity log). Every note is a Markdown file with YAML
frontmatter; \`refs\` render as Obsidian \`[[wikilinks]]\`.

## Operations

- **ingest** — new source/observation: read it, then either update an existing
  note or write a new one, and set \`refs\` to link what it connects to.
- **query** — \`list_notes\` (filter by tag/status/refs) then \`read_note(id)\`.
- **lint** — periodically scan for contradictions, stale claims, and orphans
  (see the \`⚠ Orphans\` section of \`index.md\`); reconcile or link them.

## Active preset: audit dossier (default)

Page kinds (\`kind:*\` tag) and lifecycle (\`status\`):

- \`kind:finding\` — a concrete result. Use \`status:confirmed\` once evidenced
  (cite support in \`refs\`), else \`status:open\`.
- \`kind:hypothesis\` — a suspicion not yet verified (stays pinned across rounds).
- \`kind:decision\` / \`kind:goal\` / \`kind:handoff\` — anchors.
- \`status:dead\` — a ruled-out lead (2–3 sentences on why, so it isn't re-run).

## Alternative preset: general knowledge wiki

To repurpose this notebook as a general wiki, use these kinds instead and edit
this section to match your domain:

- \`kind:overview\` — a top-level map of an area.
- \`kind:entity\` — a person / system / component / place.
- \`kind:concept\` — an idea or mechanism.
- \`kind:summary\` — a distilled source.

The engine treats both presets identically — \`index.md\` groups by whatever
\`kind:*\` you use. Only this file and your tagging change.
`;

/** Default schema for the GLOBAL notebook (\`<REINA_HOME>/notes\`, id prefix
 * \`g_\`). Unlike the workspace notebook (per-project audit dossier), this is
 * cross-project durable memory — it persists across every session and repo,
 * so keep it about knowledge that stays true when you switch projects. */
export const GLOBAL_WIKI_SCHEMA_SEED = `# Global notebook schema

This is your **cross-project memory** — it lives at \`<REINA_HOME>/notes\` and is
injected into every session in every repository. Keep it for knowledge that
stays true across projects; project-specific findings belong in the workspace
notebook (\`.reina/notes\`, id prefix \`n_\`) instead.

Knowledge **compounds** here: when you learn something durable, fold it into the
relevant existing note (\`update_note\`) instead of appending a near-duplicate,
and link related notes with \`refs\` so the graph stays connected. \`index.md\`
and \`log.md\` are auto-maintained — do not hand-edit.

## What belongs here

- \`kind:preference\` — how this user likes to work (tone, review depth, what to
  skip, recurring corrections). This is the highest-value tier: it makes you fit
  the user better every session.
- \`kind:technique\` — a reusable method / recipe that worked and would work again
  elsewhere. If it's a full procedure worth invoking by name, prefer writing it
  as a **skill** (\`.claude/skills/<name>/SKILL.md\`) instead; use a note for the
  smaller "remember to do X this way" learnings.
- \`kind:concept\` — a general idea or mechanism worth remembering.
- \`kind:entity\` — a tool / service / person / environment quirk you keep hitting.
- \`kind:summary\` — a distilled source (doc, article, investigation) kept for reuse.

## Operations

- **ingest** — learned something durable and cross-project: update an existing
  note if one fits, else write a new one; set \`refs\` to link what it connects to.
- **query** — \`list_notes(scope:"global")\` then \`read_note(id, scope:"global")\`.
- **lint** — periodically reconcile contradictions and stale claims; a preference
  the user has since overridden should be updated, not left to mislead you.
`;

/** Regenerate the Obsidian/human landing page from the index. Derived, never
 * a source of truth. Generic on purpose so it serves any wiki preset: notes
 * group by their `kind:*` page-type (audit preset uses kind:finding /
 * kind:hypothesis / …; a general wiki uses kind:entity / kind:concept / …),
 * falling back to `status` for notes with no kind. Every note is an Obsidian
 * wikilink, and isolated notes (no refs, cited by no one) surface under an
 * Orphans heading — the cheap llm-wiki lint signal. */
function buildIndexMd(entries: NoteIndexEntry[]): string {
  const kindOf = (e: NoteIndexEntry): string => {
    const k = e.tags.find((t) => t.startsWith("kind:"));
    return k ? k.slice("kind:".length) || "unfiled" : e.status;
  };
  const groups = new Map<string, NoteIndexEntry[]>();
  for (const e of entries) {
    const g = kindOf(e);
    const arr = groups.get(g);
    if (arr) arr.push(e);
    else groups.set(g, [e]);
  }
  const referenced = new Set<string>();
  for (const e of entries) for (const r of e.refs) referenced.add(r);
  const orphans = entries.filter((e) => e.refs.length === 0 && !referenced.has(e.id));

  const line = (e: NoteIndexEntry): string =>
    `- [[${e.id}]] — ${e.title}  \`(${e.status})\`${e.tags.length ? " · " + e.tags.join(", ") : ""}`;
  const byId = (a: NoteIndexEntry, b: NoteIndexEntry): number => a.id.localeCompare(b.id);

  const out: string[] = [
    "# Notebook index",
    "",
    `${entries.length} note${entries.length === 1 ? "" : "s"}. Auto-generated from the notebook — do not edit; open any \`[[link]]\` to jump.`,
    "",
  ];
  for (const g of [...groups.keys()].sort()) {
    const rows = groups.get(g)!.slice().sort(byId);
    out.push(`## ${g} (${rows.length})`, "", ...rows.map(line), "");
  }
  if (orphans.length > 0) {
    out.push(
      `## ⚠ Orphans (${orphans.length})`,
      "",
      "No refs and cited by no other note — link them in or confirm they stand alone.",
      "",
      ...orphans.slice().sort(byId).map(line),
      "",
    );
  }
  return out.join("\n");
}

function idToSeq(id: string): number {
  const m = id.match(/^[a-z]+_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
