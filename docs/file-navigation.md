# Reina File Navigation

Short navigation for new sessions. Do not read the whole repo. Use codegraph
first, then open only the files it points to.

## Required Flow

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Use codegraph before broad search or directory reading.
3. If the task touches code, run `codegraph_context` for the feature/flow.
4. Run `codegraph_search` / `codegraph_node` on the exact symbol before editing it.
5. Run `codegraph_impact` before changing any function, class, or method.
6. Read only the returned files plus the small entry list below.
7. Before committing, run `codegraph affected <changed files>` to pick the tests.

If a query returns no useful flow, do not start grepping broadly. Tighten it
with a real symbol or file name from this document, then run `codegraph_context`
on it.

Useful calls (MCP tools; the `codegraph` CLI hits the same index when the
`codegraph_*` MCP tools aren't in the session):

```text
codegraph_search("symbolName")        # where a symbol is defined (kind + file:line)
codegraph_context("feature or flow")  # focused context for a task/area
codegraph_impact("symbolName")        # blast radius before editing
codegraph_callers("symbolName")       # who calls it
```

CLI equivalents (run via Bash):

```powershell
codegraph query "feature or flow"
codegraph context "task description"
codegraph affected <changed files>
codegraph status            # index health; `codegraph sync` forces a refresh
```

For `context:` entries in the table, look the symbol up directly with
`codegraph_search` / `codegraph_node` (or `codegraph query`) — e.g. the symbol
`executeRecord` in `packages/core/src/engine.ts`.

## Start Points

| Task | codegraph First (search/context terms) | Files To Open After codegraph Narrows It |
| --- | --- | --- |
| Chat UI / tool display | `RenderToolProgressRow toolDisplay toolVerb conversation` | `apps/desktop/src/renderer/conversation.js`, `tool-blocks.js`, `styles/chat.css`, `actions/agent-events.js` |
| Composer / submit flow | `createPromptActions sendPrompt submitUserMessage renderSlashCommandPopoverView` | `renderer/composer.js`, `actions/prompt.js`, `actions/session.js`, `state.js` |
| Settings / models / MCP UI | `openProviderModelManager fetchModelsForSelectedProvider persistProviderConfigs fetchRemoteModels` | `renderer/settings.js`, `actions/settings-config.js`, `actions/local-settings.js`, `apps/desktop/src/main/ipc.ts` |
| Electron main / IPC | `AgentHostController handleLine registerIpc reina:invoke host_response` | `apps/desktop/src/main/ipc.ts`, `agent-host-controller.ts`, `host-handlers.ts`, `preload.ts` |
| Agent loop | `context: executeRecord in packages/core/src/engine.ts` | `packages/core/src/engine.ts`, `engine-prompt.ts`, `permissions.ts`, `loop-budget.ts` |
| Tools | `context: runTool in packages/tools/src/runtime.ts` | `packages/tools/src/registry.ts`, `runtime.ts`, `types.ts`, relevant `tools/*` file |
| Providers | `context: nextModelTurnStream in packages/providers/src/index.ts` | `packages/providers/src/index.ts`, `tool-compat.ts`, `packages/protocol/src/index.ts` |
| Protocol / events | `context: desktopRequestSchema in packages/desktop-protocol/src/index.ts` | `packages/protocol/src/index.ts`, `packages/desktop-protocol/src/index.ts` |
| Sessions / persistence | `create session load session rollout SessionStore` | `packages/core/src/rollout.ts`, `store/session-store.ts`, `store/schema.ts`, `apps/desktop/src/main/desktop-state.ts` |
| Compaction | `compact conversation modelMessages session summary` | `packages/core/src/compaction.ts`, `engine-prompt.ts`, related compaction tests |
| Subagents / team DAG | `SubagentManager SubtaskStore createSubtask updateSubtask getDag setPhase sendToWorker` | `packages/core/src/subagent/*`, `subtasks.ts`, `packages/tools/src/tools/agent/team.ts`, renderer `actions/agent-team.js` |
| Wakeups / notifications | `scheduleWakeup handleHostRequest triggerWakeup wakeupStore` | `apps/desktop/src/main/wakeup-scheduler.ts`, `wakeup-store.ts`, `host-handlers.ts`, `packages/tools/src/tools/agent/schedule-wakeup.ts` |

## Main Flow

```text
renderer actions
  -> apps/desktop/src/preload.ts
  -> apps/desktop/src/main/ipc.ts
  -> apps/desktop/src/main/agent-host-controller.ts
  -> packages/agent-host/src/index.ts
  -> packages/core/src/engine.ts
  -> packages/providers/src/*
  -> packages/tools/src/*
```

## Repo Map

| Path | Owns |
| --- | --- |
| `apps/desktop/` | Electron desktop app: renderer, main process, preload, terminal, settings |
| `packages/core/` | Agent runtime, model/tool loop, sessions, permissions, compaction, subagents |
| `packages/tools/` | Local tools and MCP tool exposure |
| `packages/providers/` | Model provider adapters |
| `packages/protocol/` | Shared schemas, enums, trace/session/message/tool types |
| `packages/desktop-protocol/` | Renderer/main/host request and event schemas |
| `packages/agent-host/` | Long-running Node host process for AgentEngine |
| `docs/` | Design notes |
| `参考/` | Read-only external references; do not edit |

## Avoid

- Do not start by reading all of `packages/core/src/engine.ts`.
- Do not scan the whole repo to understand a feature.
- Do not use `README.md` as truth when source or docs disagree.
- Do not edit `参考/`, `node_modules/`, `dist/`, `.git/`, `.reina/`, `.logs/`,
  or renderer `vendor/` unless the task specifically requires it.
- Do not rename via blind text search; list callers with `codegraph_impact`
  first, then edit each site deliberately.
