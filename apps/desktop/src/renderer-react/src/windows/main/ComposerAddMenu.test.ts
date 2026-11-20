import { describe, expect, it } from "vitest";
import { prepareGoalDraft, visibleAddMenuSkills } from "./composerAddMenuModel";

describe("ComposerAddMenu helpers", () => {
  it("enters Goal mode without inserting a slash command", () => {
    expect(prepareGoalDraft("")).toBe("");
  });

  it("preserves an existing draft as the Goal objective", () => {
    expect(prepareGoalDraft("  ship the unified menu  ")).toBe("  ship the unified menu  ");
  });

  it("removes a legacy Goal prefix from an existing draft", () => {
    expect(prepareGoalDraft("/goal ship it")).toBe("ship it");
    expect(prepareGoalDraft("/goal")).toBe("");
  });

  it("keeps model-only skills out of the user picker", () => {
    expect(
      visibleAddMenuSkills([{ name: "visible" }, { name: "hidden", userInvocable: false }, { name: "" }]).map(
        (skill) => skill.name,
      ),
    ).toEqual(["visible"]);
  });
});
