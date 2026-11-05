import {
  createRequestId,
  isExtensionMessage,
  type CatalogSnapshot,
  type ExtensionMessage,
  type MessageReply,
  type OffscreenCommand,
  type ReaderSnapshot,
} from "@vibe-tts/shared";

import {
  type HighlightUpdate,
  type OffscreenEventSink,
  type ReaderController,
} from "./reader-controller";

export interface OffscreenCommandHandler {
  handle(command: OffscreenCommand): Promise<ReaderSnapshot | CatalogSnapshot>;
}

type OffscreenReply = MessageReply<ReaderSnapshot | CatalogSnapshot>;

export function createOffscreenMessageListener(
  handler: OffscreenCommandHandler,
): (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: OffscreenReply) => void,
) => boolean | undefined {
  return (rawMessage, _sender, sendResponse) => {
    if (
      !isExtensionMessage(rawMessage) ||
      rawMessage.target !== "offscreen" ||
      rawMessage.type !== "offscreen-command"
    ) {
      return undefined;
    }
    const message = rawMessage;
    void handler.handle(message.command).then(
      (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          requestId: message.requestId,
          error: {
            code: "offscreen-command-failed",
            message: error instanceof Error ? error.message : "The playback command failed.",
          },
        }),
    );
    // Chrome 120 requires true here to keep the callback channel open.
    return true;
  };
}

function sendEvent(message: ExtensionMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function stateEvent(snapshot: ReaderSnapshot, tabId: number | undefined): ExtensionMessage {
  return {
    type: "reader-state",
    requestId: createRequestId("state"),
    source: "offscreen",
    target: "background",
    snapshot,
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function highlightEvent(update: HighlightUpdate): ExtensionMessage {
  return {
    type: "highlight-update",
    requestId: createRequestId("highlight"),
    source: "offscreen",
    target: "background",
    tabId: update.tabId,
    ...(update.blockId ? { blockId: update.blockId } : {}),
    ...(update.sentenceId ? { sentenceId: update.sentenceId } : {}),
    ...(update.wordId ? { wordId: update.wordId } : {}),
    ...(update.sourceStart === undefined ? {} : { sourceStart: update.sourceStart }),
    ...(update.sourceEnd === undefined ? {} : { sourceEnd: update.sourceEnd }),
    ...(update.wordStart === undefined ? {} : { wordStart: update.wordStart }),
    ...(update.wordEnd === undefined ? {} : { wordEnd: update.wordEnd }),
    ...(update.clear === undefined ? {} : { clear: update.clear }),
  };
}

export function createChromeEventSink(): OffscreenEventSink {
  return {
    onState: (snapshot, tabId) => sendEvent(stateEvent(snapshot, tabId)),
    onHighlight: (update) => sendEvent(highlightEvent(update)),
    onCatalog: (catalog) =>
      sendEvent({
        type: "catalog-update",
        requestId: createRequestId("catalog"),
        source: "offscreen",
        target: "background",
        catalog,
      }),
  };
}

export function installOffscreenRuntime(controller: ReaderController): () => void {
  const listener = createOffscreenMessageListener(controller);
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
