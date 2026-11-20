import type { RolloutItem, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { pushTrace } from "../trace.js";

/** Minimal host surface the PlanController needs. Plan tools write
 * session.plan + session.pendingQuestions and append rollout items. The
 * actual mode switch on approval happens in answerQuestion (engine.ts),
 * not here — exit_plan_mode just stages the plan + opens the HITL gate. */
export interface PlanHost {
  readonly session: SessionState;
  record(item: RolloutItem): void;
}

/** Owns the plan + exit_plan_mode tools. Both mutate session.plan (the
 * draft/approved snapshot) and exit_plan_mode additionally enqueues a
 * pending question so the user can approve or iterate; the post-answer
 * hook in engine.ts handles the actual mode switch when approval lands. */
export class PlanController {
  constructor(private readonly host: PlanHost) {}

  update(record: ToolCallRecord): ToolObservation {
    const input = record.input as { content?: string; status?: "draft" | "approved" };
    if (!input.content) return { callId: record.id, name: record.name, error: "plan requires content" };
    this.host.session.plan = {
      content: input.content,
      status: input.status ?? "draft",
      updatedAt: nowIso(),
    };
    this.host.record({ type: "plan", plan: this.host.session.plan });
    pushTrace(this.host.session, "plan.updated", { plan: this.host.session.plan });
    return { callId: record.id, name: record.name, output: JSON.stringify(this.host.session.plan, null, 2) };
  }

  /** Stores the final plan as a draft, then opens a HITL gate with two
   * fixed options. The actual mode switch + plan approval happens in
   * answerQuestion when the user picks "Approve & exit plan mode" — see
   * the post-answer hook there. We use the standard question flow so the
   * existing renderer (and answer plumbing) needs no changes; the renderer
   * can distinguish via the question's `intent` field.
   *
   * Tolerant of being called outside plan mode: we still gate on user
   * approval, but the mode switch is a no-op. */
  exit(record: ToolCallRecord): ToolObservation {
    const input = record.input as { plan?: string };
    if (!input.plan || !input.plan.trim()) {
      return { callId: record.id, name: record.name, error: "exit_plan_mode requires a non-empty plan" };
    }
    this.host.session.plan = {
      content: input.plan,
      status: "draft",
      updatedAt: nowIso(),
    };
    this.host.record({ type: "plan", plan: this.host.session.plan });
    const approveLabel = "Approve & exit plan mode";
    const iterateLabel = "Keep iterating";
    const question = {
      id: record.id,
      question: "Approve this plan and exit plan mode?",
      header: "Plan ready",
      options: [
        { label: approveLabel, description: "Switch to default mode so writes can proceed." },
        { label: iterateLabel, description: "Stay in plan mode and revise." },
      ],
      intent: "exit_plan_mode" as const,
      intentPayload: input.plan,
      status: "pending" as const,
      createdAt: nowIso(),
    };
    this.host.session.pendingQuestions.push(question);
    this.host.record({ type: "question", question });
    pushTrace(this.host.session, "exit_plan_mode.pending", { questionId: record.id });
    return {
      callId: record.id,
      name: record.name,
      output: "Plan submitted for approval. Waiting for the user to approve or iterate.",
    };
  }
}
