import { describe, it, expect } from "vitest";
import type { NoteIndexEntry, SessionState } from "@reina/protocol";
import { formatNotesIndexPrompt } from "../engine-prompt.js";
import { validateNoteQuality } from "./notes.js";

function entry(i: number, over: Partial<NoteIndexEntry> = {}): NoteIndexEntry {
  return {
    id: `n_${String(i).padStart(3, "0")}`,
    title: `note ${i}`,
    tags: [],
    refs: [],
    status: "open",
    author: "parent",
    createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
    ...over,
  };
}

function sessionWith(notes: NoteIndexEntry[]): SessionState {
  return { notes, isSubagent: false } as unknown as SessionState;
}

describe("validateNoteQuality (soft write-side nudges)", () => {
  it("is silent for a small, typed, well-formed note", () => {
    expect(
      validateNoteQuality({ body: "short finding", tags: ["kind:finding"], refs: [], status: "open" }),
    ).toEqual([]);
  });

  it("nudges when no kind:* tag is present", () => {
    const w = validateNoteQuality({ body: "x", tags: ["component:notes"], status: "open" });
    expect(w.some((m) => m.includes("kind:"))).toBe(true);
  });

  it("nudges confirmed-without-refs but accepts confirmed-with-refs", () => {
    expect(
      validateNoteQuality({ body: "x", tags: ["kind:finding"], refs: [], status: "confirmed" })
        .some((m) => m.includes("confirmed")),
    ).toBe(true);
    expect(
      validateNoteQuality({ body: "x", tags: ["kind:finding"], refs: ["n_001"], status: "confirmed" })
        .some((m) => m.includes("confirmed")),
    ).toBe(false);
  });

  it("nudges on oversized analysis-dump bodies", () => {
    const big = "line\n".repeat(200);
    expect(
      validateNoteQuality({ body: big, tags: ["kind:finding"] }).some((m) => m.includes("dump")),
    ).toBe(true);
  });
});

describe("formatNotesIndexPrompt (read-side working set)", () => {
  it("pins dead-ends so a ruled-out path survives past the recency window", () => {
    const dead = entry(0, {
      status: "dead",
      title: "ruled out path",
      createdAt: "2025-12-31T00:00:00.000Z", // oldest → would fall off recency
    });
    const opens = Array.from({ length: 35 }, (_, k) => entry(k + 1));
    const out = formatNotesIndexPrompt(sessionWith([dead, ...opens]));
    expect(out).toContain("n_000");
    expect(out).toContain("(dead)");
  });

  it("signals hidden notes instead of truncating silently", () => {
    const opens = Array.from({ length: 36 }, (_, k) => entry(k + 1));
    const out = formatNotesIndexPrompt(sessionWith(opens));
    // 36 open, none pinned → recent caps at 30, 6 hidden.
    expect(out).toContain("hidden 6");
    expect(out).toContain("⚠");
    expect(out).toContain("list_notes()");
  });

  it("does not warn about truncation when everything fits", () => {
    const out = formatNotesIndexPrompt(sessionWith([entry(1), entry(2), entry(3)]));
    expect(out).not.toContain("⚠");
    expect(out).not.toContain("hidden");
  });
});
