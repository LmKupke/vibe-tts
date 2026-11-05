import { describe, expect, it } from "vitest";

import { INITIAL_READER_SNAPSHOT } from "./domain";
import { reduceReaderState } from "./reader-machine";

describe("reader state machine", () => {
  it("moves through prepare, ready, play, pause, and complete", () => {
    let state = reduceReaderState(INITIAL_READER_SNAPSHOT, {
      type: "prepare",
      sessionId: "session-1",
      title: "Article",
      url: "https://example.test/article",
      sentenceCount: 3,
      startMode: "beginning",
      hasSelection: false,
    });
    expect(state.status).toBe("preparing");

    state = reduceReaderState(state, { type: "ready", sentenceIndex: 0 });
    state = reduceReaderState(state, { type: "play" });
    expect(state.status).toBe("playing");

    state = reduceReaderState(state, { type: "pause" });
    expect(state.status).toBe("paused");

    state = reduceReaderState(state, { type: "complete" });
    expect(state.status).toBe("completed");
  });

  it("keeps pause idempotent outside active playback", () => {
    expect(reduceReaderState(INITIAL_READER_SNAPSHOT, { type: "pause" })).toBe(
      INITIAL_READER_SNAPSHOT,
    );
  });
});
