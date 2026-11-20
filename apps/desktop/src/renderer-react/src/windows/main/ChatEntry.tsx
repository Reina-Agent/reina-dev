// ChatEntry.tsx — React port of the legacy entry DOM built by
// conversation.js appendEntry / setEntryContent / setReasoningContent.
// Reproduces the EXACT class structure so the verbatim-reused chat.css
// renders identically. NO Tailwind — only legacy class names.
//
// User entry DOM (from appendEntry + setEntryContent + ensureUserMessageActions):
//
//   <div class="entry user" data-message-id? data-created-at?>
//     [<div class="user-attachments">
//       <img class="user-attachment-image" src="…" alt="…">…
//     </div>]
//     <div class="user-message-body">{text}</div>
//     <div class="user-message-actions">
//       <span class="user-message-time">{HH:MM}</span>
//       <button class="message-copy-button" type="button">…svg…</button>
//     </div>
//   </div>
//
// Assistant entry DOM (from appendEntry + setReasoningContent + setEntryContent):
//
//   <div class="entry assistant" data-message-id? data-created-at?>
//     [<details class="assistant-reasoning [reasoning-streaming]">
//       <summary class="assistant-reasoning-summary">
//         <span class="reasoning-icon">✦</span>
//         <span class="reasoning-label">Thoughts</span>
//         <span class="reasoning-elapsed"></span>
//       </summary>
//       <div class="assistant-reasoning-body">{reasoning}</div>
//     </details>]
//     <div class="assistant-body">  {markdown HTML}  </div>
//   </div>

import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageAttachment, TimelineTextPart } from "./protocol";
import { openImageLightbox } from "./imageLightbox";
import { Markdown } from "./Markdown";
import {
  deleteMessagesFrom,
  editAndResend,
  forkSessionFromMessage,
  undoToBranch,
} from "./sessionStore";
import { parseSkillDirectives } from "./skillDirectives";
import { getPromptPrefs, initPromptPrefs, subscribePromptPrefs } from "./promptPrefs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Sprite icon (matches legacy icon("name") → <svg class="icon"><use href="#i-NAME"/></svg>).
function IconUse({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

// ─── Copy button with transient feedback (mirrors legacy is-copied flash) ──────

function CopyButton({
  className,
  label,
  getText,
}: {
  className: string;
  label: string;
  getText: () => string;
}) {
  const [flash, setFlash] = useState<"" | "is-copied" | "is-failed">("");
  const timer = useRef<number | null>(null);

  function show(cls: "is-copied" | "is-failed") {
    setFlash(cls);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(""), 1100);
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className={`${className}${flash ? ` ${flash}` : ""}`}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        const text = getText();
        if (!text) return;
        void navigator.clipboard.writeText(text).then(() => show("is-copied"), () => show("is-failed"));
      }}
    >
      <IconUse name="copy" />
    </button>
  );
}

// ─── Inline user-message edit (mirrors legacy beginEditUserMessage) ────────────

function UserEdit({
  original,
  onCancel,
  onSave,
}: {
  original: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [value, setValue] = useState(original);
  const [enterToSend, setEnterToSend] = useState(() => getPromptPrefs().enterToSend);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0;

  useEffect(() => {
    initPromptPrefs();
    const sync = () => setEnterToSend(getPromptPrefs().enterToSend);
    sync();
    return subscribePromptPrefs(sync);
  }, []);

  function submit() {
    if (canSend) onSave(value);
  }

  function autoresize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    el.style.overflowY = el.scrollHeight > 320 ? "auto" : "hidden";
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoresize(el);
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      autoresize(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="user-edit">
      <div className="user-edit-label">编辑消息</div>
      <textarea
        ref={ref}
        className="user-edit-input"
        aria-label="编辑已发送的消息"
        rows={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          autoresize(e.target);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="user-edit-actions">
        <span className="user-edit-hint">
          {enterToSend ? "Enter 发送 · Shift + Enter 换行" : `${document.body.dataset.os === "mac" ? "⌘" : "Ctrl"} + Enter 发送`}
        </span>
        <span className="user-edit-buttons">
          <button type="button" className="user-edit-btn user-edit-cancel" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="user-edit-btn user-edit-save" disabled={!canSend} onClick={submit}>
            重新发送
          </button>
        </span>
      </div>
    </div>
  );
}

// ─── Attachment thumbnails ────────────────────────────────────────────────────
// Mirrors appendUserAttachments in conversation.js.

function attachmentSrc(att: MessageAttachment): string {
  if (att.previewUrl) return att.previewUrl;
  if (att.mime && att.dataBase64) return `data:${att.mime};base64,${att.dataBase64}`;
  return "";
}

function UserAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const images = attachments.filter((a) => {
    const src = attachmentSrc(a);
    return src && (a.kind === "image" || (a.mime ?? "").startsWith("image/") || src.startsWith("data:image"));
  });
  if (images.length === 0) return null;

  return (
    <div className="user-attachments">
      {images.map((att, i) => {
        const src = attachmentSrc(att);
        const alt = att.name || "image";
        return (
          <img
            key={i}
            className="user-attachment-image"
            src={src}
            alt={alt}
            title="Click to preview"
            // In-app lightbox (zoom/pan/rotate) — replaces the bare window.open
            // native window. Works for data:/blob: in-session images and URLs.
            onClick={() => openImageLightbox(src, alt)}
          />
        );
      })}
    </div>
  );
}

// ─── Reasoning disclosure (Thoughts) ─────────────────────────────────────────
// Mirrors setReasoningContent in conversation.js.
// The <details> is always rendered collapsed (open={false}); the streaming
// class adds the icon pulse + label shimmer via CSS animations.

interface ReasoningProps {
  text: string;
  streaming: boolean;
}

function ReasoningDisclosure({ text, streaming }: ReasoningProps) {
  const cleaned = text?.trim() ?? "";
  if (!cleaned) return null;

  const cls = [
    "assistant-reasoning",
    streaming ? "reasoning-streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <details className={cls}>
      <summary className="assistant-reasoning-summary">
        <span className="reasoning-icon">✦</span>
        <span className="reasoning-label">Thoughts</span>
        <span className="reasoning-elapsed" />
      </summary>
      <div className="assistant-reasoning-body">{text}</div>
    </details>
  );
}

// ─── Assistant usage / finish-reason rows (mirrors legacy assistantMetaRows) ───
// Built from the per-turn token usage + stop reason the host now carries on the
// assistant text part. Empty array → no ⓘ info button (nothing to show).

function assistantMetaRows(part: TimelineTextPart): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const u = part.tokenUsage;
  if (u) {
    const add = (label: string, n: number | undefined) => {
      const v = Number(n) || 0;
      if (v) rows.push({ label, value: v.toLocaleString() });
    };
    add("输入 tokens", u.inputTokens);
    add("输出 tokens", u.outputTokens);
    add("缓存输入", u.cachedInputTokens);
    add("推理 tokens", u.reasoningTokens);
    add("合计", u.totalTokens);
  }
  if (part.stopReason) rows.push({ label: "Turn 结束原因", value: part.stopReason });
  return rows;
}

// ─── ChatEntry component ──────────────────────────────────────────────────────

export interface ChatEntryProps {
  part: TimelineTextPart;
  /** True when this is the live-streaming overlay assistant entry. */
  streaming?: boolean;
  /**
   * Set false to suppress the hover action bar (copy/branch/delete/info). Two
   * uses: (1) in-flight live rounds whose `part.id` is a synthetic `live-round-N`
   * (not a real message id), so the bar can't fire history mutations against a
   * non-existent message; (2) intermediate process steps folded inside a
   * TurnProcess disclosure, where per-step actions are just noise — actions
   * belong on the final answer only (mirrors legacy foldTurnProcess). Defaults
   * to true (a standalone committed message that owns its action bar).
   */
  committed?: boolean;
}

/**
 * Reproduces the exact DOM that conversation.js appendEntry builds for a
 * TimelineTextPart (user or assistant role). chat.css renders it identically.
 *
 * Memoized: committed part objects are referentially stable between snapshots,
 * so streaming-driven Timeline re-renders skip settled entries. The live
 * overlay/steer entries pass a fresh part object each render and re-render as
 * before.
 */
export const ChatEntry = memo(function ChatEntry({
  part,
  streaming = false,
  committed = true,
}: ChatEntryProps) {
  const time = formatTime(part.createdAt);
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const [rolling, setRolling] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoPosition, setInfoPosition] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);
  const [selectionAction, setSelectionAction] = useState<{ text: string; left: number; top: number; bottom: number } | null>(null);
  const [selectionActionsEnabled, setSelectionActionsEnabled] = useState(
    () => getPromptPrefs().enableSelectionActions,
  );
  const assistantEntryRef = useRef<HTMLDivElement>(null);
  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const infoPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initPromptPrefs();
    const sync = () => {
      const enabled = getPromptPrefs().enableSelectionActions;
      setSelectionActionsEnabled(enabled);
      if (!enabled) setSelectionAction(null);
    };
    sync();
    return subscribePromptPrefs(sync);
  }, []);

  useEffect(() => {
    if (!infoOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!infoButtonRef.current?.contains(target) && !infoPopoverRef.current?.contains(target)) {
        setInfoOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(false);
    };
    const closeOnViewportChange = () => setInfoOpen(false);
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [infoOpen]);

  const toggleInfo = () => {
    if (infoOpen) {
      setInfoOpen(false);
      return;
    }
    const rect = infoButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const placement = rect.top >= 180 ? "above" : "below";
    setInfoPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)),
      top: placement === "above" ? rect.top - 6 : rect.bottom + 6,
      placement,
    });
    setInfoOpen(true);
  };

  useEffect(() => {
    if (!selectionActionsEnabled || streaming || !committed || part.role !== "assistant") return;
    const updateSelection = () => {
      const selection = window.getSelection();
      const body = assistantEntryRef.current?.querySelector(".assistant-body");
      const anchor = selection?.anchorNode;
      const focus = selection?.focusNode;
      const belongsToBody = (node: Node | null | undefined) => Boolean(node && body?.contains(node));
      const text = selection && !selection.isCollapsed && belongsToBody(anchor) && belongsToBody(focus)
        ? selection.toString().trim()
        : "";
      if (!text || !selection?.rangeCount) {
        setSelectionAction(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSelectionAction({
        text,
        left: rect.left + rect.width / 2,
        top: rect.top - 6,
        bottom: rect.bottom + 6,
      });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [committed, part.role, selectionActionsEnabled, streaming]);

  useLayoutEffect(() => {
    const toolbar = selectionActionsRef.current;
    if (!toolbar || !selectionAction) return;
    const { width, height } = toolbar.getBoundingClientRect();
    const top = selectionAction.top >= height + 8
      ? selectionAction.top - height
      : selectionAction.bottom;
    toolbar.style.left = `${Math.max(8, Math.min(selectionAction.left - width / 2, window.innerWidth - width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
  }, [selectionAction]);

  useEffect(() => {
    if (!selectionAction) return;
    const dismiss = () => setSelectionAction(null);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [selectionAction]);

  // The timeline part id is the OWNING message id with a `:text` suffix
  // (timeline-parts.ts `${message.id}:text`). Every history-mutation IPC
  // (fork / delete-from / undo-to-branch / edit-and-resend) keys off the raw
  // MESSAGE id — passing the part id makes the engine throw
  // "Message not found: msg_…:text". Strip the suffix once here.
  const messageId = part.id.replace(/:text$/, "");

  if (part.role === "user") {
    // Skill invocations ride the user message as <skill-directive> tags
    // (skillDirectives.ts). Render them as chips + the user-authored text —
    // never the raw scaffolding, which would read as if the user typed it.
    const { skills: skillChips, rest: userText } = parseSkillDirectives(part.content ?? "");
    return (
      <div
        className={`entry user${editing ? " is-editing" : ""}`}
        data-message-id={messageId || undefined}
        data-created-at={part.createdAt || undefined}
      >
        {part.attachments && part.attachments.length > 0 && (
          <UserAttachments attachments={part.attachments} />
        )}
        {editing ? (
          <UserEdit
            original={part.content ?? ""}
            onCancel={() => {
              setEditing(false);
              requestAnimationFrame(() => editButtonRef.current?.focus());
            }}
            onSave={(text) => {
              setEditing(false);
              const trimmed = text.trim();
              if (trimmed) void editAndResend(messageId, trimmed);
            }}
          />
        ) : (
          <>
            {/* Same DOM as legacy conversation.js appendUserSkills — the
                .user-skills / .user-skill-chip styles never left chat.css. */}
            {skillChips.length > 0 && (
              <div className="user-skills">
                <span className="user-skills-label">Skills</span>
                {skillChips.map((name) => (
                  <span key={name} className="user-skill-chip" title={name}>
                    {name}
                  </span>
                ))}
              </div>
            )}
            {userText && <div className="user-message-body">{userText}</div>}
          </>
        )}
        {/* Action bar: rollback (↩ fork-before) · time · copy · edit. Hidden
            while the inline editor is open and on the streaming overlay. */}
        {!streaming && committed && !editing && (
          <div className="user-message-actions">
            <button
              type="button"
              className="message-rollback-button"
              title="撤回到新分支（保留原会话）"
              aria-label="撤回到新分支（保留原会话）"
              disabled={rolling}
              onClick={(e) => {
                e.preventDefault();
                setRolling(true);
                void Promise.resolve(undoToBranch(messageId, part.content ?? "")).finally(() =>
                  setRolling(false),
                );
              }}
            >
              <IconUse name="git-branch" />
            </button>
            {time && <span className="user-message-time">{time}</span>}
            {/* Copy what the bubble shows: the user-authored text, not the
                skill-directive scaffolding. */}
            <CopyButton
              className="message-copy-button"
              label="Copy message"
              getText={() => (skillChips.length > 0 ? userText : part.content ?? "")}
            />
            <button
              type="button"
              className="message-edit-button"
              ref={editButtonRef}
              title="编辑并重发"
              aria-label="编辑并重发"
              onClick={(e) => {
                e.preventDefault();
                setEditing(true);
              }}
            >
              <IconUse name="edit" />
            </button>
          </div>
        )}
      </div>
    );
  }

  if (part.role === "assistant") {
    const showActions = !streaming && committed && (part.content ?? "").trim().length > 0;
    const metaRows = assistantMetaRows(part);
    return (
      <div
        ref={assistantEntryRef}
        className="entry assistant"
        data-message-id={messageId || undefined}
        data-created-at={part.createdAt || undefined}
      >
        {/* Reasoning sits ABOVE the answer body — same DOM order as legacy. */}
        {part.reasoning && part.reasoning.trim() && (
          <ReasoningDisclosure text={part.reasoning} streaming={streaming} />
        )}
        {/* .assistant-body wraps the markdown output. While live-streaming it
            also carries .stream-reveal: chat.css fades in each newly-appended
            block (react-markdown reconciles committed blocks in place, so only
            genuinely new nodes play the insertion animation). The committed
            entry never has the class, so history replay stays static. */}
        <Markdown
          source={part.content ?? ""}
          className={streaming ? "assistant-body stream-reveal" : "assistant-body"}
        />
        {selectionActionsEnabled && showActions && selectionAction && createPortal(
          <div
            ref={selectionActionsRef}
            className="assistant-selection-actions"
            style={{ left: selectionAction.left, top: selectionAction.top }}
            role="toolbar"
            aria-label="选中文本操作"
          >
            <button
              type="button"
              className="assistant-context-action"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("reina:add-chat-quote", {
                  detail: { quote: selectionAction.text },
                }));
                window.getSelection()?.removeAllRanges();
                setSelectionAction(null);
              }}
            >
              添加到 Chat
            </button>
            <button
              type="button"
              className="assistant-context-action"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("reina:open-side-chat", {
                  detail: { quote: selectionAction.text },
                }));
                window.getSelection()?.removeAllRanges();
                setSelectionAction(null);
              }}
            >
              添加到 Side Chat
            </button>
          </div>,
          document.body,
        )}
        {showActions && infoOpen && infoPosition && createPortal(
          <div
            ref={infoPopoverRef}
            className="assistant-meta-panel"
            data-placement={infoPosition.placement}
            style={{ left: infoPosition.left, top: infoPosition.top }}
            role="dialog"
            aria-label="用量与结束原因"
          >
            {metaRows.map((r, i) => (
              <Fragment key={i}>
                <span className="assistant-meta-label">{r.label}</span>
                <span className="assistant-meta-value">{r.value}</span>
              </Fragment>
            ))}
          </div>,
          document.body,
        )}
        {/* Hover action bar: copy markdown · branch (fork-from) · delete-from ·
            Suppressed on the live streaming overlay and on empty answers. */}
        {showActions && (
          <div className="assistant-message-actions">
            <CopyButton
              className="assistant-action assistant-action-copy"
              label="复制为 Markdown"
              getText={() => part.content ?? ""}
            />
            <button
              type="button"
              className="assistant-action assistant-action-branch"
              title="创建分支"
              aria-label="创建分支"
              onClick={(e) => {
                e.preventDefault();
                void forkSessionFromMessage(messageId);
              }}
            >
              <IconUse name="git-branch" />
            </button>
            <button
              type="button"
              className="assistant-action assistant-action-delete"
              title="删除消息"
              aria-label="删除消息"
              onClick={(e) => {
                e.preventDefault();
                void deleteMessagesFrom(messageId);
              }}
            >
              <IconUse name="trash-2" />
            </button>
            {metaRows.length > 0 && (
              <button
                ref={infoButtonRef}
                type="button"
                className={`assistant-action assistant-action-info${infoOpen ? " is-open" : ""}`}
                title="用量与结束原因"
                aria-label="用量与结束原因"
                aria-haspopup="dialog"
                aria-expanded={infoOpen}
                onClick={(event) => {
                  event.preventDefault();
                  toggleInfo();
                }}
              >
                <IconUse name="info" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // system role — flat muted chip, mirrors appendEntry("system", …).
  return (
    <div className="entry system">
      {part.content}
    </div>
  );
});
