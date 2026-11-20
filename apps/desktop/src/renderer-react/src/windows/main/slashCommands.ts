// Slash-command registry for the React main chat composer. This is the
// self-contained mirror of the legacy command list that the plain-JS renderer
// keeps on `state.commands` (built in renderer/actions/commands.js via
// buildBaseCommands). The React main renderer has NO global command registry —
// the legacy `runCommandInMain` IPC only reaches a legacy renderer's
// menu-command listener, which does not exist in React mode — so the slash
// popover ships its own static list of the same slash commands.
//
// IMPORTANT — only the fields the slash popover VIEW reads are reproduced here:
//   slash    — the "/foo" token (the only thing the popover shows + filters on
//              besides title/category)
//   title    — human description (middle column)
//   category — the right-hand <small> tag (and the icon lookup in skill mode)
//   keybind  — the control row's <small> meta in skill mode (mirror of legacy
//              `command.keybind`)
//   disabled — live predicate; greys the row out (mirror of legacy
//              `command.disabled?.()`)
//
// The `run` side of legacy commands is intentionally NOT reproduced: most rows
// only PRIME the composer (`promptEl.value = "/foo "`) and execute later, on
// send, through `runSlashCommand`. Goal is the deliberate exception: selecting
// `/goal` opens the dedicated Goal composer immediately. (See
// resolveSlashCommandAcceptance and SlashPopover's accept handlers.)

import { getMainState } from "./sessionStore";

export interface SlashCommand {
  slash: string;
  title: string;
  category: string;
  keybind?: string;
  /** Live predicate — mirrors legacy `command.disabled?.()`. */
  disabled?: () => boolean;
}

export type SlashCommandAcceptance =
  | { kind: "composer"; mode: "goal" }
  | { kind: "prompt"; value: string };

/** Resolve what selecting a slash row does. Typing `/goal <objective>` and
 * sending remains supported; only accepting the bare launcher row enters the
 * dedicated Goal composer immediately. */
export function resolveSlashCommandAcceptance(slash: string): SlashCommandAcceptance {
  if (slash.toLowerCase() === "/goal") return { kind: "composer", mode: "goal" };
  return { kind: "prompt", value: `${slash} ` };
}

// Live flags the legacy `disabled` predicates read off `state`. The React main
// store exposes the same concepts under different names; map them here so the
// predicates below stay one-to-one with legacy.
function flags(): { working: boolean; stopping: boolean; sessionId: boolean; workspaceCwd: boolean; pendingHitl: boolean } {
  const s = getMainState();
  return {
    working: s.working === true,
    stopping: s.stopping === true,
    sessionId: Boolean(s.sessionId),
    workspaceCwd: Boolean(s.workspaceCwd),
    pendingHitl: s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0,
  };
}

// The base slash commands, ported field-for-field from legacy
// renderer/actions/commands.js buildBaseCommands (only the entries that carry a
// `slash` token — bare command-palette-only entries never appear in the slash
// popover, exactly as in legacy where the view filters `command.slash`).
export const SLASH_COMMANDS: SlashCommand[] = [
  { slash: "/commands", title: "Open command palette", category: "General", keybind: "Ctrl+K" },
  {
    slash: "/new",
    title: "New session",
    category: "Session",
    keybind: "Ctrl+Shift+S",
    disabled: () => !flags().workspaceCwd,
  },
  {
    slash: "/open",
    title: "Open workspace",
    category: "Workspace",
    keybind: "Ctrl+O",
    disabled: () => flags().working,
  },
  // NOTE: legacy's "/refresh" (refresh workspace panels) is intentionally absent.
  // The React chat window has no file-tree / git panels — those live in the
  // separate Workspace window, which has its own refresh controls — so there is
  // nothing here to refresh.
  {
    slash: "/team",
    title: "Team mode: dispatch task with DAG coordination",
    category: "Agent",
    disabled: () => flags().working || flags().pendingHitl || !flags().sessionId,
  },
  {
    slash: "/goal",
    title: "Goal: anchor an objective with TodoWrite + pinned note + verify",
    category: "Agent",
    disabled: () => flags().working || flags().pendingHitl || !flags().sessionId,
  },
  {
    slash: "/plan",
    title: "Plan mode: explore read-only and propose a plan before editing",
    category: "Agent",
    disabled: () => flags().working || flags().pendingHitl,
  },
  {
    slash: "/verify",
    title: "Verify: pause and check the last claim with evidence",
    category: "Agent",
    disabled: () => flags().working || flags().pendingHitl || !flags().sessionId,
  },
  {
    slash: "/cancel",
    title: "Cancel: gracefully wind down autopilot + async tasks + phase",
    category: "Agent",
    disabled: () => flags().working || flags().pendingHitl || !flags().sessionId,
  },
  {
    slash: "/interrupt",
    title: "Interrupt current turn",
    category: "Session",
    keybind: "Esc",
    disabled: () => !flags().working || flags().stopping || !flags().sessionId,
  },
  {
    slash: "/approval",
    title: "Toggle approval dock",
    category: "Session",
    disabled: () => !flags().pendingHitl,
  },
  { slash: "/logs", title: "Open desktop log", category: "Help" },
  {
    slash: "/init",
    title: "Generate CLAUDE.md / AGENTS.md scaffolding",
    category: "Rules",
    disabled: () => !flags().workspaceCwd,
  },
  { slash: "/rules", title: "Edit project rules (CLAUDE.md / AGENTS.md / memory)", category: "Rules" },
  { slash: "/mode", title: "Cycle permission mode (Shift+Tab)", category: "Agent" },
  {
    slash: "/clear",
    title: "Clear current session (start fresh)",
    category: "Session",
    disabled: () => flags().working,
  },
  {
    slash: "/compact",
    title: "Compact conversation history",
    category: "Session",
    disabled: () => flags().working || !flags().sessionId,
  },
  { slash: "/settings", title: "Open settings", category: "General" },
  { slash: "/model", title: "Open settings → Models", category: "General" },
  { slash: "/agents", title: "Open settings → Agents", category: "General" },
  { slash: "/permissions", title: "Open settings → Permissions", category: "General" },
  { slash: "/output-style", title: "Open settings → Output Style", category: "General" },
  {
    // /skill is special-cased by the slash popover — it stays open past the
    // trailing space and switches to the skill-picker view (see SlashPopover
    // slashCommandQuery skill-mode branch).
    slash: "/skill",
    title: "Pick a skill (workspace + global)",
    category: "Skills",
    disabled: () => !flags().workspaceCwd,
  },
];

// Category → glyph for the command rows in the `/` launcher (skill-mode control
// rows). Ported verbatim from legacy actions/prompt.js COMMAND_ICONS.
export const COMMAND_ICONS: Record<string, string> = {
  General: "command",
  Session: "refresh",
  Workspace: "folder",
  Files: "file",
  Composer: "send",
  Agent: "bot",
  Rules: "edit",
  Prompts: "sparkles",
  View: "sun",
  Help: "book",
};
