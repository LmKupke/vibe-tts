import { describe, expect, it, vi } from "vitest";

import type { ExtensionMessage, ReaderSnapshot } from "@vibe-tts/shared";

import { createOffscreenMessageListener } from "./runtime";

const snapshot: ReaderSnapshot = {
  status: "idle",
  currentSentenceIndex: 0,
  sentenceCount: 0,
  positionMs: 0,
  playbackRate: 1,
  providerId: "browser",
  bufferedSentenceCount: 0,
  autoScroll: true,
  startMode: "beginning",
  hasSelection: false,
};

describe("offscreen Chrome message listener", () => {
  it("keeps the Chrome 120 callback channel open and replies with MessageReply", async () => {
    const handler = { handle: vi.fn(() => Promise.resolve(snapshot)) };
    const listener = createOffscreenMessageListener(handler);
    const sendResponse = vi.fn();
    const message: ExtensionMessage = {
      type: "offscreen-command",
      requestId: "request-1",
      source: "background",
      target: "offscreen",
      command: { type: "get-state" },
    };

    expect(listener(message, {}, sendResponse)).toBe(true);
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      requestId: "request-1",
      data: snapshot,
    });
  });

  it("ignores messages for other extension contexts", () => {
    const listener = createOffscreenMessageListener({
      handle: vi.fn(() => Promise.resolve(snapshot)),
    });
    const message: ExtensionMessage = {
      type: "request-state",
      requestId: "request-2",
      source: "sidepanel",
      target: "background",
    };
    expect(listener(message, {}, vi.fn())).toBeUndefined();
  });
});
