import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ReasoningEffort } from "@reina/protocol";
import { bridge } from "~/lib/bridge";
import { useT } from "~/lib/i18n";
import { ResizeHandle } from "~/components/ResizeHandle";
import { Button, Select } from "~/components/ui";
import { usePromptDialog } from "~/components/PromptDialog";
import { useContextMenu } from "~/components/ContextMenu";
import { useConfirmDialog } from "~/components/ConfirmDialog";
import { ProviderLogo } from "~/components/ProviderLogo";
import { ProviderLogoPicker } from "~/components/ProviderLogoPicker";
import { isProviderLogo, readProviderLogo } from "~/lib/providerLogoUpload";
import { isProviderBrand, type ProviderBrand } from "~/lib/providerBrands";
import {
  MODEL_TAGS,
  getModelTagKeys,
  modelMatchesQuery,
  modelMatchesTags,
} from "~/lib/modelCapabilities";

// ---------------------------------------------------------------------------
// Types (public view of ~/.reina/models.json entries + bridge payloads)
// ---------------------------------------------------------------------------

interface ModelEntry {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindowTokens?: number;
  // Capability fields the models.dev pre-fill can populate (see
  // apps/desktop/src/main/models-dev.ts; parsed/sanitized in custom-models.ts).
  maxOutputTokens?: number;
  thinkingMode?: "adaptive" | "budget";
  supportedEfforts?: ReasoningEffort[];
  reasoningLevels?: ReasoningEffort[];
  reasoningDialect?: "openai" | "deepseek" | "kimi" | "qwen" | "openrouter";
  offEffort?: "none";
  authMode?: "api-key" | "oauth" | "bearer";
  headers?: Record<string, string>;
  description?: string;
}

interface CustomModelsPayload {
  workspacePath?: string;
  globalPath?: string;
  workspace?: ModelEntry[];
  global?: ModelEntry[];
  effective?: ModelEntry[];
}

interface ProviderConfig {
  /** Stable key: either "draft:<ts>" for unsaved entries or "<provider>|<baseUrl>" */
  key: string;
  label: string;
  provider: "openai-chat" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  logoDataUrl?: string;
  logoBrand?: ProviderBrand;
  /** Write-only: never rendered back from persisted state. Empty = not configured. */
  apiKeySet: boolean;
  contextWindowK: string; // k-tokens string, empty = unset
  models: ModelEntry[];
}

// Protocol ids stay the stored values; the labels say what each one actually
// speaks so "which one do I pick for an OpenAI-compatible endpoint" answers
// itself.
const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions (openai-chat)" },
  { value: "openai-responses", label: "OpenAI Responses (openai-responses)" },
  { value: "anthropic-messages", label: "Anthropic Messages (anthropic-messages)" },
];

const PROVIDER_STORE = { name: "model-providers", key: "sources" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerBucketKey(provider: string, baseUrl: string): string {
  const host = (baseUrl || "").replace(/\/+$/, "");
  return `${provider}|${host}`;
}

function providerBucketLabel(provider: string, baseUrl: string): string {
  if (!baseUrl) return provider;
  try {
    const h = new URL(baseUrl).host;
    return `${provider} — ${h}`;
  } catch {
    return `${provider} — ${baseUrl}`;
  }
}

/** Placeholder label for a freshly-added provider when the user didn't type a
 * custom name; replaced by the derived "provider — host" label on first save. */
const DRAFT_LABEL = "New provider";

function modelFamilyName(modelId: string): string {
  // e.g. "gpt-4o-mini-2024-07-18" → "gpt-4o"
  const parts = modelId.split(/[-./]/);
  if (parts.length >= 2) return parts.slice(0, 2).join("-");
  return modelId;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function buildModelId(provider: string, baseUrl: string, modelId: string): string {
  let hostPart = "";
  if (baseUrl) {
    try { hostPart = slugify(new URL(baseUrl).host || baseUrl); } catch { hostPart = slugify(baseUrl); }
  }
  return slugify([provider, hostPart, modelId].filter(Boolean).join("-")) || slugify(`${provider}-${modelId}`);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Inline status line — info / success / error */
function StatusLine({ text, isError }: { text: string; isError?: boolean }) {
  if (!text) return null;
  return (
    <span className={`text-xs ${isError ? "text-destructive" : "text-muted-foreground"}`}>
      {text}
    </span>
  );
}

/** Simple grouped list of model IDs that can be toggled on/off */
function ModelPickerModal({
  providerLabel,
  remoteIds,
  enabledModels,
  onEnable,
  onDisable,
  onClose,
}: {
  providerLabel: string;
  remoteIds: string[];
  enabledModels: ModelEntry[];
  onEnable: (id: string) => Promise<void>;
  onDisable: (model: ModelEntry) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = remoteIds.filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase()));

  // Group by family prefix
  const grouped = new Map<string, string[]>();
  for (const id of visible) {
    const fam = modelFamilyName(id);
    if (!grouped.has(fam)) grouped.set(fam, []);
    grouped.get(fam)!.push(id);
  }

  function isEnabled(id: string) {
    return enabledModels.some((m) => m.model === id);
  }

  async function toggle(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      const existing = enabledModels.find((m) => m.model === id);
      if (existing) await onDisable(existing);
      else await onEnable(id);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-[520px] max-h-[80vh] flex-col rounded-xl border bg-card shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{t("models.pickerTitle", { provider: providerLabel })}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t("models.pickerDesc")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors duration-(--motion-fast) hover:text-foreground"
            aria-label={t("models.close")}
          >
            ✕
          </button>
        </div>
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("models.filterPlaceholder")}
            autoFocus
            spellCheck={false}
            className="h-7 flex-1 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="text-xs text-muted-foreground">{visible.length}/{remoteIds.length}</span>
        </div>
        {/* List */}
        <div className="flex-1 overflow-y-auto p-2">
          {[...grouped.entries()].map(([fam, ids]) => (
            <div key={fam} className="mb-3">
              <div className="mb-1 flex items-center gap-2 px-2">
                <span className="text-xs font-medium text-muted-foreground">{fam}</span>
                <span className="text-xs text-muted-foreground">({ids.length})</span>
              </div>
              {ids.map((id) => {
                const enabled = isEnabled(id);
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={busy === id}
                    onClick={() => void toggle(id)}
                    className={
                      "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12.5px] transition-colors duration-(--motion-fast) hover:bg-secondary disabled:opacity-50 " +
                      (enabled ? "text-foreground" : "text-muted-foreground")
                    }
                  >
                    <span className="font-mono">{id}</span>
                    <span className={`text-xs font-medium ${enabled ? "text-primary" : "text-muted-foreground"}`}>
                      {enabled ? t("models.modelEnabled") : "+"}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {visible.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">{t("models.noMatches")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dialog to manually add a model by ID */
function ManualModelDialog({
  providerLabel,
  onAdd,
  onClose,
}: {
  providerLabel: string;
  onAdd: (modelId: string, customLabel: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = modelId.trim();
    if (!id) { setStatus(t("models.modelIdRequired")); return; }
    setBusy(true);
    setStatus("");
    try {
      await onAdd(id, label.trim());
      onClose();
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[400px] rounded-xl border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{t("models.addManualTitle")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{providerLabel}</div>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label={t("models.close")}>✕</button>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">{t("models.modelIdLabel")}</label>
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              autoFocus
              spellCheck={false}
              placeholder="e.g. glm-4-plus"
              className="h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">{t("models.displayNameLabel")}</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              spellCheck={false}
              placeholder={t("models.displayNamePlaceholder")}
              className="h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <StatusLine text={status} isError />
            <Button onClick={() => void submit()} disabled={busy} variant="accent">{t("models.add")}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider config panel (right pane)
// ---------------------------------------------------------------------------

function ProviderConfigPane({
  bucket,
  enabledModels,
  onSaved,
  onModelEnabled,
  onModelDisabled,
  onModelRename,
  onPrefill,
  resolveStoredKey,
  onLogoChanged,
}: {
  bucket: ProviderConfig | null;
  enabledModels: ModelEntry[];
  onSaved: (patch: { provider: string; baseUrl: string; apiKey: string; contextWindowK: string }) => Promise<void>;
  onModelEnabled: (modelId: string, label: string) => Promise<void>;
  onModelDisabled: (model: ModelEntry) => Promise<void>;
  onModelRename: (model: ModelEntry) => void;
  onPrefill: () => Promise<number>;
  resolveStoredKey: (provider: string, baseUrl: string) => Promise<string | undefined>;
  onLogoChanged: (bucket: ProviderConfig, logo: { logoDataUrl?: string; logoBrand?: ProviderBrand }) => Promise<void>;
}) {
  const t = useT();
  const { open: openModelMenu, element: modelMenuElement } = useContextMenu();
  const [provider, setProvider] = useState(bucket?.provider ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(bucket?.baseUrl ?? "");
  // The key field is pre-filled with the stored key (shown masked) when a
  // provider is selected; the eye toggle reveals it, editing replaces it.
  const [apiKey, setApiKey] = useState("");
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [contextWindowK, setContextWindowK] = useState(bucket?.contextWindowK ?? "");
  // Last-saved form values — the reference `dirty` compares against, refreshed
  // on bucket switch and successful save. apiKey starts "" and is bumped when
  // the stored key is pre-filled so the prefill itself doesn't read as dirty.
  const [savedSnap, setSavedSnap] = useState<{
    provider: string;
    baseUrl: string;
    apiKey: string;
    contextWindowK: string;
  } | null>(null);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [probeStatus, setProbeStatus] = useState("");
  const [probeError, setProbeError] = useState(false);
  const [probing, setProbing] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [fetchError, setFetchError] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [prefillStatus, setPrefillStatus] = useState("");
  const [prefillError, setPrefillError] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [logoPickerOpen, setLogoPickerOpen] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoStatus, setLogoStatus] = useState("");
  const [logoError, setLogoError] = useState(false);
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  const [showManual, setShowManual] = useState(false);
  // Per-model probe: at most one result shown at a time, keyed by model id.
  const [modelTest, setModelTest] = useState<{ id: string; state: "running" | "ok" | "error"; text?: string } | null>(null);
  // Monotonic probe token: a slow earlier probe resolving late must not
  // overwrite the state of a newer probe the user has since started.
  const modelTestSeq = useRef(0);

  // Model browser filters (mirror legacy: model query + capability tag set).
  const [modelQuery, setModelQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const toggleTag = (key: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Reset form when bucket changes
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bucket || bucket.key === prevKeyRef.current) return;
    prevKeyRef.current = bucket.key;
    setProvider(bucket.provider);
    setBaseUrl(bucket.baseUrl);
    setKeyRevealed(false);
    // Pre-fill the field with the stored key (shown masked) so a configured
    // provider doesn't look empty. Loaded async + guarded so a fast provider
    // switch can't drop the previous provider's key into this one.
    setApiKey("");
    if (bucket.apiKeySet) {
      const targetKey = bucket.key;
      void resolveStoredKey(bucket.provider, bucket.baseUrl).then((stored) => {
        if (stored && prevKeyRef.current === targetKey) {
          setApiKey(stored);
          setSavedSnap((snap) => (snap ? { ...snap, apiKey: stored } : snap));
        }
      });
    }
    setContextWindowK(bucket.contextWindowK);
    setSavedSnap({
      provider: bucket.provider,
      baseUrl: bucket.baseUrl,
      apiKey: "",
      contextWindowK: bucket.contextWindowK,
    });
    setSaveStatus("");
    setSaveError(false);
    setProbeStatus("");
    setProbeError(false);
    setFetchStatus("");
    setFetchError(false);
    setPrefillStatus("");
    setPrefillError(false);
    setLogoStatus("");
    setLogoError(false);
    setLogoPickerOpen(false);
  }, [bucket]);

  async function changeLogo(choice?: File | ProviderBrand) {
    if (!bucket || logoBusy) return;
    const target = bucket;
    setLogoBusy(true);
    setLogoStatus("");
    setLogoError(false);
    try {
      const logoBrand = typeof choice === "string" ? choice : undefined;
      const logoDataUrl = choice && typeof choice !== "string" ? await readProviderLogo(choice) : undefined;
      await onLogoChanged(target, { logoBrand, logoDataUrl });
      if (prevKeyRef.current === target.key) {
        setLogoStatus(t("models.saved"));
        setLogoPickerOpen(false);
      }
    } catch (error) {
      if (prevKeyRef.current === target.key) {
        const key = error instanceof Error ? error.message : "";
        setLogoError(true);
        setLogoStatus(t(key === "models.logoInvalidImage" || key === "models.logoTooLarge" ? key : "models.logoSaveFailed"));
      }
    } finally {
      setLogoBusy(false);
    }
  }

  if (!bucket) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-xs text-muted-foreground">{t("models.selectProvider")}</span>
      </div>
    );
  }

  function endpointPreview() {
    const base = (baseUrl || "").replace(/\/+$/, "") || t("models.defaultEndpoint");
    if (provider === "anthropic-messages") return `${base}/messages`;
    if (provider === "openai-responses") return `${base}/responses`;
    return `${base}/chat/completions`;
  }

  async function handleSave() {
    setSaveStatus("");
    setSaveError(false);
    try {
      await onSaved({ provider, baseUrl, apiKey, contextWindowK });
      setSavedSnap({ provider, baseUrl, apiKey, contextWindowK });
      const savedMsg = t("models.saved");
      setSaveStatus(savedMsg);
      setSaveError(false);
      // Success confirmation fades after a beat; errors stay until resolved.
      window.setTimeout(() => setSaveStatus((s) => (s === savedMsg ? "" : s)), 2500);
      // Keep the key in the field (masked) so the saved credential stays visible.
    } catch (err: unknown) {
      setSaveStatus(err instanceof Error ? err.message : String(err));
      setSaveError(true);
    }
  }

  async function toggleKeyReveal() {
    // Lazily pull the stored key into the field the first time it's revealed, so
    // the write-only field stays blank (and the secret out of the DOM) until the
    // user actually asks to see it.
    if (!keyRevealed && !apiKey) {
      const stored = await resolveStoredKey(provider, baseUrl);
      if (stored) setApiKey(stored);
    }
    setKeyRevealed((v) => !v);
  }

  async function handleProbe() {
    setProbing(true);
    setProbeStatus("");
    setProbeError(false);
    const start = performance.now();
    try {
      // Fall back to the already-stored key when the write-only field is blank.
      const key = apiKey || (await resolveStoredKey(provider, baseUrl)) || undefined;
      const result = await bridge().probeRemoteConnection({ provider, baseUrl: baseUrl || undefined, apiKey: key, authMode: bucket?.models[0]?.authMode, headers: bucket?.models[0]?.headers }) as { latencyMs?: number; httpStatus?: number; modelsCount?: number } | null;
      const ms = result?.latencyMs ?? Math.round(performance.now() - start);
      const httpPart = result?.httpStatus ? `, HTTP ${result.httpStatus}` : "";
      const modelsPart = typeof result?.modelsCount === "number" ? `, ${t("models.probeModelsCount", { count: result.modelsCount })}` : "";
      setProbeStatus(`${t("models.probeOk", { ms })}${httpPart}${modelsPart})`);
      setProbeError(false);
    } catch (err: unknown) {
      const ms = Math.round(performance.now() - start);
      setProbeStatus(`${t("models.probeFailed", { ms })}: ${err instanceof Error ? err.message : String(err)}`);
      setProbeError(true);
    } finally {
      setProbing(false);
    }
  }

  async function handleFetch() {
    setFetching(true);
    setFetchStatus("");
    setFetchError(false);
    try {
      // Save current config first so models inherit the right credentials
      await onSaved({ provider, baseUrl, apiKey, contextWindowK });
      // Fall back to the already-stored key when the field is blank.
      const key = apiKey || (await resolveStoredKey(provider, baseUrl)) || undefined;
      const result = await bridge().fetchRemoteModels({ provider, baseUrl: baseUrl || undefined, apiKey: key, authMode: bucket?.models[0]?.authMode, headers: bucket?.models[0]?.headers }) as { models?: { id: string }[] } | null;
      const ids = (result?.models ?? []).map((m) => m.id).filter(Boolean) as string[];
      if (ids.length === 0) {
        setFetchStatus(t("models.noModelsReturned"));
        setFetchError(true);
      } else {
        setPickerIds(ids);
      }
    } catch (err: unknown) {
      setFetchStatus(err instanceof Error ? err.message : String(err));
      setFetchError(true);
    } finally {
      setFetching(false);
    }
  }

  async function handlePrefill() {
    setPrefilling(true);
    setPrefillStatus("");
    setPrefillError(false);
    try {
      const filled = await onPrefill();
      setPrefillStatus(filled > 0 ? t("models.prefillDone", { count: filled }) : t("models.prefillNone"));
      setPrefillError(false);
    } catch (err: unknown) {
      setPrefillStatus(err instanceof Error ? err.message : String(err));
      setPrefillError(true);
    } finally {
      setPrefilling(false);
    }
  }

  async function handleModelProbe(model: ModelEntry) {
    const seq = ++modelTestSeq.current;
    setModelTest({ id: model.id, state: "running" });
    const start = performance.now();
    try {
      // Fall back to the already-stored key when the write-only field is blank.
      const key = apiKey || (await resolveStoredKey(provider, baseUrl)) || undefined;
      const result = (await bridge().probeModel({
        provider,
        baseUrl: baseUrl || undefined,
        apiKey: key,
        model: model.model,
        maxOutputTokens: model.maxOutputTokens,
        thinkingMode: model.thinkingMode,
        supportedEfforts: model.supportedEfforts,
        reasoningLevels: model.reasoningLevels,
        reasoningDialect: model.reasoningDialect,
        offEffort: model.offEffort,
        authMode: model.authMode,
        headers: model.headers,
      })) as { latencyMs?: number } | null;
      if (seq !== modelTestSeq.current) return; // superseded by a newer probe
      const ms = result?.latencyMs ?? Math.round(performance.now() - start);
      setModelTest({ id: model.id, state: "ok", text: t("models.modelProbeOk", { ms }) });
    } catch (err: unknown) {
      if (seq !== modelTestSeq.current) return; // superseded by a newer probe
      const detail = err instanceof Error ? err.message : String(err);
      setModelTest({ id: model.id, state: "error", text: `${t("models.modelProbeFailed")}: ${detail}` });
    }
  }

  // Unsaved edits? Switching providers silently resets the form, so surface
  // the pending state on the Save button before the user navigates away.
  const dirty =
    !!savedSnap &&
    (provider !== savedSnap.provider ||
      baseUrl !== savedSnap.baseUrl ||
      apiKey !== savedSnap.apiKey ||
      contextWindowK !== savedSnap.contextWindowK);

  const bucketModels = enabledModels.filter(
    (m) => m.provider === bucket.provider && (m.baseUrl ?? "") === (bucket.baseUrl ?? ""),
  );

  // Apply the model query + capability-tag filters, then group by model family
  // (legacy renderModelBrowser → groupBy(modelFamilyName)).
  const visibleModels = bucketModels.filter(
    (m) => modelMatchesQuery(m, modelQuery) && modelMatchesTags(m, selectedTags),
  );
  const modelGroups = (() => {
    const map = new Map<string, ModelEntry[]>();
    for (const m of visibleModels) {
      const fam = modelFamilyName(m.model);
      if (!map.has(fam)) map.set(fam, []);
      map.get(fam)!.push(m);
    }
    return [...map.entries()];
  })();

  return (
    <div className="flex flex-1 flex-col gap-0 overflow-hidden">
      {modelMenuElement}
      <ProviderLogoPicker
        key={bucket.key}
        open={logoPickerOpen}
        identity={bucket}
        busy={logoBusy}
        error={logoError ? logoStatus : ""}
        onClose={() => setLogoPickerOpen(false)}
        onChoose={(brand) => void changeLogo(brand)}
        onUpload={(file) => void changeLogo(file)}
        onReset={() => void changeLogo()}
      />
      {/* Provider config form */}
      <div className="border-b p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => { setLogoStatus(""); setLogoError(false); setLogoPickerOpen(true); }}
              disabled={logoBusy}
              title={t("models.chooseLogo")}
              aria-label={t("models.chooseLogo")}
              aria-haspopup="dialog"
              className="shrink-0 rounded-lg outline-none hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ProviderLogo {...bucket} className="size-10 rounded-lg" />
            </button>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium" title={bucket.label}>{bucket.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("models.enabledModelCount", { count: bucketModels.length })}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <button type="button" disabled={logoBusy} onClick={() => { setLogoStatus(""); setLogoError(false); setLogoPickerOpen(true); }} aria-haspopup="dialog" className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                  {logoBusy ? t("models.logoSaving") : t("models.changeLogo")}
                </button>
                {logoStatus && <span role="status" className={logoError ? "text-destructive" : undefined}>{logoStatus}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && <span className="text-xs text-muted-foreground">{t("models.unsaved")}</span>}
            <Button onClick={() => void handleSave()} disabled={logoBusy} variant={dirty ? "accent" : undefined}>
              {t("models.saveConfig")}
            </Button>
            <Button onClick={() => setShowManual(true)}>{t("models.addManually")}</Button>
            <Button onClick={() => void handlePrefill()} disabled={prefilling}>
              {prefilling ? t("models.prefilling") : t("models.prefillFromModelsDev")}
            </Button>
            <Button onClick={() => void handleFetch()} disabled={fetching || logoBusy} variant="accent">
              {fetching ? t("models.fetching") : t("models.fetchModelList")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {/* Provider */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("models.provider")}</label>
            <Select
              value={provider}
              options={PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => setProvider(v as typeof provider)}
            />
          </div>

          {/* Base URL */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("models.apiBaseUrl")}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              className="h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {/* API Key — write-only */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              {t("models.apiKey")}{bucket.apiKeySet ? <span className="ml-1 text-[11px] font-medium text-muted-foreground">{t("models.stored")}</span> : ""}
            </label>
            <div className="flex items-center gap-2">
              <input
                type={keyRevealed ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                placeholder={bucket.apiKeySet ? t("models.enterNewKey") : "sk-…"}
                className="h-7 flex-1 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={() => void toggleKeyReveal()}
                title={keyRevealed ? t("models.hideKey") : t("models.showStoredKey")}
                aria-label={keyRevealed ? t("models.hideKey") : t("models.showStoredKey")}
                className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
              >
                {keyRevealed ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" x2="22" y1="2" y2="22" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
              <Button onClick={() => void handleProbe()} disabled={probing}>
                {probing ? t("models.testing") : t("models.test")}
              </Button>
            </div>
          </div>

          {/* Context window */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("models.contextWindow")}</label>
            <input
              type="number"
              value={contextWindowK}
              onChange={(e) => setContextWindowK(e.target.value)}
              min={1}
              step={1}
              placeholder="200"
              className="h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        {/* Endpoint preview + status lines */}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground font-mono">{endpointPreview()}</span>
          {saveStatus && <StatusLine text={saveStatus} isError={saveError} />}
          {probeStatus && <StatusLine text={probeStatus} isError={probeError} />}
          {fetchStatus && <StatusLine text={fetchStatus} isError={fetchError} />}
          {prefillStatus && <StatusLine text={prefillStatus} isError={prefillError} />}
        </div>
      </div>

      {/* Model browser toolbar: filter input + visible count */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <input
          type="text"
          value={modelQuery}
          onChange={(e) => setModelQuery(e.target.value)}
          placeholder={t("models.filterModels")}
          spellCheck={false}
          className="h-7 flex-1 rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
        />
        <span className="shrink-0 text-xs text-muted-foreground">{visibleModels.length}</span>
      </div>

      {/* Capability tag filters */}
      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
        {MODEL_TAGS.map((tag) => {
          const on = selectedTags.has(tag.key);
          return (
            <button
              key={tag.key}
              type="button"
              onClick={() => toggleTag(tag.key)}
              className={
                "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-(--motion-fast) " +
                (on
                  ? "border-ring bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {t(tag.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Model list — grouped by family, each row tagged with capabilities */}
      <div className="flex-1 overflow-y-auto">
        {visibleModels.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {bucketModels.length === 0
              ? t("models.emptyNoModels", { action: t("models.fetchModelList") })
              : t("models.emptyNoMatch")}
          </div>
        ) : (
          modelGroups.map(([family, models]) => (
            <section key={family}>
              <div className="flex items-center gap-2 bg-secondary/40 px-4 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{family}</span>
                <span className="text-muted-foreground/60">{models.length}</span>
              </div>
              <div className="divide-y divide-(--surface-divider)">
                {models.map((model) => (
                  <div
                    key={model.id}
                    onContextMenu={(e) =>
                      openModelMenu(e, [
                        { label: t("models.test"), onSelect: () => void handleModelProbe(model) },
                        { label: t("models.rename"), onSelect: () => onModelRename(model) },
                        { label: t("models.remove"), danger: true, onSelect: () => void onModelDisabled(model) },
                      ])
                    }
                    className="flex items-center justify-between gap-2 px-4 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px]">{model.label}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{model.model}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleModelProbe(model)}
                        disabled={modelTest?.id === model.id && modelTest.state === "running"}
                        className="text-xs text-muted-foreground transition-colors duration-(--motion-fast) hover:text-foreground disabled:opacity-60"
                        aria-label={t("models.testModel", { label: model.label })}
                      >
                        {modelTest?.id === model.id && modelTest.state === "running" ? t("models.testing") : t("models.test")}
                      </button>
                      {modelTest?.id === model.id && modelTest.state !== "running" && (
                        <span
                          title={modelTest.text}
                          className={
                            "max-w-64 truncate text-xs " +
                            (modelTest.state === "error" ? "text-destructive" : "text-muted-foreground")
                          }
                        >
                          {modelTest.text}
                        </span>
                      )}
                      {getModelTagKeys(model)
                        .slice(0, 4)
                        .map((key) => (
                          <span
                            key={key}
                            className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {(() => {
                              const def = MODEL_TAGS.find((tag) => tag.key === key);
                              return def ? t(def.labelKey) : key;
                            })()}
                          </span>
                        ))}
                      <button
                        type="button"
                        onClick={() => void onModelDisabled(model)}
                        className="text-xs text-muted-foreground transition-colors duration-(--motion-fast) hover:text-destructive"
                        aria-label={t("models.removeModel", { label: model.label })}
                      >
                        {t("models.remove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Model picker modal */}
      {pickerIds && (
        <ModelPickerModal
          providerLabel={bucket.label}
          remoteIds={pickerIds}
          enabledModels={bucketModels}
          onEnable={(id) => onModelEnabled(id, "")}
          onDisable={onModelDisabled}
          onClose={() => setPickerIds(null)}
        />
      )}

      {/* Manual add dialog */}
      {showManual && (
        <ManualModelDialog
          providerLabel={bucket.label}
          onAdd={onModelEnabled}
          onClose={() => setShowManual(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ModelsPanel() {
  const t = useT();
  const b = bridge();
  const { prompt, element: promptElement } = usePromptDialog();
  const { open: openMenu, element: menuElement } = useContextMenu();
  const { confirm, element: confirmElement } = useConfirmDialog();

  // Known models (effective = builtins merged with custom)
  const [knownModels, setKnownModels] = useState<ModelEntry[]>([]);
  const [customGlobal, setCustomGlobal] = useState<ModelEntry[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [activeModelRef, setActiveModelRef] = useState<{ provider: string; model: string } | null>(null);

  // Provider list
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");

  // Provider sidebar search
  const [providerSearch, setProviderSearch] = useState("");

  // Draggable provider-pane width (legacy .settings-model-provider-resizer:
  // persists to localStorage, clamps the pane width on drag).
  const browserRef = useRef<HTMLDivElement>(null);
  const [providerPaneWidth, setProviderPaneWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem("reina.settings.providerPaneWidth") || 0);
    return stored >= 180 && stored <= 360 ? stored : 224;
  });
  const [providerResizing, setProviderResizing] = useState(false);
  /** Detach hook for the in-flight resize's window listeners (see below). */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const startProviderResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const container = browserRef.current;
    if (!container) return;
    const left = container.getBoundingClientRect().left;
    let latest = providerPaneWidth;
    setProviderResizing(true);
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(360, Math.max(180, ev.clientX - left));
      setProviderPaneWidth(latest);
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      resizeCleanupRef.current = null;
    };
    const onUp = () => {
      setProviderResizing(false);
      detach();
      localStorage.setItem("reina.settings.providerPaneWidth", String(Math.round(latest)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    resizeCleanupRef.current = detach;
  };
  // Unmount safety net: switching panels mid-drag unmounts this component —
  // the window listeners must not keep firing setState afterwards.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // Status lines
  const [globalStatus, setGlobalStatus] = useState("");

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadCustomModels = useCallback(async () => {
    try {
      const payload = await b.readCustomModels(undefined) as CustomModelsPayload;
      const globals = payload?.global ?? [];
      setCustomGlobal(globals);
      setKnownModels(payload?.effective ?? globals);
    } catch (err: unknown) {
      setGlobalStatus(err instanceof Error ? err.message : String(err));
    }
  }, [b]);

  const loadProviderConfigs = useCallback(async () => {
    try {
      const raw = await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key) as string | null;
      if (!raw) return;
      const parsed: Array<{
        key?: string;
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
        label?: string;
        logoDataUrl?: string;
        logoBrand?: string;
        contextWindowTokens?: number;
      }> = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setProviders((prev) => {
        // Merge stored provider meta into current provider list without wiping
        // providers that come from model entries
        const byKey = new Map(prev.map((p) => [p.key, p]));
        for (const cfg of parsed) {
          const prov = (cfg.provider as ProviderConfig["provider"]) ?? "openai-chat";
          const key = cfg.key?.startsWith("draft:") ? cfg.key : providerBucketKey(prov, cfg.baseUrl ?? "");
          const existing = byKey.get(key);
          byKey.set(key, {
            key,
            label: cfg.label || providerBucketLabel(prov, cfg.baseUrl ?? ""),
            provider: prov,
            baseUrl: cfg.baseUrl ?? "",
            logoDataUrl: isProviderLogo(cfg.logoDataUrl) ? cfg.logoDataUrl : undefined,
            logoBrand: isProviderBrand(cfg.logoBrand) ? cfg.logoBrand : undefined,
            apiKeySet: Boolean(cfg.apiKey) || (existing?.apiKeySet ?? false),
            contextWindowK: cfg.contextWindowTokens ? String(Math.round(cfg.contextWindowTokens / 1000)) : (existing?.contextWindowK ?? ""),
            models: existing?.models ?? [],
          });
        }
        return [...byKey.values()];
      });
    } catch {
      // ignore parse errors
    }
  }, [b]);

  // Build provider buckets from known models
  const buildProviders = useCallback((models: ModelEntry[]) => {
    setProviders((prev) => {
      const byKey = new Map(prev.map((p) => [p.key, { ...p, models: [] as ModelEntry[] }]));
      for (const model of models) {
        if (model.id === "deterministic") continue;
        const key = providerBucketKey(model.provider, model.baseUrl ?? "");
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            label: providerBucketLabel(model.provider, model.baseUrl ?? ""),
            provider: model.provider as ProviderConfig["provider"],
            baseUrl: model.baseUrl ?? "",
            apiKeySet: Boolean(model.apiKey),
            contextWindowK: model.contextWindowTokens ? String(Math.round(model.contextWindowTokens / 1000)) : "",
            models: [],
          });
        }
        const bucket = byKey.get(key)!;
        bucket.models.push(model);
        if (!bucket.apiKeySet && model.apiKey) bucket.apiKeySet = true;
      }
      return [...byKey.values()];
    });
  }, []);

  // Resolve the ACTIVE session's model from desktop state (the old version
  // showed the first configured model, which lied whenever the user chatted on
  // anything else). model is either a models.json id string or a
  // {provider, model} ref — keep both forms for the header lookup.
  const loadActiveModel = useCallback(async () => {
    try {
      const desktop = (await b.getDesktopState()) as {
        activeSessionId?: string;
        sessions?: Array<{ id: string; model?: unknown }>;
      } | null;
      const active = desktop?.sessions?.find((s) => s.id === desktop?.activeSessionId);
      const m = active?.model;
      if (typeof m === "string" && m) {
        setActiveModelId(m);
        setActiveModelRef(null);
      } else if (m && typeof m === "object") {
        const ref = m as { provider?: string; model?: string };
        setActiveModelId("");
        setActiveModelRef({ provider: ref.provider ?? "", model: ref.model ?? "" });
      } else {
        setActiveModelId("");
        setActiveModelRef(null);
      }
    } catch {
      // best-effort
    }
  }, [b]);

  useEffect(() => {
    void loadActiveModel();
    void loadCustomModels().then(() => loadProviderConfigs());
  }, [loadActiveModel, loadCustomModels, loadProviderConfigs]);

  // Stay live: models.json edits from anywhere (this panel, the agent, a hand
  // edit — the config watcher broadcasts them all) and session switches in the
  // main window both refresh, so the panel can't go stale while open.
  useEffect(() => {
    const offModels = b.events.on("custom-models-changed", () => {
      void loadCustomModels().then(() => loadProviderConfigs());
    });
    const offActive = b.events.on("active-session", () => {
      void loadActiveModel();
    });
    return () => {
      offModels();
      offActive();
    };
  }, [b, loadCustomModels, loadProviderConfigs, loadActiveModel]);

  // Sync providers after models change
  useEffect(() => {
    buildProviders(knownModels);
  }, [knownModels, buildProviders]);

  // Auto-select first provider
  useEffect(() => {
    setSelectedKey((prev) => {
      if (prev && providers.some((p) => p.key === prev)) return prev;
      return providers[0]?.key ?? "";
    });
  }, [providers]);

  // ---------------------------------------------------------------------------
  // Provider sidebar: add
  // ---------------------------------------------------------------------------

  async function addProvider() {
    // Electron's renderer hard-disables window.prompt(), so use the in-app
    // dialog. A confirmed-but-empty name falls back to the auto-derived
    // "provider — host" label on first save; Cancel (null) aborts.
    const name = await prompt({
      title: t("models.addProviderTitle"),
      message: t("models.addProviderMessage"),
      placeholder: t("models.addProviderPlaceholder"),
      okLabel: t("models.add"),
    });
    if (name === null) return;
    const draftKey = `draft:${Date.now()}`;
    const newP: ProviderConfig = {
      key: draftKey,
      label: name || DRAFT_LABEL,
      provider: "openai-chat",
      baseUrl: "",
      apiKeySet: false,
      contextWindowK: "",
      models: [],
    };
    setProviders((prev) => [...prev, newP]);
    setSelectedKey(draftKey);
  }

  async function renameProvider(p: ProviderConfig) {
    const name = (
      await prompt({
        title: t("models.renameProviderTitle"),
        defaultValue: p.label,
        placeholder: t("models.displayName"),
        okLabel: t("models.renameAction"),
      })
    )?.trim();
    if (!name || name === p.label) return;
    setProviders((prev) => prev.map((x) => (x.key === p.key ? { ...x, label: name } : x)));
    // Upsert the label into the persisted provider store so it survives reload.
    try {
      const raw = (await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key)) as string | null;
      const list: Array<{ key?: string; provider?: string; baseUrl?: string; label?: string }> = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return;
      const idx = list.findIndex(
        (e) => e.key === p.key || providerBucketKey(e.provider ?? "openai-chat", e.baseUrl ?? "") === p.key,
      );
      if (idx >= 0) list[idx] = { ...list[idx], label: name };
      else list.push({ key: p.key, provider: p.provider, baseUrl: p.baseUrl, label: name });
      await b.storeSet(PROVIDER_STORE.name, PROVIDER_STORE.key, JSON.stringify(list));
    } catch {
      // ignore persistence errors — the in-memory rename still applies
    }
  }

  async function deleteProvider(p: ProviderConfig) {
    const owned = customGlobal.filter((m) => providerBucketKey(m.provider, m.baseUrl ?? "") === p.key);
    const message =
      owned.length > 0
        ? t("models.deleteProviderWithModels", { label: p.label, count: owned.length })
        : t("models.deleteProviderEmpty", { label: p.label });
    const ok = await confirm({ title: t("models.deleteProviderTitle"), message, confirmLabel: t("models.delete"), danger: true });
    if (!ok) return;
    // Drop its models from models.json (the file the engine reads).
    if (owned.length > 0) {
      const remaining = customGlobal.filter((m) => providerBucketKey(m.provider, m.baseUrl ?? "") !== p.key);
      await b.writeCustomModels(undefined, "global", remaining);
    }
    // Drop its entry from the provider store.
    try {
      const raw = (await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key)) as string | null;
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const next = list.filter(
            (e: { key?: string; provider?: string; baseUrl?: string }) =>
              e.key !== p.key && providerBucketKey(e.provider ?? "openai-chat", e.baseUrl ?? "") !== p.key,
          );
          await b.storeSet(PROVIDER_STORE.name, PROVIDER_STORE.key, JSON.stringify(next));
        }
      }
    } catch {
      // ignore — model removal above already detached the provider
    }
    setProviders((prev) => prev.filter((x) => x.key !== p.key));
    if (selectedKey === p.key) setSelectedKey("");
    await loadCustomModels();
  }

  // ---------------------------------------------------------------------------
  // Provider config: save
  // ---------------------------------------------------------------------------

  async function handleProviderLogoChanged(target: ProviderConfig, logo: { logoDataUrl?: string; logoBrand?: ProviderBrand }) {
    const raw = await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key);
    const list: Array<Record<string, unknown>> = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) throw new Error("models.logoSaveFailed");
    const index = list.findIndex((entry) =>
      entry.key === target.key || providerBucketKey(String(entry.provider ?? "openai-chat"), String(entry.baseUrl ?? "")) === target.key,
    );
    // Merge just the visual metadata; keep credentials and model settings intact.
    const entry: Record<string, unknown> = index >= 0 ? { ...list[index] } : {
      key: target.key, provider: target.provider, baseUrl: target.baseUrl, label: target.label,
    };
    if (logo.logoDataUrl) entry.logoDataUrl = logo.logoDataUrl;
    else delete entry.logoDataUrl;
    if (logo.logoBrand) entry.logoBrand = logo.logoBrand;
    else delete entry.logoBrand;
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    await b.storeSet(PROVIDER_STORE.name, PROVIDER_STORE.key, JSON.stringify(list));
    setProviders((prev) => prev.map((p) => p.key === target.key ? { ...p, ...logo } : p));
  }

  async function handleProviderSaved(patch: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    contextWindowK: string;
  }) {
    const prevKey = selectedKey;
    const prov = patch.provider as ProviderConfig["provider"];
    const nextKey = providerBucketKey(prov, patch.baseUrl);
    const ctxRaw = Number(patch.contextWindowK);
    const ctxTokens = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.floor(ctxRaw * 1000) : undefined;
    // Resolve the label to persist + display once, so the stored config and the
    // in-memory list stay in sync. A placeholder draft gets the derived
    // "provider — host" name; a custom-named or existing provider keeps its own.
    const prevLabel = providers.find((p) => p.key === prevKey)?.label ?? "";
    const savedLabel =
      prevKey.startsWith("draft:") && prevLabel === DRAFT_LABEL
        ? providerBucketLabel(prov, patch.baseUrl)
        : prevLabel;

    // Update models that were in the old bucket
    const nextGlobal = customGlobal.map((model) => {
      if (providerBucketKey(model.provider, model.baseUrl ?? "") !== prevKey) return model;
      const updated: ModelEntry = { ...model, provider: prov };
      if (patch.baseUrl) updated.baseUrl = patch.baseUrl; else delete updated.baseUrl;
      if (patch.apiKey) updated.apiKey = patch.apiKey; else if (!patch.apiKey && !model.apiKey) delete updated.apiKey;
      if (ctxTokens) updated.contextWindowTokens = ctxTokens; else delete updated.contextWindowTokens;
      return updated;
    });

    await b.writeCustomModels(undefined, "global", nextGlobal);

    // Persist provider config. Merge into the CURRENTLY stored list instead of
    // rebuilding it from in-memory state: ProviderConfig deliberately never
    // holds apiKey/contextWindowTokens (write-only fields), so a rebuild would
    // silently strip both from every provider except the one being saved.
    let storedList: Array<{ key?: string; provider?: string; baseUrl?: string; label?: string; apiKey?: string; contextWindowTokens?: number }> = [];
    try {
      const raw = (await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key)) as string | null;
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) storedList = parsed;
    } catch {
      // Unreadable store — fall through to writing just the saved entry.
    }
    const matchesPrev = (e: { key?: string; provider?: string; baseUrl?: string }) =>
      e.key === prevKey || providerBucketKey(e.provider ?? "openai-chat", e.baseUrl ?? "") === prevKey;
    const existingEntry = storedList.find(matchesPrev);
    const savedEntry = {
      ...existingEntry,
      key: nextKey,
      provider: prov,
      baseUrl: patch.baseUrl,
      // Blank key field means "keep the stored one" (same contract as the
      // models.json merge above and resolveStoredKey).
      apiKey: patch.apiKey || existingEntry?.apiKey || undefined,
      label: savedLabel,
      contextWindowTokens: ctxTokens,
    };
    const storedProviders = existingEntry
      ? storedList.map((e) => (matchesPrev(e) ? savedEntry : e))
      : [...storedList, savedEntry];
    await b.storeSet(PROVIDER_STORE.name, PROVIDER_STORE.key, JSON.stringify(storedProviders));

    setSelectedKey(nextKey);
    setProviders((prev) =>
      prev.map((p) => {
        if (p.key !== prevKey) return p;
        return {
          ...p,
          key: nextKey,
          provider: prov,
          baseUrl: patch.baseUrl,
          apiKeySet: Boolean(patch.apiKey) || p.apiKeySet,
          contextWindowK: patch.contextWindowK,
          label: savedLabel,
        };
      }),
    );

    await loadCustomModels();
  }

  // ---------------------------------------------------------------------------
  // Model enable / disable
  // ---------------------------------------------------------------------------

  // The API key is provider-level and write-only in the UI (persisted to the
  // model-providers store), but the engine authenticates per-model from
  // models.json. Resolve the bucket's stored key so newly-enabled models inherit
  // it — otherwise the model lands in models.json with no apiKey and fails to
  // authenticate even though the provider shows "(stored ✓)".
  // Resolve the stored API key for a provider bucket (keyed by provider+baseUrl)
  // from models.json (a sibling model's key) or the provider store. Used so the
  // write-only key field can stay blank yet Test / Fetch / enable still
  // authenticate with the already-saved key.
  async function resolveStoredKey(provider: string, baseUrl: string): Promise<string | undefined> {
    const bucketKey = providerBucketKey(provider, baseUrl);
    // Prefer a sibling model already carrying the key (authoritative for the engine).
    const sibling = customGlobal.find(
      (m) => providerBucketKey(m.provider, m.baseUrl ?? "") === bucketKey && m.apiKey,
    );
    if (sibling?.apiKey) return sibling.apiKey;
    try {
      const raw = (await b.storeGet(PROVIDER_STORE.name, PROVIDER_STORE.key)) as string | null;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Array<{
        key?: string;
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
      }>;
      if (!Array.isArray(parsed)) return undefined;
      const hit =
        parsed.find((p) => p.key === bucketKey) ??
        parsed.find((p) => providerBucketKey(p.provider ?? "openai-chat", p.baseUrl ?? "") === bucketKey);
      return hit?.apiKey || undefined;
    } catch {
      return undefined;
    }
  }

  async function resolveBucketApiKey(bucket: ProviderConfig): Promise<string | undefined> {
    return resolveStoredKey(bucket.provider, bucket.baseUrl);
  }

  async function handleModelEnabled(modelId: string, customLabel: string) {
    const bucket = providers.find((p) => p.key === selectedKey);
    if (!bucket) return;
    const id = buildModelId(bucket.provider, bucket.baseUrl, modelId);
    // Inherit the provider's stored API key + context window so the enabled model
    // is self-contained in models.json (the file the engine reads).
    const apiKey = await resolveBucketApiKey(bucket);
    const ctxRaw = Number(bucket.contextWindowK);
    const ctxTokens = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.floor(ctxRaw * 1000) : undefined;
    const entry: ModelEntry = {
      id,
      label: customLabel || modelId,
      provider: bucket.provider,
      model: modelId,
      ...(bucket.baseUrl ? { baseUrl: bucket.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(ctxTokens ? { contextWindowTokens: ctxTokens } : {}),
    };
    const byId = new Map(customGlobal.map((m) => [m.id, m]));
    const prev = byId.get(id);
    let merged = prev ? { ...prev, ...entry } : entry;
    // Silent models.dev pre-fill: fill ONLY fields still unset after the merge
    // (context window, max output, thinking mode, efforts). Best-effort — the
    // enable must succeed even when the catalog is unreachable.
    try {
      const res = (await b.modelsDevEnrich([merged])) as { models?: ModelEntry[]; filledIds?: string[] } | null;
      if (res?.filledIds?.includes(id) && res.models?.[0]) merged = { ...merged, ...res.models[0] };
    } catch {
      // enrichment is optional
    }
    byId.set(id, merged);
    await b.writeCustomModels(undefined, "global", [...byId.values()]);
    await loadCustomModels();
  }

  // Batch "fill from models.dev" for the selected provider bucket: enrich its
  // models.json entries in main (missing fields only — user-set values are
  // never overwritten) and persist only the entries that actually gained data.
  async function handleModelsDevPrefill(): Promise<number> {
    const bucket = providers.find((p) => p.key === selectedKey);
    if (!bucket) return 0;
    const owned = customGlobal.filter((m) => providerBucketKey(m.provider, m.baseUrl ?? "") === bucket.key);
    if (owned.length === 0) return 0;
    const res = (await b.modelsDevEnrich(owned)) as { models?: ModelEntry[]; filledIds?: string[] } | null;
    const filledIds = res?.filledIds ?? [];
    if (filledIds.length === 0 || !res?.models) return 0;
    const byId = new Map(customGlobal.map((m) => [m.id, m]));
    for (const model of res.models) {
      if (filledIds.includes(model.id)) byId.set(model.id, model);
    }
    await b.writeCustomModels(undefined, "global", [...byId.values()]);
    await loadCustomModels();
    return filledIds.length;
  }

  async function handleModelDisabled(model: ModelEntry) {
    if (!model || model.id === "deterministic") return;
    const remaining = customGlobal.filter((m) => m.id !== model.id);
    await b.writeCustomModels(undefined, "global", remaining);
    await loadCustomModels();
  }

  async function renameModel(model: ModelEntry) {
    if (model.id === "deterministic") return;
    const name = (
      await prompt({
        title: t("models.renameModelTitle"),
        message: t("models.renameModelMessage"),
        defaultValue: model.label,
        okLabel: t("models.renameAction"),
      })
    )?.trim();
    if (!name || name === model.label) return;
    const next = customGlobal.map((m) => (m.id === model.id ? { ...m, label: name } : m));
    await b.writeCustomModels(undefined, "global", next);
    await loadCustomModels();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Match the session's model id (or provider+model ref) to a configured
  // entry; an unmatched ref still renders raw so the header never lies.
  const activeModel =
    knownModels.find((m) => m.id === activeModelId || (!!activeModelId && m.model === activeModelId)) ??
    (activeModelRef
      ? knownModels.find((m) => m.provider === activeModelRef.provider && m.model === activeModelRef.model)
      : undefined);
  const activeFallback = activeModelRef
    ? `${activeModelRef.provider} / ${activeModelRef.model}`
    : activeModelId || "";
  const selectedBucket = providers.find((p) => p.key === selectedKey) ?? null;
  const filteredProviders = providers.filter(
    (p) => !providerSearch || p.label.toLowerCase().includes(providerSearch.toLowerCase()),
  );

  return (
    <div className="pane-enter flex h-full flex-col">
      {promptElement}
      {menuElement}
      {confirmElement}
      {/* Slim active-model + status bar */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 truncate text-xs">
          <span className="text-muted-foreground">{t("models.activeModel")} </span>
          <span className="font-medium">
            {activeModel ? activeModel.label : activeFallback || t("models.deterministic")}
          </span>
          {activeModel && (
            <span className="ml-2 text-muted-foreground">
              {activeModel.provider} / {activeModel.model}
              {activeModel.apiKey ? t("models.keyOk") : ""}
            </span>
          )}
        </div>
        {globalStatus && <span className="shrink-0 truncate text-xs text-destructive">{globalStatus}</span>}
      </div>

      {/* Model browser — provider list | resizer | detail, filling the panel */}
      <div ref={browserRef} className="flex min-h-0 flex-1 overflow-hidden">
        {/* Provider sidebar */}
        <aside className="flex shrink-0 flex-col" style={{ width: providerPaneWidth }}>
            <div className="border-b p-2">
              <input
                type="text"
                value={providerSearch}
                onChange={(e) => setProviderSearch(e.target.value)}
                placeholder={t("models.searchProviders")}
                spellCheck={false}
                className="h-7 w-full rounded-md border bg-transparent px-2 text-[12.5px] outline-none transition-colors duration-(--motion-fast) focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {filteredProviders.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setSelectedKey(p.key)}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: t("models.rename"), onSelect: () => void renameProvider(p) },
                      { label: t("models.delete"), danger: true, onSelect: () => void deleteProvider(p) },
                    ])
                  }
                  className={
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors duration-(--motion-fast) hover:bg-secondary " +
                    (p.key === selectedKey ? "bg-secondary font-medium" : "")
                  }
                >
                  <ProviderLogo {...p} />
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <span className={`shrink-0 text-[10px] ${p.apiKeySet ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
                    {p.apiKeySet ? t("models.on") : "—"}
                  </span>
                </button>
              ))}
              {/* Add provider row */}
              <button
                type="button"
                onClick={() => void addProvider()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded border text-[14px] leading-none">+</span>
                <span>{t("models.addProvider")}</span>
              </button>
            </div>
          </aside>

          {/* Draggable divider (legacy provider-pane resizer) */}
          <ResizeHandle
            onPointerDown={startProviderResize}
            active={providerResizing}
            ariaLabel={t("models.resizeProviderPane")}
          />

          {/* Right pane: config + model list */}
          <ProviderConfigPane
            bucket={selectedBucket}
            enabledModels={knownModels.filter((m) => m.id !== "deterministic")}
            onSaved={handleProviderSaved}
            onModelEnabled={handleModelEnabled}
            onModelDisabled={handleModelDisabled}
            onModelRename={renameModel}
            onPrefill={handleModelsDevPrefill}
            resolveStoredKey={resolveStoredKey}
            onLogoChanged={handleProviderLogoChanged}
          />
        </div>
    </div>
  );
}
