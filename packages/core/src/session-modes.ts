import type { SessionState, ToolName } from "@reina/protocol";

/** Persistent composer toggles. Goal deliberately does not live here: it is
 * a host-owned lifecycle, not a prompt/tool overlay. Each ON mode overlays its
 * `extraDirectTools` onto whatever the active agent profile already
 * exposes AND contributes a diffable `<session-mode>` context section. Modes
 * Session-scoped
 * (a new session starts with everything off) and persisted via the
 * `session_modes_changed` rollout event so a cold replay restores them.
 *
 * UI keys, IPC payloads, and rollout events all reference the keys
 * declared here — this file is the single source of truth. */

export type SessionModeName = "team";

export type SessionModeDefinition = {
  /** Composer-popover label (matches the Chinese UI styling of the rest
   * of the composer). */
  label: string;
  /** Short description used as the toggle's tooltip / aria-label. */
  description: string;
  /** Deferred-by-default tools to overlay into the cold-start tools
   * array while this mode is on. Deduped against the active profile's
   * own `extraDirectTools` at `availableTools()` time; `toolPermissions`
   * deny still wins. */
  extraDirectTools: ReadonlyArray<ToolName>;
  /** Model instruction used while this mode is on. The engine wraps it in
   * `<session-mode name="...">` so the model can distinguish it from
   * one-shot slash reminders and appends it only on state changes. */
  turnReminder: string;
  /** One-shot transition notice injected on the SINGLE turn right after this
   * mode flips ON→OFF. While ON the model narrates a persona ("我是协调者…")
   * into durable history; simply dropping `turnReminder` on the off-turn
   * leaves that self-narration in place, so a weak model keeps role-playing
   * the retired mode. Mirrors codex's `build_collaboration_mode_update_item`
   * OFF branch (参考/codex .../context_manager/updates.rs): on the diff, codex
   * injects the new mode's instructions to actively re-ground the model rather
   * than relying on the absence of a reminder. */
  exitReminder: string;
};

export const SESSION_MODES: Record<SessionModeName, SessionModeDefinition> = {
  team: {
    label: "团队模式",
    description: "DAG 协调 + 异步 worker 工具集常驻；适合多模块/多阶段并行任务。",
    extraDirectTools: [
      "create_subtask",
      "update_subtask",
      "get_dag",
      "set_phase",
      "send_to_worker",
      "task",
      "get_async_tasks",
      "wait_async_tasks",
      "update_async_task",
      "cancel_async_task",
    ],
    turnReminder: [
      "你处于 Team 模式：任务是 DAG-shaped——拆 subtask、按依赖调度、收结果、综合。你自己也是完整 agent（read_file / run_shell / edit_file 都能用）：轻活默认自己干；worker 是 escalation——≥2 个独立 ready 节点可并行、大噪音/低 SNR 的批量读取、需要隔离或真长跑时才派。",
      "",
      "硬规则：",
      "- 当前还没拆过 subtask（用 `get_dag` 确认） → 先 `set_phase(\"plan\")`，自己摸清现状（git status / rg / 读关键文件）再 `create_subtask` 拆节点，依赖用 `blockedBy` 串（blocker 完成后 blocked 自动转 pending）。",
      "- DAG 已经有节点 → 每轮 `get_dag` 起步，只认本轮 ready 列表。≥2 个独立 ready 节点 → **同一回复内** 并行发多条 `task`（wall-clock = max 而非 sum；逐条发等于串行）。**每条都带 `subtaskId`**：引擎会自动把节点标 in_progress + 绑 worker（当轮离开 ready，防重复派），worker 跑完自动回写节点状态并级联解锁——不用再手动 `update_subtask` bind/收尾。单个 ready / 串行小活 → 自己干完 `update_subtask` 标 completed。已 in_progress / 已绑定的节点绝不再派；纠偏在跑的 worker 用 `update_async_task` 续发。",
      "- `get_dag` 返回 `stalled`（绑定的 worker 已失联，如进程重启） → 当轮处理：`update_async_task` 续跑、`task` 重派（自动重绑），或 `update_subtask` 收口，别放着不管。",
      "- 阶段推进：plan → exec → verify → fix → complete。**换阶段前必须先写一条 `kind:handoff` note（tags:[\"kind:handoff\"]，覆盖 Decided/Rejected/Risks/Files/Remaining），否则引擎拒绝 `set_phase`。** 转 `complete` 还要求 DAG 全部收口：所有节点 completed 或显式 cancelled，有 pending/in_progress/failed 节点时引擎直接拒绝。verify 要看原始输出就自己跑测试/lint，要独立第二意见或跑得久就派 worker。fix 每条 pipeline 引擎限进 3 次：不收敛就诚实收口（cancel + resultSummary 后 complete，或 set_phase(\"failed\")），要换思路先回 plan（重置额度）。",
      "",
      "只有当任务确实是 2-3 个独立读取这种轻量 fan-out 才跳过 DAG 直接发多条 `task`；其它一律先 plan 再 exec。",
    ].join("\n"),
    exitReminder: [
      "Team 模式已关闭。你**不再是协调者**——现在恢复单兵直接执行：直接 `read_file` / `run_shell` / `edit_file` / `write_file`，自己读代码、跑命令、写补丁、调试。",
      "忽略本对话中此前以协调者身份立下的任何调度/派 worker 设定。按用户当前请求直接动手，不要再派 worker / 拆 subtask（除非用户重新开启团队模式）。",
    ].join("\n"),
  },
};

/** Canonical iteration order. Used everywhere that needs a stable order
 * (mode-extra-tools dedup, reminder injection, UI rendering, IPC payload
 * shape) so prompt-cache and snapshot equality stay deterministic. */
export const SESSION_MODE_NAMES = Object.keys(SESSION_MODES) as SessionModeName[];

export function isSessionModeName(value: unknown): value is SessionModeName {
  return typeof value === "string" && (SESSION_MODE_NAMES as string[]).includes(value);
}

/** Names of modes that are currently ON, in canonical order. */
export function activeSessionModes(modes: SessionState["sessionModes"]): SessionModeName[] {
  if (!modes) return [];
  return SESSION_MODE_NAMES.filter((name) => modes[name] === true);
}

/** Deduplicated extra-direct tools from every active mode. Stable order:
 * follows `SESSION_MODE_NAMES`, then within-mode order. */
export function modeExtraDirectTools(modes: SessionState["sessionModes"]): ToolName[] {
  const seen = new Set<string>();
  const out: ToolName[] = [];
  for (const name of activeSessionModes(modes)) {
    for (const tool of SESSION_MODES[name].extraDirectTools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      out.push(tool);
    }
  }
  return out;
}

/** Current instructions from every active mode. The engine wraps
 * each `body` in `<session-mode name="...">…</session-mode>` before
 * pushing into the per-turn `systemReminders` array. Each body has a
 * trailing "Tools added by this mode" line appended automatically so the
 * model has a definitive answer to "what does this toggle put in my
 * tools array" without having to cross-reference the Hidden tools roster. */
export function modeTurnReminders(
  modes: SessionState["sessionModes"],
): Array<{ name: SessionModeName; body: string }> {
  return activeSessionModes(modes).map((name) => {
    const def = SESSION_MODES[name];
    const toolsLine = `Tools added by this mode (already in your tools array — call directly): ${def.extraDirectTools.join(", ")}.`;
    return { name, body: `${def.turnReminder}\n\n${toolsLine}` };
  });
}

/** One-shot transition notice for a mode that just flipped ON→OFF, wrapped so
 * the model reads it as the authoritative "this changed" signal (not a standing
 * steer). The engine queues this for the single turn after the toggle; see
 * `SessionModeDefinition.exitReminder` for why dropping the on-reminder isn't
 * enough on its own. */
export function modeExitReminder(name: SessionModeName): string {
  return `<session-mode-exit name="${name}">\n${SESSION_MODES[name].exitReminder}\n</session-mode-exit>`;
}
