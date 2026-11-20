# Engine Lifecycle Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `AgentEngine` owner stop active work, await settlement, and dispose resources without leaving untracked NotesService writers or rollout recorders.

**Architecture:** `AgentHost` owns the lifetime of registered engines and stores each active turn Promise as a settlement barrier. Subagent identity is supplied during construction so child engines never start private Notes services before inheriting the parent services. Temporary session listing reads the directory directly instead of constructing an engine.

**Tech Stack:** TypeScript, Node.js promises/filesystem APIs, Vitest.

## Global Constraints

- Preserve the current public desktop protocol and approval behavior.
- Do not add timeouts or new configuration knobs.
- Do not commit or stage; the current working tree contains user-owned changes.
- Keep retrying directory removal only as a Windows filesystem backstop.

---

### Task 1: Track and settle active host turns

**Files:**
- Modify: `packages/agent-host/src/index.ts`
- Test: `packages/agent-host/src/index.test.ts`

**Interfaces:**
- Produces: `HostSession.turnPromise: Promise<void> | null`
- Produces: asynchronous `closeSession(...): Promise<DesktopResponse>`
- Consumes: `AgentEngine.interrupt()` and `AgentEngine.dispose()`

- [x] **Step 1: Write failing lifecycle tests**

Add tests that replace `engine.runTurn` with a controlled Promise and replace `engine.interrupt` with a resolver. Assert that both `host.close()` and `close_session` call interrupt, wait for the controlled turn to settle, call dispose exactly once, and emit no late events.

- [x] **Step 2: Run the tests and verify red state**

Run:

```powershell
npm test -- --reporter=dot packages/agent-host/src/index.test.ts
```

Expected: the new assertions fail because the host neither tracks the active Promise nor disposes `close_session` engines.

- [x] **Step 3: Implement the settlement barrier**

Add `turnPromise` to `HostSession`, assign the complete `runTurn(...).then(...).catch(...).finally(...)` chain in `startTurn`, and clear it only when that exact Promise settles. For shutdown, detach sessions from the map first, interrupt active engines, await their captured turn Promises, then dispose. Make `closeSession` async and use the same order.

- [x] **Step 4: Re-run the host tests**

Expected: all `packages/agent-host/src/index.test.ts` tests pass with no hanging controlled Promise.

---

### Task 2: Prevent child engines from starting private Notes services

**Files:**
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/src/engine.test.ts`

**Interfaces:**
- Produces: internal constructor options `{ isSubagent?: boolean; subagentDepth?: number }`
- Consumes: existing parent `notesService`, `notesInitPromise`, `globalNotesService`, and `globalNotesInitPromise`

- [x] **Step 1: Write a failing constructor-order test**

Spy on `NotesService.prototype.init`, construct a parent engine, record the two parent init calls, then invoke the private `spawnChildEngine` test seam. Assert that spawning the child adds zero init calls while the child still references the parent's services and Promises.

- [x] **Step 2: Run the focused test and verify red state**

Run:

```powershell
npm test -- --reporter=dot packages/core/src/engine.test.ts
```

Expected: the new call-count assertion fails because the child currently starts workspace and global Notes initialization before `isSubagent` is set.

- [x] **Step 3: Set subagent state during construction**

Accept internal constructor options, place `isSubagent` and `subagentDepth` into the initial session object before `startNotesService()` and `startSubtaskStore()`, and pass those options from `spawnChildEngine`. Retain the existing parent-service sharing assignments.

- [x] **Step 4: Re-run the engine tests**

Expected: the child adds no Notes init calls and the full engine test file passes.

---

### Task 3: Dispose every temporary or replaced engine resource

**Files:**
- Modify: `packages/agent-host/src/index.ts`
- Modify: `packages/core/src/engine.ts`
- Test: `packages/agent-host/src/index.test.ts`
- Test: `packages/core/src/engine.test.ts`

**Interfaces:**
- Consumes: `node:fs/promises.readdir`
- Produces: `loadSession()` that awaits the old recorder close and both new Notes init Promises

- [x] **Step 1: Write failing ownership tests**

For cold `list_sessions`, use a temporary cwd and assert that listing an empty session directory does not create a rollout JSONL file. For `loadSession`, use a recorder close spy and controlled workspace/global init Promises to assert the method does not resolve before all three settle.

- [x] **Step 2: Verify the tests fail**

Run the two affected test files. Expected: cold listing creates a temporary engine rollout, and `loadSession` returns without waiting for every resource.

- [x] **Step 3: Remove temporary engine construction and await replacements**

Read `<cwd>/.reina/sessions` directly in `AgentHost.listSessions`. In `AgentEngine.loadSession`, await the previous recorder close before nulling it, then await both workspace and global Notes initialization after restarting the services.

- [x] **Step 4: Re-run focused tests**

Expected: no ghost session file, recorder close is ordered, and load waits for both Notes tiers.

---

### Task 4: Repository verification

**Files:**
- Verify only; no additional production changes unless a check exposes a regression.

- [x] **Step 1: Run targeted tests**

```powershell
npm test -- --reporter=dot packages/agent-host/src/index.test.ts packages/core/src/engine.test.ts packages/core/src/subagent/bubble.test.ts packages/core/src/goal-verify.test.ts packages/core/src/controllers/turn-context.test.ts packages/core/src/gc.test.ts packages/core/src/title.test.ts packages/core/src/rollout.test.ts
```

- [x] **Step 2: Run type checking and changed-file lint**

```powershell
npm run check
npx eslint packages/agent-host/src/index.ts packages/agent-host/src/index.test.ts packages/core/src/engine.ts packages/core/src/engine.test.ts
```

- [x] **Step 3: Run the complete suite twice**

```powershell
npm test -- --reporter=dot
npm test -- --reporter=dot
```

Expected: both runs report zero failures and no Windows teardown error.

- [x] **Step 4: Inspect the final patch**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors and only the intended lifecycle/test/plan files plus pre-existing user changes.
