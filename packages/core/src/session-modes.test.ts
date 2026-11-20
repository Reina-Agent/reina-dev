import { describe, expect, it } from "vitest";
import {
  SESSION_MODES,
  SESSION_MODE_NAMES,
  activeSessionModes,
  isSessionModeName,
  modeExtraDirectTools,
  modeTurnReminders,
} from "./session-modes.js";

describe("session modes", () => {
  it("keeps Goal out of the mode roster", () => {
    expect(SESSION_MODE_NAMES).toEqual(["team"]);
    expect(isSessionModeName("goal")).toBe(false);
    expect(isSessionModeName("team")).toBe(true);
    expect(SESSION_MODES).not.toHaveProperty("goal");
  });

  it("Team carries the DAG and async-task tools", () => {
    const tools = new Set(SESSION_MODES.team.extraDirectTools);
    for (const required of ["create_subtask", "set_phase", "get_dag", "task", "get_async_tasks", "wait_async_tasks"]) {
      expect(tools.has(required as never)).toBe(true);
    }
  });

  it("ignores the deprecated legacy goal flag", () => {
    expect(activeSessionModes({ goal: true })).toEqual([]);
    expect(activeSessionModes({ goal: true, team: true })).toEqual(["team"]);
    expect(modeExtraDirectTools({ goal: true })).toEqual([]);
    expect(modeTurnReminders({ goal: true })).toEqual([]);
  });

  it("emits one stable Team reminder and exact tool overlay", () => {
    const reminders = modeTurnReminders({ team: true });
    expect(reminders.map((item) => item.name)).toEqual(["team"]);
    expect(reminders[0]!.body).toContain(SESSION_MODES.team.turnReminder);
    for (const tool of SESSION_MODES.team.extraDirectTools) expect(reminders[0]!.body).toContain(tool);
    expect(new Set(modeExtraDirectTools({ team: true }))).toEqual(new Set(SESSION_MODES.team.extraDirectTools));
  });
});
