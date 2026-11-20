// Timeline.tsx — React port of the legacy #timeline inner content.
// Renders committed parts (TimelinePart[]) + a live overlay entry when the
// engine is streaming. Auto-scrolls to bottom unless the user has scrolled up.
// Reproduces the legacy thinking-entry markup while the engine is working with
// an empty overlay. NO Tailwind — only legacy class names.
//
// Thinking entry DOM (from timeline.js showThinking):
//
//   <div class="thinking-entry [is-slow]">
//     <span class="thinking-glyph">✦</span>
//     <span class="thinking-word [is-typing]">Thinking...</span>
//     <span class="thinking-meta">(esc to interrupt)</span>
//   </div>

import { memo, useEffect, useRef, useState } from "react";
import { AgentChipRow } from "./AgentChipRow";
import { ChatEntry } from "./ChatEntry";
import { ErrorEntry } from "./ErrorEntry";
import type { TimelinePart, TimelineTextPart } from "./protocol";
import { useMainStore, type AnchoredNotice } from "./sessionStore";
import { ToolCard } from "./ToolCard";
import { groupToolRuns, summarizeToolRun } from "./toolRunGroups";

// ─── Constants mirroring timeline.js ─────────────────────────────────────────

// Fixed thinking word — no per-turn rotation. The "alive" signal is carried by
// the gradient shimmer sweeping the word (chat.css .text-shimmer), so a single
// stable label reads calmer than the randomized SPINNER_VERBS the legacy
// renderer cycled through.
const THINKING_WORD = "Thinking";
const THINKING_QUIET_MS = 2000;
const THINKING_SLOW_MS = 30_000;
const THINKING_TICK_MS = 250;
const THINKING_WORD_SUFFIX = "...";
const AUTO_SCROLL_THRESHOLD = 96;

// ─── Thinking entry ───────────────────────────────────────────────────────────
// Reproduces the DOM + animation class structure from timeline.js showThinking.

interface ThinkingEntryProps {
  startedAt: number;
}

function ThinkingEntry({ startedAt }: ThinkingEntryProps) {
  const metaRef = useRef<HTMLSpanElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Fixed word (no rotation). The gradient shimmer (chat.css .text-shimmer)
  // carries the "working" motion, so there is no mid-turn typewriter rotation
  // or spinning glyph.

  useEffect(() => {
    // Only the meta line ticks now (elapsed time + slow-turn hint). The word
    // itself is static markup animated purely by CSS.
    const update = () => {
      const elapsedMs = Date.now() - startedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      if (metaRef.current) {
        if (elapsedMs < THINKING_QUIET_MS) {
          metaRef.current.textContent = "(esc to interrupt)";
          wrapRef.current?.classList.remove("is-slow");
        } else if (elapsedMs < THINKING_SLOW_MS) {
          metaRef.current.textContent = `(${formatWorked(elapsedSec * 1000)} · esc to interrupt)`;
          wrapRef.current?.classList.remove("is-slow");
        } else {
          metaRef.current.textContent = `(${formatWorked(elapsedSec * 1000)} · taking longer than usual · esc to interrupt)`;
          wrapRef.current?.classList.add("is-slow");
        }
      }
    };
    update();
    const id = window.setInterval(update, THINKING_TICK_MS);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div ref={wrapRef} className="thinking-entry">
      <span className="thinking-word text-shimmer">{THINKING_WORD}{THINKING_WORD_SUFFIX}</span>
      <span ref={metaRef} className="thinking-meta">(esc to interrupt)</span>
    </div>
  );
}

// Mirrors legacy conversation.js formatWorkedDuration exactly, including the
// hours rollover (>= 60min shows "1h 5m", not "65m").
function formatWorked(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin ? `${hours}h ${restMin}m` : `${hours}h`;
}

// ─── Turn folding ─────────────────────────────────────────────────────────────
// Port of legacy conversation.js foldTurnProcess / foldHistoryTurns. A completed
// turn's intermediate process — reasoning rounds, tool groups, and non-final
// assistant text — collapses into one "Worked for … · N steps" disclosure, with
// the final answer (a trailing assistant message with body) left visible below.
// Without this, every text part and every tool card renders as a detached block
// ("说话和工具分开了"). This is purely presentational over committed `parts`; the
// live (in-flight) turn rides on the overlay + liveTools rendered flat after.

interface TurnSegment {
  user: TimelineTextPart | null;
  body: TimelinePart[];
}

// Split committed parts into turns at user-message boundaries (legacy
// foldHistoryTurns segmentation).
function groupTurns(parts: TimelinePart[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let current: TurnSegment | null = null;
  for (const part of parts) {
    if (part.type === "text" && part.role === "user") {
      if (current) segments.push(current);
      current = { user: part, body: [] };
    } else {
      if (!current) current = { user: null, body: [] };
      current.body.push(part);
    }
  }
  if (current) segments.push(current);
  return segments;
}

function isUnsettledTool(part: TimelinePart): boolean {
  return part.type === "tool" && (part.status === "running" || part.status === "pending_approval");
}

// End time of a turn segment — the newest stamp across its user message and
// body parts (tools date from completion, text from creation). Anchored
// notices insert before the first segment whose end is past their timestamp:
// a compaction that fired mid-turn sits above that turn, a self-evolve review
// that ran after a turn sits right below it — and neither moves when the live
// turn later commits (the in-flight turn has no committed segment yet, so a
// fresh notice trails the transcript exactly where the live divider was).
function segmentEndTime(seg: TurnSegment): number {
  let end = seg.user ? Date.parse(seg.user.createdAt) : NaN;
  for (const part of seg.body) {
    const raw = part.type === "tool" ? part.completedAt ?? part.createdAt : part.createdAt;
    const ts = Date.parse(raw ?? "");
    if (Number.isFinite(ts)) end = Number.isFinite(end) ? Math.max(end, ts) : ts;
  }
  return end;
}

// One timestamp-anchored notice: a settled compaction boundary reuses the
// divider chrome; a self-evolve "💾" memory line renders as a system entry.
function renderAnchoredNotice(n: AnchoredNotice): React.ReactNode {
  return n.kind === "compaction" ? (
    <div key={n.id} className="entry compact-divider">
      <span className="compact-divider-label">{n.text}</span>
    </div>
  ) : (
    <ChatEntry
      key={n.id}
      part={{ id: n.id, type: "text", role: "system", createdAt: n.at, content: n.text }}
      streaming={false}
    />
  );
}

// "Worked for Xs" — span from the user message to the last body part (legacy
// historyTurnDuration). Tools date from completion; text from creation.
function workedLabel(seg: TurnSegment): string {
  const start = seg.user ? Date.parse(seg.user.createdAt) : NaN;
  let end = NaN;
  for (const part of seg.body) {
    const raw = part.type === "tool" ? part.completedAt ?? part.createdAt : part.createdAt;
    const ts = Date.parse(raw ?? "");
    if (Number.isFinite(ts)) end = Number.isFinite(end) ? Math.max(end, ts) : ts;
  }
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    const dur = formatWorked(end - start);
    if (dur) return `Worked for ${dur}`;
  }
  return "Worked";
}

// One batched run of consecutive tools (+ interleaved Thoughts) — the
// CC-desktop style "Ran 7 commands, ran 3 agents, used a tool" disclosure.
// Always collapsed by default; a failed child only tints the header red
// (has-failed) rather than auto-expanding the group. A running child folds in
// too — the header pulses an accent dot (is-running) instead of leaving the
// live card loose below the group.
function ToolRunGroup({ parts }: { parts: TimelinePart[] }) {
  const { label, count, failed, running } = summarizeToolRun(parts);
  const cls = ["entry", "tool-run-group", failed && "has-failed", running && "is-running"]
    .filter(Boolean)
    .join(" ");
  return (
    <details className={cls}>
      <summary className="tool-run-group-summary">
        {running && <span className="tool-run-group-live" aria-hidden="true" />}
        <span className="tool-run-group-label">{label}</span>
        <span className="tool-run-group-count">{count}</span>
      </summary>
      <div className="tool-run-group-body">
        {/* Reasoning rounds pass committed={false} — same rule as TurnProcess:
            the history-mutating action bar belongs to visible answers only. */}
        {parts.map((part) =>
          part.type === "text" ? (
            <ChatEntry key={part.id} part={part} streaming={false} committed={false} />
          ) : (
            <ToolCard key={part.id} part={part} />
          ),
        )}
      </div>
    </details>
  );
}

// Map a part list through groupToolRuns: batched runs render as ToolRunGroup,
// everything else through the caller's per-part renderer.
function renderRunItems(
  parts: TimelinePart[],
  renderLoose: (part: TimelinePart) => React.ReactNode,
): React.ReactNode[] {
  return groupToolRuns(parts).map((item) =>
    item.kind === "run" ? (
      <ToolRunGroup key={item.id} parts={item.parts} />
    ) : item.kind === "chips" ? (
      <AgentChipRow key={item.id} parts={item.parts} />
    ) : (
      renderLoose(item.part)
    ),
  );
}

function TurnProcess({ label, steps, children }: { label: string; steps: number; children: React.ReactNode }) {
  return (
    <details className="entry turn-process">
      <summary className="turn-process-summary">
        <span className="turn-process-label">{label}</span>
        <span className="turn-process-count">{steps} step{steps === 1 ? "" : "s"}</span>
      </summary>
      <div className="turn-process-body">{children}</div>
    </details>
  );
}

// Render one turn: fold its process into a disclosure when it has tool/reasoning
// work and is settled (mirrors foldTurnProcess's step rules + the lone-Thoughts
// skip). `allowFold` is false for the in-flight turn (mirror legacy
// foldHistoryTurns' `isLast && active` guard) so a running turn's already-committed
// steps don't collapse mid-turn. Returns a flat, keyed node list.
function renderSegment(
  seg: TurnSegment,
  allowFold: boolean,
  inFlight = false,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (seg.user) out.push(<ChatEntry key={seg.user.id} part={seg.user} streaming={false} />);
  const body = seg.body;
  if (body.length === 0) return out;

  const last = body[body.length - 1];
  const finalAnswer =
    last.type === "text" && last.role === "assistant" && (last.content ?? "").trim() ? last : null;
  const process = finalAnswer ? body.slice(0, -1) : body;

  let toolSteps = 0;
  let reasoningSteps = 0;
  for (const part of process) {
    if (part.type === "tool") toolSteps += 1;
    else if (part.type === "text" && (part.reasoning ?? "").trim()) reasoningSteps += 1;
  }
  const steps = toolSteps + reasoningSteps;
  // Don't fold the in-flight turn (allowFold), the in-flight tail (a running/
  // pending tool), turns with no foldable work, or a lone Thoughts (already a
  // one-line disclosure).
  const foldable = allowFold && !isUnsettledTool(last) && steps > 0 && !(toolSteps === 0 && reasoningSteps === 1);

  if (!foldable) {
    // In-flight segment: the host commits mid-turn snapshots (async-task
    // updates, set_phase, …), so assistant text can land in `parts` while the
    // turn is still running. Pass committed={false} so the copy/branch/delete/
    // info action bar stays hidden until the turn settles — mutating history
    // under a live turn races the engine, and the bar reads as "done".
    out.push(
      ...renderRunItems(body, (part) =>
        part.type === "text" ? (
          <ChatEntry
            key={part.id}
            part={part}
            streaming={false}
            committed={!inFlight}
          />
        ) : (
          <ToolCard key={part.id} part={part} />
        ),
      ),
    );
    return out;
  }

  out.push(
    <TurnProcess key={`turn-process:${process[0]?.id ?? seg.user?.id ?? "x"}`} label={workedLabel(seg)} steps={steps}>
      {/* Intermediate process steps pass committed={false} to suppress the
          copy/branch/delete/info action bar — those only make sense on the final
          answer, not on each folded reasoning round (mirrors legacy
          foldTurnProcess, which mounts the action bar only on the split-out
          answer). */}
      {renderRunItems(process, (part) =>
        part.type === "text" ? (
          <ChatEntry key={part.id} part={part} streaming={false} committed={false} />
        ) : (
          <ToolCard key={part.id} part={part} />
        ),
      )}
    </TurnProcess>,
  );
  if (finalAnswer) {
    out.push(
      <ChatEntry
        key={finalAnswer.id}
        part={finalAnswer}
        streaming={false}
      />,
    );
  }
  return out;
}

// ─── Committed transcript (memoized) ─────────────────────────────────────────
// The memo boundary that keeps long sessions responsive. Timeline re-renders on
// EVERY streaming update (each text-delta / reasoning-delta / tool-progress
// set()), and before this boundary it rebuilt the React elements for the whole
// committed history each time — O(history) element creation + reconciliation
// per token, which is why sessions got slower the longer they ran. Everything
// here changes only at turn boundaries: `parts` is a fresh array per committed
// snapshot, `anchoredNotices` per snapshot/notice event, and the fold flag
// flips on turn start/settle — all referentially stable between deltas, so
// React.memo skips this whole subtree during streaming and per-token renders
// touch only the live tail below.
// Long-session render window: only the trailing VISIBLE_COMMITTED_TURNS turns
// mount by default; everything older sits behind an explicit expander. This
// caps the committed subtree's mount cost (the memo above already skips
// re-RENDERS during streaming, but a 300-turn session still paid a 300-turn
// mount on session load / every turn boundary). groupTurns itself stays O(all
// parts) — it's cheap data shaping; the expensive part is the React elements.
const VISIBLE_COMMITTED_TURNS = 30;

const CommittedTranscript = memo(function CommittedTranscript({
  parts,
  anchoredNotices,
  suppressLastFold,
}: {
  parts: TimelinePart[];
  anchoredNotices: AnchoredNotice[];
  suppressLastFold: boolean;
}) {
  // Reset per session via the `key={sessionId}` on the call site — a session
  // you expanded stays expanded for its lifetime, a fresh session starts
  // collapsed again.
  const [showAll, setShowAll] = useState(false);
  const segments = groupTurns(parts);
  const hiddenCount = showAll ? 0 : Math.max(0, segments.length - VISIBLE_COMMITTED_TURNS);
  // Interleave the timestamp-anchored notices (compaction boundaries,
  // self-evolve memory lines) into the turn flow at the moment they happened.
  // The store keeps them chronological; leftovers — newer than every committed
  // turn, or stampless — trail after the last segment, the same spot the old
  // end-pinned rendering used for a just-fired notice. Notices anchored inside
  // the hidden window are consumed WITHOUT rendering so they don't all pile up
  // above the first visible turn; expanding restores them in place.
  let noticeIdx = 0;
  const turnNodes: React.ReactNode[] = [];
  if (hiddenCount > 0) {
    turnNodes.push(
      <div key="history-expander" className="entry history-expander">
        <button type="button" className="history-expander-btn" onClick={() => setShowAll(true)}>
          Show {hiddenCount} earlier turn{hiddenCount === 1 ? "" : "s"}
        </button>
      </div>,
    );
  }
  segments.forEach((seg, i) => {
    const end = segmentEndTime(seg);
    const hidden = i < hiddenCount;
    while (noticeIdx < anchoredNotices.length) {
      const n = anchoredNotices[noticeIdx]!;
      const at = Date.parse(n.at);
      if (!Number.isFinite(at) || !Number.isFinite(end) || at >= end) break;
      if (!hidden) turnNodes.push(renderAnchoredNotice(n));
      noticeIdx += 1;
    }
    if (hidden) return;
    const inFlightTail = suppressLastFold && i === segments.length - 1;
    turnNodes.push(
      ...renderSegment(
        seg,
        !inFlightTail,
        inFlightTail,
      ),
    );
  });
  for (; noticeIdx < anchoredNotices.length; noticeIdx += 1) {
    turnNodes.push(renderAnchoredNotice(anchoredNotices[noticeIdx]!));
  }
  return <>{turnNodes}</>;
});

// ─── Timeline component ───────────────────────────────────────────────────────

/**
 * Renders the INNER content of #timeline: maps committed parts to
 * ChatEntry / ToolCard by type, appends a live assistant ChatEntry from the
 * overlay when streaming text is present, and shows a ThinkingEntry when
 * working with an empty overlay.
 *
 * Auto-scroll: a sentinel <div> at the bottom is observed by a ResizeObserver;
 * whenever content grows the scroll container (the parent .timeline section)
 * scrolls to the bottom — unless the user has manually scrolled up past the
 * AUTO_SCROLL_THRESHOLD, in which case we leave their position alone.
 */
export function Timeline() {
  const parts = useMainStore((s) => s.parts);
  // Keys CommittedTranscript so its render-window state (showAll) resets on
  // session switch instead of leaking one session's "expanded" into the next.
  const sessionId = useMainStore((s) => s.sessionId);
  const overlay = useMainStore((s) => s.overlay);
  const working = useMainStore((s) => s.working);
  // Stopping (esc pressed, turn draining). Legacy showThinking() bails while
  // stopping, so the persistent spinner hides during the wind-down.
  const stopping = useMainStore((s) => s.stopping);
  // Start of the current continuous work span — anchors the thinking spinner's
  // elapsed counter. Preserved across compaction/continuations (see store).
  const turnStartedAt = useMainStore((s) => s.turnStartedAt);
  // In-flight tool cards streamed from `tool-progress` (the host only commits a
  // snapshot at turn end, so these carry live tool activity). Cleared into the
  // committed `parts` on the next snapshot — see sessionStore.liveTools.
  const liveTools = useMainStore((s) => s.liveTools);
  // Intermediate assistant text rounds flushed out of the overlay when a tool
  // call ended each round (see sessionStore.liveText). Merged with liveTools by
  // createdAt so the live transcript shows rounds and tool cards in the order
  // they happened (text → its tools → next round), with the still-streaming
  // overlay tail rendered last — instead of all text stacked above all tools.
  const liveText = useMainStore((s) => s.liveText);
  // Ephemeral slash-command confirmations (/agent → X, Unknown model: Y). Rendered
  // as system chips after the committed transcript (mirror legacy appendEntry("system")).
  const systemNotices = useMainStore((s) => s.systemNotices);
  const anchoredNotices = useMainStore((s) => s.anchoredNotices);
  // Turn failure / provider error (set on turn_failed / send catch). Rendered as a
  // .error-entry with a remediation hint (mirror legacy appendErrorEntry).
  const error = useMainStore((s) => s.error);
  // Compaction boundary divider + steered user bubbles (mirror legacy
  // appendCompactDivider / appendEntry-on-user-message).
  const compaction = useMainStore((s) => s.compaction);
  const steerBubbles = useMainStore((s) => s.steerBubbles);
  // Pending human-in-the-loop prompts. The turn is NOT over while one of these is
  // open — `working` is set false on permission_request/question_request so the
  // composer can take input, but the turn resumes after the user answers. The
  // in-flight fold must treat these as "still running" (see suppressLastFold).
  const pendingPermissions = useMainStore((s) => s.pendingPermissions);
  const pendingQuestions = useMainStore((s) => s.pendingQuestions);

  // Sentinel div at the very bottom of the content; used to measure/scroll.
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Whether the user has scrolled up away from the bottom.
  const userScrolledUp = useRef(false);

  // Reset scroll tracking when work (re)starts.
  const prevWorking = useRef(false);
  useEffect(() => {
    if (working && !prevWorking.current) {
      userScrolledUp.current = false;
    }
    prevWorking.current = working;
  }, [working]);

  // Attach scroll listener to the .timeline container to track user scroll.
  useEffect(() => {
    const container = sentinelRef.current?.closest<HTMLElement>(".timeline");
    if (!container) return;
    const onScroll = () => {
      const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
      userScrolledUp.current = dist > AUTO_SCROLL_THRESHOLD;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom after every render when user is at the bottom.
  useEffect(() => {
    if (userScrolledUp.current) return;
    const container = sentinelRef.current?.closest<HTMLElement>(".timeline");
    if (container) container.scrollTop = container.scrollHeight;
  });

  // Build the overlay part as a synthetic TimelineTextPart when streaming.
  const hasOverlayText = working && (overlay.assistantText || overlay.reasoning);
  const overlayPart: TimelineTextPart | null = hasOverlayText
    ? {
        id: "__overlay__",
        type: "text",
        role: "assistant",
        createdAt: new Date().toISOString(),
        content: overlay.assistantText,
        reasoning: overlay.reasoning || undefined,
      }
    : null;

  // Spinner is PERSISTENT for the whole turn — it stays mounted at the very
  // bottom of the transcript even while assistant text streams (mirrors legacy
  // showThinking, which pins the thinking-entry to the end via a MutationObserver
  // and only removes it on hideThinking). The earlier `working && !hasOverlayText`
  // gate made it blink out whenever text streamed — worse now that round-boundary
  // overlay flushes (liveText) clear the overlay between every round. Hidden only
  // while stopping (esc), matching legacy's early-return.

  // Merge the flushed intermediate text rounds with the live tool cards into one
  // ordered stream. Stable sort + text-first concat keeps a round's text above
  // its own tools even when their createdAt ties to the millisecond.
  const liveStream: TimelinePart[] = [...liveText, ...liveTools].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const showThinking = working && !stopping;

  // Elapsed anchor for the spinner's counter. Anchors to the store's
  // `turnStartedAt`, which is RE-ANCHORED at every turn start (Claude Code's
  // per-query reset) so the counter reflects the current model response, not the
  // whole session. Steers/compaction run inside a runTurn (no turn_started) so
  // they keep the anchor — no "压缩后重置". HITL deliberation is excluded: the
  // store banks each pause by shifting turnStartedAt forward on resume, so plain
  // `Date.now() - turnStartedAt` already nets it out. The ref is only a fallback
  // for spans with no recorded start (e.g. a session restored mid-turn).
  const fallbackAnchor = useRef<number>(Date.now());
  const thinkingAnchor = turnStartedAt ?? fallbackAnchor.current;

  // Fold completed turns, but keep the in-flight turn unfolded (mirror legacy
  // foldHistoryTurns({ active: working })). The host commits mid-turn snapshots
  // (e.g. after update_goal / set_phase in Team mode), so without this the current
  // turn's already-run steps collapse into "Worked for …" while it's still going.
  // "In-flight" is broader than `working`: a turn that paused on a permission /
  // question prompt sets working=false (so the composer can take the answer) but
  // is NOT over — it resumes after the user responds. Folding then made a live,
  // mid-turn process collapse to "Worked for …" (the bug: only fold once the task
  // has truly ended). `stopping` (esc drain) is likewise still in-flight. So fold
  // the last segment only when the turn has fully settled — nothing running,
  // draining, or awaiting the user. Guard on steerBubbles: right after a fresh
  // send (before the first snapshot commits the new user message) the last
  // committed segment is still the PREVIOUS, completed turn — folding it then is
  // correct, so only suppress once the in-flight turn's own content is committed last.
  const turnInFlight =
    working || stopping || pendingPermissions.length > 0 || pendingQuestions.length > 0;
  const suppressLastFold = turnInFlight && steerBubbles.length === 0;

  return (
    <div className="timeline-content-column">
      <CommittedTranscript
        key={sessionId ?? "draft"}
        parts={parts}
        anchoredNotices={anchoredNotices}
        suppressLastFold={suppressLastFold}
      />

      {/* LIVE compaction divider — pulses at the tail while the summary call
          runs; ephemeral settled labels ("Nothing to compact", failures) show
          here too. A successful compaction clears this and lands as an
          anchored notice interleaved above, at the boundary's timestamp. */}
      {compaction && (
        <div className={`entry compact-divider${compaction.phase === "running" ? " is-active" : ""}`}>
          <span className="compact-divider-label">{compaction.label}</span>
        </div>
      )}

      {/* User messages materialized before the host snapshot commits them —
          steers AND the optimistic bubble for a fresh send. committed={false}:
          their ids are synthetic (steer-N / sent-N), so the rollback/edit action
          bar must stay hidden until the snapshot commits a real message id. */}
      {steerBubbles.map((b) => (
        <ChatEntry
          key={b.id}
          part={{
            id: b.id,
            type: "text",
            role: "user",
            createdAt: "",
            content: b.text,
            ...(b.attachments && b.attachments.length > 0 ? { attachments: b.attachments } : {}),
          }}
          streaming={false}
          committed={false}
        />
      ))}

      {/* Slash-command system notices (ephemeral, client-side). After committed
          parts, before the live overlay — same order legacy appendEntry used. */}
      {systemNotices.map((n) => (
        <ChatEntry
          key={n.id}
          part={{ id: n.id, type: "text", role: "system", createdAt: "", content: n.text }}
          streaming={false}
        />
      ))}

      {/* Live in-flight stream — intermediate text rounds + tool cards in the
          order they happened. Streams in as the engine emits tool-progress /
          text-delta, before the end-of-turn snapshot folds them into committed
          parts. Rendered BEFORE the overlay tail so the still-streaming round
          sits at the bottom (mirrors legacy's per-round assistant entries).
          Text rounds pass committed={false}: their ids are synthetic, so the
          history-mutating action bar must stay hidden until the snapshot commits
          them to `parts`. */}
      {/* Tools batch into ToolRunGroups as they stream — running ones included
          (the group header pulses); only a pending-approval card stays outside. */}
      {renderRunItems(liveStream, (part) =>
        part.type === "text" ? (
          <ChatEntry key={part.id} part={part} streaming={false} committed={false} />
        ) : (
          <ToolCard key={part.id} part={part} />
        ),
      )}

      {/* Live streaming overlay — the current (tail) round, still receiving
          deltas. Always last in the live block. */}
      {overlayPart && (
        <ChatEntry key="__overlay__" part={overlayPart} streaming={true} />
      )}

      {/* Thinking spinner — only when working with no text yet. */}
      {showThinking && <ThinkingEntry startedAt={thinkingAnchor} />}

      {/* Turn failure / provider error — actionable hint + Open Models button. */}
      {error && !working && <ErrorEntry text={error} />}

      {/* Scroll sentinel — sits at the very bottom of the content. */}
      <div ref={sentinelRef} aria-hidden style={{ height: 0 }} />
    </div>
  );
}
