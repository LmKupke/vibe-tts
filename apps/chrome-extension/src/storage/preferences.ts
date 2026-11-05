import {
  DEFAULT_READER_PREFERENCES,
  normalizeSpeechServerUrl,
  type ReaderPreferences,
} from "@vibe-tts/shared";

export const READER_PREFERENCES_STORAGE_KEY = "readerPreferences";

const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 3;

export interface ReaderPreferenceUpdate {
  playbackRate?: number;
  providerId?: string;
  voiceId?: string | undefined;
  autoScroll?: boolean;
  serverUrl?: string;
}

interface PreferenceStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validServerUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return normalizeSpeechServerUrl(value);
  } catch {
    return undefined;
  }
}

export function normalizeServerUrl(value: string): string {
  const normalized = validServerUrl(value);
  if (!normalized) {
    throw new Error(
      "The neural TTS server URL must use HTTPS, or HTTP only when it is on this device.",
    );
  }
  return normalized;
}

export function sanitizeReaderPreferences(value: unknown): ReaderPreferences {
  const candidate = isRecord(value) ? value : {};
  const rate = candidate.playbackRate;
  const playbackRate =
    typeof rate === "number" && Number.isFinite(rate)
      ? Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate))
      : DEFAULT_READER_PREFERENCES.playbackRate;
  const providerId =
    typeof candidate.providerId === "string" && candidate.providerId.trim()
      ? candidate.providerId.trim()
      : DEFAULT_READER_PREFERENCES.providerId;
  const serverUrl = validServerUrl(candidate.serverUrl) ?? DEFAULT_READER_PREFERENCES.serverUrl;
  const base: ReaderPreferences = {
    playbackRate,
    providerId,
    autoScroll:
      typeof candidate.autoScroll === "boolean"
        ? candidate.autoScroll
        : DEFAULT_READER_PREFERENCES.autoScroll,
    serverUrl,
  };
  if (typeof candidate.voiceId === "string" && candidate.voiceId.trim()) {
    return { ...base, voiceId: candidate.voiceId.trim() };
  }
  return base;
}

export class ReaderPreferenceStore {
  readonly #storage: PreferenceStorageArea;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(storage: PreferenceStorageArea = chrome.storage.local) {
    this.#storage = storage;
  }

  async get(): Promise<ReaderPreferences> {
    const result = await this.#storage.get(READER_PREFERENCES_STORAGE_KEY);
    return sanitizeReaderPreferences(result[READER_PREFERENCES_STORAGE_KEY]);
  }

  update(update: ReaderPreferenceUpdate): Promise<ReaderPreferences> {
    const operation = this.#writeQueue.then(async () => {
      const current = await this.get();
      const merged: Record<string, unknown> = { ...current, ...update };
      if (update.voiceId === undefined && Object.hasOwn(update, "voiceId")) {
        delete merged.voiceId;
      }
      const next = sanitizeReaderPreferences(merged);
      await this.#storage.set({ [READER_PREFERENCES_STORAGE_KEY]: next });
      return next;
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
