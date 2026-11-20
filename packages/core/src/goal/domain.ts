import {
  createId,
  nowIso,
  type GoalActor,
  type GoalBudgetLimits,
  type GoalCommand,
  type GoalEvent,
  type GoalRecord,
  type GoalRun,
  type GoalState,
  type SessionGoal,
  type SessionState,
} from "@reina/protocol";

export type GoalUsageSnapshot = {
  tokens: number;
  turns: number;
};

export type GoalTransitionContext = {
  now?: string;
  usage?: GoalUsageSnapshot;
  createId?: (prefix: string) => string;
};

export type GoalTransitionErrorCode =
  | "STALE_REVISION"
  | "GOAL_EXISTS"
  | "GOAL_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "INVALID_INPUT"
  | "STALE_CLAIM";

export type GoalTransitionResult =
  | { ok: true; state: GoalState; changed: boolean }
  | { ok: false; code: GoalTransitionErrorCode; message: string };

const EMPTY_USAGE = { tokensUsed: 0, turnsUsed: 0, wallClockMs: 0 } as const;

export function emptyGoalState(): GoalState {
  return { current: null, history: [], run: null, revision: 0 };
}

export function sessionGoalUsage(session: SessionState): GoalUsageSnapshot {
  return {
    tokens: (session.usage?.inputTokens ?? 0) + (session.usage?.outputTokens ?? 0),
    turns: session.usage?.turns ?? 0,
  };
}

export function projectedGoalUsage(
  state: GoalState,
  usage: GoalUsageSnapshot,
  now = nowIso(),
): GoalRecord["usage"] | null {
  if (!state.current) return null;
  const projected = { ...state.current.usage };
  if (!state.run) return projected;
  projected.tokensUsed += Math.max(0, usage.tokens - state.run.tokenBaseline);
  projected.turnsUsed += Math.max(0, usage.turns - state.run.turnBaseline);
  projected.wallClockMs += Math.max(0, Date.parse(now) - Date.parse(state.run.startedAt));
  return projected;
}

export function cloneGoalState(state: GoalState): GoalState {
  return {
    current: state.current ? cloneGoal(state.current) : null,
    history: state.history.map(cloneGoal),
    run: state.run ? { ...state.run } : null,
    revision: state.revision,
    ...(state.completionClaim ? { completionClaim: { ...state.completionClaim } } : {}),
  };
}

export function transitionGoal(
  inputState: GoalState | undefined,
  command: GoalCommand,
  actor: GoalActor,
  context: GoalTransitionContext = {},
): GoalTransitionResult {
  const state = cloneGoalState(inputState ?? emptyGoalState());
  const now = context.now ?? nowIso();
  const usage = context.usage ?? { tokens: 0, turns: 0 };
  const id = context.createId ?? createId;
  const expectedRevision = "expectedRevision" in command ? command.expectedRevision : undefined;
  if (expectedRevision !== undefined && expectedRevision !== state.revision) {
    return failure(
      "STALE_REVISION",
      `Goal state changed (expected revision ${expectedRevision}, current ${state.revision}). Read the goal again before updating it.`,
    );
  }
  if (!actorCanExecute(command.type, actor)) {
    return failure("INVALID_TRANSITION", `Actor ${actor} cannot execute Goal command ${command.type}.`);
  }

  switch (command.type) {
    case "create": {
      const objective = cleanRequired(command.objective, "Goal objective");
      if (!objective.ok) return objective;
      const budgetLimits = validateBudgetLimits(command.budgetLimits);
      if (!budgetLimits.ok) return budgetLimits;
      if (state.current && state.current.status !== "complete") {
        if (normalizeObjective(state.current.objective) === normalizeObjective(objective.value)) {
          return { ok: true, state, changed: false };
        }
        return failure(
          "GOAL_EXISTS",
          `An unfinished goal already exists (${state.current.id}, ${state.current.status}). Update it or ask the user to replace it.`,
        );
      }
      if (state.current) state.history.push(cloneGoal(state.current));
      const goal = makeGoal(objective.value, command.completionCriterion, budgetLimits.value, actor, now, id);
      state.current = goal;
      state.run = makeRun(goal, usage, now, id);
      delete state.completionClaim;
      return changed(state);
    }

    case "replace": {
      if (actor !== "user" && actor !== "system") {
        return failure("INVALID_TRANSITION", "Only the user can replace the current goal.");
      }
      const objective = cleanRequired(command.objective, "Goal objective");
      if (!objective.ok) return objective;
      const budgetLimits = validateBudgetLimits(command.budgetLimits);
      if (!budgetLimits.ok) return budgetLimits;
      settleCurrentUsage(state, usage, now);
      if (state.current) state.history.push(archiveInterrupted(state.current, "Replaced by the user", now));
      const goal = makeGoal(objective.value, command.completionCriterion, budgetLimits.value, "user", now, id);
      state.current = goal;
      state.run = makeRun(goal, usage, now, id);
      delete state.completionClaim;
      return changed(state);
    }

    case "edit": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (current.goal.status === "complete")
        return failure("INVALID_TRANSITION", "A completed goal cannot be edited. Replace it with a new goal instead.");
      const objective = command.objective === undefined ? current.goal.objective : command.objective.trim();
      if (!objective) return failure("INVALID_INPUT", "Goal objective cannot be empty.");
      const criterion =
        command.completionCriterion === undefined
          ? current.goal.completionCriterion
          : command.completionCriterion.trim() || undefined;
      if (objective === current.goal.objective && criterion === current.goal.completionCriterion) {
        return { ok: true, state, changed: false };
      }
      settleCurrentUsage(state, usage, now);
      current.goal.objective = objective.slice(0, 4000);
      if (criterion) current.goal.completionCriterion = criterion.slice(0, 4000);
      else delete current.goal.completionCriterion;
      current.goal.revision += 1;
      current.goal.updatedAt = now;
      delete current.goal.evidence;
      delete current.goal.terminalReason;
      delete current.goal.completedAt;
      delete state.completionClaim;
      if (current.goal.status === "active") state.run = makeRun(current.goal, usage, now, id);
      return changed(state);
    }

    case "pause": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (current.goal.status === "paused") return { ok: true, state, changed: false };
      if (current.goal.status !== "active")
        return failure(
          "INVALID_TRANSITION",
          `Only an active goal can be paused; ${current.goal.id} is ${current.goal.status}.`,
        );
      settleCurrentUsage(state, usage, now);
      current.goal.status = "paused";
      current.goal.updatedAt = now;
      state.run = null;
      delete state.completionClaim;
      return changed(state);
    }

    case "resume": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (current.goal.status === "active") return { ok: true, state, changed: false };
      if (current.goal.status !== "paused" && current.goal.status !== "blocked") {
        return failure(
          "INVALID_TRANSITION",
          `Only a paused or blocked goal can be resumed; ${current.goal.id} is ${current.goal.status}.`,
        );
      }
      current.goal.status = "active";
      current.goal.updatedAt = now;
      delete current.goal.terminalReason;
      delete current.goal.completedAt;
      delete state.completionClaim;
      state.run = makeRun(current.goal, usage, now, id);
      return changed(state);
    }

    case "clear": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (actor !== "user" && actor !== "system")
        return failure("INVALID_TRANSITION", "Only the user can clear the current goal.");
      settleCurrentUsage(state, usage, now);
      state.history.push(
        current.goal.status === "complete"
          ? cloneGoal(current.goal)
          : archiveInterrupted(current.goal, command.reason?.trim() || "Cleared by the user", now),
      );
      state.current = null;
      state.run = null;
      delete state.completionClaim;
      return changed(state);
    }

    case "claim_complete": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (current.goal.status !== "active")
        return failure(
          "INVALID_TRANSITION",
          `Only an active goal can be claimed complete; ${current.goal.id} is ${current.goal.status}.`,
        );
      const evidence = cleanRequired(command.evidence, "Completion evidence");
      if (!evidence.ok) return evidence;
      if (
        state.completionClaim?.goalId === current.goal.id &&
        state.completionClaim.goalRevision === current.goal.revision &&
        state.completionClaim.evidence === evidence.value
      ) {
        return { ok: true, state, changed: false };
      }
      settleCurrentUsage(state, usage, now);
      state.completionClaim = {
        id: `claim_${id("gc").slice(-12)}`,
        goalId: current.goal.id,
        goalRevision: current.goal.revision,
        evidence: evidence.value,
        claimedAt: now,
      };
      current.goal.updatedAt = now;
      return changed(state);
    }

    case "claim_blocked": {
      const current = requireCurrent(state, command.goalId);
      if (!current.ok) return current;
      if (current.goal.status !== "active")
        return failure(
          "INVALID_TRANSITION",
          `Only an active goal can be marked blocked; ${current.goal.id} is ${current.goal.status}.`,
        );
      const reason = cleanRequired(command.reason, "Blocked reason");
      if (!reason.ok) return reason;
      settleCurrentUsage(state, usage, now);
      current.goal.status = "blocked";
      current.goal.terminalReason = reason.value;
      current.goal.updatedAt = now;
      current.goal.completedAt = now;
      state.run = null;
      delete state.completionClaim;
      return changed(state);
    }

    case "verification_passed": {
      const claim = state.completionClaim;
      if (
        !claim ||
        claim.id !== command.claimId ||
        !state.current ||
        claim.goalId !== state.current.id ||
        claim.goalRevision !== state.current.revision
      ) {
        return failure("STALE_CLAIM", "The completion claim is stale; the goal changed before verification finished.");
      }
      settleCurrentUsage(state, usage, now);
      state.current.status = "complete";
      state.current.evidence = command.evidence?.trim() || claim.evidence;
      state.current.updatedAt = now;
      state.current.completedAt = now;
      state.run = null;
      delete state.completionClaim;
      return changed(state);
    }

    case "verification_rejected": {
      const claim = state.completionClaim;
      if (
        !claim ||
        claim.id !== command.claimId ||
        !state.current ||
        claim.goalId !== state.current.id ||
        claim.goalRevision !== state.current.revision
      ) {
        return failure("STALE_CLAIM", "The completion claim is stale; the goal changed before verification finished.");
      }
      settleCurrentUsage(state, usage, now);
      state.run ??= makeRun(state.current, usage, now, id);
      state.run.verifyRounds += 1;
      state.run.lastVerifyReason = command.reason.trim();
      state.run.lastVerifyFeedback = command.feedback.trim();
      state.current.status = "active";
      state.current.updatedAt = now;
      delete state.completionClaim;
      return changed(state);
    }

    case "advance_run": {
      if (!state.current || state.current.status !== "active" || !state.run) {
        return failure("INVALID_TRANSITION", "No active goal run is available to advance.");
      }
      settleCurrentUsage(state, usage, now);
      const run = state.run!;
      const progressKey = command.progressKey.trim();
      run.stagnantTurns = run.lastProgressKey === progressKey ? run.stagnantTurns + 1 : 0;
      run.lastProgressKey = progressKey;
      run.rounds += 1;
      run.lastContinuationAt = command.at ?? now;
      return changed(state);
    }

    case "budget_reached": {
      if (!state.current || state.current.status !== "active") {
        return failure("INVALID_TRANSITION", "No active goal can be stopped by a budget limit.");
      }
      settleCurrentUsage(state, usage, now);
      state.current.status = "blocked";
      state.current.terminalReason = command.reason.trim() || "Goal budget reached";
      state.current.updatedAt = now;
      state.current.completedAt = now;
      state.run = null;
      delete state.completionClaim;
      return changed(state);
    }
  }
}

export function makeGoalEvent(kind: GoalEvent["kind"], actor: GoalActor, state: GoalState, at = nowIso()): GoalEvent {
  return {
    id: `goal_event_${createId("ge").slice(-12)}`,
    kind,
    actor,
    at,
    state: cloneGoalState(state),
  };
}

/** Convert pre-v2 goal arrays once after snapshot/rollout load. */
export function migrateLegacyGoalState(session: SessionState, at = nowIso()): boolean {
  const removedLegacyRuntime = session.autopilot?.activeGoalId !== undefined;
  if (removedLegacyRuntime) delete session.autopilot;
  if (session.goal) {
    if (session.sessionModes?.goal) delete session.sessionModes.goal;
    if (session.sessionModes && !session.sessionModes.team) delete session.sessionModes;
    if (session.activeGoals) delete session.activeGoals;
    return removedLegacyRuntime;
  }
  const legacy = session.activeGoals ?? [];
  if (legacy.length === 0) {
    if (session.sessionModes?.goal) delete session.sessionModes.goal;
    if (session.sessionModes && !session.sessionModes.team) delete session.sessionModes;
    delete session.activeGoals;
    return removedLegacyRuntime;
  }

  const records = legacy
    .map((goal, legacyIndex) => ({ goal, legacyIndex }))
    .filter(({ goal }) => !goal.removed)
    .map(({ goal, legacyIndex }) => ({ record: migrateLegacyRecord(goal, at), legacyIndex }));
  const currentLegacyIndex =
    legacy
      .map((goal, index) => (!goal.removed && (goal.status === "active" || goal.status === "paused") ? index : -1))
      .filter((index) => index >= 0)
      .at(-1) ?? -1;
  let current: GoalRecord | null = null;
  const history: GoalRecord[] = [];
  for (const item of records) {
    const record = item.record;
    if (item.legacyIndex === currentLegacyIndex) current = record;
    else
      history.push(
        record.status === "active" || record.status === "paused"
          ? archiveInterrupted(record, "Superseded during Goal v2 migration", at)
          : record,
      );
  }
  if (!current && records.length > 0) {
    const last = records.at(-1)!.record;
    current = last;
    history.pop();
  }
  const usage = sessionGoalUsage(session);
  session.goal = {
    current,
    history,
    run: current?.status === "active" ? makeRun(current, usage, at, createId) : null,
    revision: 1,
  };
  delete session.activeGoals;
  if (session.sessionModes?.goal) delete session.sessionModes.goal;
  if (session.sessionModes && !session.sessionModes.team) delete session.sessionModes;
  return true;
}

function cloneGoal(goal: GoalRecord): GoalRecord {
  return {
    ...goal,
    usage: { ...goal.usage },
    ...(goal.budgetLimits ? { budgetLimits: { ...goal.budgetLimits } } : {}),
  };
}

function makeGoal(
  objective: string,
  completionCriterion: string | undefined,
  budgetLimits: GoalRecord["budgetLimits"],
  actor: GoalActor,
  now: string,
  id: (prefix: string) => string,
): GoalRecord {
  const criterion = completionCriterion?.trim();
  return {
    id: `goal_${id("g").slice(-12)}`,
    objective: objective.slice(0, 4000),
    ...(criterion ? { completionCriterion: criterion.slice(0, 4000) } : {}),
    status: "active",
    revision: 1,
    createdBy: actor === "model" ? "model" : "user",
    createdAt: now,
    updatedAt: now,
    usage: { ...EMPTY_USAGE },
    ...(budgetLimits ? { budgetLimits: { ...budgetLimits } } : {}),
  };
}

function makeRun(
  goal: GoalRecord,
  usage: GoalUsageSnapshot,
  now: string,
  id: (prefix: string) => string,
  previous: Partial<Pick<GoalRun, "verifyRounds" | "lastVerifyReason" | "lastVerifyFeedback">> = {},
): GoalRun {
  return {
    id: `goal_run_${id("gr").slice(-12)}`,
    goalId: goal.id,
    goalRevision: goal.revision,
    startedAt: now,
    tokenBaseline: usage.tokens,
    turnBaseline: usage.turns,
    rounds: 0,
    stagnantTurns: 0,
    verifyRounds: previous.verifyRounds ?? 0,
    ...(previous.lastVerifyReason ? { lastVerifyReason: previous.lastVerifyReason } : {}),
    ...(previous.lastVerifyFeedback ? { lastVerifyFeedback: previous.lastVerifyFeedback } : {}),
  };
}

function settleCurrentUsage(state: GoalState, usage: GoalUsageSnapshot, now: string): void {
  if (!state.current || !state.run) return;
  state.current.usage.tokensUsed += Math.max(0, usage.tokens - state.run.tokenBaseline);
  state.current.usage.turnsUsed += Math.max(0, usage.turns - state.run.turnBaseline);
  state.current.usage.wallClockMs += Math.max(0, Date.parse(now) - Date.parse(state.run.startedAt));
  state.run.tokenBaseline = usage.tokens;
  state.run.turnBaseline = usage.turns;
  state.run.startedAt = now;
  state.current.updatedAt = now;
}

function archiveInterrupted(goal: GoalRecord, reason: string, now: string): GoalRecord {
  const archived = cloneGoal(goal);
  if (archived.status !== "complete") {
    archived.status = "blocked";
    archived.terminalReason = reason;
    archived.completedAt = now;
    archived.updatedAt = now;
  }
  return archived;
}

function migrateLegacyRecord(goal: SessionGoal, at: string): GoalRecord {
  const status =
    goal.status === "met"
      ? "complete"
      : goal.status === "active"
        ? "active"
        : goal.status === "paused"
          ? "paused"
          : "blocked";
  const terminalReason = goal.cancelReason ?? goal.limitReason;
  return {
    id: goal.id,
    objective: goal.condition,
    status,
    revision: 1,
    createdBy: goal.createdBy,
    createdAt: goal.createdAt,
    updatedAt: goal.resolvedAt ?? at,
    usage: { ...EMPTY_USAGE },
    ...(goal.evidence ? { evidence: goal.evidence } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(goal.resolvedAt ? { completedAt: goal.resolvedAt } : {}),
  };
}

function requireCurrent(
  state: GoalState,
  goalId: string,
): { ok: true; goal: GoalRecord } | { ok: false; code: "GOAL_NOT_FOUND"; message: string } {
  if (!state.current || state.current.id !== goalId)
    return failure("GOAL_NOT_FOUND", `No current goal with id "${goalId}".`);
  return { ok: true, goal: state.current };
}

function changed(state: GoalState): GoalTransitionResult {
  state.revision += 1;
  return { ok: true, state, changed: true };
}

function cleanRequired(
  value: string,
  label: string,
): { ok: true; value: string } | { ok: false; code: "INVALID_INPUT"; message: string } {
  const clean = value.trim();
  if (!clean) return failure("INVALID_INPUT", `${label} cannot be empty.`);
  return { ok: true, value: clean };
}

function validateBudgetLimits(
  value: GoalBudgetLimits | undefined,
): { ok: true; value?: GoalBudgetLimits } | { ok: false; code: "INVALID_INPUT"; message: string } {
  if (!value) return { ok: true };
  const labels: Record<keyof GoalBudgetLimits, string> = {
    tokenBudget: "Goal token budget",
    turnBudget: "Goal turn budget",
    wallClockBudgetMs: "Goal wall-clock budget",
  };
  const clean: GoalBudgetLimits = {};
  for (const key of Object.keys(labels) as (keyof GoalBudgetLimits)[]) {
    const limit = value[key];
    if (limit === undefined) continue;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
      return failure("INVALID_INPUT", `${labels[key]} must be a positive integer.`);
    }
    clean[key] = limit;
  }
  return Object.keys(clean).length > 0 ? { ok: true, value: clean } : { ok: true };
}

function failure<C extends GoalTransitionErrorCode>(code: C, message: string): { ok: false; code: C; message: string } {
  return { ok: false, code, message };
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function actorCanExecute(type: GoalCommand["type"], actor: GoalActor): boolean {
  if (actor === "system") return true;
  switch (type) {
    case "create":
      return actor === "user" || actor === "model";
    case "replace":
    case "edit":
    case "pause":
    case "resume":
    case "clear":
      return actor === "user";
    case "claim_complete":
    case "claim_blocked":
      return actor === "model";
    case "verification_passed":
    case "verification_rejected":
      return actor === "verifier";
    case "advance_run":
    case "budget_reached":
      return actor === "runtime";
  }
}
