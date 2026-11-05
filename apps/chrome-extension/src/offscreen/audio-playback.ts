import {
  findAlignmentAtTime,
  type AlignmentEntry,
  type NarrationUnit,
  type RawSynthesisResult,
  type ReaderError,
} from "@vibe-tts/shared";

export interface PreparedAudioClip {
  unit: NarrationUnit;
  audio: ArrayBuffer | Blob;
  mimeType: string;
  durationMs?: number;
  alignment: AlignmentEntry[];
}

export interface AudioClockPosition {
  positionMs: number;
  durationMs?: number;
  alignment?: AlignmentEntry;
}

export interface AudioPlaybackCallbacks {
  onStarted(): void;
  onPosition(position: AudioClockPosition): void;
  onEnded(): void;
  onError(error: ReaderError): void;
}

export interface AudioElementLike {
  currentTime: number;
  duration: number;
  playbackRate: number;
  preload: string;
  src: string;
  readonly paused: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  load(): void;
  pause(): void;
  play(): Promise<void>;
}

export interface PlaybackObserverClock {
  start(callback: () => void, intervalMs: number): number;
  stop(handle: number): void;
}

export interface AudioPlaybackDependencies {
  createAudio(): AudioElementLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  observerClock: PlaybackObserverClock;
}

function defaultDependencies(): AudioPlaybackDependencies {
  return {
    createAudio: () => new Audio(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    observerClock: {
      start: (callback, intervalMs) => window.setInterval(callback, intervalMs),
      stop: (handle) => window.clearInterval(handle),
    },
  };
}

export function prepareAudioClip(
  unit: NarrationUnit,
  result: RawSynthesisResult,
): PreparedAudioClip {
  if (!result.audio || !result.mimeType) {
    throw new Error("Synthesis completed without playable audio.");
  }
  return {
    unit,
    audio: result.audio,
    mimeType: result.mimeType,
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    alignment: result.nativeAlignment ?? [],
  };
}

/** Plays one neural clip and derives all timing from HTMLAudioElement.currentTime. */
export class HtmlAudioPlayback {
  readonly #dependencies: AudioPlaybackDependencies;
  #audio: AudioElementLike | undefined;
  #clip: PreparedAudioClip | undefined;
  #callbacks: AudioPlaybackCallbacks | undefined;
  #objectUrl: string | undefined;
  #observer: number | undefined;
  #lastEmittedPosition = Number.NEGATIVE_INFINITY;
  #lastAlignment: AlignmentEntry | undefined;
  #token = 0;
  #rate = 1;

  constructor(dependencies: AudioPlaybackDependencies = defaultDependencies()) {
    this.#dependencies = dependencies;
  }

  get active(): boolean {
    return this.#audio !== undefined;
  }

  get paused(): boolean {
    return this.#audio?.paused ?? true;
  }

  get currentUnit(): NarrationUnit | undefined {
    return this.#clip?.unit;
  }

  async playClip(clip: PreparedAudioClip, callbacks: AudioPlaybackCallbacks): Promise<void> {
    this.stop();
    const token = this.#token;
    const audio = this.#dependencies.createAudio();
    const blob =
      clip.audio instanceof Blob ? clip.audio : new Blob([clip.audio], { type: clip.mimeType });
    const objectUrl = this.#dependencies.createObjectURL(blob);
    this.#audio = audio;
    this.#clip = clip;
    this.#callbacks = callbacks;
    this.#objectUrl = objectUrl;
    this.#lastEmittedPosition = Number.NEGATIVE_INFINITY;
    this.#lastAlignment = undefined;
    audio.preload = "auto";
    audio.playbackRate = this.#rate;
    audio.src = objectUrl;
    audio.addEventListener("ended", this.#onEnded);
    audio.addEventListener("error", this.#onError);
    audio.addEventListener("loadedmetadata", this.#onLoadedMetadata);
    audio.addEventListener("timeupdate", this.#onTimeUpdate);
    audio.load();
    try {
      await audio.play();
      if (token !== this.#token || audio !== this.#audio) return;
      callbacks.onStarted();
      this.#emitPosition(true);
      this.#schedule();
    } catch (error) {
      if (token !== this.#token || audio !== this.#audio) return;
      callbacks.onError({
        code: "audio-failed",
        message: error instanceof Error ? error.message : "Audio playback could not start.",
        recoverable: true,
      });
    }
  }

  pause(): void {
    const audio = this.#audio;
    if (!audio || audio.paused) return;
    audio.pause();
    this.#stopObserver();
    this.#emitPosition(true);
  }

  async resume(): Promise<void> {
    const audio = this.#audio;
    if (!audio || !audio.paused) return;
    const token = this.#token;
    try {
      await audio.play();
      if (token !== this.#token || audio !== this.#audio) return;
      this.#emitPosition(true);
      this.#schedule();
    } catch (error) {
      if (token !== this.#token || audio !== this.#audio) return;
      this.#callbacks?.onError({
        code: "audio-failed",
        message: error instanceof Error ? error.message : "Audio playback could not resume.",
        recoverable: true,
      });
    }
  }

  setRate(rate: number): void {
    this.#rate = Math.min(4, Math.max(0.25, rate));
    if (this.#audio) this.#audio.playbackRate = this.#rate;
  }

  stop(): void {
    this.#token += 1;
    this.#stopObserver();
    const audio = this.#audio;
    if (audio) {
      audio.removeEventListener("ended", this.#onEnded);
      audio.removeEventListener("error", this.#onError);
      audio.removeEventListener("loadedmetadata", this.#onLoadedMetadata);
      audio.removeEventListener("timeupdate", this.#onTimeUpdate);
      audio.pause();
      audio.src = "";
      audio.load();
    }
    if (this.#objectUrl) this.#dependencies.revokeObjectURL(this.#objectUrl);
    this.#audio = undefined;
    this.#clip = undefined;
    this.#callbacks = undefined;
    this.#objectUrl = undefined;
    this.#lastAlignment = undefined;
    this.#lastEmittedPosition = Number.NEGATIVE_INFINITY;
  }

  #schedule(): void {
    this.#stopObserver();
    if (!this.#audio || this.#audio.paused) return;
    // This interval only wakes observation. HTMLAudioElement.currentTime is the
    // sole authoritative clock, with `timeupdate` as an independent wake-up.
    this.#observer = this.#dependencies.observerClock.start(this.#onObservation, 75);
  }

  #stopObserver(): void {
    if (this.#observer === undefined) return;
    this.#dependencies.observerClock.stop(this.#observer);
    this.#observer = undefined;
  }

  #onObservation = (): void => {
    if (!this.#audio || this.#audio.paused) return;
    this.#emitPosition(false);
  };

  #emitPosition(force: boolean): void {
    const audio = this.#audio;
    const clip = this.#clip;
    const callbacks = this.#callbacks;
    if (!audio || !clip || !callbacks) return;
    if (!Number.isFinite(audio.currentTime) || audio.currentTime < 0) return;
    const positionMs = audio.currentTime * 1_000;
    const alignment = findAlignmentAtTime(clip.alignment, positionMs);
    const alignmentChanged = alignment !== this.#lastAlignment;
    const progressIntervalReached = Math.abs(positionMs - this.#lastEmittedPosition) >= 100;
    if (!force && !alignmentChanged && !progressIntervalReached) return;
    this.#lastEmittedPosition = positionMs;
    this.#lastAlignment = alignment;
    const actualDuration =
      Number.isFinite(audio.duration) && audio.duration >= 0
        ? audio.duration * 1_000
        : clip.durationMs;
    callbacks.onPosition({
      positionMs,
      ...(actualDuration === undefined ? {} : { durationMs: actualDuration }),
      ...(alignment ? { alignment } : {}),
    });
  }

  #onLoadedMetadata = (): void => this.#emitPosition(true);

  #onTimeUpdate = (): void => this.#emitPosition(false);

  #onEnded = (): void => {
    this.#stopObserver();
    this.#emitPosition(true);
    this.#callbacks?.onEnded();
  };

  #onError = (): void => {
    this.#stopObserver();
    this.#callbacks?.onError({
      code: "audio-failed",
      message: "The synthesized audio could not be played.",
      recoverable: true,
    });
  };
}
