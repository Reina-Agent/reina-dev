import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { description } from "../../prompts/schedule-wakeup.js";

const schema = z.object({
  delaySeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .describe("Seconds from now to fire. Range: 1..3600. Use the longer end (1200s+) for idle waits to avoid burning the prompt cache."),
  prompt: z
    .string()
    .min(1)
    .max(8000)
    .describe("The user-message-shaped prompt that will be injected into this session when the timer fires."),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe("Short one-sentence explanation of why this wakeup was scheduled, for telemetry and user-visible status."),
});

export const scheduleWakeupTool: ToolImplementation = {
  descriptor: {
    name: "schedule_wakeup",
    description,
    permission: "state",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Schedule a future model turn (autonomous loop / CI polling / idle re-check).",
    inputSchema: schema,
    examples: [
      {
        description: "Long idle wait (cache-friendly, default for autonomous loop heartbeats)",
        input: {
          delaySeconds: 1800,
          reason: "idle heartbeat",
          prompt: "Resume autonomous loop and pick up where we left off.",
        },
      },
      {
        description: "Poll a CI run that takes ~8 minutes (under cache TTL)",
        input: {
          delaySeconds: 270,
          reason: "watching CI run",
          prompt: "Re-check the CI status for branch main and decide whether to retry.",
        },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input ?? {});
    if (!options.hostBridge) {
      throw new Error("schedule_wakeup is unavailable in this environment (no host bridge).");
    }
    if (!options.sessionId) {
      throw new Error("schedule_wakeup requires a session context.");
    }
    const data = (await options.hostBridge("schedule_wakeup", {
      sessionId: options.sessionId,
      delaySeconds: parsed.delaySeconds,
      prompt: parsed.prompt,
      reason: parsed.reason,
    })) as { wakeupId: string; firesAt: string } | undefined;
    if (!data?.wakeupId) {
      throw new Error("schedule_wakeup: host did not return a wakeupId.");
    }
    return [
      "<schedule_wakeup>",
      `<wakeup_id>${data.wakeupId}</wakeup_id>`,
      `<fires_at>${data.firesAt}</fires_at>`,
      `<delay_seconds>${parsed.delaySeconds}</delay_seconds>`,
      `<reason>${parsed.reason}</reason>`,
      "</schedule_wakeup>",
    ].join("\n");
  },
};
