import type { CompactBoundary, TokenRequestBreakdown, TokenUsage } from "./index.js";

/** Local input estimates. These six mutually exclusive parts sum to the
 * request's estimatedInputTokens; output and cache reads are not extra parts. */
export type ContextComposition = {
  system: number;
  tools: number;
  user: number;
  injected: number;
  assistant: number;
  toolResults: number;
};

/** One engine-level provider attempt. The body is the logical model request,
 * before provider-specific HTTP serialization and SDK-internal retries. */
export type ContextRequestRecord = {
  id: string;
  sessionId: string;
  turnId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  status: "preview" | "running" | "completed" | "failed" | "cancelled";
  provider: string;
  model: string;
  breakdown: TokenRequestBreakdown;
  usage?: TokenUsage;
  error?: string;
};

export type ContextCompactionRecord = {
  id: string;
  createdAt: string;
  status: "started" | "completed" | "failed";
  reason?: string;
  boundary?: CompactBoundary;
  error?: string;
};

export type ContextHistory = {
  requests: ContextRequestRecord[];
  events: ContextCompactionRecord[];
  retentionLimit: number;
  /** Read-only next-request estimate, never persisted as a request attempt. */
  live?: ContextRequestDetail;
};

export type ContextRequestDetail = {
  request: ContextRequestRecord;
  sections: Array<{
    id: string;
    label: string;
    items: Array<{
      id: string; label: string; content: string; truncated?: boolean;
      /** Proportional allocation of the local category estimate. Absent when
       * that estimate or the category's complete inspection content is unavailable. */
      tokens?: number;
      category?: keyof ContextComposition;
      source?: string;
      role?: string;
      createdAt?: string;
    }>;
  }>;
};
