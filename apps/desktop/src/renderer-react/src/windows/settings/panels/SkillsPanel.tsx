import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { getWorkspaceCwd } from "~/lib/workspace";
import { useT } from "~/lib/i18n";
import { Button, Section, Select, TextField } from "~/components/ui";

interface Skill {
  name: string;
  description?: string;
  path: string;
  scope?: "workspace" | "global";
}

interface SkillsPayload {
  skills: Skill[];
  workspaceDir?: string;
  globalDir?: string;
}

type StatusLevel = "info" | "success" | "error";

function statusColor(level: StatusLevel) {
  if (level === "success") return "text-success-foreground";
  if (level === "error") return "text-destructive";
  return "text-muted-foreground";
}

type ActiveTab = "installed" | "recommended";

export function SkillsPanel() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<ActiveTab>("installed");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [paths, setPaths] = useState("");
  const [loading, setLoading] = useState(false);

  // Create-skill form
  const [createOpen, setCreateOpen] = useState(false);
  const [scope, setScope] = useState<"workspace" | "global">("workspace");
  const [skillName, setSkillName] = useState("");
  const [description, setDescription] = useState("");
  const [createStatus, setCreateStatus] = useState("");
  const [createStatusLevel, setCreateStatusLevel] = useState<StatusLevel>("info");
  const [creating, setCreating] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      // Pass "" when no workspace is open: the IPC layer falls back to defaultCwd
      // and listSkills returns BOTH the workspace and global skill dirs, so the
      // global skills stay visible/manageable without a workspace.
      const cwd = await getWorkspaceCwd();
      const payload = (await bridge().listSkills(cwd || "")) as SkillsPayload;
      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      const parts: string[] = [];
      if (payload.workspaceDir) parts.push(t("skills.workspaceDir", { dir: payload.workspaceDir }));
      if (payload.globalDir) parts.push(t("skills.globalDir", { dir: payload.globalDir }));
      setPaths(parts.join(" — "));
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const handleUse = (skill: Skill) => {
    // Settings is a separate window with no composer of its own — hand the
    // skill to the main window via the main process, then dismiss settings
    // (mirrors legacy skills.js: useSkillInMain → closeSettings).
    void bridge().useSkillInMain?.(skill as unknown as Record<string, unknown>);
    void bridge().windowClose().catch(() => undefined);
  };

  const handleReveal = (skill: Skill) => {
    void bridge().revealInFolder(skill.path).catch(() => undefined);
  };

  const handleCreate = async () => {
    const name = skillName.trim();
    if (!name) {
      setCreateStatus(t("skills.nameRequired"));
      setCreateStatusLevel("error");
      return;
    }
    const cwd = await getWorkspaceCwd();
    // Only a workspace-scoped skill needs a workspace; a global skill is written
    // under $REINA_HOME and the IPC layer falls back to defaultCwd for "".
    if (scope === "workspace" && !cwd) {
      setCreateStatus(t("skills.openWorkspaceFirst"));
      setCreateStatusLevel("error");
      return;
    }
    setCreating(true);
    try {
      const result = (await bridge().createSkill(cwd || "", scope, name, description.trim())) as { path: string };
      setCreateStatus(t("skills.savedTo", { path: result.path }));
      setCreateStatusLevel("success");
      setSkillName("");
      setDescription("");
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCreateStatus(msg);
      setCreateStatusLevel("error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="pane-enter">
      <div className="mb-2">
        <h2 className="text-sm font-semibold">{t("skills.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("skills.introBefore")} <code className="font-mono">SKILL.md</code> {t("skills.introUnder")}{" "}
          <code className="font-mono">.claude/skills/&lt;name&gt;/</code> {t("skills.introWorkspace")}{" "}
          <code className="font-mono">~/.claude/skills/&lt;name&gt;/</code> {t("skills.introGlobal")}
        </p>
      </div>

      {/* Tab strip + Refresh */}
      <div className="mb-3 flex items-center gap-1">
        {(["installed", "recommended"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={
              "rounded-md px-3 py-1 text-[12.5px] transition-colors duration-(--motion-fast) " +
              (activeTab === tab
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {tab === "installed" ? t("skills.tabInstalled") : t("skills.tabRecommended")}
          </button>
        ))}
        <div className="ml-auto">
          <Button onClick={() => void loadSkills()} disabled={loading}>
            {loading ? t("skills.loading") : t("skills.refresh")}
          </Button>
        </div>
      </div>

      {activeTab === "installed" && (
        <>
          {/* Skills grid */}
          <div className="mb-3 rounded-xl border bg-card">
            {skills.length === 0 ? (
              <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                {t("skills.emptyInstalled")}
              </div>
            ) : (
              <div className="divide-y divide-(--surface-divider)">
                {skills.map((skill) => (
                  <div key={skill.path} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{skill.name}</div>
                      {skill.description && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{skill.description}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button onClick={() => handleUse(skill)}>{t("skills.use")}</Button>
                      <button
                        type="button"
                        title={t("skills.revealInFolder")}
                        aria-label={t("skills.revealInFolder")}
                        onClick={() => handleReveal(skill)}
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-secondary hover:text-foreground"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Skill paths */}
          {paths && (
            <div className="mb-3 font-mono text-[11px] text-muted-foreground">{paths}</div>
          )}

          {/* Create skill — collapsible */}
          <div className="rounded-xl border bg-card">
            <button
              type="button"
              onClick={() => setCreateOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] hover:bg-secondary/50 transition-colors duration-(--motion-fast) rounded-xl"
            >
              <span>{t("skills.createNew")}</span>
              <span className="text-muted-foreground">{createOpen ? "▲" : "▼"}</span>
            </button>

            {createOpen && (
              <div className="divide-y divide-(--surface-divider) border-t">
                <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px]">{t("skills.scope")}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("skills.scopeHelp")}
                    </div>
                  </div>
                  <Select
                    value={scope}
                    options={[
                      { value: "workspace", label: t("skills.scopeWorkspace") },
                      { value: "global", label: t("skills.scopeGlobal") },
                    ]}
                    onChange={(v) => setScope(v as "workspace" | "global")}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px]">{t("skills.skillName")}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("skills.skillNameHelp")}
                    </div>
                  </div>
                  <TextField
                    value={skillName}
                    placeholder={t("skills.skillNamePlaceholder")}
                    onChange={(v) => { setSkillName(v); setCreateStatus(""); }}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px]">{t("skills.description")}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("skills.descriptionHelp")}
                    </div>
                  </div>
                  <TextField
                    value={description}
                    placeholder={t("skills.descriptionPlaceholder")}
                    onChange={(v) => { setDescription(v); setCreateStatus(""); }}
                  />
                </div>

                <div className="flex items-center gap-3 px-4 py-2.5">
                  <Button variant="accent" onClick={() => void handleCreate()} disabled={creating}>
                    {t("skills.createSkill")}
                  </Button>
                  {createStatus && (
                    <span className={`text-[12px] ${statusColor(createStatusLevel)}`}>{createStatus}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === "recommended" && (
        <div className="rounded-xl border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t("skills.recommendedEmpty")}
        </div>
      )}
    </div>
  );
}
