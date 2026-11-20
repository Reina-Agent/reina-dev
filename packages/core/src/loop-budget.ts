import type { ToolCallRecord } from "@reina/protocol";
import { isBlockingTaskWait } from "./storm-breaker.js";
import { toolResultFingerprint } from "./tool-progress.js";

export type ToolLoopStopReason = "max_steps" | "hard_max_steps" | "no_progress" | "repeated_action" | "consecutive_errors";

export type ToolLoopStop = {
  reason: ToolLoopStopReason;
  message: string;
  turnCount: number;
  maxSteps: number;
  hardMaxSteps: number;
};

type LoopBudgetOptions = {
  baseSteps: number;
  hardMaxSteps?: number;
  stagnationLimit?: number;
  repeatedActionLimit?: number;
  consecutiveErrorLimit?: number;
};

export class ToolLoopBudget {
  baseSteps = 0;
  hardMaxSteps = 0;
  private stagnationLimit = 8;
  private repeatedActionLimit = 10;
  private consecutiveErrorLimit = 5;
  private readonly seenActions = new Map<string, { count: number; canRecheck: boolean }>();
  private readonly seenResults = new Map<string, Set<string>>();
  private noProgressTurns = 0;
  private consecutiveErrorTurns = 0;
  private budget = 0;
  private turns = 0;

  constructor(options: LoopBudgetOptions) {
    this.updateConfig(options);
  }

  /** Preserve consumed turns and repetition/error history when limits change. */
  updateConfig(options: LoopBudgetOptions): void {
    this.baseSteps = Math.max(0, options.baseSteps);
    this.hardMaxSteps = Math.max(this.baseSteps, options.hardMaxSteps ?? this.baseSteps * 4);
    this.stagnationLimit = options.stagnationLimit ?? envInt("REINA_TOOL_LOOP_STAGNATION_LIMIT", 8);
    this.repeatedActionLimit = options.repeatedActionLimit ?? envInt("REINA_TOOL_LOOP_REPEATED_ACTION_LIMIT", 10);
    this.consecutiveErrorLimit = options.consecutiveErrorLimit ?? envInt("REINA_TOOL_LOOP_ERROR_LIMIT", 5);
    this.budget = Math.min(this.hardMaxSteps, Math.max(this.budget, this.baseSteps));
  }

  get turnCount(): number {
    return this.turns;
  }

  canContinue(): boolean {
    return this.turns < this.budget;
  }

  /** Give recovery a fresh stagnation window without renewing budgets or history. */
  resetStagnation(): void {
    this.noProgressTurns = 0;
    this.consecutiveErrorTurns = 0;
  }

  recordTurn(records: readonly ToolCallRecord[]): ToolLoopStop | undefined {
    this.turns++;
    let hasProgress = false;
    let hasRepeatedAction = false;
    for (const record of records) {
      if (record.status === "completed" && record.permission === "write") this.invalidateVerificationHistory();
      const key = `${record.name}:${stableStringify(record.input)}`;
      const count = this.recordAction(record, key);
      const progress = this.recordProgress(record, key);
      hasProgress ||= progress;
      hasRepeatedAction ||= count >= this.repeatedActionLimit;
    }
    const hasOnlyErrors = records.length > 0 && records.every((record) => record.status === "failed" || record.status === "rejected");

    this.noProgressTurns = hasProgress ? 0 : this.noProgressTurns + 1;
    this.consecutiveErrorTurns = hasOnlyErrors ? this.consecutiveErrorTurns + 1 : 0;

    if (hasRepeatedAction && !hasProgress) return this.stop("repeated_action");
    if (this.consecutiveErrorTurns >= this.consecutiveErrorLimit) return this.stop("consecutive_errors");
    if (this.noProgressTurns >= this.stagnationLimit) return this.stop("no_progress");

    if (hasProgress && this.turns >= this.budget - 2 && this.budget < this.hardMaxSteps) {
      this.budget = Math.min(this.hardMaxSteps, this.budget + Math.max(1, this.baseSteps));
    }
    return undefined;
  }

  exhaustedStop(): ToolLoopStop {
    return this.stop(this.budget >= this.hardMaxSteps ? "hard_max_steps" : "max_steps");
  }

  private stop(reason: ToolLoopStopReason): ToolLoopStop {
    return {
      reason,
      message: messageForReason(reason),
      turnCount: this.turns,
      maxSteps: this.budget,
      hardMaxSteps: this.hardMaxSteps,
    };
  }

  private invalidateVerificationHistory(): void {
    for (const [key, action] of this.seenActions) {
      if (!action.canRecheck) continue;
      this.seenActions.delete(key);
      this.seenResults.delete(key);
    }
  }

  private recordAction(record: ToolCallRecord, key: string): number {
    const count = (this.seenActions.get(key)?.count ?? 0) + 1;
    const canRecheck = record.permission !== "write" && (record.name === "run_shell" || record.permission === "read");
    this.seenActions.set(key, { count, canRecheck });
    return count;
  }

  private recordProgress(record: ToolCallRecord, key: string): boolean {
    if (record.status !== "completed") return false;
    if (isBlockingTaskWait(record.name, record.input)) return true;
    if (["write_file", "edit_file", "multi_edit", "apply_patch", "write_todos", "plan"].includes(record.name)) {
      return true;
    }
    const output = record.output?.trim();
    if (!output) return false;
    if (record.name === "task_output") return true;
    const signature = toolResultFingerprint(record);
    if (!signature) return false;
    const results = this.seenResults.get(key) ?? new Set<string>();
    if (results.has(signature)) return false;
    results.add(signature);
    this.seenResults.set(key, results);
    return true;
  }
}

function messageForReason(reason: ToolLoopStopReason): string {
  switch (reason) {
    case "no_progress":
      return "Paused after several tool turns without new progress.";
    case "repeated_action":
      return "Paused after repeating the same tool action.";
    case "consecutive_errors":
      return "Paused after repeated tool errors.";
    case "hard_max_steps":
      return "Paused after reaching the hard tool-turn limit.";
    case "max_steps":
      return "Paused after reaching the current tool-turn budget.";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
