import { describe, expect, it } from "vitest";
import { modelConfigSchema, normalizeReasoningEffort, reasoningEfforts } from "./index.js";

describe("reasoningEffort tiers (Claude Code parity)", () => {
  it("exposes the six Claude Code tiers in ascending order", () => {
    expect(reasoningEfforts).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  it("migrates the legacy 'extra-high' value to 'xhigh' on parse", () => {
    const parsed = modelConfigSchema.parse({ reasoningEffort: "extra-high" });
    expect(parsed.reasoningEffort).toBe("xhigh");
  });

  it("passes every canonical tier through parse unchanged", () => {
    for (const tier of reasoningEfforts) {
      expect(modelConfigSchema.parse({ reasoningEffort: tier }).reasoningEffort).toBe(tier);
    }
  });

  it("rejects an unknown effort value", () => {
    expect(() => modelConfigSchema.parse({ reasoningEffort: "ludicrous" })).toThrow();
  });

  it("normalizeReasoningEffort remaps only the legacy alias", () => {
    expect(normalizeReasoningEffort("extra-high")).toBe("xhigh");
    expect(normalizeReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeReasoningEffort("max")).toBe("max");
    expect(normalizeReasoningEffort(undefined)).toBe(undefined);
  });

  it("parses supportedEfforts and migrates legacy 'extra-high' entries", () => {
    const parsed = modelConfigSchema.parse({ supportedEfforts: ["high", "extra-high", "max"] });
    expect(parsed.supportedEfforts).toEqual(["high", "xhigh", "max"]);
  });

  it("supportedEfforts is optional and rejects unknown entries", () => {
    expect(modelConfigSchema.parse({}).supportedEfforts).toBeUndefined();
    expect(() => modelConfigSchema.parse({ supportedEfforts: ["ludicrous"] })).toThrow();
  });
});
