import type { SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { resolveProfile } from "../profiles.js";

/** Minimal host surface the SubmitResponseController needs. The tool only
 * reads the active agent profile (to find responseSchema) and writes
 * session.submittedResponse. No rollout or stream events — last-writer-wins
 * semantics live entirely on the session field. */
export interface SubmitResponseHost {
  readonly session: SessionState;
}

/** Owns the synthetic submit_response tool. Validates the payload against
 * the profile's responseSchema (provider-side validation isn't always
 * strict enough to trust), stores the JSON form on session.submittedResponse
 * so the parent's task / async-task plumbing can extract it in place of the
 * last assistant message, and returns a confirmation observation. Last
 * writer wins — a child that calls submit_response twice gets the second
 * payload as its final result. */
export class SubmitResponseController {
  constructor(private readonly host: SubmitResponseHost) {}

  respond(record: ToolCallRecord): ToolObservation {
    const profile = resolveProfile(this.host.session.agent);
    if (!profile.responseSchema) {
      return {
        callId: record.id,
        name: record.name,
        error: "submit_response is not available — this profile has no responseSchema configured.",
      };
    }
    const parsed = profile.responseSchema.safeParse(record.input);
    if (!parsed.success) {
      return {
        callId: record.id,
        name: record.name,
        error: `submit_response payload did not match the profile's response schema.\n${parsed.error.message}\nFix the payload to match the schema and retry.`,
      };
    }
    this.host.session.submittedResponse = JSON.stringify(parsed.data);
    return {
      callId: record.id,
      name: record.name,
      output: "Response submitted. Your structured payload will be forwarded to the parent verbatim.",
    };
  }
}
