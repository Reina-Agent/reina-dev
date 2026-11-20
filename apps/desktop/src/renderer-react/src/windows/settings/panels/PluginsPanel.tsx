import { useT } from "~/lib/i18n";
import { Button, FieldRow, Section } from "~/components/ui";

export function PluginsPanel() {
  const t = useT();
  return (
    <div className="pane-enter">
      <Section title={t("plugins.title")}>
        <FieldRow
          label={t("plugins.marketplaceLabel")}
          hint={t("plugins.marketplaceHint")}
        >
          <Button onClick={() => undefined} disabled>
            {t("plugins.browse")}
          </Button>
        </FieldRow>
      </Section>
    </div>
  );
}
