import { describe, expect, it, vi } from "vitest";

import type { NarrationUnit } from "@vibe-tts/shared";

import {
  HtmlAudioPlayback,
  type AudioElementLike,
  type PlaybackObserverClock,
} from "./audio-playback";

class FakeAudio implements AudioElementLike {
  currentTime = 0;
  duration = 2;
  playbackRate = 1;
  preload = "";
  src = "";
  paused = true;
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  load(): void {}

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const unit: NarrationUnit = {
  id: "unit",
  blockId: "block",
  sentenceId: "sentence",
  sentenceIndex: 0,
  text: "Alpha beta",
  sourceStart: 0,
  sourceEnd: 10,
  words: [],
};

describe("HTML audio playback clock", () => {
  it("uses audio.currentTime and binary alignment lookup on a bounded observer", async () => {
    const audio = new FakeAudio();
    let observation: (() => void) | undefined;
    const observerClock: PlaybackObserverClock = {
      start: vi.fn((callback: () => void, intervalMs: number) => {
        expect(intervalMs).toBeGreaterThanOrEqual(50);
        expect(intervalMs).toBeLessThanOrEqual(100);
        observation = callback;
        return 1;
      }),
      stop: vi.fn(),
    };
    const positions: Array<{ positionMs: number; text?: string }> = [];
    const playback = new HtmlAudioPlayback({
      createAudio: () => audio,
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
      observerClock,
    });

    await playback.playClip(
      {
        unit,
        audio: new Uint8Array([1]).buffer,
        mimeType: "audio/wav",
        durationMs: 2_000,
        alignment: [
          { text: "Alpha", charStart: 0, charEnd: 5, startMs: 0, endMs: 500 },
          { text: "beta", charStart: 6, charEnd: 10, startMs: 500, endMs: 1_000 },
        ],
      },
      {
        onStarted: vi.fn(),
        onPosition: (position) =>
          positions.push({
            positionMs: position.positionMs,
            ...(position.alignment ? { text: position.alignment.text } : {}),
          }),
        onEnded: vi.fn(),
        onError: vi.fn(),
      },
    );

    audio.currentTime = 0.6;
    observation?.();
    expect(positions.at(-1)).toEqual({ positionMs: 600, text: "beta" });

    audio.currentTime = 0.82;
    audio.emit("timeupdate");
    expect(positions.at(-1)?.positionMs).toBe(820);
  });

  it("emits real progress without a word when a provider has no alignment", async () => {
    const audio = new FakeAudio();
    let observation: (() => void) | undefined;
    const onPosition = vi.fn();
    const playback = new HtmlAudioPlayback({
      createAudio: () => audio,
      createObjectURL: () => "blob:unaligned",
      revokeObjectURL: vi.fn(),
      observerClock: {
        start: (callback) => {
          observation = callback;
          return 1;
        },
        stop: vi.fn(),
      },
    });
    await playback.playClip(
      {
        unit,
        audio: new Uint8Array([1]).buffer,
        mimeType: "audio/wav",
        alignment: [],
      },
      { onStarted: vi.fn(), onPosition, onEnded: vi.fn(), onError: vi.fn() },
    );
    audio.currentTime = 0.3;
    observation?.();
    expect(onPosition.mock.calls.at(-1)?.[0]).toMatchObject({ positionMs: 300 });
    expect(onPosition.mock.calls.at(-1)?.[0]).not.toHaveProperty("alignment");
  });
});
