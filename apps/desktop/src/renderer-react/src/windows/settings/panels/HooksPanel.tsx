import { useCallback, useEffect, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT } from "~/lib/i18n";
import { Button, Section, TextArea } from "~/components/ui";

type HooksScope = "workspace" | "global";

type StatusLevel = "info" | "success" | "error";

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

const EXAMPLE_HOOKS = {
  preToolUse: [
    { matcher: "run_shell", command: "node ./.reina/hooks/pre-shell.js", timeoutMs: 4000 },
  ],
  userPromptSubmit: [
    { command: "node ./.reina/hooks/log-prompt.js" },
  ],
  onStop: [
    { command: 'powershell -Command "[console]::beep(800,150)"' },
  ],
};

const SUPPORTED_EVENTS = [
  { name: "preToolUse", descKey: "hooks.eventPreToolUse" },
  { name: "postToolUse", descKey: "hooks.eventPostToolUse" },
  { name: "userPromptSubmit", descKey: "hooks.eventUserPromptSubmit" },
  { name: "onStop", descKey: "hooks.eventOnStop" },
  { name: "sessionStart", descKey: "hooks.eventSessionStart" },
  { name: "sessionEnd", descKey: "hooks.eventSessionEnd" },
  { name: "preCompact", descKey: "hooks.eventPreCompact" },
];

interface EngineConfigPayload {
  workspace?: Record<string, unknown>;
  global?: Record<string, unknown>;
  workspacePath?: string;
  globalPath?: string;
}

export function HooksPanel() {
  const t = useT();
  const [scope, setScope] = useState<HooksScope>("workspace");
  const [editorValue, setEditorValue] = useState("{}");
  const [configPath, setConfigPath] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusLevel, setStatusLevel] = useState<StatusLevel>("info");

  // Cached full engineConfig payload — we need it when saving to merge with
  // the existing scope config (same pattern as legacy saveHooks).
  const [engineConfig, setEngineConfig] = useState<EngineConfigPayload | null>(null);

  const fillFromConfig = useCallback(
    (config: EngineConfigPayload, activeScope: HooksScope) => {
      const scopeData = config[activeScope] as Record<string, unknown> | undefined;
      const hooks = (scopeData?.hooks ?? {}) as Record<string, unknown>;
      setEditorValue(JSON.stringify(hooks, null, 2));
      setConfigPath(
        activeScope === "workspace"
          ? (config.workspacePath ?? "")
          : (config.globalPath ?? ""),
      );
      setDirty(false);
      setStatus("");
    },
    [],
  );

  const loadConfig = useCallback(
    async (activeScope: HooksScope) => {
      const cwd = await getWorkspaceCwd();
      try {
        // Pass "" when no workspace is open: the IPC layer falls back to
        // defaultCwd so the GLOBAL config still loads (its section is in the
        // payload regardless of cwd). Bailing here left the editor showing "{}",
        // which a subsequent global save would then write OVER the real global
        // hooks — silent data loss.
        const payload = (await bridge().readEngineConfig(cwd || "")) as EngineConfigPayload;
        setEngineConfig(payload);
        fillFromConfig(payload, activeScope);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(msg);
        setStatusLevel("error");
      }
    },
    [fillFromConfig],
  );

  useEffect(() => {
    void loadConfig(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScopeSwitch = (next: HooksScope) => {
    if (dirty) {
      if (!window.confirm(t("hooks.discardConfirm"))) return;
    }
    setScope(next);
    // Re-fill from cached config if available, otherwise fetch.
    if (engineConfig) {
      fillFromConfig(engineConfig, next);
    } else {
      void loadConfig(next);
    }
  };

  const handleEditorChange = (value: string) => {
    setEditorValue(value);
    setDirty(true);
    setStatus("");
  };

  const handleInsertExample = () => {
    if (editorValue.trim() && !window.confirm(t("hooks.overwriteConfirm"))) return;
    setEditorValue(JSON.stringify(EXAMPLE_HOOKS, null, 2));
    setDirty(true);
    setStatus("");
  };

  const handleSave = async () => {
    const cwd = await getWorkspaceCwd();
    // Only a workspace-scoped save needs a workspace; global hooks live at
    // $REINA_HOME and the IPC layer falls back to defaultCwd for an empty cwd.
    if (scope === "workspace" && !cwd) {
      setStatus(t("hooks.openWorkspaceFirst"));
      setStatusLevel("error");
      return;
    }
    let parsed: unknown;
    try {
      parsed = editorValue.trim() === "" ? {} : JSON.parse(editorValue);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(t("hooks.invalidJson", { msg }));
      setStatusLevel("error");
      return;
    }
    setSaving(true);
    try {
      const current = (engineConfig?.[scope] ?? {}) as Record<string, unknown>;
      const next = { ...current, hooks: parsed };
      await bridge().writeEngineConfig(cwd || "", scope, next);
      setDirty(false);
      setStatus(t("hooks.savedToScope", { scope }));
      setStatusLevel("success");
      // Reload to update cached config + path display.
      await loadConfig(scope);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg);
      setStatusLevel("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pane-enter">
      <Section
        title={t("hooks.title")}
        description={t("hooks.description")}
      >
        {/* Scope tab strip */}
        <div className="flex gap-1 border-b px-3 pt-2">
          {(["workspace", "global"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleScopeSwitch(s)}
              className={
                "rounded-t-md px-3 py-1.5 text-[12.5px] transition-colors duration-(--motion-fast) " +
                (scope === s
                  ? "border border-b-card bg-card text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {s === "workspace" ? t("hooks.scopeWorkspace") : t("hooks.scopeGlobal")}
            </button>
          ))}
        </div>

        {/* Path + hint */}
        <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono truncate">{configPath}</span>
          <span className="shrink-0">{t("hooks.editsHint")}</span>
        </div>

        {/* JSON editor */}
        <div className="px-3 pb-1">
          <TextArea
            value={editorValue}
            placeholder={'{"preToolUse": [{"matcher": "run_shell", "command": "echo blocking; exit 2"}]}'}
            onChange={handleEditorChange}
            rows={14}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-3 pb-3">
          <Button variant="accent" onClick={() => void handleSave()} disabled={!dirty || saving}>
            {t("hooks.save")}
          </Button>
          <Button onClick={handleInsertExample}>
            {t("hooks.insertExample")}
          </Button>
          {status && (
            <span className={`text-[12px] ${statusColor(statusLevel)}`}>{status}</span>
          )}
        </div>
      </Section>

      {/* Supported events reference */}
      <Section title={t("hooks.supportedEvents")}>
        {SUPPORTED_EVENTS.map((ev) => (
          <div key={ev.name} className="flex items-baseline gap-3 px-4 py-2.5">
            <code className="shrink-0 font-mono text-[12.5px]">{ev.name}</code>
            <span className="text-[12.5px] text-muted-foreground">{t(ev.descKey)}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
