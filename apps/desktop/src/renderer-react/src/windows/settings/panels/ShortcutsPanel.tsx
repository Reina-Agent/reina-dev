import { Section } from "~/components/ui";
import { useT } from "~/lib/i18n";
import { displayKeybind } from "~/lib/keybinds";

// Shortcut reference list. The legacy settings panel (settings.html,
// data-settings-panel="shortcuts") is a static read-only list with no
// rebinding support. keymap.js confirms the same bindings. This panel
// mirrors that list exactly.

interface ShortcutEntry {
  labelKey: string;
  keys: string[];
}

const SHORTCUTS: ShortcutEntry[] = [
  { labelKey: "shortcuts.commandPalette", keys: ["Ctrl+K"] },
  { labelKey: "shortcuts.openFile", keys: ["Ctrl+P"] },
  { labelKey: "shortcuts.newSession", keys: ["Ctrl+Shift+S"] },
  { labelKey: "shortcuts.interruptTurn", keys: ["Esc"] },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 items-center rounded border border-border bg-secondary px-1.5 font-mono text-[11px] text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsPanel() {
  const t = useT();
  return (
    <div className="pane-enter">
      <Section title={t("shortcuts.title")}>
        {SHORTCUTS.map((entry) => (
          <div
            key={entry.labelKey}
            className="flex items-center justify-between gap-4 px-4 py-2.5"
          >
            <div className="text-[13px]">{t(entry.labelKey)}</div>
            <div className="flex shrink-0 items-center gap-1">
              {entry.keys.map((k) => (
                <Kbd key={k}>{displayKeybind(k)}</Kbd>
              ))}
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
