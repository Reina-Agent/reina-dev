import { useCallback, useEffect, useState } from "react";
import { setViewSetting, useViewSettings } from "~/lib/viewSettings";
import { useT } from "~/lib/i18n";
import { bridge } from "~/lib/bridge";
import { Button, FieldRow, Section, Select, Toggle } from "~/components/ui";

// ── Composer (prompt-input) prefs ──────────────────────────────────────────
// Legacy parity: the chat composer toggles persist to the `desktop-settings`
// store under key `settings`, as `{ promptInput: { ... } }`. The main chat
// window reads this exact shape (renderer.js loadLocalSettings → applyLocalSettings)
// and merges it over getDesktopConfig().promptInput, so writing the same store
// here keeps both renderers in sync. Defaults mirror config.js defaultDesktopConfig.
const DESKTOP_SETTINGS_STORE = { name: "desktop-settings", key: "settings" };

interface PromptInputPrefs {
  enterToSend: boolean;
  enableSlashCommands: boolean;
  enableFileMentions: boolean;
  enableSelectionActions: boolean;
}

const PROMPT_INPUT_DEFAULTS: PromptInputPrefs = {
  enterToSend: true,
  enableSlashCommands: true,
  enableFileMentions: true,
  enableSelectionActions: true,
};

export function GeneralPanel() {
  const s = useViewSettings();
  const t = useT();

  // ── Composer prefs (loaded from desktop-settings store) ──────────────────
  const [promptInput, setPromptInput] = useState<PromptInputPrefs>(PROMPT_INPUT_DEFAULTS);
  // Hold the full persisted settings object so we never drop sibling keys
  // (diffMode and anything else the legacy renderer stores alongside promptInput).
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>({});

  // ── Open-folder action status ────────────────────────────────────────────
  const [opening, setOpening] = useState(false);
  const [openStatus, setOpenStatus] = useState("");

  // Load the persisted composer prefs once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await bridge().storeGet(DESKTOP_SETTINGS_STORE.name, DESKTOP_SETTINGS_STORE.key);
        if (cancelled) return;
        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const stored = (parsed.promptInput ?? {}) as Partial<PromptInputPrefs>;
        setLocalSettings(parsed);
        setPromptInput({
          enterToSend: stored.enterToSend ?? PROMPT_INPUT_DEFAULTS.enterToSend,
          enableSlashCommands: stored.enableSlashCommands ?? PROMPT_INPUT_DEFAULTS.enableSlashCommands,
          enableFileMentions: stored.enableFileMentions ?? PROMPT_INPUT_DEFAULTS.enableFileMentions,
          enableSelectionActions: stored.enableSelectionActions ?? PROMPT_INPUT_DEFAULTS.enableSelectionActions,
        });
      } catch {
        // Best-effort: fall back to defaults already in state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist a single composer toggle, merging over the full stored object so
  // sibling keys survive (matches legacy updatePromptSetting → saveLocalSettings).
  const updatePromptSetting = useCallback(
    async (key: keyof PromptInputPrefs, value: boolean) => {
      const nextPrompt = { ...promptInput, [key]: value };
      setPromptInput(nextPrompt);
      const existingPrompt = (localSettings.promptInput ?? {}) as Record<string, unknown>;
      const nextSettings = { ...localSettings, promptInput: { ...existingPrompt, [key]: value } };
      setLocalSettings(nextSettings);
      try {
        await bridge().storeSet(
          DESKTOP_SETTINGS_STORE.name,
          DESKTOP_SETTINGS_STORE.key,
          JSON.stringify(nextSettings),
        );
      } catch {
        // Best-effort persistence; UI state already updated.
      }
    },
    [promptInput, localSettings],
  );

  function handleReload() {
    void bridge().reloadRenderer();
  }

  // Open another folder as the active workspace. Mirrors the React Welcome
  // switchWorkspace flow (touch the SessionStore, tell the engine to open the
  // workspace, then drive the main chat window to follow). The settings window
  // is an aux window with no main store, so there is no local state refresh.
  const handleOpenWorkspace = useCallback(async () => {
    setOpenStatus("");
    let picked: string | null = null;
    try {
      picked = await bridge().openDirectoryPicker({ title: t("general.openPickerTitle") });
    } catch {
      picked = null;
    }
    if (!picked) return;
    setOpening(true);
    try {
      await bridge().touchWorkspace(picked).catch(() => undefined);
      await bridge().invoke("open_workspace", { cwd: picked }).catch(() => undefined);
      await bridge().openWorkspaceInMain(picked).catch(() => undefined);
      setOpenStatus(t("general.openedInChat"));
    } catch (err: unknown) {
      setOpenStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [t]);

  return (
    <div className="pane-enter">
      <Section title={t("general.application")}>
        <FieldRow label={t("general.language")} hint={t("general.languageDesc")}>
          <Select
            value={s.language}
            options={[
              { value: "en", label: "English" },
              { value: "zh", label: "中文" },
            ]}
            onChange={(v) => void setViewSetting("language", v as typeof s.language)}
          />
        </FieldRow>
        <FieldRow label={t("general.closeAction")} hint={t("general.closeActionDesc")}>
          <Select
            value={s.closeAction}
            options={[
              { value: "ask", label: t("general.closeActionAsk") },
              { value: "tray", label: t("general.closeActionTray") },
              { value: "quit", label: t("general.closeActionQuit") },
            ]}
            onChange={(v) => void setViewSetting("closeAction", v as typeof s.closeAction)}
          />
        </FieldRow>
        <FieldRow label={t("general.reload")} hint={t("general.reloadDesc")}>
          <Button variant="accent" onClick={handleReload}>
            {t("general.reloadButton")}
          </Button>
        </FieldRow>
      </Section>

      <Section title={t("general.workspace")} description={t("general.workspaceDesc")}>
        <FieldRow label={t("general.openFolder")} hint={t("general.openFolderDesc")}>
          <div className="flex items-center gap-3">
            {openStatus && <span className="text-xs text-muted-foreground">{openStatus}</span>}
            <Button onClick={() => void handleOpenWorkspace()} disabled={opening}>
              {opening ? t("general.openingButton") : t("general.openFolderButton")}
            </Button>
          </div>
        </FieldRow>
      </Section>

      <Section title={t("general.composer")} description={t("general.composerDesc")}>
        <FieldRow label={t("general.enterToSend")} hint={t("general.enterToSendDesc")}>
          <Toggle
            checked={promptInput.enterToSend}
            onChange={(v) => void updatePromptSetting("enterToSend", v)}
          />
        </FieldRow>
        <FieldRow label={t("general.slashCommands")} hint={t("general.slashCommandsDesc")}>
          <Toggle
            checked={promptInput.enableSlashCommands}
            onChange={(v) => void updatePromptSetting("enableSlashCommands", v)}
          />
        </FieldRow>
        <FieldRow label={t("general.fileMentions")} hint={t("general.fileMentionsDesc")}>
          <Toggle
            checked={promptInput.enableFileMentions}
            onChange={(v) => void updatePromptSetting("enableFileMentions", v)}
          />
        </FieldRow>
        <FieldRow label={t("general.selectionActions")} hint={t("general.selectionActionsDesc")}>
          <Toggle
            checked={promptInput.enableSelectionActions}
            onChange={(v) => void updatePromptSetting("enableSelectionActions", v)}
          />
        </FieldRow>
      </Section>

      <Section title={t("general.notifications")}>
        <FieldRow label={t("general.systemNotifications")} hint={t("general.systemNotificationsDesc")}>
          <Toggle
            checked={s.notifySystem}
            onChange={(v) => void setViewSetting("notifySystem", v)}
          />
        </FieldRow>
        <FieldRow label={t("general.warningToasts")} hint={t("general.warningToastsDesc")}>
          <Toggle
            checked={s.notifyWarnings}
            onChange={(v) => void setViewSetting("notifyWarnings", v)}
          />
        </FieldRow>
        <FieldRow label={t("general.completionSound")} hint={t("general.completionSoundDesc")}>
          <Toggle
            checked={s.notifySound}
            onChange={(v) => void setViewSetting("notifySound", v)}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
