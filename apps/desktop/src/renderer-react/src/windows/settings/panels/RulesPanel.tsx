import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT } from "~/lib/i18n";
import { Button, Section } from "~/components/ui";

// Mirrors the three file keys in legacy rules.js RULES_FILES.
const RULES_FILES = [
  {
    key: "AGENTS.md",
    labelKey: "rules.fileAgentsLabel",
    hintKey: "rules.fileAgentsHint",
  },
  {
    key: "rules.md@workspace",
    labelKey: "rules.fileWorkspaceLabel",
    hintKey: "rules.fileWorkspaceHint",
  },
  {
    key: "rules.md@global",
    labelKey: "rules.fileGlobalLabel",
    hintKey: "rules.fileGlobalHint",
  },
] as const;

type RulesKey = (typeof RULES_FILES)[number]["key"];

interface RulesFileData {
  content: string;
  exists: boolean;
  path: string;
  bytes?: number;
}

type StatusLevel = "info" | "success" | "error";

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

export function RulesPanel() {
  const t = useT();
  const [activeKey, setActiveKey] = useState<RulesKey>(RULES_FILES[0].key);
  const [editorValue, setEditorValue] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileExists, setFileExists] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [statusLevel, setStatusLevel] = useState<StatusLevel>("info");
  const [saving, setSaving] = useState(false);

  // Per-key content cache — avoids round-trips when switching tabs.
  const cache = useRef<Map<RulesKey, RulesFileData>>(new Map());

  const activeEntry = RULES_FILES.find((f) => f.key === activeKey)!;

  const loadFile = useCallback(async (key: RulesKey) => {
    const cwd = await getWorkspaceCwd();
    // The two workspace-relative keys need a workspace; `rules.md@global` is
    // user-wide (~/.reina/rules.md) and the IPC resolves it independent of cwd,
    // so it stays editable with no workspace open.
    if (key !== "rules.md@global" && !cwd) {
      // No workspace open — show empty editor, same as legacy.
      return { content: "", exists: false, path: key } as RulesFileData;
    }
    try {
      const data = (await bridge().readRulesFile(cwd || "", key)) as RulesFileData;
      cache.current.set(key, data);
      return data;
    } catch (err) {
      return { content: "", exists: false, path: key } as RulesFileData;
    }
  }, []);

  const selectFile = useCallback(
    async (key: RulesKey) => {
      setActiveKey(key);
      setStatus("");
      setDirty(false);
      const cached = cache.current.get(key);
      const data = cached ?? (await loadFile(key));
      setEditorValue(data.content ?? "");
      setFilePath(data.path);
      setFileExists(data.exists);
    },
    [loadFile],
  );

  // Load the first tab on mount.
  useEffect(() => {
    void selectFile(activeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabClick = (key: RulesKey) => {
    if (dirty) {
      if (!window.confirm(t("rules.discardConfirm"))) return;
    }
    void selectFile(key);
  };

  const handleEditorChange = (value: string) => {
    setEditorValue(value);
    setDirty(true);
    setStatus("");
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !saving) void handleSave();
    }
  };

  const handleSave = async () => {
    const cwd = await getWorkspaceCwd();
    // `rules.md@global` lives at ~/.reina and saves without a workspace; only the
    // two workspace-relative keys require one.
    if (activeKey !== "rules.md@global" && !cwd) {
      setStatus(t("rules.openWorkspaceFirst"));
      setStatusLevel("error");
      return;
    }
    setSaving(true);
    try {
      const data = (await bridge().writeRulesFile(cwd || "", activeKey, editorValue)) as RulesFileData & { bytes?: number };
      cache.current.set(activeKey, { key: activeKey, path: data.path, content: editorValue, exists: true } as RulesFileData & { key: string });
      setFilePath(data.path);
      setFileExists(true);
      setDirty(false);
      setStatus(t("rules.savedBytes", { bytes: data.bytes ?? 0 }));
      setStatusLevel("success");
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
        title={t("rules.sectionTitle")}
        description={t("rules.sectionDescription")}
      >
        {/* Header: file tabs + resolved path, hint below */}
        <div className="px-3 pb-2.5 pt-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex shrink-0 gap-1">
              {RULES_FILES.map((file) => (
                <button
                  key={file.key}
                  type="button"
                  onClick={() => handleTabClick(file.key)}
                  className={
                    "h-6 rounded-md px-2.5 text-[12px] transition-colors duration-(--motion-fast) " +
                    (activeKey === file.key
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                  }
                >
                  {t(file.labelKey)}
                  {activeKey === file.key && dirty && (
                    <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" />
                  )}
                </button>
              ))}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate font-mono">{filePath}</span>
              {!fileExists && (
                <span className="shrink-0 rounded-md bg-secondary/60 px-1.5 py-px text-[10px]">
                  {t("rules.newBadge")}
                </span>
              )}
            </div>
          </div>
          <p className="mt-1.5 px-0.5 text-[11px] text-muted-foreground/80">{t(activeEntry.hintKey)}</p>
        </div>

        {/* Editor — full-bleed inside the card, framed by the section dividers */}
        <textarea
          value={editorValue}
          placeholder={t("rules.editorPlaceholder")}
          spellCheck={false}
          rows={16}
          onChange={(e) => handleEditorChange(e.target.value)}
          onKeyDown={handleEditorKeyDown}
          className="block w-full min-h-[260px] resize-y bg-transparent px-4 py-3 font-mono text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        />

        {/* Actions row */}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Button variant="accent" onClick={() => void handleSave()} disabled={!dirty || saving}>
            {t("rules.save")}
          </Button>
          {status && (
            <span className={`text-[12px] ${statusColor(statusLevel)}`}>{status}</span>
          )}
          {dirty && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              {t("rules.unsaved")}
            </span>
          )}
        </div>
      </Section>
    </div>
  );
}
