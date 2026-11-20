import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { bridge } from "~/lib/bridge";
import { SESSION_MODE_DEFS, setSessionMode, useAgentSettings } from "./agentSettings";
import { visibleAddMenuSkills, type AddMenuSkill } from "./composerAddMenuModel";

const TEAM_MODE = SESSION_MODE_DEFS.find((mode) => mode.name === "team");

interface ComposerAddMenuProps {
  workspaceCwd: string | null;
  goalDisabled?: boolean;
  planDisabled?: boolean;
  onAddFile: () => void;
  onEnterGoal: () => void;
  onEnterPlan: () => void;
  onSelectSkill: (skill: AddMenuSkill) => void;
}

function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function ComposerAddMenu({
  workspaceCwd,
  goalDisabled = false,
  planDisabled = false,
  onAddFile,
  onEnterGoal,
  onEnterPlan,
  onSelectSkill,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<AddMenuSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const teamEnabled = useAgentSettings((state) => state.sessionModes.team === true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSkills(null);
  }, [workspaceCwd]);

  useEffect(() => {
    const invalidate = () => setSkills(null);
    const offSkills = bridge().events.on("skills-changed", invalidate);
    const offWorkspace = bridge().events.on("open-workspace", invalidate);
    return () => {
      offSkills?.();
      offWorkspace?.();
    };
  }, []);

  useEffect(() => {
    if (!open || skills !== null) return;
    let cancelled = false;
    setLoading(true);
    void Promise.resolve(bridge().listSkills(workspaceCwd ?? undefined))
      .then((payload) => {
        if (cancelled) return;
        const list = (payload as { skills?: AddMenuSkill[] } | null)?.skills;
        setSkills(visibleAddMenuSkills(Array.isArray(list) ? list : []));
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills, workspaceCwd]);

  useEffect(() => {
    if (!open) return;
    const onOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onOutsidePointer, true);
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onOutsidePointer, true);
    };
  }, [open]);

  const closeAndRun = (action: () => void): void => {
    setOpen(false);
    action();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : current < 0
            ? 0
            : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const toggle = (): void => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const slashPopover = document.getElementById("slash-popover") as HTMLElement | null;
        if (slashPopover) slashPopover.hidden = true;
      }
      return !wasOpen;
    });
  };

  return (
    <div className="composer-add" ref={rootRef}>
      <button
        className="icon-button composer-attach composer-add-trigger"
        id="attach-button"
        ref={triggerRef}
        type="button"
        title="添加"
        aria-label="添加"
        aria-haspopup="menu"
        aria-controls="composer-add-menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="plus" />
      </button>

      {open && (
        <div
          className="composer-add-menu"
          id="composer-add-menu"
          ref={menuRef}
          role="menu"
          aria-label="添加"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="composer-add-section-title">添加</div>
          <button className="composer-add-row" type="button" role="menuitem" onClick={() => closeAndRun(onAddFile)}>
            <span className="composer-add-row-icon">
              <Icon name="paperclip" />
            </span>
            <span className="composer-add-row-copy">
              <strong>文件</strong>
              <span>添加代码、文本、图片或 PDF</span>
            </span>
          </button>
          <button
            className="composer-add-row"
            type="button"
            role="menuitem"
            disabled={goalDisabled}
            onClick={() => closeAndRun(onEnterGoal)}
          >
            <span className="composer-add-row-icon">
              <Icon name="target" />
            </span>
            <span className="composer-add-row-copy">
              <strong>目标</strong>
              <span>设置基于需求的目标</span>
            </span>
          </button>
          <button
            className="composer-add-row"
            type="button"
            role="menuitem"
            disabled={planDisabled}
            onClick={() => closeAndRun(onEnterPlan)}
          >
            <span className="composer-add-row-icon">
              <Icon name="lightbulb" />
            </span>
            <span className="composer-add-row-copy">
              <strong>计划模式</strong>
              <span>先调研并生成计划</span>
            </span>
          </button>
          {TEAM_MODE && (
            <button
              className={`composer-add-row composer-add-mode-row${teamEnabled ? " active" : ""}`}
              type="button"
              role="menuitemcheckbox"
              aria-checked={teamEnabled}
              onClick={() => void setSessionMode(TEAM_MODE.name, !teamEnabled)}
            >
              <span className="composer-add-row-icon">
                <Icon name="sparkles" />
              </span>
              <span className="composer-add-row-copy">
                <strong>{TEAM_MODE.label}</strong>
                <span>{TEAM_MODE.description}</span>
              </span>
              <span className="composer-add-switch" aria-hidden="true" />
            </button>
          )}

          <div className="composer-add-section-title composer-add-skills-title">技能</div>
          {loading && skills === null ? (
            <div className="composer-add-empty">正在加载技能…</div>
          ) : skills?.length ? (
            skills.map((skill) => (
              <button
                className="composer-add-row composer-add-skill-row"
                type="button"
                role="menuitem"
                key={`${skill.scope ?? "workspace"}:${skill.name}`}
                onClick={() => closeAndRun(() => onSelectSkill(skill))}
              >
                <span className="composer-add-row-icon">
                  <Icon name="cube" />
                </span>
                <span className="composer-add-row-copy">
                  <strong>{skill.name}</strong>
                  {skill.description && <span>{skill.description}</span>}
                </span>
              </button>
            ))
          ) : (
            <div className="composer-add-empty">没有可用技能</div>
          )}
        </div>
      )}
    </div>
  );
}
