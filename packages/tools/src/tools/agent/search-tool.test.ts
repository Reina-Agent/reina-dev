import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeferredCatalogEntry,
  searchCatalog,
  searchToolTool,
  setDeferredCatalogProvider,
  tokenize,
} from "./search-tool.js";
import type { ToolRuntimeOptions } from "../../types.js";
import * as mcpRuntime from "../../mcp-runtime.js";
import type { McpRuntimeTool } from "../../mcp-runtime.js";
import { z } from "zod";

describe("tokenize", () => {
  it("splits snake_case and camelCase ASCII into stemmed parts", () => {
    expect(tokenize("start_async_task")).toEqual(["start", "async", "task"]);
    expect(tokenize("taskOutput")).toEqual(["task", "output"]);
  });

  it("drops mcp__server__tool separators down to alnum parts", () => {
    expect(tokenize("mcp__github__create_issue")).toEqual(["mcp", "github", "create", "issue"]);
  });

  it("stems trailing plural 's' uniformly but leaves 'ss'", () => {
    expect(tokenize("notes")).toEqual(["note"]);
    expect(tokenize("goals")).toEqual(["goal"]);
    expect(tokenize("css")).toEqual(["css"]);
  });

  it("emits unigrams and bigrams for CJK runs", () => {
    expect(tokenize("后台任务")).toEqual(["后", "台", "任", "务", "后台", "台任", "任务"]);
  });
});

describe("searchCatalog", () => {
  const catalog: DeferredCatalogEntry[] = [
    { name: "start_async_task", summary: "Start a background async task and return its id." },
    { name: "wait_async_tasks", summary: "Block until background async tasks finish." },
    { name: "note", summary: "Append a note to the shared dossier." },
    { name: "schedule_wakeup", summary: "Schedule a future wakeup for this session." },
    { name: "mcp__github__create_issue", summary: "[MCP:github] Create a GitHub issue." },
  ];

  it("returns nothing for an empty catalog or blank query", () => {
    expect(searchCatalog([], "task", 8)).toEqual([]);
    expect(searchCatalog(catalog, "   ", 8)).toEqual([]);
  });

  it("ranks an exact tool-name hit first", () => {
    const results = searchCatalog(catalog, "note", 8);
    expect(results[0]?.name).toBe("note");
  });

  it("matches a multi-word capability query via token overlap", () => {
    const results = searchCatalog(catalog, "background async task", 8);
    const names = results.map((r) => r.name);
    expect(names).toContain("start_async_task");
    expect(names).toContain("wait_async_tasks");
    // an unrelated tool should not surface
    expect(names).not.toContain("note");
  });

  it("finds MCP tools through the namespaced name", () => {
    const results = searchCatalog(catalog, "github issue", 8);
    expect(results[0]?.name).toBe("mcp__github__create_issue");
  });

  it("honours the limit", () => {
    expect(searchCatalog(catalog, "async task background note schedule", 2)).toHaveLength(2);
  });

  it("matches CJK queries when the corpus contains CJK", () => {
    const cjk: DeferredCatalogEntry[] = [
      { name: "start_async_task", summary: "启动后台任务并返回 id。" },
      { name: "note", summary: "向共享档案追加一条笔记。" },
    ];
    const results = searchCatalog(cjk, "后台任务", 8);
    expect(results[0]?.name).toBe("start_async_task");
  });

  it("returns empty when nothing matches at all", () => {
    expect(searchCatalog(catalog, "zzzznonexistent", 8)).toEqual([]);
  });
});

describe("searchToolTool.execute — output shape", () => {
  // Catalog entries carry `params` so the model can dispatch on its next turn
  // without a second descriptor-fetch round-trip. These tests install a
  // synthetic catalog and assert the wire shape (parseable XML-ish blocks +
  // actionable hint).
  const runtimeOptions = { cwd: "." } as ToolRuntimeOptions;

  beforeEach(() => {
    // Stub the MCP runtime pool to an empty list so this describe block stays
    // hermetic. Without it, `buildCombinedCatalog` reaches into the user's
    // real `~/.reina/mcp.json` at session-time cold-start and can spend
    // multiple seconds dialling actual servers — pushing these tests past
    // vitest's 5s default and flaking on any developer machine that has MCP
    // servers configured. Tests here only care about the native-catalog
    // rendering path; MCP integration has its own describe with a real spy.
    vi.spyOn(mcpRuntime, "loadMcpRuntimeTools").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runWithCatalog(catalog: DeferredCatalogEntry[], query: string): Promise<string> {
    setDeferredCatalogProvider(() => catalog);
    const result = await searchToolTool.execute({ query }, runtimeOptions);
    return typeof result === "string" ? result : result.output;
  }

  it("renders each match as a <tool> block with name, summary, and input params", async () => {
    const out = await runWithCatalog(
      [
        {
          name: "notify",
          summary: "Post a native desktop notification.",
          params: [
            { name: "title", type: "string", required: true, description: "Notification title." },
            { name: "silent", type: "boolean", required: false, description: "Suppress sound." },
          ],
        },
      ],
      "notify",
    );
    expect(out).toContain('<tool name="notify">');
    expect(out).toContain("<summary>Post a native desktop notification.</summary>");
    expect(out).toContain("title (string, required) — Notification title.");
    expect(out).toContain("silent (boolean, optional) — Suppress sound.");
    expect(out).toContain("</tool>");
  });

  it("emits `(no parameters)` for tools with an empty params array", async () => {
    const out = await runWithCatalog([{ name: "get_goal", summary: "Read the current Goal.", params: [] }], "goals");
    expect(out).toContain("<input>(no parameters)</input>");
  });

  it("hint points the model at the next-turn direct call (single unmasked path)", async () => {
    const out = await runWithCatalog([{ name: "notify", summary: "Notify.", params: [] }], "notify");
    expect(out).toContain("NEXT turn");
    expect(out).toContain("notify({...})");
    // MCP runtime tools call the same way — the hint says so explicitly so a
    // model that just discovered an mcp__... entry knows it's not special.
    expect(out).toContain("MCP runtime tools");
    // execute_tool is gone — the hint must not resurrect the wrapper concept.
    expect(out).not.toContain("execute_tool");
  });

  it("renders an <examples> block with one line per example when present", async () => {
    const out = await runWithCatalog(
      [
        {
          name: "schedule_wakeup",
          summary: "Schedule a future model turn.",
          params: [
            { name: "delaySeconds", type: "number", required: true },
            { name: "prompt", type: "string", required: true },
            { name: "reason", type: "string", required: true },
          ],
          examples: [
            {
              description: "Long idle wait",
              input: { delaySeconds: 1800, reason: "idle", prompt: "Resume." },
            },
            {
              description: "Watching CI",
              input: { delaySeconds: 270, reason: "ci", prompt: "Re-check CI." },
            },
          ],
        },
      ],
      "wakeup",
    );
    expect(out).toContain("<examples>");
    expect(out).toContain('- Long idle wait: {"delaySeconds":1800,"reason":"idle","prompt":"Resume."}');
    expect(out).toContain('- Watching CI: {"delaySeconds":270,"reason":"ci","prompt":"Re-check CI."}');
    expect(out).toContain("</examples>");
  });

  it("omits the <examples> block when the entry has none", async () => {
    const out = await runWithCatalog(
      [
        {
          name: "notify",
          summary: "Post a notification.",
          params: [{ name: "title", type: "string", required: true }],
          // examples deliberately omitted
        },
      ],
      "notify",
    );
    expect(out).not.toContain("<examples>");
  });

  it("falls back to legacy one-line rendering when params field is absent", async () => {
    // Fixture without `params` — represents a stale or test-only catalog.
    const out = await runWithCatalog([{ name: "notify", summary: "Post a notification." }], "notify");
    expect(out).toContain("- notify: Post a notification.");
    expect(out).not.toContain("<tool name=");
  });
});

describe("searchToolTool.execute — MCP runtime integration (Phase 2a)", () => {
  // search_tool surfaces MCP runtime tools alongside native deferred entries
  // so the model can discover and call them directly on its next turn without
  // them having to live in the cold-start tools array. The MCP pool is
  // fetched per-call via loadMcpRuntimeTools(cwd) — we mock that here so the
  // test doesn't need a real MCP server.
  const runtimeOptions = { cwd: "." } as ToolRuntimeOptions;

  beforeEach(() => {
    // Reset the native catalog so prior tests in this file don't leak
    // synthetic entries into the MCP merge.
    setDeferredCatalogProvider(() => []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMcpTools(tools: McpRuntimeTool[]): void {
    vi.spyOn(mcpRuntime, "loadMcpRuntimeTools").mockResolvedValue(tools);
  }

  function mcpFixture(server: string, tool: string, schema?: Record<string, unknown>): McpRuntimeTool {
    return {
      name: `mcp__${server}__${tool}` as McpRuntimeTool["name"],
      description: `[MCP:${server}] ${tool} description.`,
      permission: "execute",
      requiresApproval: true,
      inputSchema: z.object({}).passthrough(),
      inputJsonSchema: schema ?? {
        type: "object",
        properties: {
          repo: { type: "string", description: "Target repository." },
        },
        required: ["repo"],
      },
      mcpServer: server,
      mcpTool: tool,
    };
  }

  it("surfaces MCP tools as catalog entries with summary and schema params", async () => {
    mockMcpTools([mcpFixture("github", "create_issue")]);
    const result = await searchToolTool.execute({ query: "github" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain('<tool name="mcp__github__create_issue">');
    expect(out).toContain("[MCP:github] create_issue description.");
    // JSON-schema walker extracted the `repo` parameter.
    expect(out).toContain("repo (string, required) — Target repository.");
  });

  it("ranks MCP tools by server / tool name tokens in the query", async () => {
    mockMcpTools([mcpFixture("github", "create_issue"), mcpFixture("slack", "post_message")]);
    const result = await searchToolTool.execute({ query: "slack post" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    // slack-related entry wins; github entry should not surface for this query.
    expect(out).toContain('<tool name="mcp__slack__post_message">');
    expect(out).not.toContain('<tool name="mcp__github__create_issue">');
  });

  it("searches only MCP servers allowed by the active profile", async () => {
    mockMcpTools([mcpFixture("github", "create_issue"), mcpFixture("slack", "post_message")]);
    const restrictedOptions = { cwd: ".", allowedMcpServers: ["github"] } as ToolRuntimeOptions;

    const blocked = await searchToolTool.execute({ query: "slack post" }, restrictedOptions);
    const allowed = await searchToolTool.execute({ query: "github issue" }, restrictedOptions);
    const blockedOutput = typeof blocked === "string" ? blocked : blocked.output;
    const allowedOutput = typeof allowed === "string" ? allowed : allowed.output;

    expect(blockedOutput).toContain('<matches count="0"/>');
    expect(blockedOutput).not.toContain("mcp__slack__post_message");
    expect(typeof blocked === "string" ? undefined : blocked.metadata?.unmaskTools).toBeUndefined();
    expect(allowedOutput).toContain('<tool name="mcp__github__create_issue">');
    expect(typeof allowed === "string" ? undefined : allowed.metadata?.unmaskTools).toEqual([
      "mcp__github__create_issue",
    ]);
  });

  it("surfaces MCP tools alongside native deferred entries (no shadowing)", async () => {
    setDeferredCatalogProvider(() => [
      {
        name: "notify",
        summary: "Post a native desktop notification.",
        params: [{ name: "title", type: "string", required: true }],
      },
    ]);
    mockMcpTools([mcpFixture("github", "notify_repo_watchers")]);
    const result = await searchToolTool.execute({ query: "notify" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    // Both should surface for a query that matches both.
    expect(out).toContain('<tool name="notify">');
    expect(out).toContain('<tool name="mcp__github__notify_repo_watchers">');
  });

  it("surfaces a synthesised <examples> block for MCP tools so the model gets a shape, not just params", async () => {
    // Closes the "right tool, wrong args" gap the Anthropic tool-design
    // article calls out: MCP tool authors don't ship `examples`, so without
    // synthesis the model has to guess the JSON shape from the params list
    // (which is the failure mode the Java-gadget catalog screenshot caught).
    mockMcpTools([
      mcpFixture("scanner", "find_gadget", {
        type: "object",
        properties: {
          method: { type: "string", description: "Java method signature." },
          maxResults: { type: "integer" },
        },
        required: ["method"],
      }),
    ]);
    const result = await searchToolTool.execute({ query: "gadget" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain("<examples>");
    expect(out).toContain("Minimal shape (required fields only");
    // The synthesised example JSON only carries required fields with
    // type-appropriate placeholders. Optional fields appear in the <input>
    // params list (their job) but must NOT leak into the example body.
    expect(out).toContain('"method":"<java-method-signature.>"');
    const exampleLineMatch = out.match(/Minimal shape[^\n]*\n/);
    expect(exampleLineMatch?.[0] ?? "").not.toContain("maxResults");
  });

  it("omits the synthesised example when an MCP tool has no required fields", async () => {
    // An empty `{}` example would add noise without signal — confirm the
    // synthesis path bails out and the renderer drops the block entirely.
    mockMcpTools([
      mcpFixture("ping", "noop", {
        type: "object",
        properties: { detail: { type: "string" } },
      }),
    ]);
    const result = await searchToolTool.execute({ query: "noop" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain('<tool name="mcp__ping__noop">');
    expect(out).not.toContain("<examples>");
  });

  it("still works when loadMcpRuntimeTools throws (mcp.json typo or read failure)", async () => {
    vi.spyOn(mcpRuntime, "loadMcpRuntimeTools").mockRejectedValue(new Error("mcp.json: unexpected token"));
    setDeferredCatalogProvider(() => [{ name: "notify", summary: "Post a desktop notification.", params: [] }]);
    const result = await searchToolTool.execute({ query: "notify" }, runtimeOptions);
    const out = typeof result === "string" ? result : result.output;
    // Native entries continue to surface; MCP failure is silent.
    expect(out).toContain('<tool name="notify">');
  });
});
