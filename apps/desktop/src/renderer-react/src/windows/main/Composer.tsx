// Composer — React port of the legacy composer.js / actions/prompt.js behavior.
// Renders the EXACT same <footer class="composer"> DOM as the static skeleton in
// MainApp.tsx (and the legacy main.html), so legacy CSS (composer.css) applies
// identically without any class or structure changes.
//
// ## Wired behaviors
//   - Textarea auto-grow via `field-sizing: content` (CSS) + JS scroll-height
//     fallback for browsers that don't support it (rows 1 → max ~12 lines).
//   - Enter → sendMessage then clear; Shift+Enter → newline.
//   - #send button data-mode: "send" (idle, no content) disabled, "send" (idle,
//     has content) enabled, "stop" (working), "stopping" (stopping — disabled).
//   - Paste image from clipboard via readClipboardImage bridge call.
//   - Add button opens one intent menu for files, Goal, Plan, and skills. Media
//     is staged as an attachment; readable code/text is staged as file context.
//   - Drag-and-drop files onto the composer footer.
//   - #attachments-bar renders staged items with legacy classes; remove buttons
//     clear individual items.
//   - Sends staged attachments and one-shot file context with the message.
//
// ## Wired sub-features (each owns its element / store)
//   - #composer-mode/model + #composer-popover — pickers via <ComposerPickers/>.
//   - #composer-usage — context-window usage ring (usageRing.ts, fed by the
//     session snapshot + usage-updated stream events).
//   - #slash-popover — "/" command + skill autocomplete via <SlashPopover/>.
//   - #queue-panel — drafts typed while busy buffer in the store's queuedMessages;
//     manual flush ("Send now"), mirroring legacy.
//   - #context-bar — chips for @-mentioned files in the draft; their contents ride
//     as one-shot reminders on send.
//   - .skill-tag — skills staged via /skill (store pendingSkills); prepended as
//     <skill-directive> tags on send (skillDirectives.ts; ChatEntry renders
//     them back as chips instead of raw scaffolding).
//   - #usage-popover — still present-but-hidden (detail popover not yet ported).
//
// ## readClipboardImage shape assumed
//   The bridge declares `readClipboardImage(): Promise<unknown>`. The main-process
//   handler returns either null (no image on clipboard) or an object shaped:
//     { kind: "image"; mime: string; dataBase64: string; name?: string }
//   This matches the attachments array element type of sendMessage (SendMessagePayload).

import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "~/lib/bridge";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { ComposerPickers } from "./ComposerPickers";
import { ComposerQueue } from "./ComposerQueue";
import { SlashPopover } from "./SlashPopover";
import { runSlashCommand } from "./runSlashCommand";
import { prepareGoalDraft, type AddMenuSkill } from "./composerAddMenuModel";
import { buildSelectedFileReminder, decodeSelectedTextFile } from "./composerFiles";
import { formatSkillDirectives } from "./skillDirectives";
import { cyclePermissionMode } from "./CommandPalette";
import { getPromptPrefs, initPromptPrefs, subscribePromptPrefs } from "./promptPrefs";
import { getAgentSettingsState, setSessionMode, useAgentSettings } from "./agentSettings";
import { computeUsageRing, type SessionUsage, type UsageModelRef } from "./usageRing";
import { UsagePopover } from "./UsagePopover";
import {
  addPendingSkill,
  clearPendingSkills,
  enqueueMessage,
  interrupt,
  removePendingSkill,
  sendMessage,
  startGoal,
  useMainStore,
} from "./sessionStore";

// ── Types ──────────────────────────────────────────────────────────────────────

interface StagedAttachment {
  id: string;
  kind: "image" | "pdf";
  mime: string;
  dataBase64: string;
  name?: string;
  /** Blob URL for thumbnail preview (images only). Revoked on remove/send. */
  previewUrl?: string;
}

interface StagedContextFile {
  id: string;
  name: string;
  content: string;
  truncated: boolean;
  fingerprint: string;
}

// readClipboardImage bridge return shape (main process returns this or null).
interface ClipboardImageResult {
  kind: "image";
  mime: string;
  dataBase64: string;
  name?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PDF_MIME = "application/pdf";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_FILE_READ_BYTES = 512 * 1024;
const MAX_CONTEXT_FILES = 8;

let attachmentSeq = 0;

function nextId(): string {
  attachmentSeq += 1;
  return `att-${attachmentSeq}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// ── @-mention parsing (mirror legacy fileMentionsFromMessage) ─────────────────
// Pull `@token` references (up to whitespace) out of the draft, trimming wrapping
// quotes + trailing punctuation, deduped and capped at 8.
function fileMentions(message: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|\s)@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message))) {
    const token = match[1]?.replace(/^["']|["'.,;:!?)]$/g, "");
    if (token) out.push(token);
  }
  return [...new Set(out)].slice(0, 8);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MENTION_CONTENT_LIMIT = 20000;

// Shape of readWorkspaceFile's result (bridge returns unknown).
interface WorkspaceFileResult {
  kind?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
  path?: string;
}

// ── Icon helper (matches legacy <svg class="icon"><use href="#i-NAME"/></svg>) ──

function Icon({ name, className = "icon" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────────

export function Composer() {
  const working = useMainStore((s) => s.working);
  const stopping = useMainStore((s) => s.stopping);
  const draftRequest = useMainStore((s) => s.draftRequest);
  const sessionId = useMainStore((s) => s.sessionId);
  const activeSession = useMainStore((s) => s.activeSession);
  const workspaceCwd = useMainStore((s) => s.workspaceCwd);
  const pendingSkills = useMainStore((s) => s.pendingSkills);
  const teamEnabled = useAgentSettings((state) => state.sessionModes.team === true);
  const pendingHitl = useMainStore(
    (s) => s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0,
  );

  // Usage ring — shown once a session exists (mirrors legacy renderUsageChip,
  // which renders the chip for the active session, "0" until usage arrives).
  // usage rides untyped on the snapshot; model from the session, else the
  // composer-selected model; knownModels for the context-window fallback.
  const usageData = activeSession ? (activeSession as { usage?: SessionUsage }).usage : undefined;
  const usageModel = (((activeSession as { model?: UsageModelRef } | null)?.model ??
    getAgentSettingsState().agentSettings.model) || undefined) as UsageModelRef | undefined;
  const usageRing = activeSession
    ? computeUsageRing(usageData, usageModel, getAgentSettingsState().knownModels)
    : null;
  // Detail popover (token breakdown) opened by clicking the ring — mirror legacy
  // bindUsagePopover. Only meaningful once usage exists.
  const usageRef = useRef<HTMLButtonElement>(null);
  const [usageOpen, setUsageOpen] = useState(false);

  const [text, setText] = useState("");
  const [goalComposeMode, setGoalComposeMode] = useState(false);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [contextFiles, setContextFiles] = useState<StagedContextFile[]>([]);
  const [selectedQuote, setSelectedQuote] = useState("");
  // Per-workspace prompt history for ↑/↓ recall (mirror legacy promptHistory).
  // historyIdx: -1 = live draft, 0 = most recent sent, increasing = older.
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const historyIdx = useRef(-1);
  const draftBeforeHistory = useRef("");

  // Composer input prefs (回车发送 / 启用斜杠命令 / 启用 @ 文件) — persisted by the
  // settings window's GeneralPanel but previously ignored in chat. Track in state
  // so the @-mention context bar reacts to the toggle; the keydown / send paths
  // read getPromptPrefs() live. initPromptPrefs loads once + re-reads on focus.
  const [promptPrefs, setPromptPrefs] = useState(getPromptPrefs);
  useEffect(() => {
    initPromptPrefs();
    setPromptPrefs(getPromptPrefs());
    return subscribePromptPrefs(() => setPromptPrefs(getPromptPrefs()));
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastDraftSeqRef = useRef(0);
  const previousSessionIdRef = useRef(sessionId);

  // ── Textarea auto-grow ────────────────────────────────────────────────────
  // CSS `field-sizing: content` handles this natively in modern Chromium.
  // The JS fallback covers anything that doesn't support it.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset so scrollHeight reflects content, not prior height.
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const maxHeight = lineHeight * 12; // ~12 lines
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    autoGrow();
  }, [text, autoGrow]);

  useEffect(() => {
    const stageQuote = (event: Event) => {
      const quote = (event as CustomEvent<{ quote?: unknown }>).detail?.quote;
      if (typeof quote !== "string" || !quote.trim()) return;
      setSelectedQuote(quote.trim());
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("reina:add-chat-quote", stageQuote);
    return () => window.removeEventListener("reina:add-chat-quote", stageQuote);
  }, []);

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      setSelectedQuote("");
      setGoalComposeMode(false);
    }
    previousSessionIdRef.current = sessionId;
  }, [sessionId]);

  // Goal creation is a text-only composer intent. If another input kind is
  // staged, or the session starts working, fall back to the normal composer
  // without discarding the user's draft.
  useEffect(() => {
    if (
      goalComposeMode &&
      (working ||
        pendingHitl ||
        attachments.length > 0 ||
        contextFiles.length > 0 ||
        pendingSkills.length > 0 ||
        Boolean(selectedQuote))
    ) {
      setGoalComposeMode(false);
    }
  }, [attachments.length, contextFiles.length, goalComposeMode, pendingHitl, pendingSkills.length, selectedQuote, working]);

  // ── Draft injection (edit / undo-to-branch / rollback restore text) ────────
  // The store bumps draftRequest.seq on each request; apply once per seq, then
  // focus the textarea with the caret at the end (mirrors legacy restoreDraft).
  useEffect(() => {
    if (!draftRequest || draftRequest.seq === lastDraftSeqRef.current) return;
    lastDraftSeqRef.current = draftRequest.seq;
    // "prepend" (interrupted-turn queue restore) keeps whatever the user has since
    // typed, placing the restored drafts above it (mirrors codex's merge order:
    // queued drafts before the existing composer text). "replace" (edit / undo /
    // rollback) overwrites.
    if (draftRequest.mode === "prepend") {
      setText((prev) => (prev.trim() ? `${draftRequest.text}\n\n${prev}` : draftRequest.text));
    } else {
      setText(draftRequest.text);
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draftRequest]);

  // ── Send / interrupt ──────────────────────────────────────────────────────

  // Load this workspace's prompt history for ↑/↓ recall.
  useEffect(() => {
    historyIdx.current = -1;
    if (!workspaceCwd) {
      setPromptHistory([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`reina:promptHistory:${workspaceCwd}`);
      setPromptHistory(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setPromptHistory([]);
    }
  }, [workspaceCwd]);

  const pushHistory = useCallback((entry: string) => {
    const v = entry.trim();
    if (!v || !workspaceCwd) return;
    setPromptHistory((prev) => {
      const next = [...prev.filter((p) => p !== v), v].slice(-100);
      try {
        localStorage.setItem(`reina:promptHistory:${workspaceCwd}`, JSON.stringify(next));
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
    historyIdx.current = -1;
  }, [workspaceCwd]);

  const doSend = useCallback(async () => {
    const msg = text.trim();
    if (goalComposeMode) {
      if (!msg || working || pendingHitl) return;
      setText("");
      setGoalComposeMode(false);
      await startGoal(msg);
      return;
    }
    if (!msg && attachments.length === 0 && pendingSkills.length === 0) return;
    if (msg) pushHistory(msg);
    // Slash commands execute immediately (mirror legacy sendPrompt: a "/..."
    // message routes to runSlashCommand BEFORE any queueing — even mid-turn, so
    // steer directives like /verify can interject). No attachments/skills ride
    // along; a bare "/" with staged attachments falls through to a normal send.
    if (
      msg.startsWith("/") &&
      attachments.length === 0 &&
      contextFiles.length === 0 &&
      pendingSkills.length === 0 &&
      !selectedQuote
    ) {
      setText("");
      await runSlashCommand(msg);
      return;
    }
    if (working) {
      // Turn in flight → buffer the draft in the queue panel (text-only;
      // attachments stay staged). Codex model: Enter queues a manageable row
      // (reorder / edit / delete); the per-row 引导/Steer button injects it into
      // the live turn at the next boundary. Enter never auto-steers.
      if (msg && attachments.length === 0 && contextFiles.length === 0 && !selectedQuote) {
        // Fold any staged-skill directive into the queued text and clear it
        // here. The auto-drain later sends the queued string bare via
        // sendMessage(next, [], []), so a skill left staged would otherwise
        // silently ride the NEXT manual send instead of this queued message.
        let queued = msg;
        if (pendingSkills.length > 0) {
          queued = formatSkillDirectives(pendingSkills.map((s) => s.name), msg);
          clearPendingSkills();
        }
        enqueueMessage(queued);
        setText("");
      }
      return;
    }

    const wireAttachments = attachments.map((a) => ({
      kind: a.kind,
      mime: a.mime,
      dataBase64: a.dataBase64,
      ...(a.name ? { name: a.name } : {}),
    }));

    // Revoke preview URLs before clearing state.
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setText("");
    setAttachments([]);
    setContextFiles([]);
    setSelectedQuote("");

    // Resolve @-mentioned files → one-shot reminders (mirror legacy
    // addMentionedFilesToContext + buildMessageWithContext, but delivered as
    // reminders so the user bubble keeps the raw "@path" text). Unresolved
    // tokens are left as plain text — no hard error like legacy.
    const reminders: string[] = [];
    reminders.push(...contextFiles.map(buildSelectedFileReminder));
    if (selectedQuote) {
      reminders.push(`Selected text from this conversation:\n<selected_quote>\n${selectedQuote}\n</selected_quote>`);
    }
    if (msg && workspaceCwd && getPromptPrefs().enableFileMentions) {
      for (const token of fileMentions(msg)) {
        try {
          const file = (await bridge().readWorkspaceFile(workspaceCwd, token)) as WorkspaceFileResult | null;
          if (!file || (file.kind && file.kind !== "file") || file.binary || typeof file.content !== "string") continue;
          const content =
            file.content.length > MENTION_CONTENT_LIMIT
              ? `${file.content.slice(0, MENTION_CONTENT_LIMIT)}\n\n[truncated]`
              : file.content;
          reminders.push(`Referenced file \`${file.path ?? token}\`:\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          /* unresolved @token — leave it as plain text in the message */
        }
      }
    }

    // Prepend staged-skill directives (tagged wire format — see
    // skillDirectives.ts), then clear the tags.
    let outgoing = msg;
    if (pendingSkills.length > 0) {
      outgoing = formatSkillDirectives(pendingSkills.map((s) => s.name), msg);
      clearPendingSkills();
    }

    await sendMessage(outgoing, wireAttachments, reminders);
  }, [
    text,
    goalComposeMode,
    attachments,
    contextFiles,
    working,
    pendingHitl,
    workspaceCwd,
    pendingSkills,
    selectedQuote,
    pushHistory,
  ]);

  // Strip an @-mention token from the draft (context-bar chip remove).
  const removeMention = useCallback((token: string) => {
    setText((prev) => prev.replace(new RegExp(`(^|\\s)@${escapeRegExp(token)}["'.,;:!?)]?`, "g"), (_m, p1: string) => p1));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // @-mentions currently in the draft — drives the context bar. Suppressed when
  // the "启用 @ 文件" pref is off (mirrors legacy enableFileMentions gating).
  const mentions = promptPrefs.enableFileMentions ? fileMentions(text) : [];

  // ── Send button mode ──────────────────────────────────────────────────────
  // "send"     — idle, content present  → click sends
  // "stop"     — working               → click interrupts
  // "stopping" — stopping in progress  → disabled
  // send button disabled when idle + no content OR stopping
  const sendMode: "send" | "stop" | "stopping" = stopping
    ? "stopping"
    : working
      ? "stop"
      : "send";

  const sendDisabled =
    sendMode === "stopping" ||
    (sendMode === "send" && text.trim() === "" && attachments.length === 0 && pendingSkills.length === 0);

  const handleSendClick = useCallback(() => {
    if (sendMode === "stop") {
      void interrupt();
    } else if (sendMode === "send") {
      void doSend();
    }
    // "stopping" → button is disabled, click never fires
  }, [sendMode, doSend]);

  // ── Keyboard handler on textarea ─────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && goalComposeMode) {
        e.preventDefault();
        setGoalComposeMode(false);
        return;
      }
      // Backspace at the very start of the input pops the last staged skill tag
      // (mirror legacy keymap removeLastSkill muscle-memory).
      if (
        e.key === "Backspace" &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0 &&
        pendingSkills.length > 0
      ) {
        e.preventDefault();
        removePendingSkill(pendingSkills[pendingSkills.length - 1].name);
        return;
      }
      // Shift+Tab cycles the permission mode (mirror legacy keymap.js — the
      // mode-button tooltip advertises "Shift+Tab to cycle"). The slash popover's
      // capture-phase handler owns Tab while it's open, so this only fires when
      // the popover is closed, matching legacy's `slashPopover.hidden` guard.
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        cyclePermissionMode();
        return;
      }
      // ↑/↓ prompt-history recall (mirror legacy): ArrowUp at the first line walks
      // back through history; ArrowDown at the last line walks forward, restoring
      // the live draft past index 0. Caret must be collapsed and on the edge line
      // so multi-line editing still works.
      const ta = e.currentTarget;
      const collapsed = ta.selectionStart === ta.selectionEnd;
      if (e.key === "ArrowUp" && collapsed && !ta.value.slice(0, ta.selectionStart).includes("\n") && promptHistory.length > 0) {
        e.preventDefault();
        if (historyIdx.current === -1) draftBeforeHistory.current = text;
        const idx = Math.min(historyIdx.current + 1, promptHistory.length - 1);
        historyIdx.current = idx;
        setText(promptHistory[promptHistory.length - 1 - idx]);
        return;
      }
      if (e.key === "ArrowDown" && collapsed && !ta.value.slice(ta.selectionEnd).includes("\n") && historyIdx.current >= 0) {
        e.preventDefault();
        const idx = historyIdx.current - 1;
        historyIdx.current = idx;
        setText(idx === -1 ? draftBeforeHistory.current : promptHistory[promptHistory.length - 1 - idx]);
        return;
      }
      // Enter-to-send honoring the "回车发送" pref (mirror legacy keymap.js):
      // enterToSend ON  → Enter sends, Shift+Enter newline.
      // enterToSend OFF → Ctrl/Cmd+Enter sends, plain Enter newline.
      if (e.key === "Enter") {
        const send = getPromptPrefs().enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
        if (send) {
          e.preventDefault();
          void doSend();
        }
      }
    },
    [doSend, goalComposeMode, pendingSkills, promptHistory, text],
  );

  // ── Attachment ingestion ──────────────────────────────────────────────────

  const ingestFile = useCallback(async (file: File): Promise<void> => {
    const isImage = SUPPORTED_IMAGE_MIME.has(file.type);
    const isPdf =
      file.type === PDF_MIME || file.name.toLowerCase().endsWith(".pdf");
    if (isImage || isPdf) {
      const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_ATTACHMENT_BYTES;
      if (file.size > maxBytes) return; // silently skip oversized media

      const buffer = await file.arrayBuffer();
      const dataBase64 = arrayBufferToBase64(buffer);
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      const staged: StagedAttachment = {
        id: nextId(),
        kind: isPdf ? "pdf" : "image",
        mime: isPdf ? PDF_MIME : file.type,
        dataBase64,
        name: file.name || undefined,
        previewUrl,
      };
      setAttachments((prev) => [...prev, staged]);
      return;
    }

    const bytes = new Uint8Array(await file.slice(0, MAX_CONTEXT_FILE_READ_BYTES).arrayBuffer());
    const decoded = decodeSelectedTextFile(bytes);
    if (decoded === null) return; // binary files are not valid model context

    const name = file.name || "untitled";
    const content = decoded.slice(0, MENTION_CONTENT_LIMIT);
    const fingerprint = `${name}:${file.size}:${file.lastModified}`;
    const staged: StagedContextFile = {
      id: nextId(),
      name,
      content,
      truncated: file.size > bytes.byteLength || decoded.length > content.length,
      fingerprint,
    };
    setContextFiles((prev) => {
      if (prev.some((item) => item.fingerprint === fingerprint)) return prev;
      return [...prev, staged].slice(0, MAX_CONTEXT_FILES);
    });
  }, []);

  // ── Paste handler (images from clipboard) ─────────────────────────────────
  // Primary path: DataTransfer items from paste event (works when the OS
  // copies a file/screenshot into the clipboard as a File blob).
  // Secondary path: bridge readClipboardImage IPC for cases where the
  // clipboard holds raw image bytes not exposed as a File (common on Windows
  // with screenshots / Win+Shift+S captures).

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (items) {
        const files: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind !== "file") continue;
          const blob = item.getAsFile();
          if (
            blob &&
            (SUPPORTED_IMAGE_MIME.has(blob.type) ||
              blob.type === PDF_MIME ||
              blob.name?.toLowerCase().endsWith(".pdf"))
          ) {
            files.push(blob);
          }
        }
        if (files.length > 0) {
          e.preventDefault();
          for (const f of files) await ingestFile(f);
          return;
        }
      }

      // Fallback: try bridge readClipboardImage for raw clipboard images.
      try {
        const result = (await bridge().readClipboardImage()) as ClipboardImageResult | null;
        if (result && result.kind === "image" && result.mime && result.dataBase64) {
          e.preventDefault();
          const staged: StagedAttachment = {
            id: nextId(),
            kind: "image",
            mime: result.mime,
            dataBase64: result.dataBase64,
            name: result.name,
          };
          setAttachments((prev) => [...prev, staged]);
        }
      } catch {
        // Bridge unavailable or no image — let default paste proceed.
      }
    },
    [ingestFile],
  );

  // ── Drag-and-drop onto the composer footer ────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.currentTarget.classList.add("is-drop-target");
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    e.currentTarget.classList.remove("is-drop-target");
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      e.currentTarget.classList.remove("is-drop-target");
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) await ingestFile(f);
    },
    [ingestFile],
  );

  // ── Add-menu actions ─────────────────────────────────────────────────────
  // The menu selects intent; each action delegates to the existing canonical
  // state path instead of duplicating Goal, Plan, skill, or attachment logic.

  const enterGoal = useCallback(() => {
    setText((draft) => prepareGoalDraft(draft));
    setGoalComposeMode(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const enterPlan = useCallback(() => {
    setGoalComposeMode(false);
    void runSlashCommand("/plan");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const selectSkill = useCallback((skill: AddMenuSkill) => {
    addPendingSkill({ name: skill.name, description: skill.description });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // File selection still uses a hidden file input. The privileged bridge
  // picker returns paths rather than bytes, while media transport and local
  // text context both need the browser-selected File contents.

  const openFilePicker = useCallback(() => {
    if (!fileInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      input.tabIndex = -1;
      input.addEventListener("change", () => {
        const files = Array.from(input.files ?? []);
        input.value = "";
        if (files.length === 0) return;
        void (async () => {
          for (const f of files) await ingestFile(f);
          textareaRef.current?.focus();
        })();
      });
      document.body.appendChild(input);
      fileInputRef.current = input;
    }
    fileInputRef.current.click();
  }, [ingestFile]);

  // ── Remove attachment ─────────────────────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const removeContextFile = useCallback((id: string) => {
    setContextFiles((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // ── Composer surface click → focus textarea ───────────────────────────────

  const handleComposerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as Element;
      if (
        target.closest(
          "button, a, input, textarea, select, label, [role='button'], .composer-popover, .slash-popover",
        )
      )
        return;
      e.preventDefault();
      textareaRef.current?.focus();
    },
    [],
  );

  // ── Cleanup file input on unmount ─────────────────────────────────────────

  useEffect(() => {
    return () => {
      const input = fileInputRef.current;
      if (input && input.parentNode) input.parentNode.removeChild(input);
      // Revoke any remaining preview URLs.
      setAttachments((prev) => {
        for (const a of prev) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
        return [];
      });
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ComposerQueue />

      <footer
        ref={footerRef}
        className="composer"
        aria-label="Message composer"
        onMouseDown={handleComposerMouseDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
      >
      {/* Context bar — chips for the @-mentioned files in the current draft.
          Their contents are attached as reminders on send; the × strips the
          token from the message (mirrors legacy renderContextBarView markup). */}
      <div id="context-bar" className="context-bar" hidden={mentions.length === 0}>
        {mentions.map((token) => (
          <button
            key={token}
            type="button"
            className="context-chip"
            title={`Remove @${token}`}
            onClick={() => removeMention(token)}
          >
            <span>{token.split("/").pop() || token}</span>
            <small>×</small>
          </button>
        ))}
      </div>

      {/* Attachments bar */}
      <div
        id="attachments-bar"
        className="attachments-bar"
        hidden={attachments.length === 0 && contextFiles.length === 0}
      >
        {attachments.map((item) => (
          <div
            key={item.id}
            className={`attachment-chip${item.kind === "pdf" ? " attachment-doc" : ""}`}
          >
            {item.kind === "pdf" || !item.previewUrl ? (
              <>
                <span className="attachment-badge">PDF</span>
                <span className="attachment-name" title={item.name ?? "document.pdf"}>
                  {item.name ?? "document.pdf"}
                </span>
              </>
            ) : (
              <img
                className="attachment-thumb"
                src={item.previewUrl}
                alt={item.name ?? "attachment"}
              />
            )}
            <button
              type="button"
              className="attachment-remove"
              title="Remove"
              aria-label={`Remove ${item.name ?? "attachment"}`}
              onClick={() => removeAttachment(item.id)}
            >
              ×
            </button>
          </div>
        ))}
        {contextFiles.map((item) => (
          <div key={item.id} className="attachment-chip attachment-file">
            <span className="attachment-file-icon">
              <Icon name="terminal" />
            </span>
            <span className="attachment-name" title={item.name}>
              {item.name}
            </span>
            <button
              type="button"
              className="attachment-remove"
              title={`移除文件 ${item.name}`}
              aria-label={`移除文件 ${item.name}`}
              onClick={() => removeContextFile(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Input row */}
      <div id="composer-input" className="composer-input">
        {selectedQuote && (
          <span className="composer-quote" title={selectedQuote}>
            <svg viewBox="0 0 24 24" aria-hidden focusable={false}>
              <path d="M7 17h4V9H5v6a2 2 0 0 0 2 2Zm10 0h2V9h-6v6a2 2 0 0 0 2 2h2Z" />
            </svg>
            <span>{selectedQuote.replace(/\s+/g, " ")}</span>
            <button
              type="button"
              title="移除引用"
              aria-label="移除引用"
              onClick={() => setSelectedQuote("")}
            >
              ×
            </button>
          </span>
        )}
        <div className="composer-input-line">
          {/* Staged-skill tags (mirror legacy renderSkillTagsView, inserted before
              the textarea). Click a tag to unstage it. */}
          {pendingSkills.map((skill) => (
            <span
              key={skill.name}
              className="skill-tag"
              role="button"
              tabIndex={0}
              title={`Remove skill: ${skill.name}`}
              onClick={() => removePendingSkill(skill.name)}
            >
              <Icon name="cube" />
              <span className="skill-tag-name">{skill.name}</span>
            </span>
          ))}
          <textarea
            ref={textareaRef}
            id="prompt"
            rows={1}
            aria-label={goalComposeMode ? "目标描述" : "Message prompt"}
            placeholder={
              goalComposeMode
                ? "描述你的目标，定义可衡量的成果，以获得最佳效果…"
                : working
                  ? "Request a follow-up"
                  : "Send a follow up"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => void handlePaste(e)}
          />
        </div>
      </div>

      {/* Slash popover — owns the #slash-popover element and self-wires to the
          #prompt textarea (by id) for the "/" command + skill autocomplete. */}
      <SlashPopover onEnterGoal={enterGoal} />

      {/* Actions bar */}
      <div className="composer-actions">
        <ComposerAddMenu
          workspaceCwd={workspaceCwd}
          goalDisabled={
            working ||
            pendingHitl ||
            !sessionId ||
            attachments.length > 0 ||
            contextFiles.length > 0 ||
            pendingSkills.length > 0 ||
            Boolean(selectedQuote)
          }
          planDisabled={working || pendingHitl}
          onAddFile={openFilePicker}
          onEnterGoal={enterGoal}
          onEnterPlan={enterPlan}
          onSelectSkill={selectSkill}
        />

        {/* Permission-mode / model pickers + shared #composer-popover (wired via
            the agentSettings store). The mode button renders on the LEFT (next
            to attach); the model picker and usage ring stay right-aligned inside
            .composer-selects, which ComposerPickers owns. */}
        <ComposerPickers
          modeAccessory={
            goalComposeMode || teamEnabled ? (
              <span className="composer-active-modes">
                <span className="composer-mode-divider" aria-hidden="true" />
                {goalComposeMode && (
                  <button
                    className="select-button composer-active-mode-button"
                    type="button"
                    title="退出目标模式"
                    aria-label="退出目标模式"
                    onClick={() => {
                      setGoalComposeMode(false);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    <Icon name="target" />
                    <span>目标</span>
                  </button>
                )}
                {teamEnabled && (
                  <button
                    className="select-button composer-active-mode-button"
                    type="button"
                    title="退出团队模式"
                    aria-label="退出团队模式"
                    onClick={() => {
                      void setSessionMode("team", false);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    <Icon name="sparkles" />
                    <span>团队</span>
                  </button>
                )}
              </span>
            ) : undefined
          }
        >
          {/* Usage ring — context-window usage for the active session. Hidden
              until a session exists; tooltip carries the token breakdown. */}
          <button
            ref={usageRef}
            className="composer-usage"
            id="composer-usage"
            type="button"
            data-level={usageRing?.level ?? "ok"}
            title={usageRing?.title ?? ""}
            aria-label={usageRing?.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={usageOpen}
            hidden={!usageRing}
            onClick={() => {
              if (usageData) setUsageOpen((v) => !v);
            }}
          >
            <svg className="usage-ring" viewBox="0 0 24 24" aria-hidden>
              <circle className="usage-ring-track" cx="12" cy="12" r="10" />
              <circle
                className="usage-ring-fill"
                cx="12"
                cy="12"
                r="10"
                pathLength={100}
                strokeDasharray={usageRing?.dasharray ?? "0 100"}
                transform="rotate(-90 12 12)"
              />
            </svg>
            <span className="usage-ring-label" id="composer-usage-label">
              {usageRing?.label ?? "0"}
            </span>
          </button>
        </ComposerPickers>

        {/* Send / Stop button */}
        <button
          id="send"
          className="send-button"
          type="button"
          data-mode={sendMode}
          title={sendMode === "stop" ? "Stop" : sendMode === "stopping" ? "Stopping…" : "Send"}
          aria-label={sendMode === "stop" ? "Stop" : sendMode === "stopping" ? "Stopping" : "Send"}
          disabled={sendDisabled}
          onClick={handleSendClick}
        >
          {/* Both icons always in DOM; CSS hides the inactive one via data-mode */}
          <Icon name="arrow-up" className="icon icon-send" />
          {/* Stop icon: a filled square rendered via CSS (.icon-stop) */}
          <span className="icon icon-stop" aria-hidden />
        </button>
      </div>

      {/* Composer popover (model / permission mode picker) is rendered by
          <ComposerPickers/> (inside .composer-selects). It is position: fixed,
          so its DOM parent does not affect layout. */}

      {/* Usage detail popover — token breakdown, anchored to the ring. Owns the
          #usage-popover element; renders nothing until opened (position: fixed,
          so DOM placement doesn't affect layout). */}
      <UsagePopover
        usage={usageData}
        model={usageModel}
        anchorRef={usageRef}
        open={usageOpen}
        onClose={() => setUsageOpen(false)}
      />
      </footer>
    </>
  );
}
