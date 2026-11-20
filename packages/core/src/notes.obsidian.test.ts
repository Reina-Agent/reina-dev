import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotesService, GLOBAL_WIKI_SCHEMA_SEED } from "./notes.js";

async function tempCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "reina-notes-"));
}

describe("notes ↔ Obsidian on-disk interop", () => {
  it("writes refs as wikilinks and tags with '/' but reads them back native", async () => {
    const cwd = await tempCwd();
    const svc = new NotesService(path.join(cwd, ".reina", "notes"));

    const parent = await svc.append({
      title: "parent",
      body: "root",
      tags: ["kind:finding", "sev:high"],
      refs: [],
      author: "a",
    });
    const child = await svc.append({
      title: "child",
      body: "depends on parent",
      tags: ["kind:hypothesis"],
      refs: [parent.id],
      author: "a",
    });

    // On disk: Obsidian-flavored (graph edges + nested tags work).
    const raw = await fs.readFile(
      path.join(cwd, ".reina", "notes", `${child.id}.md`),
      "utf-8",
    );
    expect(raw).toContain(`refs: ["[[${parent.id}]]"]`);
    expect(raw).toContain("kind/hypothesis");
    expect(raw).not.toContain("kind:hypothesis");
    // Title mirrored as an alias so Obsidian's quick switcher finds it by name.
    expect(raw).toContain("aliases: [child]");

    // Read back: native form, untouched by the interop wrapping.
    const back = await svc.read(child.id);
    expect(back?.meta.refs).toEqual([parent.id]);
    expect(back?.meta.tags).toEqual(["kind:hypothesis"]);

    const parentBack = await svc.read(parent.id);
    expect(parentBack?.meta.tags).toEqual(["kind:finding", "sev:high"]);
  });

  it("round-trips a path-valued tag without mangling the '/' in its value", async () => {
    const cwd = await tempCwd();
    const svc = new NotesService(path.join(cwd, ".reina", "notes"));
    const n = await svc.append({
      title: "path tag",
      body: "b",
      tags: ["file:apps/desktop/src/main/ipc.ts", "kind:finding"],
      refs: [],
      author: "a",
    });

    const raw = await fs.readFile(
      path.join(cwd, ".reina", "notes", `${n.id}.md`),
      "utf-8",
    );
    // On disk the namespace ':' and the path '/' are both '/': a nested tag.
    expect(raw).toContain("file/apps/desktop/src/main/ipc.ts");

    // Read back: only the namespace boundary flips back to ':'; the path
    // segments stay '/'.
    const back = await svc.read(n.id);
    expect(back?.meta.tags).toEqual([
      "file:apps/desktop/src/main/ipc.ts",
      "kind:finding",
    ]);
  });

  it("maintains index.md, log.md, schema.md as derived artifacts that aren't re-parsed as notes", async () => {
    const cwd = await tempCwd();
    const dir = path.join(cwd, ".reina", "notes");
    const svc = new NotesService(path.join(cwd, ".reina", "notes"));

    const a = await svc.append({ title: "finding a", body: "x", tags: ["kind:finding"], refs: [], author: "u", status: "confirmed" });
    const b = await svc.append({ title: "orphan b", body: "y", tags: ["kind:concept"], refs: [], author: "u" });
    await svc.append({ title: "cites a", body: "z", tags: ["kind:finding"], refs: [a.id], author: "u" });

    // index.md: groups by kind, links every note, flags the orphan.
    const index = await fs.readFile(path.join(dir, "index.md"), "utf-8");
    expect(index).toContain(`[[${a.id}]]`);
    expect(index).toContain("## finding");
    expect(index).toContain("## concept");
    expect(index).toContain("⚠ Orphans");
    expect(index).toContain(`[[${b.id}]]`); // b is isolated → listed as orphan

    // log.md: one append-only line per change.
    const log = await fs.readFile(path.join(dir, "log.md"), "utf-8");
    expect(log).toContain("# Activity log");
    expect((log.match(/\*\*created\*\*/g) ?? []).length).toBe(3);

    // schema.md seeded with both presets.
    const schema = await fs.readFile(path.join(dir, "schema.md"), "utf-8");
    expect(schema).toContain("audit dossier");
    expect(schema).toContain("general knowledge wiki");

    // A fresh service scanning the same dir must NOT surface the derived
    // files as notes (they'd be malformed findings).
    const svc2 = new NotesService(path.join(cwd, ".reina", "notes"));
    await svc2.init();
    const ids = svc2.list().map((n) => n.id).sort();
    expect(ids).toEqual(["n_001", "n_002", "n_003"]);
  });

  it("does not re-seed schema.md once the user has edited it", async () => {
    const cwd = await tempCwd();
    const dir = path.join(cwd, ".reina", "notes");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "schema.md"), "# my custom schema\n", "utf-8");

    const svc = new NotesService(path.join(cwd, ".reina", "notes"));
    await svc.init();
    const schema = await fs.readFile(path.join(dir, "schema.md"), "utf-8");
    expect(schema).toBe("# my custom schema\n");
  });

  it("global tier: uses the g_ id prefix and its own schema seed", async () => {
    const root = await tempCwd();
    const dir = path.join(root, "notes"); // global lives at <REINA_HOME>/notes
    const svc = new NotesService(dir, { idPrefix: "g", schemaSeed: GLOBAL_WIKI_SCHEMA_SEED });

    const a = await svc.append({ title: "user prefers Chinese replies", body: "b", tags: ["kind:preference"], refs: [], author: "parent" });
    expect(a.id).toBe("g_001");
    // refs across g_ ids validate + parse like n_ ids.
    const b = await svc.append({ title: "builds on a", body: "c", tags: ["kind:technique"], refs: [a.id], author: "parent" });
    expect(b.id).toBe("g_002");
    expect((await svc.read(b.id))?.meta.refs).toEqual([a.id]);

    const schema = await fs.readFile(path.join(dir, "schema.md"), "utf-8");
    expect(schema).toContain("Global notebook schema");
    expect(schema).toContain("kind:preference");
  });

  it("append never overwrites an existing note file (crash / concurrency safe)", async () => {
    const cwd = await tempCwd();
    const dir = path.join(cwd, ".reina", "notes");
    await fs.mkdir(dir, { recursive: true });
    // A note file already on disk that the in-memory nextSeq doesn't know about
    // (e.g. written by another live session). append must skip past it, not
    // clobber it.
    await fs.writeFile(
      path.join(dir, "n_001.md"),
      ["---", "id: n_001", "title: pre-existing", "status: open", "author: other", "createdAt: 2026-01-01T00:00:00.000Z", "tags: []", "refs: []", "---", "", "keep me", ""].join("\n"),
      "utf-8",
    );

    const svc = new NotesService(dir);
    const fresh = await svc.append({ title: "new", body: "b", tags: [], refs: [], author: "parent" });
    expect(fresh.id).toBe("n_002"); // init() scanned n_001 → nextSeq advanced
    // The pre-existing note is untouched.
    expect((await svc.read("n_001"))?.meta.title).toBe("pre-existing");
  });

  it("still parses legacy files written without wikilinks / '/'", async () => {
    const cwd = await tempCwd();
    const dir = path.join(cwd, ".reina", "notes");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "n_001.md"),
      [
        "---",
        "id: n_001",
        "title: legacy",
        "status: open",
        "author: a",
        "createdAt: 2026-01-01T00:00:00.000Z",
        "tags: [kind:finding, sev:high, file:apps/desktop/src/main/ipc.ts]",
        "refs: [n_000]",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf-8",
    );

    const svc = new NotesService(path.join(cwd, ".reina", "notes"));
    const back = await svc.read("n_001");
    // The path tag already has its ':' — the '/'s are path text, not a
    // namespace boundary, and must survive untouched.
    expect(back?.meta.tags).toEqual([
      "kind:finding",
      "sev:high",
      "file:apps/desktop/src/main/ipc.ts",
    ]);
    expect(back?.meta.refs).toEqual(["n_000"]);
  });
});
