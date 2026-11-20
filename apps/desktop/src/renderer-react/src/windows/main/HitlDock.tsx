// HITL dock — React wrapper around the verbatim-copied legacy renderer
// (legacy/hitl.js). This component renders ONLY the static dock shell (header +
// two empty list containers) once; it never re-renders. An effect subscribes to
// the store imperatively and re-invokes renderHitlDockView against the refs on
// every change. The legacy renderer owns everything inside: hidden/collapsed
// state, the title text, the permission/question items, keyboard nav, previews,
// batched groups — so the dock stays byte-identical to legacy with zero
// re-implementation.

import { useEffect, useRef } from "react";
import { renderHitlDockView } from "./legacy/hitl.js";
import { stableJson, truncate } from "./hitlHelpers";
import {
  answerQuestion,
  answerQuestionGroup,
  approveAllPermissions,
  approvePermission,
  getMainState,
  persistAlwaysAllow,
  subscribeMainStore,
  toggleHitlDock,
} from "./sessionStore";

export function HitlDock() {
  const dockRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const permRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const render = () => {
      const dock = dockRef.current;
      const title = titleRef.current;
      const subtitle = subtitleRef.current;
      const collapse = collapseRef.current;
      const permissionList = permRef.current;
      const questionList = questionRef.current;
      if (!dock || !title || !subtitle || !collapse || !permissionList || !questionList) return;
      const s = getMainState();
      renderHitlDockView({
        els: { hitlDock: dock, hitlTitle: title, hitlSubtitle: subtitle, hitlCollapseButton: collapse, permissionList, questionList },
        pendingPermissions: new Map(s.pendingPermissions.map((t) => [t.id, t])),
        pendingQuestions: new Map(s.pendingQuestions.map((q) => [q.id, q])),
        collapsed: s.hitlCollapsed,
        actions: {
          approve: (callId, approved, opts) => void approvePermission(callId, approved, opts),
          approveAll: (approved) => void approveAllPermissions(approved),
          alwaysAllow: (callId, rule) => void persistAlwaysAllow(callId, rule),
          answer: (questionId, answer) => void answerQuestion(questionId, answer),
          answerGroup: (groupId, answers) => void answerQuestionGroup(groupId, answers),
        },
        helpers: { stableJson, truncate },
      });
    };
    render();
    return subscribeMainStore(render);
  }, []);

  return (
    <section
      id="hitl-dock"
      className="hitl-dock"
      role="region"
      aria-labelledby="hitl-title"
      aria-describedby="hitl-subtitle"
      hidden
      ref={dockRef}
    >
      <div className="hitl-header">
        <div>
          <strong id="hitl-title" ref={titleRef}>Action needed</strong>
          <p id="hitl-subtitle" ref={subtitleRef}>The agent is waiting for your decision.</p>
        </div>
        <button
          id="hitl-collapse"
          className="ghost-button"
          type="button"
          title="Collapse"
          aria-label="Collapse action panel"
          ref={collapseRef}
          onClick={() => toggleHitlDock()}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
            <use href="#i-chevron-down" />
          </svg>
        </button>
      </div>
      <div id="permission-list" className="hitl-list" ref={permRef} />
      <div id="question-list" className="hitl-list" ref={questionRef} />
    </section>
  );
}
