import { agentSettingsPatchSchema, type DesktopRequestWithout } from "@reina/desktop-protocol";
import { readStoreValue, writeStoreValue } from "./store.js";

/** Settings edits update new-session defaults and only the foreground session.
 * Composer saves use their existing session-scoped path instead. */
export async function saveAgentSettingsPatch(
  input: unknown,
  sessionId: string | null | undefined,
  send: (request: DesktopRequestWithout<"id">) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const patch = agentSettingsPatchSchema.parse(input);
  const raw = readStoreValue("agent-settings", "current");
  let current: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* A malformed saved default can be repaired by this edit. */ }
  }
  const next = { ...current, ...patch };
  writeStoreValue("agent-settings", "current", JSON.stringify(next));
  await send({ type: "patch_agent_settings", sessionId: sessionId ?? undefined, patch });
  return next;
}
