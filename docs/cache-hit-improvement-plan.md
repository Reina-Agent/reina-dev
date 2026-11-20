# Cache Hit Improvement Plan

> Status: proposal. No code has been changed for this plan yet.

## Goal

Improve LLM prompt cache hit rate without weakening prompt correctness.

The target is not just "make the prompt shorter". The target is to keep the reusable prompt prefix byte-stable across normal turns, resume, compaction, and subagent fork paths, while moving volatile state into explicit contextual updates.

## Current Findings

Reina already has partial cache support:

- OpenAI requests set `prompt_cache_key`, but the key is derived from the full `systemPrompt` hash in `packages/providers/src/index.ts`.
- Anthropic requests mark the whole system prompt with `cache_control` and also mark the last tool with `cache_control`.
- `cachedInputTokens` is captured and displayed, but Anthropic cache creation tokens are not captured.
- `buildHiddenToolsReminder` is already outside the system prompt, which is the right direction for Anthropic because deferred tool visibility changes frequently.

The main problem is that `packages/core/src/engine-prompt.ts` mixes stable and volatile content in one system prompt:

- stable: base agent prompt, profile guidance, tool-selection guidance
- semi-stable: skills, user rules, workspace rules
- volatile: summary, memory chunk index, plan, todos, notes index, autopilot state, cwd-dependent shell guidance

When volatile content changes, OpenAI's current hash-based cache key changes, and Anthropic's exact prefix cache becomes cold.

## Reference: Codex

The reference implementation under `参考/codex` points to a better architecture:

- OpenAI uses a stable thread id for `prompt_cache_key`, not a hash of the current instructions.
- Codex keeps a `reference_context_item` baseline and emits only contextual diffs on steady-state turns.
- Codex persists one turn context item per real user turn even when no visible diff is emitted, so resume and fork can recover the diff baseline.
- Codex fork supports full-history and last-N-turn modes; full-history fork inherits model/reasoning/agent type instead of allowing incompatible overrides.
- Codex compaction can clear or re-establish the context baseline depending on whether canonical context is reinserted.

This suggests Reina should not implement a one-off "move some text out of system prompt" patch. The more durable fix is stable base prompt + contextual baseline/diff + provider-specific cache placement.

## Provider Strategy

### OpenAI

OpenAI has automatic prefix caching and a `prompt_cache_key` routing hint.

Plan:

1. Add an optional `promptCacheKey` field to `ModelRequest`.
2. Populate it from a stable session/thread id in the engine.
3. Make OpenAI providers prefer `request.promptCacheKey`.
4. Keep the existing system-prompt hash only as a fallback.

Rationale:

- A stable key avoids cache-key churn when volatile context changes.
- Prefix stability still matters; the stable key alone is not enough.
- Provider changes touch `openaiPromptCacheKey`, which previously showed HIGH blast radius in GitNexus, so this must be done with focused tests.

### Anthropic

Anthropic prompt caching has no cache key. It caches exact prompt prefixes up to explicit `cache_control` breakpoints. The prompt order is `tools`, then `system`, then `messages`.

Plan:

1. Stop treating Anthropic `system` as one large string cache block.
2. Represent system prompt as ordered sections:
   - stable base instructions
   - semi-stable profile/skills/rules
   - volatile contextual updates
3. For Anthropic, send `system` as `TextBlockParam[]`.
4. Put `cache_control` on the last stable or semi-stable block, not on the whole prompt.
5. Keep volatile context after the stable breakpoint, or emit it as message-level contextual updates.
6. Continue caching tools, but keep tool ordering deterministic.
7. Record `cache_creation_input_tokens` in addition to `cache_read_input_tokens`.

Rationale:

- Anthropic requires exact prefix matches. A changing summary or todo list before the cache breakpoint invalidates the cache.
- The existing hidden-tools reminder design should remain outside the stable prefix.
- Anthropic supports multiple breakpoints, but the first implementation should use the minimum number needed: tools and stable system sections.

Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

## Context Architecture

Introduce a context baseline/diff layer similar to Codex.

Proposed model:

```ts
type PromptContextSnapshot = {
  cwd: string;
  agent: string;
  outputStyle?: string;
  goalsDigest?: string;
  skillsDigest?: string;
  rulesDigest?: string;
  summaryDigest?: string;
  memoryIndexDigest?: string;
  planDigest?: string;
  todosDigest?: string;
  notesDigest?: string;
  autopilotDigest?: string;
};
```

Plan:

1. Build a stable base prompt from invariant instructions.
2. Build full contextual injection when no baseline exists.
3. Store the latest prompt context snapshot on the session.
4. On normal turns, compare previous and current snapshots.
5. Emit only changed sections as contextual user/developer messages.
6. Advance the snapshot even when no diff is emitted.
7. Reset or re-establish the snapshot during compaction and resume.

Initial dynamic sections to move out of the stable system prompt:

- conversation summary
- memory chunks index
- current plan
- todo state and todo nudge
- notes index
- autopilot state
- cwd-dependent shell guidance

Sections to evaluate carefully before moving:

- active goals, because they gate completion behavior
- user/workspace rules, because they have authority semantics
- skills, because skill visibility may be part of capability selection

## Fork And Resume

Reina already has `buildForkContext`, but the saved async task currently persists `fork: true` without persisting the serializable `forkContext` snapshot. `rebuildForkContext` exists, but the manager path does not fully use it.

Plan:

1. Persist `ctx.forkContext` on `AsyncTaskRecord` when starting a forked subagent.
2. Use `rebuildForkContext` during recoverable resume.
3. Mark `forkContextLost` only when the saved snapshot cannot be reconstructed.
4. Add a fork mode shape closer to Codex:
   - `none`
   - `all`
   - last N turns
5. For full-history fork, disallow model/reasoning/profile overrides unless the child is spawned without full-history fork.

Rationale:

- Fork cache reuse depends on the child seeing the same prefix as the parent.
- If a full-history fork changes model or profile, the inherited prefix and actual runtime semantics diverge.
- Persisted fork context is needed for restart recovery.

## Compaction

Compaction must cooperate with the prompt context baseline.

Plan:

1. If compaction removes the context that established the current baseline, clear the prompt context snapshot.
2. On the next normal turn after snapshot clear, inject full contextual state once.
3. If compaction replacement history includes canonical initial context, re-establish the snapshot at that point.
4. Keep summaries out of the stable provider cache prefix unless they are intentionally placed after the stable breakpoint.

Rationale:

- A stale context baseline is worse than a cold cache because it can omit needed instructions.
- Full reinjection after compaction is acceptable; steady-state turns should return to diff-only updates.

## Implementation Phases

### Phase 0: Measurement

Add cache telemetry before risky changes:

- OpenAI: input tokens, cached input tokens, cache hit ratio.
- Anthropic: input tokens, cache read tokens, cache creation tokens, cache hit ratio.
- Group by provider, model, session kind, fork/non-fork, and compaction count.

Success criteria:

- We can distinguish cache creation from cache read on Anthropic.
- We can compare hit rate before and after prompt-shape changes.

### Phase 1: Low-Risk Provider Plumbing

Add `ModelRequest.promptCacheKey` and use stable session id for OpenAI.

Success criteria:

- Existing tests pass.
- OpenAI requests keep using prompt cache when enabled.
- Existing hash fallback remains available.

### Phase 2: Prompt Sections

Refactor `buildSystemPrompt` into stable and contextual sections.

Success criteria:

- The stable base prompt is byte-identical across turns when profile/rules/skills do not change.
- Volatile state appears in contextual updates instead of the stable base prompt.
- Existing behavior remains visible to the model.

### Phase 3: Anthropic Block Cache

Send Anthropic system as ordered text blocks with cache breakpoints on stable blocks.

Success criteria:

- Anthropic cache reads increase on repeated turns.
- Dynamic context changes do not invalidate the stable system cache.
- Cache unsupported fallback still works.

### Phase 4: Context Baseline Persistence

Persist and restore prompt context snapshots across normal turns, resume, fork, and compaction.

Success criteria:

- Resume after restart does not lose the diff baseline.
- Compaction clears or re-establishes the baseline intentionally.
- Forked subagents either inherit context correctly or explicitly degrade with `forkContextLost`.

### Phase 5: Fork Mode Cleanup

Replace the current boolean fork shape with explicit fork modes.

Success criteria:

- Full-history fork prevents incompatible overrides.
- Last-N fork is deterministic and tested.
- Subagent cache usage can be measured separately from parent turns.

## Test Plan

Provider tests:

- OpenAI uses stable `promptCacheKey` when provided.
- OpenAI falls back to system prompt hash when no key is provided.
- Anthropic system blocks put `cache_control` only on intended stable blocks.
- Anthropic usage maps both cache read and cache creation tokens.

Core prompt tests:

- Stable base prompt remains unchanged when only todos/plan/summary change.
- Contextual diff emits changed sections only.
- Missing baseline triggers full contextual injection.
- Snapshot advances even when no diff is emitted.

Fork/resume tests:

- Fork persists `forkContext`.
- Resume rebuilds fork context when referenced messages still exist.
- Resume marks `forkContextLost` when reconstruction fails.
- Full-history fork rejects incompatible model/reasoning/profile overrides.

Compaction tests:

- Compaction that removes baseline context clears snapshot.
- Next normal turn reinjects full contextual state.
- Replacement history with canonical context re-establishes snapshot.

## Risks

- Moving authoritative content out of system prompt can change model behavior. Active goals and user rules need extra care.
- Anthropic block ordering must remain deterministic, or cache hit rate will be noisy.
- OpenAI stable key improves routing but does not fix cache misses if the actual prefix keeps changing.
- Fork cache reuse can hide context bugs; tests should assert both inherited prompt shape and runtime config.

## Recommended First Patch

Start with measurement and request plumbing:

1. Add `cacheCreationInputTokens` to usage types and Anthropic mapping.
2. Add `promptCacheKey` to `ModelRequest`.
3. Pass a stable session id from engine to provider.
4. Keep all prompt text unchanged.

This gives visibility and lowers risk before changing prompt structure.

