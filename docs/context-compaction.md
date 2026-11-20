# Context Compaction

Reina now keeps two conversation views:

- `session.messages` is the complete transcript used by the TUI, saved sessions, and history review.
- `session.modelMessages` is the compactable context sent to the model. It is created only after the first compaction.

This avoids the old behavior where compaction deleted visible history.

## Triggering

- Manual: desktop `/compact` sends the `compact_session` control request and calls the engine's compaction path directly. Compaction is a runtime operation and is not exposed as a model-callable tool.
- Automatic: before a model request, Reina estimates context size and compacts when it crosses the threshold.
- Reina does not auto-compact while tool observations or approval prompts are pending, because provider tool state must stay aligned with the next model call.

Desktop compaction settings apply to the running agent host after Save succeeds. Existing sessions and subagents use the new threshold, retention and offload settings at the next compaction check; saving does not interrupt a model request or start compaction on its own. Clearing the percentage selects the token-buffer threshold immediately. The summary model is reloaded from the global/workspace `.reina/config.json` before the next compaction too.

## What Gets Preserved

Compaction preserves recent messages by count and estimated token budget. Older messages are summarized into `session.summary`, which is injected through the system prompt. The provider state is reset after compaction so OpenAI/Anthropic tool-call state does not reference pruned context.

Before older messages are removed from `session.modelMessages`, Reina appends them to `.reina/conversation_history/<session-id>.md`. The boundary stores that relative path so the agent can recover exact earlier details when needed.

After compaction, Reina reinjects a model-only restored-context message. It includes the history path, recently read file snippets, active skill names, and active memory file paths. This message is not appended to the visible transcript.

Each compaction emits `context-compaction-started` before summary/offload work begins, then either `context-compacted` with the final boundary or `context-compaction-failed` with an error. Each successful compaction writes a `compactBoundaries` entry with:

- trigger type: `manual` or `auto`
- estimated tokens before and after
- compacted and preserved message counts
- preserved message ids
- preserved segment metadata
- conversation history path
- model-only reinjected message ids
- reason and timestamp

The UI receives the compaction stream events and shows a compact status line, while transcript scrollback remains intact.

## Context-Window Recovery

If a provider still rejects a model request as too large, Reina treats that separately from transient API retries. It first trims oversized pending tool observations and rebuilds the request. If that is not enough, it runs an emergency auto-compaction and retries once with the compacted model view.

This recovery is intentionally bounded: it does not keep trimming in a loop, and it does not delete visible transcript history. Full tool outputs remain in the session records; only the model-facing retry payload is shortened.
