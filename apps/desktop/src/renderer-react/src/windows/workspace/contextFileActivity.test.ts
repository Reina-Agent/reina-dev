import { describe, expect, it } from "vitest";
import type { ContextRequestDetail } from "@reina/protocol";
import { contextFileActivity, contextPatchPaths } from "./contextFileActivityModel";

function snapshot(messages: unknown[], observations: unknown[] = []): ContextRequestDetail {
  return {
    request: { id: "request", sessionId: "session", turnId: "turn", attempt: 1, startedAt: "2026-09-10T00:00:00Z", status: "completed", provider: "test", model: "test",
      breakdown: { createdAt: "2026-09-10T00:00:00Z", provider: "test", model: "test", messagesCount: 0, observationsCount: 0, toolsCount: 0,
        systemPromptChars: 0, systemPromptTokens: 0, messagesChars: 0, messagesTokens: 0, observationsChars: 0, observationsTokens: 0,
        toolsDescriptionChars: 0, toolsSchemaChars: 0, toolsTokens: 0, totalChars: 0, estimatedInputTokens: 0, toolNames: [] } },
    sections: [
      { id: "messages", label: "Messages", items: messages.map((value, index) => ({ id: `m${index}`, label: "message", content: JSON.stringify({ role: "user", toolResult: value }) })) },
      { id: "observations", label: "Observations", items: observations.map((value, index) => ({ id: `o${index}`, label: "observation", content: JSON.stringify(value) })) },
    ],
  };
}

describe("retained context file operations", () => {
  it("groups explicit paths, preserves failed attempts, and never guesses success from arbitrary output", () => {
    const activity = contextFileActivity(snapshot([
      { callId: "read", name: "read_file", input: { path: ".\\src\\a.ts" }, output: "File text" },
      { callId: "write", name: "write_file", input: { filePath: "src/a.ts", content: "changed" }, output: "Created src/a.ts", status: "completed" },
      { callId: "edit", name: "edit_file", input: { file_path: "src/a.ts", oldText: "old", newText: "new" }, error: "read first" },
    ]));
    expect(activity.files).toHaveLength(1);
    expect(activity.files[0]).toMatchObject({ path: "src/a.ts", counts: { read: 1, write: 2, search: 0, image: 0 } });
    expect(activity.files[0]!.operations.map(({ status }) => status)).toEqual(["recorded", "completed", "failed"]);
    expect(activity.unresolved).toBe(0);
  });

  it("merges the same call across historical messages and pending observations without double counting", () => {
    const activity = contextFileActivity(snapshot([{ callId: "same", name: "read_file", input: { path: "a.txt" }, output: "old preview" }],
      [{ callId: "same", name: "read_file", output: "complete result", error: "failed" }]));
    expect(activity.calls).toBe(1);
    expect(activity.counts.read).toBe(1);
    expect(activity.files[0]!.operations[0]).toMatchObject({ input: { path: "a.txt" }, output: "complete result", error: "failed", status: "failed" });
  });

  it("counts an image only when the retained read result contains an image attachment", () => {
    const activity = contextFileActivity(snapshot([
      { name: "read_file", input: { path: "image.png" }, attachments: [{ kind: "image", mime: "image/png", dataBase64: "[omitted]" }] },
      { name: "read_file", input: { path: "missing.png" }, error: "not found" },
    ]));
    expect(activity.counts).toEqual({ read: 1, write: 0, search: 0, image: 1 });
  });

  it("does not infer file activity from shell commands, arbitrary tools, or missing arguments", () => {
    const activity = contextFileActivity(snapshot([
      { name: "run_shell", input: { command: "cat a.txt; rm b.txt" }, output: "a.txt" },
      { name: "mcp__server__read_file", input: { path: "private.txt" }, output: "text" },
      { name: "read_file", output: "Read a.txt" },
    ]));
    expect(activity.calls).toBe(1);
    expect(activity.files).toEqual([]);
    expect(activity.unresolved).toBe(1);
  });
});

describe("search result attribution", () => {
  it("attributes grep and glob to returned files, never the directory argument or trailer text", () => {
    const activity = contextFileActivity(snapshot([
      { callId: "grep", name: "grep", input: { path: "src", pattern: "needle" }, output: "<note>2 file(s) with matches.</note>\nsrc/a.ts\nsrc/b.ts\n\nThe output above was truncated to fit context, but the complete verbatim copy was saved to disk.\n...[full output saved to ignored.txt]" },
      { callId: "glob", name: "glob", input: { path: "src", pattern: "*.ts" }, output: "<note>1 file(s) matching `*.ts`, newest first.</note>\nsrc/a.ts" },
    ]));
    expect(activity.files.map(({ path }) => path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(activity.files[0]!.counts.search).toBe(2);
    expect(activity.counts.search).toBe(2);
    expect(activity.truncated).toBe(true);
  });

  it("parses content/count modes without confusing matched text with a path", () => {
    const activity = contextFileActivity(snapshot([
      { name: "grep", input: { pattern: "needle", output_mode: "content" }, output: "src/a.ts:2:needle:also/a/path.ts\nsrc/a.ts:3:next\nC:/work/b.ts:4:needle" },
      { name: "grep", input: { pattern: "needle", output_mode: "count" }, output: "src/c.ts:12" },
    ]));
    expect(activity.files.map(({ path }) => path)).toEqual(["C:/work/b.ts", "src/a.ts", "src/c.ts"]);
    expect(activity.files.find(({ path }) => path === "src/a.ts")!.operations).toHaveLength(1);
  });

  it("keeps zero matches empty and reports unsupported/ambiguous result formats as unresolved", () => {
    const activity = contextFileActivity(snapshot([
      { name: "grep", input: { path: "src", pattern: "none" }, output: "No matches for /none/ under src." },
      { name: "glob", input: { path: "src", pattern: "none" }, output: "No files match `none` under src." },
      { name: "grep", input: { path: "src", output_mode: "content", "-n": false }, output: "src/a.ts:ambiguous text" },
    ]));
    expect(activity.files).toEqual([]);
    expect(activity.unresolved).toBe(1);
  });

  it.each(["grep", "glob"])("drops the partial path before a %s character-replay cut and never parses the detached tail", (name) => {
    const header = name === "glob" ? "<note>200 file(s) matching `*.ts`, newest first.</note>\n" : "<note>200 file(s) with matches.</note>\n";
    const activity = contextFileActivity(snapshot([{ name, input: { pattern: "*.ts" },
      output: `${header}packages/core/src/gc.ts\npackages/core/src/engine.tool-dedup.test.ts\npackages/co\n… [390 chars truncated] …\n/src/controllers/notes-quality.test.ts`,
    }]));
    expect(activity.files.map(({ path }) => path)).toEqual(["packages/core/src/engine.tool-dedup.test.ts", "packages/core/src/gc.ts"]);
    expect(activity.truncated).toBe(true);
  });

  it("keeps complete final paths at natural newlines and whole-line tool truncation boundaries", () => {
    const activity = contextFileActivity(snapshot([
      { callId: "newline", name: "grep", output: "<note>2 file(s) with matches.</note>\na.ts\n\n… [100 chars truncated] …\n/b.ts" },
      { callId: "lines", name: "grep", output: "<note>2 file(s) with matches.</note>\nc.ts\n...[truncated 10 lines from tail]" },
      { callId: "bytes", name: "glob", output: "<note>2 file(s) matching `*.ts`, newest first.</note>\nd.ts\n...[truncated 100 bytes from tail]" },
      { callId: "eof", name: "grep", output: "<note>1 file(s) with matches.</note>\ne.ts" },
    ]));
    expect(activity.files.map(({ path }) => path)).toEqual(["a.ts", "c.ts", "d.ts", "e.ts"]);
    expect(activity.truncated).toBe(true);
  });

  it("drops an unterminated last path when the saved item itself is marked truncated", () => {
    const detail = snapshot([{ name: "grep", output: "<note>2 file(s) with matches.</note>\na.ts\npackages/co" }]);
    detail.sections[0]!.items[0]!.truncated = true;
    expect(contextFileActivity(detail).files.map(({ path }) => path)).toEqual(["a.ts"]);
  });
});

describe("patch paths", () => {
  it("includes add/delete/rename targets and ignores file-header-like hunk content", () => {
    const patch = [
      "--- a/first.txt", "+++ b/first.txt", "@@ -1,1 +1,1 @@", "--- a/fake.txt", "+++ b/fake.txt",
      "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,1 @@", "+new",
      "--- a/deleted.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-old",
      "diff --git a/old.txt b/renamed.txt", "rename from old.txt", "rename to renamed.txt",
    ].join("\n");
    expect(contextPatchPaths(patch)).toEqual(["first.txt", "new.txt", "deleted.txt", "old.txt", "renamed.txt"]);
    const activity = contextFileActivity(snapshot([{ name: "apply_patch", input: { patch }, output: "Applied patch" }]));
    expect(activity.files).toHaveLength(5);
    expect(activity.counts.write).toBe(1);
  });

  it("does not misdecode quoted paths or turn patch body text into file paths", () => {
    expect(contextPatchPaths('--- "a/quoted\\040file.txt"\n+++ "b/quoted\\040file.txt"\n@@ -1 +1 @@\n-before\n+after')).toEqual([]);
    expect(contextPatchPaths("not a diff mentioning /tmp/file.txt")).toEqual([]);
  });
});
