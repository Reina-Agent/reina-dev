// Composer input prefs (mirror legacy state.desktopConfig.promptInput). The
// settings window's GeneralPanel persists these toggles into the
// `desktop-settings` store under key `settings` as `{ promptInput: {...} }`, but
// the React chat window never read them back — so "回车发送", "启用斜杠命令" and
// "启用 @ 文件" were silently dead in chat. This tiny module loads the prefs once
// (and re-reads on settings changes and window focus) and exposes them synchronously to the
// Composer (Enter-to-send + @-mention gating) and SlashPopover (slash gating).

import { bridge } from "~/lib/bridge";

export interface PromptPrefs {
  enterToSend: boolean;
  enableSlashCommands: boolean;
  enableFileMentions: boolean;
  enableSelectionActions: boolean;
}

// Defaults match GeneralPanel's PROMPT_INPUT_DEFAULTS (all on).
const DEFAULTS: PromptPrefs = {
  enterToSend: true,
  enableSlashCommands: true,
  enableFileMentions: true,
  enableSelectionActions: true,
};

const STORE = { name: "desktop-settings", key: "settings" } as const;

let prefs: PromptPrefs = { ...DEFAULTS };
const listeners = new Set<() => void>();

export function getPromptPrefs(): PromptPrefs {
  return prefs;
}

export function subscribePromptPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadPromptPrefs(): Promise<void> {
  try {
    const raw = await bridge().storeGet(STORE.name, STORE.key);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const stored = (parsed.promptInput ?? {}) as Partial<PromptPrefs>;
    const next: PromptPrefs = {
      enterToSend: stored.enterToSend ?? DEFAULTS.enterToSend,
      enableSlashCommands: stored.enableSlashCommands ?? DEFAULTS.enableSlashCommands,
      enableFileMentions: stored.enableFileMentions ?? DEFAULTS.enableFileMentions,
      enableSelectionActions: stored.enableSelectionActions ?? DEFAULTS.enableSelectionActions,
    };
    const changed =
      next.enterToSend !== prefs.enterToSend ||
      next.enableSlashCommands !== prefs.enableSlashCommands ||
      next.enableFileMentions !== prefs.enableFileMentions ||
      next.enableSelectionActions !== prefs.enableSelectionActions;
    prefs = next;
    if (changed) for (const fn of listeners) fn();
  } catch {
    // Best-effort: keep whatever we have (defaults on first load).
  }
}

let started = false;

/** Load once + re-read on settings changes/focus. Safe to call from mount effects. */
export function initPromptPrefs(): void {
  if (started) return;
  started = true;
  void loadPromptPrefs();
  bridge().events.on("desktop-settings-changed", () => void loadPromptPrefs());
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => void loadPromptPrefs());
  }
}
