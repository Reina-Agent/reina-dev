import type { ContextCompactionRecord, ContextRequestRecord } from "@reina/protocol";

export function contextStatistics(requests: ContextRequestRecord[]) {
  let input = 0, output = 0, cached = 0, cacheWrite = 0, modelMs = 0, reported = 0;
  for (const request of requests) {
    const usage = request.usage;
    if (usage && Number.isFinite(usage.inputTokens) && usage.inputTokens > 0) {
      reported += 1;
      input += usage.inputTokens;
      const read = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens || 0));
      cached += read;
      cacheWrite += Math.min(usage.inputTokens - read, Math.max(0, usage.cacheCreationInputTokens || 0));
    }
    if (usage && Number.isFinite(usage.outputTokens)) output += Math.max(0, usage.outputTokens);
    if (request.completedAt) {
      const duration = Date.parse(request.completedAt) - Date.parse(request.startedAt);
      if (Number.isFinite(duration)) modelMs += Math.max(0, duration);
    }
  }
  return {
    requests: requests.length, turns: new Set(requests.map((request) => request.turnId)).size,
    input, output, cached, cacheWrite, uncached: input - cached - cacheWrite, modelMs, reported,
    cachePercent: input ? cached / input * 100 : undefined,
  };
}

export type ContextTimelineEntry = {
  id: string; createdAt: string; kind: "compact" | "switch"; requestId?: string;
  compaction?: ContextCompactionRecord; from?: string; to?: string;
};

/** Model changes are observed between retained requests, not invented switch events. */
export function contextTimeline(requests: ContextRequestRecord[], events: ContextCompactionRecord[]): ContextTimelineEntry[] {
  const entries: ContextTimelineEntry[] = events.map((event) => ({ id: event.id, createdAt: event.createdAt, kind: "compact", compaction: event }));
  requests.forEach((request, index) => {
    const previous = requests[index - 1];
    if (previous && (previous.provider !== request.provider || previous.model !== request.model)) {
      entries.push({ id: `switch-${request.id}`, createdAt: request.startedAt, kind: "switch", requestId: request.id,
        from: `${previous.provider} / ${previous.model}`, to: `${request.provider} / ${request.model}` });
    }
  });
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
