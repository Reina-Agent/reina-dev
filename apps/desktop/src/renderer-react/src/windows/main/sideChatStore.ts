// Side-chat store — external store for the Workspace Side Chat app.
// Backs the "/btw"-style side conversation: an ephemeral read-only child agent
// forked from each live parent session so the user can ask questions while the
// main turn keeps running. Self-contained (bridge only — no sessionStore
// import; workspaceEngineStore forwards the stream envelopes here, so there is
// no dependency on the main conversation store).
//
// Data source: the foreground session's model_stream envelopes —
//   side-chat-event  { event }   nested child ModelStreamEvent (deltas, tools)
//   side-chat-state  { status }  turn lifecycle (started/completed/failed/closed)
// The child's transcript is NOT persisted to disk (ephemeral by design), but
// it is retained per parent session for the renderer lifetime so switching
// between live sessions does not destroy either side conversation.

import { useSyncExternalStore } from "react";
import { bridge } from "~/lib/bridge";

export interface SideChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Collapsed reasoning captured alongside a committed assistant reply. */
  reasoning?: string;
  /** True when the turn errored — renders the row in the danger tint. */
  failed?: boolean;
}

export interface SideChatState {
  /** Session the current transcript belongs to (bind guard). */
  sessionId: string | null;
  messages: SideChatMessage[];
  /** In-flight assistant text while the child streams. */
  streamText: string;
  streamReasoning: string;
  /** Last running read-only tool name ("read_file"), shown as a subtle
   * activity hint under the streaming row. */
  activity: string | null;
  running: boolean;
  error: string | null;
}

function emptyState(sessionId: string | null): SideChatState {
  return {
    sessionId,
    messages: [],
    streamText: "",
    streamReasoning: "",
    activity: null,
    running: false,
    error: null,
  };
}

const states = new Map<string, SideChatState>();
let activeSessionId: string | null = null;
let state: SideChatState = emptyState(null);

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function stateFor(sessionId: string): SideChatState {
  return states.get(sessionId) ?? emptyState(sessionId);
}

function setFor(sessionId: string, patch: Partial<SideChatState>): void {
  const next = { ...stateFor(sessionId), ...patch, sessionId };
  states.set(sessionId, next);
  if (activeSessionId !== sessionId) return;
  state = next;
  emit();
}

export function getSideChatState(): SideChatState {
  return state;
}

export function useSideChatStore<T>(selector: (s: SideChatState) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => selector(state),
  );
}

// ── Session binding ─────────────────────────────────────────────────────────

/** Bind the panel to the foreground session. Each live parent keeps its own
 * side-chat child and renderer state while it is off-screen. */
export function bindSideChatSession(sessionId: string | null): void {
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  state = sessionId ? stateFor(sessionId) : emptyState(null);
  if (sessionId && !states.has(sessionId)) states.set(sessionId, state);
  emit();
}

// ── User actions ────────────────────────────────────────────────────────────

export async function sideChatSend(text: string, selectedQuote = ""): Promise<void> {
  const sessionId = activeSessionId;
  const trimmed = text.trim();
  if (!sessionId || !trimmed || stateFor(sessionId).running) return;
  // Optimistic user bubble + busy state; the host's `started` event confirms.
  const current = stateFor(sessionId);
  setFor(sessionId, {
    messages: [...current.messages, { role: "user", text: trimmed }],
    running: true,
    error: null,
    streamText: "",
    streamReasoning: "",
    activity: null,
  });
  try {
    const quote = selectedQuote.trim();
    const message = quote
      ? `<selected_quote>\n${quote}\n</selected_quote>\n\n${trimmed}`
      : trimmed;
    await bridge().invoke("side_chat", { sessionId, action: "prompt", message });
  } catch (error) {
    setFor(sessionId, { running: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function sideChatInterrupt(): void {
  if (!activeSessionId) return;
  void bridge()
    .invoke("side_chat", { sessionId: activeSessionId, action: "interrupt" })
    .catch(() => undefined);
}

/** Clear the conversation: tear down the child (fresh context next time)
 * and blank the panel. */
export function sideChatClear(): void {
  const sessionId = activeSessionId;
  if (!sessionId) return;
  const current = stateFor(sessionId);
  if (current.messages.length > 0 || current.running || current.streamText.length > 0) {
    void bridge()
      .invoke("side_chat", { sessionId, action: "close" })
      .catch(() => undefined);
  }
  setFor(sessionId, emptyState(sessionId));
}

// ── Stream ingestion (called from workspaceEngineStore) ─────────────────────

/** Commit whatever streamed into a durable assistant row. */
function commitStream(sessionId: string, failed: boolean, error?: string): void {
  const current = stateFor(sessionId);
  const text = current.streamText.trim();
  const reasoning = current.streamReasoning.trim();
  const messages =
    text || reasoning
      ? [
          ...current.messages,
          {
            role: "assistant" as const,
            text: text || (failed ? "" : "(no reply)"),
            reasoning: reasoning || undefined,
            failed: failed || undefined,
          },
        ]
      : current.messages;
  setFor(sessionId, {
    messages,
    streamText: "",
    streamReasoning: "",
    activity: null,
    running: false,
    error: error ?? null,
  });
}

export function handleSideChatEvent(sessionId: string, sub: { type?: string } & Record<string, unknown>): void {
  const event = (sub.event ?? {}) as { type?: string; text?: string; name?: string; status?: string };
  const current = stateFor(sessionId);
  switch (event.type) {
    case "text-delta":
      if (event.text) setFor(sessionId, { streamText: current.streamText + event.text, activity: null });
      return;
    case "reasoning-delta":
      if (event.text) setFor(sessionId, { streamReasoning: current.streamReasoning + event.text });
      return;
    case "stream-reset":
      // Connection dropped mid-answer; the child re-issues the request —
      // discard the partial so the retry replaces instead of appending.
      setFor(sessionId, { streamText: "", streamReasoning: "" });
      return;
    case "tool-progress":
      setFor(sessionId, { activity: event.status === "running" ? (event.name ?? null) : null });
      return;
    default:
      return;
  }
}

export function handleSideChatState(sessionId: string, sub: { status?: string; error?: string }): void {
  switch (sub.status) {
    case "started":
      setFor(sessionId, { running: true, error: null });
      return;
    case "completed":
      commitStream(sessionId, false);
      return;
    case "failed":
      commitStream(sessionId, true, sub.error ?? "Side chat failed.");
      return;
    case "closed":
      // Engine-side teardown (session close / explicit clear elsewhere).
      setFor(sessionId, { streamText: "", streamReasoning: "", activity: null, running: false });
      return;
    default:
      return;
  }
}
