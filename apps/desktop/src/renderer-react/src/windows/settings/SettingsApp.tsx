import { useEffect, useState } from "react";
import { TitleBar } from "~/components/TitleBar";
import { ResizeHandle } from "~/components/ResizeHandle";
import { useResizableSidebar } from "~/lib/useResizableSidebar";
import { useT } from "~/lib/i18n";
import { bridge } from "~/lib/bridge";
import { loadViewSettings, subscribeViewSettingsBroadcast } from "~/lib/viewSettings";
import { AppearancePanel } from "~/windows/settings/panels/AppearancePanel";
import { ThemesPanel } from "~/windows/settings/panels/ThemesPanel";
import { GeneralPanel } from "~/windows/settings/panels/GeneralPanel";
import { TerminalPanel } from "~/windows/settings/panels/TerminalPanel";
import { CompactionPanel } from "~/windows/settings/panels/CompactionPanel";
import { SelfEvolvePanel } from "~/windows/settings/panels/SelfEvolvePanel";
import { RulesPanel } from "~/windows/settings/panels/RulesPanel";
import { SkillsPanel } from "~/windows/settings/panels/SkillsPanel";
import { HooksPanel } from "~/windows/settings/panels/HooksPanel";
import { ModelsPanel } from "~/windows/settings/panels/ModelsPanel";
import { SubscriptionsPanel } from "~/windows/settings/panels/SubscriptionsPanel";
import { AgentsPanel } from "~/windows/settings/panels/AgentsPanel";
import { ShortcutsPanel } from "~/windows/settings/panels/ShortcutsPanel";
import { ToolsMcpPanel } from "~/windows/settings/panels/ToolsMcpPanel";
import { PermissionsPanel } from "~/windows/settings/panels/PermissionsPanel";
import { PluginsPanel } from "~/windows/settings/panels/PluginsPanel";
import { AboutPanel } from "~/windows/settings/panels/AboutPanel";

// Related settings stay together; app information is the final group.
const PANELS = [
  { id: "general", labelKey: "settings.nav.general", icon: "settings", group: "general" },
  { id: "appearance", labelKey: "settings.nav.appearance", icon: "layout", group: "general" },
  { id: "themes", labelKey: "settings.nav.themes", icon: "palette", group: "general" },
  { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: "keyboard", group: "general" },
  { id: "terminal", labelKey: "settings.nav.terminal", icon: "terminal", group: "general" },
  { id: "models", labelKey: "settings.nav.models", icon: "cube", group: "intelligence" },
  { id: "subscriptions", labelKey: "settings.nav.subscriptions", icon: "card", group: "intelligence" },
  { id: "agents", labelKey: "settings.nav.agents", icon: "bot", group: "intelligence" },
  { id: "rules", labelKey: "settings.nav.rules", icon: "book", group: "intelligence" },
  { id: "permissions", labelKey: "settings.nav.permissions", icon: "shield", group: "intelligence" },
  { id: "compaction", labelKey: "settings.nav.compaction", icon: "archive", group: "intelligence" },
  { id: "self-evolve", labelKey: "settings.nav.selfEvolve", icon: "brain", group: "intelligence" },
  { id: "tools", labelKey: "settings.nav.tools", icon: "wrench", group: "extend" },
  { id: "skills", labelKey: "settings.nav.skills", icon: "sparkles", group: "extend" },
  { id: "hooks", labelKey: "settings.nav.hooks", icon: "webhook", group: "extend" },
  { id: "plugins", labelKey: "settings.nav.plugins", icon: "puzzle", group: "extend" },
  { id: "about", labelKey: "settings.nav.about", icon: "info", group: "app" },
] as const;

type PanelId = (typeof PANELS)[number]["id"];

// Sidebar grouping: render order only. Groups are separated by whitespace (no
// text headers); panels keep their declared order within a group.
const NAV_GROUPS = [
  { id: "general" },
  { id: "intelligence" },
  { id: "extend" },
  { id: "app" },
] as const;

const PANEL_VIEWS: Partial<Record<PanelId, React.ComponentType>> = {
  general: GeneralPanel,
  appearance: AppearancePanel,
  themes: ThemesPanel,
  models: ModelsPanel,
  agents: AgentsPanel,
  "self-evolve": SelfEvolvePanel,
  subscriptions: SubscriptionsPanel,
  plugins: PluginsPanel,
  rules: RulesPanel,
  skills: SkillsPanel,
  tools: ToolsMcpPanel,
  hooks: HooksPanel,
  compaction: CompactionPanel,
  permissions: PermissionsPanel,
  shortcuts: ShortcutsPanel,
  terminal: TerminalPanel,
  about: AboutPanel,
};

function resolvePanel(requested: string | null): PanelId | undefined {
  const id = requested === "updates" ? "about" : requested;
  return PANELS.find((panel) => panel.id === id)?.id;
}

function initialPanel(): PanelId {
  const requested = new URLSearchParams(location.search).get("panel");
  return resolvePanel(requested) ?? "general";
}

export function SettingsApp() {
  const [panel, setPanel] = useState<PanelId>(initialPanel);
  const [ready, setReady] = useState(false);
  const nav = useResizableSidebar({
    storageKey: "reina.settings.navWidth",
    defaultWidth: 208,
    minWidth: 160,
    maxWidth: 360,
  });
  const t = useT();

  useEffect(() => {
    void loadViewSettings().finally(() => setReady(true));
    return subscribeViewSettingsBroadcast();
  }, []);

  useEffect(() => bridge().events.on("open-settings-panel", (payload) => {
    const requested = typeof payload === "string" ? resolvePanel(payload) : undefined;
    if (requested) setPanel(requested);
  }), []);

  const View = PANEL_VIEWS[panel];
  // Tools + Models are full-bleed: they own a master-detail browser that should
  // fill the whole content area (legacy `data-settings-panel` had max-width:none
  // + height:100%), not sit inside the centered max-w-2xl column.
  const fullBleed = panel === "tools" || panel === "models";
  const content = !ready ? null : View ? <View /> : <PanelPlaceholder panel={panel} />;

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar
        title={t("settings.title")}
        leading={
          <button
            type="button"
            title={nav.collapsed ? "Show sidebar" : "Hide sidebar"}
            aria-label={nav.collapsed ? "Show sidebar" : "Hide sidebar"}
            onClick={nav.toggleCollapsed}
            className={
              "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-fast) " +
              (nav.collapsed
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
            }
          >
            <PanelToggleIcon />
          </button>
        }
      />
      <div className="flex min-h-0 flex-1">
        {!nav.collapsed && (
          <>
            <nav
              style={{ width: nav.width }}
              className="flex shrink-0 flex-col gap-0.5 overflow-y-auto p-2"
            >
              {NAV_GROUPS.map((g, gi) => (
                <div key={g.id} className={gi > 0 ? "mt-4" : ""}>
                  {PANELS.filter((p) => p.group === g.id).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPanel(p.id)}
                      aria-current={panel === p.id ? "page" : undefined}
                      className={
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors duration-(--motion-fast) " +
                        (panel === p.id
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                      }
                    >
                      <NavIcon name={p.icon} />
                      <span className="min-w-0 flex-1 truncate">{t(p.labelKey)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <ResizeHandle onPointerDown={nav.startResize} active={nav.resizing} ariaLabel="Resize navigation sidebar" />
          </>
        )}
        <main
          className={
            "min-w-0 flex-1 " +
            (fullBleed ? "flex flex-col overflow-hidden" : "overflow-y-auto p-6")
          }
        >
          {fullBleed ? content : <div className="mx-auto max-w-2xl">{content}</div>}
        </main>
      </div>
    </div>
  );
}

// Lucide-style nav glyphs (stroke-only, inherit currentColor), keyed by the
// `icon` field on each PANELS entry. Mirrors the legacy renderer icon set.
const NAV_ICONS: Record<string, React.ReactNode> = {
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.51 1z" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" x2="21" y1="9" y2="9" />
    </>
  ),
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  palette: (
    <>
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </>
  ),
  cube: (
    <>
      <path d="m12.83 2.18 9 5.19a1 1 0 0 1 .5.87v8.69a1 1 0 0 1-.5.87l-9 5.18a1 1 0 0 1-1 0l-9-5.18a1 1 0 0 1-.5-.87V8.24a1 1 0 0 1 .5-.87l9-5.19a1 1 0 0 1 1 0z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  bot: (
    <>
      <rect x="3" y="8" width="18" height="13" rx="2" />
      <path d="M12 3v5" />
      <circle cx="9" cy="14" r="1" />
      <circle cx="15" cy="14" r="1" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5a3 3 0 0 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 0 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </>
  ),
  puzzle: (
    <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />
  ),
  book: <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />,
  sparkles: (
    <>
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  webhook: (
    <>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M6 10h.01" />
      <path d="M10 10h.01" />
      <path d="M14 10h.01" />
      <path d="M18 10h.01" />
      <path d="M6 14h.01" />
      <path d="M18 14h.01" />
      <path d="M8 17h8" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
};

function NavIcon({ name }: { name: string }) {
  const glyph = NAV_ICONS[name];
  if (!glyph) return null;
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      {glyph}
    </svg>
  );
}

// Sidebar collapse glyph (panel-left): a framed rect with a divider rail.
function PanelToggleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function PanelPlaceholder({ panel }: { panel: PanelId }) {
  const t = useT();
  const labelKey = PANELS.find((p) => p.id === panel)?.labelKey;
  return (
    <div className="pane-enter">
      <h1 className="text-base font-semibold">{labelKey ? t(labelKey) : panel}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("settings.notPorted.body")}</p>
    </div>
  );
}
