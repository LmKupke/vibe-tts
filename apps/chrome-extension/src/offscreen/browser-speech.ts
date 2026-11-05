import type {
  NarrationUnit,
  ReaderError,
  ReadingWord,
  TTSCapabilities,
  TTSProviderInfo,
  TTSVoice,
} from "@vibe-tts/shared";

import { wordForSourceSpan } from "./narration";

export interface BrowserVoiceLike {
  readonly default: boolean;
  readonly lang: string;
  readonly localService: boolean;
  readonly name: string;
  readonly voiceURI: string;
}

export interface BrowserSpeechEventLike {
  readonly charIndex?: number;
  readonly charLength?: number;
  readonly elapsedTime?: number;
  readonly name?: string;
  readonly error?: string;
}

export interface BrowserUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: BrowserVoiceLike | null;
  onstart: ((event: BrowserSpeechEventLike) => void) | null;
  onboundary: ((event: BrowserSpeechEventLike) => void) | null;
  onend: ((event: BrowserSpeechEventLike) => void) | null;
  onerror: ((event: BrowserSpeechEventLike) => void) | null;
}

export interface BrowserSpeechEngineLike {
  readonly paused: boolean;
  readonly speaking: boolean;
  cancel(): void;
  getVoices(): readonly BrowserVoiceLike[];
  pause(): void;
  resume(): void;
  speak(utterance: BrowserUtteranceLike): void;
  addEventListener?(type: "voiceschanged", listener: () => void): void;
  removeEventListener?(type: "voiceschanged", listener: () => void): void;
}

export interface NormalizedSpeechBoundary {
  positionMs?: number;
  sourceCharStart: number;
  sourceCharEnd: number;
  word?: ReadingWord;
}

export interface BrowserSpeechCallbacks {
  onStarted(): void;
  onPosition(boundary: NormalizedSpeechBoundary): void;
  onEnded(positionMs?: number): void;
  onError(error: ReaderError): void;
}

export interface BrowserSpeechOptions {
  language?: string;
  rate: number;
  voiceId?: string;
}

const BROWSER_CAPABILITIES: TTSCapabilities = {
  streaming: true,
  voiceSelection: true,
  voiceCloning: false,
  voiceDesign: false,
  nativeAlignment: true,
};

function voiceId(voice: BrowserVoiceLike): string {
  return voice.voiceURI || `${voice.name}:${voice.lang}:${voice.localService ? "local" : "remote"}`;
}

export function mapBrowserVoice(voice: BrowserVoiceLike): TTSVoice {
  return {
    id: voiceId(voice),
    name: voice.name,
    language: voice.lang,
    providerId: "browser",
    isDefault: voice.default,
    description: voice.localService
      ? "Installed on this device"
      : "Provided by the browser speech service",
  };
}

export function normalizeSpeechBoundary(
  unit: NarrationUnit,
  event: BrowserSpeechEventLike,
): NormalizedSpeechBoundary {
  const localStart = Math.min(
    unit.text.length,
    Math.max(0, Number.isFinite(event.charIndex) ? Math.trunc(event.charIndex ?? 0) : 0),
  );
  const suppliedLength =
    Number.isFinite(event.charLength) && (event.charLength ?? 0) > 0
      ? Math.trunc(event.charLength ?? 0)
      : 0;
  const provisionalStart = unit.sourceStart + localStart;
  const provisionalEnd = Math.min(unit.sourceEnd, provisionalStart + Math.max(1, suppliedLength));
  const isWordBoundary = !event.name || event.name === "word";
  const word = isWordBoundary
    ? wordForSourceSpan(unit, provisionalStart, provisionalEnd)
    : undefined;
  const elapsedTime = event.elapsedTime;
  const positionMs =
    typeof elapsedTime === "number" && Number.isFinite(elapsedTime) && elapsedTime >= 0
      ? elapsedTime * 1_000
      : undefined;

  return {
    ...(positionMs === undefined ? {} : { positionMs }),
    sourceCharStart: word?.startOffset ?? provisionalStart,
    sourceCharEnd: word?.endOffset ?? provisionalEnd,
    ...(word ? { word } : {}),
  };
}

function defaultEngine(): BrowserSpeechEngineLike {
  return {
    get paused() {
      return speechSynthesis.paused;
    },
    get speaking() {
      return speechSynthesis.speaking;
    },
    cancel: () => speechSynthesis.cancel(),
    getVoices: () => speechSynthesis.getVoices(),
    pause: () => speechSynthesis.pause(),
    resume: () => speechSynthesis.resume(),
    speak: (utterance) => speechSynthesis.speak(utterance as SpeechSynthesisUtterance),
    addEventListener: (type, listener) => speechSynthesis.addEventListener(type, listener),
    removeEventListener: (type, listener) => speechSynthesis.removeEventListener(type, listener),
  };
}

function defaultUtterance(text: string): BrowserUtteranceLike {
  return new SpeechSynthesisUtterance(text) as BrowserUtteranceLike;
}

export class BrowserSpeechProvider {
  readonly id = "browser";
  readonly #engine: BrowserSpeechEngineLike;
  readonly #createUtterance: (text: string) => BrowserUtteranceLike;
  readonly #voiceListeners = new Set<() => void>();
  #activeUtterance: BrowserUtteranceLike | undefined;
  #token = 0;

  constructor(
    engine: BrowserSpeechEngineLike = defaultEngine(),
    createUtterance: (text: string) => BrowserUtteranceLike = defaultUtterance,
  ) {
    this.#engine = engine;
    this.#createUtterance = createUtterance;
    this.#engine.addEventListener?.("voiceschanged", this.#onVoicesChanged);
  }

  get active(): boolean {
    return this.#activeUtterance !== undefined;
  }

  get paused(): boolean {
    return this.#engine.paused;
  }

  get providerInfo(): TTSProviderInfo {
    return {
      id: this.id,
      name: "Browser speech",
      available: true,
      local: true,
      status: "ready",
      detail: "Uses Chrome's SpeechSynthesis voices. Voice metadata identifies on-device voices.",
      capabilities: BROWSER_CAPABILITIES,
    };
  }

  getCapabilities(signal?: AbortSignal): Promise<TTSCapabilities> {
    signal?.throwIfAborted();
    return Promise.resolve(BROWSER_CAPABILITIES);
  }

  getVoices(signal?: AbortSignal): Promise<TTSVoice[]> {
    signal?.throwIfAborted();
    return Promise.resolve(this.#engine.getVoices().map(mapBrowserVoice));
  }

  subscribeVoicesChanged(listener: () => void): () => void {
    this.#voiceListeners.add(listener);
    return () => this.#voiceListeners.delete(listener);
  }

  speak(
    unit: NarrationUnit,
    options: BrowserSpeechOptions,
    callbacks: BrowserSpeechCallbacks,
  ): void {
    this.cancel();
    const token = this.#token;
    const utterance = this.#createUtterance(unit.text);
    utterance.rate = Math.min(10, Math.max(0.1, options.rate));
    utterance.lang = options.language ?? "";
    utterance.voice = options.voiceId
      ? (this.#engine.getVoices().find((voice) => voiceId(voice) === options.voiceId) ?? null)
      : null;
    utterance.onstart = () => {
      if (this.#isCurrent(token, utterance)) callbacks.onStarted();
    };
    utterance.onboundary = (event) => {
      if (!this.#isCurrent(token, utterance)) return;
      callbacks.onPosition(normalizeSpeechBoundary(unit, event));
    };
    utterance.onend = (event) => {
      if (!this.#isCurrent(token, utterance)) return;
      this.#activeUtterance = undefined;
      const elapsed = event.elapsedTime;
      callbacks.onEnded(
        typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0
          ? elapsed * 1_000
          : undefined,
      );
    };
    utterance.onerror = (event) => {
      if (!this.#isCurrent(token, utterance)) return;
      this.#activeUtterance = undefined;
      callbacks.onError({
        code: "speech-unavailable",
        message: `Browser speech stopped${event.error ? `: ${event.error}` : "."}`,
        recoverable: true,
      });
    };
    this.#activeUtterance = utterance;
    this.#engine.speak(utterance);
  }

  pause(): void {
    if (this.#activeUtterance && !this.#engine.paused) this.#engine.pause();
  }

  resume(): void {
    if (this.#activeUtterance && this.#engine.paused) this.#engine.resume();
  }

  cancel(): void {
    this.#token += 1;
    if (this.#activeUtterance || this.#engine.speaking || this.#engine.paused) {
      this.#clearHandlers(this.#activeUtterance);
      this.#engine.cancel();
    }
    this.#activeUtterance = undefined;
  }

  dispose(): void {
    this.cancel();
    this.#engine.removeEventListener?.("voiceschanged", this.#onVoicesChanged);
    this.#voiceListeners.clear();
  }

  #isCurrent(token: number, utterance: BrowserUtteranceLike): boolean {
    return token === this.#token && utterance === this.#activeUtterance;
  }

  #clearHandlers(utterance: BrowserUtteranceLike | undefined): void {
    if (!utterance) return;
    utterance.onstart = null;
    utterance.onboundary = null;
    utterance.onend = null;
    utterance.onerror = null;
  }

  #onVoicesChanged = (): void => {
    for (const listener of this.#voiceListeners) listener();
  };
}
