import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/lib/bridge", () => ({
  bridge: () => ({ invoke: mocks.invoke }),
}));

import {
  bindSideChatSession,
  getSideChatState,
  handleSideChatEvent,
  handleSideChatState,
  sideChatClear,
  sideChatSend,
} from "./sideChatStore";

describe("sideChatStore session isolation", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
  });

  it("retains an independent transcript for each parent session", () => {
    bindSideChatSession("side-store-a");
    handleSideChatEvent("side-store-a", { event: { type: "text-delta", text: "answer a" } });
    handleSideChatState("side-store-a", { status: "completed" });

    bindSideChatSession("side-store-b");
    expect(getSideChatState().messages).toEqual([]);
    handleSideChatEvent("side-store-b", { event: { type: "text-delta", text: "answer b" } });
    handleSideChatState("side-store-b", { status: "completed" });

    bindSideChatSession("side-store-a");
    expect(getSideChatState().messages.map((message) => message.text)).toEqual(["answer a"]);
    bindSideChatSession("side-store-b");
    expect(getSideChatState().messages.map((message) => message.text)).toEqual(["answer b"]);
  });

  it("buffers background side-chat events without repainting the foreground", () => {
    bindSideChatSession("side-store-foreground");
    handleSideChatEvent("side-store-background", { event: { type: "text-delta", text: "late background reply" } });

    expect(getSideChatState().streamText).toBe("");
    bindSideChatSession("side-store-background");
    expect(getSideChatState().streamText).toBe("late background reply");
  });

  it("clears only the active parent session and closes its child", async () => {
    bindSideChatSession("side-store-clear-a");
    await sideChatSend("question a");
    bindSideChatSession("side-store-clear-b");
    await sideChatSend("question b");

    sideChatClear();
    expect(getSideChatState().messages).toEqual([]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("side_chat", {
      sessionId: "side-store-clear-b",
      action: "close",
    });

    bindSideChatSession("side-store-clear-a");
    expect(getSideChatState().messages.map((message) => message.text)).toEqual(["question a"]);
  });
});
