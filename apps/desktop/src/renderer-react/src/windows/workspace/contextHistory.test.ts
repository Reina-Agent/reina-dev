import { describe, expect, it } from "vitest";
import type { ContextRequestRecord, TokenRequestBreakdown } from "@reina/protocol";
import { translate, type TFunc } from "../../lib/i18n";
import { contextCategories, contextEventPosition, contextItemLabel, contextSectionLabel, isContextHistoryEvent } from "./contextHistory";

const en: TFunc = (key, vars) => translate("en", key, vars);
const zh: TFunc = (key, vars) => translate("zh", key, vars);

const breakdown: TokenRequestBreakdown = {
  createdAt: "2026-09-09T00:00:00Z", provider: "test", model: "test", messagesCount: 1,
  observationsCount: 0, toolsCount: 1, systemPromptChars: 40, systemPromptTokens: 10,
  messagesChars: 80, messagesTokens: 20, observationsChars: 0, observationsTokens: 0,
  toolsDescriptionChars: 20, toolsSchemaChars: 20, toolsTokens: 10, totalChars: 160,
  estimatedInputTokens: 45, toolNames: ["read_file"],
};

function request(id: string, startedAt: string): ContextRequestRecord {
  return { id, startedAt, breakdown, sessionId: "parent", turnId: "turn", attempt: 1, status: "completed", provider: "test", model: "test" };
}

describe("context request accounting", () => {
  it("counts shipped categories once and excludes deferred tools, nested counts and reserve", () => {
    const entries = contextCategories({ ...breakdown, estimatedInputTokens: 50, categories: {
      systemPromptBase: 10, systemPromptSkills: 5, systemPromptUserRules: 5,
      messages: 10, observations: 2, reminders: 3, toolsCore: 10, toolsMcp: 5,
      toolsCoreDeferred: 100, toolsMcpDeferred: 100, toolsCoreActiveDeferred: 4,
      toolsMcpActiveDeferred: 3, hiddenToolsReminder: 1, autocompactBuffer: 100,
      autocompactThreshold: 900, autocompactEstimate: 75, freeSpace: 650, contextWindow: 1_000,
    } }, en);
    expect(entries.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(50);
    expect(entries.map((entry) => entry.id)).not.toContain("other");
  });

  it("keeps unclassified input visible when only older coarse accounting is available", () => {
    const entries = contextCategories(breakdown, en);
    expect(entries.find((entry) => entry.id === "other")?.tokens).toBe(5);
    expect(entries.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(45);
  });
});

describe("context language", () => {
  it("provides English and Chinese entry points, empty states, status and request labels", () => {
    expect(en("context.title")).toBe("Context");
    expect(zh("context.title")).toBe("上下文");
    expect(en("context.openSubagent")).toBe("View subagent context");
    expect(zh("context.openSubagent")).toBe("查看子 Agent 上下文");
    expect(en("context.noRequests")).toBe("No recorded requests yet");
    expect(zh("context.noRequests")).toBe("暂无请求记录");
    expect(en("context.status.cancelled")).toBe("Cancelled");
    expect(zh("context.status.cancelled")).toBe("已取消");
    expect(en("context.numberedContents", { index: 2 })).toBe("Request 2 contents");
    expect(zh("context.numberedContents", { index: 2 })).toBe("第 2 次请求内容");
  });

  it("relabels existing request categories and generated headers without changing data", () => {
    const english = contextCategories(breakdown, en);
    const chinese = contextCategories(breakdown, zh);
    expect(english.find((entry) => entry.id === "system")?.label).toBe("System prompt");
    expect(chinese.find((entry) => entry.id === "system")?.label).toBe("系统提示词");
    expect(english.map(({ label: _label, ...entry }) => entry)).toEqual(chinese.map(({ label: _label, ...entry }) => entry));
    expect(contextSectionLabel("tools", "Tool definitions", zh)).toBe("工具定义");
    expect(contextItemLabel("messages", { id: "msg-id", label: "2. assistant" }, zh)).toBe("2. 助手");
    expect(contextItemLabel("reminders", { id: "reminder-0", label: "Reminder 1" }, zh)).toBe("提醒 1");
    expect(contextItemLabel("tools", { id: "tools-omitted", label: "Remaining items" }, zh)).toBe("剩余内容");
  });

  it("preserves tool names and unfamiliar labels rather than translating request data", () => {
    expect(contextItemLabel("tools", { id: "read_file", label: "read_file" }, zh)).toBe("read_file");
    expect(contextItemLabel("messages", { id: "custom", label: "Custom imported message" }, zh)).toBe("Custom imported message");
    expect(contextSectionLabel("future", "Future input", zh)).toBe("Future input");
  });
});

describe("context history telemetry scoping", () => {
  const event = (sessionId: string, inner: unknown) => ({ type: "model_stream", sessionId, event: inner });

  it("ignores background engines and token streams", () => {
    expect(isContextHistoryEvent(event("other", { type: "context-request" }), "parent", null)).toBe(false);
    expect(isContextHistoryEvent(event("parent", { type: "text-delta", text: "hello" }), "parent", null)).toBe(false);
    expect(isContextHistoryEvent(event("parent", { type: "context-request" }), "parent", null)).toBe(true);
  });

  it("keeps main and subagent histories separate, including other tasks", () => {
    const child = event("parent", { type: "subagent-event", taskId: "child-1", event: { type: "context-history-event" } });
    expect(isContextHistoryEvent(child, "parent", null)).toBe(false);
    expect(isContextHistoryEvent(child, "parent", "child-2")).toBe(false);
    expect(isContextHistoryEvent(child, "parent", "child-1")).toBe(true);
    expect(isContextHistoryEvent(event("parent", { type: "context-request" }), "parent", "child-1")).toBe(false);
  });

  it("refreshes retained content after a matching session snapshot only", () => {
    expect(isContextHistoryEvent({ type: "session_snapshot", sessionId: "parent" }, "parent", null)).toBe(true);
    expect(isContextHistoryEvent({ type: "session_snapshot", sessionId: "parent" }, "parent", "child-1")).toBe(true);
    expect(isContextHistoryEvent({ type: "session_snapshot", sessionId: "other" }, "parent", null)).toBe(false);
  });
});

describe("compaction markers", () => {
  const requests = [request("a", "2026-09-09T00:00:10Z"), request("b", "2026-09-09T00:00:30Z")];

  it("places compactions between requests rather than on the next request", () => {
    expect(contextEventPosition(requests, "2026-09-09T00:00:20Z")).toBe(1);
    expect(contextEventPosition(requests, "2026-09-09T00:00:15Z")).toBe(0.75);
  });

  it("keeps a compaction visible before the first or after the latest request", () => {
    expect(contextEventPosition(requests, "2026-09-09T00:00:01Z")).toBe(0);
    expect(contextEventPosition(requests, "2026-09-09T00:00:40Z")).toBe(2);
  });
});
