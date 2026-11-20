import type { RolloutItem, SessionState, ToolCallRecord, ToolObservation } from "@reina/protocol";
import { nowIso } from "@reina/protocol";
import { pushTrace } from "../trace.js";

export type UserQuestionHandler = (input: {
  prompt: string;
  options?: string[];
}) => Promise<{ answer: string } | { cancelled: true }>;

/** Minimal host surface the QuestionController needs. The single-vs-batch
 * tool shape both push onto session.pendingQuestions; the subagent escalation
 * path (used when isSubagent + a handler is wired) bubbles inline through
 * `userQuestionHandler` and resolves the whole thing before returning. The
 * handler is read fresh from a getter because the parent wires it onto every
 * spawned child AFTER construction. */
export interface QuestionHost {
  readonly session: SessionState;
  readonly userQuestionHandler: UserQuestionHandler | undefined;
  record(item: RolloutItem): void;
}

type OptionInput = { label: string; description?: string; preview?: string };
type QuestionInput = {
  question: string;
  header?: string;
  options?: OptionInput[];
  multiSelect?: boolean;
};

/** Owns the `question` tool handler. The matching `answerQuestion` /
 * `answerQuestionGroup` resolution path stays on AgentEngine because it's a
 * public API surface the renderer/IPC layer calls — extracting just the
 * dispatch handler keeps engine.ts smaller without splitting the answer
 * channel from the public engine. */
export class QuestionController {
  constructor(private readonly host: QuestionHost) {}

  ask(record: ToolCallRecord): ToolObservation | Promise<ToolObservation> {
    const input = record.input as Partial<QuestionInput> & { questions?: QuestionInput[] };

    // Subagent escalation: a worker has no UI of its own, so route its
    // question up to the parent's user via the bubble channel and block inline
    // until answered. Returns ONE observation carrying the answer(s).
    if (this.host.session.isSubagent && this.host.userQuestionHandler) {
      return this.bubbleToUser(record, input);
    }

    // Batch form: produce N pendingQuestions sharing groupId = record.id so
    // the renderer can render one card with one Submit button, and the
    // engine can return one combined observation when all are answered.
    if (Array.isArray(input.questions) && input.questions.length > 0) {
      const groupId = record.id;
      const created = input.questions.map((q, index) => ({
        id: `${groupId}::${index}`,
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        ...(q.options ? { options: q.options } : {}),
        ...(q.multiSelect ? { multiSelect: true as const } : {}),
        groupId,
        status: "pending" as const,
        createdAt: nowIso(),
      }));
      for (const q of created) {
        this.host.session.pendingQuestions.push(q);
        this.host.record({ type: "question", question: q });
      }
      pushTrace(this.host.session, "question.pending", { groupId, count: created.length });
      return {
        callId: record.id,
        name: record.name,
        output: `${created.length} questions pending`,
      };
    }

    // Single-question shape.
    if (!input.question) return { callId: record.id, name: record.name, error: "question requires question" };
    const question = {
      id: record.id,
      question: input.question,
      ...(input.header ? { header: input.header } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.multiSelect ? { multiSelect: true as const } : {}),
      status: "pending" as const,
      createdAt: nowIso(),
    };
    this.host.session.pendingQuestions.push(question);
    this.host.record({ type: "question", question });
    pushTrace(this.host.session, "question.pending", { question });
    return {
      callId: record.id,
      name: record.name,
      output: `Question pending: ${input.question}`,
    };
  }

  /** Forward a subagent's `question` to the parent's user via the escalation
   * handler, awaiting each answer inline. Supports both the single and batched
   * `question` shapes; multiple questions are asked sequentially and joined
   * into one observation so the worker resumes with all answers at once. */
  private async bubbleToUser(
    record: ToolCallRecord,
    input: {
      question?: string;
      header?: string;
      options?: Array<{ label: string }>;
      questions?: Array<{ question: string; header?: string; options?: Array<{ label: string }> }>;
    },
  ): Promise<ToolObservation> {
    const handler = this.host.userQuestionHandler!;
    const items =
      Array.isArray(input.questions) && input.questions.length > 0
        ? input.questions
        : input.question
          ? [{ question: input.question, header: input.header, options: input.options }]
          : [];
    if (items.length === 0) {
      return { callId: record.id, name: record.name, error: "question requires question" };
    }
    const answers: string[] = [];
    for (const q of items) {
      const result = await handler({ prompt: q.question, options: q.options?.map((o) => o.label) });
      const label = items.length > 1 ? `${q.header ?? q.question}: ` : "";
      answers.push("cancelled" in result ? `${label}(no answer — user unavailable; use your best judgment)` : `${label}${result.answer}`);
    }
    return { callId: record.id, name: record.name, output: `User answered: ${answers.join("\n")}` };
  }
}
