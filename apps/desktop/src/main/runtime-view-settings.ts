import { compactionSettingsSchema, subagentConcurrencySchema, type DesktopRequestWithout } from "@reina/desktop-protocol";
import { readStore, writeStore } from "./store.js";

/** Persist one complete settings block, then wait for the live host to accept it. */
export async function saveRuntimeViewSettings(
  command: "save_compaction_settings" | "save_subagent_concurrency",
  args: Record<string, unknown> | undefined,
  send: (request: DesktopRequestWithout<"id">) => Promise<unknown>,
): Promise<Record<string, string>> {
  const request = command === "save_compaction_settings"
    ? { type: "update_compaction_settings" as const, settings: compactionSettingsSchema.parse(args?.settings) }
    : { type: "update_subagent_concurrency" as const, concurrency: subagentConcurrencySchema.parse(args?.concurrency) };
  const settings = request.type === "update_compaction_settings"
    ? request.settings
    : { subagentConcurrency: request.concurrency };
  const values = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, JSON.stringify(value)]));
  writeStore("view-settings", { ...readStore("view-settings"), ...values });
  await send(request);
  return values;
}
