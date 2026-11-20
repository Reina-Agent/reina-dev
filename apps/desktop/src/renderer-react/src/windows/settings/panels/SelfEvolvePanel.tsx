import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { Button, FieldRow, NumberField, Section, TextArea, Toggle } from "~/components/ui";
import { useT } from "~/lib/i18n";

// Self-evolve (Hermes-style learning loop) settings. Everything here is GLOBAL
// config in reina.json — the loop is cross-project — so writes go to the
// "global" scope and never need an open workspace. Existing sessions reload
// changes at the next request boundary.

interface EngineConfigPayload {
  globalPath?: string;
  global?: Record<string, unknown>;
  effective?: Record<string, unknown>;
}

interface SelfEvolveConfig {
  enabled?: boolean;
  everyTurns?: number;
  notify?: boolean;
}

interface MemoryDreamConfig {
  dream?: boolean;
  cooldownHours?: number;
  minSessions?: number;
  idleHours?: number;
}

const DREAM_DEFAULTS = { cooldownHours: 72, minSessions: 10, idleHours: 6 } as const;

interface DirectiveData {
  path: string;
  content: string;
  exists: boolean;
}

const DEFAULT_EVERY_TURNS = 5;

export function SelfEvolvePanel() {
  const t = useT();

  // ── selfEvolve block (reina.json global) ─────────────────────────────────
  const [engineConfig, setEngineConfig] = useState<EngineConfigPayload | null>(null);
  const [engineConfigSaving, setEngineConfigSaving] = useState(false);
  const engineConfigSaveInFlight = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [everyTurns, setEveryTurns] = useState<number>(DEFAULT_EVERY_TURNS);
  const [notify, setNotify] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [statusError, setStatusError] = useState(false);

  function markDirty() {
    setDirty(true);
    setStatus("");
    setStatusError(false);
  }

  // ── memory-consolidation (dream) block (reina.json global `memory`) ──────
  const [dreamOn, setDreamOn] = useState(true);
  const [cooldownHours, setCooldownHours] = useState<number>(DREAM_DEFAULTS.cooldownHours);
  const [minSessions, setMinSessions] = useState<number>(DREAM_DEFAULTS.minSessions);
  const [idleHours, setIdleHours] = useState<number>(DREAM_DEFAULTS.idleHours);
  const [dreamDirty, setDreamDirty] = useState(false);
  const [dreamStatus, setDreamStatus] = useState("");
  const [dreamError, setDreamError] = useState(false);

  function markDreamDirty() {
    setDreamDirty(true);
    setDreamStatus("");
    setDreamError(false);
  }

  const load = useCallback(async (savedBlock?: "selfEvolve" | "memory") => {
    const cwd = await getWorkspaceCwd();
    try {
      const config = (await bridge().readEngineConfig(cwd)) as EngineConfigPayload;
      setEngineConfig(config);
      if (savedBlock !== "memory") {
        const se = (config?.effective?.selfEvolve as SelfEvolveConfig | undefined) ?? {};
        setEnabled(se.enabled === true);
        setEveryTurns(typeof se.everyTurns === "number" && se.everyTurns > 0 ? Math.floor(se.everyTurns) : DEFAULT_EVERY_TURNS);
        setNotify(se.notify !== false);
        setDirty(false);
      }
      if (savedBlock !== "selfEvolve") {
        const mem = (config?.effective?.memory as MemoryDreamConfig | undefined) ?? {};
        setDreamOn(mem.dream !== false);
        const num = (v: unknown, fallback: number) =>
          typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
        setCooldownHours(num(mem.cooldownHours, DREAM_DEFAULTS.cooldownHours));
        setMinSessions(num(mem.minSessions, DREAM_DEFAULTS.minSessions));
        setIdleHours(num(mem.idleHours, DREAM_DEFAULTS.idleHours));
        setDreamDirty(false);
      }
    } catch {
      // best-effort — panel stays on the built-in defaults (off / 5 / notify)
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Writes replace the global file. Always read its current contents before
  // merging this block so another panel's completed save is preserved.
  async function requireLoadedConfig(): Promise<EngineConfigPayload | null> {
    try {
      const cwd = await getWorkspaceCwd();
      const config = (await bridge().readEngineConfig(cwd)) as EngineConfigPayload;
      setEngineConfig(config);
      return config;
    } catch {
      return null;
    }
  }

  async function handleSave() {
    if (engineConfigSaveInFlight.current) return;
    engineConfigSaveInFlight.current = true;
    setEngineConfigSaving(true);
    setStatus("");
    setStatusError(false);
    const loaded = await requireLoadedConfig();
    if (!loaded) {
      setStatus(t("selfEvolve.configNotLoaded"));
      setStatusError(true);
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
      return;
    }
    const turns = Number.isFinite(everyTurns) ? Math.max(1, Math.min(50, Math.round(everyTurns))) : DEFAULT_EVERY_TURNS;
    setEveryTurns(turns);
    const current = (loaded.global ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current, selfEvolve: { enabled, everyTurns: turns, notify } };
    try {
      const cwd = await getWorkspaceCwd();
      await bridge().writeEngineConfig(cwd || "", "global", next);
      setDirty(false);
      setStatus(t("selfEvolve.savedImmediately"));
      await load("selfEvolve");
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusError(true);
    } finally {
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
    }
  }

  async function handleDreamSave() {
    if (engineConfigSaveInFlight.current) return;
    engineConfigSaveInFlight.current = true;
    setEngineConfigSaving(true);
    setDreamStatus("");
    setDreamError(false);
    const loaded = await requireLoadedConfig();
    if (!loaded) {
      setDreamStatus(t("selfEvolve.configNotLoaded"));
      setDreamError(true);
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
      return;
    }
    const clamp = (v: number, lo: number, hi: number, fallback: number) =>
      Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;
    const cooldown = clamp(cooldownHours, 1, 720, DREAM_DEFAULTS.cooldownHours);
    const sessions = clamp(minSessions, 1, 100, DREAM_DEFAULTS.minSessions);
    const idle = clamp(idleHours, 1, 168, DREAM_DEFAULTS.idleHours);
    setCooldownHours(cooldown);
    setMinSessions(sessions);
    setIdleHours(idle);
    const current = (loaded.global ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...current,
      memory: { dream: dreamOn, cooldownHours: cooldown, minSessions: sessions, idleHours: idle },
    };
    try {
      const cwd = await getWorkspaceCwd();
      await bridge().writeEngineConfig(cwd || "", "global", next);
      setDreamDirty(false);
      setDreamStatus(t("selfEvolve.savedImmediately"));
      await load("memory");
    } catch (err: unknown) {
      setDreamStatus(err instanceof Error ? err.message : String(err));
      setDreamError(true);
    } finally {
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
    }
  }

  // ── Review directive (<REINA_HOME>/self-evolve.md) ───────────────────────
  const [directive, setDirective] = useState("");
  const [directivePath, setDirectivePath] = useState("");
  const [directiveExists, setDirectiveExists] = useState(false);
  const [directiveDirty, setDirectiveDirty] = useState(false);
  const [directiveStatus, setDirectiveStatus] = useState("");
  const [directiveError, setDirectiveError] = useState(false);

  const loadDirective = useCallback(async () => {
    try {
      const data = (await bridge().readSelfEvolveDirective()) as DirectiveData;
      setDirective(data.content ?? "");
      setDirectivePath(data.path ?? "");
      setDirectiveExists(Boolean(data.exists));
      setDirectiveDirty(false);
    } catch {
      // best-effort — editor stays empty (= built-in default in effect)
    }
  }, []);

  useEffect(() => {
    void loadDirective();
  }, [loadDirective]);

  async function handleDirectiveSave() {
    setDirectiveStatus("");
    setDirectiveError(false);
    try {
      const data = (await bridge().writeSelfEvolveDirective(directive)) as { exists: boolean };
      setDirectiveExists(Boolean(data.exists));
      setDirectiveDirty(false);
      setDirectiveStatus(data.exists ? t("selfEvolve.directiveSaved") : t("selfEvolve.directiveReset"));
    } catch (err: unknown) {
      setDirectiveStatus(err instanceof Error ? err.message : String(err));
      setDirectiveError(true);
    }
  }

  function handleDirectiveReset() {
    setDirective("");
    setDirectiveDirty(true);
    setDirectiveStatus("");
    setDirectiveError(false);
  }

  // ── Global memory folder action ──────────────────────────────────────────
  const [memStatus, setMemStatus] = useState("");
  const [memError, setMemError] = useState(false);

  async function handleOpenMemory() {
    setMemStatus("");
    setMemError(false);
    // <REINA_HOME>/reina.json → <REINA_HOME>/notes. globalPath comes from the
    // engine-config payload so we never hardcode the home dir in the renderer.
    const globalPath = engineConfig?.globalPath;
    if (!globalPath) {
      setMemStatus(t("selfEvolve.memoryUnavailable"));
      setMemError(true);
      return;
    }
    const notesDir = globalPath.replace(/reina\.json$/, "notes");
    try {
      await bridge().openPath(notesDir);
    } catch (err: unknown) {
      setMemStatus(err instanceof Error ? err.message : String(err));
      setMemError(true);
    }
  }

  return (
    <div className="pane-enter">
      <fieldset disabled={engineConfigSaving || !engineConfig} className="contents">
      <Section title={t("selfEvolve.title")} description={t("selfEvolve.desc")}>
        <FieldRow label={t("selfEvolve.enable")} hint={t("selfEvolve.enableHint")}>
          <Toggle
            checked={enabled}
            onChange={(v) => {
              setEnabled(v);
              markDirty();
            }}
          />
        </FieldRow>
        <FieldRow label={t("selfEvolve.everyTurns")} hint={t("selfEvolve.everyTurnsHint")}>
          <NumberField
            value={everyTurns}
            min={1}
            max={50}
            step={1}
            onChange={(v) => {
              setEveryTurns(v);
              markDirty();
            }}
          />
        </FieldRow>
        <FieldRow label={t("selfEvolve.notify")} hint={t("selfEvolve.notifyHint")}>
          <Toggle
            checked={notify}
            onChange={(v) => {
              setNotify(v);
              markDirty();
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="accent" disabled={!dirty} onClick={() => void handleSave()}>
            {t("selfEvolve.save")}
          </Button>
          {status && (
            <span className={`text-xs ${statusError ? "text-destructive" : "text-muted-foreground"}`}>{status}</span>
          )}
        </div>
      </Section>

      <Section title={t("memoryDream.title")} description={t("memoryDream.desc")}>
        <FieldRow label={t("memoryDream.enable")} hint={t("memoryDream.enableHint")}>
          <Toggle
            checked={dreamOn}
            onChange={(v) => {
              setDreamOn(v);
              markDreamDirty();
            }}
          />
        </FieldRow>
        <FieldRow label={t("memoryDream.cooldown")} hint={t("memoryDream.cooldownHint")}>
          <NumberField
            value={cooldownHours}
            min={1}
            max={720}
            step={1}
            onChange={(v) => {
              setCooldownHours(v);
              markDreamDirty();
            }}
          />
        </FieldRow>
        <FieldRow label={t("memoryDream.minSessions")} hint={t("memoryDream.minSessionsHint")}>
          <NumberField
            value={minSessions}
            min={1}
            max={100}
            step={1}
            onChange={(v) => {
              setMinSessions(v);
              markDreamDirty();
            }}
          />
        </FieldRow>
        <FieldRow label={t("memoryDream.idleHours")} hint={t("memoryDream.idleHoursHint")}>
          <NumberField
            value={idleHours}
            min={1}
            max={168}
            step={1}
            onChange={(v) => {
              setIdleHours(v);
              markDreamDirty();
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="accent" disabled={!dreamDirty} onClick={() => void handleDreamSave()}>
            {t("selfEvolve.save")}
          </Button>
          {dreamStatus && (
            <span className={`text-xs ${dreamError ? "text-destructive" : "text-muted-foreground"}`}>{dreamStatus}</span>
          )}
        </div>
      </Section>
      </fieldset>

      <Section title={t("selfEvolve.directiveTitle")} description={t("selfEvolve.directiveDesc")}>
        <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono truncate">{directivePath}</span>
          <span className="shrink-0">
            {directiveExists ? t("selfEvolve.directiveCustom") : t("selfEvolve.directiveDefault")}
          </span>
        </div>
        <div className="px-3 pb-1">
          <TextArea
            value={directive}
            placeholder={t("selfEvolve.directivePlaceholder")}
            rows={14}
            onChange={(v) => {
              setDirective(v);
              setDirectiveDirty(true);
              setDirectiveStatus("");
              setDirectiveError(false);
            }}
          />
        </div>
        <div className="flex items-center gap-3 px-3 pb-3">
          <Button variant="accent" disabled={!directiveDirty} onClick={() => void handleDirectiveSave()}>
            {t("selfEvolve.save")}
          </Button>
          <Button disabled={!directiveExists && directive.trim() === ""} onClick={handleDirectiveReset}>
            {t("selfEvolve.directiveResetButton")}
          </Button>
          {directiveStatus && (
            <span className={`text-xs ${directiveError ? "text-destructive" : "text-muted-foreground"}`}>
              {directiveStatus}
            </span>
          )}
        </div>
      </Section>

      <Section title={t("selfEvolve.memoryTitle")} description={t("selfEvolve.memoryDesc")}>
        <FieldRow label={t("selfEvolve.memoryFolder")} hint={t("selfEvolve.memoryFolderHint")}>
          <div className="flex items-center gap-2">
            {memStatus && (
              <span className={`text-xs ${memError ? "text-destructive" : "text-muted-foreground"}`}>{memStatus}</span>
            )}
            <Button onClick={() => void handleOpenMemory()}>{t("selfEvolve.open")}</Button>
          </div>
        </FieldRow>
      </Section>
    </div>
  );
}
