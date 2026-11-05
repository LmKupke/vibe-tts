import {
  INITIAL_READER_SNAPSHOT,
  reduceReaderState,
  type CatalogSnapshot,
  type NarrationUnit,
  type OffscreenCommand,
  type ReaderError,
  type ReaderSnapshot,
  type ReadingWord,
  type TTSProvider,
} from "@vibe-tts/shared";

import {
  HtmlAudioPlayback,
  prepareAudioClip,
  type AudioClockPosition,
  type PreparedAudioClip,
} from "./audio-playback";
import { BrowserSpeechProvider, type NormalizedSpeechBoundary } from "./browser-speech";
import { buildNarrationUnits, unitOffsetForSentence, wordForSourceSpan } from "./narration";
import { HttpTTSClient, HttpTTSProviderError } from "./neural-http";
import { GenerationPrefetchQueue, StaleGenerationError } from "./prefetch-queue";

export interface HighlightUpdate {
  tabId: number;
  blockId?: string;
  sentenceId?: string;
  wordId?: string;
  sourceStart?: number;
  sourceEnd?: number;
  wordStart?: number;
  wordEnd?: number;
  clear?: boolean;
}

export interface OffscreenEventSink {
  onState(snapshot: ReaderSnapshot, tabId?: number): void;
  onHighlight(update: HighlightUpdate): void;
  onCatalog(catalog: CatalogSnapshot): void;
}

export interface ReaderControllerDependencies {
  browserSpeech?: BrowserSpeechProvider;
  audioPlayback?: HtmlAudioPlayback;
  httpClientFactory?: (serverUrl: string) => HttpTTSClient;
  createSessionId?: () => string;
  prefetchSize?: number;
}

interface TimedSourceSpan {
  sourceStart: number;
  sourceEnd: number;
  text: string;
}

function defaultSessionId(): string {
  return `reader-${crypto.randomUUID()}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function playbackRate(rate: number): number {
  return Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1;
}

function readerError(error: unknown, fallbackCode: ReaderError["code"]): ReaderError {
  if (error instanceof HttpTTSProviderError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Playback failed unexpectedly.",
    recoverable: true,
  };
}

export class ReaderController {
  readonly #sink: OffscreenEventSink;
  readonly #browserSpeech: BrowserSpeechProvider;
  readonly #audioPlayback: HtmlAudioPlayback;
  readonly #httpClientFactory: (serverUrl: string) => HttpTTSClient;
  readonly #createSessionId: () => string;
  readonly #queue: GenerationPrefetchQueue<PreparedAudioClip>;
  readonly #unsubscribeVoices: () => void;
  #snapshot: ReaderSnapshot = { ...INITIAL_READER_SNAPSHOT };
  #catalog: CatalogSnapshot;
  #units: NarrationUnit[] = [];
  #unitOffset = 0;
  #initialUnitOffset = 0;
  #tabId: number | undefined;
  #language: string | undefined;
  #serverUrl = "http://127.0.0.1:8765";
  #httpClient: { serverUrl: string; client: HttpTTSClient } | undefined;
  readonly #catalogRefreshedAfterSynthesis = new Set<string>();
  #operation = 0;
  #wantsPlayback = false;
  #activeUnitId: string | undefined;
  #lastHighlight = "";

  constructor(sink: OffscreenEventSink, dependencies: ReaderControllerDependencies = {}) {
    this.#sink = sink;
    this.#browserSpeech = dependencies.browserSpeech ?? new BrowserSpeechProvider();
    this.#audioPlayback = dependencies.audioPlayback ?? new HtmlAudioPlayback();
    this.#httpClientFactory =
      dependencies.httpClientFactory ?? ((serverUrl) => new HttpTTSClient(serverUrl));
    this.#createSessionId = dependencies.createSessionId ?? defaultSessionId;
    this.#catalog = {
      providers: [this.#browserSpeech.providerInfo],
      voices: [],
      serverConnected: false,
    };
    this.#queue = new GenerationPrefetchQueue<PreparedAudioClip>({
      ...(dependencies.prefetchSize === undefined ? {} : { capacity: dependencies.prefetchSize }),
      onChange: () => this.#updateBufferedCount(),
    });
    this.#unsubscribeVoices = this.#browserSpeech.subscribeVoicesChanged(() => {
      void this.#refreshBrowserVoices();
    });
  }

  get snapshot(): ReaderSnapshot {
    return this.#snapshot;
  }

  get catalog(): CatalogSnapshot {
    return this.#catalog;
  }

  async initialize(): Promise<void> {
    await this.#refreshBrowserVoices();
    this.#emitState();
  }

  async handle(command: OffscreenCommand): Promise<ReaderSnapshot | CatalogSnapshot> {
    switch (command.type) {
      case "load":
        this.#load(command);
        return this.#snapshot;
      case "play":
        await this.#play();
        return this.#snapshot;
      case "pause":
        this.#pause();
        return this.#snapshot;
      case "resume":
        await this.#resume();
        return this.#snapshot;
      case "stop":
        this.#stop();
        return this.#snapshot;
      case "previous-sentence":
        await this.#moveBy(-1);
        return this.#snapshot;
      case "next-sentence":
        await this.#moveBy(1);
        return this.#snapshot;
      case "seek-sentence":
        await this.#seekSentence(command.sentenceIndex);
        return this.#snapshot;
      case "set-rate":
        await this.#setRate(command.rate);
        return this.#snapshot;
      case "set-provider":
        await this.#setProvider(command.providerId, command.serverUrl);
        return this.#snapshot;
      case "set-voice":
        await this.#setVoice(command.voiceId);
        return this.#snapshot;
      case "set-auto-scroll":
        this.#snapshot = reduceReaderState(this.#snapshot, {
          type: "auto-scroll",
          enabled: command.enabled,
        });
        this.#emitState();
        return this.#snapshot;
      case "page-error":
        this.#fail(command.error);
        return this.#snapshot;
      case "get-state":
        this.#emitState();
        return this.#snapshot;
      case "get-catalog":
        return this.#refreshCatalog(command.serverUrl);
    }
  }

  dispose(): void {
    this.#wantsPlayback = false;
    this.#invalidatePlayback();
    this.#unsubscribeVoices();
    this.#browserSpeech.dispose();
  }

  #load(command: Extract<OffscreenCommand, { type: "load" }>): void {
    this.#wantsPlayback = false;
    this.#invalidatePlayback();
    this.#clearHighlight();
    this.#lastHighlight = "";
    this.#tabId = command.tabId;
    this.#language = command.document.language;
    this.#setServerUrl(command.preferences.serverUrl);
    this.#units = buildNarrationUnits(command.document, command.selection);
    this.#unitOffset = command.selection
      ? this.#units.length > 0
        ? 0
        : -1
      : unitOffsetForSentence(this.#units, command.startSentenceIndex);
    this.#initialUnitOffset = Math.max(0, this.#unitOffset);
    const inferredStartMode = command.selection
      ? "selection"
      : command.startSentenceIndex > 0
        ? "here"
        : "beginning";
    const snapshotWithPreferences: ReaderSnapshot = {
      ...this.#snapshot,
      playbackRate: playbackRate(command.preferences.playbackRate),
      providerId: command.preferences.providerId || "browser",
      autoScroll: command.preferences.autoScroll,
    };
    if (command.preferences.voiceId) {
      snapshotWithPreferences.voiceId = command.preferences.voiceId;
    } else {
      delete snapshotWithPreferences.voiceId;
    }
    this.#snapshot = snapshotWithPreferences;
    this.#snapshot = reduceReaderState(this.#snapshot, {
      type: "prepare",
      sessionId: this.#createSessionId(),
      ...(command.document.title ? { title: command.document.title } : {}),
      url: command.document.url,
      sentenceCount: this.#units.length,
      startMode: inferredStartMode,
      hasSelection: Boolean(command.selection),
    });

    if (this.#unitOffset < 0) {
      this.#snapshot = reduceReaderState(this.#snapshot, {
        type: "fail",
        error: {
          code: "empty-document",
          message: command.selection
            ? "The selected source range does not contain readable text."
            : "The page does not contain readable text.",
          recoverable: true,
        },
      });
      this.#clearHighlight();
      this.#emitState();
      return;
    }

    const unit = this.#units[this.#unitOffset];
    if (!unit) return;
    this.#snapshot = reduceReaderState(this.#snapshot, {
      type: "ready",
      sentenceIndex: unit.sentenceIndex,
    });
    this.#setPosition(unit, 0);
  }

  async #play(): Promise<void> {
    if (this.#units.length === 0 || this.#unitOffset < 0) return;
    if (this.#snapshot.status === "completed") {
      this.#unitOffset = this.#initialUnitOffset;
      this.#invalidatePlayback();
      const first = this.#units[this.#unitOffset];
      if (first) this.#setPosition(first, 0);
    }
    if (this.#snapshot.status === "playing") return;
    this.#wantsPlayback = true;
    await this.#resumeOrStartCurrent();
  }

  #pause(): void {
    this.#wantsPlayback = false;
    this.#browserSpeech.pause();
    this.#audioPlayback.pause();
    this.#snapshot = reduceReaderState(this.#snapshot, { type: "pause" });
    this.#emitState();
  }

  async #resume(): Promise<void> {
    if (this.#snapshot.status !== "paused" && this.#snapshot.status !== "buffering") return;
    this.#wantsPlayback = true;
    await this.#resumeOrStartCurrent();
  }

  async #resumeOrStartCurrent(): Promise<void> {
    const unit = this.#units[this.#unitOffset];
    if (!unit) return;
    if (
      this.#activeUnitId === unit.id &&
      this.#snapshot.providerId === "browser" &&
      this.#browserSpeech.active &&
      this.#browserSpeech.paused
    ) {
      this.#browserSpeech.resume();
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "play" });
      this.#emitState();
      return;
    }
    if (
      this.#activeUnitId === unit.id &&
      this.#snapshot.providerId !== "browser" &&
      this.#audioPlayback.active &&
      this.#audioPlayback.paused
    ) {
      await this.#audioPlayback.resume();
      if (!this.#wantsPlayback) return;
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "play" });
      this.#emitState();
      return;
    }
    await this.#startCurrent();
  }

  #stop(): void {
    this.#wantsPlayback = false;
    this.#invalidatePlayback();
    this.#unitOffset = this.#initialUnitOffset;
    this.#snapshot = reduceReaderState(this.#snapshot, { type: "stop" });
    this.#clearHighlight();
    this.#emitState();
  }

  async #moveBy(delta: -1 | 1): Promise<void> {
    if (this.#units.length === 0) return;
    const target = Math.min(this.#units.length - 1, Math.max(0, this.#unitOffset + delta));
    await this.#seekOffset(target);
  }

  async #seekSentence(sentenceIndex: number): Promise<void> {
    if (!Number.isFinite(sentenceIndex) || this.#units.length === 0) return;
    const target = unitOffsetForSentence(this.#units, Math.max(0, Math.trunc(sentenceIndex)));
    if (target >= 0) await this.#seekOffset(target);
  }

  async #seekOffset(target: number): Promise<void> {
    const continuePlaying =
      this.#wantsPlayback ||
      this.#snapshot.status === "playing" ||
      this.#snapshot.status === "buffering";
    this.#wantsPlayback = continuePlaying;
    this.#invalidatePlayback();
    this.#unitOffset = target;
    const unit = this.#units[target];
    if (!unit) return;
    this.#snapshot = { ...this.#snapshot, status: continuePlaying ? "buffering" : "paused" };
    this.#setPosition(unit, 0);
    if (continuePlaying) await this.#startCurrent();
  }

  async #setRate(rate: number): Promise<void> {
    const nextRate = playbackRate(rate);
    if (nextRate === this.#snapshot.playbackRate) return;
    this.#snapshot = reduceReaderState(this.#snapshot, { type: "rate", rate: nextRate });
    this.#audioPlayback.setRate(nextRate);
    this.#emitState();
    if (
      this.#snapshot.providerId === "browser" &&
      (this.#snapshot.status === "playing" || this.#snapshot.status === "buffering")
    ) {
      this.#wantsPlayback = true;
      this.#invalidatePlayback();
      await this.#startCurrent();
    }
  }

  async #setProvider(providerId: string, serverUrl: string): Promise<void> {
    const nextProvider = providerId.trim() || "browser";
    const changed =
      nextProvider !== this.#snapshot.providerId || serverUrl.trim() !== this.#serverUrl;
    this.#setServerUrl(serverUrl);
    if (!changed) return;
    const continuePlaying =
      this.#wantsPlayback ||
      this.#snapshot.status === "playing" ||
      this.#snapshot.status === "buffering";
    this.#wantsPlayback = continuePlaying;
    this.#invalidatePlayback();
    this.#snapshot = reduceReaderState(this.#snapshot, {
      type: "provider",
      providerId: nextProvider,
    });
    this.#snapshot = {
      ...this.#snapshot,
      status: continuePlaying
        ? "buffering"
        : this.#units.length > 0
          ? "paused"
          : this.#snapshot.status,
    };
    this.#emitState();
    if (continuePlaying) await this.#startCurrent();
  }

  async #setVoice(voiceId: string | undefined): Promise<void> {
    if (voiceId === this.#snapshot.voiceId) return;
    const continuePlaying =
      this.#wantsPlayback ||
      this.#snapshot.status === "playing" ||
      this.#snapshot.status === "buffering";
    this.#wantsPlayback = continuePlaying;
    this.#invalidatePlayback();
    const snapshotWithVoice: ReaderSnapshot = {
      ...this.#snapshot,
      status: continuePlaying
        ? "buffering"
        : this.#units.length > 0
          ? "paused"
          : this.#snapshot.status,
    };
    if (voiceId) snapshotWithVoice.voiceId = voiceId;
    else delete snapshotWithVoice.voiceId;
    this.#snapshot = snapshotWithVoice;
    this.#emitState();
    if (continuePlaying) await this.#startCurrent();
  }

  async #startCurrent(): Promise<void> {
    const unit = this.#units[this.#unitOffset];
    if (!unit || !this.#wantsPlayback) return;
    const operation = this.#operation;
    this.#activeUnitId = unit.id;
    this.#emitHighlight(unit);
    const bufferingSnapshot: ReaderSnapshot = {
      ...this.#snapshot,
      status: "buffering",
    };
    delete bufferingSnapshot.error;
    this.#snapshot = bufferingSnapshot;
    this.#emitState();
    if (this.#snapshot.providerId === "browser") {
      this.#startBrowser(unit, operation);
      return;
    }
    await this.#startNeural(unit, operation);
  }

  #startBrowser(unit: NarrationUnit, operation: number): void {
    this.#browserSpeech.speak(
      unit,
      {
        rate: this.#snapshot.playbackRate,
        ...(this.#snapshot.voiceId ? { voiceId: this.#snapshot.voiceId } : {}),
        ...(this.#language ? { language: this.#language } : {}),
      },
      {
        onStarted: () => {
          if (!this.#isCurrent(operation, unit)) return;
          if (!this.#wantsPlayback) {
            this.#browserSpeech.pause();
            return;
          }
          this.#snapshot = reduceReaderState(this.#snapshot, { type: "play" });
          this.#setPosition(unit, 0);
        },
        onPosition: (boundary) => this.#onBrowserPosition(operation, unit, boundary),
        onEnded: (positionMs) => {
          if (!this.#isCurrent(operation, unit)) return;
          if (positionMs !== undefined) this.#setPosition(unit, positionMs);
          void this.#advance(operation, unit);
        },
        onError: (error) => {
          if (this.#isCurrent(operation, unit)) this.#fail(error);
        },
      },
    );
  }

  #onBrowserPosition(
    operation: number,
    unit: NarrationUnit,
    boundary: NormalizedSpeechBoundary,
  ): void {
    if (!this.#isCurrent(operation, unit) || !this.#wantsPlayback) return;
    const positionMs = boundary.positionMs ?? this.#snapshot.positionMs;
    this.#setPosition(unit, positionMs, undefined, boundary.word);
  }

  async #startNeural(unit: NarrationUnit, operation: number): Promise<void> {
    const offsetAtStart = this.#unitOffset;
    const loader = (index: number, signal: AbortSignal): Promise<PreparedAudioClip> =>
      this.#synthesize(index, signal);
    this.#queue.fill(this.#unitOffset, this.#units.length, loader);
    let clip: PreparedAudioClip;
    try {
      clip = await this.#queue.get(this.#unitOffset, loader);
    } catch (error) {
      if (isAbort(error) || error instanceof StaleGenerationError) return;
      if (this.#isCurrent(operation, unit))
        await this.#fallbackToBrowser(readerError(error, "synthesis-failed"));
      return;
    }
    if (
      !this.#isCurrent(operation, unit) ||
      !this.#wantsPlayback ||
      offsetAtStart !== this.#unitOffset
    ) {
      return;
    }
    this.#audioPlayback.setRate(this.#snapshot.playbackRate);
    await this.#audioPlayback.playClip(clip, {
      onStarted: () => {
        if (!this.#isCurrent(operation, unit) || !this.#wantsPlayback) return;
        this.#snapshot = reduceReaderState(this.#snapshot, { type: "play" });
        this.#emitState();
      },
      onPosition: (position) => this.#onAudioPosition(operation, unit, position),
      onEnded: () => {
        if (this.#isCurrent(operation, unit)) void this.#advance(operation, unit);
      },
      onError: (error) => {
        if (this.#isCurrent(operation, unit)) void this.#fallbackToBrowser(error);
      },
    });
    if (!this.#wantsPlayback && this.#isCurrent(operation, unit)) this.#audioPlayback.pause();
  }

  async #synthesize(index: number, signal: AbortSignal): Promise<PreparedAudioClip> {
    const unit = this.#units[index];
    if (!unit) throw new StaleGenerationError();
    const providerId = this.#snapshot.providerId;
    const provider: TTSProvider = this.#client().provider(providerId);
    const result = await provider.synthesize(
      {
        text: unit.text,
        providerId,
        speed: 1,
        ...(this.#snapshot.voiceId ? { voice: this.#snapshot.voiceId } : {}),
        ...(this.#language ? { language: this.#language } : {}),
      },
      signal,
    );
    await this.#refreshCatalogAfterSynthesis(providerId);
    return prepareAudioClip(unit, result);
  }

  #onAudioPosition(operation: number, unit: NarrationUnit, position: AudioClockPosition): void {
    if (!this.#isCurrent(operation, unit)) return;
    const alignment = position.alignment;
    const sourceSpan = alignment
      ? {
          sourceStart: unit.sourceStart + alignment.charStart,
          sourceEnd: unit.sourceStart + alignment.charEnd,
          text: unit.text.slice(alignment.charStart, alignment.charEnd),
        }
      : undefined;
    const word = sourceSpan
      ? wordForSourceSpan(unit, sourceSpan.sourceStart, sourceSpan.sourceEnd)
      : undefined;
    this.#setPosition(unit, position.positionMs, position.durationMs, word, sourceSpan);
  }

  async #advance(operation: number, completedUnit: NarrationUnit): Promise<void> {
    if (!this.#isCurrent(operation, completedUnit) || !this.#wantsPlayback) return;
    const previousOffset = this.#unitOffset;
    if (previousOffset + 1 >= this.#units.length) {
      this.#wantsPlayback = false;
      this.#activeUnitId = undefined;
      this.#audioPlayback.stop();
      this.#browserSpeech.cancel();
      this.#queue.beginGeneration();
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "complete" });
      this.#clearHighlight();
      this.#emitState();
      return;
    }
    this.#audioPlayback.stop();
    this.#browserSpeech.cancel();
    this.#queue.discard(previousOffset);
    this.#unitOffset = previousOffset + 1;
    const next = this.#units[this.#unitOffset];
    if (next) this.#setPosition(next, 0);
    await this.#startCurrent();
  }

  async #fallbackToBrowser(error: ReaderError): Promise<void> {
    if (this.#snapshot.providerId === "browser") {
      this.#fail(error);
      return;
    }
    const shouldContinue = this.#wantsPlayback;
    this.#snapshot = reduceReaderState(this.#snapshot, { type: "fail", error });
    if (error.code === "server-offline") {
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "server", connected: false });
    }
    this.#emitState();
    this.#invalidatePlayback();
    this.#wantsPlayback = shouldContinue;
    this.#snapshot = reduceReaderState(this.#snapshot, {
      type: "provider",
      providerId: "browser",
    });
    this.#snapshot = { ...this.#snapshot, status: shouldContinue ? "buffering" : "paused" };
    this.#emitState();
    if (shouldContinue) await this.#startCurrent();
  }

  #fail(error: ReaderError): void {
    this.#wantsPlayback = false;
    this.#invalidatePlayback();
    this.#snapshot = reduceReaderState(this.#snapshot, { type: "fail", error });
    this.#clearHighlight();
    this.#emitState();
  }

  #setPosition(
    unit: NarrationUnit,
    positionMs: number,
    durationMs?: number,
    word?: ReadingWord,
    timedSourceSpan?: TimedSourceSpan,
  ): void {
    this.#snapshot = reduceReaderState(this.#snapshot, {
      type: "position",
      sentenceIndex: unit.sentenceIndex,
      blockId: unit.blockId,
      sentenceId: unit.sentenceId,
      sentenceText: unit.text,
      ...(word ? { wordId: word.id } : {}),
      ...(timedSourceSpan
        ? { wordText: timedSourceSpan.text }
        : word
          ? { wordText: word.text }
          : {}),
      positionMs,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    this.#emitHighlight(unit, word, timedSourceSpan);
    this.#emitState();
  }

  #emitHighlight(unit: NarrationUnit, word?: ReadingWord, timedSourceSpan?: TimedSourceSpan): void {
    if (this.#tabId === undefined) return;
    const key = `${unit.blockId}\u0000${unit.sentenceId}\u0000${word?.id ?? ""}\u0000${timedSourceSpan?.sourceStart ?? ""}-${timedSourceSpan?.sourceEnd ?? ""}`;
    if (key === this.#lastHighlight) return;
    this.#lastHighlight = key;
    this.#sink.onHighlight({
      tabId: this.#tabId,
      blockId: unit.blockId,
      sentenceId: unit.sentenceId,
      sourceStart: unit.sourceStart,
      sourceEnd: unit.sourceEnd,
      ...(word ? { wordId: word.id } : {}),
      ...(timedSourceSpan
        ? { wordStart: timedSourceSpan.sourceStart, wordEnd: timedSourceSpan.sourceEnd }
        : word
          ? { wordStart: word.startOffset, wordEnd: word.endOffset }
          : {}),
    });
  }

  #clearHighlight(): void {
    if (this.#tabId === undefined || this.#lastHighlight === "clear") return;
    this.#lastHighlight = "clear";
    this.#sink.onHighlight({ tabId: this.#tabId, clear: true });
  }

  #invalidatePlayback(): void {
    this.#operation += 1;
    this.#activeUnitId = undefined;
    this.#browserSpeech.cancel();
    this.#audioPlayback.stop();
    this.#queue.beginGeneration();
  }

  #isCurrent(operation: number, unit: NarrationUnit): boolean {
    return (
      operation === this.#operation &&
      this.#activeUnitId === unit.id &&
      this.#units[this.#unitOffset]?.id === unit.id
    );
  }

  #client(): HttpTTSClient {
    if (!this.#httpClient || this.#httpClient.serverUrl !== this.#serverUrl) {
      this.#httpClient = {
        serverUrl: this.#serverUrl,
        client: this.#httpClientFactory(this.#serverUrl),
      };
    }
    return this.#httpClient.client;
  }

  #setServerUrl(serverUrl: string): void {
    const next = serverUrl.trim() || this.#serverUrl;
    if (next !== this.#serverUrl) this.#catalogRefreshedAfterSynthesis.clear();
    this.#serverUrl = next;
  }

  async #refreshCatalogAfterSynthesis(providerId: string): Promise<void> {
    const key = `${this.#serverUrl}\u0000${providerId}`;
    if (this.#catalogRefreshedAfterSynthesis.has(key)) return;
    this.#catalogRefreshedAfterSynthesis.add(key);
    const expectedServerUrl = this.#serverUrl;
    try {
      const neuralCatalog = await this.#client().getCatalog();
      if (expectedServerUrl !== this.#serverUrl) return;
      this.#catalog = {
        providers: [
          this.#browserSpeech.providerInfo,
          ...neuralCatalog.providers.filter((provider) => provider.id !== "browser"),
        ],
        voices: [
          ...this.#catalog.voices.filter((voice) => voice.providerId === "browser"),
          ...neuralCatalog.voices.filter((voice) => voice.providerId !== "browser"),
        ],
        serverConnected: true,
      };
      this.#sink.onCatalog(this.#catalog);
    } catch {
      // Synthesis already succeeded, so a discovery failure must not discard
      // playable audio. The next successful clip may retry the refresh.
      this.#catalogRefreshedAfterSynthesis.delete(key);
    }
  }

  #updateBufferedCount(): void {
    const count = this.#queue.readyCount(this.#unitOffset);
    if (count === this.#snapshot.bufferedSentenceCount) return;
    this.#snapshot = { ...this.#snapshot, bufferedSentenceCount: count };
    this.#emitState();
  }

  async #refreshBrowserVoices(): Promise<void> {
    const voices = await this.#browserSpeech.getVoices();
    this.#catalog = {
      ...this.#catalog,
      providers: [
        this.#browserSpeech.providerInfo,
        ...this.#catalog.providers.filter((provider) => provider.id !== "browser"),
      ],
      voices: [
        ...voices,
        ...this.#catalog.voices.filter((voice) => voice.providerId !== "browser"),
      ],
    };
    this.#sink.onCatalog(this.#catalog);
  }

  async #refreshCatalog(serverUrl: string): Promise<CatalogSnapshot> {
    this.#setServerUrl(serverUrl);
    const browserVoices = await this.#browserSpeech.getVoices();
    try {
      const neuralCatalog = await this.#client().getCatalog();
      this.#catalog = {
        providers: [
          this.#browserSpeech.providerInfo,
          ...neuralCatalog.providers.filter((provider) => provider.id !== "browser"),
        ],
        voices: [
          ...browserVoices,
          ...neuralCatalog.voices.filter((voice) => voice.providerId !== "browser"),
        ],
        serverConnected: true,
      };
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "server", connected: true });
    } catch (error) {
      if (isAbort(error)) throw error;
      const serverError =
        error instanceof Error ? error.message : "Unable to reach the speech server.";
      const knownNeuralProviders = this.#catalog.providers
        .filter((provider) => provider.id !== "browser")
        .map((provider) => ({
          ...provider,
          available: false,
          status: "unavailable" as const,
          detail: serverError,
        }));
      if (
        this.#snapshot.providerId !== "browser" &&
        !knownNeuralProviders.some((provider) => provider.id === this.#snapshot.providerId)
      ) {
        knownNeuralProviders.push({
          id: this.#snapshot.providerId,
          name: this.#snapshot.providerId,
          available: false,
          local: true,
          status: "unavailable",
          detail: serverError,
          capabilities: {
            streaming: false,
            voiceSelection: false,
            voiceCloning: false,
            voiceDesign: false,
            nativeAlignment: false,
          },
        });
      }
      this.#catalog = {
        providers: [this.#browserSpeech.providerInfo, ...knownNeuralProviders],
        voices: browserVoices,
        serverConnected: false,
        serverError,
      };
      this.#snapshot = reduceReaderState(this.#snapshot, { type: "server", connected: false });
    }
    this.#sink.onCatalog(this.#catalog);
    this.#emitState();
    return this.#catalog;
  }

  #emitState(): void {
    this.#sink.onState(this.#snapshot, this.#tabId);
  }
}
