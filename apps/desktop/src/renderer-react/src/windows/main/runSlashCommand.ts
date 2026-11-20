// Slash-command dispatch for the React main chat composer — the missing
// `runSlashCommand` the legacy renderer kept in actions/prompt.js. The slash
// popover only PRIMES the composer (sets the textarea to "/foo "); the command
// actually EXECUTES here, on send, when the user's message starts with "/".
// Without this, every slash command degraded to literal text sent to the model.
//
// Behaviour is ported field-for-field from legacy runSlashCommand:
//   /agent <name>  — switch the live agent profile (no settings window)
//   /use <model>   — switch the live model
//   /goal <text>   — host creates Goal state, then starts the first turn
//   /plan          — switch the native permission mode to read-only planning
//   /team <text>   — turn Team session-mode ON + steer into DAG coordination
//   /verify [text] — steer: pause and verify the last claim with evidence
//   /cancel [text] — steer: wind down autopilot + async tasks + phase
//   /skill <name>  — invoke a skill directly ("Use the `x` skill.")
//   everything else — fall back to the command registry (runSlashByToken)
//
// Steer directives ride as one-shot reminders with intent:"steer" so the
// directive reaches the model without polluting the user's chat bubble — exactly
// like legacy submitUserMessage(…, { reminders, intent }).

import { getAgentSettingsState, setAgent, setMode, setModel, setSessionMode } from "./agentSettings";
import { runSlashByToken } from "./CommandPalette";
import { appendSystemNotice, compactSession, sendMessage, startGoal } from "./sessionStore";
import { formatSkillDirectives } from "./skillDirectives";

export async function runSlashCommand(message: string): Promise<void> {
  const name = message.split(/\s+/, 1)[0].toLowerCase();
  const arg = message.slice(name.length).trim();
  const settings = getAgentSettingsState();

  // `/agent <name>` and `/use <model>` switch the live session without opening
  // the settings panel. Without an arg they fall through to the command registry
  // (which opens the picker).
  if (arg) {
    if (name === "/agent") {
      const profile = settings.agentProfiles.find(
        (p) => p.name === arg || p.name.toLowerCase() === arg.toLowerCase(),
      );
      if (profile) {
        setAgent(profile.name);
        appendSystemNotice(`Agent → ${profile.name}`);
      } else {
        appendSystemNotice(`Unknown agent: ${arg}`);
      }
      return;
    }
    if (name === "/use") {
      const model = settings.knownModels.find(
        (m) =>
          m.id === arg ||
          m.id.toLowerCase() === arg.toLowerCase() ||
          m.label?.toLowerCase() === arg.toLowerCase(),
      );
      if (model) {
        setModel(model);
        appendSystemNotice(`Model → ${model.label || model.id}`);
      } else {
        appendSystemNotice(`Unknown model: ${arg}`);
      }
      return;
    }
  }

  // `/goal <text>` — create durable Goal state in the host BEFORE any model
  // request. No reminder and no model-side set call means registration cannot
  // repeat on later turns. `/goal --replace <text>` is the explicit user-only
  // replacement path for an unfinished Goal.
  if (name === "/goal" && arg) {
    const replace = arg.startsWith("--replace ");
    const objective = replace ? arg.slice("--replace ".length).trim() : arg;
    if (objective) await startGoal(objective, replace);
    return;
  }

  // `/plan` — enter the engine's native plan permission mode. The next task
  // is constrained to read-only investigation and the model exits through
  // `exit_plan_mode`, so this is state selection rather than a chat message.
  if (name === "/plan") {
    setMode("plan");
    appendSystemNotice("Plan mode enabled");
    return;
  }

  // `/verify [text]` — steer the model away from generic "looks good" toward
  // concrete evidence. Optional arg narrows what to verify.
  if (name === "/verify") {
    const target = arg || "the work you just claimed to complete";
    const directive = [
      `[user invoked /verify — pause new work and verify ${target}. Concrete steps:`,
      "  1. Re-read the diff / changed files.",
      "  2. Run the relevant tests / lint / type-check; quote the actual output.",
      "  3. Re-check the original spec / user request line-by-line; note any unmet criteria.",
      '  4. Report SPECIFICALLY what you checked and the result — not a generic "looks good".',
      "  5. If something is wrong, fix it now; if all checks pass, say so with evidence.]",
    ].join("\n");
    await sendMessage(arg ? `/verify ${arg}` : "/verify", [], [directive], "steer");
    return;
  }

  // `/cancel [reason]` — graceful teardown of active multi-turn / async work.
  if (name === "/cancel") {
    const reason = arg || "user requested cancellation";
    const directive = [
      `[user invoked /cancel (reason: ${reason}) — wind down all active multi-turn work in this session:`,
      "  1. Call `get_async_tasks({detail: \"headers\"})`; cancel each running child with `cancel_async_task`.",
      '  2. If autopilot is active, write a brief `kind:handoff` note summarizing where you stopped, then call `declare_audit_done({status: "blocked", summary: "..."})`.',
      "  3. If a team phase is set, call `set_phase(null)` after the handoff note is written.",
      "  4. Confirm what was cancelled and what state was preserved.]",
    ].join("\n");
    await sendMessage(arg ? `/cancel ${arg}` : "/cancel", [], [directive], "steer");
    return;
  }

  // `/team <text>` — flip the persistent Team toggle ON, then steer the first
  // turn to plan a DAG. MUST await setSessionMode (see /goal's IPC-race note).
  if (name === "/team" && arg) {
    await setSessionMode("team", true);
    const directive =
      '[user invoked /team — DAG-coordination mode is now ON. Your FIRST action this turn MUST be `set_phase("plan")` followed by `create_subtask` calls to decompose the user\'s request into file-scoped or module-scoped nodes (use `blockedBy` for dependencies). DO NOT do direct shell/file investigation yourself this turn — that\'s a worker\'s job once you dispatch it. After the DAG is sketched, call `set_phase("exec")` and emit MULTIPLE `task` calls in ONE response for parallel fan-out. The <session-mode name="team"> reminder has the full working loop and rules.]';
    await sendMessage(`/team ${arg}`, [], [directive], "steer");
    return;
  }

  // `/compact` — deterministic manual compaction via the host control op. Handled
  // here (not via the command registry) so it works mid-turn: compactSession
  // interrupts a running turn first, which the registry's working-gated entry can't.
  if (name === "/compact") {
    await compactSession();
    return;
  }

  // `/skill <name>` directly invokes a skill (no picker). The React main store
  // has no skills catalog, so we send the directive verbatim and let the engine
  // resolve the skill (legacy additionally matched/validated the name + appended
  // the description; sending the bare directive is functionally equivalent).
  // Tagged wire format so the transcript renders a chip (skillDirectives.ts).
  if (name === "/skill" && arg) {
    await sendMessage(formatSkillDirectives([arg], ""));
    return;
  }

  // Generic tokens (/new, /open, /interrupt, /mode, /clear, /settings, …) run
  // against the command registry; unknown tokens open the palette seeded with the
  // raw text (mirror legacy's `state.commands.find(slash===name)` tail).
  await runSlashByToken(name, message);
}
