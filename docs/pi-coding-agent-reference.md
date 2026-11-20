# Pi coding-agent reference notes

Reference inspected: local reference tree `Reina/reference/pi/packages/coding-agent`

Date: 2026-05-19

## Summary

Pi is worth studying as a reliability and boundary-design reference, not as a feature blueprint.

Reina already has product-specific capabilities that Pi intentionally avoids: subagents, MCP, shared notes, autopilot, desktop approvals, deferred tools, and audit-oriented durable state. Those should stay. The parts worth borrowing from Pi are narrower: places where Pi has small, well-isolated implementations that reduce common agent failure modes.

The confirmed high-confidence references are:

1. File mutation queue
2. Tool output truncation utilities
3. Session runtime boundary
4. Typed extension lifecycle
5. Regression suite organization
6. Minimal default tool surface

The conditional references are:

1. Credential/config file locking
2. Session tree and branch navigation

Everything else is either already covered better in Reina, too terminal-specific, or mismatched with Reina's audit/autopilot direction.

## Evaluation Criteria

I treated a Pi design as worth referencing only if it passed most of these checks:

- It solves a repeated coding-agent failure mode, not just a UI preference.
- It is small enough to borrow without importing Pi's whole architecture.
- It fits Reina's desktop + audit + subagent direction.
- It has clear tests or is easy to test.
- It reduces hidden state, race conditions, prompt bloat, or lifecycle ambiguity.
- It does not weaken Reina's existing strengths.

That is why the list is intentionally short.

## High-confidence references

### 1. File mutation queue

Reference:

- `reference/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts`
- Reina target: `packages/tools/src/tools/files/edit-file.ts`

What Pi does:

Pi serializes mutations by resolved real file path. If two tool calls edit the same file, the second waits for the first. If two tool calls edit different files, they can still proceed independently.

Why this is worth referencing:

Coding agents often make multiple file edits in one turn, and tool calls may be concurrent depending on provider behavior, host implementation, or future batching. Without a per-file mutation queue, two writes to the same file can race:

- both read the same old content
- edit A writes successfully
- edit B writes based on stale content and silently overwrites A
- the final diff loses one of the model's intended changes

This class of bug is hard to spot because each individual tool call can report success. The agent only sees later test failures or confusing diffs.

Why Pi's implementation is good:

- It is tiny and isolated.
- It uses the normalized real path as the lock key, so symlink/relative path aliases are less likely to bypass the queue.
- It keeps concurrency for unrelated files.
- It cleans the queue entry after the last waiter completes.

Reina status:

Reina already has similar locking in `packages/tools/src/tools/files/edit-file.ts`, which is the right idea. But the cleanup logic should be reviewed. The current shape stores a chained promise in the map, then compares the stored value to the unchained current promise in `finally`. That can leave stale entries in the lock map.

Recommended Reina action:

- Fix the cleanup logic or adopt Pi's queue shape.
- Add tests for:
  - two edits to the same file are serialized
  - edits to different files are not globally blocked
  - the lock map is cleaned after completion
  - stale-read protection still fires when a file changed after `read_file`

Expected benefit:

- Fewer lost edits.
- Better behavior when subagents or future parallel tool execution edit nearby files.
- Less hidden state leakage over long desktop sessions.

Confidence: high.

Priority: first.

### 2. Tool output truncation utilities

Reference:

- `reference/pi/packages/coding-agent/src/core/tools/truncate.ts`
- Reina target: `packages/tools/src/utils.ts`

What Pi does:

Pi has shared truncation helpers with explicit semantics:

- head truncation for file reads
- tail truncation for shell output
- independent line and byte limits
- UTF-8-safe truncation
- metadata explaining what was truncated and why

Why this is worth referencing:

Tool output is one of the main ways coding agents damage their own context. Too much output pushes important instructions and recent work out of the model's attention. The opposite problem is also common: naive truncation removes the useful part of the output.

Different tools need different truncation policies:

- File reads usually need the beginning or a requested range.
- Shell commands usually need the end, where errors and summaries appear.
- Grep output needs bounded line lengths.
- Large outputs need a way to recover the full body later.

If truncation is ad hoc per tool, the model gets inconsistent observations. That makes it harder to learn how to recover.

Why Pi's implementation is good:

- The policy is centralized.
- It avoids partial lines for normal head truncation.
- It handles UTF-8 byte boundaries.
- It returns structured metadata, so renderers and tests can assert behavior precisely.

Reina status:

Reina already has a strong behavior Pi does not emphasize as much: when output is truncated, Reina saves the full output under `.reina/tool-output`. That should stay. The weaker part is the truncation itself: byte slicing is simpler and may cut through multi-byte text or remove the wrong side of shell output.

Recommended Reina action:

- Keep full-output saving.
- Borrow the structured truncation helper idea.
- Use head truncation for `read_file`.
- Use tail truncation for `run_shell` and background task output.
- Return/record truncation metadata where useful.

Expected benefit:

- Better context hygiene.
- Fewer "model missed the actual error because output was truncated wrong" failures.
- Easier tests for large output behavior.
- Better Chinese/Unicode output handling on Windows.

Confidence: high.

Priority: second.

### 3. Session runtime boundary

Reference:

- `reference/pi/packages/coding-agent/src/core/agent-session-runtime.ts`
- `reference/pi/packages/coding-agent/test/suite/agent-session-runtime.test.ts`

What Pi does:

Pi separates the active session object from session lifecycle orchestration. The runtime owns transitions such as:

- start
- new session
- resume
- fork
- import
- teardown
- extension shutdown
- rebind services for a new cwd

Why this is worth referencing:

Agent lifecycle bugs are usually not inside one model turn. They appear at boundaries:

- resume a session from another cwd
- fork a prior point
- reload extensions
- compact and continue
- switch model/provider
- shut down while work is still settling
- rebuild services after cwd changes

If these transitions are spread across UI, host, engine, and store code, each new feature adds another special case. The system becomes hard to test because reproducing lifecycle bugs requires the whole desktop app.

Why Pi's implementation is good:

- Lifecycle transitions have one owner.
- Teardown happens before replacement.
- Extension/session events are emitted in a deterministic order.
- Tests can characterize transition behavior without running the full UI.

Reina status:

Reina already has an important process boundary: Electron renderer -> main -> agent-host -> core engine. That boundary is good. But session lifecycle can still become scattered as features grow: desktop state, agent-host requests, engine state, store persistence, and renderer refresh can all want to participate.

Recommended Reina action:

- Do not add this as an immediate refactor just for cleanliness.
- When touching resume/fork/durable recovery, introduce a small runtime facade that owns lifecycle transitions.
- Write characterization tests for each transition before adding more behavior.

Expected benefit:

- Fewer resume/fork bugs.
- Easier durable recovery.
- Clearer shutdown semantics.
- Less coupling between desktop UI and core agent lifecycle.

Confidence: high for future session work.

Priority: third only if session lifecycle work is active.

### 4. Typed extension lifecycle

Reference:

- `reference/pi/packages/coding-agent/docs/extensions.md`
- `reference/pi/packages/coding-agent/src/core/extensions/`
- `reference/pi/packages/coding-agent/src/core/agent-session.ts`

What Pi does:

Pi exposes a typed event lifecycle around the agent:

- `before_agent_start`
- `agent_start`
- `turn_start`
- `context`
- `before_provider_request`
- `after_provider_response`
- `tool_call`
- `tool_result`
- `turn_end`
- `agent_end`
- `session_before_compact`
- `session_shutdown`

It also centralizes tool interception before and after execution.

Why this is worth referencing:

Agent platforms attract feature hooks: permissions, audit logs, prompt injection, context filters, custom tools, renderers, notifications, and safety gates. If each feature adds its own special path, the agent becomes unpredictable:

- one hook sees pre-permission data, another sees post-permission data
- one hook can block, another cannot
- one hook mutates tool results, another logs stale values
- failures are handled differently depending on where they occur

A typed lifecycle makes hook ordering and failure semantics explicit.

Why Pi's implementation is good:

- Tool-call interception has a single path.
- Session lifecycle events are first-class.
- Extensions can inspect/modify specific phases instead of monkey-patching core behavior.
- Error handling is differentiated: blocking hooks fail safe, non-critical hooks can report without killing the session.

Reina status:

Reina already has hooks, permissions, MCP tools, deferred tools, skills, and desktop HITL. This means Reina needs a stable hook contract even more than Pi does. The risk is not missing hooks; the risk is growing too many incompatible hook surfaces.

Recommended Reina action:

- Treat Pi's lifecycle as a vocabulary reference.
- Consolidate Reina hooks into clear phases.
- Keep permission decisions and tool interception centralized.
- Make hook failure semantics explicit:
  - permission/tool gate failures should fail closed
  - telemetry/render/status failures should not crash the agent

Expected benefit:

- Safer plugin/extensibility work.
- Less accidental bypass of permissions.
- Easier debugging when a hook changes model context or tool output.
- Cleaner future support for user-installed agent extensions.

Confidence: high.

Priority: architectural, not urgent unless plugin/extensibility work starts.

### 5. Regression suite organization

Reference:

- `reference/pi/packages/coding-agent/test/suite/`
- `reference/pi/packages/coding-agent/test/suite/regressions/`

What Pi does:

Pi has many tests that characterize agent harness behavior rather than just utility functions. Examples include:

- session runtime events
- queue behavior
- compaction
- dynamic tools
- allowlist filtering
- stale resource reloads
- event settlement
- prompt and tool rendering edge cases

Why this is worth referencing:

Coding-agent regressions are rarely simple "function returns wrong value" bugs. They often involve a sequence:

1. user submits prompt
2. model calls a tool
3. host transforms or gates the tool
4. tool result is persisted
5. compaction or resume changes state
6. next turn sees a slightly wrong context

Without scenario tests, these bugs only show up in real usage.

Why Pi's test organization is good:

- It keeps historical bug cases as named regression files.
- It tests lifecycle/event ordering directly.
- It covers prompt/tool visibility, not just business logic.
- It makes subtle harness contracts executable.

Reina status:

Reina already has useful tests in core/tools/providers/store. The opportunity is to add more agent-harness regression tests around the exact places Reina is becoming sophisticated.

Recommended Reina regression areas:

- deferred tool unmasking
- direct-call fallback for deferred tools
- stable system prompt prefix vs volatile reminders
- prompt budget accounting
- file mutation locks
- compaction recovery and memory chunks
- subagent settlement
- subagent resume/reconciliation
- permission allow/deny/ask order
- tool loop stop reasons
- notes/autopilot stop gates

Expected benefit:

- Safer iteration on agent behavior.
- Faster refactors because lifecycle contracts are pinned down.
- Better confidence before changing prompt/tool/session internals.

Confidence: high.

Priority: continuous. Add tests when touching each area.

### 6. Minimal default tool surface

Reference:

- `reference/pi/packages/coding-agent/src/core/tools/index.ts`
- `reference/pi/packages/coding-agent/src/core/system-prompt.ts`

What Pi does:

Pi starts with a very small default tool surface: read, write, edit, bash, plus optional exploration tools. Larger capabilities are opt-in through extensions, skills, packages, or settings.

Why this is worth referencing:

Every exposed tool has three costs:

- prompt/token cost
- model decision cost
- safety and permission surface

Large tool lists make the model worse at selecting the right tool. They also make provider requests bigger and less cache-friendly.

Why Pi's approach is good:

- The model starts with only the basic coding primitives.
- Optional capabilities do not pollute every turn.
- The default behavior is easier to reason about.

Reina status:

Reina already has a stronger version of this idea:

- direct tools for common work
- deferred tools for cold/specialty capabilities
- `search_tool` to discover deferred tools
- active deferred tools remembered per session
- hidden-tool reminders kept outside the stable cached prompt

So Pi is not something to copy here. It validates Reina's direction.

Recommended Reina action:

- Keep cold-start tools small.
- Keep subagent, notes, MCP, wakeup, network, and specialty tools deferred unless the active profile truly needs them.
- Continue testing prompt-size and cache-hit behavior.

Expected benefit:

- Better model tool selection.
- Lower prompt cost.
- Higher cache reuse.
- Smaller permission attack surface.

Confidence: high.

Priority: already mostly implemented; preserve it.

## Conditional references

### 1. Credential/config file locking

Reference:

- `reference/pi/packages/coding-agent/src/core/auth-storage.ts`
- Reina related areas: `apps/desktop/src/main/ipc.ts`, model config writes, permission config writes

What Pi does:

Pi uses file locking around credential storage and OAuth token refresh. This prevents multiple agent instances from refreshing or writing credentials at the same time.

Why it may be worth referencing:

Config writes are usually safe in a single desktop process. They become risky when there are multiple writers:

- multiple Reina windows
- background agent-host plus desktop main process
- future CLI entrypoint
- concurrent OAuth refresh
- external editor modifying config

Without locking, one writer can overwrite another writer's update.

Reina status:

Reina currently writes model and permission config from desktop main IPC paths. If the product remains single-writer, adding lockfile complexity now is probably not worth it.

Recommended Reina action:

- Do not add lockfile dependency just because Pi has it.
- Add a small locked-write helper only if multiple writers become real.
- If added, use it for credentials/config files consistently.

Expected benefit if needed:

- Fewer corrupted config files.
- Safer multi-window or CLI/desktop coexistence.
- Safer token refresh in future OAuth flows.

Confidence: medium.

Priority: conditional.

### 2. Session tree and branch navigation

Reference:

- `reference/pi/packages/coding-agent/src/core/session-manager.ts`
- `reference/pi/packages/coding-agent/src/core/agent-session.ts`

What Pi does:

Pi stores session entries as a tree. Users can navigate to previous points, fork, clone, and continue from branches while preserving history.

Why it may be worth referencing:

Branching is useful when agent work reaches a decision point:

- try two refactor approaches
- backtrack after a bad direction
- preserve a previous plan
- compare two model/provider runs

Why it is conditional:

Session trees add UI and mental-model complexity. Reina's audit/autopilot workflows may benefit more from durable notes, goals, phases, and reports than from conversation-tree navigation.

Recommended Reina action:

- Borrow only if users explicitly need in-place branch navigation.
- For audit work, prefer durable notebook/report artifacts first.
- If branching is added, copy Pi's discipline around lifecycle tests and branch summaries, not necessarily the exact UI.

Expected benefit if needed:

- Safer experimentation.
- Better recovery from bad agent turns.
- More inspectable long sessions.

Confidence: medium.

Priority: conditional.

## What not to copy

### Pi's "no built-in subagents / no MCP / no plan mode" philosophy

Pi intentionally keeps these out of core. That is a valid philosophy for a minimal terminal harness.

Reina's direction is different. Subagents, MCP, notes, permissions, and autopilot are central to the product. Removing or hiding them to match Pi would make Reina worse for its intended use case.

Decision:

- Do not copy this philosophy.
- Keep Reina's built-in advanced agent capabilities.
- Use deferred exposure and profile gating to control complexity instead.

### Pi's terminal-first UI assumptions

Pi is a TUI/CLI agent. Reina is an Electron desktop app.

Pi UI patterns like custom TUI components, terminal keybindings, and editor replacement are not directly relevant. Reina should borrow lifecycle boundaries and tests, not TUI implementation details.

Decision:

- Do not port Pi's TUI extension surface directly.
- If Reina adds extensions, expose desktop-native UI and IPC concepts.

### Whole extension system as-is

Pi's extension system is mature, but copying the whole thing would be a large product decision.

Decision:

- Do not import the full extension architecture now.
- Evolve Reina's hooks toward a typed lifecycle gradually.
- Add only the extension points needed by real workflows.

### Pi's lack of durable shared audit state

Pi's core does not center shared notes/findings/autopilot. Reina does, and that is appropriate for audit work.

Decision:

- Keep notes/autopilot as Reina-specific strengths.
- Use Pi only to improve reliability around those features.

## Priority order

### Immediate

1. Fix or harden file mutation locking.
2. Add file-lock regression tests.
3. Improve truncation utilities with UTF-8-safe head/tail behavior.

### Near-term

4. Add regression tests for deferred tools and prompt-cache stability.
5. Add regression tests for compaction recovery and subagent settlement.
6. Document hook lifecycle phases before adding new hook surfaces.

### Later, only when needed

7. Add a session runtime facade during session lifecycle work.
8. Add file locking for credentials/config only if multiple writers become real.
9. Add session tree navigation only if users need branching UX.

## Final decision

The confirmed "worth referencing" set is intentionally limited. Pi is useful because it demonstrates disciplined boundaries around common agent harness risks:

- races around file edits
- bad truncation and context pollution
- scattered session lifecycle code
- uncontrolled extension/hook behavior
- insufficient regression coverage
- excessive cold-start tool surface

Those are real best-practice areas for Reina.

Pi's broader product choices should not be treated as best practices for Reina. They serve a different product: a minimal terminal coding harness. Reina should keep its richer desktop, audit, subagent, and durable-state direction, while borrowing Pi's reliability patterns where they fit.
