import { describe, expect, it, vi } from "vitest";

import { HttpTTSClient } from "./neural-http";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("neural HTTP provider", () => {
  it("refuses plaintext non-loopback servers before making a request", () => {
    expect(() => new HttpTTSClient("http://192.168.1.40:8765")).toThrow(/HTTPS/);
    expect(() => new HttpTTSClient("http://tts.example.test")).toThrow(/HTTPS/);
    expect(() => new HttpTTSClient("https://tts.example.test")).not.toThrow();
  });

  it("sends the canonical snake-case request and decodes validated JSON audio", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(typeof init?.body).toBe("string");
      const body = typeof init?.body === "string" ? init.body : "";
      expect(JSON.parse(body)).toEqual({
        text: "Hello world",
        provider_id: "tada",
        speed: 1.2,
        voice_id: "voice-1",
      });
      return Promise.resolve(
        jsonResponse({
          audio_base64: "AQID",
          mime_type: "audio/wav",
          duration_ms: 800,
          alignment: [
            { text: "Hello", char_start: 0, char_end: 5, start_ms: 0, end_ms: 350 },
            { text: "world", char_start: 6, char_end: 11, start_ms: 350, end_ms: 800 },
          ],
        }),
      );
    });
    const provider = new HttpTTSClient("http://127.0.0.1:8765/", fetchMock).provider("tada");

    const result = await provider.synthesize({
      text: "Hello world",
      providerId: "tada",
      voice: "voice-1",
      speed: 1.2,
    });

    expect([...new Uint8Array(result.audio as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("audio/wav");
    expect(result.nativeAlignment).toHaveLength(2);
  });

  it("accepts empty Qwen alignment for sentence-only highlighting", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          audio_base64: "AQID",
          mime_type: "audio/wav",
          duration_ms: 500,
          alignment: [],
        }),
      ),
    );
    const result = await new HttpTTSClient("http://localhost:8765", fetchMock)
      .provider("qwen")
      .synthesize({ text: "No timings", providerId: "qwen" });
    expect(result.nativeAlignment).toEqual([]);
  });

  it("consumes server offsets as JavaScript UTF-16 code units", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          audio_base64: "AQID",
          mime_type: "audio/wav",
          duration_ms: 200,
          alignment: [{ text: "echo", char_start: 3, char_end: 7, start_ms: 0, end_ms: 200 }],
        }),
      ),
    );
    const result = await new HttpTTSClient("http://localhost:8765", fetchMock)
      .provider("mock")
      .synthesize({ text: "🙂 echo", providerId: "mock" });
    expect(result.nativeAlignment).toEqual([
      { text: "echo", charStart: 3, charEnd: 7, startMs: 0, endMs: 200 },
    ]);
  });

  it("rejects malformed alignment instead of inventing replacement timestamps", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          audio_base64: "AQID",
          mime_type: "audio/wav",
          alignment: [{ text: "Hello", char_start: 0, char_end: 5, start_ms: 100, end_ms: 50 }],
        }),
      ),
    );
    const request = new HttpTTSClient("http://localhost:8765", fetchMock)
      .provider("tada")
      .synthesize({ text: "Hello", providerId: "tada" });
    await expect(request).rejects.toMatchObject({
      code: "malformed-alignment",
    });
  });

  it("normalizes lazy server providers and voice language metadata", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url.endsWith("/v1/providers")
          ? jsonResponse({
              providers: [
                {
                  id: "tada",
                  name: "TADA",
                  local: true,
                  available: false,
                  loadable: true,
                  selectable: true,
                  state: "unloaded",
                  capabilities: {
                    voice_selection: true,
                    native_alignment: true,
                  },
                },
              ],
            })
          : jsonResponse({
              voices: [
                {
                  id: "voice",
                  provider_id: "tada",
                  name: "Voice",
                  languages: ["en-US"],
                },
              ],
            }),
      );
    });

    const catalog = await new HttpTTSClient("http://localhost:8765", fetchMock).getCatalog();
    expect(catalog.providers[0]).toMatchObject({
      id: "tada",
      available: true,
      local: true,
      capabilities: { voiceSelection: true, nativeAlignment: true },
    });
    expect(catalog.providers[0]?.status).toBeUndefined();
    expect(catalog.voices[0]).toMatchObject({ language: "en-US" });
  });
});
