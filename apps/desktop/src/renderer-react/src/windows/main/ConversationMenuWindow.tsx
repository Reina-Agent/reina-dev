import { useEffect, useLayoutEffect, useState } from "react";
import { bridge } from "~/lib/bridge";

interface ConversationMenuPayload {
  hasSession: boolean;
  hasTarget: boolean;
  pinned: boolean;
  archived: boolean;
  selectedAppId: string;
  apps: Array<{ id: string; label: string }>;
}

const BRAND_ICON: Record<string, string> = {
  explorer: "./legacy-assets/icons/app/file-explorer.svg",
  finder: "./legacy-assets/icons/app/file-explorer.svg",
  files: "./legacy-assets/icons/app/file-explorer.svg",
  vscode: "./legacy-assets/icons/app/vscode.svg",
  cursor: "./legacy-assets/icons/app/cursor.svg",
  antigravity: "./legacy-assets/icons/app/antigravity.svg",
  zed: "./legacy-assets/icons/app/zed.svg",
  terminal: "./legacy-assets/icons/app/powershell.svg",
  wsl: "./legacy-assets/icons/app/wsl.svg",
  intellij: "./legacy-assets/icons/app/intellij.svg",
  pycharm: "./legacy-assets/icons/app/pycharm.svg",
  sublime: "./legacy-assets/icons/app/sublimetext.svg",
  xcode: "./legacy-assets/icons/app/xcode.svg",
};

const EMPTY_PAYLOAD: ConversationMenuPayload = {
  hasSession: false,
  hasTarget: false,
  pinned: false,
  archived: false,
  selectedAppId: "",
  apps: [],
};

function readPayload(raw: unknown): ConversationMenuPayload {
  const value = raw && typeof raw === "object" ? raw as Partial<ConversationMenuPayload> : {};
  return {
    hasSession: value.hasSession === true,
    hasTarget: value.hasTarget === true,
    pinned: value.pinned === true,
    archived: value.archived === true,
    selectedAppId: typeof value.selectedAppId === "string" ? value.selectedAppId : "",
    apps: Array.isArray(value.apps)
      ? value.apps.filter(
          (app): app is { id: string; label: string } =>
            Boolean(app) && typeof app.id === "string" && typeof app.label === "string",
        )
      : [],
  };
}

function Icon({ name }: { name: string }) {
  return (
    <svg className="conversation-menu-icon icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

type Submenu = "open-with" | "copy" | null;

export function ConversationMenuWindow() {
  const [menuState, setMenuState] = useState<{ revision: number; payload: ConversationMenuPayload } | null>(null);
  const payload = menuState?.payload ?? EMPTY_PAYLOAD;
  const [submenu, setSubmenu] = useState<Submenu>(null);

  useEffect(() => {
    const api = bridge();
    const unsubscribe = api.events.on("conversation-menu-state", (raw) => {
      const state = raw as { revision?: unknown; payload?: unknown } | null;
      if (typeof state?.revision !== "number") return;
      setSubmenu(null);
      setMenuState({ revision: state.revision, payload: readPayload(state.payload) });
    });
    api.conversationMenuReady();
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    if (menuState) bridge().conversationMenuReady(menuState.revision);
  }, [menuState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      bridge().closeConversationMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const run = (action: string) => bridge().conversationMenuAction(action);

  return (
    <div
      key={menuState?.revision ?? "prewarm"}
      className="conversation-menu-surface"
      onPointerDown={() => bridge().closeConversationMenu()}
      onContextMenu={(event) => {
        event.preventDefault();
        bridge().closeConversationMenu();
      }}
    >
      <div
        className="conversation-menu-panel conversation-menu-primary"
        role="menu"
        aria-label="Conversation actions"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="conversation-menu-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onPointerEnter={() => setSubmenu(null)}
          onClick={() => run("conversation.pin")}
        >
          <Icon name="pin" />
          <span>{payload.pinned ? "Unpin" : "Pin to top"}</span>
        </button>
        <button
          type="button"
          className="conversation-menu-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onPointerEnter={() => setSubmenu(null)}
          onClick={() => run("conversation.rename")}
        >
          <Icon name="edit" />
          <span>Rename…</span>
        </button>
        <button
          type="button"
          className={`conversation-menu-item${submenu === "open-with" ? " is-active" : ""}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === "open-with"}
          disabled={!payload.hasTarget || payload.apps.length === 0}
          onPointerEnter={() => setSubmenu("open-with")}
          onClick={() => setSubmenu("open-with")}
        >
          <Icon name="folder-open" />
          <span>Open with</span>
          <Icon name="chevron-right" />
        </button>

        <div className="conversation-menu-separator" role="separator" />

        <button
          type="button"
          className={`conversation-menu-item${submenu === "copy" ? " is-active" : ""}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === "copy"}
          disabled={!payload.hasSession && !payload.hasTarget}
          onPointerEnter={() => setSubmenu("copy")}
          onClick={() => setSubmenu("copy")}
        >
          <Icon name="copy" />
          <span>Copy</span>
          <Icon name="chevron-right" />
        </button>
        <button
          type="button"
          className="conversation-menu-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onPointerEnter={() => setSubmenu(null)}
          onClick={() => run("conversation.archive")}
        >
          <Icon name={payload.archived ? "archive-restore" : "archive"} />
          <span>{payload.archived ? "Unarchive" : "Archive"}</span>
        </button>

        <div className="conversation-menu-separator" role="separator" />

        <button
          type="button"
          className="conversation-menu-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onPointerEnter={() => setSubmenu(null)}
          onClick={() => run("conversation.new-side-chat")}
        >
          <Icon name="messages-square" />
          <span>New Side Chat</span>
        </button>
      </div>

      <div
        className="conversation-menu-panel conversation-menu-submenu conversation-menu-apps"
        role="menu"
        aria-label="Open with options"
        hidden={submenu !== "open-with"}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {payload.apps.map((app) => (
          <button
            key={app.id}
            type="button"
            className={`conversation-menu-item${app.id === payload.selectedAppId ? " is-selected" : ""}`}
            role="menuitem"
            onClick={() => run(`conversation.open-with:${app.id}`)}
          >
            {BRAND_ICON[app.id] ? (
              <img className="conversation-menu-brand" src={BRAND_ICON[app.id]} alt="" draggable={false} />
            ) : (
              <span className="conversation-menu-brand-fallback" aria-hidden />
            )}
            <span>{app.label}</span>
            {app.id === payload.selectedAppId ? <Icon name="check" /> : null}
          </button>
        ))}
      </div>

      <div
        className="conversation-menu-panel conversation-menu-submenu conversation-menu-copy"
        role="menu"
        aria-label="Copy conversation details"
        hidden={submenu !== "copy"}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="conversation-menu-item conversation-menu-text-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onClick={() => run("conversation.copy-title")}
        >
          <span>Copy title</span>
        </button>
        <button
          type="button"
          className="conversation-menu-item conversation-menu-text-item"
          role="menuitem"
          disabled={!payload.hasSession}
          onClick={() => run("conversation.copy-id")}
        >
          <span>Copy ID</span>
        </button>
        <button
          type="button"
          className="conversation-menu-item conversation-menu-text-item"
          role="menuitem"
          disabled={!payload.hasTarget}
          onClick={() => run("conversation.copy-path")}
        >
          <span>Copy path</span>
        </button>
      </div>
    </div>
  );
}
