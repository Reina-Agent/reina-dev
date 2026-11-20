import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@reina/protocol";
import {
  CONTEXT_STATE_VERSION,
  buildContextStateUpdate,
  latestContextStateSnapshot,
  type ModelContextSection,
} from "./context-state.js";

const section = (id: string, content: string, cleared = `${id} cleared`): ModelContextSection => ({
  id,
  content,
  cleared,
});

describe("model context state", () => {
  it("injects a full initial snapshot, then emits nothing for identical state", () => {
    const initial = buildContextStateUpdate([section("plan", "plan v1"), section("todos", "")]);
    expect(initial.reminders).toEqual(["plan v1"]);

    const unchanged = buildContextStateUpdate(
      [section("plan", "plan v1"), section("todos", "")],
      initial.snapshot,
    );
    expect(unchanged.reminders).toEqual([]);
    expect(unchanged.snapshot).toEqual(initial.snapshot);
  });

  it("emits only a changed section and an explicit removal notice", () => {
    const initial = buildContextStateUpdate([
      section("plan", "plan v1"),
      section("todos", "todo v1", "todos are now empty"),
    ]);
    const changed = buildContextStateUpdate(
      [section("plan", "plan v2"), section("todos", "todo v1")],
      initial.snapshot,
    );
    expect(changed.reminders).toEqual(["plan v2"]);

    const removed = buildContextStateUpdate(
      [section("plan", "plan v2"), section("todos", "", "todos are now empty")],
      changed.snapshot,
    );
    expect(removed.reminders).toEqual(["todos are now empty"]);
    expect(removed.snapshot).not.toHaveProperty("todos");
  });

  it("recovers only the newest baseline retained in model history", () => {
    const oldSnapshot = buildContextStateUpdate([section("plan", "old")]).snapshot;
    const newSnapshot = buildContextStateUpdate([section("plan", "new")]).snapshot;
    const messages: ChatMessage[] = [
      contextMessage("old", oldSnapshot),
      { id: "assistant", role: "assistant", content: "ok", createdAt: "2025-01-01T00:00:01Z" },
      contextMessage("new", newSnapshot),
    ];

    expect(latestContextStateSnapshot(messages)).toEqual(newSnapshot);
    expect(latestContextStateSnapshot(messages.slice(0, 2))).toEqual(oldSnapshot);
    expect(latestContextStateSnapshot(messages.slice(1, 2))).toBeUndefined();
  });
});

function contextMessage(id: string, sections: Record<string, string>): ChatMessage {
  return {
    id,
    role: "user",
    content: "<system-reminder>context</system-reminder>",
    ephemeral: true,
    contextState: { version: CONTEXT_STATE_VERSION, sections },
    createdAt: "2025-01-01T00:00:00Z",
  };
}
