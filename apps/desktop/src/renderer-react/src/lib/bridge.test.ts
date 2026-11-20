import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, type ReinaDesktopBridge } from "./bridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge", () => {
  it("uses the current frame preload bridge when present", () => {
    const api = { invoke: vi.fn() } as unknown as ReinaDesktopBridge;
    vi.stubGlobal("window", { reinaDesktop: api, parent: {} });

    expect(bridge()).toBe(api);
  });

  it("reuses the same-origin parent bridge for the embedded Workspace", () => {
    const api = { invoke: vi.fn() } as unknown as ReinaDesktopBridge;
    const child: Record<string, unknown> = { reinaDesktop: undefined };
    child.parent = { reinaDesktop: api };
    vi.stubGlobal("window", child);

    expect(bridge()).toBe(api);
  });

  it("fails clearly when neither frame exposes the preload bridge", () => {
    const child: Record<string, unknown> = { reinaDesktop: undefined };
    child.parent = child;
    vi.stubGlobal("window", child);

    expect(() => bridge()).toThrow("reinaDesktop bridge missing");
  });
});
