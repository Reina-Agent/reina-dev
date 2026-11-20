import type {
  GoalActor,
  GoalCommand,
  GoalEvent,
  GoalState,
  ModelStreamEvent,
  RolloutItem,
  SessionState,
  ToolCallRecord,
  ToolObservation,
} from "@reina/protocol";
import {
  cloneGoalState,
  emptyGoalState,
  makeGoalEvent,
  sessionGoalUsage,
  transitionGoal,
  type GoalTransitionResult,
} from "./domain.js";

export interface GoalServiceHost {
  readonly session: SessionState;
  record(item: RolloutItem): void;
  emitStream(event: ModelStreamEvent): void;
  touch?(): void;
  persist?(): void;
}

export class GoalService {
  constructor(private readonly host: GoalServiceHost) {}

  snapshot(): GoalState {
    return cloneGoalState(this.host.session.goal ?? emptyGoalState());
  }

  execute(command: GoalCommand, actor: GoalActor): GoalTransitionResult {
    const result = transitionGoal(this.host.session.goal, command, actor, {
      usage: sessionGoalUsage(this.host.session),
    });
    if (!result.ok || !result.changed) return result;

    this.host.session.goal = result.state;
    // Once v2 writes, legacy mirrors are discarded. From here onward there
    // is exactly one source of truth.
    delete this.host.session.activeGoals;
    if (this.host.session.sessionModes?.goal) delete this.host.session.sessionModes.goal;
    if (this.host.session.sessionModes && !this.host.session.sessionModes.team) delete this.host.session.sessionModes;

    const event = makeGoalEvent(command.type, actor, result.state);
    this.publish(event);
    return result;
  }

  get(record: ToolCallRecord): ToolObservation {
    return success(record, formatGoalState(this.snapshot()));
  }

  create(record: ToolCallRecord): ToolObservation {
    const input = record.input as {
      objective?: string;
      completionCriterion?: string;
      tokenBudget?: number;
      turnBudget?: number;
      wallClockBudgetMs?: number;
      expectedRevision?: number;
    };
    const objective = input.objective?.trim();
    if (!objective) return toolError(record, "create_goal requires `objective`.");
    const result = this.execute(
      {
        type: "create",
        objective,
        ...(input.completionCriterion?.trim() ? { completionCriterion: input.completionCriterion.trim() } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
        ...(input.tokenBudget !== undefined || input.turnBudget !== undefined || input.wallClockBudgetMs !== undefined
          ? {
              budgetLimits: {
                ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
                ...(input.turnBudget !== undefined ? { turnBudget: input.turnBudget } : {}),
                ...(input.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: input.wallClockBudgetMs } : {}),
              },
            }
          : {}),
      },
      "model",
    );
    if (!result.ok) return toolError(record, result.message);
    const prefix = result.changed ? "Goal created." : "The same goal is already current; no duplicate was created.";
    return success(record, `${prefix}\n\n${formatGoalState(result.state)}`);
  }

  update(record: ToolCallRecord): ToolObservation {
    const input = record.input as {
      goalId?: string;
      status?: "complete" | "blocked";
      evidence?: string;
      reason?: string;
      expectedRevision?: number;
    };
    const goal = this.host.session.goal?.current;
    if (!goal)
      return toolError(record, "No current goal. Use create_goal only when the user explicitly wants to start one.");
    const goalId = input.goalId?.trim() || goal.id;
    let command: GoalCommand;
    if (input.status === "complete") {
      if (!input.evidence?.trim())
        return toolError(record, "update_goal(status=complete) requires concrete `evidence`.");
      command = {
        type: "claim_complete",
        goalId,
        evidence: input.evidence.trim(),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      };
    } else if (input.status === "blocked") {
      if (!input.reason?.trim()) return toolError(record, "update_goal(status=blocked) requires a specific `reason`.");
      command = {
        type: "claim_blocked",
        goalId,
        reason: input.reason.trim(),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      };
    } else {
      return toolError(record, "update_goal requires status `complete` or `blocked`.");
    }
    const result = this.execute(command, "model");
    if (!result.ok) return toolError(record, result.message);
    return success(
      record,
      input.status === "complete"
        ? `Completion claim recorded and queued for independent verification. The goal remains active until verification passes.\n\n${formatGoalState(result.state)}`
        : `Goal marked blocked. The user can resume, replace, or clear it.\n\n${formatGoalState(result.state)}`,
    );
  }

  private publish(event: GoalEvent): void {
    this.host.record({ type: "goal_event", event });
    this.host.emitStream({
      type: "goal-state-changed",
      state: cloneGoalState(event.state),
      event: { id: event.id, kind: event.kind, actor: event.actor, at: event.at },
    });
    this.host.touch?.();
    // Runtime/verifier transitions can happen after a turn has already ended
    // and may not start another one. Persist every accepted Goal event here
    // instead of relying on a future turn boundary that may never arrive.
    this.host.persist?.();
  }
}

export function formatGoalState(state: GoalState): string {
  if (!state.current) {
    return JSON.stringify({ stateRevision: state.revision, current: null }, null, 2);
  }
  return JSON.stringify(
    {
      stateRevision: state.revision,
      current: state.current,
      run: state.run,
      completionClaim: state.completionClaim ?? null,
    },
    null,
    2,
  );
}

function success(record: ToolCallRecord, output: string): ToolObservation {
  return { callId: record.id, name: record.name, output };
}

function toolError(record: ToolCallRecord, error: string): ToolObservation {
  return { callId: record.id, name: record.name, error };
}
