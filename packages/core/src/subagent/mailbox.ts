import type { AsyncTaskRecord } from "@reina/protocol";

/** Mailbox semantics for the team-mode coordinator/worker channel.
 *
 * Builds on the existing notes infrastructure (notes.ts + send_to_worker
 * tool) by adding two pseudo-recipients with special routing:
 *
 *   - `team-broadcast` — visible to every reader of list_notes,
 *     regardless of who is calling. Written by passing `recipient: "*"`
 *     to send_to_worker.
 *   - `team-lead` — the conventional coordinator inbox. The wire value
 *     is kept for compatibility with existing notes, but the runtime
 *     treats it as the top-level team coordinator channel. Auto idle
 *     notifications land here when a worker completes its last in-flight
 *     subtask.
 *
 * The mailbox module owns the constants + the recipient normalizer.
 * The engine's toolSendToWorker calls `normalizeRecipient(input)` to
 * map the supervisor-supplied alias `"*"` to BROADCAST_RECIPIENT, and
 * notesList consults `isBroadcastRecipient` so broadcasts surface to
 * every caller's list_notes view. */

export const BROADCAST_RECIPIENT = "team-broadcast";
export const COORDINATOR_RECIPIENT = "team-lead";

/** Translate the supervisor-supplied recipient string into the
 * canonical form stored on the note record. Accepts the wildcard
 * `"*"` shorthand for broadcasts; everything else passes through
 * verbatim (trimmed). Empty / whitespace-only inputs are surfaced as
 * undefined so the caller can throw a "recipient required" error. */
export function normalizeRecipient(input: string | undefined): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "*") return BROADCAST_RECIPIENT;
  return trimmed;
}

/** True when a note's stored recipient is the broadcast pseudo-channel. */
export function isBroadcastRecipient(recipient: string | undefined): boolean {
  return recipient === BROADCAST_RECIPIENT;
}

/** Compose the idle-notification body sent to the coordinator when a worker
 * settles. The coordinator's list_notes view picks this up via the
 * COORDINATOR recipient. Kept as a pure formatter so the manager can call it
 * without a notes-service handle. */
export function formatIdleNotification(task: AsyncTaskRecord): {
  title: string;
  body: string;
  tags: string[];
} {
  const handle = task.name ? `${task.id} (${task.name})` : task.id;
  const lines = [
    `Worker ${handle} has settled with status \`${task.status}\`.`,
    `Agent: ${task.agent}`,
  ];
  if (task.description) lines.push(`Brief: ${task.description.slice(0, 200)}${task.description.length > 200 ? "…" : ""}`);
  if (task.result) lines.push("", "Result:", task.result.slice(0, 1500));
  if (task.error) lines.push("", "Error:", task.error);
  return {
    title: `Worker idle: ${handle}`,
    body: lines.join("\n"),
    tags: ["mailbox", "idle", `worker:${task.agent}`],
  };
}
