import { describe, expect, it } from "vitest";
import type { AgentProfile, SkillMetadata, ToolDescriptor } from "@reina/protocol";
import { deferredToolDescriptors } from "@reina/tools";
import { availableTools, filterSkillsByProfile, matchesToolAllowList, profiles, resolveProfile } from "./index.js";

describe("AgentProfile schema extensions (P0-1)", () => {
  it("the built-in default profile still resolves and carries no allow-list", () => {
    const def = resolveProfile("default");
    expect(def.name).toBe("default");
    expect(def.tools).toBeUndefined();
    expect(def.skills).toBeUndefined();
    expect(def.initialPrompt).toBeUndefined();
    expect(def.color).toBeUndefined();
  });

  it("the built-in summary profile keeps its deny set unchanged", () => {
    const summary = resolveProfile("summary");
    expect(summary.toolPermissions.write_file).toBe("deny");
    expect(summary.toolPermissions.run_shell).toBe("deny");
  });

  it("the built-in coordinator profile resolves and lists DAG + async-task tools in extraDirectTools", () => {
    const coord = resolveProfile("coordinator");
    expect(coord.name).toBe("coordinator");
    expect(coord.mode).toBe("primary");
    expect(coord.extraDirectTools).toBeDefined();
    const extra = new Set(coord.extraDirectTools!);
    // DAG coordination tools — without these the model can't drive team mode.
    for (const tool of ["create_subtask", "update_subtask", "get_dag", "set_phase", "send_to_worker"]) {
      expect(extra.has(tool as never)).toBe(true);
    }
    // Async-task lifecycle — one dispatch verb and one non-blocking read verb.
    for (const tool of ["task", "get_async_tasks", "wait_async_tasks", "update_async_task", "cancel_async_task"]) {
      expect(extra.has(tool as never)).toBe(true);
    }
    // Standard agent toolkit — coordinator defaults to self-execute and
    // only escalates to a worker on specific triggers; without these in
    // cold-start, every trivial recon/edit pays a search_tool round-trip.
    for (const tool of ["read_file", "run_shell", "edit_file", "write_file"]) {
      expect(extra.has(tool as never)).toBe(true);
    }
  });
});

describe("availableTools - tools allow-list semantics", () => {
  it("adds only activated deferred tools in a stable, duplicate-free order", () => {
    const def = resolveProfile("default");
    const cold = availableTools(def).map((t) => t.name);
    const warm = availableTools(def, ["notify", "schedule_wakeup", "task"]).map((t) => t.name);
    expect(cold).not.toContain("notify");
    expect(warm).toEqual([...cold, "notify", "schedule_wakeup", "task"]);
    expect(availableTools(def, ["task", "notify", "task", "schedule_wakeup", "unknown"]).map((t) => t.name)).toEqual(
      warm,
    );
    expect(availableTools(def).map((t) => t.name)).toEqual(cold);
  });

  it("keeps note discovery/read direct while deferring default-session mutations", () => {
    const def = resolveProfile("default");
    const directNames = new Set(availableTools(def).map((t) => t.name));
    const deferredNames = new Set(deferredToolDescriptors.map((t) => t.name));
    expect(directNames.has("list_notes")).toBe(true);
    expect(directNames.has("read_note")).toBe(true);
    for (const name of ["note", "update_note", "delete_note"] as const) {
      expect(directNames.has(name)).toBe(false);
      expect(deferredNames.has(name)).toBe(true);
    }
  });

  it("promotes deferred note mutations for the dedicated memory profiles", () => {
    const selfReviewNames = new Set(availableTools(resolveProfile("self-review")).map((t) => t.name));
    expect(selfReviewNames.has("note")).toBe(true);
    expect(selfReviewNames.has("update_note")).toBe(true);
    expect(selfReviewNames.has("delete_note")).toBe(false);

    const consolidateNames = new Set(availableTools(resolveProfile("memory-consolidate")).map((t) => t.name));
    expect(consolidateNames.has("note")).toBe(true);
    expect(consolidateNames.has("update_note")).toBe(true);
    expect(consolidateNames.has("delete_note")).toBe(true);
  });

  it("with no `tools` field, returns the direct deny-filtered catalog", () => {
    const def = resolveProfile("default");
    const tools = availableTools(def);
    // Cold-start requests expose only direct tools.
    // Specialty tools are unmasked by search_tool or direct name.
    expect(tools.find((t) => t.name === "create_subtask")).toBeUndefined();
    expect(availableTools(def, ["create_subtask"]).find((t) => t.name === "create_subtask")).toBeDefined();
    expect(tools.find((t) => t.name === "read_file")).toBeDefined();
  });

  it("with `tools: ['*']` returns the same catalog as no allow-list", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const wide: AgentProfile = { ...base, tools: ["*"] };
    expect(
      availableTools(wide)
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      availableTools(base)
        .map((t) => t.name)
        .sort(),
    );
  });

  it("restricts the surface to exact names when given a finite list", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const narrow: AgentProfile = {
      ...base,
      tools: ["read_file", "write_file"],
    };
    const names = availableTools(narrow).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("task");
  });

  it("activation does not bypass allow-lists or deny entries", () => {
    const base = resolveProfile("default");
    const narrow: AgentProfile = {
      ...base,
      tools: ["read_file", "notify", "task"],
      toolPermissions: { ...base.toolPermissions, task: "deny" },
    };
    const names = availableTools(narrow, ["notify", "task", "schedule_wakeup"]).map((t) => t.name);
    expect(names).toEqual(["read_file", "notify"]);
  });

  it("fails MCP wildcards closed when a descriptor has no server identity", () => {
    const base = resolveProfile("default");
    const profile: AgentProfile = { ...base, tools: ["mcp__foo__*"] };
    const ambiguous = {
      ...deferredToolDescriptors[0]!,
      name: "mcp__foo__bar__dangerous",
    } as ToolDescriptor;

    expect(matchesToolAllowList(profile, ambiguous)).toBe(false);
    expect(matchesToolAllowList(profile, { ...ambiguous, mcpServer: "foo" } as ToolDescriptor)).toBe(true);
    expect(matchesToolAllowList(profile, { ...ambiguous, mcpServer: "foo__bar" } as ToolDescriptor)).toBe(false);
  });

  it("extraDirectTools promotes deferred-by-default tools into the direct catalog", () => {
    // coordinator is the production consumer of this code path — verify the
    // promotion is actually wired end-to-end through availableTools.
    const coord = resolveProfile("coordinator");
    const names = new Set(availableTools(coord).map((t) => t.name));
    expect(names.has("create_subtask")).toBe(true);
    expect(names.has("task")).toBe(true);
    expect(names.has("get_async_tasks")).toBe(true);
    expect(names.has("get_dag")).toBe(true);
    expect(names.has("set_phase")).toBe(true);
    // Direct tools still present (we add to, never replace, the direct set).
    expect(names.has("read_file")).toBe(true);
  });

  it("extraDirectTools does NOT bleed into other profiles' tools array (prompt-cache safety)", () => {
    // Coordinator-only promotions must not enlarge default's cold-start array.
    const def = resolveProfile("default");
    const names = new Set(availableTools(def).map((t) => t.name));
    expect(names.has("create_subtask")).toBe(false);
    expect(names.has("task")).toBe(false);
    expect(names.has("get_async_tasks")).toBe(false);
    expect(names.has("get_dag")).toBe(false);
  });

  it("extraDirectTools respects deny entries", () => {
    const base = profiles.find((p) => p.name === "coordinator")!;
    const denied: AgentProfile = {
      ...base,
      toolPermissions: { ...base.toolPermissions, task: "deny" },
    };
    const names = new Set(availableTools(denied).map((t) => t.name));
    expect(names.has("task")).toBe(false);
    // Other extraDirectTools entries survive.
    expect(names.has("create_subtask")).toBe(true);
  });

  it("sessionModes overlays Team tools and ignores the deprecated Goal flag", () => {
    const def = resolveProfile("default");
    const legacyGoalOnly = new Set(availableTools(def, undefined, { goal: true }).map((t) => t.name));
    expect(legacyGoalOnly.has("get_goal")).toBe(false);
    expect(legacyGoalOnly.has("create_subtask")).toBe(false);

    const teamOnly = new Set(availableTools(def, undefined, { team: true }).map((t) => t.name));
    expect(teamOnly.has("create_subtask")).toBe(true);
    expect(teamOnly.has("task")).toBe(true);
    expect(teamOnly.has("get_async_tasks")).toBe(true);
  });

  it("sessionModes overlay does NOT double-promote tools already in the profile's extraDirectTools", () => {
    // coordinator's extraDirectTools already includes task; team
    // mode overlay names it too. The merged catalog should contain it once.
    const coord = resolveProfile("coordinator");
    const names = availableTools(coord, undefined, { team: true }).map((t) => t.name);
    const occurrences = names.filter((n) => n === "task").length;
    expect(occurrences).toBe(1);
  });

  it("sessionModes overlay respects deny (deny still wins)", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const teamDenied: AgentProfile = {
      ...base,
      toolPermissions: { ...base.toolPermissions, create_subtask: "deny" },
    };
    const names = new Set(availableTools(teamDenied, undefined, { team: true }).map((t) => t.name));
    expect(names.has("create_subtask")).toBe(false);
    expect(names.has("get_dag")).toBe(true);
  });

  it("deny entries still win over allow-list entries", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const conflicted: AgentProfile = {
      ...base,
      tools: ["read_file", "run_shell"],
      toolPermissions: { ...base.toolPermissions, run_shell: "deny" },
    };
    const names = availableTools(conflicted).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("run_shell");
  });
});

describe("filterSkillsByProfile", () => {
  const sampleSkills: SkillMetadata[] = [
    { name: "review", description: "code review", path: "/x/review" },
    { name: "tdd", description: "test-first", path: "/x/tdd" },
    { name: "refactor", description: "rename safely", path: "/x/refactor" },
  ];

  it("returns the input array verbatim when profile.skills is undefined", () => {
    const base = profiles.find((p) => p.name === "default")!;
    expect(filterSkillsByProfile(sampleSkills, base)).toEqual(sampleSkills);
  });

  it("filters to the listed names in the order the profile declared them", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const profile: AgentProfile = { ...base, skills: ["tdd", "review"] };
    const result = filterSkillsByProfile(sampleSkills, profile);
    expect(result.map((s) => s.name)).toEqual(["tdd", "review"]);
  });

  it("silently drops names that don't match any loaded skill", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const profile: AgentProfile = { ...base, skills: ["nonexistent", "review"] };
    expect(filterSkillsByProfile(sampleSkills, profile).map((s) => s.name)).toEqual(["review"]);
  });

  it("empty skills array is treated as 'no allow-list' (returns all)", () => {
    const base = profiles.find((p) => p.name === "default")!;
    const profile: AgentProfile = { ...base, skills: [] };
    expect(filterSkillsByProfile(sampleSkills, profile)).toEqual(sampleSkills);
  });
});
