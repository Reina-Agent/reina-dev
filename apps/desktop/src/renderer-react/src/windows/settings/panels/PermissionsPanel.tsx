import { useCallback, useEffect, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT } from "~/lib/i18n";
import { Button, FieldRow, NumberField, Section, Select, Toggle } from "~/components/ui";
import { pickModelConfig, type SessionModelConfig } from "../../main/agentSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type PermissionMode = "default" | "accept-edits" | "bypass";
type Effort = "off" | "low" | "medium" | "high" | "xhigh" | "max";
type StatusLevel = "info" | "success" | "error";

interface ToolLoop {
  hardMaxSteps?: number;
  stagnationLimit?: number;
  repeatedActionLimit?: number;
  consecutiveErrorLimit?: number;
  autoRepair?: boolean;
}

interface EngineConfigPayload {
  workspace?: Record<string, unknown>;
  global?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  workspacePath?: string;
  globalPath?: string;
}

// A model-override (titleModel) as persisted into reina.json: the transport
// block needed so the side call can run cross-provider. Mirrors legacy
// readModelOverride() in actions/settings-config.js.
type ModelOverride = SessionModelConfig;

// Known-model entry surfaced in the title-model dropdown. Mirrors the
// effective merged list (builtins + custom) the legacy renderer feeds into
// fillModelOverrideOptions().
interface KnownModel extends SessionModelConfig {
  id: string;
  label?: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

interface CustomModelsPayload {
  effective?: KnownModel[];
  global?: KnownModel[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PERMISSION_MODE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "default", labelKey: "permissions.modeAsk" },
  { value: "accept-edits", labelKey: "permissions.modeAutoEdit" },
  { value: "bypass", labelKey: "permissions.modeBypass" },
];

const EFFORT_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "off", labelKey: "permissions.effortOff" },
  { value: "low", labelKey: "permissions.effortLow" },
  { value: "medium", labelKey: "permissions.effortMedium" },
  { value: "high", labelKey: "permissions.effortHigh" },
  { value: "xhigh", labelKey: "permissions.effortXHigh" },
  { value: "max", labelKey: "permissions.effortMax" },
];

const LOOP_DEFAULTS = {
  hardMaxSteps: 256,
  stagnationLimit: 20,
  repeatedActionLimit: 40,
  consecutiveErrorLimit: 12,
  autoRepair: true,
};

const EFFORT_VALUES: Effort[] = ["off", "low", "medium", "high", "xhigh", "max"];

const TITLE_MODEL_SAME = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORT_VALUES as string[]).includes(value);
}


// Match a persisted Partial<ModelConfig> back to a known-model id so the
// dropdown can preselect it. Mirrors legacy findKnownModelIdFor().
function findKnownModelId(models: KnownModel[], partial: ModelOverride | undefined): string {
  if (!partial) return TITLE_MODEL_SAME;
  return (
    models.find((m) => m.provider === partial.provider && m.model === partial.model)?.id ?? TITLE_MODEL_SAME
  );
}

// Read a selected known-model id back into the transport-carrying override
// shape persisted in reina.json. Returns undefined for "Same as session".
// Mirrors legacy readModelOverride().
function modelOverrideFor(models: KnownModel[], id: string): ModelOverride | undefined {
  if (!id) return undefined;
  const picked = models.find((m) => m.id === id);
  if (!picked) return undefined;
  return pickModelConfig(picked);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PermissionsPanel() {
  const t = useT();

  // ── Loaded config ────────────────────────────────────────────────────────
  const [engineConfig, setEngineConfig] = useState<EngineConfigPayload | null>(null);

  // ── Permission + effort drafts ───────────────────────────────────────────
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [effort, setEffort] = useState<Effort>("high");
  const [effortStatus, setEffortStatus] = useState("");

  // ── Auto-title drafts ────────────────────────────────────────────────────
  const [autoTitleEnabled, setAutoTitleEnabled] = useState(true);
  const [titleModelId, setTitleModelId] = useState<string>(TITLE_MODEL_SAME);
  const [knownModels, setKnownModels] = useState<KnownModel[]>([]);

  // ── Tool-loop drafts ─────────────────────────────────────────────────────
  const [hardMaxSteps, setHardMaxSteps] = useState(LOOP_DEFAULTS.hardMaxSteps);
  const [stagnationLimit, setStagnationLimit] = useState(LOOP_DEFAULTS.stagnationLimit);
  const [repeatedActionLimit, setRepeatedActionLimit] = useState(LOOP_DEFAULTS.repeatedActionLimit);
  const [consecutiveErrorLimit, setConsecutiveErrorLimit] = useState(LOOP_DEFAULTS.consecutiveErrorLimit);
  const [autoRepair, setAutoRepair] = useState(LOOP_DEFAULTS.autoRepair);

  // ── Dirty / status ───────────────────────────────────────────────────────
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusLevel, setStatusLevel] = useState<StatusLevel>("info");

  // ── Fill fields from effective config ────────────────────────────────────
  const fillFields = useCallback((effective: Record<string, unknown>, models: KnownModel[]) => {
    const pm = effective.permissionMode;
    if (pm === "default" || pm === "accept-edits" || pm === "bypass") {
      setPermissionMode(pm);
    } else {
      setPermissionMode("default");
    }

    const loop = (effective.toolLoop ?? {}) as ToolLoop;
    setHardMaxSteps(loop.hardMaxSteps ?? LOOP_DEFAULTS.hardMaxSteps);
    setStagnationLimit(loop.stagnationLimit ?? LOOP_DEFAULTS.stagnationLimit);
    setRepeatedActionLimit(loop.repeatedActionLimit ?? LOOP_DEFAULTS.repeatedActionLimit);
    setConsecutiveErrorLimit(loop.consecutiveErrorLimit ?? LOOP_DEFAULTS.consecutiveErrorLimit);
    setAutoRepair(loop.autoRepair !== false);

    const autoTitle = (effective.autoTitle ?? {}) as { enabled?: boolean };
    setAutoTitleEnabled(autoTitle.enabled !== false);

    const titleModel = effective.titleModel as ModelOverride | undefined;
    setTitleModelId(findKnownModelId(models, titleModel));

    setDirty(false);
    setStatus("");
  }, []);

  // Load known models for the title-model picker — effective list (builtins
  // merged with user custom models), same source the legacy renderer feeds into
  // fillModelOverrideOptions().
  const loadKnownModels = useCallback(async (cwd: string | undefined): Promise<KnownModel[]> => {
    try {
      const builtins = (await bridge().listKnownModels()) as KnownModel[] | null;
      const payload = (await bridge().readCustomModels(cwd)) as CustomModelsPayload | null;
      const byId = new Map<string, KnownModel>();
      for (const m of Array.isArray(builtins) ? builtins : []) byId.set(m.id, m);
      for (const m of payload?.effective ?? []) byId.set(m.id, m);
      const merged = [...byId.values()].filter((m) => m.id !== "deterministic");
      setKnownModels(merged);
      return merged;
    } catch {
      setKnownModels([]);
      return [];
    }
  }, []);

  // Load effort from desktop state (lives in agentSettings, not engineConfig)
  const loadEffort = useCallback(async () => {
    try {
      const state = (await bridge().getDesktopState()) as {
        agentSettings?: { effort?: string };
      } | null;
      const e = state?.agentSettings?.effort;
      if (isEffort(e)) setEffort(e);
    } catch {
      // use default
    }
  }, []);

  const loadConfig = useCallback(async () => {
    const cwd = await getWorkspaceCwd();
    const models = await loadKnownModels(cwd);
    try {
      const payload = (await bridge().readEngineConfig(cwd)) as EngineConfigPayload;
      setEngineConfig(payload);
      const effective = (payload.effective ?? {}) as Record<string, unknown>;
      fillFields(effective, models);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg);
      setStatusLevel("error");
    }
  }, [fillFields, loadKnownModels]);

  useEffect(() => {
    void loadConfig();
    void loadEffort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dirty marking helper ─────────────────────────────────────────────────
  function markDirty() {
    setDirty(true);
    setStatus("");
  }

  // Effort applies to the foreground session and new-session defaults.
  const persistEffort = useCallback(async (next: Effort) => {
    setEffort(next);
    setEffortStatus("");
    try {
      await bridge().invoke("patch_agent_settings", { patch: { effort: next } });
      setEffortStatus(t("agents.saved"));
    } catch (err: unknown) {
      setEffortStatus(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  // ── Reset tool-loop fields to engine defaults ────────────────────────────
  function handleReset() {
    setHardMaxSteps(LOOP_DEFAULTS.hardMaxSteps);
    setStagnationLimit(LOOP_DEFAULTS.stagnationLimit);
    setRepeatedActionLimit(LOOP_DEFAULTS.repeatedActionLimit);
    setConsecutiveErrorLimit(LOOP_DEFAULTS.consecutiveErrorLimit);
    setAutoRepair(LOOP_DEFAULTS.autoRepair);
    setDirty(true);
    setStatus(t("permissions.defaultsLoaded"));
    setStatusLevel("info");
  }

  // ── Build the config patch from current draft state ──────────────────────
  function buildPatch() {
    return {
      permissionMode,
      toolLoop: {
        hardMaxSteps,
        stagnationLimit,
        repeatedActionLimit,
        consecutiveErrorLimit,
        autoRepair,
      },
      autoTitle: { enabled: autoTitleEnabled },
      titleModel: modelOverrideFor(knownModels, titleModelId),
    };
  }

  // ── Save to a given scope ────────────────────────────────────────────────
  const handleSave = async (scope: "workspace" | "global") => {
    const cwd = await getWorkspaceCwd();
    // Only a workspace-scoped save needs a workspace. Global config lives at
    // $REINA_HOME and the IPC layer falls back to defaultCwd for an empty cwd,
    // so a global save must proceed even with no workspace open.
    if (scope === "workspace" && !cwd) {
      setStatus(t("permissions.openWorkspaceFirst"));
      setStatusLevel("error");
      return;
    }
    setSaving(true);
    try {
      const perm = buildPatch();
      const current = (engineConfig?.[scope] ?? {}) as Record<string, unknown>;
      const currentLoop = (current.toolLoop ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = {
        ...current,
        permissionMode: perm.permissionMode,
        toolLoop: { ...currentLoop, ...perm.toolLoop },
        autoTitle: {
          ...((current.autoTitle ?? {}) as Record<string, unknown>),
          ...perm.autoTitle,
        },
      };
      // titleModel: persist the override when a model is picked; drop the key
      // (back to "Same as session") when the user cleared it. Mirrors legacy
      // savePermConfig.
      if (perm.titleModel) next.titleModel = perm.titleModel;
      else delete next.titleModel;
      await bridge().writeEngineConfig(cwd || "", scope, next);
      setDirty(false);
      setStatus(
        t("permissions.savedToScope", {
          scope:
            scope === "workspace"
              ? t("permissions.scopeWorkspace")
              : t("permissions.scopeGlobal"),
        }),
      );
      setStatusLevel("success");
      await loadConfig();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg);
      setStatusLevel("error");
    } finally {
      setSaving(false);
    }
  };

  // Permission-mode + effort dropdown options, labels translated at render time.
  const permissionModeOptions = PERMISSION_MODE_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));
  const effortOptions = EFFORT_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));

  // Title-model dropdown options: "Same as session" + every known model.
  const titleModelOptions: { value: string; label: string }[] = [
    { value: TITLE_MODEL_SAME, label: t("permissions.titleModelSame") },
    ...knownModels.map((m) => ({
      value: m.id,
      label: (m.label ?? m.model) === m.model ? `${m.model} · ${m.provider}` : `${m.label} — ${m.provider} / ${m.model}`,
    })),
  ];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="pane-enter">
      {/* ── Permission mode + effort ──────────────────────────────────────── */}
      <Section
        title={t("permissions.sectionPermissions")}
        description={t("permissions.sectionPermissionsDesc")}
      >
        <FieldRow
          label={t("permissions.defaultMode")}
          hint={t("permissions.defaultModeHint")}
        >
          <Select
            value={permissionMode}
            options={permissionModeOptions}
            onChange={(v) => {
              setPermissionMode(v as PermissionMode);
              markDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.defaultEffort")}
          hint={t("permissions.defaultEffortHint")}
        >
          <div className="flex items-center gap-2">
            {effortStatus && (
              <span className="text-[12px] text-muted-foreground">{effortStatus}</span>
            )}
            <Select
              value={effort}
              options={effortOptions}
              onChange={(v) => {
                if (isEffort(v)) void persistEffort(v);
              }}
            />
          </div>
        </FieldRow>
      </Section>

      {/* ── Session auto-title ────────────────────────────────────────────── */}
      <Section
        title={t("permissions.sectionAutoTitle")}
        description={t("permissions.sectionAutoTitleDesc")}
      >
        <FieldRow
          label={t("permissions.renameAuto")}
          hint={t("permissions.renameAutoHint")}
        >
          <Toggle
            checked={autoTitleEnabled}
            onChange={(v) => {
              setAutoTitleEnabled(v);
              markDirty();
            }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.autoTitleModel")}
          hint={t("permissions.autoTitleModelHint")}
        >
          <Select
            value={titleModelId}
            options={titleModelOptions}
            onChange={(v) => {
              setTitleModelId(v);
              markDirty();
            }}
          />
        </FieldRow>
      </Section>

      {/* ── Tool loop limits ──────────────────────────────────────────────── */}
      <Section
        title={t("permissions.sectionLoopLimits")}
        description={t("permissions.sectionLoopLimitsDesc")}
      >
        <FieldRow
          label={t("permissions.hardMaxSteps")}
          hint={t("permissions.hardMaxStepsHint")}
        >
          <NumberField
            value={hardMaxSteps}
            min={1}
            max={2048}
            step={1}
            onChange={(v) => { setHardMaxSteps(v); markDirty(); }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.stagnationLimit")}
          hint={t("permissions.stagnationLimitHint")}
        >
          <NumberField
            value={stagnationLimit}
            min={1}
            max={256}
            step={1}
            onChange={(v) => { setStagnationLimit(v); markDirty(); }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.repeatedActionLimit")}
          hint={t("permissions.repeatedActionLimitHint")}
        >
          <NumberField
            value={repeatedActionLimit}
            min={1}
            max={256}
            step={1}
            onChange={(v) => { setRepeatedActionLimit(v); markDirty(); }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.consecutiveErrorLimit")}
          hint={t("permissions.consecutiveErrorLimitHint")}
        >
          <NumberField
            value={consecutiveErrorLimit}
            min={1}
            max={64}
            step={1}
            onChange={(v) => { setConsecutiveErrorLimit(v); markDirty(); }}
          />
        </FieldRow>
        <FieldRow
          label={t("permissions.autoRepair")}
          hint={t("permissions.autoRepairHint")}
        >
          <Toggle
            checked={autoRepair}
            onChange={(v) => { setAutoRepair(v); markDirty(); }}
          />
        </FieldRow>

        {/* Save / Reset actions */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <Button onClick={handleReset}>
            {t("permissions.resetDefaults")}
          </Button>
          <Button
            onClick={() => void handleSave("workspace")}
            disabled={!dirty || saving}
          >
            {t("permissions.saveWorkspace")}
          </Button>
          <Button
            variant="accent"
            onClick={() => void handleSave("global")}
            disabled={!dirty || saving}
          >
            {t("permissions.saveGlobal")}
          </Button>
          {status && (
            <span className={`text-[12px] ${statusColor(statusLevel)}`}>{status}</span>
          )}
        </div>
      </Section>
    </div>
  );
}
