import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, CompactBoundary, ModelConfig, SessionState, TokenRequestBreakdown } from "@reina/protocol";
import { createId, nowIso } from "@reina/protocol";
import {
  autoCompactBodyLimit,
  autoCompactThreshold,
  buildSummaryRequestMessages,
  compactSessionContext,
  effectiveContextWindow,
  estimateObservationTokens,
  estimateSessionContextTokens,
  formatCompactSummary,
  POST_COMPACT_CONTEXT_PREFIX,
  sessionContextTokens,
  shouldAutoCompactSession,
} from "./compaction.js";
import type { ToolObservation } from "@reina/protocol";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "reina-compaction-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deterministicModel: ModelConfig = {
  provider: "deterministic",
  model: "deterministic-test",
};

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: createId("sess"),
    title: "test",
    agent: "default",
    cwd,
    permissionMode: "default",
    model: deterministicModel,
    messages: [],
    toolCalls: [],
    todos: [],
    pendingQuestions: [],
    skills: [],
    trace: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

describe("formatCompactSummary", () => {
  it("strips the <analysis> drafting scratchpad", () => {
    const raw = [
      "<analysis>",
      "Internal reasoning the user should never see.",
      "</analysis>",
      "<summary>",
      "1. Primary Request and Intent: Refactor X",
      "</summary>",
    ].join("\n");
    const out = formatCompactSummary(raw);
    expect(out).not.toContain("<analysis>");
    expect(out).not.toContain("Internal reasoning");
    expect(out).toContain("Refactor X");
  });

  it("unwraps <summary> tags into a 'Summary:' section", () => {
    const out = formatCompactSummary("<summary>\nA\nB\n</summary>");
    expect(out.startsWith("Summary:")).toBe(true);
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).not.toContain("<summary>");
  });

  it("collapses runaway blank lines", () => {
    const out = formatCompactSummary("<summary>line1\n\n\n\nline2</summary>");
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("returns the raw text trimmed when neither tag is present", () => {
    expect(formatCompactSummary("   plain text  ")).toBe("plain text");
  });
});

// Minimal measured-request breakdown (measureModelRequest shape) carrying just
// the full-footprint estimate the trigger floors on.
function makeLastRequest(autocompactEstimate: number, createdAt: string): TokenRequestBreakdown {
  return {
    createdAt,
    provider: "openai-chat",
    model: "no-usage-test",
    messagesCount: 40,
    observationsCount: 0,
    toolsCount: 0,
    systemPromptChars: 0,
    systemPromptTokens: 0,
    messagesChars: 0,
    messagesTokens: 0,
    observationsChars: 0,
    observationsTokens: 0,
    toolsDescriptionChars: 0,
    toolsSchemaChars: 0,
    toolsTokens: 0,
    totalChars: 0,
    estimatedInputTokens: autocompactEstimate,
    toolNames: [],
    categories: {
      systemPromptBase: 0,
      systemPromptSkills: 0,
      systemPromptUserRules: 0,
      messages: 0,
      observations: 0,
      reminders: 0,
      toolsCore: 0,
      toolsMcp: 0,
      toolsCoreDeferred: 0,
      toolsMcpDeferred: 0,
      autocompactBuffer: 0,
      autocompactEstimate,
      freeSpace: 0,
      contextWindow: 200_000,
    },
  };
}

function makeBoundary(createdAt: string): CompactBoundary {
  return {
    id: createId("compact"),
    type: "auto",
    compactType: "auto",
    createdAt,
    preCompactTokenCount: 0,
    postCompactTokenCount: 0,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    preMessageCount: 0,
    postMessageCount: 0,
    messagesCompacted: 0,
    preservedMessageIds: [],
  };
}

describe("shouldAutoCompactSession", () => {
  it("returns false when below the minimum-messages threshold", () => {
    const session = makeSession({
      modelMessages: Array.from({ length: 5 }, (_, i) => makeMessage("user", `m${i}`)),
    });
    const decision = shouldAutoCompactSession(session);
    expect(decision.shouldCompact).toBe(false);
  });

  it("returns false when below the token threshold even with enough messages", () => {
    const session = makeSession({
      modelMessages: Array.from({ length: 12 }, (_, i) => makeMessage("user", `short m${i}`)),
    });
    const decision = shouldAutoCompactSession(session);
    expect(decision.shouldCompact).toBe(false);
  });

  it("returns true with a reason once tokens exceed the threshold", () => {
    // Force a tiny effective window so we don't have to fabricate 100k chars.
    const tinyWindow: ModelConfig = { ...deterministicModel, contextWindowTokens: 8_200 };
    const heavy = "x".repeat(2_000);
    const session = makeSession({
      model: tinyWindow,
      modelMessages: Array.from({ length: 14 }, () => makeMessage("user", heavy)),
    });
    const decision = shouldAutoCompactSession(session);
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.reason).toMatch(/exceeded autocompact threshold/);
    }
  });

  it("triggers off the provider's real total even when the o200k estimate is under threshold", () => {
    // Short messages → tiny o200k estimate (far below threshold), but the
    // provider reported a real total above it. The trigger must fire on the
    // real number (codex/pi parity), not the local estimate.
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    const threshold = autoCompactThreshold(session.model);
    expect(estimateSessionContextTokens(session)).toBeLessThan(threshold);
    session.usage = {
      inputTokens: threshold + 5_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: threshold + 5_000,
      contextTokensSource: "provider",
    };
    expect(sessionContextTokens(session)).toEqual({ tokens: threshold + 5_000, source: "provider" });
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);
  });

  it("falls back to the o200k estimate when no provider total is present", () => {
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, () => makeMessage("user", "word ".repeat(50))),
    });
    expect(sessionContextTokens(session).source).toBe("estimate");
  });

  it("does not re-trigger on a provider total cleared after compaction", () => {
    // recordCompaction clears usage.contextTokens post-compaction; with the
    // provider source gone, the trigger must fall back to the (now small)
    // estimate rather than re-firing on the stale pre-compaction peak.
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        turns: 1,
      },
    });
    expect(sessionContextTokens(session).source).toBe("estimate");
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
  });

  it("floors the estimate with the last measured request footprint (no-usage providers)", () => {
    // Providers that never report usage leave source = "estimate", and the raw
    // modelMessages estimate misses the system-prompt/tools prefix and the
    // tool outputs woven back at send time entirely. The engine's own request
    // measure saw the real footprint — the trigger must fire on it.
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    const threshold = autoCompactThreshold(session.model);
    expect(estimateSessionContextTokens(session)).toBeLessThan(threshold);
    session.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 20,
      lastRequest: makeLastRequest(threshold + 2_000, nowIso()),
    };
    const decision = shouldAutoCompactSession(session);
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.reason).toMatch(/exceeded autocompact threshold/);
    }
  });

  it("ignores a request measure taken before the last compaction (no churn)", () => {
    // Right after a compaction the last measure still describes the pre-compact
    // history; flooring on it would re-fire the trigger every preflight and
    // churn the summarizer until the next request refreshes the measure.
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    const threshold = autoCompactThreshold(session.model);
    const measuredAt = "2026-01-01T00:00:00.000Z";
    session.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 20,
      lastRequest: makeLastRequest(threshold + 2_000, measuredAt),
    };
    session.compactBoundaries = [makeBoundary("2026-01-01T00:00:01.000Z")];
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
    // A measure taken AFTER that boundary counts again.
    session.usage.lastRequest = makeLastRequest(threshold + 2_000, "2026-01-01T00:00:02.000Z");
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);
  });

  it("fires on pending observation tokens even when history alone is under the threshold", () => {
    // The follow-up / goal-continuation case: history sits just below the line,
    // but a large tool result is queued for weaving into the NEXT request. The
    // request-aware trigger must add it on top and compact BEFORE that request.
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    const threshold = autoCompactThreshold(session.model);
    session.usage = {
      inputTokens: threshold - 1_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: threshold - 1_000,
      contextTokensSource: "provider",
    };
    // History-only view stays under the line — no compaction.
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
    // Adding the pending observation tips it over.
    const decision = shouldAutoCompactSession(session, 2_000);
    expect(decision.shouldCompact).toBe(true);
    if (decision.shouldCompact) {
      expect(decision.reason).toContain("pending");
      expect(decision.reason).toMatch(/exceeded autocompact threshold/);
    }
  });

  it("ignores a negative extraInputTokens (treats it as zero)", () => {
    const session = makeSession({
      modelMessages: Array.from({ length: 12 }, (_, i) => makeMessage("user", `short m${i}`)),
    });
    expect(shouldAutoCompactSession(session, -5_000).shouldCompact).toBe(false);
  });
});

describe("shouldAutoCompactSession body-after-prefix gate (codex AutoCompactWindow)", () => {
  function overThresholdSession(total: number, baseline: number | undefined): SessionState {
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    session.usage = {
      inputTokens: total,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 1,
      contextTokens: total,
      contextTokensSource: "provider",
      ...(baseline !== undefined ? { autoCompactBaseline: baseline } : {}),
    };
    return session;
  }

  it("does not re-fire when growth since the post-compaction baseline is under the body budget", () => {
    const model = deterministicModel;
    const total = autoCompactThreshold(model) + 1_000; // over the hard threshold
    const bodyLimit = autoCompactBodyLimit(model);
    // Only half the budget grew since the baseline — the stable prefix sitting
    // above the threshold must not churn the summarizer.
    const session = overThresholdSession(total, total - Math.floor(bodyLimit / 2));
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
  });

  it("fires once growth since the baseline clears the body budget", () => {
    const model = deterministicModel;
    const bodyLimit = autoCompactBodyLimit(model);
    const total = autoCompactThreshold(model) + bodyLimit + 5_000;
    const session = overThresholdSession(total, total - (bodyLimit + 1));
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);
  });

  it("skips the gate (legacy total-vs-threshold) when no baseline is seeded yet", () => {
    const model = deterministicModel;
    const total = autoCompactThreshold(model) + 1_000;
    const session = overThresholdSession(total, undefined);
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);
  });

  it("still respects the pending-observation tail when measuring body growth", () => {
    const model = deterministicModel;
    const bodyLimit = autoCompactBodyLimit(model);
    const total = autoCompactThreshold(model) + 1_000;
    // History alone grew only a sliver past the baseline (under budget), but a
    // large pending tool result pushes the projected body over it.
    const session = overThresholdSession(total, total - 1_000);
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
    expect(shouldAutoCompactSession(session, bodyLimit).shouldCompact).toBe(true);
  });

  it("applies the gate on the estimate path once a baseline is seeded from the measured floor", () => {
    // The no-usage-provider churn case: right after a compaction the NEXT
    // request is re-measured; when the un-shrinkable footprint (prefix + the
    // launching directive kept verbatim) still sits above the threshold, the
    // fresh measure alone must not re-fire every turn — only growth since the
    // seeded baseline may.
    const model = deterministicModel;
    const threshold = autoCompactThreshold(model);
    const measured = threshold + 1_000;
    const session = makeSession({
      modelMessages: Array.from({ length: 40 }, (_, i) => makeMessage("user", `hi ${i}`)),
    });
    session.compactBoundaries = [makeBoundary("2026-01-01T00:00:01.000Z")];
    session.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      turns: 20,
      lastRequest: makeLastRequest(measured, "2026-01-01T00:00:02.000Z"),
      autoCompactBaseline: measured,
    };
    expect(sessionContextTokens(session).source).toBe("estimate");
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(false);
    // Body growth past the budget since that baseline fires again.
    const bodyLimit = autoCompactBodyLimit(model);
    session.usage.lastRequest = makeLastRequest(measured + bodyLimit, "2026-01-01T00:00:03.000Z");
    expect(shouldAutoCompactSession(session).shouldCompact).toBe(true);
  });
});

describe("estimateObservationTokens", () => {
  const obs = (over: Partial<ToolObservation>): ToolObservation => ({
    callId: "c",
    name: "read_file",
    output: "",
    ...over,
  });

  it("is zero for an empty list", () => {
    expect(estimateObservationTokens([])).toBe(0);
  });

  it("counts output and error bodies, scaling with content", () => {
    const small = estimateObservationTokens([obs({ output: "short" })]);
    const large = estimateObservationTokens([obs({ output: "word ".repeat(500) })]);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    // An error-only observation still contributes (mirrors what gets woven).
    expect(estimateObservationTokens([obs({ output: undefined, error: "boom ".repeat(50) })])).toBeGreaterThan(0);
  });
});

describe("effectiveContextWindow", () => {
  it("reserves output room from the model's context window", () => {
    expect(effectiveContextWindow({ provider: "deterministic", model: "m", contextWindowTokens: 200_000 })).toBe(
      200_000 - 20_000,
    );
  });

  it("floors at 8k when the window is too small to reserve output", () => {
    expect(effectiveContextWindow({ provider: "deterministic", model: "m", contextWindowTokens: 4_000 })).toBe(8_000);
  });
});

describe("compactSessionContext", () => {
  it("returns undefined when there is nothing to compact", async () => {
    const session = makeSession({
      modelMessages: Array.from({ length: 5 }, (_, i) => makeMessage("user", `m${i}`)),
    });
    const boundary = await compactSessionContext(session, "manual", "test");
    expect(boundary).toBeUndefined();
    expect(session.summary).toBeUndefined();
  });

  it("no-ops when there are many messages but the droppable prefix is trivially small", async () => {
    // The repeated-/compact churn bug: lots of tiny messages whose compactable
    // prefix is below COMPACT_MIN_COMPACTED_TOKENS. Dropping it would free ~zero
    // tokens (a similar-sized post-compact context message gets re-injected), so
    // a user could hammer /compact forever. compactSplitIndex must bail.
    const session = makeSession({
      modelMessages: Array.from({ length: 30 }, (_, i) => makeMessage(i % 2 ? "assistant" : "user", `hi ${i}`)),
    });
    const boundary = await compactSessionContext(session, "manual", "churn guard");
    expect(boundary).toBeUndefined();
    expect(session.summary).toBeUndefined();
    expect(session.compactBoundaries).toBeUndefined();
  });

  it("produces a boundary and mutates the session when there is content to compact", async () => {
    // Each body has to be heavy enough that the 8-message tail already exceeds
    // COMPACT_KEEP_RECENT_TOKENS (5000); otherwise the split walks all the way
    // back to index 1 and only one message gets compacted.
    const long = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `message body ${i} `.repeat(300)),
    );
    const session = makeSession({ modelMessages: long });
    const before = session.modelMessages!.length;

    const boundary = await compactSessionContext(session, "manual", "unit test");

    expect(boundary).toBeDefined();
    expect(boundary!.preMessageCount).toBe(before);
    expect(boundary!.messagesCompacted).toBeGreaterThan(0);
    expect(boundary!.postMessageCount).toBeLessThan(before);
    expect(session.summary).toBeDefined();
    expect(session.modelMessages!.length).toBe(boundary!.postMessageCount);
    expect(session.compactBoundaries).toHaveLength(1);
  });

  it("preserves providerState so pending tool outputs keep their call to join to", async () => {
    // Mid-turn auto-compaction fires at a loop boundary while tool
    // observations are still pending. The within-turn replay state (Responses
    // function_call items / Anthropic tool_use blocks / chat tool_calls
    // message) must survive the history rewrite — wiping it orphans the
    // function_call_output items on the next request and the provider rejects
    // it ("400 No tool call found for function call output with call_id ...").
    const long = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `message body ${i} `.repeat(300)),
    );
    const providerState: SessionState["providerState"] = {
      provider: "openai-responses",
      data: {
        assistantItems: [{ type: "function_call", call_id: "call_x", name: "read_file", arguments: "{}" }],
      },
    };
    const session = makeSession({ modelMessages: long, providerState });

    const boundary = await compactSessionContext(session, "auto", "mid-turn compaction");

    expect(boundary).toBeDefined();
    expect(session.providerState).toEqual(providerState);
  });

  it("re-injects a resume directive that tells the model not to acknowledge the summary", async () => {
    // Bodies must be heavy enough that the prefix-to-drop clears
    // COMPACT_MIN_COMPACTED_TOKENS — otherwise compaction correctly no-ops.
    const long = Array.from({ length: 16 }, (_, i) => makeMessage("user", `body ${i} `.repeat(300)));
    const session = makeSession({
      modelMessages: long,
      recentFiles: [{ path: path.join(cwd, "does-not-exist.txt"), mtimeMs: 0, readAt: nowIso() }],
    });

    await compactSessionContext(session, "manual", "unit test");
    const resume = session.modelMessages!.find((m) => m.content.startsWith("Post-compact restored context:"));
    expect(resume).toBeDefined();
    expect(resume!.content).toContain("Do not acknowledge");
    expect(resume!.content).toContain("Resume directly");
  });

  it("falls back to an extractive summary when the model call returns a non-summary response", async () => {
    // The deterministic provider returns the "deterministic provider only handles..." sentinel,
    // which buildCompactSummary rejects, exercising the extractive fallback path.
    const long = Array.from({ length: 14 }, (_, i) => makeMessage(i % 2 ? "assistant" : "user", `body ${i} `.repeat(300)));
    const session = makeSession({ modelMessages: long });
    const boundary = await compactSessionContext(session, "auto", "fallback test");
    expect(boundary).toBeDefined();
    expect(session.summary).toMatch(/Compacted conversation:/);
  });

  it("lists recent file paths without re-injecting their contents", async () => {
    // pi-style restore: the post-compact message points at the files instead of
    // carrying 20k-char snapshots — that re-injection was the largest single
    // contributor to the post-compaction context floor.
    const filePath = path.join(cwd, "big-file.ts");
    await writeFile(filePath, "const FILE_BODY_MARKER = 1;\n".repeat(50), "utf8");
    const long = Array.from({ length: 16 }, (_, i) => makeMessage("user", `body ${i} `.repeat(300)));
    const session = makeSession({
      modelMessages: long,
      recentFiles: [{ path: filePath, mtimeMs: 1, readAt: nowIso() }],
    });

    await compactSessionContext(session, "manual", "unit test");

    const restored = session.modelMessages![0]!;
    expect(restored.content.startsWith(POST_COMPACT_CONTEXT_PREFIX)).toBe(true);
    expect(restored.content).toContain("Recently read files");
    expect(restored.content).toContain("big-file.ts");
    expect(restored.content).not.toContain("FILE_BODY_MARKER");
    expect(restored.content).not.toContain("<file path=");
  });

  it("restores the absolute locations of active skills", async () => {
    const globalSkillPath = path.join(os.homedir(), ".claude", "skills", "global-review", "SKILL.md");
    const long = Array.from({ length: 16 }, (_, i) => makeMessage("user", `body ${i} `.repeat(300)));
    const session = makeSession({
      modelMessages: long,
      skills: [{ name: "global-review", description: "Review changes", path: globalSkillPath }],
    });

    await compactSessionContext(session, "manual", "unit test");

    const restored = session.modelMessages![0]!;
    expect(restored.content).toContain("global-review");
    expect(restored.content).toContain(globalSkillPath);
  });

  it("compacts a subagent session independently of any parent", async () => {
    // Subagent contexts run their own AgentEngine with their own SessionState.
    // compactSessionContext should treat them identically — only the session
    // passed in is mutated.
    const child = makeSession({
      id: createId("child"),
      isSubagent: true,
      subagentDepth: 1,
      modelMessages: Array.from({ length: 16 }, (_, i) => makeMessage(i % 2 ? "assistant" : "user", `child body ${i} `.repeat(300))),
    });
    const parent = makeSession({
      id: createId("parent"),
      modelMessages: Array.from({ length: 4 }, (_, i) => makeMessage("user", `parent body ${i}`)),
    });

    const boundary = await compactSessionContext(child, "auto", "child compaction");

    expect(boundary).toBeDefined();
    expect(child.compactBoundaries).toHaveLength(1);
    // Parent untouched.
    expect(parent.summary).toBeUndefined();
    expect(parent.compactBoundaries).toBeUndefined();
    expect(parent.modelMessages!.length).toBe(4);
  });
});

describe("compactSplitIndex last-user-message tail anchor", () => {
  /** Mid-turn shape: heavy old conversation, then the user directive that
   * launched the current work, then a long run of heavy in-band tool results
   * (role "user" but ephemeral+toolResult — the engine's materialized form). */
  function midTurnMessages(): ChatMessage[] {
    const oldConversation = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i % 2 ? "assistant" : "user", `old body ${i} `.repeat(300)),
    );
    const directive = makeMessage("user", "ANCHOR_DIRECTIVE run the full migration end to end");
    const toolResults = Array.from({ length: 12 }, (_, i) => ({
      ...makeMessage("user", `Tool read_file (call_${i}) result:\n${"tool output ".repeat(300)}`),
      ephemeral: true,
      toolResult: { callId: `call_${i}`, name: "read_file" },
    }));
    return [...oldConversation, directive, ...toolResults];
  }

  /** The directive surviving as its own preserved user message — NOT merely
   * quoted inside the restored-context summary, which mentions it either way. */
  function directivePreservedVerbatim(session: SessionState): boolean {
    return session.modelMessages!.some(
      (m) =>
        m.role === "user" &&
        !m.content.startsWith(POST_COMPACT_CONTEXT_PREFIX) &&
        m.content.includes("ANCHOR_DIRECTIVE"),
    );
  }

  it("keeps the launching user message verbatim when auto-compaction fires mid-turn", async () => {
    const session = makeSession({ modelMessages: midTurnMessages() });
    const boundary = await compactSessionContext(session, "auto", "mid-turn anchor test");
    expect(boundary).toBeDefined();
    // The ephemeral tool results around it are NOT mistaken for the anchor —
    // the split walked back to the real directive, so it survives verbatim
    // instead of arriving as a summary paraphrase.
    expect(directivePreservedVerbatim(session)).toBe(true);
    // Everything before the directive was still compacted away.
    expect(boundary!.messagesCompacted).toBe(10);
  });

  it("does not extend the tail past the anchor budget on a small-window model", async () => {
    // 30k window → 10k effective → 2.5k anchor budget; the ~12 heavy tool
    // results behind the directive far exceed it, so pulling the anchor in
    // would leave compaction unable to free meaningful space. Fall back to the
    // summary's verbatim-quote sections instead.
    const tinyWindow: ModelConfig = { ...deterministicModel, contextWindowTokens: 30_000 };
    const session = makeSession({ model: tinyWindow, modelMessages: midTurnMessages() });
    const boundary = await compactSessionContext(session, "auto", "anchor budget test");
    expect(boundary).toBeDefined();
    expect(directivePreservedVerbatim(session)).toBe(false);
    expect(boundary!.messagesCompacted).toBeGreaterThan(10);
  });
});

describe("summary fold into modelMessages", () => {
  it("folds the summary into the head of modelMessages, not just the field", async () => {
    const body = Array.from({ length: 24 }, (_, i) =>
      makeMessage(i % 2 ? "assistant" : "user", `body ${i} `.repeat(300)),
    );
    const session = makeSession({ messages: [...body], modelMessages: [...body] });

    const boundary = await compactSessionContext(session, "manual", "fold test");

    expect(boundary).toBeDefined();
    // Field retained for the next compaction's `previous` seed + persistence...
    expect(session.summary).toBeTruthy();
    // ...AND folded into the once-injected, cacheable restored-context message at
    // the head of modelMessages (mirrors Codex's build_compacted_history).
    expect(session.modelMessages![0]!.content).toContain("Post-compact restored context:");
    expect(session.modelMessages![0]!.content).toContain("Conversation summary:");
  });

  it("does not double-count the folded summary in the context-token estimate", () => {
    // Post-fold shape: the summary text lives inside modelMessages AND the field.
    const summaryText = "S".repeat(4000);
    const modelMessages = [
      makeMessage("user", `Post-compact restored context:\n\nConversation summary:\n${summaryText}`),
      makeMessage("user", "live tail"),
    ];
    const withField = makeSession({ modelMessages, summary: summaryText });
    const withoutField = makeSession({ modelMessages, summary: undefined });

    // The estimate must IGNORE the summary field now that the text is a message;
    // otherwise it adds ~1k tokens on top and trips auto-compaction early/churns.
    expect(estimateSessionContextTokens(withField)).toBe(estimateSessionContextTokens(withoutField));

    const ctx = sessionContextTokens(withField);
    expect(ctx.source).toBe("estimate");
    expect(ctx.tokens).toBe(estimateSessionContextTokens(withoutField));
  });
});

describe("buildSummaryRequestMessages", () => {
  it("sends the slice natively: user opener, roles intact, instruction last", () => {
    const session = makeSession();
    const slice = [makeMessage("user", "u1"), makeMessage("assistant", "a1")];
    const msgs = buildSummaryRequestMessages(session, slice, "test reason");
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toContain("Conversation segment to summarize");
    expect(msgs[1]!.content).toBe("u1");
    expect(msgs[2]!.role).toBe("assistant");
    expect(msgs[2]!.content).toBe("a1");
    expect(msgs.at(-1)!.role).toBe("user");
    expect(msgs.at(-1)!.content).toContain("Compaction reason: test reason");
  });

  it("carries the previous summary inside the trailing instruction", () => {
    const session = makeSession({ summary: "OLD_SUMMARY_TEXT" });
    const msgs = buildSummaryRequestMessages(session, [makeMessage("user", "u")], "r");
    expect(msgs.at(-1)!.content).toContain("OLD_SUMMARY_TEXT");
    expect(msgs.at(-1)!.content).toContain("copy verbatim if still relevant");
  });

  it("flattens structured tool pairs to text so the no-tools request stays valid", () => {
    // The summary call declares `tools: []`; Anthropic rejects tool_use /
    // tool_result blocks when no tools are defined, so the pair must not reach
    // the provider in its native form.
    const session = makeSession();
    const toolMessage: ChatMessage = {
      ...makeMessage("assistant", "tool output body"),
      toolResult: { callId: "call_1", name: "read_file", input: { path: "x.ts" } },
    };
    const msgs = buildSummaryRequestMessages(session, [makeMessage("user", "u"), toolMessage], "r");
    const flattened = msgs.find((m) => m.content.includes("tool output body"))!;
    expect(flattened).toBeDefined();
    expect(flattened.toolResult).toBeUndefined();
    expect(flattened.role).toBe("user");
    expect(flattened.content).toContain("read_file");
  });

  it("excludes origin-tagged injected notices from the summary source", () => {
    // Task deltas / stale-read nudges / completion blocks are per-turn
    // bookkeeping the injectors rebuild from live state — summarizing them
    // wastes budget on stale snapshots (kimi drops injection-origin messages
    // at compaction for the same reason).
    const session = makeSession();
    const notice: ChatMessage = {
      ...makeMessage("user", "(system) Subagent task state changes since last turn:\nsub_1 completed"),
      origin: "task-delta",
    };
    const msgs = buildSummaryRequestMessages(session, [notice, makeMessage("user", "live message")], "r");
    expect(msgs.some((m) => m.content.includes("Subagent task state changes"))).toBe(false);
    expect(msgs.some((m) => m.content === "live message")).toBe(true);
  });

  it("excludes a prior post-compact restored-context message from the source", () => {
    const session = makeSession();
    const slice = [
      makeMessage("user", `${POST_COMPACT_CONTEXT_PREFIX}\n\nold restored context`),
      makeMessage("user", "live message"),
    ];
    const msgs = buildSummaryRequestMessages(session, slice, "r");
    expect(msgs.some((m) => m.content.includes("old restored context"))).toBe(false);
    expect(msgs.some((m) => m.content === "live message")).toBe(true);
  });

  it("drops oldest messages whole when the slice overflows the summary budget, and says so", () => {
    // 30k window → 10k effective → 8k source budget (the floor). ~24k tokens of
    // slice must trim from the FRONT, keep the newest, and surface the omission
    // in the opener instead of silently truncating.
    const tinyWindow: ModelConfig = { ...deterministicModel, contextWindowTokens: 30_000 };
    const session = makeSession({ model: tinyWindow });
    const slice = Array.from({ length: 30 }, (_, i) => makeMessage("user", `marker-${i} ${"word ".repeat(800)}`));
    const msgs = buildSummaryRequestMessages(session, slice, "r");
    expect(msgs.length).toBeLessThan(slice.length + 2);
    expect(msgs[0]!.content).toContain("omitted");
    expect(msgs.some((m) => m.content.includes("marker-29"))).toBe(true);
    expect(msgs.some((m) => m.content.includes("marker-0 "))).toBe(false);
  });

  it("keeps the whole slice (no omission note) when it fits the budget", () => {
    const session = makeSession();
    const slice = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 ? "assistant" : "user", `m${i}`));
    const msgs = buildSummaryRequestMessages(session, slice, "r");
    expect(msgs).toHaveLength(slice.length + 2);
    expect(msgs[0]!.content).not.toContain("omitted");
  });

  it("sizes the trim budget to the dedicated summary model's window, not the session's", () => {
    // Session on a 200k model, summary delegated to a 30k model (config
    // `compactionModel`): the slice fits the session window but must be
    // trimmed to the SUMMARY model's window or the side call 400s.
    const session = makeSession();
    const summaryModel: ModelConfig = { ...deterministicModel, contextWindowTokens: 30_000 };
    const slice = Array.from({ length: 30 }, (_, i) => makeMessage("user", `marker-${i} ${"word ".repeat(800)}`));
    expect(buildSummaryRequestMessages(session, slice, "r")).toHaveLength(slice.length + 2);
    const msgs = buildSummaryRequestMessages(session, slice, "r", summaryModel);
    expect(msgs.length).toBeLessThan(slice.length + 2);
    expect(msgs[0]!.content).toContain("omitted");
  });
});
