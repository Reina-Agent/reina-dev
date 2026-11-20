// AgentChipRow — the dedicated subagent presentation in the transcript
// (codex-style): one colored-dot chip per dispatch (`task` /
// `start_async_task`), laid out as a wrapping row so parallel agents read at a
// glance. Clicking a chip expands an inline detail panel (brief, live steps,
// result) under the row — one open at a time; the full step-by-step trace
// still lives in the workspace window's Agent Team tab.
//
// Data flow: the chips themselves render from committed/live tool parts (so
// they survive reload/replay); the live tail + true child status come from
// sessionStore's asyncTaskIndex (async-task-updated pings) and
// subagentActivity (subagent-event stream), matched via the task brief — see
// agentChips.ts. Styled by chat-styles/subagent-chips.css.

import { useState } from "react";
import type { MouseEvent } from "react";
import { bridge } from "~/lib/bridge";
import type { TimelineToolPart } from "./protocol";
import { useMainStore } from "./sessionStore";
import {
  chipActivityTail,
  chipColorIndex,
  chipDurationMs,
  chipFromPart,
  chipStatus,
  formatChipDuration,
  resolveChipTask,
} from "./agentChips";

export function AgentChipRow({ parts }: { parts: TimelineToolPart[] }) {
  const index = useMainStore((s) => s.asyncTaskIndex);
  const activity = useMainStore((s) => s.subagentActivity);
  const [openId, setOpenId] = useState<string | null>(null);

  const chips = parts.map((part) => {
    const chip = chipFromPart(part);
    const task = resolveChipTask(chip, index);
    return { chip, task, status: chipStatus(chip, task) };
  });
  const open = chips.find(({ chip }) => chip.callId === openId) ?? null;
  const openAct = open?.task ? activity[open.task.id] : undefined;

  const openWorkspace = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void bridge().openWorkspaceWindow({ tab: "agentTeam" });
  };

  return (
    <div className="entry subagent-chips">
      <div className="subagent-chip-row">
        {chips.map(({ chip, task, status }) => {
          const act = task ? activity[task.id] : undefined;
          const tail =
            status === "running"
              ? chipActivityTail(act) || "running…"
              : status === "completed"
                ? formatChipDuration(chipDurationMs(chip, task) ?? 0)
                : "";
          const isOpen = chip.callId === openId;
          const cls = [
            "subagent-chip",
            `status-${status}`,
            `color-${chipColorIndex(task?.id ?? chip.callId)}`,
            isOpen ? "open" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={chip.callId}
              type="button"
              className={cls}
              onClick={() => setOpenId(isOpen ? null : chip.callId)}
              title={chip.description}
            >
              <span className="chip-dot" aria-hidden="true" />
              <span className="chip-label">{chip.label}</span>
              <span className="chip-status">
                {status === "completed" && <span className="chip-glyph">✓</span>}
                {status === "failed" && <span className="chip-glyph">✗</span>}
                {tail && <span className="chip-tail">{tail}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {open && (
        <div className="subagent-chip-detail">
          <div className="chip-detail-meta">
            {open.chip.agent ?? open.task?.agent ?? "default"}
            {open.task ? ` · ${open.task.id.replace(/^sub_/, "").slice(0, 8)}` : ""}
          </div>
          <div className="chip-detail-brief">{open.chip.description || open.chip.label}</div>
          {openAct && (openAct.tools.length > 0 || openAct.misc.length > 0) && (
            <ul className="chip-detail-steps">
              {openAct.tools.map((t) => (
                <li key={t.key} className={`chip-detail-step status-${t.status}`}>
                  {t.name}
                  {t.target ? ` · ${t.target}` : ""}
                </li>
              ))}
              {openAct.misc.map((m, i) => (
                <li key={`misc-${i}`} className="chip-detail-step">
                  {m}
                </li>
              ))}
            </ul>
          )}
          {open.status === "failed" && (open.chip.error || open.task?.error) && (
            <div className="chip-detail-error">{open.chip.error || open.task?.error}</div>
          )}
          {open.status !== "failed" && open.chip.output && (
            <div className="chip-detail-output">{open.chip.output}</div>
          )}
          <button type="button" className="subagent-open-workspace" onClick={openWorkspace}>
            在 Workspace 的 Agent Team 中查看完整活动 →
          </button>
        </div>
      )}
    </div>
  );
}
