import type { ToolObservation } from "@reina/protocol";

/**
 * Codex-style bidirectional tool-call pairing normalization, shared by every
 * provider path (Responses / chat / Anthropic). Mirrors codex's
 * `context_manager::normalize` invariant pair:
 *
 *   - every issued call must have an output — a call left dangling makes the
 *     backend reject the request ("No tool output found for function call" /
 *     Anthropic "tool_use ids were found without tool_result blocks"), so we
 *     SYNTHESIZE a placeholder output (codex inserts "aborted");
 *   - every output must join to an issued call — an orphan output is rejected
 *     too ("No tool call found for function call output with call_id ..." /
 *     "unexpected tool_use_id"). Codex drops orphans; Reina's orphans carry
 *     real information (engine-injected follow-ups like the auto task_output
 *     after a backgrounded run_shell), so we DEGRADE them to plain text
 *     instead of dropping.
 *
 * The matched pairs always stay native — unlike the previous all-or-nothing
 * gate, one stray follow-up no longer costs the whole round its native
 * pairing (and with it the model's chain-of-thought continuity).
 */
export type NormalizedToolPairing = {
  /** Observations whose callId matches an issued call, in call order. */
  matched: ToolObservation[];
  /** Placeholder outputs for issued calls that have no observation. */
  synthesized: Array<{ callId: string; output: string }>;
  /** Observations that join to no issued call — render as plain text. */
  orphans: ToolObservation[];
  /** True when any synthesis or degradation happened (log-worthy). */
  repaired: boolean;
};

export const SYNTHETIC_TOOL_OUTPUT =
  "[no tool result recorded — it may have been trimmed for context or lost to an interrupt; re-run the tool if the result still matters]";

export function normalizeToolPairing(callIds: string[], observations: ToolObservation[]): NormalizedToolPairing {
  const callIdSet = new Set(callIds);
  const byCallId = new Map(observations.map((observation) => [observation.callId, observation]));
  const matched: ToolObservation[] = [];
  const synthesized: Array<{ callId: string; output: string }> = [];
  for (const callId of callIds) {
    const observation = byCallId.get(callId);
    if (observation) matched.push(observation);
    else synthesized.push({ callId, output: SYNTHETIC_TOOL_OUTPUT });
  }
  const orphans = observations.filter((observation) => !callIdSet.has(observation.callId));
  const repaired = synthesized.length > 0 || orphans.length > 0;
  if (repaired) {
    // Self-healing in production, loud in development/tests: the engine is
    // supposed to keep calls and observations paired, so a repair here means
    // an upstream invariant slipped (mirrors codex's debug-panic policy).
    const detail = {
      calls: callIds.length,
      observations: observations.length,
      synthesized: synthesized.map((s) => s.callId),
      orphaned: orphans.map((o) => `${o.name}:${o.callId}`),
    };
    if (process.env.REINA_STRICT_TOOL_PAIRING === "1") {
      throw new Error(`tool pairing invariant violated: ${JSON.stringify(detail)}`);
    }
    console.warn("[reina:providers] repaired tool pairing before request", detail);
  }
  return { matched, synthesized, orphans, repaired };
}
