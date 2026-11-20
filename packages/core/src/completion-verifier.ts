// Independent completion verifier shared by Goal v2 and legacy autopilot.
// A separate judge-model call reviews a compressed execution trace so the
// working model cannot close its own lifecycle without external evidence.
//
// Design notes (what we took from chainreactors/aiscan's evaluator and what we
// deliberately did NOT):
//   - Take: judge sees a COMPRESSED TRACE (tool-call sequence + assistant
//     summaries + final declaration + token usage), not the raw transcript —
//     keeps the call small and aligned to "was the goal met", which never
//     needs a token-by-token replay.
//   - Take: hard pass bar, structured verdict, temperature 0.
//   - Drop: aiscan's `inherit_context` reset-with-self-contained-feedback. That
//     is its substitute for having no compaction subsystem; Reina already has
//     real compaction (memory chunks / recall tools), so a verify rejection
//     just re-enters the existing continuation loop with feedback.
//
// This module is pure orchestration over `nextModelTurnStream` so the trace
// builder and verdict parser can be unit-tested without a live model.

import type { ModelConfig, SessionState, TokenUsage } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import { nextModelTurnStream } from "@reina/providers";

export interface Verdict {
  pass: boolean;
  reason: string;
  feedback: string;
}

const MAX_TRACE_CHARS = 16000;
const MAX_SUMMARY_CHARS = 200;
const MAX_DECLARE_SUMMARY_CHARS = 1500;

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Build the compressed execution trace handed to the judge. Pure over the
 * session + the declaration the model just made. */
export function buildCompletionVerifyTrace(
  session: SessionState,
  declare: { summary?: string; status?: string },
): string {
  const lines: string[] = [];
  const ap = session.autopilot;
  const goalRun = session.goal?.run;

  const usage = session.usage;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  lines.push(
    `Continuation rounds: ${goalRun?.rounds ?? ap?.rounds ?? 0} | Messages: ${session.messages.length} | Model tokens used: ${tokens}`,
  );

  // Tool-call sequence — derived from the in-band tool-result messages (each
  // carries the executed tool's name). Names only: the judge needs the shape of
  // the work, not every argument.
  const toolNames = session.messages
    .map((m) => m.toolResult?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  lines.push(`Tool calls: ${toolNames.length}`);
  if (toolNames.length > 0) {
    lines.push("", "Tool call sequence:");
    toolNames.forEach((name, i) => lines.push(`  [${i + 1}] ${name}`));
  }

  // Recent assistant narration — the model's own account of what it did.
  const summaries = session.messages
    .filter((m) => m.role === "assistant" && m.content.trim().length > 0)
    .slice(-8)
    .map((m) => `- ${clip(m.content, MAX_SUMMARY_CHARS)}`);
  if (summaries.length > 0) {
    lines.push("", "Assistant summaries (recent):", ...summaries);
  }

  // Goal under contract + completion criterion/evidence. Fall back to the
  // legacy array only when replaying a pre-v2 snapshot.
  const currentGoal = session.goal?.current;
  if (currentGoal) {
    lines.push("", "Goal:");
    lines.push(
      `  - [${currentGoal.id}] (${currentGoal.status}, revision ${currentGoal.revision}) ${currentGoal.objective}`,
    );
    if (currentGoal.completionCriterion)
      lines.push(`      completion criterion: ${clip(currentGoal.completionCriterion, MAX_SUMMARY_CHARS)}`);
    const evidence = session.goal?.completionClaim?.evidence ?? currentGoal.evidence;
    if (evidence) lines.push(`      evidence: ${clip(evidence, MAX_SUMMARY_CHARS)}`);
  } else {
    const goals = session.activeGoals ?? [];
    if (goals.length > 0) {
      lines.push("", "Legacy goals:");
      for (const goal of goals) {
        lines.push(`  - [${goal.id}] (${goal.status}) ${goal.condition}`);
        if (goal.evidence) lines.push(`      evidence: ${clip(goal.evidence, MAX_SUMMARY_CHARS)}`);
      }
    }
  }

  // The declaration itself.
  if (declare.summary) {
    lines.push(
      "",
      `Final declaration (status=${declare.status ?? "?"}):`,
      clip(declare.summary, MAX_DECLARE_SUMMARY_CHARS),
    );
  }

  return clip(lines.join("\n"), MAX_TRACE_CHARS);
}

const SYSTEM_PROMPT = [
  "You are an independent completion verifier for an autonomous coding/audit agent.",
  "The agent just declared its task done. Judge whether the goal was ACTUALLY achieved, strictly against the goal condition(s) and the evidence in the trace.",
  "Be skeptical: pass=true ONLY when the trace proves every goal requirement was met. Plausible-sounding summaries without concrete evidence (tool output, file changes, test results) are NOT proof — default to pass=false when uncertain.",
  "",
  "Reply with ONLY a single JSON object, no prose, no code fences:",
  '{"pass": boolean, "reason": "one sentence", "feedback": "concrete next step when pass=false (else empty)"}',
].join("\n");

/** Extract the first balanced top-level JSON object from a model reply that may
 * wrap it in prose or code fences. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Exported for unit tests. Parses (and leniently extracts) the judge's JSON
 * reply into a Verdict; throws when there is no usable object. */
export function parseVerdict(content: string): Verdict {
  const json = extractJsonObject(content);
  if (!json) throw new Error("verifier returned no JSON object");
  const parsed = JSON.parse(json) as Partial<Verdict>;
  if (typeof parsed.pass !== "boolean") throw new Error("verifier verdict missing boolean `pass`");
  return {
    pass: parsed.pass,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
  };
}

/** Run one judge call over the compressed trace. Throws on provider failure or
 * an unparseable reply — the caller decides fail-open vs fail-closed.
 * `onUsage` fires (when provided) even for unparseable replies, so the caller
 * can bill the spend either way. */
export async function runCompletionVerify(
  model: ModelConfig,
  trace: string,
  opts: { signal?: AbortSignal; onUsage?: (usage: TokenUsage | undefined) => void } = {},
): Promise<Verdict> {
  const turn = await nextModelTurnStream(
    model,
    {
      messages: [{ id: createId("msg"), role: "user", content: trace, createdAt: nowIso() }],
      observations: [],
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      // One-shot throwaway prefix — never cache-write it (1.25x surcharge).
      promptCache: "none",
    },
    undefined,
    opts.signal,
  );
  opts.onUsage?.(turn.usage);
  return parseVerdict(turn.content ?? "");
}
