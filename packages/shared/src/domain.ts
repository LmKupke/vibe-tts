export type ReadingBlockType = "heading" | "paragraph" | "list-item" | "quote" | "other";

export interface ReadingWord {
  id: string;
  sentenceId: string;
  text: string;
  /** Block-normalized, end-exclusive character offsets. */
  startOffset: number;
  endOffset: number;
}

export interface ReadingSentence {
  id: string;
  blockId: string;
  text: string;
  /** Block-normalized, end-exclusive character offsets. */
  startOffset: number;
  endOffset: number;
  words: ReadingWord[];
}

export interface ReadingBlock {
  id: string;
  type: ReadingBlockType;
  text: string;
  sentences: ReadingSentence[];
}

export interface ReadingDocument {
  id: string;
  version: number;
  title?: string;
  url: string;
  language?: string;
  blocks: ReadingBlock[];
  sentenceCount: number;
  wordCount: number;
}

export interface ReadingSelection {
  startBlockId: string;
  startOffset: number;
  endBlockId: string;
  endOffset: number;
}

export type ReaderStartMode = "beginning" | "selection" | "here";

export interface AlignmentEntry {
  text: string;
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

export interface TTSCapabilities {
  streaming: boolean;
  voiceSelection: boolean;
  voiceCloning: boolean;
  voiceDesign: boolean;
  nativeAlignment: boolean;
}

export interface TTSVoice {
  id: string;
  name: string;
  language?: string;
  providerId: string;
  isDefault?: boolean;
  description?: string;
}

export interface TTSProviderInfo {
  id: string;
  name: string;
  available: boolean;
  local: boolean;
  status?: "ready" | "unavailable" | "loading" | "error";
  detail?: string;
  capabilities: TTSCapabilities;
}

export interface SynthesisRequest {
  text: string;
  providerId: string;
  voice?: string;
  speed?: number;
  language?: string;
  diagnostics?: boolean;
}

export interface RawSynthesisResult {
  audio?: ArrayBuffer | Blob;
  mimeType?: string;
  durationMs?: number;
  nativeAlignment?: AlignmentEntry[];
}

export interface SynthesisResult {
  audio: ArrayBuffer | Blob;
  mimeType: string;
  durationMs: number;
  alignment: AlignmentEntry[];
}

export interface AlignmentRequest {
  text: string;
  audio: ArrayBuffer | Blob;
  mimeType: string;
  language?: string;
}

export interface TTSProvider {
  readonly id: string;
  getVoices(signal?: AbortSignal): Promise<TTSVoice[]>;
  getCapabilities(signal?: AbortSignal): Promise<TTSCapabilities>;
  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<RawSynthesisResult>;
}

export interface AlignmentProvider {
  readonly id: string;
  align(request: AlignmentRequest, signal?: AbortSignal): Promise<AlignmentEntry[]>;
}

export type ReaderStatus =
  "idle" | "preparing" | "buffering" | "playing" | "paused" | "completed" | "error";

export interface ReaderError {
  code:
    | "unsupported-page"
    | "file-access-denied"
    | "empty-document"
    | "content-unavailable"
    | "speech-unavailable"
    | "server-offline"
    | "provider-unavailable"
    | "model-loading-failed"
    | "synthesis-failed"
    | "malformed-alignment"
    | "audio-failed"
    | "navigation"
    | "unknown";
  message: string;
  recoverable: boolean;
  detail?: string;
}

export interface ReaderSnapshot {
  sessionId?: string;
  status: ReaderStatus;
  documentTitle?: string;
  documentUrl?: string;
  currentBlockId?: string;
  currentSentenceId?: string;
  currentSentenceText?: string;
  currentWordId?: string;
  currentWordText?: string;
  currentSentenceIndex: number;
  sentenceCount: number;
  positionMs: number;
  durationMs?: number;
  playbackRate: number;
  providerId: string;
  voiceId?: string;
  alignmentProviderId?: string;
  bufferedSentenceCount: number;
  autoScroll: boolean;
  startMode: ReaderStartMode;
  hasSelection: boolean;
  serverConnected?: boolean;
  error?: ReaderError;
}

export interface ReaderPreferences {
  playbackRate: number;
  providerId: string;
  voiceId?: string;
  autoScroll: boolean;
  serverUrl: string;
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  playbackRate: 1,
  providerId: "browser",
  autoScroll: true,
  serverUrl: "http://127.0.0.1:8765",
};

export const INITIAL_READER_SNAPSHOT: ReaderSnapshot = {
  status: "idle",
  currentSentenceIndex: 0,
  sentenceCount: 0,
  positionMs: 0,
  playbackRate: 1,
  providerId: "browser",
  bufferedSentenceCount: 0,
  autoScroll: true,
  startMode: "beginning",
  hasSelection: false,
};

export interface NarrationUnit {
  id: string;
  blockId: string;
  sentenceId: string;
  sentenceIndex: number;
  text: string;
  /** Block-normalized source span represented by this unit. */
  sourceStart: number;
  sourceEnd: number;
  words: ReadingWord[];
}

export type NarrationEvent =
  | { type: "started"; unit: NarrationUnit }
  | { type: "buffering"; unit: NarrationUnit }
  | {
      type: "position";
      unit: NarrationUnit;
      positionMs: number;
      durationMs?: number;
      sourceCharStart?: number;
      sourceCharEnd?: number;
    }
  | { type: "paused"; unit?: NarrationUnit }
  | { type: "resumed"; unit?: NarrationUnit }
  | { type: "unit-ended"; unit: NarrationUnit }
  | { type: "completed" }
  | { type: "stopped" }
  | { type: "error"; error: ReaderError };
