import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clearQueuedMessages,
  editQueuedMessage,
  moveQueuedMessageUp,
  removeQueuedMessage,
  reorderQueuedMessage,
  retractPendingSteer,
  steerQueuedMessage,
  useMainStore,
} from "./sessionStore";

function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function ComposerQueue() {
  const queuedMessages = useMainStore((s) => s.queuedMessages);
  const pendingSteers = useMainStore((s) => s.pendingSteers);
  const working = useMainStore((s) => s.working);
  const stopping = useMainStore((s) => s.stopping);
  const sessionId = useMainStore((s) => s.sessionId);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ index: number; trigger: HTMLButtonElement } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Queue indices can change when an item is sent or the active session changes.
  useEffect(() => {
    setMenu(null);
    setDragIndex(null);
  }, [queuedMessages, pendingSteers, sessionId]);

  useLayoutEffect(() => {
    const popup = menuRef.current;
    if (!menu || !popup) return;
    const anchor = menu.trigger.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(
      8,
      anchor.bottom + popup.offsetHeight + 6 <= window.innerHeight - 8
        ? anchor.bottom + 6
        : anchor.top - popup.offsetHeight - 6,
    )}px`;
    popup.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menu.trigger.contains(target)) setMenu(null);
    };
    const closeOnScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      menu.trigger.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeOnScroll, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", closeOnScroll, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  return (
    <>
      {/* In flow above the composer, so queued prompts reserve transcript space. */}
      <div id="queue-panel" className="queue-panel" hidden={!queuedMessages.length && !pendingSteers.length}>
        <ul className="queue-list" aria-label="Queued prompts">
          {pendingSteers.map((steer, index) => (
            <li className="queue-row queue-row-pending" key={steer.id}>
              <span className="queue-drag-placeholder" aria-hidden="true" />
              <span className="queue-body">
                <span className="queue-dot" title="Submitted — waiting for the next tool boundary">
                  <Icon name="clock" />
                </span>
                <span className="queue-text" title={`Submitted — waiting for the next tool boundary\n${steer.text}`}>
                  {steer.text}
                </span>
              </span>
              <span className="queue-actions">
                <button
                  type="button"
                  className="queue-action"
                  aria-label="Retract submitted prompt"
                  title="Retract — return this prompt to the queue"
                  onClick={() => void retractPendingSteer(index)}
                >
                  <Icon name="undo-2" />
                </button>
              </span>
            </li>
          ))}
          {queuedMessages.map((message, index) => (
            <li
              className={`queue-row${dragIndex === index ? " queue-row-dragging" : ""}${menu?.index === index ? " queue-row-menu-open" : ""}`}
              key={`${index}:${message}`}
              onDragOver={(event) => {
                if (dragIndex === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (dragIndex === null) return;
                event.preventDefault();
                reorderQueuedMessage(dragIndex, index);
                setDragIndex(null);
              }}
            >
              <button
                type="button"
                className="queue-drag"
                draggable
                aria-label="Reorder queued prompt"
                title="Drag to reorder, or use Alt + ↑ / ↓"
                onDragStart={(event) => {
                  setMenu(null);
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(index));
                }}
                onDragEnd={() => setDragIndex(null)}
                onKeyDown={(event) => {
                  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  const next = index + (event.key === "ArrowUp" ? -1 : 1);
                  if (next < 0 || next >= queuedMessages.length) return;
                  reorderQueuedMessage(index, next);
                  requestAnimationFrame(() =>
                    document.querySelectorAll<HTMLButtonElement>("#queue-panel .queue-drag")[next]?.focus(),
                  );
                }}
              >
                <Icon name="grip-vertical" />
              </button>
              <span className="queue-body">
                <span className="queue-dot">
                  <Icon name="file-text" />
                </span>
                <span className="queue-text" title={message}>
                  {message}
                </span>
              </span>
              <span className="queue-actions">
                <button
                  type="button"
                  className="queue-action queue-action-danger"
                  aria-label="Remove queued prompt"
                  title="Remove queued prompt"
                  onClick={() => removeQueuedMessage(index)}
                >
                  <Icon name="trash-2" />
                </button>
                <button
                  type="button"
                  className="queue-action queue-action-more"
                  aria-label="More queue actions"
                  aria-haspopup="menu"
                  aria-expanded={menu?.index === index}
                  aria-controls={menu?.index === index ? "queue-actions-menu" : undefined}
                  title="More queue actions"
                  onClick={(event) => setMenu(menu?.index === index ? null : { index, trigger: event.currentTarget })}
                >
                  <Icon name="more-horizontal" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {menu &&
        createPortal(
          <div
            id="queue-actions-menu"
            className="queue-menu"
            role="menu"
            aria-label="Queued prompt actions"
            ref={menuRef}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                setMenu(null);
                menu.trigger.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            <button
              type="button"
              className="queue-menu-item"
              role="menuitem"
              onClick={() => {
                editQueuedMessage(menu.index);
                setMenu(null);
              }}
            >
              <Icon name="edit" /> Edit prompt
            </button>
            <button
              type="button"
              className="queue-menu-item"
              role="menuitem"
              disabled={stopping}
              title={working ? "Steer into the running turn without interrupting" : "Send this prompt now"}
              onClick={() => {
                void steerQueuedMessage(menu.index);
                setMenu(null);
              }}
            >
              <Icon name="arrow-up" /> {working ? "Steer now" : "Send now"}
            </button>
            <button
              type="button"
              className="queue-menu-item"
              role="menuitem"
              disabled={menu.index === 0}
              onClick={() => {
                moveQueuedMessageUp(menu.index);
                setMenu(null);
              }}
            >
              <Icon name="chevron-up" /> Move up
            </button>
            <div className="queue-menu-separator" role="separator" />
            <button
              type="button"
              className="queue-menu-item queue-action-danger"
              role="menuitem"
              onClick={() => {
                clearQueuedMessages();
                setMenu(null);
              }}
            >
              <Icon name="trash-2" /> Clear queued prompts
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
