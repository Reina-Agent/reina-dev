import type { ModelStreamEvent, SessionState, ToolCallRecord } from "@reina/protocol";
import { describe, expect, it } from "vitest";
import { AuditController, type AuditHost } from "./audit.js";

function declareRecord(input: Record<string, unknown> = { status: "complete", summary: "done" }): ToolCallRecord {
  return { id: "call_1", name: "declare_audit_done", input } as unknown as ToolCallRecord;
}

function stubHost(
  overrides: Partial<SessionState>,
  verifyCompletion?: AuditHost["verifyCompletion"],
) {
  const emitted: ModelStreamEvent[] = [];
  const session = {
    autopilot: { running: true, goal: "g", startedAt: "t", rounds: 1 },
    ...overrides,
  } as unknown as SessionState;
  const host: AuditHost = {
    session,
    emitStream: (e) => emitted.push(e),
    ...(verifyCompletion ? { verifyCompletion } : {}),
  };
  return { host, session, emitted, controller: new AuditController(host) };
}

describe("AuditController.declareDone", () => {
  it("refuses outside autopilot mode", async () => {
    const { controller } = stubHost({ autopilot: undefined });
    const obs = await controller.declareDone(declareRecord());
    expect(obs.error).toMatch(/only valid in autopilot/i);
  });

  it("is independent from the dedicated Goal lifecycle", async () => {
    const { controller, session } = stubHost({
      goal: {
        current: { id: "goal_1", objective: "x", status: "active" },
        history: [],
        run: null,
        revision: 1,
      } as unknown as NonNullable<SessionState["goal"]>,
    });
    const obs = await controller.declareDone(declareRecord());
    expect(obs.error).toBeUndefined();
    expect(session.autopilot?.running).toBe(false);
  });

  it("accepts and closes the loop when the verifier passes", async () => {
    const { controller, session } = stubHost({}, async () => ({ ok: true }));
    const obs = await controller.declareDone(declareRecord());
    expect(obs.error).toBeUndefined();
    expect(obs.output).toContain("<status>done</status>");
    expect(session.autopilot?.running).toBe(false);
  });

  it("keeps the loop running and returns feedback when the verifier rejects", async () => {
    const { controller, session } = stubHost({}, async () => ({ ok: false, feedback: "not proven — run the tests" }));
    const obs = await controller.declareDone(declareRecord());
    expect(obs.error).toBe("not proven — run the tests");
    expect(session.autopilot?.running).toBe(true);
  });

  it("accepts when no verifier is wired (verify disabled / interactive parity)", async () => {
    const { controller, session } = stubHost({});
    const obs = await controller.declareDone(declareRecord());
    expect(obs.error).toBeUndefined();
    expect(session.autopilot?.running).toBe(false);
  });

  it("still validates summary/status before the verifier runs", async () => {
    let verifyCalled = false;
    const { controller } = stubHost({}, async () => {
      verifyCalled = true;
      return { ok: true };
    });
    const obs = await controller.declareDone(declareRecord({ status: "complete" })); // no summary
    expect(obs.error).toMatch(/requires summary/i);
    expect(verifyCalled).toBe(false);
  });
});
