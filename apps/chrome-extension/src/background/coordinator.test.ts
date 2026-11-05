import {
  DEFAULT_READER_PREFERENCES,
  INITIAL_READER_SNAPSHOT,
  type ContentCommand,
  type ExtensionMessage,
  type MessageReply,
  type OffscreenCommand,
  type ReaderSnapshot,
  type ReadingDocument,
} from "@vibe-tts/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const offscreen = vi.hoisted(() => ({
  ensure: vi.fn(() => Promise.resolve()),
  exists: vi.fn<() => Promise<boolean>>(),
  send: vi.fn(),
}));

const browser = {
  fileAccess: vi.fn<() => Promise<boolean>>(),
  tabsQuery: vi.fn<() => Promise<chrome.tabs.Tab[]>>(),
  needsMermaid: false,
  inlinePreparationWaits: new Map<string, Promise<void>>(),
  inlinePreparationErrors: new Set<string>(),
};

vi.mock("./offscreen", () => ({
  ensureOffscreenDocument: offscreen.ensure,
  hasOffscreenDocument: offscreen.exists,
  isMessageReply: (value: unknown) =>
    typeof value === "object" && value !== null && "ok" in value && "requestId" in value,
  offscreenCommand: (command: OffscreenCommand) => ({
    type: "offscreen-command",
    requestId: `offscreen-${command.type}`,
    source: "background",
    target: "offscreen",
    command,
  }),
  sendOffscreenMessage: offscreen.send,
}));

vi.mock("./permissions", () => ({
  ServerPermissionError: class ServerPermissionError extends Error {
    readonly code = "server-permission-denied";
  },
  hasServerPermission: vi.fn(() => Promise.resolve(true)),
  removeServerPermission: vi.fn(() => Promise.resolve()),
  requestServerPermission: vi.fn(() => Promise.resolve()),
  serverOriginPattern: (url: string) => url,
}));

import { BackgroundCoordinator } from "./coordinator";

type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageReply<unknown>) => void,
) => boolean | undefined;

const readingDocument: ReadingDocument = {
  id: "document-test",
  version: 1,
  title: "Lifecycle test",
  url: "https://example.test/article",
  blocks: [
    {
      id: "block-0",
      type: "paragraph",
      text: "First sentence. Second sentence.",
      sentences: [
        {
          id: "sentence-0",
          blockId: "block-0",
          text: "First sentence.",
          startOffset: 0,
          endOffset: 15,
          words: [],
        },
        {
          id: "sentence-1",
          blockId: "block-0",
          text: "Second sentence.",
          startOffset: 16,
          endOffset: 32,
          words: [],
        },
      ],
    },
  ],
  sentenceCount: 2,
  wordCount: 4,
};

function snapshot(status: ReaderSnapshot["status"]): ReaderSnapshot {
  return {
    ...INITIAL_READER_SNAPSHOT,
    sessionId: "reader-stale",
    status,
    documentTitle: "Lifecycle test",
    documentUrl: readingDocument.url,
    currentBlockId: "block-0",
    currentSentenceId: "sentence-1",
    currentSentenceIndex: 1,
    sentenceCount: 2,
    startMode: "selection",
    hasSelection: true,
  };
}

describe("background lifecycle reconstruction", () => {
  let listener: BackgroundListener;
  let actionListener: (tab: chrome.tabs.Tab) => void;
  let commandListener: (command: string) => void;
  let contentMessages: Extract<ExtensionMessage, { type: "content-command" }>[];
  let contentTabIds: number[];
  let runtimeMessages: ExtensionMessage[];

  beforeEach(() => {
    offscreen.ensure.mockClear();
    offscreen.exists.mockReset();
    offscreen.send.mockReset();
    offscreen.send.mockImplementation(
      (message: Extract<ExtensionMessage, { type: "offscreen-command" }>) =>
        Promise.resolve({ ok: true, requestId: message.requestId }),
    );
    contentMessages = [];
    contentTabIds = [];
    runtimeMessages = [];
    browser.fileAccess.mockReset().mockResolvedValue(true);
    browser.needsMermaid = false;
    browser.inlinePreparationWaits.clear();
    browser.inlinePreparationErrors.clear();
    browser.tabsQuery
      .mockReset()
      .mockResolvedValue([
        { id: 7, url: "https://example.test/article", active: true } as chrome.tabs.Tab,
      ]);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        onMessage: { addListener: (candidate: BackgroundListener) => (listener = candidate) },
        sendMessage: vi.fn((message: ExtensionMessage) => {
          runtimeMessages.push(message);
          return Promise.resolve();
        }),
      },
      action: {
        onClicked: {
          addListener: (candidate: (tab: chrome.tabs.Tab) => void) => (actionListener = candidate),
        },
      },
      commands: {
        onCommand: {
          addListener: (candidate: (command: string) => void) => (commandListener = candidate),
        },
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        query: browser.tabsQuery,
        get: vi.fn(() =>
          Promise.resolve({ id: 7, url: "https://example.test/article", active: true }),
        ),
        sendMessage: vi.fn(
          (tabId: number, message: Extract<ExtensionMessage, { type: "content-command" }>) => {
            contentTabIds.push(tabId);
            contentMessages.push(message);
            const command: ContentCommand = message.command;
            const data =
              command.type === "ping"
                ? {
                    ok: true,
                    type: "pong" as const,
                    needsMermaid: browser.needsMermaid,
                  }
                : command.type === "prepare-from-block" &&
                    browser.inlinePreparationErrors.has(command.blockKey)
                  ? {
                      ok: false,
                      type: "error" as const,
                      code: "stale-block",
                      message: "That paragraph is no longer available.",
                    }
                  : command.type === "prepare" || command.type === "prepare-from-block"
                    ? {
                        ok: true,
                        type: "prepared" as const,
                        document: readingDocument,
                        startSentenceIndex:
                          command.type === "prepare-from-block" && command.blockKey === "md-0"
                            ? 0
                            : 1,
                        ...(command.type === "prepare"
                          ? {
                              selection: {
                                startBlockId: "block-0",
                                startOffset: 16,
                                endBlockId: "block-0",
                                endOffset: 32,
                              },
                            }
                          : {}),
                      }
                    : { ok: true, type: "ack" as const };
            const wait =
              command.type === "prepare-from-block"
                ? browser.inlinePreparationWaits.get(command.blockKey)
                : undefined;
            return Promise.resolve(wait).then(() => ({
              ok: true,
              requestId: message.requestId,
              data,
            }));
          },
        ),
      },
      scripting: { executeScript: vi.fn(() => Promise.resolve()) },
      sidePanel: { open: vi.fn(() => Promise.resolve()) },
      extension: { isAllowedFileSchemeAccess: browser.fileAccess },
      storage: {
        local: {
          get: vi.fn(() => Promise.resolve({ readerPreferences: DEFAULT_READER_PREFERENCES })),
          set: vi.fn(() => Promise.resolve()),
        },
      },
    });

    new BackgroundCoordinator().start();
  });

  const dispatch = (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender = {},
  ): Promise<MessageReply<unknown>> =>
    new Promise((resolve, reject) => {
      const keepAlive = listener(message, sender, resolve);
      if (keepAlive !== true) reject(new Error("Background listener did not accept the message."));
    });

  async function installStaleSnapshot(status: ReaderSnapshot["status"]): Promise<void> {
    await dispatch({
      type: "reader-state",
      requestId: `state-${status}`,
      source: "offscreen",
      target: "background",
      snapshot: snapshot(status),
      tabId: 7,
    });
  }

  const inlineRequest = (requestId: string, blockKey: string): ExtensionMessage => ({
    type: "read-from-block",
    requestId,
    source: "content",
    target: "background",
    blockKey,
    url: readingDocument.url,
  });

  it("prepares and plays from a semantic block in the sender tab", async () => {
    browser.tabsQuery.mockResolvedValue([
      { id: 99, url: "https://other.test/active", active: true } as chrome.tabs.Tab,
    ]);

    const reply = await dispatch(inlineRequest("inline-read", "md-1"), {
      tab: { id: 42, url: readingDocument.url, active: false } as chrome.tabs.Tab,
    });

    expect(reply.ok).toBe(true);
    expect(browser.tabsQuery).not.toHaveBeenCalled();
    expect(new Set(contentTabIds)).toEqual(new Set([42]));
    expect(
      contentMessages.find((message) => message.command.type === "prepare-from-block")?.command,
    ).toEqual({ type: "prepare-from-block", blockKey: "md-1" });
    expect(
      offscreen.send.mock.calls.map(
        (call) =>
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type,
      ),
    ).toEqual(["load", "play"]);
    const load = (
      offscreen.send.mock.calls[0]?.[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>
    ).command;
    expect(load).toMatchObject({ type: "load", tabId: 42, startSentenceIndex: 1 });
  });

  it("rejects missing tabs and malformed block keys without loading playback", async () => {
    const missingTab = await dispatch(inlineRequest("inline-no-tab", "md-1"));
    const malformedKey = await dispatch(inlineRequest("inline-bad-key", "md-1234567"), {
      tab: { id: 42, url: readingDocument.url } as chrome.tabs.Tab,
    });

    expect(missingTab).toMatchObject({
      ok: false,
      error: { code: "missing-tab" },
    });
    expect(malformedKey).toMatchObject({
      ok: false,
      error: { code: "invalid-block-key" },
    });
    expect(contentMessages).toHaveLength(0);
    expect(offscreen.send).not.toHaveBeenCalled();
  });

  it("does not load or play when block preparation fails", async () => {
    browser.inlinePreparationErrors.add("md-1");

    const reply = await dispatch(inlineRequest("inline-stale-block", "md-1"), {
      tab: { id: 42, url: readingDocument.url } as chrome.tabs.Tab,
    });

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "stale-block",
        message: "That paragraph is no longer available.",
      },
    });
    expect(offscreen.ensure).not.toHaveBeenCalled();
    expect(offscreen.send).not.toHaveBeenCalled();
    expect(
      runtimeMessages.some(
        (message) =>
          message.type === "reader-state" && message.snapshot.error?.message.includes("paragraph"),
      ),
    ).toBe(true);
  });

  it("lets the latest rapid inline request win", async () => {
    let releaseFirst: (() => void) | undefined;
    browser.inlinePreparationWaits.set(
      "md-0",
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const sender = {
      tab: { id: 42, url: readingDocument.url, active: true } as chrome.tabs.Tab,
    };

    const first = dispatch(inlineRequest("inline-first", "md-0"), sender);
    await vi.waitFor(() =>
      expect(
        contentMessages.some(
          (message) =>
            message.command.type === "prepare-from-block" && message.command.blockKey === "md-0",
        ),
      ).toBe(true),
    );
    const second = dispatch(inlineRequest("inline-second", "md-1"), sender);
    await expect(second).resolves.toMatchObject({ ok: true });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ ok: true });

    const offscreenCommands = offscreen.send.mock.calls.map(
      (call) => (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command,
    );
    expect(offscreenCommands.map((command) => command.type)).toEqual(["load", "play"]);
    expect(offscreenCommands[0]).toMatchObject({ type: "load", startSentenceIndex: 1 });
  });

  it("cancels an in-flight inline request when the page is invalidated", async () => {
    let releasePreparation: (() => void) | undefined;
    browser.inlinePreparationWaits.set(
      "md-0",
      new Promise<void>((resolve) => {
        releasePreparation = resolve;
      }),
    );
    const sender = {
      tab: { id: 42, url: readingDocument.url, active: true } as chrome.tabs.Tab,
    };

    const inline = dispatch(inlineRequest("inline-cancelled", "md-0"), sender);
    await vi.waitFor(() =>
      expect(contentMessages.some((message) => message.command.type === "prepare-from-block")).toBe(
        true,
      ),
    );
    await dispatch(
      {
        type: "page-invalidated",
        requestId: "inline-view-changed",
        source: "content",
        target: "background",
        url: readingDocument.url,
        reason: "view-mode-changed",
      },
      sender,
    );
    releasePreparation?.();
    await expect(inline).resolves.toMatchObject({ ok: true });

    expect(
      offscreen.send.mock.calls.some((call) =>
        ["load", "play"].includes(
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type,
        ),
      ),
    ).toBe(false);
  });

  it("verifies the real offscreen context and reconstructs a stale panel session", async () => {
    await installStaleSnapshot("paused");
    offscreen.exists.mockResolvedValue(false);

    const reply = await dispatch({
      type: "panel-command",
      requestId: "panel-next",
      source: "sidepanel",
      target: "background",
      command: { type: "next-sentence" },
    });

    expect(reply.ok).toBe(true);
    expect(contentMessages.find((message) => message.command.type === "prepare")?.command).toEqual({
      type: "prepare",
      startMode: "here",
      restoreSession: "current",
    });
    expect(offscreen.ensure).toHaveBeenCalledTimes(1);
    expect(
      offscreen.send.mock.calls.map(
        (call) =>
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type,
      ),
    ).toEqual(["load", "next-sentence"]);
    expect(offscreen.send.mock.calls[1]?.[1]).toBe(false);
  });

  it("uses the same reconstruction path for a keyboard pause after expiry", async () => {
    await installStaleSnapshot("playing");
    offscreen.exists.mockResolvedValue(false);

    commandListener("toggle-playback");
    await vi.waitFor(() => expect(offscreen.ensure).toHaveBeenCalledTimes(1));

    expect(contentMessages.find((message) => message.command.type === "prepare")?.command).toEqual({
      type: "prepare",
      startMode: "here",
      restoreSession: "current",
    });
    expect(
      offscreen.send.mock.calls.map(
        (call) =>
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type,
      ),
    ).toEqual(["load"]);
  });

  it("stops and clears content session memory when indexed content is invalidated", async () => {
    await installStaleSnapshot("playing");
    offscreen.exists.mockResolvedValue(true);

    const reply = await dispatch(
      {
        type: "page-invalidated",
        requestId: "content-invalidated",
        source: "content",
        target: "background",
        url: readingDocument.url,
        reason: "indexed-content-mutated",
      },
      { tab: { id: 7 } as chrome.tabs.Tab },
    );

    expect(reply.ok).toBe(true);
    expect(
      contentMessages.find((message) => message.command.type === "clear-highlights")?.command,
    ).toEqual({ type: "clear-highlights", resetSession: true });
    expect(
      offscreen.send.mock.calls.some(
        (call) =>
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type ===
          "stop",
      ),
    ).toBe(true);
  });

  it("returns to idle without an error when the Markdown view mode changes", async () => {
    await installStaleSnapshot("playing");
    offscreen.exists.mockResolvedValue(true);
    runtimeMessages = [];

    const reply = await dispatch(
      {
        type: "page-invalidated",
        requestId: "view-mode-changed",
        source: "content",
        target: "background",
        url: readingDocument.url,
        reason: "view-mode-changed",
      },
      { tab: { id: 7 } as chrome.tabs.Tab },
    );

    expect(reply.ok).toBe(true);
    expect(
      contentMessages.find((message) => message.command.type === "clear-highlights")?.command,
    ).toEqual({ type: "clear-highlights", resetSession: true });
    expect(
      offscreen.send.mock.calls.some(
        (call) =>
          (call[0] as Extract<ExtensionMessage, { type: "offscreen-command" }>).command.type ===
          "stop",
      ),
    ).toBe(true);
    const finalState = runtimeMessages.findLast((message) => message.type === "reader-state");
    expect(finalState?.type).toBe("reader-state");
    if (!finalState || finalState.type !== "reader-state") {
      throw new Error("Expected the coordinator to broadcast a final reader state.");
    }
    expect(finalState.snapshot.status).toBe("idle");
    expect(finalState.snapshot.sentenceCount).toBe(0);
    expect(finalState.snapshot.error).toBeUndefined();
  });

  it("reports an actionable error before preparing a file when local access is off", async () => {
    browser.tabsQuery.mockResolvedValue([
      { id: 7, url: "file:///Users/example/company.md", active: true } as chrome.tabs.Tab,
    ]);
    browser.fileAccess.mockResolvedValue(false);

    const reply = await dispatch({
      type: "panel-command",
      requestId: "panel-prepare-file",
      source: "sidepanel",
      target: "background",
      command: { type: "prepare", startMode: "beginning" },
    });

    expect(reply).toEqual({
      ok: false,
      requestId: "panel-prepare-file",
      error: {
        code: "file-access-denied",
        message:
          "Local file access is off. Open Manage Extension, enable ‘Allow access to file URLs,’ reload this file, and try again.",
      },
    });
    expect(browser.fileAccess).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("opens the panel but does not inject into a file when local access is off", async () => {
    browser.fileAccess.mockResolvedValue(false);

    actionListener({
      id: 7,
      url: "file:///Users/example/company.md",
      active: true,
    } as chrome.tabs.Tab);

    await vi.waitFor(() =>
      expect(
        runtimeMessages.some(
          (message) =>
            message.type === "reader-state" &&
            message.snapshot.status === "error" &&
            message.snapshot.error?.code === "file-access-denied" &&
            message.snapshot.error.message.includes("Allow access to file URLs"),
        ),
      ).toBe(true),
    );
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("does not consult the file-access setting for ordinary webpages", async () => {
    browser.fileAccess.mockResolvedValue(false);

    const reply = await dispatch({
      type: "panel-command",
      requestId: "panel-prepare-web",
      source: "sidepanel",
      target: "background",
      command: { type: "prepare", startMode: "beginning" },
    });

    expect(reply.ok).toBe(true);
    expect(browser.fileAccess).not.toHaveBeenCalled();
    expect(contentMessages.some((message) => message.command.type === "prepare")).toBe(true);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("injects the Mermaid runtime only when the content script reports a pending diagram", async () => {
    browser.needsMermaid = true;

    const reply = await dispatch({
      type: "panel-command",
      requestId: "panel-prepare-mermaid",
      source: "sidepanel",
      target: "background",
      command: { type: "prepare", startMode: "beginning" },
    });

    expect(reply.ok).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["mermaid.js"],
      world: "ISOLATED",
    });
  });

  it("lets file injection report its normal result when the access API is unavailable", async () => {
    browser.tabsQuery.mockResolvedValue([
      { id: 7, url: "file:///Users/example/company.md", active: true } as chrome.tabs.Tab,
    ]);
    delete (chrome as unknown as { extension?: unknown }).extension;

    const reply = await dispatch({
      type: "panel-command",
      requestId: "panel-prepare-file-no-api",
      source: "sidepanel",
      target: "background",
      command: { type: "prepare", startMode: "beginning" },
    });

    expect(reply.ok).toBe(true);
    expect(contentMessages.some((message) => message.command.type === "prepare")).toBe(true);
  });
});
