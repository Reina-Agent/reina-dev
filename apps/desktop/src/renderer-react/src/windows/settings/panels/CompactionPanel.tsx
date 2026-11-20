import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { DEFAULTS, saveCompactionSettings, saveSubagentConcurrency, useViewSettings } from "~/lib/viewSettings";
import { Button, FieldRow, NumberField, Section, Select, Toggle } from "~/components/ui";
import { useT } from "~/lib/i18n";
import { pickModelConfig, type SessionModelConfig } from "../../main/agentSettings";

// Explicit saves wait for the running host to accept the settings.

// ── Types for the compaction-summary-model picker ──────────────────────────
// Mirror of ~/.reina/models.json entries surfaced by listKnownModels().
interface KnownModel extends SessionModelConfig {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

// Partial<ModelConfig> override block persisted into reina.json (global engine
// config). Carries the transport so the side call works cross-provider.
type ModelOverride = SessionModelConfig;

interface EngineConfigPayload {
  workspace?: Record<string, unknown>;
  global?: Record<string, unknown>;
  effective?: Record<string, unknown>;
}


// Find the known-model id whose provider+model match a stored override block,
// so the dropdown can re-select the saved choice. Returns "" for "Same as session".
function findKnownModelId(models: KnownModel[], partial: ModelOverride | undefined): string {
  if (!partial) return "";
  return (
    models.find((m) => m.provider === partial.provider && m.model === partial.model)?.id ?? ""
  );
}

// Read a known-model id back into the Partial<ModelConfig> shape (provider/model
// + transport). Returns undefined for "Same as session".
function readModelOverride(models: KnownModel[], id: string): ModelOverride | undefined {
  if (!id) return undefined;
  const picked = models.find((m) => m.id === id);
  if (!picked) return undefined;
  return pickModelConfig(picked);
}

export function CompactionPanel() {
  const t = useT();
  const s = useViewSettings();

  // ── Compaction summary-model picker ──────────────────────────────────────
  // The override lives in reina.json pinned to the GLOBAL engine config (a
  // per-user preference). Existing sessions reload it at the next request boundary.
  const [knownModels, setKnownModels] = useState<KnownModel[]>([]);
  const [engineConfig, setEngineConfig] = useState<EngineConfigPayload | null>(null);
  const [engineConfigSaving, setEngineConfigSaving] = useState(false);
  const engineConfigSaveInFlight = useRef(false);
  const [compModelId, setCompModelId] = useState<string>("");
  const [compModelStatus, setCompModelStatus] = useState<string>("");
  const [compModelError, setCompModelError] = useState(false);

  // ── Goal independent verification (reina.json global goal.verify) ─────────
  const [goalVerifyEnabled, setGoalVerifyEnabled] = useState(true);
  const [goalVerifyMaxRounds, setGoalVerifyMaxRounds] = useState<number>(3);
  const [goalVerifyFailOpen, setGoalVerifyFailOpen] = useState(true);
  const [goalVerifyModelId, setGoalVerifyModelId] = useState<string>("");
  const [goalVerifyDirty, setGoalVerifyDirty] = useState(false);
  const [goalVerifyStatus, setGoalVerifyStatus] = useState<string>("");
  const [goalVerifyError, setGoalVerifyError] = useState(false);
  function markGoalVerifyDirty() {
    setGoalVerifyDirty(true);
    setGoalVerifyStatus("");
    setGoalVerifyError(false);
  }

  const loadModelPicker = useCallback(async (resetGoalDraft = true) => {
    const cwd = await getWorkspaceCwd();
    try {
      const [models, config] = await Promise.all([
        bridge().listKnownModels() as Promise<KnownModel[] | null>,
        bridge().readEngineConfig(cwd) as Promise<EngineConfigPayload>,
      ]);
      const list = Array.isArray(models) ? models : [];
      setKnownModels(list);
      setEngineConfig(config);
      const current = config?.effective?.compactionModel as ModelOverride | undefined;
      setCompModelId(findKnownModelId(list, current));
      // Read the Goal namespace first. The autopilot fallback migrates the
      // display for configs written before Goal v2 had a dedicated block.
      const verify =
        (config?.effective?.goal as { verify?: Record<string, unknown> } | undefined)?.verify
        ?? (config?.effective?.autopilot as { verify?: Record<string, unknown> } | undefined)?.verify;
      if (resetGoalDraft) {
        setGoalVerifyEnabled(verify?.enabled !== false);
        setGoalVerifyFailOpen(verify?.failOpen !== false);
        setGoalVerifyMaxRounds(typeof verify?.maxRounds === "number" && verify.maxRounds > 0 ? Math.floor(verify.maxRounds) : 3);
        setGoalVerifyModelId(findKnownModelId(list, verify?.model as ModelOverride | undefined));
        setGoalVerifyDirty(false);
      }
    } catch {
      // best-effort — picker stays on "Same as session"
    }
  }, []);

  async function handleGoalVerifySave() {
    if (engineConfigSaveInFlight.current) return;
    engineConfigSaveInFlight.current = true;
    setEngineConfigSaving(true);
    setGoalVerifyStatus("");
    setGoalVerifyError(false);
    // Goal verification is GLOBAL config — never needs an open workspace; the IPC
    // layer resolves the global path regardless of cwd.
    const rounds = Number.isFinite(goalVerifyMaxRounds) ? Math.max(1, Math.min(10, Math.round(goalVerifyMaxRounds))) : 3;
    setGoalVerifyMaxRounds(rounds);
    const verify: Record<string, unknown> = { enabled: goalVerifyEnabled, failOpen: goalVerifyFailOpen, maxRounds: rounds };
    const pickedModel = readModelOverride(knownModels, goalVerifyModelId);
    if (pickedModel) verify.model = pickedModel;
    try {
      const cwd = await getWorkspaceCwd();
      const fresh = await bridge().readEngineConfig(cwd) as EngineConfigPayload;
      const current = fresh.global ?? {};
      const currentGoal = current.goal && typeof current.goal === "object"
        ? current.goal as Record<string, unknown>
        : {};
      const next: Record<string, unknown> = { ...current, goal: { ...currentGoal, verify } };
      await bridge().writeEngineConfig(cwd || "", "global", next);
      setGoalVerifyDirty(false);
      setGoalVerifyStatus(t("compaction.savedImmediately"));
      await loadModelPicker();
    } catch (err: unknown) {
      setGoalVerifyStatus(err instanceof Error ? err.message : String(err));
      setGoalVerifyError(true);
    } finally {
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
    }
  }

  useEffect(() => {
    void loadModelPicker();
  }, [loadModelPicker]);

  async function handleCompModelChange(id: string) {
    if (engineConfigSaveInFlight.current) return;
    engineConfigSaveInFlight.current = true;
    setEngineConfigSaving(true);
    setCompModelId(id);
    setCompModelStatus("");
    setCompModelError(false);
    // Compaction model is GLOBAL config — never needs an open workspace; the IPC
    // layer resolves the global path regardless of cwd.
    const picked = readModelOverride(knownModels, id);
    try {
      const cwd = await getWorkspaceCwd();
      const fresh = await bridge().readEngineConfig(cwd) as EngineConfigPayload;
      const next: Record<string, unknown> = { ...fresh.global };
      if (picked) next.compactionModel = picked;
      else delete next.compactionModel;
      await bridge().writeEngineConfig(cwd || "", "global", next);
      setCompModelStatus(
        picked
          ? t("compaction.savedImmediately")
          : t("compaction.clearedSessionModel"),
      );
      setCompModelError(false);
      await loadModelPicker(false);
    } catch (err: unknown) {
      setCompModelStatus(err instanceof Error ? err.message : String(err));
      setCompModelError(true);
    } finally {
      engineConfigSaveInFlight.current = false;
      setEngineConfigSaving(false);
    }
  }

  // ── Conversation-history folder action ───────────────────────────────────
  const [historyStatus, setHistoryStatus] = useState<string>("");
  const [historyError, setHistoryError] = useState(false);

  async function handleOpenHistory() {
    setHistoryStatus("");
    setHistoryError(false);
    const cwd = await getWorkspaceCwd();
    if (!cwd) {
      setHistoryStatus(t("compaction.openWorkspaceFirst"));
      setHistoryError(true);
      return;
    }
    try {
      await bridge().openPath(`${cwd}/.reina/conversation_history`);
    } catch (err: unknown) {
      setHistoryStatus(err instanceof Error ? err.message : String(err));
      setHistoryError(true);
    }
  }

  const compModelOptions = [
    { value: "", label: t("compaction.sameAsSession") },
    ...knownModels.map((m) => ({
      value: m.id,
      // Avoid the redundant "label — provider / model" when label already equals
      // the model id (the common models.json case); just suffix the provider.
      label: m.label === m.model ? `${m.label} · ${m.provider}` : `${m.label} — ${m.provider} / ${m.model}`,
    })),
  ];

  // ── Compaction dirty state ────────────────────────────────────────────────
  const [compDirty, setCompDirty] = useState(false);
  const [compStatus, setCompStatus] = useState<string>("");
  const [compSaving, setCompSaving] = useState(false);
  const [compError, setCompError] = useState(false);
  const compRevision = useRef(0);

  // Local draft values for the compaction number fields (so the user can
  // edit freely before committing with Save).
  const [draftTrigger, setDraftTrigger] = useState<string>(() => {
    const pct = s.compactionTriggerPercent;
    return pct > 0 ? String(pct) : "";
  });
  const [draftBuffer, setDraftBuffer] = useState<number>(s.compactionBufferTokens);
  const [draftKeep, setDraftKeep] = useState<number>(s.compactionKeepRecent);
  const [draftOffload, setDraftOffload] = useState<boolean>(s.compactionOffload);
  const [draftAuto, setDraftAuto] = useState<boolean>(s.compactionAuto);

  function markCompDirty() {
    compRevision.current += 1;
    setCompDirty(true);
    setCompStatus("");
    setCompError(false);
  }

  async function handleCompSave() {
    const revision = compRevision.current;
    setCompSaving(true);
    setCompStatus("");
    setCompError(false);
    // Trigger percent: empty / 0 = unset (falls back to buffer-token mode).
    // Otherwise clamped to 30-95.
    const pctRawStr = draftTrigger.trim();
    let pct = 0;
    if (pctRawStr !== "") {
      const pctRaw = Number(pctRawStr);
      if (Number.isFinite(pctRaw) && pctRaw > 0) {
        pct = Math.max(30, Math.min(95, Math.round(pctRaw)));
      }
    }
    setDraftTrigger(pct > 0 ? String(pct) : "");

    const buf = Number.isFinite(draftBuffer)
      ? Math.max(1000, Math.min(500000, Math.round(draftBuffer)))
      : DEFAULTS.compactionBufferTokens;
    setDraftBuffer(buf);

    const keep = Number.isFinite(draftKeep)
      ? Math.max(2, Math.min(64, Math.round(draftKeep)))
      : DEFAULTS.compactionKeepRecent;
    setDraftKeep(keep);

    try {
      await saveCompactionSettings({
        compactionOffload: draftOffload,
        compactionAuto: draftAuto,
        compactionTriggerPercent: pct,
        compactionBufferTokens: buf,
        compactionKeepRecent: keep,
      });
      if (compRevision.current === revision) {
        setCompDirty(false);
        setCompStatus(t("compaction.savedImmediately"));
      }
    } catch (err: unknown) {
      setCompStatus(err instanceof Error ? err.message : String(err));
      setCompError(true);
    } finally {
      setCompSaving(false);
    }
  }

  // ── Subagent concurrency dirty state ─────────────────────────────────────
  const [concDirty, setConcDirty] = useState(false);
  const [concStatus, setConcStatus] = useState<string>("");
  const [concSaving, setConcSaving] = useState(false);
  const [concError, setConcError] = useState(false);
  const concRevision = useRef(0);
  const [draftConc, setDraftConc] = useState<number>(s.subagentConcurrency);

  function markConcDirty() {
    concRevision.current += 1;
    setConcDirty(true);
    setConcStatus("");
    setConcError(false);
  }

  async function handleConcSave() {
    const revision = concRevision.current;
    setConcSaving(true);
    setConcStatus("");
    setConcError(false);
    const clamped = Number.isFinite(draftConc)
      ? Math.max(1, Math.min(32, Math.round(draftConc)))
      : DEFAULTS.subagentConcurrency;
    setDraftConc(clamped);
    try {
      await saveSubagentConcurrency(clamped);
      if (concRevision.current === revision) {
        setConcDirty(false);
        setConcStatus(t("compaction.savedImmediately"));
      }
    } catch (err: unknown) {
      setConcStatus(err instanceof Error ? err.message : String(err));
      setConcError(true);
    } finally {
      setConcSaving(false);
    }
  }

  return (
    <div className="pane-enter">
      <Section
        title={t("compaction.compactionTitle")}
        description={t("compaction.compactionDesc")}
      >
        <FieldRow
          label={t("compaction.enableAutoCompact")}
          hint={t("compaction.enableAutoCompactHint")}
        >
          <Toggle
            checked={draftAuto}
            onChange={(v) => {
              setDraftAuto(v);
              markCompDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.triggerPercent")}
          hint={t("compaction.triggerPercentHint")}
        >
          <input
            type="number"
            value={draftTrigger}
            min={30}
            max={95}
            step={1}
            placeholder="—"
            onChange={(e) => {
              setDraftTrigger(e.target.value);
              markCompDirty();
            }}
            className="h-7 w-20 rounded-md border bg-transparent px-2 text-right text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.triggerBuffer")}
          hint={t("compaction.triggerBufferHint")}
        >
          <NumberField
            value={draftBuffer}
            min={1000}
            max={500000}
            step={500}
            onChange={(v) => {
              setDraftBuffer(v);
              markCompDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.keepRecent")}
          hint={t("compaction.keepRecentHint")}
        >
          <NumberField
            value={draftKeep}
            min={2}
            max={64}
            step={1}
            onChange={(v) => {
              setDraftKeep(v);
              markCompDirty();
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="accent" disabled={!compDirty || compSaving} onClick={handleCompSave}>
            {t("compaction.save")}
          </Button>
          {compStatus && (
            <span className={`text-xs ${compError ? "text-destructive" : "text-muted-foreground"}`}>{compStatus}</span>
          )}
        </div>
      </Section>

      <fieldset disabled={engineConfigSaving || !engineConfig} className="contents">
      <Section
        title={t("compaction.summaryModelTitle")}
        description={t("compaction.summaryModelDesc")}
      >
        <FieldRow
          label={t("compaction.compactionModel")}
          hint={t("compaction.compactionModelHint")}
        >
          <div className="flex items-center gap-2">
            <Select
              value={compModelId}
              options={compModelOptions}
              disabled={engineConfigSaving || !engineConfig}
              onChange={(v) => void handleCompModelChange(v)}
            />
            {compModelStatus && (
              <span className={`text-xs ${compModelError ? "text-destructive" : "text-muted-foreground"}`}>
                {compModelStatus}
              </span>
            )}
          </div>
        </FieldRow>
      </Section>

      <Section
        title={t("compaction.goalVerifyTitle")}
        description={t("compaction.goalVerifyDesc")}
      >
        <FieldRow
          label={t("compaction.enableVerify")}
          hint={t("compaction.enableVerifyHint")}
        >
          <Toggle
            checked={goalVerifyEnabled}
            onChange={(v) => {
              setGoalVerifyEnabled(v);
              markGoalVerifyDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.maxRounds")}
          hint={t("compaction.maxRoundsHint")}
        >
          <NumberField
            value={goalVerifyMaxRounds}
            min={1}
            max={10}
            step={1}
            onChange={(v) => {
              setGoalVerifyMaxRounds(v);
              markGoalVerifyDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.acceptOnError")}
          hint={t("compaction.acceptOnErrorHint")}
        >
          <Toggle
            checked={goalVerifyFailOpen}
            onChange={(v) => {
              setGoalVerifyFailOpen(v);
              markGoalVerifyDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("compaction.verifierModel")}
          hint={t("compaction.verifierModelHint")}
        >
          <Select
            value={goalVerifyModelId}
            options={compModelOptions}
            disabled={engineConfigSaving || !engineConfig}
            onChange={(v) => {
              setGoalVerifyModelId(v);
              markGoalVerifyDirty();
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="accent" disabled={!goalVerifyDirty} onClick={() => void handleGoalVerifySave()}>
            {t("compaction.save")}
          </Button>
          {goalVerifyStatus && (
            <span className={`text-xs ${goalVerifyError ? "text-destructive" : "text-muted-foreground"}`}>{goalVerifyStatus}</span>
          )}
        </div>
      </Section>
      </fieldset>

      <Section title={t("compaction.memoryOffloadTitle")}>
        <FieldRow
          label={t("compaction.enableOffload")}
          hint={t("compaction.enableOffloadHint")}
        >
          <Toggle
            checked={draftOffload}
            onChange={(v) => {
              setDraftOffload(v);
              markCompDirty();
            }}
          />
        </FieldRow>
      </Section>

      <Section
        title={t("compaction.subagentTitle")}
        description={t("compaction.subagentDesc")}
      >
        <FieldRow label={t("compaction.maxConcurrent")}>
          <NumberField
            value={draftConc}
            min={1}
            max={32}
            step={1}
            onChange={(v) => {
              setDraftConc(v);
              markConcDirty();
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="accent" disabled={!concDirty || concSaving} onClick={handleConcSave}>
            {t("compaction.save")}
          </Button>
          {concStatus && (
            <span className={`text-xs ${concError ? "text-destructive" : "text-muted-foreground"}`}>{concStatus}</span>
          )}
        </div>
      </Section>

      <Section title={t("compaction.historyTitle")}>
        <FieldRow
          label={t("compaction.historyFolder")}
          hint={t("compaction.historyFolderHint")}
        >
          <div className="flex items-center gap-2">
            {historyStatus && (
              <span className={`text-xs ${historyError ? "text-destructive" : "text-muted-foreground"}`}>
                {historyStatus}
              </span>
            )}
            <Button onClick={() => void handleOpenHistory()}>{t("compaction.open")}</Button>
          </div>
        </FieldRow>
      </Section>
    </div>
  );
}
