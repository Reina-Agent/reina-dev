//! Heuristic log/build-output compressor — a TypeScript adaptation of the
//! ideas in headroomlabs/headroom's `log_compressor.rs`.
//
// Build and test runners (vitest, tsc, npm/pnpm, cargo, jest, pytest, make)
// emit thousands of lines where only a handful carry signal — the errors,
// the failure summary, and the stack frames around them. Reina's shell tool
// currently tail-truncates that output (`truncateToolOutputTail`), which keeps
// the last N lines blindly: a long install/lint pass that fails early loses
// the error off the top, and a passing-then-noisy run wastes the budget on
// progress chatter.
//
// This module compresses *by importance* before truncation runs, never
// instead of it. The full verbatim output is still saved to disk and made
// recallable by the shell tool, so compression here is lossless from the
// model's point of view — dropped lines are a `read_file` away.
//
// Design rules, in priority order:
//   1. Short output is left untouched (nothing to gain, and we never want to
//      reword a clean 20-line result).
//   2. Any line that looks like an error / warning / failure summary / stack
//      frame is ALWAYS kept, with a few lines of surrounding context. We
//      over-preserve on purpose — dropping a real error is far worse than
//      keeping a few dull lines.
//   3. Runs of low-value lines collapse to a `… [N lines omitted]` marker;
//      adjacent identical (or near-identical) lines collapse to `(line) ×N`.
//   4. If the result doesn't save a meaningful fraction, the ORIGINAL is
//      returned unchanged — we never hand back a scrambled version of output
//      that was already tight.

/** Error/failure keywords (lowercase). Ported from headroom's `ERROR_KEYWORDS`
 * — intentionally broad: better to over-preserve than to drop a real error. */
const ERROR_KEYWORDS = [
  "error",
  "exception",
  "failed",
  "failure",
  "critical",
  "fatal",
  "crash",
  "panic",
  "abort",
  "timeout",
  "denied",
  "rejected",
] as const;

const WARN_KEYWORDS = ["warn", "warning", "deprecated"] as const;

// Summary / failure-banner lines across the common runners. These are the
// lines a human scans to first — the "=== 3 failed, 10 passed ===" verdict,
// the `npm ERR!` block, the `error[E0432]:` rustc diagnostic header.
const SUMMARY_PATTERNS: RegExp[] = [
  /={3,}.*\b(passed|failed|error|skipped)\b/i, // pytest / vitest banner
  /^\s*(FAIL|PASS)\b/, // jest / vitest per-file verdict
  /^\s*Tests?:\s/i, // jest summary "Tests: 1 failed, 2 passed"
  /^\s*npm (ERR|WARN)!/, // npm
  /^\s*error(\[[A-Z]?\d+\])?:/i, // rustc / tsc "error TS2345:" / "error[E0432]:"
  /^\s*warning(\[[A-Z]?\d+\])?:/i, // rustc / cargo warning
  /^\s*\d+\s+(passing|failing|pending)\b/i, // mocha
  /\b(Test Files|Tests)\b.*\b(failed|passed)\b/i, // vitest footer
];

// Stack-trace frame lines. They carry no keyword themselves but are worthless
// without the error they belong to, and useless to drop piecemeal — so we keep
// a contiguous trace block whole whenever it sits next to a kept anchor.
const TRACE_PATTERNS: RegExp[] = [
  /^\s+at\s/, // JS:  "    at foo (file.js:1:2)"
  /^\s*File ".*", line \d+/, // Python: '  File "x.py", line 3'
  /^\s*-->\s/, // rustc: "  --> src/x.rs:1:2"
  /^Traceback \(most recent call last\)/, // Python header
  /panicked at/, // Rust panic
  /^\s*\d+\s*\|/, // rustc / many compilers' code-frame gutter "12 | code"
  /^\s*\^+/, // caret underline under a diagnostic
];

export interface LogCompressOptions {
  /** Below this many lines, return the input untouched. */
  minLines?: number;
  /** Lines of context kept on each side of an anchor line. */
  contextLines?: number;
  /** Collapse a run of dropped lines only when it is at least this long;
   * shorter gaps are cheaper to keep than to mark. */
  minGapToCollapse?: number;
  /** Require at least this fractional byte saving, else return the original
   * unchanged. 0.15 = "must shave ≥15% or don't bother". */
  minSavings?: number;
}

export interface LogCompressResult {
  content: string;
  /** True when the output differs from the input (savings threshold met). */
  compressed: boolean;
  inputLines: number;
  outputLines: number;
  inputBytes: number;
  outputBytes: number;
  /** Fraction of bytes removed (0..1). 0 when not compressed. */
  savings: number;
}

const DEFAULTS: Required<LogCompressOptions> = {
  minLines: 40,
  contextLines: 2,
  minGapToCollapse: 3,
  minSavings: 0.15,
};

/** Importance class of a single line. `anchor` lines are always kept; `trace`
 * lines are kept when contiguous with a kept anchor; `noise` is droppable. */
type LineClass = "anchor" | "trace" | "noise";

function classifyLine(line: string): LineClass {
  const lower = line.toLowerCase();
  for (const pattern of SUMMARY_PATTERNS) {
    if (pattern.test(line)) return "anchor";
  }
  for (const kw of ERROR_KEYWORDS) {
    if (lower.includes(kw)) return "anchor";
  }
  for (const kw of WARN_KEYWORDS) {
    if (lower.includes(kw)) return "anchor";
  }
  for (const pattern of TRACE_PATTERNS) {
    if (pattern.test(line)) return "trace";
  }
  return "noise";
}

/** Normalize a line for adjacent-duplicate detection: collapse runs of digits
 * and hex addresses to a single token so "downloaded chunk 1/900" lines fold
 * together — but keep the message prefix intact so two genuinely different
 * messages that happen to share a trailing number stay distinct. */
function dedupeKey(line: string): string {
  return line
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\d+/g, "#")
    .trim();
}

export function compressLogOutput(text: string, options: LogCompressOptions = {}): LogCompressResult {
  const opts = { ...DEFAULTS, ...options };
  const inputBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split(/\r?\n/);
  const inputLines = lines.length;

  const unchanged = (): LogCompressResult => ({
    content: text,
    compressed: false,
    inputLines,
    outputLines: inputLines,
    inputBytes,
    outputBytes: inputBytes,
    savings: 0,
  });

  // Rule 1: short output — nothing to gain.
  if (inputLines < opts.minLines) return unchanged();

  const classes = lines.map(classifyLine);

  // Mark which line indices to keep. Start with anchors + their context window.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] !== "anchor") continue;
    const from = Math.max(0, i - opts.contextLines);
    const to = Math.min(lines.length - 1, i + opts.contextLines);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  // Keep contiguous trace blocks that touch a kept line on either edge — a
  // stack trace is only useful whole and only when its error survived.
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] !== "trace") continue;
    let start = i;
    while (start > 0 && classes[start - 1] === "trace") start--;
    let end = i;
    while (end < lines.length - 1 && classes[end + 1] === "trace") end++;
    const touchesKept = (start > 0 && keep[start - 1]) || (end < lines.length - 1 && keep[end + 1]);
    if (touchesKept) {
      for (let j = start; j <= end; j++) keep[j] = true;
    }
    i = end; // skip past the block we just considered
  }

  // Emit: kept lines verbatim; runs of dropped lines collapse to a marker;
  // adjacent near-identical kept... no — dedupe applies to DROPPED runs we
  // would otherwise mark, and to repeated kept lines is left alone (rare).
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    // Gather the run of dropped lines [i, j).
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    const runLength = j - i;
    if (runLength >= opts.minGapToCollapse) {
      out.push(`… [${runLength} lines omitted]`);
    } else {
      // Short gap: cheaper to keep than to annotate, but fold adjacent
      // duplicates within it so spinner/progress repeats don't survive.
      let prevKey: string | null = null;
      let repeat = 0;
      const flush = (line: string) => {
        if (repeat > 1) out.push(`${line}  ×${repeat}`);
        else if (repeat === 1) out.push(line);
      };
      let prevLine = "";
      for (let k = i; k < j; k++) {
        const key = dedupeKey(lines[k]!);
        if (key === prevKey) {
          repeat++;
        } else {
          flush(prevLine);
          prevKey = key;
          prevLine = lines[k]!;
          repeat = 1;
        }
      }
      flush(prevLine);
    }
    i = j;
  }

  const content = out.join("\n");
  const outputBytes = Buffer.byteLength(content, "utf8");
  const savings = inputBytes > 0 ? 1 - outputBytes / inputBytes : 0;

  // Rule 4: don't hand back a scrambled version that barely saved anything.
  if (savings < opts.minSavings) return unchanged();

  return {
    content,
    compressed: true,
    inputLines,
    outputLines: out.length,
    inputBytes,
    outputBytes,
    savings,
  };
}
