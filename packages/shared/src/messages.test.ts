import { describe, expect, it } from "vitest";

import { DEFAULT_READER_PREFERENCES, INITIAL_READER_SNAPSHOT } from "./domain";
import {
  isExtensionMessage,
  isReaderBootstrap,
  type ContentCommand,
  type ExtensionMessage,
  type ReaderBootstrap,
} from "./messages";

describe("reader bootstrap messages", () => {
  it("recognizes a persisted-preference bootstrap payload", () => {
    const bootstrap: ReaderBootstrap = {
      snapshot: INITIAL_READER_SNAPSHOT,
      preferences: DEFAULT_READER_PREFERENCES,
      catalog: { providers: [], voices: [], serverConnected: false },
    };

    expect(isReaderBootstrap(bootstrap)).toBe(true);
  });

  it("rejects payloads that omit persisted preferences", () => {
    expect(isReaderBootstrap({ snapshot: INITIAL_READER_SNAPSHOT })).toBe(false);
  });
});

describe("inline reading messages", () => {
  it("models a content request and its semantic block preparation command", () => {
    const request: ExtensionMessage = {
      type: "read-from-block",
      requestId: "read-from-block-test",
      source: "content",
      target: "background",
      blockKey: "md-12",
      url: "file:///Users/example/notes.md",
    };
    const command: ContentCommand = { type: "prepare-from-block", blockKey: request.blockKey };

    expect(isExtensionMessage(request)).toBe(true);
    expect(command).toEqual({ type: "prepare-from-block", blockKey: "md-12" });
  });
});
