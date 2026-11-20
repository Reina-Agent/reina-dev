#!/usr/bin/env node
import { createInterface } from "node:readline";
import { errorMessage } from "@reina/protocol";
import { AgentHost } from "./index.js";
import { parseDesktopRequest, parseJsonLine, serializeJsonLine, type DesktopOutbound } from "@reina/desktop-protocol";

// Respect stdout backpressure: when the main-process reader stalls,
// `process.stdout.write` returns false and continuing to write piles every
// model_stream token straight into Node's internal stream buffer (unbounded
// growth in the host's heap). Queue instead, stop pulling on a false write, and
// resume only on `drain`.
const outQueue: string[] = [];
let draining = false;

function flushOut(): void {
  if (draining) return;
  while (outQueue.length > 0) {
    const chunk = outQueue.shift()!;
    if (!process.stdout.write(chunk)) {
      draining = true;
      process.stdout.once("drain", () => {
        draining = false;
        flushOut();
      });
      return;
    }
  }
}

function write(message: DesktopOutbound): void {
  outQueue.push(serializeJsonLine(message));
  flushOut();
}

const host = new AgentHost(write);
write({ type: "host_ready", version: "0.1.0" });

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  void handleLine(line);
});

// A rejected fire-and-forget promise anywhere in the engine must not take
// down the host: Node's default (--unhandled-rejections=throw) would kill the
// process — and with it every live session — over one background task's
// settlement bug. Log to stderr (the controller forwards it into the app log)
// and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error(`[agent-host] unhandled rejection: ${errorMessage(reason)}`);
});

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

async function handleLine(line: string): Promise<void> {
  let requestId: string | undefined;
  let command = "unknown";
  try {
    const parsed = parseJsonLine(line);
    requestId = typeof parsed === "object" && parsed !== null && "id" in parsed ? String(parsed.id) : undefined;
    command = typeof parsed === "object" && parsed !== null && "type" in parsed ? String(parsed.type) : "unknown";
    const request = parseDesktopRequest(parsed);
    const response = await host.handle(request);
    if (response) write(response);
    if (request.type === "shutdown") await shutdown(0);
  } catch (error) {
    write({
      type: "response",
      id: requestId,
      command,
      success: false,
      error: errorMessage(error),
    });
  }
}

async function shutdown(code: number): Promise<never> {
  rl.close();
  await host.close();
  process.exit(code);
}
