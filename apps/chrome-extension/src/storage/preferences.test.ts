import { describe, expect, it } from "vitest";

import {
  READER_PREFERENCES_STORAGE_KEY,
  ReaderPreferenceStore,
  normalizeServerUrl,
  sanitizeReaderPreferences,
} from "./preferences";

class MemoryStorage {
  readonly values: Record<string, unknown> = {};

  get(key: string): Promise<Record<string, unknown>> {
    return Promise.resolve({ [key]: this.values[key] });
  }

  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
    return Promise.resolve();
  }
}

describe("reader preference storage", () => {
  it("sanitizes corrupt values and clamps playback rate", () => {
    expect(
      sanitizeReaderPreferences({
        playbackRate: 99,
        providerId: "  tada  ",
        voiceId: " ",
        autoScroll: false,
        serverUrl: "javascript:alert(1)",
      }),
    ).toEqual({
      playbackRate: 3,
      providerId: "tada",
      autoScroll: false,
      serverUrl: "http://127.0.0.1:8765",
    });
  });

  it("serializes updates and removes an explicitly cleared voice", async () => {
    const storage = new MemoryStorage();
    const store = new ReaderPreferenceStore(storage);
    await store.update({ providerId: "tada", voiceId: "speaker-one" });
    const next = await store.update({ voiceId: undefined, playbackRate: 1.25 });

    expect(next.voiceId).toBeUndefined();
    expect(storage.values[READER_PREFERENCES_STORAGE_KEY]).toEqual(next);
  });

  it("normalizes server URLs and rejects credentialed origins", () => {
    expect(normalizeServerUrl(" http://localhost:8765/api/ ")).toBe("http://localhost:8765/api");
    expect(normalizeServerUrl("http://127.12.34.56:8765")).toBe("http://127.12.34.56:8765");
    expect(normalizeServerUrl("http://[::1]:8765")).toBe("http://[::1]:8765");
    expect(normalizeServerUrl("https://speech.example.com/api")).toBe(
      "https://speech.example.com/api",
    );
    expect(() => normalizeServerUrl("http://192.168.1.50:8765")).toThrow(/HTTPS/);
    expect(() => normalizeServerUrl("http://speech.example.com")).toThrow(/HTTPS/);
    expect(() => normalizeServerUrl("https://user:secret@example.com")).toThrow(/HTTPS/);
  });
});
