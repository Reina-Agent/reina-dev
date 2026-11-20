import { z } from "zod";
import type { ToolImplementation } from "../../types.js";
import { description } from "../../prompts/notify.js";

const schema = z.object({
  title: z.string().min(1).max(200).describe("Notification title (1-200 chars)."),
  body: z.string().min(1).max(2000).describe("Notification body (1-2000 chars)."),
  silent: z.boolean().optional().describe("If true, suppress the system notification sound."),
});

export const notifyTool: ToolImplementation = {
  descriptor: {
    name: "notify",
    description,
    permission: "state",
    requiresApproval: false,
    concurrencySafe: true,
    exposure: "deferred",
    catalogSummary: "Post a native desktop notification (toast/banner) to the user.",
    inputSchema: schema,
    examples: [
      {
        description: "Tell the user a long-running task finished",
        input: { title: "Build done", body: "All checks green on main." },
      },
      {
        description: "Silent variant for low-priority signals",
        input: { title: "Lints clean", body: "0 errors / 2 warnings", silent: true },
      },
    ],
  },
  async execute(input, options) {
    const parsed = schema.parse(input ?? {});
    if (!options.hostBridge) {
      throw new Error("notify is unavailable in this environment (no host bridge).");
    }
    const data = (await options.hostBridge("notify", {
      title: parsed.title,
      body: parsed.body,
      silent: parsed.silent ?? false,
    })) as { delivered: boolean; reason?: string } | undefined;
    if (!data || !data.delivered) {
      const reason = data?.reason ?? "host did not confirm delivery";
      return `<notify><delivered>false</delivered><reason>${reason}</reason><title>${parsed.title}</title></notify>`;
    }
    return `<notify><delivered>true</delivered><title>${parsed.title}</title></notify>`;
  },
};
