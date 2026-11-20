// SlashPopover — React port of the legacy composer "/" autocomplete: the
// #slash-popover that opens when the prompt textarea starts with "/" (or the
// skill launcher is triggered), showing filtered slash commands + installed
// skills (workspace + global), with keyboard nav and accept → prime / stage or
// enter the dedicated Goal composer.
//
// Faithful tech-stack swap: reproduces the EXACT legacy DOM (same class names /
// ids / structure as renderer/composer.js renderSlashCommandPopoverView +
// renderSkillPickerView) and reuses the already-linked legacy composer.css. ZERO
// visual/behavioral change. The popover CONTENT is built imperatively —
// byte-for-byte the same createElement / innerHTML the legacy view helpers
// produce — so it stays identical to legacy with zero re-implementation drift
// (same approach as ComposerPickers / WorkspaceSwitcher).
//
// ## How it's driven
// Legacy bound `promptEl.addEventListener("input", renderSlashCommandPopover)`
// (keymap.js) and re-rendered from `promptEl.value`. We do the same: this
// component owns the `#slash-popover` element and attaches its OWN `input` +
// `keydown` listeners to the existing `#prompt` textarea (looked up by id). It
// never reads React state — it reads `promptEl.value` directly, exactly like
// legacy — so it stays correct whether the textarea is controlled or not. The
// sole React callback enters Composer's dedicated Goal editor when `/goal` is
// accepted.
//
// ## Two modes (slashCommandQuery, ported verbatim)
//   - "slash" mode: `/foo` (no trailing space, prefix-matches a known command) →
//     renderSlashCommandPopoverView. Most accepts PRIME the composer (`/foo `),
//     exactly like legacy acceptSlashCommand — the command executes later on
//     send (runSlashCommand), which is the Composer's send path, not ours.
//     `/goal` instead enters the dedicated Goal composer immediately.
//   - "skill" mode: `/skill …`, or a `/foo` that matches no command → the
//     launcher: a 命令 section of slash-command control rows + a 技能 section of
//     installed skills (renderSkillPickerView). Skills come from
//     bridge.listSkills(cwd), lazy-loaded + cached on first skill-mode open.
//
// ## Behavior deltas vs legacy (see also the task's caveats)
//   - Accepting a command CONTROL row (命令 section): legacy ran the command
//     immediately via runCommand(id). The React main renderer has no command
//     dispatcher (runCommandInMain only reaches a legacy menu-command listener),
//     so most controls PRIME the composer with that command's `/slash ` token —
//     the same faithful "stage it, send to run" path slash-mode uses. `/goal`
//     opens its dedicated editor; `/skill` stays open in skill mode.
//   - Accepting a SKILL row: stages it into the sessionStore `pendingSkills`
//     (addPendingSkill) as an inline composer tag, matching legacy. The Composer
//     renders the tag and prepends `Use the \`<name>\` skill.` to the message on
//     send (read_skill on that name), then clears it.

import { useEffect, useRef } from "react";
import { bridge } from "~/lib/bridge";
import { displayKeybind } from "~/lib/keybinds";
import { addPendingSkill, getMainState } from "./sessionStore";
import {
  COMMAND_ICONS,
  SLASH_COMMANDS,
  resolveSlashCommandAcceptance,
  type SlashCommand,
} from "./slashCommands";
import { getPromptPrefs } from "./promptPrefs";

// ── Skill shape (mirror main/ipc.ts SkillSummary, as returned by listSkills) ──

interface Skill {
  name: string;
  description?: string;
  scope?: "workspace" | "global";
  path?: string;
  allowedTools?: string[];
}

// ── Module-level wiring (mirror the legacy globals/closures) ───────────────────
//
// The legacy renderer kept a single shared `#slash-popover` element + the
// `#prompt` textarea and re-rendered on every input. We keep the same shape,
// bound to the live DOM nodes the React component owns (popover) / looks up
// (prompt) at mount.

let popoverEl: HTMLDivElement | null = null;
let promptEl: HTMLTextAreaElement | null = null;
let enterGoalComposer: (() => void) | null = null;

// Skill cache + in-flight latch (mirror legacy state.skills + skillFetchInFlight).
let skillsCache: Skill[] = [];
let skillFetchInFlight = false;
let skillsLoaded = false;
let skillsRevision = 0;

function invalidateSkills(): void {
  skillsRevision += 1;
  skillsLoaded = false;
  skillsCache = [];
  render();
}

// ── Native value setter so a controlled <textarea> re-syncs React state ────────
//
// The composer textarea is a React-controlled input. Setting `.value` directly
// would be clobbered on the next render. We set it through the native setter and
// dispatch a bubbling "input" event so React's onChange runs and adopts the new
// value (the standard React-controlled-input external-write pattern). This is
// the React-renderer equivalent of legacy's `promptEl.value = "…"`.
const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)?.set;

function setPromptValue(value: string): void {
  if (!promptEl) return;
  if (nativeTextareaValueSetter) nativeTextareaValueSetter.call(promptEl, value);
  else promptEl.value = value;
  promptEl.dispatchEvent(new Event("input", { bubbles: true }));
  promptEl.focus();
  const end = promptEl.value.length;
  promptEl.setSelectionRange(end, end);
}

// ── slashCommandQuery — ported verbatim from legacy actions/prompt.js ──────────
//
// Returns null when the popover should be hidden, or a mode object that tells
// the renderer which view to show.

interface SlashQuery {
  mode: "slash" | "skill";
  query: string;
}

function slashCommandQuery(): SlashQuery | null {
  const value = promptEl?.value ?? "";
  // Honor the General settings "启用斜杠命令" toggle (legacy
  // state.desktopConfig.promptInput.enableSlashCommands). Off → never surface the
  // popover, so "/" is just literal text.
  if (!getPromptPrefs().enableSlashCommands) return null;
  if (!value.startsWith("/")) return null;
  const skillMatch = value.match(/^\/skill(?:\s+(.*))?$/i);
  if (skillMatch) return { mode: "skill", query: (skillMatch[1] ?? "").toLowerCase() };
  // Whitespace after the slash token means the user is typing arguments —
  // dismiss the popover (Codex behavior). Must run BEFORE the skill-mode
  // fallback: "/goal " no longer prefix-matches any command, so it would
  // otherwise fall through to the skill picker. `/skill …` above is the one
  // deliberate exception that stays open across spaces.
  if (/\s/.test(value)) return null;
  const query = value.slice(1).toLowerCase();
  const commandMatches = SLASH_COMMANDS.some((command) => command.slash.toLowerCase().startsWith(value.toLowerCase()));
  if (!query || !commandMatches) return { mode: "skill", query };
  return { mode: "slash", query };
}

// ── slashCommandControls — mirror legacy actions/prompt.js slashCommandControls ─
//
// Command rows shown above the skills in the `/` launcher, derived from the
// slash-command registry so only real slash commands ever appear.

interface SlashControl {
  slash: string;
  title: string;
  description: string;
  meta: string;
  icon: string;
  disabled: boolean;
}

function slashCommandControls(): SlashControl[] {
  return SLASH_COMMANDS.map((command) => ({
    slash: command.slash,
    title: command.slash,
    description: command.title,
    meta: command.keybind ? displayKeybind(command.keybind) : "",
    icon: COMMAND_ICONS[command.category] || "command",
    disabled: Boolean(command.disabled?.()),
  }));
}

// ── Accept handlers (mirror legacy acceptSlashCommand / acceptSkill / acceptSkillControl) ──

function acceptCommandSlash(slash: string): void {
  const acceptance = resolveSlashCommandAcceptance(slash);
  if (acceptance.kind === "composer" && acceptance.mode === "goal" && enterGoalComposer) {
    hide();
    enterGoalComposer();
    return;
  }
  setPromptValue(acceptance.kind === "prompt" ? acceptance.value : `${slash} `);
  render();
}

function acceptSlashCommand(command: SlashCommand): void {
  if (!command.slash) return;
  acceptCommandSlash(command.slash);
}

function acceptControl(control: SlashControl): void {
  if (control.disabled) return;
  // `/goal` enters its dedicated editor. Other rows use the faithful
  // "stage, send to run" path; `/skill` re-enters skill mode and stays open.
  acceptCommandSlash(control.slash);
}

function acceptSkill(skill: Skill): void {
  if (!skill.name) return;
  // Stage the skill as an inline composer tag (mirror legacy state.pendingSkills);
  // the Composer renders the tag and prepends "Use the `name` skill." on send.
  // Clear the "/skill …" trigger text so only the tag remains.
  addPendingSkill({ name: skill.name, description: skill.description });
  setPromptValue("");
  hide();
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function hide(): void {
  if (!popoverEl) return;
  popoverEl.hidden = true;
  popoverEl.textContent = "";
}

// renderSlashCommandPopoverView — byte-for-byte mirror of legacy composer.js.
function renderSlashView(query: string): void {
  if (!popoverEl) return;
  const filtered = SLASH_COMMANDS.filter((command) => {
    const haystack = `${command.slash} ${command.title} ${command.category}`.toLowerCase();
    return haystack.includes(query);
  }).slice(0, 8);
  popoverEl.hidden = filtered.length === 0;
  popoverEl.textContent = "";
  for (const command of filtered) {
    const row = document.createElement("button");
    row.className = "slash-row";
    row.disabled = Boolean(command.disabled?.());
    row.innerHTML = "<strong></strong><span></span><small></small>";
    row.querySelector("strong")!.textContent = command.slash;
    row.querySelector("span")!.textContent = command.title;
    row.querySelector("small")!.textContent = command.category;
    row.onclick = () => acceptSlashCommand(command);
    popoverEl.appendChild(row);
  }
}

// renderSkillPickerView — byte-for-byte mirror of legacy composer.js.
function renderSkillView(query: string, emptyHint?: string): void {
  if (!popoverEl) return;
  popoverEl.textContent = "";
  const normalized = (query ?? "").trim().toLowerCase();
  const controls = slashCommandControls();
  const filteredControls = controls.filter((control) => {
    if (!normalized) return true;
    const haystack = `${control.title} ${control.description || ""} ${control.meta || ""}`.toLowerCase();
    return haystack.includes(normalized);
  });
  // Frontmatter `user-invocable: false` marks a skill as model-only — it
  // stays out of the user-facing picker (mirrors core skills.ts parsing).
  const skills = skillsCache.filter((skill) => (skill as { userInvocable?: boolean }).userInvocable !== false);
  const filtered = (skills || [])
    .filter((skill) => {
      if (!normalized) return true;
      const haystack = `${skill.name} ${skill.description || ""} ${(skill.allowedTools || []).join(" ")} ${skill.scope || ""}`.toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, 12);

  if (filteredControls.length === 0 && filtered.length === 0) {
    popoverEl.hidden = false;
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = emptyHint || (skills && skills.length > 0 ? "No matching skills" : "No skills installed");
    popoverEl.appendChild(empty);
    return;
  }
  popoverEl.hidden = false;

  if (filteredControls.length > 0) {
    const heading = document.createElement("div");
    heading.className = "slash-section-title";
    heading.textContent = "命令";
    popoverEl.appendChild(heading);
  }

  for (const control of filteredControls) {
    const row = document.createElement("button");
    row.className = "slash-row slash-row-control";
    row.disabled = Boolean(control.disabled);
    row.innerHTML = '<svg class="icon"><use></use></svg><strong></strong><span></span><small></small>';
    row.querySelector("use")!.setAttribute("href", `#i-${control.icon || "command"}`);
    row.querySelector("strong")!.textContent = control.title;
    row.querySelector("span")!.textContent = control.description || "";
    row.querySelector("small")!.textContent = control.meta || "";
    row.onclick = () => acceptControl(control);
    popoverEl.appendChild(row);
  }

  if (filtered.length > 0 || (skills && skills.length > 0)) {
    const heading = document.createElement("div");
    heading.className = "slash-section-title";
    heading.textContent = "技能";
    popoverEl.appendChild(heading);
  }

  for (const skill of filtered) {
    const row = document.createElement("button");
    row.className = "slash-row slash-row-skill";
    row.innerHTML = '<svg class="icon"><use href="#i-cube" /></svg><strong></strong><span></span><small></small>';
    row.querySelector("strong")!.textContent = skill.name;
    row.querySelector("span")!.textContent = skill.description || "";
    // `context: fork` skills are designed for one-shot subagent dispatch —
    // surface that in the picker (the SkillSummary field exists for this).
    const forkBadge = (skill as { context?: string }).context === "fork" ? " · fork" : "";
    row.querySelector("small")!.textContent = (skill.scope === "global" ? "个人" : "工作区") + forkBadge;
    row.onclick = () => acceptSkill(skill);
    popoverEl.appendChild(row);
  }
}

// Lazy-load the skill list on first skill-mode open (mirror legacy: refreshSkills
// kicks off, popover stays open and re-renders when state.skills lands).
function ensureSkillsLoaded(): void {
  const cwd = getMainState().workspaceCwd;
  if (!skillsLoaded && cwd && !skillFetchInFlight) {
    skillFetchInFlight = true;
    const revision = skillsRevision;
    void Promise.resolve(bridge().listSkills(cwd))
      .then((payload) => {
        if (revision !== skillsRevision) return;
        const list = (payload as { skills?: Skill[] } | null)?.skills;
        skillsCache = Array.isArray(list) ? list : [];
      })
      .catch(() => {
        if (revision === skillsRevision) skillsCache = [];
      })
      .finally(() => {
        if (revision === skillsRevision) skillsLoaded = true;
        skillFetchInFlight = false;
        // Re-render so an open `/skill` popover updates once skills arrive.
        render();
      });
  }
}

// render — mirror legacy renderSlashCommandPopover dispatch.
function render(): void {
  if (!popoverEl) return;
  const q = slashCommandQuery();
  if (!q) {
    hide();
    return;
  }
  if (q.mode === "skill") {
    ensureSkillsLoaded();
    renderSkillView(q.query, skillFetchInFlight ? "Loading skills…" : undefined);
    return;
  }
  renderSlashView(q.query);
}

// ── Keyboard navigation (mirror legacy actions/keymap.js) ──────────────────────

function slashRows(): HTMLButtonElement[] {
  if (!popoverEl) return [];
  return [...popoverEl.querySelectorAll<HTMLButtonElement>(".slash-row:not(:disabled)")];
}

function setActiveSlashRow(rows: HTMLButtonElement[], index: number): void {
  rows.forEach((row, i) => row.classList.toggle("active", i === index));
  rows[index]?.scrollIntoView({ block: "nearest" });
}

function moveActiveSlashRow(delta: number): boolean {
  const rows = slashRows();
  if (rows.length === 0) return false;
  const current = rows.findIndex((row) => row.classList.contains("active"));
  const next = current === -1 ? (delta > 0 ? 0 : rows.length - 1) : (current + delta + rows.length) % rows.length;
  setActiveSlashRow(rows, next);
  return true;
}

function acceptActiveSlashRow(): boolean {
  const rows = slashRows();
  if (rows.length === 0) return false;
  const active = rows.find((row) => row.classList.contains("active")) || rows[0];
  active.click();
  return true;
}

function handlePromptKeyDown(event: KeyboardEvent): void {
  if (!popoverEl) return;
  const open = !popoverEl.hidden;
  if (!open) return;
  // While the popover is open it OWNS these keys (legacy keymap.js authority).
  // We run in capture phase on the textarea, so stopPropagation() here prevents
  // the event from ever reaching the Composer's React onKeyDown (Enter→send,
  // Shift+Tab→cycle-mode) at the React root — without it, accepting a row with
  // Enter would ALSO send the message.
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    hide();
    return;
  }
  if (event.key === "Tab") {
    if (acceptActiveSlashRow()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    moveActiveSlashRow(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter") {
    if (acceptActiveSlashRow()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

function handlePromptInput(): void {
  render();
}

// ── React shell ────────────────────────────────────────────────────────────────

export function SlashPopover({ onEnterGoal }: { onEnterGoal: () => void }) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    popoverEl = popoverRef.current;
    promptEl = document.getElementById("prompt") as HTMLTextAreaElement | null;
    enterGoalComposer = onEnterGoal;
    if (promptEl) {
      // Capture phase so our nav intercepts Enter/Tab/Arrows BEFORE the
      // composer's own bubble-phase keydown (which sends on Enter). Mirrors the
      // legacy keymap.js prompt keydown, which is the authority while the
      // popover is open.
      promptEl.addEventListener("keydown", handlePromptKeyDown, true);
      promptEl.addEventListener("input", handlePromptInput);
    }
    // Initial paint in case the textarea already starts with "/".
    render();
    // Refresh an already-open picker after a save or workspace change, and
    // discard replies from a fetch that started before the invalidation.
    const offSkills = bridge().events.on("skills-changed", invalidateSkills);
    const offWsSkills = bridge().events.on("open-workspace", invalidateSkills);
    return () => {
      offSkills?.();
      offWsSkills?.();
      if (promptEl) {
        promptEl.removeEventListener("keydown", handlePromptKeyDown, true);
        promptEl.removeEventListener("input", handlePromptInput);
      }
      hide();
      popoverEl = null;
      promptEl = null;
      if (enterGoalComposer === onEnterGoal) enterGoalComposer = null;
    };
  }, [onEnterGoal]);

  // Owns the `#slash-popover` element (replaces Composer's stub). Content is
  // built imperatively to stay byte-identical to legacy.
  return <div className="slash-popover" id="slash-popover" hidden ref={popoverRef} />;
}
