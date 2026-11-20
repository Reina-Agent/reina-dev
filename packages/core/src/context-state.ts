import { createHash } from "node:crypto";
import type { ChatMessage } from "@reina/protocol";

export const CONTEXT_STATE_VERSION = 1 as const;

export type ContextStateSnapshot = Record<string, string>;

export type ContextStateMetadata = {
  version: typeof CONTEXT_STATE_VERSION;
  sections: ContextStateSnapshot;
};

export type ModelContextSection = {
  id: string;
  content: string;
  cleared: string;
};

export type ContextStateUpdate = {
  snapshot: ContextStateSnapshot;
  reminders: string[];
};

/** Build the smallest model-visible update for the current context state.
 *
 * The durable snapshot stores hashes rather than section bodies, so restoring a
 * session can compare state without duplicating large note/memory indexes in
 * SQLite metadata. A missing baseline means the retained model history no
 * longer proves what the model saw (new session, legacy session, or compaction),
 * so every non-empty section is injected once as a fresh baseline. */
export function buildContextStateUpdate(
  sections: readonly ModelContextSection[],
  previous?: ContextStateSnapshot,
): ContextStateUpdate {
  const snapshot: ContextStateSnapshot = {};
  const reminders: string[] = [];
  const ids = new Set<string>();

  for (const section of sections) {
    if (ids.has(section.id)) throw new Error(`duplicate model context section id: ${section.id}`);
    ids.add(section.id);

    const content = section.content.trim();
    if (!content) {
      if (previous?.[section.id]) reminders.push(section.cleared);
      continue;
    }

    const hash = sectionHash(content);
    snapshot[section.id] = hash;
    if (!previous || previous[section.id] !== hash) reminders.push(content);
  }

  return { snapshot, reminders: reminders.filter(Boolean) };
}

/** Recover the comparison baseline from the newest context message that is
 * still in the model-visible history. If compaction removed it, callers get no
 * baseline and naturally perform one full re-injection. */
export function latestContextStateSnapshot(
  messages: readonly ChatMessage[],
): ContextStateSnapshot | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.contextState;
    if (metadata?.version !== CONTEXT_STATE_VERSION || !isSnapshot(metadata.sections)) continue;
    return { ...metadata.sections };
  }
  return undefined;
}

function sectionHash(content: string): string {
  return createHash("sha256").update("reina-context-section-v1\0").update(content).digest("hex");
}

function isSnapshot(value: unknown): value is ContextStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((hash) => typeof hash === "string" && hash.length > 0);
}
