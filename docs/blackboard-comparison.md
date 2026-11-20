# Reina Blackboard vs Cairn Blackboard

## Purpose

Reina should keep a general-purpose blackboard model rather than copying Cairn's narrower `Fact / Intent / Hint` graph directly.

Cairn is optimized for goal-directed state-space search: start from an origin, explore unknown paths, and stop when enough facts prove the goal. That fits CTF and penetration-testing workflows well.

Reina's target is broader: code audit, code modification, investigation, planning, verification, and other general agent-team work. Those workflows need a blackboard that can hold findings, leads, decisions, work items, artifacts, and directed messages.

## Cairn's Blackboard

Cairn records a single project graph:

- `Project`: project metadata, status, origin, goal, and current project-level `reason` lease.
- `Fact`: confirmed objective fact. Each fact has an `id` and `description`.
- `Intent`: an exploration edge from one or more facts toward a future fact. It records `from`, `to`, `description`, `creator`, `worker`, heartbeat time, creation time, and conclusion time.
- `Hint`: graph-external strategy note or situational advice. It is read by agents but does not participate in causal graph edges.

The important design property is that Cairn preserves the reasoning path:

```text
origin -> intent -> fact -> intent -> fact -> ... -> goal
```

An `Intent` can reference multiple source facts, so it can represent a hyperedge:

```text
f002 ----\
          intent -> f006
f004 ----/
```

That is useful when several confirmed facts jointly justify the next exploration step.

## Reina's Blackboard

Reina already has a blackboard, but it is split across three layers.

### Shared Notes

Shared Notes are Reina's knowledge blackboard.

Each note is stored as Markdown under:

```text
.reina/notes/<id>.md
```

The note index records:

- `id`
- `title`
- `tags`
- `refs`
- `status`
- `author`
- `recipient`
- `createdAt`

The body is loaded lazily with `read_note(id)`, while `list_notes` returns only the compact index. This keeps shared knowledge visible without flooding every agent's context.

Recommended semantics:

```text
status=open       lead or provisional finding
status=confirmed  verified finding or accepted fact
status=dead       false positive or ruled-out path
status=todo       action item
```

Recommended tags:

```text
kind:finding
kind:lead
kind:decision
kind:artifact
sev:high
sev:med
sev:low
component:auth
cwe-89
file:src/foo.ts
```

`refs` is the main causal-link mechanism. If one finding builds on another, the new note should reference the earlier note id.

### Subtask DAG

The Subtask DAG is Reina's planning and scheduling blackboard.

Each subtask records:

- `id`
- `title`
- `description`
- `owner`
- `status`
- `blockedBy`
- `blocks`
- `asyncTaskIds`
- `phase`
- `tags`
- `resultSummary`

This represents work decomposition, dependencies, ownership, and progress. It should not be treated as the source of truth for audit findings; findings belong in Notes.

### Async Task Records

`AsyncTaskRecord` is the subagent execution ledger.

It records:

- child agent profile
- original brief
- status
- result or error
- worktree metadata
- token and duration usage
- background/fork/resume flags

This is useful for lifecycle, UI, debugging, and cost accounting, but it should not be the long-term knowledge blackboard. Important child results should be promoted into Notes.

## Comparison

| Dimension | Cairn | Reina |
| --- | --- | --- |
| Core model | `Fact -> Intent -> Fact` graph | Notes + Subtask DAG + AsyncTaskRecord |
| Best fit | Goal-directed search | Code audit, coding, investigation, general agent teams |
| Knowledge unit | Confirmed fact | Note: finding, lead, decision, artifact, message |
| Work unit | Intent | Subtask + async task |
| Causal links | `Intent.from` and `Intent.to` | `note.refs`, `subtask.blockedBy`, `asyncTaskIds` |
| Agent coordination | Claim, heartbeat, conclude | Spawn, check, update, cancel, notes, directed messages |
| Strength | Clean audit path from origin to goal | Flexible collaboration across many coding workflows |
| Weakness | Narrow schema for general work | Requires conventions to keep notes structured |

## Design Direction

Reina should borrow Cairn's principle, not its exact schema.

The useful principle is:

> Agents should coordinate through durable shared state, not fragile conversation history.

For Reina, that means:

1. Subagents write durable findings and leads into Notes.
2. The lead agent uses the Subtask DAG to schedule work.
3. Important execution results are promoted from `AsyncTaskRecord.result` into Notes.
4. Notes use `refs` to preserve causal chains and combination findings.
5. Dead ends are recorded as `status=dead` notes so later workers do not repeat them.
6. Directed team messages use note `recipient`, not ad hoc parent-child chat.

## Practical Mapping

| Cairn Concept | Reina Equivalent | Notes |
| --- | --- | --- |
| `Fact` | `note(status=confirmed, kind:finding)` | Confirmed objective finding or accepted fact |
| `Intent` | `subtask` or `note(status=open, kind:lead)` | Use subtask for assigned work; use lead note for investigative direction |
| `Hint` | `note(kind:decision)` or directed note | Strategy, handoff, human guidance, situational summary |
| `Project.reason` | lead agent synthesis turn | Reina does not need a server-side reason lease for normal local sessions |
| `worker` claim | `owner` + `asyncTaskIds` | Subtask ownership plus concrete child execution attempts |
| `conclude` | `note(status=confirmed/dead)` + `update_subtask` | Promote outcome into durable knowledge and mark task state |

## Recommendation

Keep Reina's current blackboard architecture:

- Shared Notes for knowledge.
- Subtask DAG for planning.
- AsyncTaskRecord for execution lifecycle.

Do not rename everything to Cairn's `Fact / Intent / Hint`, because code audit and general coding work need richer vocabulary than path search.

Instead, enforce a lightweight convention:

```text
Every meaningful subagent result should end as one of:
- confirmed finding note
- open lead note
- dead note
- decision note
- artifact note

Every assigned unit of work should be represented as a subtask when team mode is active.
Every subtask result should cite the notes it produced or consumed.
```

This gives Reina the same core advantage as Cairn, durable cross-agent coordination, while keeping the flexibility needed for code audit and general software engineering.
