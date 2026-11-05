import {
  assertValidAlignment,
  normalizeSpeechServerUrl,
  type AlignmentEntry,
  type CatalogSnapshot,
  type RawSynthesisResult,
  type ReaderError,
  type SynthesisRequest,
  type TTSCapabilities,
  type TTSProvider,
  type TTSProviderInfo,
  type TTSVoice,
} from "@vibe-tts/shared";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const EMPTY_CAPABILITIES: TTSCapabilities = {
  streaming: false,
  voiceSelection: false,
  voiceCloning: false,
  voiceDesign: false,
  nativeAlignment: false,
};

export class HttpTTSProviderError extends Error {
  readonly code: ReaderError["code"];
  readonly recoverable: boolean;

  constructor(code: ReaderError["code"], message: string, recoverable = true) {
    super(message);
    this.name = "HttpTTSProviderError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function property(value: Record<string, unknown>, camelCase: string, snakeCase: string): unknown {
  return value[camelCase] ?? value[snakeCase];
}

function capabilitiesFrom(value: unknown): TTSCapabilities {
  const candidate = record(value);
  if (!candidate) return EMPTY_CAPABILITIES;
  return {
    streaming: booleanValue(candidate.streaming),
    voiceSelection: booleanValue(property(candidate, "voiceSelection", "voice_selection")),
    voiceCloning: booleanValue(property(candidate, "voiceCloning", "voice_cloning")),
    voiceDesign: booleanValue(property(candidate, "voiceDesign", "voice_design")),
    nativeAlignment: booleanValue(property(candidate, "nativeAlignment", "native_alignment")),
  };
}

function providerFrom(value: unknown): TTSProviderInfo | undefined {
  const candidate = record(value);
  const id = candidate ? stringValue(candidate.id) : undefined;
  if (!candidate || !id) return undefined;
  const rawStatus = stringValue(candidate.status) ?? stringValue(candidate.state);
  const status =
    rawStatus === "ready"
      ? "ready"
      : rawStatus === "loading" || rawStatus === "downloading"
        ? "loading"
        : rawStatus === "error"
          ? "error"
          : rawStatus === "unavailable" || rawStatus === "disabled" || rawStatus === "not_installed"
            ? "unavailable"
            : undefined;
  const name = stringValue(candidate.name) ?? id;
  const model = stringValue(candidate.model);
  const detail =
    stringValue(candidate.detail) ??
    stringValue(candidate.error) ??
    (rawStatus
      ? `Server lifecycle: ${rawStatus.replaceAll("_", " ")}${model ? ` · ${model}` : ""}`
      : model);
  const selectable =
    typeof candidate.selectable === "boolean"
      ? candidate.selectable
      : booleanValue(candidate.available) || booleanValue(candidate.loadable);
  return {
    id,
    name,
    available: selectable,
    local: booleanValue(candidate.local),
    ...(status ? { status } : {}),
    ...(detail ? { detail } : {}),
    capabilities: capabilitiesFrom(candidate.capabilities),
  };
}

function voiceFrom(value: unknown): TTSVoice | undefined {
  const candidate = record(value);
  const id = candidate ? stringValue(candidate.id) : undefined;
  const name = candidate ? stringValue(candidate.name) : undefined;
  const providerId = candidate
    ? stringValue(property(candidate, "providerId", "provider_id"))
    : undefined;
  if (!candidate || !id || !name || !providerId) return undefined;
  const language = stringValue(candidate.language);
  const languages = Array.isArray(candidate.languages)
    ? candidate.languages.filter((value): value is string => typeof value === "string")
    : [];
  const description = stringValue(candidate.description);
  return {
    id,
    name,
    providerId,
    ...(language || languages[0] ? { language: language ?? languages[0] } : {}),
    ...(typeof candidate.isDefault === "boolean"
      ? { isDefault: candidate.isDefault }
      : typeof candidate.is_default === "boolean"
        ? { isDefault: candidate.is_default }
        : {}),
    ...(description ? { description } : {}),
  };
}

function arrayPayload(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const candidate = record(value);
  return candidate && Array.isArray(candidate[key]) ? candidate[key] : [];
}

function alignmentFrom(value: unknown, sourceText: string): AlignmentEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpTTSProviderError(
      "malformed-alignment",
      "The speech server returned alignment in an unsupported format.",
    );
  }
  const entries = value.map((rawEntry, index): AlignmentEntry => {
    const entry = record(rawEntry);
    const text = entry ? stringValue(entry.text) : undefined;
    const charStart = entry ? finiteNumber(property(entry, "charStart", "char_start")) : undefined;
    const charEnd = entry ? finiteNumber(property(entry, "charEnd", "char_end")) : undefined;
    const startMs = entry ? finiteNumber(property(entry, "startMs", "start_ms")) : undefined;
    const endMs = entry ? finiteNumber(property(entry, "endMs", "end_ms")) : undefined;
    if (
      !entry ||
      text === undefined ||
      charStart === undefined ||
      charEnd === undefined ||
      !Number.isInteger(charStart) ||
      !Number.isInteger(charEnd) ||
      startMs === undefined ||
      endMs === undefined
    ) {
      throw new HttpTTSProviderError(
        "malformed-alignment",
        `The speech server returned an invalid alignment entry at index ${index}.`,
      );
    }
    return { text, charStart, charEnd, startMs, endMs };
  });
  try {
    assertValidAlignment(sourceText, entries);
  } catch (error) {
    throw new HttpTTSProviderError(
      "malformed-alignment",
      error instanceof Error ? error.message : "The speech server returned malformed alignment.",
    );
  }
  return entries;
}

function decodeBase64(value: string): ArrayBuffer {
  const data = value.startsWith("data:") ? (value.split(",", 2)[1] ?? "") : value;
  const normalized = data.replace(/\s+/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new HttpTTSProviderError(
      "synthesis-failed",
      "The speech server returned invalid base64 audio.",
    );
  }
  try {
    const binary = atob(normalized);
    if (binary.length === 0) throw new Error("Decoded audio is empty.");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  } catch {
    throw new HttpTTSProviderError(
      "synthesis-failed",
      "The speech server returned invalid base64 audio.",
    );
  }
}

function endpointRoot(serverUrl: string): string {
  try {
    return normalizeSpeechServerUrl(serverUrl);
  } catch {
    throw new HttpTTSProviderError(
      "provider-unavailable",
      "The speech server URL must use HTTPS, or HTTP only when it is on this device.",
    );
  }
}

export class HttpTTSClient {
  readonly #root: string;
  readonly #fetch: FetchLike;

  constructor(serverUrl: string, fetchImplementation: FetchLike = fetch) {
    this.#root = endpointRoot(serverUrl);
    this.#fetch = fetchImplementation;
  }

  provider(providerId: string): HttpTTSProvider {
    return new HttpTTSProvider(providerId, this);
  }

  async getCatalog(signal?: AbortSignal): Promise<CatalogSnapshot> {
    const [providerPayload, voicePayload] = await Promise.all([
      this.#json("/v1/providers", signal ? { signal } : {}),
      this.#json("/v1/voices", signal ? { signal } : {}),
    ]);
    return {
      providers: arrayPayload(providerPayload, "providers").flatMap((value) => {
        const provider = providerFrom(value);
        return provider ? [provider] : [];
      }),
      voices: arrayPayload(voicePayload, "voices").flatMap((value) => {
        const voice = voiceFrom(value);
        return voice ? [voice] : [];
      }),
      serverConnected: true,
    };
  }

  async synthesize(
    providerId: string,
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<RawSynthesisResult> {
    const payload: Record<string, unknown> = {
      text: request.text,
      provider_id: providerId,
      speed: request.speed ?? 1,
    };
    if (request.voice) payload.voice_id = request.voice;
    if (request.language) payload.language = request.language;
    if (request.diagnostics !== undefined) payload.diagnostics = request.diagnostics;

    const raw = await this.#json("/v1/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    const response = record(raw);
    if (!response) {
      throw new HttpTTSProviderError(
        "synthesis-failed",
        "The speech server returned an invalid response.",
      );
    }
    const audioBase64 = stringValue(property(response, "audioBase64", "audio_base64"));
    const mimeType = stringValue(property(response, "mimeType", "mime_type"));
    if (!audioBase64 || !mimeType || !mimeType.startsWith("audio/")) {
      throw new HttpTTSProviderError(
        "synthesis-failed",
        "The speech server response did not contain valid audio and a MIME type.",
      );
    }
    const rawAlignment =
      response.alignment ?? property(response, "nativeAlignment", "native_alignment");
    const nativeAlignment = alignmentFrom(rawAlignment, request.text);
    const durationMs = finiteNumber(property(response, "durationMs", "duration_ms"));
    if (durationMs !== undefined && durationMs <= 0) {
      throw new HttpTTSProviderError(
        "synthesis-failed",
        "The speech server returned a negative audio duration.",
      );
    }
    return {
      audio: decodeBase64(audioBase64),
      mimeType,
      ...(durationMs === undefined ? {} : { durationMs }),
      nativeAlignment,
    };
  }

  async #json(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#root}${path}`, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new HttpTTSProviderError(
        "server-offline",
        error instanceof Error
          ? `Unable to reach the speech server: ${error.message}`
          : "Unable to reach the speech server.",
      );
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`.trim();
      try {
        const errorPayload: unknown = await response.json();
        const errorRecord = record(errorPayload);
        detail =
          (errorRecord && (stringValue(errorRecord.detail) ?? stringValue(errorRecord.message))) ||
          detail;
      } catch {
        // The HTTP status remains actionable even when the body is not JSON.
      }
      throw new HttpTTSProviderError(
        response.status === 404 || response.status === 503
          ? "provider-unavailable"
          : "synthesis-failed",
        `Speech server request failed: ${detail}`,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HttpTTSProviderError(
        "synthesis-failed",
        "The speech server returned invalid JSON.",
      );
    }
  }
}

export class HttpTTSProvider implements TTSProvider {
  readonly id: string;
  readonly #client: HttpTTSClient;

  constructor(id: string, client: HttpTTSClient) {
    this.id = id;
    this.#client = client;
  }

  async getVoices(signal?: AbortSignal): Promise<TTSVoice[]> {
    const catalog = await this.#client.getCatalog(signal);
    return catalog.voices.filter((voice) => voice.providerId === this.id);
  }

  async getCapabilities(signal?: AbortSignal): Promise<TTSCapabilities> {
    const catalog = await this.#client.getCatalog(signal);
    const provider = catalog.providers.find((candidate) => candidate.id === this.id);
    if (!provider) {
      throw new HttpTTSProviderError(
        "provider-unavailable",
        `Speech provider “${this.id}” is not available.`,
      );
    }
    return provider.capabilities;
  }

  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<RawSynthesisResult> {
    return this.#client.synthesize(this.id, request, signal);
  }
}
