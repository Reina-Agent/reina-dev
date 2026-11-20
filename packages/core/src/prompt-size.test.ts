import { describe, expect, it } from "vitest";
import { deferredToolDescriptors, directToolDescriptors, publicToolDescriptors } from "@reina/tools";
import { toolInputJsonSchema } from "@reina/providers";
import { estimateTextTokens } from "./compaction.js";
import { buildSystemPrompt, formatDeferredToolsCatalog } from "./engine-prompt.js";
import { loadSkills } from "./skills.js";
import { profiles } from "./profiles.js";

describe("prompt-size analysis", () => {
  it("keeps the default native tool prefix within the recorded lean budget", () => {
    const directNames = new Set(directToolDescriptors.map((tool) => tool.name));
    const deferredNames = new Set(deferredToolDescriptors.map((tool) => tool.name));
    expect(directToolDescriptors).toHaveLength(15);
    expect(directNames.has("list_notes")).toBe(true);
    expect(directNames.has("read_note")).toBe(true);
    expect(directNames.has("apply_patch")).toBe(false);
    expect(deferredNames.has("apply_patch")).toBe(true);
    expect(directNames.has("note")).toBe(false);
    expect(directNames.has("update_note")).toBe(false);
    expect(directNames.has("delete_note")).toBe(false);

    const directTokens = directToolDescriptors.reduce((total, tool) => {
      const schema = JSON.stringify(toolInputJsonSchema(tool));
      return total + estimateTextTokens(tool.description) + estimateTextTokens(schema);
    }, 0);
    expect(directTokens).toBeLessThanOrEqual(5_000);

    const catalog = formatDeferredToolsCatalog();
    expect(estimateTextTokens(catalog)).toBeLessThanOrEqual(160);
    expect(catalog).not.toContain("start_async_task");
    expect(catalog).not.toContain("update_note");
  });

  it("dumps cold-start prompt + tool breakdown", async () => {
    const cwd = process.cwd();
    const skills = await loadSkills(cwd);
    const profile = profiles[0]!;

    const session: any = {
      id: "test",
      title: "test",
      agent: profile.name,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      cwd,
      model: { provider: "deterministic", model: "x" },
      permissionMode: "default",
      messages: [],
      toolCalls: [],
      trace: [],
      approvals: [],
      questions: [],
      skills,
      asyncTasks: [],
      subagentDepth: 0,
    };

    const sp = buildSystemPrompt(session);
    console.log("\n=== SYSTEM PROMPT total chars:", sp.length, "  approx tokens (/4):", Math.round(sp.length / 4));

    const blocks = sp.split("\n\n").map((b) => ({ chars: b.length, head: b.split("\n")[0].slice(0, 90) }));
    console.log("\n--- SP blocks (by chars desc):");
    for (const b of [...blocks].sort((a, b) => b.chars - a.chars)) {
      console.log(String(b.chars).padStart(6), "|", b.head);
    }

    const measure = (descs: typeof publicToolDescriptors, label: string) => {
      let descTotal = 0;
      let schemaTotal = 0;
      const rows: { name: string; desc: number; schema: number; total: number }[] = [];
      for (const t of descs) {
        const descLen = (t.description || "").length;
        const schemaJson = JSON.stringify(toolInputJsonSchema(t));
        const schemaLen = schemaJson.length;
        descTotal += descLen;
        schemaTotal += schemaLen;
        rows.push({ name: t.name, desc: descLen, schema: schemaLen, total: descLen + schemaLen });
      }
      console.log(`\n=== ${label} (n=${descs.length}) desc:`, descTotal, "schema:", schemaTotal, "approx tokens (/4):", Math.round((descTotal + schemaTotal) / 4));
      for (const r of [...rows].sort((a, b) => b.total - a.total)) {
        console.log(String(r.total).padStart(6), "| desc:", String(r.desc).padStart(5), "schema:", String(r.schema).padStart(4), "|", r.name);
      }
    };
    measure(directToolDescriptors, "DIRECT TOOLS (in request)");
    measure(deferredToolDescriptors, "DEFERRED TOOLS (not in cold-start request)");
    console.log("\nAll-tools count:", publicToolDescriptors.length);
    console.log("Skills count:", skills.length, "| names:", skills.map((s) => s.name).join(", "));
  });
});
