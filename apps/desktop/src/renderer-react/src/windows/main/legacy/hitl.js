// Render the Human-in-the-loop dock above the composer. Visual model is
// Claude Code's permission prompt: a single question line, a vertical list
// of numbered options, and a free-text input that doubles as "reject with
// feedback". No tool badges, no preview by default — the question carries
// the context.

export function renderHitlDockView({ els, pendingPermissions, pendingQuestions, collapsed, actions, helpers }) {
  const permissionCount = pendingPermissions.size;
  const questionCount = pendingQuestions.size;
  const total = permissionCount + questionCount;
  els.hitlDock.hidden = total === 0;
  if (total === 0) return;

  els.hitlTitle.textContent = total === 1 ? "" : `${total} pending`;
  els.hitlSubtitle.hidden = true;
  els.hitlDock.classList.toggle("collapsed", collapsed);
  els.hitlDock.classList.toggle("single", total === 1);
  els.hitlCollapseButton.classList.toggle("rotated", collapsed);
  els.hitlCollapseButton.title = collapsed ? "Expand" : "Collapse";

  els.permissionList.textContent = "";
  els.questionList.textContent = "";
  if (collapsed) return;

  // Batch row only when multiple tool prompts are queued.
  if (permissionCount > 1) {
    const batch = document.createElement("div");
    batch.className = "hitl-batch";
    const note = document.createElement("span");
    note.className = "hitl-batch-note";
    note.textContent = `${permissionCount} pending`;
    const approveAll = document.createElement("button");
    approveAll.className = "hitl-batch-button hitl-batch-primary";
    approveAll.textContent = "Approve all";
    approveAll.onclick = () => actions.approveAll?.(true);
    const rejectAll = document.createElement("button");
    rejectAll.className = "hitl-batch-button";
    rejectAll.textContent = "Reject all";
    rejectAll.onclick = () => actions.approveAll?.(false);
    batch.append(note, approveAll, rejectAll);
    els.permissionList.appendChild(batch);
  }

  for (const toolCall of pendingPermissions.values()) renderPermissionItem(els.permissionList, toolCall, actions, helpers);

  // Group pendingQuestions by groupId. Questions without groupId are solo
  // (each its own article). Questions with the same groupId share one card
  // with one Submit button — they were spawned from a single batched
  // `question` tool call and resolve atomically.
  const groups = new Map();
  const solos = [];
  for (const question of pendingQuestions.values()) {
    if (question.groupId) {
      if (!groups.has(question.groupId)) groups.set(question.groupId, []);
      groups.get(question.groupId).push(question);
    } else {
      solos.push(question);
    }
  }
  for (const question of solos) renderQuestionItem(els.questionList, question, actions);
  for (const [groupId, members] of groups) renderQuestionGroup(els.questionList, groupId, members, actions);

  // Hands-on-keyboard moment: when the dock appears (or repopulates while
  // the user is focused elsewhere), pull focus to the primary option of the
  // first pending item so 1-N, Enter, Esc and Arrows all work without a
  // preceding mouse click. If the user has already tabbed into the dock —
  // e.g. they're typing feedback — leave their focus alone.
  if (!els.hitlDock.contains(document.activeElement)) {
    const firstPrimary = els.hitlDock.querySelector(".hitl-option.is-primary")
      ?? els.hitlDock.querySelector(".hitl-option");
    firstPrimary?.focus({ preventScroll: false });
  }
}

// Split a question string on backtick-fenced spans and render each as either
// a text node or a <code> element. Safer than innerHTML — never interprets
// the rest of the source as markup.
function renderQuestionMarkup(target, source) {
  target.textContent = "";
  const parts = String(source).split(/`([^`]+)`/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) target.appendChild(document.createTextNode(parts[i]));
    } else {
      const code = document.createElement("code");
      code.textContent = parts[i];
      target.appendChild(code);
    }
  }
}

// Map a tool call to a single-line yes/no question. The point is to put
// the relevant context (command, path, url) into the question itself so a
// preview isn't needed for the common cases.
function questionFor(toolCall, helpers) {
  const input = (toolCall.input || {});
  const trunc = (text, max = 100) => helpers.truncate(String(text || ""), max);
  switch (toolCall.name) {
    case "run_shell":
      return `Run \`${trunc(input.command, 120)}\`?`;
    case "kill_shell":
      return `Kill shell \`${trunc(input.shellId || input.shell_id, 40)}\`?`;
    case "task_output":
      return `Read output from shell \`${trunc(input.shellId || input.shell_id, 40)}\`?`;
    case "write_file":
      return `Write to \`${trunc(input.path || input.file_path, 80)}\`?`;
    case "edit_file":
    case "multi_edit":
    case "apply_patch":
      return `Make this edit to \`${trunc(input.path || input.file_path, 80)}\`?`;
    case "read_file":
      return `Read \`${trunc(input.path || input.file_path, 80)}\`?`;
    case "list_files":
      return `List files in \`${trunc(input.path || ".", 80)}\`?`;
    case "glob":
      return `Search files matching \`${trunc(input.pattern, 80)}\`?`;
    case "grep":
    case "code_search":
      return `Search code for \`${trunc(input.pattern || input.query, 80)}\`?`;
    case "web_fetch":
      return `Fetch ${trunc(input.url, 100)}?`;
    case "task":
      return `Spawn subagent \`${trunc(input.subagentType || input.subagent_type || "agent", 40)}\`?`;
    default: {
      const summary = toolCall.summary && !/^Call\s+\w+$/i.test(toolCall.summary) ? `: ${toolCall.summary}` : "";
      return `Allow ${toolCall.name}${summary}?`;
    }
  }
}

/** Derive a persistent permission rule (and a human label) for the
 * "Always allow X" option. Returns null when the call has no sensible
 * pattern — we'd rather omit the option than offer one that ends up
 * blanket-allowing every call of a tool. Currently supports shell prefixes
 * (`git status`, `npm run build`, etc.); other tools fall back to nothing. */
function persistentAllowOption(toolCall) {
  if (toolCall.name === "run_shell") {
    const command = String(toolCall.input?.command || "").trim();
    if (!command) return null;
    const prefix = shellApprovalPrefix(command);
    if (!prefix) return null;
    return {
      label: `${prefix}*`,
      rule: { tool: "run_shell", mode: "allow", commandPrefix: prefix },
    };
  }
  return null;
}

// Mirrors core/shell-approval.ts PREFIX_ARITY — update BOTH copies together
// (the renderer offers the label, core mints the equivalent session rule).
// Arity = leading tokens forming the command unit; only multi-token entries,
// single-token commands (rm, cat, …) stay exact-command.
const PREFIX_ARITY = {
  "aws": 3, "az": 3, "bazel": 2, "brew": 2,
  "bun": 2, "bun run": 3, "bun x": 3,
  "cargo": 2, "cargo add": 3, "cargo run": 3,
  "choco": 2, "cmake": 2, "composer": 2, "corepack": 2,
  "deno": 2, "deno task": 3,
  "docker": 2, "docker builder": 3, "docker compose": 3, "docker container": 3,
  "docker image": 3, "docker network": 3, "docker volume": 3,
  "dotnet": 2, "firebase": 2, "flyctl": 2, "gcloud": 3, "gh": 3,
  "git": 2, "git config": 3, "git remote": 3, "git stash": 3,
  "go": 2, "gradle": 2, "helm": 2, "heroku": 2,
  "kind": 2, "kind create": 3, "kubectl": 2, "kubectl rollout": 3,
  "make": 2, "minikube": 2, "mvn": 2, "netlify": 2, "ng": 2, "node": 2,
  "npm": 2, "npm exec": 3, "npm init": 3, "npm run": 3, "npm view": 3,
  "npx": 2, "nvm": 2, "nx": 2,
  "pip": 2, "pip3": 2, "pipenv": 2,
  "pnpm": 2, "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3,
  "podman": 2, "podman container": 3, "podman image": 3,
  "poetry": 2, "pulumi": 2, "pulumi stack": 3, "pyenv": 2,
  "python": 2, "python3": 2, "rake": 2, "rustup": 2, "scoop": 2,
  "swift": 2, "systemctl": 2, "terraform": 2, "terraform workspace": 3,
  "tmux": 2, "turbo": 2, "uv": 2, "uv run": 3,
  "vercel": 2, "volta": 2, "winget": 2,
  "yarn": 2, "yarn dlx": 3, "yarn run": 3,
};

function shellApprovalPrefix(command) {
  // Mirrors core/shell-approval.ts `suggestedShellApprovalPrefix`. Keeping a
  // small copy in the renderer avoids importing engine internals into the UI.
  // Never distil a COMPOUND command into a broad prefix rule: a persistent
  // `npm run build` allow minted from `npm run build && curl … | sh` would
  // silently authorise whatever is chained after the vetted head. Mirrors
  // core's hasCommandChaining (quote-aware; core's permission matcher would
  // refuse to auto-allow the compound anyway, so offering the option here
  // would only mint a rule that never fires for the command the user saw).
  if (hasCommandChaining(command)) return null;
  const parts = command.trim().replace(/\s+/g, " ").match(/"[^"]*"|'[^']*'|\S+/g);
  if (!parts) return null;
  const cleaned = parts.map((part) => part.replace(/^["']|["']$/g, ""));
  const head = cleaned[0]?.toLowerCase().replace(/\.exe$/, "");
  if (!head) return null;
  const tokens = [head, ...cleaned.slice(1).map((part) => part.toLowerCase())];
  // Longest matching dictionary key wins ("npm run" beats "npm").
  let arity;
  for (let len = Math.min(tokens.length, 2); len > 0; len--) {
    const hit = PREFIX_ARITY[tokens.slice(0, len).join(" ")];
    if (hit !== undefined) {
      arity = hit;
      break;
    }
  }
  if (arity === undefined) return null;
  // Shorter than the command unit ("npm run" with no script) would mint a
  // rule matching EVERY script — offer nothing, core falls back to exact.
  if (tokens.length < arity) return null;
  const kept = tokens.slice(0, arity);
  // A flag in a subcommand slot ("git -C /x status" → "git -c") describes
  // nothing the user vetted — offer nothing.
  if (kept.some((token, index) => index > 0 && token.startsWith("-"))) return null;
  return kept.join(" ");
}

function hasCommandChaining(raw) {
  // Mirrors core/shell-approval.ts `hasCommandChaining`.
  const command = raw.trim();
  if (command.includes("$(") || command.includes("`")) return true;
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, "");
  return /[;&|<>\n\r]/.test(unquoted);
}

/** Build a compact diff/content preview for write-class permission cards.
 * Returns null when the tool isn't a write/edit or the preview would be empty.
 * Preview is capped at PREVIEW_MAX_LINES total (additions + removals) and
 * each line is truncated to PREVIEW_MAX_COLS chars — the dock has tight
 * height; full-fidelity is for the workspace diff viewer. */
const PREVIEW_MAX_LINES = 14;
const PREVIEW_MAX_COLS = 200;

function buildDiffPreview(toolCall) {
  const input = toolCall.input || {};
  const lines = [];
  if (toolCall.name === "write_file") {
    const content = String(input.content ?? "");
    if (content.length === 0) return null;
    for (const line of content.split(/\r?\n/)) lines.push({ kind: "add", text: line });
  } else if (toolCall.name === "edit_file") {
    pushEditLines(lines, input.oldText, input.newText);
  } else if (toolCall.name === "multi_edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const [i, edit] of edits.entries()) {
      if (i > 0) lines.push({ kind: "hunk", text: `── edit ${i + 1} ──` });
      pushEditLines(lines, edit?.oldText, edit?.newText);
      if (lines.length >= PREVIEW_MAX_LINES) break;
    }
  } else if (toolCall.name === "apply_patch") {
    const patch = String(input.patch ?? input.diff ?? "");
    if (patch.length === 0) return null;
    for (const raw of patch.split(/\r?\n/)) {
      if (raw.startsWith("+++") || raw.startsWith("---")) continue;
      if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
      else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
      else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
      else lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  } else {
    return null;
  }
  if (lines.length === 0) return null;
  const totalLines = lines.length;
  const shown = lines.slice(0, PREVIEW_MAX_LINES);

  const wrap = document.createElement("div");
  wrap.className = "hitl-diff-preview";
  for (const line of shown) {
    const row = document.createElement("div");
    row.className = `hitl-diff-line is-${line.kind}`;
    const sign = document.createElement("span");
    sign.className = "hitl-diff-sign";
    sign.textContent = line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "hunk" ? "" : " ";
    const code = document.createElement("span");
    code.className = "hitl-diff-code";
    const text = line.text.length > PREVIEW_MAX_COLS ? `${line.text.slice(0, PREVIEW_MAX_COLS)}…` : line.text;
    code.textContent = text || " ";
    row.append(sign, code);
    wrap.appendChild(row);
  }
  if (totalLines > PREVIEW_MAX_LINES) {
    const more = document.createElement("div");
    more.className = "hitl-diff-line is-more";
    more.textContent = `… (${totalLines - PREVIEW_MAX_LINES} more lines)`;
    wrap.appendChild(more);
  }
  return wrap;
}

function pushEditLines(lines, oldText, newText) {
  const old = String(oldText ?? "");
  const next = String(newText ?? "");
  if (old) for (const line of old.split(/\r?\n/)) lines.push({ kind: "del", text: line });
  if (next) for (const line of next.split(/\r?\n/)) lines.push({ kind: "add", text: line });
}

function renderPermissionItem(parent, toolCall, actions, helpers) {
  const node = document.createElement("article");
  node.className = "hitl-item permission-item";

  const q = document.createElement("div");
  q.className = "hitl-question";
  renderQuestionMarkup(q, questionFor(toolCall, helpers));
  node.appendChild(q);

  const preview = buildDiffPreview(toolCall);
  if (preview) node.appendChild(preview);

  // Build the option list. Order: Allow → Allow similar → Edit → Reject.
  // We skip Edit unless `allowedDecisions` lets us; same for the others.
  const decisions = Array.isArray(toolCall.allowedDecisions) && toolCall.allowedDecisions.length > 0
    ? toolCall.allowedDecisions
    : ["approve", "reject"];

  // Vertical numbered list, Claude Code style. Order: Allow → Allow similar
  // (session) → Always allow (persistent) → Edit → Reject. Secondary actions
  // are styled muted so the eye lands on the primary "Allow" first.
  const options = [];
  if (decisions.includes("approve")) {
    options.push({ label: "Yes, allow", primary: true, onClick: () => actions.approve(toolCall.id, true) });
    options.push({ label: "Allow similar for this session", muted: true, onClick: () => actions.approve(toolCall.id, true, { remember: "session" }) });
    const persistent = persistentAllowOption(toolCall);
    if (persistent && actions.alwaysAllow) {
      options.push({
        label: `Always allow \`${persistent.label}\` in this workspace`,
        muted: true,
        onClick: () => actions.alwaysAllow(toolCall.id, persistent.rule),
      });
    }
  }
  if (decisions.includes("edit")) {
    options.push({ label: "Edit input first", muted: true, onClick: () => openEditor(node, toolCall, actions, helpers) });
  }
  if (decisions.includes("reject")) {
    options.push({ label: "No, reject", muted: true, onClick: () => actions.approve(toolCall.id, false) });
  }

  const list = document.createElement("div");
  list.className = "hitl-options";
  options.forEach((opt, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hitl-option";
    if (opt.primary) row.classList.add("is-primary");
    if (opt.muted) row.classList.add("is-muted");
    row.dataset.key = String(index + 1);
    const num = document.createElement("span");
    num.className = "hitl-option-num";
    num.textContent = String(index + 1);
    const label = document.createElement("span");
    label.className = "hitl-option-label";
    label.textContent = opt.label;
    row.append(num, label);
    row.onclick = opt.onClick;
    list.appendChild(row);
  });
  node.appendChild(list);

  // Inline reject-with-reason. Empty Enter is a no-op so typing accidents
  // don't silently reject — use option N for a plain reject.
  if (decisions.includes("reject")) {
    const feedback = document.createElement("input");
    feedback.type = "text";
    feedback.className = "hitl-feedback";
    feedback.placeholder = "Tell the agent what to do instead";
    feedback.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const reason = feedback.value.trim();
        if (reason) actions.approve(toolCall.id, false, { reason });
      }
    });
    node.appendChild(feedback);
  }

  const hint = document.createElement("div");
  hint.className = "hitl-hint";
  hint.textContent = options.length > 0
    ? `${options.map((_, i) => i + 1).join("/")} · Esc to dismiss`
    : "Esc to dismiss";
  node.appendChild(hint);

  installItemKeyboardNav(node, options);

  parent.appendChild(node);
}

// Wire up the keyboard model for a HITL article:
//   1-N: select that option (when not typing in feedback)
//   ↑/↓: move focus between option buttons
//   Esc: blur back to the composer textarea (soft dismiss — does NOT reject)
// This lives at the article level so it follows wherever focus is inside.
function installItemKeyboardNav(node, options) {
  const optionEls = () => Array.from(node.querySelectorAll(".hitl-option"));

  node.addEventListener("keydown", (event) => {
    const inTypingField = event.target instanceof HTMLInputElement
      || event.target instanceof HTMLTextAreaElement;

    if (event.key === "Escape") {
      event.preventDefault();
      const composer = document.getElementById("prompt");
      if (composer instanceof HTMLTextAreaElement) composer.focus();
      else if (event.target instanceof HTMLElement) event.target.blur();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Don't hijack arrow navigation inside a multi-line text field.
      if (inTypingField) return;
      const buttons = optionEls();
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === "ArrowDown"
        ? (current + 1 + buttons.length) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
      event.preventDefault();
      return;
    }

    if (inTypingField) return;
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      event.preventDefault();
      options[n - 1].onClick();
    }
  });
}

function openEditor(node, toolCall, actions, helpers) {
  if (node.querySelector(".hitl-editor")) return;
  const wrap = document.createElement("div");
  wrap.className = "hitl-editor";
  const label = document.createElement("label");
  label.textContent = "Edit input JSON, then submit";
  const ta = document.createElement("textarea");
  ta.value = helpers.stableJson(toolCall.input);
  ta.spellcheck = false;
  ta.rows = Math.min(16, Math.max(6, ta.value.split("\n").length || 6));
  const err = document.createElement("div");
  err.className = "hitl-editor-error";
  err.hidden = true;
  const controls = document.createElement("div");
  controls.className = "hitl-form-actions";
  const submit = document.createElement("button");
  submit.className = "hitl-batch-button hitl-batch-primary";
  submit.textContent = "Approve with edits";
  const cancel = document.createElement("button");
  cancel.className = "hitl-batch-button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => wrap.remove();
  submit.onclick = () => {
    let parsed;
    try { parsed = JSON.parse(ta.value); }
    catch (parseError) {
      err.textContent = `Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
      err.hidden = false;
      return;
    }
    actions.approve(toolCall.id, true, { updatedInput: parsed });
  };
  controls.append(cancel, submit);
  wrap.append(label, ta, err, controls);
  node.appendChild(wrap);
  ta.focus();
}

/** Render a batched question group (1-4 questions answered atomically).
 * Each member renders its own widget (header, question text, options) but
 * only stages a draft answer. One shared Submit button at the bottom reads
 * every member's draft and fires actions.answerGroup. */
function renderQuestionGroup(parent, groupId, questions, actions) {
  const node = document.createElement("article");
  node.className = "hitl-item question-item question-group";

  /** id → answer (string). The Submit button stays disabled until every
   * member has SOME entry here. */
  const drafts = {};
  let submitButton = null;
  const refreshSubmit = () => {
    if (!submitButton) return;
    const ready = questions.every((q) => typeof drafts[q.id] === "string" && drafts[q.id].length > 0);
    submitButton.disabled = !ready;
    submitButton.textContent = ready ? `Submit answers (${questions.length})` : `Submit answers`;
  };

  for (const q of questions) {
    renderQuestionBody(node, q, {
      onStage: (answer) => {
        if (typeof answer === "string" && answer.length > 0) drafts[q.id] = answer;
        else delete drafts[q.id];
        refreshSubmit();
      },
    });
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "hitl-form-actions";
  submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "hitl-batch-button hitl-batch-primary";
  submitButton.onclick = () => {
    const ready = questions.every((q) => typeof drafts[q.id] === "string" && drafts[q.id].length > 0);
    if (!ready) return;
    actions.answerGroup(groupId, { ...drafts });
  };
  actionsRow.appendChild(submitButton);
  node.appendChild(actionsRow);
  refreshSubmit();

  const hint = document.createElement("div");
  hint.className = "hitl-hint";
  hint.textContent = "Pick an answer for each · Enter to submit · Esc to dismiss";
  node.appendChild(hint);

  // Submit on Enter anywhere inside the group except text inputs.
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    submitButton?.click();
  });

  parent.appendChild(node);
}

function renderQuestionItem(parent, question, actions) {
  const node = document.createElement("article");
  node.className = "hitl-item question-item";

  renderQuestionBody(node, question, {
    onAnswer: (answer) => actions.answer(question.id, answer),
  });

  parent.appendChild(node);
}

/** Shared rendering of one question's interactive widgets. The caller passes
 * EITHER `onAnswer` (solo mode — picking an option fires immediately) OR
 * `onStage` (batch mode — picking an option stages a draft to be submitted
 * together with siblings). Multi-select questions always stage internally
 * and submit via their own button (solo) or the group's Submit (batch). */
function renderQuestionBody(parent, question, callbacks) {
  // Solo mode fires on click; batch mode just stages.
  const fireOrStage = (answer) => {
    if (callbacks.onStage) callbacks.onStage(answer);
    else callbacks.onAnswer?.(answer);
  };

  if (question.header) {
    const chip = document.createElement("span");
    chip.className = "hitl-question-header";
    chip.textContent = question.header;
    parent.appendChild(chip);
  }

  const q = document.createElement("div");
  q.className = "hitl-question";
  q.textContent = question.question;
  parent.appendChild(q);

  const options = Array.isArray(question.options) ? question.options : [];
  const multiSelect = Boolean(question.multiSelect);
  const anyHasPreview = options.some((o) => typeof o.preview === "string" && o.preview.trim() !== "");
  const anyHasDescription = options.some((o) => typeof o.description === "string" && o.description.trim() !== "");

  if (anyHasPreview) parent.classList.add("has-previews");
  if (multiSelect) parent.classList.add("is-multi");

  const optionDescriptors = [];
  const selected = new Set(); // multi-select state: indices of picked options

  // Preview pane lives to the right of the option list when any option has
  // a preview. Updates on mouseenter / focusin to mirror Claude Code's
  // side-by-side layout.
  let previewPane = null;
  let previewBody = null;
  if (anyHasPreview) {
    previewPane = document.createElement("aside");
    previewPane.className = "hitl-preview";
    previewBody = document.createElement("pre");
    previewBody.className = "hitl-preview-body";
    previewPane.appendChild(previewBody);
    // Seed with first option that has a preview so the pane isn't blank
    // before the user moves focus.
    const firstWithPreview = options.find((o) => o.preview);
    if (firstWithPreview?.preview) previewBody.textContent = firstWithPreview.preview;
  }

  // Solo-mode multi-select needs its own Submit button (batch has the
  // group's Submit). isStaging = batch mode — every option click just
  // updates drafts instead of firing.
  const isStaging = Boolean(callbacks.onStage);
  let submitButton = null;
  const refreshSubmit = () => {
    if (!submitButton) return;
    submitButton.disabled = selected.size === 0;
    submitButton.textContent = selected.size > 0 ? `Submit (${selected.size})` : "Submit";
  };
  const joinedMulti = () => [...selected]
    .sort((a, b) => a - b)
    .map((i) => options[i]?.label)
    .filter((s) => typeof s === "string" && s.length > 0)
    .join(", ");
  const submitMultiSolo = () => {
    const joined = joinedMulti();
    if (joined.length === 0) return;
    callbacks.onAnswer?.(joined);
  };

  let stagedSingle = -1;
  let listEl = null;

  if (options.length > 0) {
    const layout = document.createElement("div");
    layout.className = "hitl-question-layout";
    const list = document.createElement("div");
    list.className = "hitl-options";
    if (anyHasDescription) list.classList.add("has-descriptions");
    listEl = list;

    options.forEach((option, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hitl-option";
      // Solo single-select: first option is visual default (primary).
      // Batch single-select: no primary — selection follows user click.
      // Multi-select (either mode): no primary, all start as ghost rows.
      if (!multiSelect && !isStaging && index === 0) row.classList.add("is-primary");
      row.dataset.key = String(index + 1);

      const num = document.createElement("span");
      num.className = "hitl-option-num";
      num.textContent = String(index + 1);

      const body = document.createElement("span");
      body.className = "hitl-option-body";
      const label = document.createElement("span");
      label.className = "hitl-option-label";
      label.textContent = option.label;
      body.appendChild(label);
      if (option.description) {
        const desc = document.createElement("span");
        desc.className = "hitl-option-desc";
        desc.textContent = option.description;
        body.appendChild(desc);
      }

      let check = null;
      if (multiSelect) {
        check = document.createElement("span");
        check.className = "hitl-option-check";
        check.setAttribute("aria-hidden", "true");
        row.classList.add("is-checkable");
      }

      const onClick = () => {
        if (multiSelect) {
          if (selected.has(index)) {
            selected.delete(index);
            row.classList.remove("is-selected");
            if (check) check.classList.remove("checked");
          } else {
            selected.add(index);
            row.classList.add("is-selected");
            if (check) check.classList.add("checked");
          }
          if (isStaging) callbacks.onStage(joinedMulti());
          else refreshSubmit();
        } else if (isStaging) {
          // Batch single-select: stage this row, un-highlight the old one.
          if (stagedSingle !== -1 && listEl) {
            const prev = listEl.children[stagedSingle];
            if (prev) prev.classList.remove("is-selected");
          }
          stagedSingle = index;
          row.classList.add("is-selected");
          callbacks.onStage(option.label);
        } else {
          callbacks.onAnswer?.(option.label);
        }
      };
      row.onclick = onClick;

      if (check) row.append(num, check, body);
      else row.append(num, body);

      if (previewBody) {
        const showPreview = () => {
          if (typeof option.preview === "string") previewBody.textContent = option.preview;
        };
        row.addEventListener("mouseenter", showPreview);
        row.addEventListener("focusin", showPreview);
      }

      list.appendChild(row);
      optionDescriptors.push({ onClick });
    });

    layout.appendChild(list);
    if (previewPane) layout.appendChild(previewPane);
    parent.appendChild(layout);
  }

  // Solo multi-select: per-body Submit button. Batch mode skips this — the
  // group renders one Submit at the bottom of the whole card.
  if (multiSelect && !isStaging && options.length > 0) {
    const actionsRow = document.createElement("div");
    actionsRow.className = "hitl-form-actions";
    submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "hitl-batch-button hitl-batch-primary";
    submitButton.onclick = submitMultiSolo;
    actionsRow.appendChild(submitButton);
    parent.appendChild(actionsRow);
    refreshSubmit();
  }

  // Free-text fallback. Always available for single-select questions
  // (override picked option by typing). Hidden for multi-select where
  // typed text would conflict with the checkbox set semantics. In batch
  // mode (isStaging) with options, the per-question free-text input is
  // visual noise — most users just click an option. We render it only
  // when there are NO options (then it's the answer surface). Solo mode
  // still gets the free-text input universally (Ctrl+Enter usage).
  const showFreeText = !multiSelect && (!isStaging || options.length === 0);
  if (showFreeText) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "hitl-feedback";
    input.placeholder = options.length > 0 ? "Or type your own answer" : "Type an answer";
    input.addEventListener("input", () => {
      if (!isStaging) return;
      const text = input.value.trim();
      if (text.length > 0) callbacks.onStage(text);
      else if (stagedSingle !== -1 && listEl) {
        // Falling back to the previously-staged option when input clears.
        const opt = options[stagedSingle];
        if (opt) callbacks.onStage(opt.label);
      } else {
        callbacks.onStage("");
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (isStaging) return; // group's Enter handler submits the whole batch
      event.preventDefault();
      const answer = input.value.trim();
      if (answer) callbacks.onAnswer?.(answer);
    });
    parent.appendChild(input);
  }

  // Hint row: only shown in solo mode. Batch renders its own hint below
  // the whole group's Submit button.
  if (!isStaging) {
    const hint = document.createElement("div");
    hint.className = "hitl-hint";
    if (multiSelect && options.length > 0) {
      hint.textContent = `${options.map((_, i) => i + 1).join("/")} or ↑↓ to toggle · Enter to submit · Esc to dismiss`;
    } else if (options.length > 0) {
      hint.textContent = `${options.map((_, i) => i + 1).join("/")} or ↑↓ to select · Enter to confirm · Esc to dismiss`;
    } else {
      hint.textContent = "Enter to send · Esc to dismiss";
    }
    parent.appendChild(hint);
  }

  // Solo mode: install keyboard nav at the article level (parent === article).
  // Solo multi-select: Enter submits via the layered handler below.
  // Batch mode: no per-body keyboard nav — the group provides one at its level.
  if (!isStaging) {
    installItemKeyboardNav(parent, optionDescriptors);
    if (multiSelect) {
      parent.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        submitMultiSolo();
      });
    }
  }
}
