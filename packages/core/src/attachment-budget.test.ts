import type { ChatMessage } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { capInflightAttachmentBytes } from "./engine.js";

function mediaMessage(id: string, b64Len: number): ChatMessage {
  return {
    id,
    role: "user",
    content: `Tool read_file (${id}) result:\nRead image ${id}.png`,
    ephemeral: true,
    toolResult: {
      callId: id,
      name: "read_file",
      input: { path: `${id}.png` },
      attachments: [{ kind: "image", mime: "image/png", dataBase64: "x".repeat(b64Len), name: `${id}.png` }],
    },
    createdAt: new Date().toISOString(),
  };
}

function textMessage(id: string): ChatMessage {
  return { id, role: "assistant", content: "thinking", createdAt: new Date().toISOString() };
}

describe("capInflightAttachmentBytes", () => {
  it("returns the same array when total media is within budget", () => {
    const msgs = [mediaMessage("a", 100), textMessage("t"), mediaMessage("b", 100)];
    const out = capInflightAttachmentBytes(msgs, 1000);
    expect(out).toBe(msgs); // same reference, no clone
  });

  it("keeps the newest media and evicts older media beyond budget", () => {
    const msgs = [mediaMessage("old", 600), textMessage("t"), mediaMessage("new", 600)];
    // Budget fits only one 600-byte blob → newest kept, oldest evicted.
    const out = capInflightAttachmentBytes(msgs, 1000);
    expect(out).not.toBe(msgs);

    const oldOut = out.find((m) => m.id === "old")!;
    const newOut = out.find((m) => m.id === "new")!;
    expect(oldOut.toolResult?.attachments).toBeUndefined();
    expect(oldOut.content).toContain("re-read the file");
    // Newest media survives untouched (same reference, attachments intact).
    expect(newOut).toBe(msgs[2]);
    expect(newOut.toolResult?.attachments).toHaveLength(1);
    // Non-media messages are passed through by reference.
    expect(out.find((m) => m.id === "t")).toBe(msgs[1]);
  });

  it("does not mutate the input messages", () => {
    const msgs = [mediaMessage("old", 600), mediaMessage("new", 600)];
    capInflightAttachmentBytes(msgs, 1000);
    expect(msgs[0]!.toolResult?.attachments).toHaveLength(1); // original intact
  });
});
