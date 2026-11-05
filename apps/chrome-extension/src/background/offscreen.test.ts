import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureOffscreenDocument } from "./offscreen";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offscreen lifecycle", () => {
  it("coalesces concurrent creation behind one getContexts check", async () => {
    const getContexts = vi.fn(() => Promise.resolve([]));
    const createDocument = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts,
      },
      offscreen: {
        Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
        createDocument,
      },
    });

    await Promise.all([ensureOffscreenDocument(), ensureOffscreenDocument()]);

    expect(getContexts).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("does not create a duplicate when the context already exists", async () => {
    const createDocument = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts: vi.fn(() => Promise.resolve([{ contextType: "OFFSCREEN_DOCUMENT" }])),
      },
      offscreen: {
        Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
        createDocument,
      },
    });

    await ensureOffscreenDocument();

    expect(createDocument).not.toHaveBeenCalled();
  });
});
