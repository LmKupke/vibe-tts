import type {
  ReaderError,
  ReaderPreferences,
  ReaderSnapshot,
  ReaderStartMode,
  ReadingDocument,
  ReadingSelection,
  TTSProviderInfo,
  TTSVoice,
} from "./domain";

export type ExtensionContext = "background" | "content" | "offscreen" | "sidepanel";

export type PanelCommand =
  | { type: "prepare"; startMode: ReaderStartMode }
  | { type: "play" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "previous-sentence" }
  | { type: "next-sentence" }
  | { type: "seek-sentence"; sentenceIndex: number }
  | { type: "set-rate"; rate: number }
  | { type: "set-provider"; providerId: string }
  | { type: "set-voice"; voiceId?: string }
  | { type: "set-auto-scroll"; enabled: boolean }
  | { type: "set-server-url"; serverUrl: string }
  | { type: "refresh-providers" };

export type ContentCommand =
  | { type: "ping" }
  | {
      type: "prepare";
      startMode: ReaderStartMode;
      /** Restore content-script session metadata after the offscreen document expires. */
      restoreSession?: "beginning" | "current";
    }
  | { type: "prepare-from-block"; blockKey: string }
  | {
      type: "highlight";
      blockId: string;
      sentenceId: string;
      wordId?: string;
      /** Exact block-normalized narration span, including clipped selections. */
      sourceStart?: number;
      sourceEnd?: number;
      wordStart?: number;
      wordEnd?: number;
    }
  | { type: "clear-highlights"; resetSession?: boolean }
  | { type: "set-auto-scroll"; enabled: boolean }
  | { type: "find-here"; clientX: number; clientY: number };

export type ContentResponse =
  | { ok: true; type: "pong"; needsMermaid?: boolean }
  | {
      ok: true;
      type: "prepared";
      document: ReadingDocument;
      selection?: ReadingSelection;
      startSentenceIndex: number;
    }
  | { ok: true; type: "ack" }
  | { ok: false; type: "error"; message: string; code?: string };

export type OffscreenCommand =
  | {
      type: "load";
      tabId: number;
      document: ReadingDocument;
      selection?: ReadingSelection;
      startSentenceIndex: number;
      preferences: ReaderPreferences;
    }
  | { type: "play" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "previous-sentence" }
  | { type: "next-sentence" }
  | { type: "seek-sentence"; sentenceIndex: number }
  | { type: "set-rate"; rate: number }
  | { type: "set-provider"; providerId: string; serverUrl: string }
  | { type: "set-voice"; voiceId?: string }
  | { type: "set-auto-scroll"; enabled: boolean }
  | { type: "page-error"; error: ReaderError }
  | { type: "get-state" }
  | { type: "get-catalog"; serverUrl: string };

export interface CatalogSnapshot {
  providers: TTSProviderInfo[];
  voices: TTSVoice[];
  serverConnected: boolean;
  serverError?: string;
}

/** State needed to hydrate a newly opened side panel after worker suspension. */
export interface ReaderBootstrap {
  snapshot: ReaderSnapshot;
  preferences: ReaderPreferences;
  catalog?: CatalogSnapshot;
}

interface MessageBase {
  requestId: string;
  source: ExtensionContext;
  target: ExtensionContext;
}

export type ExtensionMessage =
  | (MessageBase & {
      type: "panel-command";
      source: "sidepanel";
      target: "background";
      command: PanelCommand;
    })
  | (MessageBase & {
      type: "content-command";
      source: "background";
      target: "content";
      command: ContentCommand;
    })
  | (MessageBase & {
      type: "offscreen-command";
      source: "background";
      target: "offscreen";
      command: OffscreenCommand;
    })
  | (MessageBase & {
      type: "reader-state";
      source: "offscreen" | "background";
      target: "background" | "sidepanel";
      snapshot: ReaderSnapshot;
      tabId?: number;
    })
  | (MessageBase & {
      type: "highlight-update";
      source: "offscreen";
      target: "background";
      tabId: number;
      blockId?: string;
      sentenceId?: string;
      wordId?: string;
      sourceStart?: number;
      sourceEnd?: number;
      wordStart?: number;
      wordEnd?: number;
      clear?: boolean;
    })
  | (MessageBase & {
      type: "catalog-update";
      source: "offscreen" | "background";
      target: "background" | "sidepanel";
      catalog: CatalogSnapshot;
    })
  | (MessageBase & {
      type: "page-changed";
      source: "content";
      target: "background";
      tabId?: number;
      url: string;
    })
  | (MessageBase & {
      type: "page-invalidated";
      source: "content";
      target: "background";
      tabId?: number;
      url: string;
      reason: "indexed-content-mutated" | "view-mode-changed";
    })
  | (MessageBase & {
      type: "read-from-block";
      source: "content";
      target: "background";
      blockKey: string;
      url: string;
    })
  | (MessageBase & {
      type: "request-state";
      source: "sidepanel";
      target: "background";
    });

export interface MessageReply<T = unknown> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: { code: string; message: string };
}

export function createRequestId(prefix = "msg"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.target === "string"
  );
}

export function isReaderBootstrap(value: unknown): value is ReaderBootstrap {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.snapshot !== "object" ||
    candidate.snapshot === null ||
    typeof candidate.preferences !== "object" ||
    candidate.preferences === null
  ) {
    return false;
  }
  const snapshot = candidate.snapshot as Record<string, unknown>;
  const preferences = candidate.preferences as Record<string, unknown>;
  const catalog = candidate.catalog;
  return (
    typeof snapshot.status === "string" &&
    typeof snapshot.currentSentenceIndex === "number" &&
    typeof snapshot.sentenceCount === "number" &&
    typeof preferences.playbackRate === "number" &&
    typeof preferences.providerId === "string" &&
    typeof preferences.autoScroll === "boolean" &&
    typeof preferences.serverUrl === "string" &&
    (catalog === undefined ||
      (typeof catalog === "object" &&
        catalog !== null &&
        Array.isArray((catalog as Record<string, unknown>).providers) &&
        Array.isArray((catalog as Record<string, unknown>).voices) &&
        typeof (catalog as Record<string, unknown>).serverConnected === "boolean"))
  );
}
