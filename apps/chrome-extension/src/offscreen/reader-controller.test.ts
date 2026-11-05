import { describe, expect, it, vi } from "vitest";

import type { ReadingDocument } from "@vibe-tts/shared";

import {
  BrowserSpeechProvider,
  type BrowserSpeechEngineLike,
  type BrowserUtteranceLike,
} from "./browser-speech";
import { HtmlAudioPlayback, type AudioElementLike } from "./audio-playback";
import { HttpTTSClient } from "./neural-http";
import { ReaderController, type OffscreenEventSink } from "./reader-controller";

function makeUtterance(text: string): BrowserUtteranceLike {
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

const document: ReadingDocument = {
  id: "doc",
  version: 1,
  title: "Test article",
  url: "https://example.test/article",
  language: "en-US",
  blocks: [
    {
      id: "block",
      type: "paragraph",
      text: "First word. Second word.",
      sentences: [
        {
          id: "first",
          blockId: "block",
          text: "First word.",
          startOffset: 0,
          endOffset: 11,
          words: [
            { id: "first-1", sentenceId: "first", text: "First", startOffset: 0, endOffset: 5 },
            { id: "first-2", sentenceId: "first", text: "word", startOffset: 6, endOffset: 10 },
          ],
        },
        {
          id: "second",
          blockId: "block",
          text: "Second word.",
          startOffset: 12,
          endOffset: 24,
          words: [
            {
              id: "second-1",
              sentenceId: "second",
              text: "Second",
              startOffset: 12,
              endOffset: 18,
            },
            { id: "second-2", sentenceId: "second", text: "word", startOffset: 19, endOffset: 23 },
          ],
        },
      ],
    },
  ],
  sentenceCount: 2,
  wordCount: 4,
};

describe("reader controller browser path", () => {
  it("owns playback state, boundaries, seek, pause/resume, and stop", async () => {
    const utterances: BrowserUtteranceLike[] = [];
    let paused = false;
    const engine: BrowserSpeechEngineLike = {
      get paused() {
        return paused;
      },
      get speaking() {
        return utterances.length > 0;
      },
      cancel: vi.fn(() => {
        paused = false;
      }),
      getVoices: () => [],
      pause: vi.fn(() => {
        paused = true;
      }),
      resume: vi.fn(() => {
        paused = false;
      }),
      speak: (utterance) => utterances.push(utterance),
    };
    const states: Array<{ tabId?: number; status: string; sentence?: string; word?: string }> = [];
    const highlights: Array<{ sentenceId?: string; wordId?: string; clear?: boolean }> = [];
    const sink: OffscreenEventSink = {
      onState: (snapshot, tabId) =>
        states.push({
          ...(tabId === undefined ? {} : { tabId }),
          status: snapshot.status,
          ...(snapshot.currentSentenceId ? { sentence: snapshot.currentSentenceId } : {}),
          ...(snapshot.currentWordId ? { word: snapshot.currentWordId } : {}),
        }),
      onHighlight: (update) => highlights.push(update),
      onCatalog: vi.fn(),
    };
    const controller = new ReaderController(sink, {
      browserSpeech: new BrowserSpeechProvider(engine, makeUtterance),
      createSessionId: () => "session",
    });

    await controller.handle({
      type: "load",
      tabId: 42,
      document,
      startSentenceIndex: 0,
      preferences: {
        playbackRate: 1,
        providerId: "browser",
        autoScroll: true,
        serverUrl: "http://127.0.0.1:8765",
      },
    });
    await controller.handle({ type: "play" });
    utterances[0]?.onstart?.({ elapsedTime: 0 });
    utterances[0]?.onboundary?.({ name: "word", charIndex: 6, charLength: 4, elapsedTime: 0.4 });

    expect(controller.snapshot).toMatchObject({
      status: "playing",
      currentSentenceId: "first",
      currentWordId: "first-2",
      positionMs: 400,
    });
    expect(highlights.at(-1)).toMatchObject({ tabId: 42, sentenceId: "first", wordId: "first-2" });

    await controller.handle({ type: "pause" });
    expect(controller.snapshot.status).toBe("paused");
    await controller.handle({ type: "resume" });
    expect(controller.snapshot.status).toBe("playing");

    await controller.handle({ type: "next-sentence" });
    expect(utterances.at(-1)?.text).toBe("Second word.");
    expect(controller.snapshot.currentSentenceIndex).toBe(1);

    await controller.handle({
      type: "page-error",
      error: {
        code: "content-unavailable",
        message: "The page mapping changed.",
        recoverable: true,
      },
    });
    expect(controller.snapshot).toMatchObject({
      status: "error",
      error: { code: "content-unavailable" },
    });

    await controller.handle({ type: "stop" });
    expect(controller.snapshot.status).toBe("idle");
    expect(highlights.at(-1)).toMatchObject({ tabId: 42, clear: true });
    expect(states.some((state) => state.tabId === 42)).toBe(true);
  });

  it("refreshes provider lifecycle and voices after the first successful lazy synthesis", async () => {
    const browserEngine: BrowserSpeechEngineLike = {
      cancel: vi.fn(),
      getVoices: () => [],
      pause: vi.fn(),
      resume: vi.fn(),
      speak: vi.fn(),
      paused: false,
      speaking: false,
    };
    let paused = true;
    const audio: AudioElementLike = {
      currentTime: 0,
      duration: 0.5,
      playbackRate: 1,
      preload: "",
      src: "",
      get paused() {
        return paused;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(() => {
        paused = true;
      }),
      play: vi.fn(() => {
        paused = false;
        return Promise.resolve();
      }),
    };
    const audioPlayback = new HtmlAudioPlayback({
      createAudio: () => audio,
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
      observerClock: { start: () => 1, stop: vi.fn() },
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/speech")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              audio_base64: "AQID",
              mime_type: "audio/wav",
              duration_ms: 500,
              alignment: [
                {
                  text: "First word",
                  char_start: 0,
                  char_end: 10,
                  start_ms: 0,
                  end_ms: 500,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/v1/providers")) {
        return Promise.resolve(
          Response.json({
            providers: [
              {
                id: "qwen",
                name: "Qwen3-TTS",
                local: true,
                selectable: true,
                available: true,
                state: "ready",
                capabilities: { voice_selection: true },
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          voices: [{ id: "Ryan", provider_id: "qwen", name: "Ryan", language: "en" }],
        }),
      );
    });
    const catalogs: Parameters<OffscreenEventSink["onCatalog"]>[0][] = [];
    const highlights: Parameters<OffscreenEventSink["onHighlight"]>[0][] = [];
    const controller = new ReaderController(
      {
        onState: vi.fn(),
        onHighlight: (update) => highlights.push(update),
        onCatalog: (catalog) => catalogs.push(catalog),
      },
      {
        browserSpeech: new BrowserSpeechProvider(browserEngine, makeUtterance),
        audioPlayback,
        httpClientFactory: (serverUrl) => new HttpTTSClient(serverUrl, fetchMock),
        createSessionId: () => "neural-session",
      },
    );
    const singleSentenceDocument: ReadingDocument = {
      ...document,
      blocks: [
        {
          ...document.blocks[0]!,
          text: "First word.",
          sentences: [document.blocks[0]!.sentences[0]!],
        },
      ],
      sentenceCount: 1,
      wordCount: 2,
    };

    await controller.handle({
      type: "load",
      tabId: 42,
      document: singleSentenceDocument,
      startSentenceIndex: 0,
      preferences: {
        playbackRate: 1,
        providerId: "qwen",
        autoScroll: true,
        serverUrl: "http://127.0.0.1:8765",
      },
    });
    await controller.handle({ type: "play" });

    expect(catalogs.at(-1)?.providers).toEqual([
      expect.objectContaining({ id: "browser" }),
      expect.objectContaining({ id: "qwen", status: "ready", available: true }),
    ]);
    expect(catalogs.at(-1)?.voices).toContainEqual(
      expect.objectContaining({ id: "Ryan", providerId: "qwen" }),
    );
    expect(highlights.at(-1)).toMatchObject({
      sentenceId: "first",
      wordId: "first-1",
      wordStart: 0,
      wordEnd: 10,
    });
    expect(controller.snapshot.currentWordText).toBe("First word");
  });
});
