import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { useT, type TFunc } from "~/lib/i18n";
import { Button, Section, Select } from "~/components/ui";
import { usePromptDialog } from "~/components/PromptDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubscriptionKind = "anthropic-oauth" | "openai-codex" | "kimi-oauth";

interface SubscriptionAccount {
  id: string;
  kind: SubscriptionKind;
  label?: string;
  email?: string;
  model?: string;
  contextTokens?: number;
}

interface UsageTier {
  label: string;
  utilization: number;
  resetsAt?: string;
}

interface UsageSnapshot {
  ok: boolean;
  tiers?: UsageTier[];
  queriedAt?: number;
  error?: string;
}

interface ModelsResult {
  models?: string[];
  current?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<SubscriptionKind, string> = {
  "anthropic-oauth": "Claude (Pro/Max)",
  "openai-codex": "ChatGPT Codex",
  "kimi-oauth": "Kimi (Moonshot)",
};

const CONTEXT_PRESETS = [128_000, 200_000, 256_000, 400_000, 1_000_000];

function defaultContextFor(kind: SubscriptionKind): number {
  return kind === "anthropic-oauth" ? 1_000_000 : 256_000;
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function countdownStr(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function relativeTime(ts: number, t: TFunc): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return t("subscriptions.justNow");
  if (diff < 3600) return t("subscriptions.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("subscriptions.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("subscriptions.daysAgo", { n: Math.floor(diff / 86400) });
}

function utilizationColor(u: number): string {
  if (u >= 90) return "text-destructive";
  if (u >= 70) return "text-yellow-500";
  return "text-green-500";
}

// ---------------------------------------------------------------------------
// Usage pill
// ---------------------------------------------------------------------------

function UsagePill({ tier }: { tier: UsageTier }) {
  const cd = countdownStr(tier.resetsAt);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{tier.label}</span>
      <span className={`font-medium ${utilizationColor(tier.utilization)}`}>
        {Math.round(tier.utilization)}%
      </span>
      {cd && (
        <span className="text-muted-foreground/70">⏱{cd}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Model selector for an account
// ---------------------------------------------------------------------------

function ModelSelect({
  account,
  onStatusChange,
}: {
  account: SubscriptionAccount;
  onStatusChange: (msg: string, isError: boolean) => void;
}) {
  const b = bridge();
  const t = useT();
  const { prompt, element } = usePromptDialog();
  const [options, setOptions] = useState<string[]>([]);
  const [current, setCurrent] = useState(account.model ?? "");
  const [loading, setLoading] = useState(false);

  // Cache key shared by account id
  const cacheRef = useRef<{ models: string[]; current: string; at: number } | null>(null);
  const MODELS_TTL_MS = 300_000;

  const loadModels = useCallback(
    async (force = false) => {
      if (loading) return;
      const cached = cacheRef.current;
      if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) {
        setOptions(cached.models);
        setCurrent(cached.current || account.model || "");
        return;
      }
      setLoading(true);
      try {
        const res = (await b.listSubscriptionModels(account.id)) as ModelsResult | null;
        const remote = Array.isArray(res?.models) ? res!.models : [];
        if (remote.length) {
          const curr =
            (typeof res?.current === "string" && res.current) || account.model || "";
          cacheRef.current = { models: remote, current: curr, at: Date.now() };
          setOptions(remote);
          setCurrent(curr);
          if (force) onStatusChange(t("subscriptions.fetchedModels", { count: remote.length }), false);
        } else {
          onStatusChange(
            res?.error
              ? t("subscriptions.modelListError", { error: res.error })
              : t("subscriptions.noModelsReturned"),
            true,
          );
        }
      } catch (err: unknown) {
        onStatusChange(
          t("subscriptions.modelFetchFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
          true,
        );
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account.id, account.model, b],
  );

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  async function save(value: string) {
    const prev = current;
    setCurrent(value);
    try {
      await b.updateSubscription(account.id, { model: value });
      account.model = value;
      onStatusChange(t("subscriptions.modelSetTo", { value }), false);
    } catch (err: unknown) {
      setCurrent(prev);
      onStatusChange(
        t("subscriptions.switchFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    }
  }

  async function handleChange(value: string) {
    if (value === "__custom__") {
      const input = (
        await prompt({
          title: t("subscriptions.customModelTitle"),
          message: t("subscriptions.customModelMessage"),
          defaultValue: current,
          placeholder: t("subscriptions.customModelPlaceholder"),
          okLabel: t("subscriptions.set"),
        })
      )?.trim();
      if (!input) return;
      if (!options.includes(input)) setOptions((prev) => [input, ...prev]);
      await save(input);
      return;
    }
    await save(value);
  }

  return (
    <div className="flex items-center gap-2">
      {element}
      <Select
        value={current}
        options={[
          ...(options.length === 0
            ? [{ value: "", label: loading ? t("subscriptions.fetching") : t("subscriptions.noModels") }]
            : []),
          ...options.map((id) => ({ value: id, label: id })),
          { value: "__custom__", label: t("subscriptions.customEllipsis") },
        ]}
        onChange={(v) => void handleChange(v)}
        disabled={loading}
        title={t("subscriptions.switchModelTitle")}
        className="max-w-[240px]"
      />
      <button
        type="button"
        onClick={() => void loadModels(true)}
        disabled={loading}
        title={t("subscriptions.refreshModelsTitle")}
        className="h-7 rounded-md border px-2 text-[12px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground disabled:opacity-40"
      >
        {loading ? "…" : t("subscriptions.refresh")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context window selector
// ---------------------------------------------------------------------------

function ContextSelect({
  account,
  onStatusChange,
}: {
  account: SubscriptionAccount;
  onStatusChange: (msg: string, isError: boolean) => void;
}) {
  const b = bridge();
  const t = useT();
  const { prompt, element } = usePromptDialog();
  const initial =
    typeof account.contextTokens === "number" && account.contextTokens > 0
      ? account.contextTokens
      : defaultContextFor(account.kind);
  const [current, setCurrent] = useState(initial);

  function buildOptions(): number[] {
    return [...new Set([...CONTEXT_PRESETS, current])].sort((a, b) => a - b);
  }

  async function save(n: number) {
    const prev = current;
    setCurrent(n);
    try {
      await b.updateSubscription(account.id, { contextTokens: n });
      account.contextTokens = n;
      onStatusChange(t("subscriptions.contextWindowSet", { size: formatContext(n) }), false);
    } catch (err: unknown) {
      setCurrent(prev);
      onStatusChange(
        t("subscriptions.updateFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    }
  }

  async function handleChange(value: string) {
    if (value === "__custom__") {
      const input = (
        await prompt({
          title: t("subscriptions.contextWindowTitle"),
          message: t("subscriptions.contextWindowMessage"),
          defaultValue: String(current),
          numeric: true,
          okLabel: t("subscriptions.set"),
        })
      )?.trim();
      const n = input ? Math.floor(Number(input)) : NaN;
      if (!Number.isFinite(n) || n <= 0) return;
      await save(n);
      return;
    }
    await save(Number(value));
  }

  const opts = buildOptions();
  return (
    <>
      {element}
      <Select
        value={String(current)}
        options={[
          ...opts.map((v) => ({ value: String(v), label: formatContext(v) })),
          { value: "__custom__", label: t("subscriptions.customEllipsis") },
        ]}
        onChange={(v) => void handleChange(v)}
        title={t("subscriptions.contextWindowSizeTitle")}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Account card
// ---------------------------------------------------------------------------

function AccountCard({
  account,
  onDisconnected,
  onStatusChange,
}: {
  account: SubscriptionAccount;
  onDisconnected: () => void;
  onStatusChange: (msg: string, isError: boolean) => void;
}) {
  const b = bridge();
  const t = useT();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usageQueriedAt, setUsageQueriedAt] = useState<number | null>(null);
  const [relTime, setRelTime] = useState("");

  const cacheRef = useRef<{ snapshot: UsageSnapshot; at: number } | null>(null);
  const USAGE_TTL_MS = 120_000;

  const loadUsage = useCallback(
    async (force = false) => {
      if (loadingUsage) return;
      const cached = cacheRef.current;
      if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) {
        setUsage(cached.snapshot);
        if (cached.snapshot.queriedAt) {
          setUsageQueriedAt(cached.snapshot.queriedAt);
          setRelTime(relativeTime(cached.snapshot.queriedAt, t));
        }
        return;
      }
      setLoadingUsage(true);
      try {
        const snap = (await b.subscriptionUsage(account.id)) as UsageSnapshot | null;
        const result: UsageSnapshot = snap ?? { ok: false, error: t("subscriptions.noResponse") };
        cacheRef.current = { snapshot: result, at: Date.now() };
        setUsage(result);
        if (result.queriedAt) {
          setUsageQueriedAt(result.queriedAt);
          setRelTime(relativeTime(result.queriedAt, t));
        }
      } catch (err: unknown) {
        setUsage({ ok: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoadingUsage(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account.id, b],
  );

  useEffect(() => {
    void loadUsage(false);
  }, [loadUsage]);

  // Tick relative time every 30s
  useEffect(() => {
    if (!usageQueriedAt) return;
    const id = setInterval(() => setRelTime(relativeTime(usageQueriedAt, t)), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageQueriedAt]);

  async function handleDisconnect() {
    if (!window.confirm(t("subscriptions.disconnectConfirm", { kind: KIND_LABEL[account.kind] }))) return;
    try {
      await b.disconnectSubscription(account.id);
      onStatusChange(t("subscriptions.disconnected", { account: account.label || account.id }), false);
      onDisconnected();
    } catch (err: unknown) {
      onStatusChange(
        t("subscriptions.disconnectFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      {/* Head row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-semibold">
            {KIND_LABEL[account.kind] || account.label || account.id}
          </div>
          {account.email && (
            <div className="mt-0.5 text-xs text-muted-foreground">{account.email}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void loadUsage(true)}
            disabled={loadingUsage}
            title={t("subscriptions.refreshUsage")}
            className="h-7 rounded-md border px-2 text-[12px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            {loadingUsage ? "…" : "↺"}
          </button>
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            className="h-7 rounded-md border px-2 text-[12px] text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-destructive"
            title={t("subscriptions.disconnect")}
          >
            {t("subscriptions.disconnect")}
          </button>
        </div>
      </div>

      {/* Controls row */}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{t("subscriptions.model")}</span>
          <ModelSelect account={account} onStatusChange={onStatusChange} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{t("subscriptions.context")}</span>
          <ContextSelect account={account} onStatusChange={onStatusChange} />
        </div>
      </div>

      {/* Usage */}
      <div className="mt-3">
        {!usage && loadingUsage && (
          <span className="text-xs text-muted-foreground">{t("subscriptions.loadingUsage")}</span>
        )}
        {usage && !usage.ok && (
          <span className="text-xs text-muted-foreground">
            {t("subscriptions.usageUnavailable")}{usage.error ? `: ${usage.error}` : ""}
          </span>
        )}
        {usage?.ok && Array.isArray(usage.tiers) && usage.tiers.length === 0 && (
          <span className="text-xs text-muted-foreground">{t("subscriptions.noUsageWindows")}</span>
        )}
        {usage?.ok && Array.isArray(usage.tiers) && usage.tiers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {usage.tiers.map((tier, i) => (
              <UsagePill key={i} tier={tier} />
            ))}
          </div>
        )}
        {relTime && (
          <div className="mt-1 text-[11px] text-muted-foreground/60">{relTime}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect card — provider-level connect / import actions
// ---------------------------------------------------------------------------

function ConnectCard({
  kind,
  cliAvailable,
  onConnected,
  panelBusy,
  setPanelBusy,
  onStatusChange,
}: {
  kind: SubscriptionKind;
  cliAvailable: boolean;
  onConnected: () => void;
  panelBusy: boolean;
  setPanelBusy: (v: boolean) => void;
  onStatusChange: (msg: string, isError: boolean) => void;
}) {
  const b = bridge();
  const t = useT();

  async function handleConnect() {
    if (panelBusy) return;
    setPanelBusy(true);
    onStatusChange(t("subscriptions.openingBrowser"), false);
    try {
      const account = (await b.connectSubscription(kind)) as SubscriptionAccount | null;
      onStatusChange(t("subscriptions.connected", { account: account?.label || kind }), false);
      onConnected();
    } catch (err: unknown) {
      onStatusChange(
        t("subscriptions.connectFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    } finally {
      setPanelBusy(false);
    }
  }

  async function handleImport() {
    if (panelBusy) return;
    setPanelBusy(true);
    onStatusChange(t("subscriptions.importingFromCli"), false);
    try {
      const account = (await b.importSubscription(kind)) as SubscriptionAccount | null;
      onStatusChange(t("subscriptions.imported", { account: account?.label || kind }), false);
      onConnected();
    } catch (err: unknown) {
      onStatusChange(
        t("subscriptions.importFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    } finally {
      setPanelBusy(false);
    }
  }

  const connectDesc =
    kind === "anthropic-oauth"
      ? t("subscriptions.connectAnthropicDesc")
      : kind === "kimi-oauth"
        ? t("subscriptions.connectKimiDesc")
        : t("subscriptions.connectCodexDesc");

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
      <div>
        <div className="text-[13px] font-medium">{KIND_LABEL[kind]}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {connectDesc}
          {cliAvailable && ` ${t("subscriptions.cliDetectedHint")}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {cliAvailable && (
          <Button onClick={() => void handleImport()} disabled={panelBusy}>
            {t("subscriptions.importFromCli")}
          </Button>
        )}
        <Button onClick={() => void handleConnect()} disabled={panelBusy} variant="accent">
          {t("subscriptions.browserLogin")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function SubscriptionsPanel() {
  const b = bridge();
  const t = useT();

  const [activeKind, setActiveKind] = useState<SubscriptionKind>("anthropic-oauth");
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([]);
  const [cliAvailable, setCliAvailable] = useState<Record<SubscriptionKind, boolean>>({
    "anthropic-oauth": false,
    "openai-codex": false,
    "kimi-oauth": false,
  });
  const [panelBusy, setPanelBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [statusError, setStatusError] = useState(false);

  function handleStatusChange(msg: string, isError: boolean) {
    setStatus(msg);
    setStatusError(isError);
  }

  const loadAccounts = useCallback(async () => {
    try {
      const list = (await b.listSubscriptions()) as SubscriptionAccount[] | null;
      setAccounts(Array.isArray(list) ? list : []);
    } catch {
      setAccounts([]);
    }
  }, [b]);

  const checkCliAvailable = useCallback(async () => {
    const [anthropic, codex, kimi] = await Promise.allSettled([
      b.subscriptionCliAvailable("anthropic-oauth"),
      b.subscriptionCliAvailable("openai-codex"),
      b.subscriptionCliAvailable("kimi-oauth"),
    ]);
    setCliAvailable({
      "anthropic-oauth": anthropic.status === "fulfilled" ? anthropic.value : false,
      "openai-codex": codex.status === "fulfilled" ? codex.value : false,
      "kimi-oauth": kimi.status === "fulfilled" ? kimi.value : false,
    });
  }, [b]);

  useEffect(() => {
    void loadAccounts();
    void checkCliAvailable();
  }, [loadAccounts, checkCliAvailable]);

  const visibleAccounts = accounts.filter((a) => a.kind === activeKind);
  const kinds: SubscriptionKind[] = ["anthropic-oauth", "openai-codex", "kimi-oauth"];

  return (
    <div className="pane-enter">
      <Section
        title={t("subscriptions.sectionTitle")}
        description={t("subscriptions.sectionDesc")}
      >
        {/* Kind tab switcher */}
        <div className="flex gap-1 border-b px-4 py-2">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={kind === activeKind}
              onClick={() => setActiveKind(kind)}
              className={
                "h-7 rounded-md px-3 text-[12.5px] transition-colors duration-(--motion-fast) " +
                (kind === activeKind
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground")
              }
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>

        {/* Connect card */}
        <div className="p-4">
          <ConnectCard
            kind={activeKind}
            cliAvailable={cliAvailable[activeKind]}
            onConnected={() => void loadAccounts()}
            panelBusy={panelBusy}
            setPanelBusy={setPanelBusy}
            onStatusChange={handleStatusChange}
          />
        </div>

        {/* Inline status */}
        {status && (
          <div className="px-4 pb-2">
            <span
              aria-live="polite"
              className={`text-xs ${statusError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {status}
            </span>
          </div>
        )}

        {/* Policy note */}
        <div className="px-4 pb-3">
          <p className="text-[11px] text-muted-foreground/60">
            {t("subscriptions.policyNote")}
          </p>
        </div>
      </Section>

      {/* Connected accounts */}
      <Section title={t("subscriptions.connectedAccounts")}>
        {visibleAccounts.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("subscriptions.noAccountsConnected", { kind: KIND_LABEL[activeKind] })}
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {visibleAccounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                onDisconnected={() => void loadAccounts()}
                onStatusChange={handleStatusChange}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
