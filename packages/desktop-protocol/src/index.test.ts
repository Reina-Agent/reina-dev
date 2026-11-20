import { describe, expect, test } from "vitest";
import { parseDesktopRequest, serializeJsonLine } from "./index.js";

describe("desktop protocol", () => {
  test("parses a create_session request", () => {
    const request = parseDesktopRequest({
      id: "1",
      type: "create_session",
      cwd: process.cwd(),
      permissionMode: "default",
    });

    expect(request.type).toBe("create_session");
    expect(request.id).toBe("1");
  });

  test("serializes newline-delimited json", () => {
    expect(serializeJsonLine({ type: "host_ready", version: "test" })).toMatch(/\n$/);
  });

  test("requires session and request identity for context reads", () => {
    expect(parseDesktopRequest({ type: "get_context_history", sessionId: "parent" }))
      .toEqual({ type: "get_context_history", sessionId: "parent" });
    const request = { type: "get_context_request", sessionId: "parent", taskId: "child", requestId: "request-1" };
    expect(parseDesktopRequest(request)).toEqual(request);
    for (const invalid of [{ sessionId: "" }, { requestId: "" }, { taskId: "" }, { requestId: undefined }]) {
      expect(() => parseDesktopRequest({ ...request, ...invalid })).toThrow();
    }
  });

  test("validates a direct subagent message and keeps sender attribution on the host", () => {
    const request = {
      type: "update_async_task_external", sessionId: "parent", taskId: "worker", message: "new requirement",
    };
    expect(parseDesktopRequest({ ...request, sender: "supervisor" })).toEqual(request);
    for (const invalid of [
      { sessionId: "" }, { taskId: "  " }, { message: "  " }, { message: 12 },
    ]) {
      expect(() => parseDesktopRequest({ ...request, ...invalid })).toThrow();
    }
  });

  test("validates complete compaction updates and the explicit buffer-mode percentage", () => {
    const settings = {
      compactionAuto: true,
      compactionOffload: false,
      compactionTriggerPercent: 0,
      compactionBufferTokens: 13_000,
      compactionKeepRecent: 8,
    };
    expect(parseDesktopRequest({ type: "update_compaction_settings", settings }))
      .toMatchObject({ type: "update_compaction_settings", settings });
    for (const invalid of [
      { compactionTriggerPercent: 29 },
      { compactionTriggerPercent: 96 },
      { compactionTriggerPercent: 70.5 },
      { compactionAuto: "true" },
      { compactionBufferTokens: 999 },
      { compactionKeepRecent: 65 },
      { REINA_CONFIG_HOME: "/tmp/override" },
    ]) {
      expect(() => parseDesktopRequest({
        type: "update_compaction_settings",
        settings: { ...settings, ...invalid },
      })).toThrow();
    }
    expect(() => parseDesktopRequest({
      type: "update_compaction_settings",
      settings: { compactionTriggerPercent: 70 },
    })).toThrow();
  });

  test("validates runtime subagent concurrency limits", () => {
    for (const concurrency of [1, 8, 32]) {
      expect(parseDesktopRequest({ type: "update_subagent_concurrency", concurrency }))
        .toMatchObject({ type: "update_subagent_concurrency", concurrency });
    }
    for (const concurrency of [0, 33, 2.5, "8"]) {
      expect(() => parseDesktopRequest({ type: "update_subagent_concurrency", concurrency })).toThrow();
    }
  });

  test("parses only user-authorized Goal commands", () => {
    const request = parseDesktopRequest({
      id: "g1",
      type: "goal_command",
      sessionId: "s1",
      command: { type: "create", objective: "ship it", tokenBudget: 1000 },
    });
    expect(request).toMatchObject({ type: "goal_command", command: { type: "create", objective: "ship it" } });
    expect(() => parseDesktopRequest({
      type: "goal_command",
      sessionId: "s1",
      command: { type: "verification_passed", claimId: "claim_1" },
    })).toThrow();
    expect(() => parseDesktopRequest({
      type: "update_session_config",
      sessionId: "s1",
      sessionModes: { goal: true },
    })).toThrow();
  });

  test("parses workspace background shell task requests", () => {
    expect(parseDesktopRequest({
      type: "list_background_shell_tasks",
      cwd: process.cwd(),
    })).toMatchObject({ type: "list_background_shell_tasks", cwd: process.cwd() });
    expect(parseDesktopRequest({
      type: "get_background_shell_task_output",
      cwd: process.cwd(),
      taskId: "shell_1234",
    })).toMatchObject({ type: "get_background_shell_task_output", taskId: "shell_1234" });
    expect(parseDesktopRequest({
      type: "stop_background_shell_task",
      cwd: process.cwd(),
      taskId: "shell_1234",
    })).toMatchObject({ type: "stop_background_shell_task", taskId: "shell_1234" });
    expect(() => parseDesktopRequest({
      type: "stop_background_shell_task",
      cwd: process.cwd(),
    })).toThrow();
  });
});
