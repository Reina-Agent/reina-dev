// Agent settings store — React port of the legacy actions/agent-config.js
// composer-picker state (model / permission-mode + effort / session-modes /
// agent). External store via useSyncExternalStore, same shape/lifecycle as
// sessionStore.ts. Faithful behavioral port: loads the persisted
// "agent-settings" store on init, applies changes to the live session via
// invoke("update_session_config", ...), and re-persists on every mutation
// exactly like legacy persistAgentSettings.
//
// The model-tag / sorting helpers are ported verbatim from the legacy
// renderer/model-ui.js so the "more models" modal groups/filters/tags
// identically without depending on the legacy plain-JS module.

import { useSyncExternalStore } from "react";
import { bridge } from "~/lib/bridge";
import { getMainState } from "./sessionStore";

// ── Permission modes (mirror legacy PERMISSION_MODES) ───────────────────────

export interface PermissionMode {
  id: string;
  label: string;
  short: string;
  description: string;
  icon: string;
  engine: string;
}

export const PERMISSION_MODES: PermissionMode[] = [
  {
    id: "ask",
    label: "Ask before edits",
    short: "Ask",
    description: "Asks before every edit.",
    icon: "hand",
    engine: "default",
  },
  {
    id: "plan",
    label: "Plan before edits",
    short: "Plan",
    description: "Explore read-only and propose a plan before editing.",
    icon: "lightbulb",
    engine: "plan",
  },
  {
    id: "auto-edit",
    label: "Edit automatically",
    short: "Auto-edit",
    description: "Auto-approves edits; asks on risky commands.",
    icon: "edit",
    engine: "accept-edits",
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    short: "Bypass",
    description: "Runs everything without asking.",
    icon: "shield-off",
    engine: "bypass",
  },
];

// ── Effort tiers (mirror legacy EFFORT_LEVELS) ──────────────────────────────

export interface EffortLevel {
  id: string;
  label: string;
  description: string;
}

export const EFFORT_LEVELS: EffortLevel[] = [
  { id: "off", label: "Off", description: "No extended thinking. Fastest." },
  { id: "low", label: "Low", description: "Quick, shallow reasoning." },
  { id: "medium", label: "Medium", description: "Balanced thinking." },
  { id: "high", label: "High", description: "Take time to plan deeply." },
  { id: "xhigh", label: "X-High", description: "Extended reasoning beyond high (Opus 4.7+)." },
  { id: "max", label: "Max", description: "Deepest reasoning. Slowest and priciest." },
];

const normalizeEffort = (effort: string): string => (effort === "extra-high" ? "xhigh" : effort);

// ── Session modes (mirror legacy SESSION_MODE_DEFS) ─────────────────────────

export interface SessionModeDef {
  name: string;
  label: string;
  description: string;
}

export const SESSION_MODE_DEFS: SessionModeDef[] = [
  { name: "team", label: "团队模式", description: "让多个 Agent 并行协作" },
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface KnownModel {
  id: string;
  label?: string;
  provider: string;
  model: string;
  description?: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  subscriptionId?: string;
  subscriptionKind?: string;
  subscriptionEmail?: string;
  thinkingMode?: unknown;
  supportedEfforts?: unknown;
  reasoningLevels?: unknown;
  reasoningDialect?: unknown;
  offEffort?: unknown;
  authMode?: unknown;
  headers?: unknown;
  subscription?: boolean;
  [key: string]: unknown;
}

export interface AgentProfile {
  name: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface SessionModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  subscriptionId?: string;
  thinkingMode?: unknown;
  supportedEfforts?: unknown;
  reasoningLevels?: unknown;
  reasoningDialect?: unknown;
  offEffort?: unknown;
  authMode?: unknown;
  headers?: unknown;
}

export interface AgentSettings {
  agent: string;
  modeId: string;
  permissionMode: string;
  effort: string;
  modelId: string;
  model: SessionModelConfig;
  outputStyle: string;
  outputStyleCustom: string;
}

export interface AgentSettingsState {
  agentSettings: AgentSettings;
  sessionModes: Record<string, boolean>;
  agentProfiles: AgentProfile[];
  knownModels: KnownModel[];
  modelPickerPinned: Set<string>;
}

// ── Store wiring (same external-store pattern as sessionStore) ──────────────

const STORE = { name: "agent-settings", key: "current" };
const MODEL_PICKER_STORE = { name: "model-picker", key: "pinned" };

let state: AgentSettingsState = {
  agentSettings: {
    agent: "default",
    modeId: "ask",
    permissionMode: "default",
    effort: "high",
    modelId: "deterministic",
    model: { provider: "deterministic", model: "reina-deterministic" },
    outputStyle: "default",
    outputStyleCustom: "",
  },
  sessionModes: { team: false },
  agentProfiles: [],
  knownModels: [],
  modelPickerPinned: new Set<string>(),
};

const listeners = new Set<() => void>();

function set(patch: Partial<AgentSettingsState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getAgentSettingsState(): AgentSettingsState {
  return state;
}

export function useAgentSettings<T>(selector: (s: AgentSettingsState) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => selector(state),
  );
}

const api = () => bridge();

// ── Selectors (mirror legacy currentMode / currentEffort / currentModel) ────

export function currentMode(): PermissionMode {
  return PERMISSION_MODES.find((mode) => mode.id === state.agentSettings.modeId) ?? PERMISSION_MODES[0];
}

export function currentEffort(): EffortLevel {
  return EFFORT_LEVELS.find((effort) => effort.id === state.agentSettings.effort) ?? EFFORT_LEVELS[2];
}

export function currentModel(): KnownModel | undefined {
  const id = state.agentSettings.modelId;
  return state.knownModels.find((model) => model.id === id) ?? state.knownModels[0];
}

export function availableEffortLevels(model: { reasoningLevels?: unknown }): EffortLevel[] {
  const levels = model.reasoningLevels;
  return Array.isArray(levels)
    ? EFFORT_LEVELS.filter((level) => levels.includes(level.id))
    : EFFORT_LEVELS;
}

// ── Persistence (mirror legacy persistAgentSettings / persistPinnedModels) ──

async function persistAgentSettings(): Promise<void> {
  try {
    await api().storeSet(STORE.name, STORE.key, JSON.stringify(state.agentSettings));
  } catch (error) {
    console.error("persistAgentSettings failed", error);
  }
}

async function persistPinnedModels(): Promise<void> {
  try {
    await api().storeSet(MODEL_PICKER_STORE.name, MODEL_PICKER_STORE.key, JSON.stringify([...state.modelPickerPinned]));
  } catch {
    /* ignore */
  }
}

// ── Live session push (mirror legacy applyLiveSessionUpdate) ────────────────

function applyLiveSessionUpdate(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = getMainState().sessionId;
  if (!sessionId) return Promise.resolve();
  return api()
    .invoke("update_session_config", { sessionId, ...payload })
    .catch(() => undefined);
}

// ── Mutations (mirror legacy setMode / setEffort / setAgent / setSessionMode / setModel) ──

export function setMode(modeId: string): void {
  const mode = PERMISSION_MODES.find((entry) => entry.id === modeId) ?? PERMISSION_MODES[0];
  state = {
    ...state,
    agentSettings: { ...state.agentSettings, modeId: mode.id, permissionMode: mode.engine },
  };
  emit();
  void persistAgentSettings();
  applyLiveSessionUpdate({ permissionMode: mode.engine });
}

export function setEffort(effortId: string): void {
  state = { ...state, agentSettings: { ...state.agentSettings, effort: effortId } };
  emit();
  void persistAgentSettings();
  // Effort rides on the model config, so push it to the live session as a model
  // update. Spread the current model so we don't clear baseUrl/apiKey/contextWindow.
  applyLiveSessionUpdate({ model: { ...state.agentSettings.model, reasoningEffort: effortId } });
}

export function setAgent(name: string): void {
  state = { ...state, agentSettings: { ...state.agentSettings, agent: name } };
  emit();
  void persistAgentSettings();
  applyLiveSessionUpdate({ agent: name });
}

/** Flip a session toggle (currently Team). Goal has a dedicated command and
 * lifecycle, so it is intentionally absent here. Session-scoped: no
 * persistAgentSettings — these toggles reset when the user starts a new
 * session. Returns the IPC promise so callers can await the change landing. */
export function setSessionMode(name: string, on: boolean): Promise<unknown> {
  const next = on === true;
  const current = state.sessionModes ?? {};
  if (current[name] === next) return Promise.resolve();
  state = { ...state, sessionModes: { ...current, [name]: next } };
  emit();
  return applyLiveSessionUpdate({ sessionModes: { [name]: next } });
}

export function setModel(model: KnownModel): void {
  const newModel = pickModelConfig(model);
  state = { ...state, agentSettings: { ...state.agentSettings, modelId: model.id, model: newModel } };
  emit();
  void persistAgentSettings();
  // Carry the current effort onto the live model update; otherwise switching
  // model mid-session would clear reasoningEffort on the running session.
  applyLiveSessionUpdate({ model: { ...newModel, reasoningEffort: state.agentSettings.effort } });
}

export function togglePinnedModel(modelId: string): void {
  const pinned = new Set(state.modelPickerPinned);
  if (pinned.has(modelId)) pinned.delete(modelId);
  else pinned.add(modelId);
  state = { ...state, modelPickerPinned: pinned };
  emit();
  void persistPinnedModels();
}

/** Reflect (display-only) the model + effort of the session the user just
 * switched into, so the composer's model button shows what THIS session is
 * actually bound to — not the persisted "new-session default".
 *
 * A resumed session keeps the model recorded in its rollout (including a
 * `subscriptionId` / OAuth binding). The picker was previously left on the
 * default after a load, so e.g. a session bound to a Codex/Claude subscription
 * still displayed "kimi-for-coding" — and when its OAuth token failed to
 * refresh, the 401 looked like a models.json config error even though the
 * config was correct.
 *
 * Unlike setModel this does NOT persist as the default and does NOT push
 * update_session_config: we are mirroring the loaded session, not changing it.
 * The modelId only moves when a known model confidently matches (so the chip
 * label/caps resolve); otherwise it's left as-is to avoid showing knownModels[0]
 * for a baked-in model that's no longer configured. */
export function reflectSessionModel(sessionModel: unknown): void {
  if (!sessionModel || typeof sessionModel !== "object") return;
  const m = sessionModel as Record<string, unknown>;
  const provider = typeof m.provider === "string" ? m.provider : state.agentSettings.model.provider;
  const modelName = typeof m.model === "string" ? m.model : state.agentSettings.model.model;
  const subscriptionId = typeof m.subscriptionId === "string" && m.subscriptionId ? m.subscriptionId : undefined;

  const nextModel: SessionModelConfig = {
    provider,
    model: modelName,
    apiKey: typeof m.apiKey === "string" ? m.apiKey : undefined,
    baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : undefined,
    contextWindowTokens: typeof m.contextWindowTokens === "number" ? m.contextWindowTokens : undefined,
    maxOutputTokens: typeof m.maxOutputTokens === "number" ? m.maxOutputTokens : undefined,
    subscriptionId,
    thinkingMode: m.thinkingMode,
    supportedEfforts: m.supportedEfforts,
    reasoningLevels: m.reasoningLevels,
    reasoningDialect: m.reasoningDialect,
    offEffort: m.offEffort,
    authMode: m.authMode,
    headers: m.headers,
  };

  // Match a subscription by its account id; otherwise match a plain model by
  // provider+model identity (excluding subscription entries). Only adopt the
  // matched id — currentModel() falls back to knownModels[0] for an unknown id,
  // which would mislabel just as badly as the stale default.
  const candidates = state.knownModels.filter((k) => subscriptionId
    ? k.subscriptionId === subscriptionId
    : !k.subscriptionId && k.provider === provider && k.model === modelName);
  const exact = candidates.filter((k) => k.baseUrl === nextModel.baseUrl && k.apiKey === nextModel.apiKey);
  const match = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
  const modelId = match ? match.id : state.agentSettings.modelId;

  const effort =
    typeof m.reasoningEffort === "string" ? normalizeEffort(m.reasoningEffort) : state.agentSettings.effort;

  state = {
    ...state,
    agentSettings: { ...state.agentSettings, modelId, model: nextModel, effort },
  };
  emit();
}

/** Reflect (authoritative) a session's actual mode toggles onto the composer
 * "Modes" badge when switching INTO it. Session modes are session-scoped on the
 * engine (a new session starts every mode OFF) and are NOT persisted as a global
 * default — so without this the badge keeps showing whatever was last toggled in
 * a DIFFERENT session. That stale badge is the "UI says Team is ON but the engine
 * never got it" desync: the engine ran plain `default`, the toggle never landed,
 * yet the picker still read 1 active mode.
 *
 * Like reflectSessionModel this only syncs DISPLAY to the loaded session's truth;
 * it does not push an update back. Derives the flag set from SESSION_MODE_DEFS so
 * a newly added mode is covered without touching this function. */
export function reflectSessionModes(sessionModes: unknown): void {
  const src =
    sessionModes && typeof sessionModes === "object" ? (sessionModes as Record<string, unknown>) : {};
  const next: Record<string, boolean> = {};
  for (const def of SESSION_MODE_DEFS) next[def.name] = src[def.name] === true;
  const cur = state.sessionModes ?? {};
  if (SESSION_MODE_DEFS.every((d) => (cur[d.name] === true) === next[d.name])) return;
  state = { ...state, sessionModes: next };
  emit();
}

/** Reflect (display-only) a loaded session's agent + permission mode onto the
 * composer pickers — same rationale as reflectSessionModel. A resumed session
 * keeps the agent and permission mode it was created / last run with, but the
 * pickers otherwise keep showing the persisted new-session defaults. The most
 * visible cost is permission mode: the composer could show "Bypass" while the
 * session actually runs in "Ask" (or vice versa), so the user gets approval
 * prompts that don't match the composer halo. Does NOT persist or push back —
 * it mirrors the loaded session, it doesn't change it. */
export function reflectSessionAgentMode(session: unknown): void {
  if (!session || typeof session !== "object") return;
  const s = session as Record<string, unknown>;
  const patch: Partial<AgentSettings> = {};
  if (typeof s.agent === "string" && s.agent && s.agent !== state.agentSettings.agent) {
    patch.agent = s.agent;
  }
  if (typeof s.permissionMode === "string" && s.permissionMode) {
    const mode = PERMISSION_MODES.find((m) => m.engine === s.permissionMode);
    if (mode && mode.id !== state.agentSettings.modeId) {
      patch.modeId = mode.id;
      patch.permissionMode = mode.engine;
    }
  }
  if (typeof s.outputStyle === "string") patch.outputStyle = s.outputStyle;
  if (typeof s.outputStyleCustom === "string") patch.outputStyleCustom = s.outputStyleCustom;
  if (Object.keys(patch).length === 0) return;
  state = { ...state, agentSettings: { ...state.agentSettings, ...patch } };
  emit();
}

function emit(): void {
  for (const fn of listeners) fn();
}

// ── Load (mirror legacy loadAgentSettings — assemble the known-models list,
//    hydrate the persisted settings, and apply migration guards) ────────────

function subscriptionKindToProvider(kind: string): string {
  // Kimi rides the Anthropic-compatible Messages endpoint (main-process
  // resolveSubscriptionModel pins its baseUrl + bearer auth mode).
  if (kind === "openai-codex") return "openai-codex-responses";
  return "anthropic-messages";
}

export async function loadAgentSettings(): Promise<void> {
  const [rawSettings, profiles, models, rawPinned] = await Promise.all([
    api().storeGet(STORE.name, STORE.key).catch(() => null),
    api().listAgentProfiles().catch(() => []),
    api().listKnownModels().catch(() => []),
    api().storeGet(MODEL_PICKER_STORE.name, MODEL_PICKER_STORE.key).catch(() => null),
  ]);
  const agentProfiles: AgentProfile[] = Array.isArray(profiles) ? (profiles as AgentProfile[]) : [];

  let modelPickerPinned: Set<string>;
  try {
    const pinned = rawPinned ? JSON.parse(rawPinned) : [];
    modelPickerPinned = new Set(Array.isArray(pinned) ? pinned.filter((id: unknown): id is string => typeof id === "string") : []);
  } catch {
    modelPickerPinned = new Set();
  }

  const builtins: KnownModel[] = Array.isArray(models) ? (models as KnownModel[]) : [];

  // Layer in user-defined models (workspace + global merge).
  let customModels: KnownModel[] = [];
  try {
    const cwd = getMainState().workspaceCwd ?? (await api().invoke("default_cwd").catch(() => undefined));
    const payload = (await api().readCustomModels(cwd as string | undefined)) as { effective?: KnownModel[] } | null;
    customModels = Array.isArray(payload?.effective) ? payload!.effective : [];
  } catch {
    customModels = [];
  }

  // Connected subscription accounts (OAuth-backed Claude/Codex), surfaced as
  // selectable models. No apiKey — the main process injects a token at session
  // start via subscriptionId.
  let subscriptions: Array<Record<string, unknown>> = [];
  try {
    const subs = await api().listSubscriptions();
    subscriptions = Array.isArray(subs) ? (subs as Array<Record<string, unknown>>) : [];
  } catch {
    subscriptions = [];
  }

  const byId = new Map<string, KnownModel>();
  for (const m of builtins) byId.set(m.id, m);
  for (const m of customModels) byId.set(m.id, m);
  for (const s of subscriptions) {
    const id = `subscription:${s.id}`;
    byId.set(id, {
      id,
      label: s.label as string | undefined,
      provider: subscriptionKindToProvider(s.kind as string),
      model: (s.model as string) || "",
      subscriptionId: s.id as string,
      subscriptionKind: s.kind as string,
      subscriptionEmail: s.email as string | undefined,
      ...(s.contextTokens ? { contextWindowTokens: s.contextTokens as number } : {}),
      subscription: true,
    });
  }
  const knownModels = [...byId.values()];

  let next: AgentSettings = { ...state.agentSettings };

  let saved: Partial<AgentSettings> | null = null;
  if (rawSettings) {
    try {
      saved = JSON.parse(rawSettings) as Partial<AgentSettings>;
    } catch {
      saved = null;
    }
  }
  if (saved && typeof saved === "object") {
    next = {
      agent: typeof saved.agent === "string" ? saved.agent : next.agent,
      modeId: typeof saved.modeId === "string" ? saved.modeId : next.modeId,
      permissionMode: typeof saved.permissionMode === "string" ? saved.permissionMode : next.permissionMode,
      effort: typeof saved.effort === "string" ? normalizeEffort(saved.effort) : next.effort,
      modelId: typeof saved.modelId === "string" ? saved.modelId : next.modelId,
      model: saved.model && typeof saved.model === "object" ? saved.model : next.model,
      outputStyle: typeof saved.outputStyle === "string" ? saved.outputStyle : next.outputStyle,
      outputStyleCustom: typeof saved.outputStyleCustom === "string" ? saved.outputStyleCustom : next.outputStyleCustom,
    };
  }

  // Migrate legacy permissionMode-only saves to the ui mode + engine mode pair.
  if (!PERMISSION_MODES.some((mode) => mode.id === next.modeId)) {
    const legacyEngine = next.permissionMode;
    const fallback = PERMISSION_MODES.find((mode) => mode.engine === legacyEngine) ?? PERMISSION_MODES[0];
    next.modeId = fallback.id;
    next.permissionMode = fallback.engine;
  } else {
    const mode = PERMISSION_MODES.find((m) => m.id === next.modeId);
    if (mode) next.permissionMode = mode.engine;
  }
  if (!EFFORT_LEVELS.some((effort) => effort.id === next.effort)) {
    next.effort = "high";
  }
  if (!agentProfiles.some((profile) => profile.name === next.agent)) {
    next.agent = agentProfiles[0]?.name || "default";
  }

  // Smart default: prefer the first real (non-deterministic) model when one is
  // configured. Applies when the saved modelId is missing, "deterministic", or
  // points to a model that no longer exists.
  const realModels = knownModels.filter((m) => m.id !== "deterministic");
  const savedExists = knownModels.some((m) => m.id === next.modelId);
  const savedIsDefault = next.modelId === "deterministic" || !next.modelId;
  if (realModels.length > 0 && (savedIsDefault || !savedExists)) {
    next.modelId = realModels[0].id;
  }
  const match = knownModels.find((model) => model.id === next.modelId);
  if (match) {
    next.model = pickModelConfig(match);
  } else if (knownModels[0]) {
    const first = knownModels[0];
    next.modelId = first.id;
    next.model = pickModelConfig(first);
  }

  set({ agentSettings: next, agentProfiles, knownModels, modelPickerPinned });
  // Catalog/default edits refresh the choices. An existing session remains
  // authoritative for what the composer is actually running.
  const active = getMainState().activeSession;
  if (active) {
    reflectSessionModel(active.model);
    reflectSessionAgentMode(active);
  }
}

export function pickModelConfig(model: SessionModelConfig): SessionModelConfig {
  return {
    provider: model.provider,
    model: model.model,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    subscriptionId: model.subscriptionId,
    thinkingMode: model.thinkingMode,
    supportedEfforts: model.supportedEfforts,
    reasoningLevels: model.reasoningLevels,
    reasoningDialect: model.reasoningDialect,
    offEffort: model.offEffort,
    authMode: model.authMode,
    headers: model.headers,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Model-tag / sort helpers — ported verbatim from legacy renderer/model-ui.js
// so the "more models" modal groups/filters/tags identically.
// ────────────────────────────────────────────────────────────────────────────

// Model-tag / capability heuristics live in the shared, dependency-free
// ~/lib/modelCapabilities so the settings Models browser can reuse them without
// importing this main-window store module. Re-exported here so existing
// importers (ComposerPickers) keep their import path.
export type { ModelTagDef } from "~/lib/modelCapabilities";
export {
  MODEL_TAGS,
  getModelTagKeys,
  modelMatchesTags,
  modelMatchesQuery,
} from "~/lib/modelCapabilities";

export function providerBucketLabel(model: KnownModel): string {
  const provider = model?.provider || "unknown";
  if (model?.subscription) return "订阅账号";
  if (model?.baseUrl) {
    try {
      return `${provider} - ${new URL(model.baseUrl).host}`;
    } catch {
      return `${provider} - custom`;
    }
  }
  return provider;
}

export function sortModels(models: KnownModel[]): KnownModel[] {
  return [...models].sort((a, b) => {
    const pa = providerBucketLabel(a).localeCompare(providerBucketLabel(b));
    if (pa !== 0) return pa;
    return String(a.label || a.model || a.id || "").localeCompare(String(b.label || b.model || b.id || ""));
  });
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}
