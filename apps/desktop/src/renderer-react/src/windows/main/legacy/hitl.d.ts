// Type surface for the verbatim-copied legacy renderer/hitl.js. Only the one
// exported entry the React wrapper uses is typed; the rest are internal.
// hitl.js is pure, dependency-free DOM logic — copied (not re-implemented) so
// the HITL dock stays byte-identical to legacy.

import type { PendingQuestionItem, PermissionToolCall } from "../protocol";

export interface HitlDockEls {
  hitlDock: HTMLElement;
  hitlTitle: HTMLElement;
  hitlSubtitle: HTMLElement;
  hitlCollapseButton: HTMLElement;
  permissionList: HTMLElement;
  questionList: HTMLElement;
}

export interface HitlDockActions {
  approve: (callId: string, approved: boolean, opts?: { remember?: "session"; updatedInput?: unknown; reason?: string }) => void;
  approveAll?: (approved: boolean) => void;
  alwaysAllow?: (callId: string, rule: Record<string, unknown>) => void;
  answer: (questionId: string, answer: string) => void;
  answerGroup: (groupId: string, answers: Record<string, string>) => void;
}

export interface HitlDockHelpers {
  stableJson: (value: unknown) => string;
  truncate: (value: unknown, max: number) => string;
}

export function renderHitlDockView(args: {
  els: HitlDockEls;
  pendingPermissions: Map<string, PermissionToolCall>;
  pendingQuestions: Map<string, PendingQuestionItem>;
  collapsed: boolean;
  actions: HitlDockActions;
  helpers: HitlDockHelpers;
}): void;
