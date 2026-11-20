import { useEffect, useState } from "react";
import { setViewSetting, useViewSettings } from "~/lib/viewSettings";
import { bridge } from "~/lib/bridge";
import { FieldRow, NumberField, Section, Select } from "~/components/ui";
import { useT } from "~/lib/i18n";

interface ShellEntry {
  command: string;
  label: string;
  available: boolean;
}

export function TerminalPanel() {
  const t = useT();
  const s = useViewSettings();
  const [shells, setShells] = useState<ShellEntry[]>([]);

  useEffect(() => {
    bridge()
      .listShells()
      .then((result) => {
        const list = Array.isArray(result) ? (result as ShellEntry[]) : [];
        setShells(list);
      })
      .catch(() => setShells([]));
  }, []);

  const shellOptions = [
    { value: "", label: t("terminal.autoPlatformDefault") },
    ...shells.map((sh) => ({
      value: sh.command,
      label: sh.available ? sh.label : t("terminal.shellNotInstalled", { label: sh.label }),
    })),
  ];

  return (
    <div className="pane-enter">
      <Section title={t("terminal.terminal")}>
        <FieldRow
          label={t("terminal.defaultShell")}
          hint={t("terminal.defaultShellHint")}
        >
          <Select
            value={s.terminalShell}
            options={shellOptions}
            onChange={(v) => void setViewSetting("terminalShell", v)}
          />
        </FieldRow>
        <FieldRow label={t("terminal.defaultColumns")} hint={t("terminal.defaultColumnsHint")}>
          <NumberField
            value={s.terminalCols}
            min={40}
            max={400}
            step={1}
            onChange={(v) => void setViewSetting("terminalCols", v)}
          />
        </FieldRow>
        <FieldRow label={t("terminal.defaultRows")} hint={t("terminal.defaultRowsHint")}>
          <NumberField
            value={s.terminalRows}
            min={10}
            max={120}
            step={1}
            onChange={(v) => void setViewSetting("terminalRows", v)}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
