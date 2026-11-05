import {
  INITIAL_READER_SNAPSHOT,
  type ReaderError,
  type ReaderSnapshot,
  type ReaderStartMode,
} from "./domain";

export type ReaderMachineEvent =
  | {
      type: "prepare";
      sessionId: string;
      title?: string;
      url: string;
      sentenceCount: number;
      startMode: ReaderStartMode;
      hasSelection: boolean;
    }
  | { type: "ready"; sentenceIndex: number }
  | { type: "buffer"; bufferedSentenceCount: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "complete" }
  | { type: "stop" }
  | { type: "fail"; error: ReaderError }
  | {
      type: "position";
      sentenceIndex: number;
      blockId: string;
      sentenceId: string;
      sentenceText: string;
      wordId?: string;
      wordText?: string;
      positionMs: number;
      durationMs?: number;
    }
  | { type: "rate"; rate: number }
  | { type: "provider"; providerId: string; voiceId?: string }
  | { type: "auto-scroll"; enabled: boolean }
  | { type: "server"; connected: boolean };

export function reduceReaderState(
  state: ReaderSnapshot,
  event: ReaderMachineEvent,
): ReaderSnapshot {
  switch (event.type) {
    case "prepare":
      return {
        ...INITIAL_READER_SNAPSHOT,
        sessionId: event.sessionId,
        status: "preparing",
        ...(event.title === undefined ? {} : { documentTitle: event.title }),
        documentUrl: event.url,
        sentenceCount: event.sentenceCount,
        playbackRate: state.playbackRate,
        providerId: state.providerId,
        ...(state.voiceId === undefined ? {} : { voiceId: state.voiceId }),
        autoScroll: state.autoScroll,
        ...(state.serverConnected === undefined ? {} : { serverConnected: state.serverConnected }),
        startMode: event.startMode,
        hasSelection: event.hasSelection,
      };
    case "ready":
      return { ...state, status: "paused", currentSentenceIndex: event.sentenceIndex };
    case "buffer":
      return {
        ...state,
        status: state.status === "playing" ? "playing" : "buffering",
        bufferedSentenceCount: event.bufferedSentenceCount,
      };
    case "play": {
      const next = { ...state, status: "playing" as const };
      delete next.error;
      return next;
    }
    case "pause":
      return state.status === "playing" || state.status === "buffering"
        ? { ...state, status: "paused" }
        : state;
    case "complete":
      return {
        ...state,
        status: "completed",
        positionMs: state.durationMs ?? state.positionMs,
        bufferedSentenceCount: 0,
      };
    case "stop": {
      const preserved = {
        playbackRate: state.playbackRate,
        providerId: state.providerId,
        autoScroll: state.autoScroll,
        ...(state.voiceId === undefined ? {} : { voiceId: state.voiceId }),
        ...(state.serverConnected === undefined ? {} : { serverConnected: state.serverConnected }),
      };
      return {
        ...INITIAL_READER_SNAPSHOT,
        ...preserved,
      };
    }
    case "fail":
      return { ...state, status: "error", error: event.error, bufferedSentenceCount: 0 };
    case "position": {
      const withoutTransientPosition = { ...state };
      delete withoutTransientPosition.currentWordId;
      delete withoutTransientPosition.currentWordText;
      delete withoutTransientPosition.durationMs;
      return {
        ...withoutTransientPosition,
        currentSentenceIndex: event.sentenceIndex,
        currentBlockId: event.blockId,
        currentSentenceId: event.sentenceId,
        currentSentenceText: event.sentenceText,
        ...(event.wordId === undefined ? {} : { currentWordId: event.wordId }),
        ...(event.wordText === undefined ? {} : { currentWordText: event.wordText }),
        positionMs: event.positionMs,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      };
    }
    case "rate":
      return { ...state, playbackRate: event.rate };
    case "provider": {
      const withoutVoice = { ...state };
      delete withoutVoice.voiceId;
      return {
        ...withoutVoice,
        providerId: event.providerId,
        ...(event.voiceId === undefined ? {} : { voiceId: event.voiceId }),
      };
    }
    case "auto-scroll":
      return { ...state, autoScroll: event.enabled };
    case "server":
      return { ...state, serverConnected: event.connected };
  }
}
