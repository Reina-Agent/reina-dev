import { describe, expect, it } from "vitest";
import type { ContextRequestDetail } from "@reina/protocol";
import { contextBrowserContent, contextBrowserGroups, contextBrowserItems, filterContextBrowserItems } from "./contextBrowserModel";

type Item = ContextRequestDetail["sections"][number]["items"][number];
const item = (id: string, value: unknown, extra: Partial<Item> = {}): Item => ({
  id, label: id, content: typeof value === "string" ? value : JSON.stringify(value), ...extra,
});
function detail(sections: Record<string, Item[]>): ContextRequestDetail {
  return {
    request: { id: "request", sessionId: "session", turnId: "turn", attempt: 1, startedAt: "2026-09-10T00:00:00Z", status: "completed", provider: "test", model: "test",
      breakdown: { createdAt: "2026-09-10T00:00:00Z", provider: "test", model: "test", messagesCount: 0, observationsCount: 0, toolsCount: 0,
        systemPromptChars: 0, systemPromptTokens: 0, messagesChars: 0, messagesTokens: 0, observationsChars: 0, observationsTokens: 0,
        toolsDescriptionChars: 0, toolsSchemaChars: 0, toolsTokens: 0, totalChars: 0, estimatedInputTokens: 0, toolNames: [] } },
    sections: Object.entries(sections).map(([id, items]) => ({ id, label: id, items })),
  };
}

describe("context browser categories", () => {
  it("classifies old snapshots by their section and actual message role, preserving injected notices and tool pairs", () => {
    const items = contextBrowserItems(detail({
      system: [item("sys", "system")],
      tools: [item("tool", { name: "read_file" })],
      messages: [item("user", { role: "user", content: "hello" }), item("assistant", { role: "assistant", content: "answer" }),
        item("system", { role: "system", content: "injected" }), item("notice", { role: "user", origin: "task-notify", content: "done" }),
        item("result", { role: "user", toolResult: { name: "read_file", input: { path: "a" } }, content: "result" })],
      reminders: [item("reminder", "remember")], observations: [item("observation", { name: "read_file", output: "result" })],
      future: [item("unknown", "unknown input")],
    }));
    expect(items.map(({ category }) => category)).toEqual(["system", "tools", "user", "assistant", "system", "injected", "toolResults", "injected", "toolResults", "injected"]);
  });

  it("honors new metadata while retaining a useful role fallback for truncated old JSON", () => {
    const items = contextBrowserItems(detail({ messages: [
      item("explicit", { role: "user" }, { category: "injected" }),
      item("truncated", '{"role":"assistant",', { label: "4. assistant", truncated: true }),
      item("role", "bad JSON", { role: "user" }),
    ] }));
    expect(items.map(({ category }) => category)).toEqual(["injected", "assistant", "user"]);
    expect(contextBrowserContent(items[1]!)).toEqual({ blocks: [{ kind: "content", text: '{"role":"assistant",', markdown: true }], attachments: [] });
  });

  it("keeps identifiers stable across insertion and scopes duplicate IDs to their section", () => {
    const before = contextBrowserItems(detail({ messages: [item("same", "a")], tools: [item("same", "b")] }));
    const after = contextBrowserItems(detail({ messages: [item("new", "x"), item("same", "a")], tools: [item("same", "b")] }));
    expect(after.slice(1).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    expect(new Set(contextBrowserItems(detail({ messages: [item("same", "a"), item("same", "b")] })).map(({ id }) => id)).size).toBe(2);
  });

  it("attributes tools only from explicit source metadata or the protocol MCP name, without repeating names or roles", () => {
    const items = contextBrowserItems(detail({ tools: [
      item("read", { name: "read_file" }, { source: "read_file" }),
      item("mcp", { name: "mcp__github__list_issues" }, { source: "mcp__github__list_issues" }),
      item("plugin", { name: "custom" }, { source: "registered-plugin" }),
      item("unknown", { name: "probably_builtin" }),
    ], messages: [item("user", { role: "user" }, { source: "user" })] }));
    expect(items.map(({ source }) => source)).toEqual([null, "MCP · github", "registered-plugin", null, null]);
  });
});

describe("context browser differences and search", () => {
  it("reports signed category token and item changes, including completely removed categories", () => {
    const previous = detail({ tools: [item("old", {}, { tokens: 50 })], messages: [item("u", { role: "user" }, { tokens: 10 })] });
    const current = detail({ messages: [item("u", { role: "user" }, { tokens: 10 }), item("u2", { role: "user" }, { tokens: 20 })] });
    const groups = contextBrowserGroups(current, previous);
    expect(groups.find(({ category }) => category === "tools")).toMatchObject({ count: 0, countDelta: -1, tokens: 0, tokenDelta: -50 });
    expect(groups.find(({ category }) => category === "user")).toMatchObject({ count: 2, countDelta: 1, tokens: 30, tokenDelta: 20 });
    expect(contextBrowserGroups(current, null).every(({ tokenDelta, countDelta }) => tokenDelta === null && countDelta === null)).toBe(true);
  });

  it("does not invent token amounts or precise differences for missing and truncated inspection data", () => {
    const previous = detail({ tools: [item("a", {}, { tokens: 5 })] });
    const missing = contextBrowserGroups(detail({ tools: [item("a", {}), item("b", {}, { tokens: Number.NaN })] }), previous)[1]!;
    expect(missing).toMatchObject({ count: 2, tokens: null, countDelta: 1, tokenDelta: null });
    const truncated = contextBrowserGroups(detail({ tools: [item("a", "partial", { tokens: 10, truncated: true }),
      item("tools-omitted", "Inspection size limit reached.", { truncated: true })] }), previous)[1]!;
    expect(truncated).toMatchObject({ count: 1, tokens: null, countDelta: 0, tokenDelta: null, incomplete: true });
  });

  it("searches names, source and full saved content and sorts stably without changing original groups", () => {
    const items = contextBrowserItems(detail({ tools: [item("z", { name: "Zulu", description: "needle" }, { tokens: 5 }),
      item("b", { name: "Bravo" }, { tokens: 5, source: "needle-plugin" }), item("a", { name: "Alpha" })] }));
    expect(filterContextBrowserItems(items, "NEEDLE", "name").map(({ name }) => name)).toEqual(["Bravo", "Zulu"]);
    expect(filterContextBrowserItems(items, "", "tokens").map(({ name }) => name)).toEqual(["Zulu", "Bravo", "Alpha"]);
    expect(items.map(({ name }) => name)).toEqual(["Zulu", "Bravo", "Alpha"]);
  });
});

describe("context browser content", () => {
  it("shows paired tool arguments, canonical output, errors, and attachment metadata without inline payloads", () => {
    const [entry] = contextBrowserItems(detail({ messages: [item("tool", { role: "user", content: "wrapper", toolResult: {
      name: "read_file", input: { path: "a.png" }, output: "canonical", error: "failed", attachments: [{ kind: "image", name: "a.png", mime: "image/png", dataBase64: "[omitted]" }],
    } })] }));
    expect(contextBrowserContent(entry!)).toEqual({ blocks: [
      { kind: "arguments", text: '{\n  "path": "a.png"\n}', markdown: false },
      { kind: "result", text: "canonical", markdown: true },
      { kind: "error", text: "failed", markdown: true },
    ], attachments: [{ name: "a.png", kind: "image", mime: "image/png" }] });
  });

  it("separates readable reasoning and replies, and exposes schema definitions", () => {
    const [assistant, tool] = contextBrowserItems(detail({ messages: [item("a", { role: "assistant", reasoning: "thinking", content: "answer" })],
      tools: [item("tool", { name: "read_file", description: "Read a file", inputSchema: { type: "object" } })] }));
    expect(contextBrowserContent(assistant!).blocks.map(({ kind, text }) => [kind, text])).toEqual([["reasoning", "thinking"], ["content", "answer"]]);
    expect(contextBrowserContent(tool!).blocks.map(({ kind }) => kind)).toEqual(["description", "schema"]);
  });
});
