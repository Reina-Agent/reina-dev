import type { RolloutItem, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { escapeXml } from "../subagent/format.js";

/** Minimal host surface the TodosController needs from AgentEngine. Mirrors
 * the SubagentHost contract: the controller reads + mutates the slice of
 * SessionState it owns and emits a rollout event when the list changes.
 *
 * Keeping this narrow (instead of passing the whole AgentEngine) means the
 * controller can be unit-tested with a stub host and documents exactly
 * which engine capabilities the todos subsystem depends on. */
export interface TodosHost {
  readonly session: SessionState;
  record(item: RolloutItem): void;
}

type TodoInput = {
  content?: string;
  activeForm?: string;
  status?: string;
};

/** Owns the write_todos tool. The list itself stays on session.todos because
 * the system-prompt nudge and session persistence read it by name — but every
 * WRITE to that field goes through here so the auto-reset semantics, the
 * lastWriteTodosToolCallIndex bookkeeping, and the rollout event live in one
 * place instead of being scattered across engine.ts. */
export class TodosController {
  constructor(private readonly host: TodosHost) {}

  /** Seed the todo checklist from an approved plan. This is the Plan→Todo
   * seam: when `exit_plan_mode` is approved the plan markdown would otherwise
   * be a dead artifact, so we decompose its top-level steps into a starting
   * checklist the model then maintains via write_todos. Mirrors write()'s
   * bookkeeping (rollout event + lastWriteTodosToolCallIndex) so the timeline,
   * persistence, and the "haven't used recently" nudge all behave as if the
   * model had written the list itself.
   *
   * Returns the number of todos seeded. Returns 0 — and writes nothing — when
   * the plan has no parseable list structure (prose-only) OR a non-empty list
   * already exists (never clobber todos the model is mid-way through). The
   * caller falls back to nudging the model to write_todos itself. */
  seedFromPlan(planContent: string): number {
    if (this.host.session.todos.length > 0) return 0;
    const steps = parsePlanSteps(planContent);
    if (steps.length === 0) return 0;
    this.host.session.todos = steps.map((content, index) => ({
      id: `todo_${index + 1}`,
      content,
      activeForm: content,
      status: "pending" as const,
    }));
    this.host.session.lastWriteTodosToolCallIndex = this.host.session.toolCalls.length;
    this.host.record({ type: "todos", todos: this.host.session.todos });
    return steps.length;
  }

  write(record: ToolCallRecord): ToolObservation {
    const todos = (record.input as { todos?: TodoInput[] }).todos ?? [];
    const submitted: SessionState["todos"] = todos.map((todo, index) => ({
      id: `todo_${index + 1}`,
      content: todo.content ?? "",
      activeForm: todo.activeForm ?? todo.content ?? "",
      status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
    }));
    // Auto-clear when every item is completed: by the time the model
    // closes out a list, that batch of work is done. Carrying the
    // "done" residue forward into the next user request lets the model
    // think the list is current state — leading to stale-context bugs
    // ("you already finished writing tests for X, why are you doing it
    // again?"). Match Claude Code's TodoWriteTool semantics: list goes
    // back to empty, model starts fresh next time.
    const allDone = submitted.length > 0 && submitted.every((t) => t.status === "completed");
    this.host.session.todos = allDone ? [] : submitted;
    // Track the tool-call index of the latest write_todos for the
    // "you haven't used this recently" nudge in the system prompt.
    this.host.session.lastWriteTodosToolCallIndex = this.host.session.toolCalls.length;
    this.host.record({ type: "todos", todos: this.host.session.todos });
    // Return both the submitted list and the "nudge to keep using it"
    // receipt, in the same shape Claude Code's TodoWriteTool returns.
    // The receipt text is what actually pushes the model to maintain
    // the list across the rest of the turn — naked JSON dumps don't.
    return {
      callId: record.id,
      name: record.name,
      output: [
        formatTodoSummary(submitted, allDone),
        "",
        "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.",
        allDone ? "All items were marked completed, so the list has been reset to empty for the next batch of work." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

/** Render a todo batch as an XML-tagged snapshot for the tool observation
 * body. The status icon column is a typographic cue, not a separate field
 * — keeps each line under the model's ~80-col scanning window. */
function formatTodoSummary(items: SessionState["todos"], allDone: boolean): string {
  if (items.length === 0) {
    return "<todos count=\"0\">No items in the current list.</todos>";
  }
  const lines = items.map((item) => {
    const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
    const label = item.status === "in_progress" && item.activeForm ? item.activeForm : item.content;
    return `  ${mark} ${item.id} (${item.status}) ${escapeXml(label)}`;
  });
  const counts = items.reduce(
    (acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }),
    { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>,
  );
  const header = `<todos count="${items.length}" pending="${counts.pending}" in_progress="${counts.in_progress}" completed="${counts.completed}"${allDone ? " all_done=\"true\"" : ""}>`;
  return [header, ...lines, "</todos>"].join("\n");
}

/** Upper bound on auto-seeded todos. A plan with more top-level steps than
 * this is almost certainly over-granular for a checklist; the model can add
 * the rest via write_todos. Keeps the seeded list scannable and bounds the
 * prompt cost of the injected snapshot. */
const MAX_SEEDED_TODOS = 20;

/** Extract the top-level actionable steps from an approved plan's markdown so
 * `seedFromPlan` can turn them into a starting checklist. Heuristic + tolerant
 * by design:
 *  - Prefers numbered steps (`1.` / `1)`), then checklist items (`- [ ]`),
 *    then plain top-level bullets — a plan rarely mixes all three at the top
 *    level, and picking one structure avoids double-counting the same step.
 *  - Only top-level items (≤1 leading space) so nested sub-points don't
 *    explode one step into many todos.
 *  - Ignores headings (`#`) and fenced code blocks.
 * Returns [] when the plan is prose with no list structure — the caller then
 * just nudges the model to write_todos rather than seeding noise. */
export function parsePlanSteps(planContent: string): string[] {
  const numbered: string[] = [];
  const checklist: string[] = [];
  const bullets: string[] = [];
  let inFence = false;
  for (const raw of planContent.split(/\r?\n/)) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Top-level only: a nested sub-point is indented two-plus spaces.
    if (raw.length - raw.trimStart().length > 1) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let m = line.match(/^[-*+]\s+\[[ xX]\]\s+(.+)$/);
    if (m) {
      checklist.push(cleanStep(m[1]!));
      continue;
    }
    m = line.match(/^\d+[.)]\s+(.+)$/);
    if (m) {
      numbered.push(cleanStep(m[1]!));
      continue;
    }
    m = line.match(/^[-*+]\s+(.+)$/);
    if (m) {
      bullets.push(cleanStep(m[1]!));
      continue;
    }
  }
  const chosen = numbered.length ? numbered : checklist.length ? checklist : bullets;
  return chosen.filter((step) => step.length > 0).slice(0, MAX_SEEDED_TODOS);
}

/** Strip markdown emphasis/inline-code markers so a seeded todo reads as a
 * plain label, not raw markdown. Conservative — only the markers that show up
 * in plan step text; leaves the wording intact. */
function cleanStep(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}
