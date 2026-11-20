import type { ModelStreamEvent, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { nowIso } from "@reina/protocol";

/** Minimal host surface for the legacy autopilot close signal. Goal v2 has
 * its own completion claim + verifier path and is intentionally independent
 * of declare_audit_done. No rollout writes
 * — the autopilot transition is observable from session.autopilot
 * directly. */
export interface AuditHost {
  readonly session: SessionState;
  emitStream(event: ModelStreamEvent): void;
  /** Optional independent completion check. When present (autopilot + verify
   * enabled), it runs AFTER the goal gate and BEFORE the loop is allowed to
   * close. `ok:false` keeps the loop running with `feedback` returned to the
   * model; the engine side has already reopened the unmet goals + bumped the
   * verify counter. Absent → the model's declaration is accepted as-is. */
  verifyCompletion?(record: ToolCallRecord): Promise<{ ok: true } | { ok: false; feedback: string }>;
}

/** Owns the legacy autopilot-only close signal. */
export class AuditController {
  constructor(private readonly host: AuditHost) {}

  async declareDone(record: ToolCallRecord): Promise<ToolObservation> {
    const input = record.input as { status?: "complete" | "exhausted" | "blocked"; summary?: string };
    const autopilot = this.host.session.autopilot;
    if (!autopilot || !autopilot.running) {
      return {
        callId: record.id,
        name: record.name,
        error: "declare_audit_done is only valid in autopilot mode. The session is currently interactive — ignore this tool.",
      };
    }
    const summary = input.summary?.trim();
    const status = input.status;
    if (!summary) {
      return { callId: record.id, name: record.name, error: "declare_audit_done requires summary" };
    }
    if (!status) {
      return { callId: record.id, name: record.name, error: "declare_audit_done requires status" };
    }
    // INDEPENDENT VERIFY GATE — a decorrelated judge reviews the run before the
    // loop is allowed to close. On rejection the engine has already reopened the
    // unmet goals (so a retry re-hits the goal gate) and bumped the verify
    // counter; we just hand the model the verdict's feedback and keep running.
    if (this.host.verifyCompletion) {
      const outcome = await this.host.verifyCompletion(record);
      if (!outcome.ok) {
        return { callId: record.id, name: record.name, error: outcome.feedback };
      }
    }
    autopilot.running = false;
    autopilot.doneStatus = status;
    autopilot.doneSummary = summary;
    autopilot.doneAt = nowIso();
    this.host.emitStream({ type: "autopilot-updated", state: { ...autopilot } });
    return {
      callId: record.id,
      name: record.name,
      output: [
        `<autopilot>`,
        `<status>done</status>`,
        `<reason>${status}</reason>`,
        `<rounds>${autopilot.rounds}</rounds>`,
        `</autopilot>`,
      ].join("\n"),
    };
  }
}
