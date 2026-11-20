import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionState, ToolCallRecord } from "@reina/protocol";
import { buildSideChatSeed, SIDE_CHAT_BOUNDARY_PROMPT, SIDE_CHAT_TOOL_DENIED } from "./side-chat.js";
import { createToolDispatch, type ToolDispatchControllers, type ToolDispatchHost } from "./tool-dispatch.js";

const cwd = mkdtempSync(path.join(tmpdir(), "reina-side-chat-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function record(name: string, input: unknown = {}): ToolCallRecord {
  return {
    id: `call_${name}`,
    name: name as ToolCallRecord["name"],
    input,
    summary: name,
    permission: "read",
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

function sideChatHost(overrides?: Partial<SessionState>): ToolDispatchHost {
  const session = {
    id: "s_side",
    cwd,
    isSubagent: true,
    isSideChat: true,
    messages: [],
    toolCalls: [],
    skills: [],
    readFileTimestamps: {},
    ...overrides,
  } as unknown as SessionState;
  return {
    session,
    signal: new AbortController().signal,
    hostBridge: undefined,
    emitStream: () => {},
    sendTaskMessage: (r) => ({ callId: r.id, name: r.name, output: "" }),
  };
}

// The gate fires before any handler/registry lookup, so the controllers are
// never reached in these tests — an empty stub is safe.
const controllers = {} as unknown as ToolDispatchControllers;

describe("side-chat read-only tool gate", () => {
  it("vetoes mutating tools (execute/write/network) with the denial message", async () => {
    const dispatch = createToolDispatch(sideChatHost(), controllers);
    for (const name of ["run_shell", "write_file", "edit_file", "web_fetch"]) {
      const obs = await dispatch.run(record(name));
      expect(obs.error).toBe(SIDE_CHAT_TOOL_DENIED);
    }
  });

  it("vetoes MCP runtime tools (unknown permission → not read)", async () => {
    const dispatch = createToolDispatch(sideChatHost(), controllers);
    const obs = await dispatch.run(record("mcp__srv__anything"));
    expect(obs.error).toBe(SIDE_CHAT_TOOL_DENIED);
  });

  it("lets read-level tools through to real execution", async () => {
    writeFileSync(path.join(cwd, "hello.txt"), "side chat readable\n");
    const dispatch = createToolDispatch(sideChatHost(), controllers);
    const obs = await dispatch.run(record("read_file", { path: "hello.txt" }));
    expect(obs.error).toBeUndefined();
    expect(obs.output).toContain("side chat readable");
  });

  it("keeps the subagent block ahead of the side-chat gate for spawn tools", async () => {
    const dispatch = createToolDispatch(sideChatHost(), controllers);
    const obs = await dispatch.run(record("task"));
    expect(obs.error).toContain("not available to subagents");
  });

  it("does not gate ordinary sessions", async () => {
    writeFileSync(path.join(cwd, "plain.txt"), "plain\n");
    const dispatch = createToolDispatch(sideChatHost({ isSideChat: undefined, isSubagent: undefined }), controllers);
    const obs = await dispatch.run(record("read_file", { path: "plain.txt" }));
    expect(obs.error).toBeUndefined();
  });
});

describe("buildSideChatSeed", () => {
  it("copies the FULL history (no tail budget) with per-entry copies", () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      content: `message ${i}`,
      createdAt: new Date().toISOString(),
    }));
    const parent = {
      messages,
      skills: [{ name: "sk", description: "d", path: "p", scope: "workspace" }],
      activeDeferredTools: ["web_fetch"],
    } as unknown as Pick<SessionState, "messages" | "skills" | "activeDeferredTools">;
    const seed = buildSideChatSeed(parent);
    expect(seed.inheritedMessages).toHaveLength(60);
    expect(seed.inheritedMessages[0]).not.toBe(parent.messages[0]);
    expect(seed.inheritedMessages[0]).toEqual(parent.messages[0]);
    expect(seed.inheritedSkills[0]).not.toBe(parent.skills[0]);
    expect(seed.activeDeferredTools).toEqual(["web_fetch"]);
  });

  it("boundary prompt demotes inherited history and states the read-only policy", () => {
    expect(SIDE_CHAT_BOUNDARY_PROMPT).toContain("Side conversation boundary");
    expect(SIDE_CHAT_BOUNDARY_PROMPT).toContain("reference context only");
    expect(SIDE_CHAT_BOUNDARY_PROMPT).toContain("read-only tools");
  });
});
