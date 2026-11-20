import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT } from "~/lib/i18n";
import { Button, FieldRow, Section, Select, TextArea, TextField, Toggle } from "~/components/ui";

// ── Types mirrored from packages/core + ipc-validators ───────────────────────

interface AgentProfileSummary {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  builtin: boolean;
  prompt?: string;
  maxSteps?: number;
  hidden?: boolean;
}

interface CustomAgent {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  prompt: string;
  maxSteps?: number;
  extraDirectTools?: string[];
}

interface CustomAgentsPayload {
  path: string;
  agents: CustomAgent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type StatusLevel = "info" | "success" | "error";

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const VALID_MODES = new Set(["primary", "subagent", "all"]);

function validMode(v: string): "primary" | "subagent" | "all" {
  return VALID_MODES.has(v) ? (v as "primary" | "subagent" | "all") : "subagent";
}

// Default agent + output style persist into the same JSON blob the legacy
// renderer writes (electron-store "agent-settings" / key "current",
// state.agentSettings). We read the raw blob, merge a single field, and write
// it back so we never clobber the composer's other keys (model, mode, effort).
const AGENT_SETTINGS_STORE = { name: "agent-settings", key: "current" };

const OUTPUT_STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default — balanced" },
  { value: "concise", label: "Concise — terse, no preamble" },
  { value: "explanatory", label: "Explanatory — annotate decisions" },
  { value: "learning", label: "Learning — teach as you go" },
];

interface PersistedAgentSettings {
  agent?: string;
  outputStyle?: string;
  outputStyleCustom?: string;
  [key: string]: unknown;
}

interface EngineConfigPayload {
  workspace?: Record<string, unknown>;
  global?: Record<string, unknown>;
  effective?: Record<string, unknown>;
}

async function readAgentSettings(): Promise<PersistedAgentSettings> {
  try {
    const raw = await bridge().storeGet(AGENT_SETTINGS_STORE.name, AGENT_SETTINGS_STORE.key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PersistedAgentSettings) : {};
  } catch {
    return {};
  }
}

/** Main merges the edited fields and applies them to the current session. */
async function patchAgentSettings(patch: PersistedAgentSettings): Promise<void> {
  await bridge().invoke("patch_agent_settings", { patch });
}


// ── Sub-component: custom agent editor ───────────────────────────────────────

interface EditorProps {
  profiles: AgentProfileSummary[];
  cache: CustomAgentsPayload;
  onSaved: (next: CustomAgentsPayload) => void;
}

function AgentEditor({ profiles, cache, onSaved }: EditorProps) {
  const t = useT();
  const [editingName, setEditingName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"primary" | "subagent" | "all">("subagent");
  const [maxSteps, setMaxSteps] = useState("");
  const [prompt, setPrompt] = useState("");

  const [status, setStatus] = useState("");
  const [statusLevel, setStatusLevel] = useState<StatusLevel>("info");

  function fillForm(agent: Partial<CustomAgent & { builtin?: boolean }>, isBuiltin = false) {
    setName(agent.name ?? "");
    setDescription(agent.description ?? "");
    setMode(validMode(agent.mode ?? "subagent"));
    setMaxSteps(agent.maxSteps != null ? String(agent.maxSteps) : "");
    setPrompt(agent.prompt ?? "");
    setEditingName(isBuiltin ? null : (agent.name ?? null));
    setDirty(false);
    setStatus(
      isBuiltin
        ? t("agents.editingBuiltinHint")
        : "",
    );
    setStatusLevel("info");
  }

  function clearForm() {
    setName("");
    setDescription("");
    setMode("subagent");
    setMaxSteps("");
    setPrompt("");
    setEditingName(null);
    setDirty(false);
    setStatus("");
  }

  function markDirty() {
    setDirty(true);
    setStatus("");
  }

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus(t("agents.nameRequired"));
      setStatusLevel("error");
      return;
    }
    if (!NAME_RE.test(trimmedName)) {
      setStatus(t("agents.invalidName"));
      setStatusLevel("error");
      return;
    }
    if (!description.trim()) {
      setStatus(t("agents.descriptionRequired"));
      setStatusLevel("error");
      return;
    }
    if (!prompt.trim()) {
      setStatus(t("agents.promptRequired"));
      setStatusLevel("error");
      return;
    }
    const maxStepsNum = maxSteps.trim() !== "" ? Number(maxSteps) : undefined;
    const extraDirectTools = cache.agents.find((agent) => agent.name === trimmedName)?.extraDirectTools;
    const entry: CustomAgent = {
      name: trimmedName,
      description: description.trim(),
      mode,
      prompt: prompt.trim(),
      ...(extraDirectTools?.length ? { extraDirectTools } : {}),
      ...(maxStepsNum != null && Number.isFinite(maxStepsNum) && maxStepsNum > 0
        ? { maxSteps: Math.floor(maxStepsNum) }
        : {}),
    };
    const byName = new Map(cache.agents.map((a) => [a.name, a]));
    byName.set(entry.name, entry);
    try {
      const result = (await bridge().writeCustomAgents([...byName.values()])) as CustomAgentsPayload;
      setEditingName(entry.name);
      setDirty(false);
      setStatus(t("agents.savedNamed", { name: entry.name }));
      setStatusLevel("success");
      onSaved(result);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusLevel("error");
    }
  }

  async function handleDelete() {
    if (!editingName) return;
    if (!cache.agents.some((a) => a.name === editingName)) {
      setStatus(t("agents.builtinCannotDelete"));
      setStatusLevel("error");
      return;
    }
    if (!window.confirm(t("agents.confirmDelete", { name: editingName }))) return;
    try {
      const remaining = cache.agents.filter((a) => a.name !== editingName);
      const result = (await bridge().writeCustomAgents(remaining)) as CustomAgentsPayload;
      clearForm();
      setStatus(t("agents.deleted"));
      setStatusLevel("success");
      onSaved(result);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusLevel("error");
    }
  }

  const isCustomEditingExisting = editingName != null && cache.agents.some((a) => a.name === editingName);

  return (
    <>
      {/* Profile list */}
      <div className="mb-4 rounded-xl border bg-card">
        {profiles.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t("agents.noAgents")}</div>
        ) : (
          <div className="divide-y divide-(--surface-divider)">
            {profiles.map((profile) => (
              <button
                key={profile.name}
                type="button"
                onClick={() => {
                  if (profile.builtin) {
                    fillForm(
                      {
                        name: profile.name,
                        description: profile.description,
                        mode: profile.mode,
                        prompt: profile.prompt ?? "",
                        maxSteps: profile.maxSteps,
                      },
                      true,
                    );
                  } else {
                    const found = cache.agents.find((a) => a.name === profile.name);
                    fillForm(found ?? {}, false);
                  }
                }}
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-(--motion-fast) hover:bg-secondary/40"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {profile.name}
                    {profile.builtin && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{t("agents.builtinTag")}</span>
                    )}
                  </div>
                  {profile.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{profile.description}</div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted-foreground/60">
                    {[profile.mode, profile.maxSteps != null ? `maxSteps: ${profile.maxSteps}` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {profile.builtin ? t("agents.readOnly") : t("agents.custom")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Editor form */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-2.5 text-[13px] font-medium text-muted-foreground">
          {editingName ? t("agents.editingNamed", { name: editingName }) : t("agents.newAgent")}
        </div>
        <div className="divide-y divide-(--surface-divider) border-t">
          <FieldRow
            label={t("agents.agentNameLabel")}
            hint={t("agents.agentNameHint")}
          >
            <TextField
              value={name}
              placeholder={t("agents.agentNamePlaceholder")}
              onChange={(v) => {
                setName(v);
                markDirty();
              }}
            />
          </FieldRow>

          <FieldRow
            label={t("agents.descriptionLabel")}
            hint={t("agents.descriptionHint")}
          >
            <TextField
              value={description}
              placeholder={t("agents.descriptionPlaceholder")}
              onChange={(v) => {
                setDescription(v);
                markDirty();
              }}
            />
          </FieldRow>

          <FieldRow
            label={t("agents.modeLabel")}
            hint={t("agents.modeHint")}
          >
            <Select
              value={mode}
              options={[
                { value: "subagent", label: "subagent" },
                { value: "primary", label: "primary" },
                { value: "all", label: "all" },
              ]}
              onChange={(v) => {
                setMode(validMode(v));
                markDirty();
              }}
            />
          </FieldRow>

          <FieldRow
            label={t("agents.maxStepsLabel")}
            hint={t("agents.maxStepsHint")}
          >
            <input
              type="number"
              value={maxSteps}
              min={1}
              step={1}
              placeholder={t("agents.maxStepsPlaceholder")}
              onChange={(e) => {
                setMaxSteps(e.target.value);
                markDirty();
              }}
              className="h-7 w-20 rounded-md border bg-transparent px-2 text-right text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
            />
          </FieldRow>

          <div className="px-4 py-3">
            <div className="mb-1.5 text-[13px]">{t("agents.systemPrompt")}</div>
            <div className="mb-2 text-xs text-muted-foreground">
              {t("agents.systemPromptDesc")}
            </div>
            <TextArea
              value={prompt}
              placeholder={t("agents.systemPromptPlaceholder")}
              rows={8}
              onChange={(v) => {
                setPrompt(v);
                markDirty();
              }}
            />
          </div>

          <div className="flex items-center gap-2 px-4 py-2.5">
            <Button variant="accent" disabled={!dirty} onClick={() => void handleSave()}>
              {t("agents.save")}
            </Button>
            <Button disabled={!isCustomEditingExisting} onClick={() => void handleDelete()}>
              {t("agents.delete")}
            </Button>
            <Button onClick={clearForm}>{t("agents.new")}</Button>
            {status && (
              <span className={`ml-1 text-[12px] ${statusColor(statusLevel)}`}>{status}</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function AgentsPanel() {
  const t = useT();
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [cache, setCache] = useState<CustomAgentsPayload>({ path: "", agents: [] });
  const [cachePath, setCachePath] = useState("");
  const [loading, setLoading] = useState(false);

  // ── Default agent (agent-settings blob) ──────────────────────────────────
  const [defaultAgent, setDefaultAgent] = useState("");

  // ── Output style (agent-settings blob) ───────────────────────────────────
  const [outputStyle, setOutputStyle] = useState("default");
  const [outputStyleCustom, setOutputStyleCustom] = useState("");
  const [styleDirty, setStyleDirty] = useState(false);
  const [styleStatus, setStyleStatus] = useState("");

  // ── Fork-mode subagents (engine config global.subagent.forkEnabled) ──────
  const [engineConfig, setEngineConfig] = useState<EngineConfigPayload | null>(null);
  const [forkEnabled, setForkEnabled] = useState(true);
  const [forkDirty, setForkDirty] = useState(false);
  const [forkStatus, setForkStatus] = useState("");
  const [forkStatusLevel, setForkStatusLevel] = useState<StatusLevel>("info");

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const [profilesPayload, customPayload] = await Promise.all([
        bridge().listAgentProfiles() as Promise<AgentProfileSummary[]>,
        bridge().readCustomAgents() as Promise<CustomAgentsPayload>,
      ]);
      const allProfiles = Array.isArray(profilesPayload) ? profilesPayload : [];
      // hidden profiles excluded from every user-facing list
      setProfiles(allProfiles.filter((p) => !p.hidden));
      const cp = customPayload ?? { path: "", agents: [] };
      setCache(cp);
      setCachePath(cp.path ?? "");
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  // Pull the persisted default-agent + output-style choices from the shared
  // agent-settings blob the composer writes.
  const loadAgentSettings = useCallback(async () => {
    const saved = await readAgentSettings();
    if (typeof saved.agent === "string") setDefaultAgent(saved.agent);
    setOutputStyle(typeof saved.outputStyle === "string" ? saved.outputStyle : "default");
    setOutputStyleCustom(typeof saved.outputStyleCustom === "string" ? saved.outputStyleCustom : "");
    setStyleDirty(false);
    setStyleStatus("");
  }, []);

  // Fork toggle reads from the global effective config — default ON when the
  // field is missing (undefined !== false), matching the engine default.
  const loadEngineConfig = useCallback(async () => {
    const cwd = await getWorkspaceCwd();
    try {
      const payload = (await bridge().readEngineConfig(cwd)) as EngineConfigPayload;
      setEngineConfig(payload);
      // Read the GLOBAL value, not the merged `effective` one: this toggle saves
      // to global scope, so reading effective would let a workspace override mask
      // the just-saved value and make Save appear to do nothing.
      const globalCfg = (payload.global ?? {}) as { subagent?: { forkEnabled?: boolean } };
      setForkEnabled(globalCfg.subagent?.forkEnabled !== false);
      setForkDirty(false);
      setForkStatus("");
    } catch {
      // best-effort; leave defaults
    }
  }, []);

  useEffect(() => {
    void loadAgents();
    void loadAgentSettings();
    void loadEngineConfig();
  }, [loadAgents, loadAgentSettings, loadEngineConfig]);

  function handleSaved(next: CustomAgentsPayload) {
    setCache(next);
    setCachePath(next.path ?? "");
    void loadAgents();
  }

  // Default agent auto-saves on change (no Save button), mirroring the legacy
  // composer's setAgent — it persists into the agent-settings blob.
  async function handleDefaultAgentChange(name: string) {
    setDefaultAgent(name);
    await patchAgentSettings({ agent: name });
  }

  function markStyleDirty() {
    setStyleDirty(true);
    setStyleStatus("");
  }

  async function handleSaveOutputStyle() {
    await patchAgentSettings({
      outputStyle,
      outputStyleCustom,
    });
    setStyleDirty(false);
    setStyleStatus(t("agents.saved"));
  }

  async function handleSaveFork() {
    const cwd = await getWorkspaceCwd();
    // Pinned to the GLOBAL config — fork-mode is a per-user preference, not
    // per-workspace (matches legacy saveForkEnabled) — so it never needs an open
    // workspace; the IPC layer resolves the global path regardless of cwd.
    const current = (engineConfig?.global ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...current,
      subagent: {
        ...((current.subagent ?? {}) as Record<string, unknown>),
        forkEnabled,
      },
    };
    try {
      await bridge().writeEngineConfig(cwd || "", "global", next);
      setForkDirty(false);
      setForkStatus(
        forkEnabled
          ? t("agents.forkEnabledStatus")
          : t("agents.forkDisabledStatus"),
      );
      setForkStatusLevel("success");
      await loadEngineConfig();
    } catch (err: unknown) {
      setForkStatus(err instanceof Error ? err.message : String(err));
      setForkStatusLevel("error");
    }
  }

  // Keep the dropdown coherent: if the persisted agent isn't among the visible
  // profiles, fall back to the first profile for display.
  const defaultAgentValue =
    profiles.some((p) => p.name === defaultAgent)
      ? defaultAgent
      : profiles[0]?.name ?? "";

  return (
    <div className="pane-enter">
      <Section
        title={t("agents.defaultAgentTitle")}
        description={t("agents.defaultAgentDesc")}
      >
        <FieldRow label={t("agents.defaultAgentLabel")} hint={t("agents.defaultAgentHint")}>
          <Select
            value={defaultAgentValue}
            options={profiles.map((p) => ({
              value: p.name,
              label: `${p.name}${p.mode === "subagent" ? " (subagent)" : ""}`,
            }))}
            onChange={(v) => void handleDefaultAgentChange(v)}
          />
        </FieldRow>
      </Section>

      <Section
        title={t("agents.outputStyleTitle")}
        description={t("agents.outputStyleDesc")}
      >
        <FieldRow
          label={t("agents.defaultStyleLabel")}
          hint={t("agents.defaultStyleHint")}
        >
          <Select
            value={outputStyle}
            options={OUTPUT_STYLE_OPTIONS.map((o) => ({
              value: o.value,
              label: t(`agents.outputStyleOption.${o.value}`),
            }))}
            onChange={(v) => {
              setOutputStyle(v);
              markStyleDirty();
            }}
          />
        </FieldRow>
        <div className="px-4 py-3">
          <div className="mb-1.5 text-[13px]">{t("agents.customDirective")}</div>
          <div className="mb-2 text-xs text-muted-foreground">
            {t("agents.customDirectiveDesc")}
          </div>
          <TextArea
            value={outputStyleCustom}
            placeholder={t("agents.customDirectivePlaceholder")}
            rows={4}
            onChange={(v) => {
              setOutputStyleCustom(v);
              markStyleDirty();
            }}
          />
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <Button variant="accent" disabled={!styleDirty} onClick={() => void handleSaveOutputStyle()}>
            {t("agents.save")}
          </Button>
          {styleStatus && (
            <span className="ml-1 text-[12px] text-success-foreground">{styleStatus}</span>
          )}
        </div>
      </Section>

      <Section
        title={t("agents.forkTitle")}
        description={t("agents.forkDesc")}
      >
        <FieldRow
          label={t("agents.forkEnableLabel")}
          hint={t("agents.forkEnableHint")}
        >
          <Toggle
            checked={forkEnabled}
            onChange={(v) => {
              setForkEnabled(v);
              setForkDirty(true);
              setForkStatus("");
            }}
          />
        </FieldRow>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <Button variant="accent" disabled={!forkDirty} onClick={() => void handleSaveFork()}>
            {t("agents.save")}
          </Button>
          {forkStatus && (
            <span className={`ml-1 text-[12px] ${statusColor(forkStatusLevel)}`}>{forkStatus}</span>
          )}
        </div>
      </Section>

      <Section
        title={t("agents.customTitle")}
        description={t("agents.customDesc")}
      >
        <div className="px-4 py-3">
          <div className="mb-3 flex items-center justify-between">
            {cachePath && (
              <span className="font-mono text-[11px] text-muted-foreground">{cachePath}</span>
            )}
            <Button onClick={() => void loadAgents()} disabled={loading}>
              {loading ? t("agents.loading") : t("agents.refresh")}
            </Button>
          </div>

          <AgentEditor profiles={profiles} cache={cache} onSaved={handleSaved} />
        </div>
      </Section>
    </div>
  );
}
