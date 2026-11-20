import { createHash } from "node:crypto";
import type { ToolCallRecord } from "@reina/protocol";

/** Compare useful results, excluding per-invocation bookkeeping from tools. */
export function toolResultFingerprint(record: ToolCallRecord): string | undefined {
  if (record.status !== "completed") return undefined;
  let output = record.output?.trim();
  if (!output) return undefined;

  if (record.name === "run_shell") {
    // run_shell returns process failures as text, not observation.error.
    const exitCode = /^<exit_code>([^<]+)<\/exit_code>/.exec(output);
    if (exitCode && exitCode[1] !== "0") return undefined;
    if (output.startsWith("{")) {
      try {
        const receipt = JSON.parse(output) as { taskId?: unknown; status?: unknown; background?: unknown } | null;
        if (receipt?.status === "running" && typeof receipt.taskId === "string" && typeof receipt.background === "string") {
          // A new task ID or elapsed time is not progress on an identical
          // launch command. The first launch still counts as a result.
          output = "background shell started";
        }
      } catch {
        // Ordinary command output need not be JSON.
      }
    }
  }

  // Compression and truncation use a fresh path even for identical output.
  output = output.replace(/\.\.\.\[full output saved to [^\r\n\]]+\]/g, "...[full output saved]");
  return createHash("sha256").update(output).digest("hex");
}
