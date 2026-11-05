import { describe, expect, it, vi } from "vitest";

import type { NarrationUnit } from "@vibe-tts/shared";

import {
  BrowserSpeechProvider,
  mapBrowserVoice,
  normalizeSpeechBoundary,
  type BrowserSpeechEngineLike,
  type BrowserUtteranceLike,
  type BrowserVoiceLike,
} from "./browser-speech";

const unit: NarrationUnit = {
  id: "unit",
  blockId: "block",
  sentenceId: "sentence",
  sentenceIndex: 0,
  text: "Alpha bravo.",
  sourceStart: 0,
  sourceEnd: 12,
  words: [
    { id: "alpha", sentenceId: "sentence", text: "Alpha", startOffset: 0, endOffset: 5 },
    { id: "bravo", sentenceId: "sentence", text: "bravo", startOffset: 6, endOffset: 11 },
  ],
};

function utterance(text: string): BrowserUtteranceLike {
  return {
    text,
    lang: "",
    rate: 1,
    voice: null,
    onstart: null,
    onboundary: null,
    onend: null,
    onerror: null,
  };
}

describe("browser speech normalization", () => {
  it("normalizes the native elapsed clock and boundary to a source word", () => {
    expect(
      normalizeSpeechBoundary(unit, {
        name: "word",
        charIndex: 6,
        charLength: 5,
        elapsedTime: 1.25,
      }),
    ).toMatchObject({
      positionMs: 1_250,
      sourceCharStart: 6,
      sourceCharEnd: 11,
      word: { id: "bravo" },
    });
  });

  it("describes whether a browser voice is installed locally", () => {
    const local: BrowserVoiceLike = {
      default: true,
      lang: "en-US",
      localService: true,
      name: "System Voice",
      voiceURI: "system-voice",
    };
    expect(mapBrowserVoice(local)).toEqual({
      id: "system-voice",
      name: "System Voice",
      language: "en-US",
      providerId: "browser",
      isDefault: true,
      description: "Installed on this device",
    });
    expect(mapBrowserVoice({ ...local, localService: false }).description).toContain("browser");
  });

  it("ignores boundary and completion callbacks from a canceled utterance", () => {
    const spoken: BrowserUtteranceLike[] = [];
    let paused = false;
    const engine: BrowserSpeechEngineLike = {
      get paused() {
        return paused;
      },
      get speaking() {
        return spoken.length > 0;
      },
      cancel: vi.fn(),
      getVoices: () => [],
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
      speak: (value) => spoken.push(value),
    };
    const provider = new BrowserSpeechProvider(engine, utterance);
    const firstPosition = vi.fn();
    provider.speak(
      unit,
      { rate: 1 },
      {
        onStarted: vi.fn(),
        onPosition: firstPosition,
        onEnded: vi.fn(),
        onError: vi.fn(),
      },
    );
    const stale = spoken[0];
    provider.speak(
      { ...unit, id: "new" },
      { rate: 1 },
      {
        onStarted: vi.fn(),
        onPosition: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
      },
    );

    stale?.onboundary?.({ charIndex: 0, elapsedTime: 1 });
    expect(firstPosition).not.toHaveBeenCalled();
  });
});
