import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { ConversationMenuPayload } from "./windows.js";

class MockWindow extends EventEmitter {
  static instances: MockWindow[] = [];
  readonly id = MockWindow.instances.length + 1;
  destroyed = false;
  visible = false;
  bounds = { x: 100, y: 100, width: 1440, height: 820 };
  webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    setZoomFactor: vi.fn(),
  });
  loadFile = vi.fn(async () => undefined);
  setAutoHideMenuBar = vi.fn();
  setMenuBarVisibility = vi.fn();
  setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
  show = vi.fn(() => { this.visible = true; });
  hide = vi.fn(() => { this.visible = false; });
  focus = vi.fn();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  });

  constructor(readonly options: { parent?: MockWindow } = {}) {
    super();
    MockWindow.instances.push(this);
  }

  getContentBounds() { return this.bounds; }
  getParentWindow() { return this.options.parent ?? null; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
}

let windows: typeof import("./windows.js");

beforeAll(async () => {
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  vi.doMock("electron", () => ({
    app: { isPackaged: false },
    BrowserWindow: MockWindow,
    Menu: {},
    screen: {
      getPrimaryDisplay: () => display,
      getDisplayMatching: () => display,
    },
    shell: {},
  }));
  vi.doMock("./store.js", () => ({
    readStore: () => ({}),
    readStoreValue: () => undefined,
    writeStore: vi.fn(),
  }));
  windows = await import("./windows.js");
});

beforeEach(() => {
  vi.useFakeTimers();
  MockWindow.instances = [];
});

afterEach(() => {
  for (const win of MockWindow.instances) win.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function handle(win: MockWindow): BrowserWindow {
  return win as unknown as BrowserWindow;
}

function createOwner(): MockWindow {
  return windows.createMainWindow({
    repoRoot: process.cwd(),
    rendererRoot: path.join(process.cwd(), "renderer"),
    preloadPath: path.join(process.cwd(), "preload.cjs"),
    log: vi.fn(),
    onMenuCommand: vi.fn(),
  }) as unknown as MockWindow;
}

const payload: ConversationMenuPayload = {
  hasSession: true,
  hasTarget: true,
  pinned: false,
  archived: false,
  selectedAppId: "code",
  apps: [{ id: "code", label: "Visual Studio Code" }],
};

function openMenu(owner: MockWindow, state = payload): MockWindow {
  windows.popupTopbarMenu(handle(owner), "conversation", 80, 36, state);
  return MockWindow.instances.at(-1)!;
}

function latestState(popup: MockWindow): { revision: number; payload: ConversationMenuPayload } {
  const call = popup.webContents.send.mock.calls.filter(
    ([channel]) => channel === "reina:event:conversation-menu-state",
  ).at(-1);
  expect(call).toBeDefined();
  return call![1];
}

describe("conversation popup lifecycle", () => {
  it("prewarms one hidden popup after the owner is ready without delaying its show", () => {
    const owner = createOwner();
    expect(MockWindow.instances).toHaveLength(1);

    owner.emit("ready-to-show");
    expect(owner.show).toHaveBeenCalledOnce();
    expect(MockWindow.instances).toHaveLength(1);

    vi.runOnlyPendingTimers();
    expect(MockWindow.instances).toHaveLength(2);
    const popup = MockWindow.instances[1]!;
    expect(popup.loadFile).toHaveBeenCalledOnce();
    expect(popup.loadFile).toHaveBeenCalledWith(
      path.join(process.cwd(), "renderer", "conversation-menu.html"),
    );
    popup.emit("ready-to-show");
    windows.conversationMenuReady(handle(popup));
    expect(popup.show).not.toHaveBeenCalled();
    expect(popup.webContents.send).not.toHaveBeenCalled();

    expect(openMenu(owner)).toBe(popup);
    expect(latestState(popup).payload).toEqual(payload);
    expect(popup.loadFile).toHaveBeenCalledOnce();
  });

  it.each(["window", "renderer"] as const)(
    "waits for both native and current renderer readiness when %s is ready first",
    (first) => {
      const popup = openMenu(createOwner());
      windows.conversationMenuReady(handle(popup));
      const { revision } = latestState(popup);
      const nativeReady = () => popup.emit("ready-to-show");
      const rendererReady = () => windows.conversationMenuReady(handle(popup), revision);

      (first === "window" ? nativeReady : rendererReady)();
      expect(popup.show).not.toHaveBeenCalled();
      (first === "window" ? rendererReady : nativeReady)();
      expect(popup.show).toHaveBeenCalledOnce();
      expect(popup.focus).toHaveBeenCalledOnce();

      rendererReady();
      expect(popup.show).toHaveBeenCalledOnce();
    },
  );

  it("reuses the loaded popup and refreshes state on every open", () => {
    const owner = createOwner();
    const popup = openMenu(owner);
    popup.emit("ready-to-show");
    windows.conversationMenuReady(handle(popup));
    const first = latestState(popup);
    windows.conversationMenuReady(handle(popup), first.revision);
    expect(windows.closeConversationMenu(handle(popup))).toBe(true);
    expect(popup.isVisible()).toBe(false);

    const nextPayload = { ...payload, pinned: true, archived: true, selectedAppId: "" };
    expect(openMenu(owner, nextPayload)).toBe(popup);
    const second = latestState(popup);
    expect(second.payload).toEqual(nextPayload);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(popup.isVisible()).toBe(false);
    windows.conversationMenuReady(handle(popup), second.revision);

    expect(popup.show).toHaveBeenCalledTimes(2);
    expect(popup.loadFile).toHaveBeenCalledOnce();
    expect(MockWindow.instances).toHaveLength(2);
  });

  it("does not reopen a cancelled menu or accept an older revision after reopening", () => {
    const owner = createOwner();
    const popup = openMenu(owner);
    windows.conversationMenuReady(handle(popup));
    const oldRevision = latestState(popup).revision;
    windows.closeConversationMenu(handle(popup));
    windows.conversationMenuReady(handle(popup), oldRevision);
    popup.emit("ready-to-show");
    expect(popup.show).not.toHaveBeenCalled();

    openMenu(owner, { ...payload, pinned: true });
    windows.conversationMenuReady(handle(popup), oldRevision);
    expect(popup.show).not.toHaveBeenCalled();
    windows.conversationMenuReady(handle(popup), latestState(popup).revision);
    expect(popup.show).toHaveBeenCalledOnce();
  });

  it("ignores a queued blur from the previous hide while a fresh open awaits rendering", () => {
    const owner = createOwner();
    const popup = openMenu(owner);
    popup.emit("ready-to-show");
    windows.conversationMenuReady(handle(popup));
    windows.conversationMenuReady(handle(popup), latestState(popup).revision);
    expect(popup.isVisible()).toBe(true);

    windows.closeConversationMenu(handle(popup));
    openMenu(owner);
    expect(popup.isVisible()).toBe(false);
    popup.emit("blur");
    windows.conversationMenuReady(handle(popup), latestState(popup).revision);

    expect(popup.isVisible()).toBe(true);
    expect(popup.show).toHaveBeenCalledTimes(2);
    expect(popup.hide).toHaveBeenCalledOnce();
  });

  it("destroys the cached popup and removes its owner listeners when the owner closes", () => {
    const owner = createOwner();
    const popup = openMenu(owner);
    owner.destroy();

    expect(popup.destroy).toHaveBeenCalledOnce();
    expect(popup.isDestroyed()).toBe(true);
    expect(owner.listenerCount("move")).toBe(0);
    expect(owner.listenerCount("resize")).toBe(0);
    expect(windows.closeConversationMenu(handle(popup))).toBe(false);
  });

  it("recreates the popup after its renderer crashes", () => {
    const owner = createOwner();
    const failedPopup = openMenu(owner);
    failedPopup.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(failedPopup.isDestroyed()).toBe(true);

    const replacement = openMenu(owner);
    expect(replacement).not.toBe(failedPopup);
    expect(replacement.loadFile).toHaveBeenCalledOnce();
    replacement.emit("ready-to-show");
    windows.conversationMenuReady(handle(replacement));
    windows.conversationMenuReady(handle(replacement), latestState(replacement).revision);
    expect(replacement.show).toHaveBeenCalledOnce();
  });

  it("ignores ready and close requests from windows other than the registered popup", () => {
    const owner = createOwner();
    const popup = openMenu(owner);
    const unrelated = new MockWindow({ parent: owner });
    popup.emit("ready-to-show");

    for (const win of [owner, unrelated]) {
      windows.conversationMenuReady(handle(win));
      windows.conversationMenuReady(handle(win), 1);
      expect(windows.closeConversationMenu(handle(win))).toBe(false);
      expect(win.hide).not.toHaveBeenCalled();
      expect(win.destroy).not.toHaveBeenCalled();
    }
    expect(popup.show).not.toHaveBeenCalled();
    expect(popup.hide).not.toHaveBeenCalled();
    expect(popup.webContents.send).not.toHaveBeenCalled();
  });
});
