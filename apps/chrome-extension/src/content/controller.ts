import {
  createRequestId,
  isExtensionMessage,
  type ContentResponse,
  type ExtensionMessage,
  type MessageReply,
  type ReadingSelection,
  type ReaderStartMode,
} from "@vibe-tts/shared";

import { extractReadingDocument, type ExtractedReadingDocument } from "./extractor";
import { PageHighlighter } from "./highlighter";
import {
  MARKDOWN_READ_FROM_BLOCK_EVENT,
  clearMarkdownReadControlStates,
  markdownReadTarget,
  setMarkdownReadActiveElement,
  setMarkdownReadControlState,
  type MarkdownReadFromBlockDetail,
} from "./markdown-gutter";
import { MARKDOWN_VIEW_CHANGED_EVENT } from "./markdown-view";
import { hasPendingMermaidDiagrams } from "./mermaid";
import { firstSentenceIndexForSelection, mapSelectionToDocument } from "./selection";

interface DOMPoint {
  node: Node;
  offset: number;
}

export function samePageIgnoringHash(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left.split("#", 1)[0] === right.split("#", 1)[0];
  }
}

function nodeInsideBlock(node: Node, block: Element): boolean {
  return node === block || block.contains(node);
}

function changedNodeTouchesBlock(node: Node, block: Element): boolean {
  return nodeInsideBlock(node, block) || node.contains(block);
}

function nodeIsNarrationSkipped(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-vibe-tts-narration-skip='true']") !== null;
}

export function mutationTouchesIndexedContent(
  mutation: MutationRecord,
  extraction: ExtractedReadingDocument,
): boolean {
  if (nodeIsNarrationSkipped(mutation.target)) return false;
  for (const blockMap of extraction.blockMaps.values()) {
    if (nodeInsideBlock(mutation.target, blockMap.element)) return true;
    if (mutation.type !== "childList") continue;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (changedNodes.some((node) => changedNodeTouchesBlock(node, blockMap.element))) return true;
  }
  return false;
}

function textPoint(node: Node, offset: number): DOMPoint | undefined {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  const child = node.childNodes[Math.min(Math.max(0, offset), node.childNodes.length - 1)];
  if (!child) return undefined;
  const walker = child.ownerDocument?.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  const text = walker?.nextNode();
  return text instanceof Text ? { node: text, offset: 0 } : undefined;
}

export function sentenceIndexForDOMPoint(
  extraction: ExtractedReadingDocument,
  node: Node,
  rawOffset: number,
): number | undefined {
  const point = textPoint(node, rawOffset);
  if (!point) return undefined;
  let sentenceIndex = 0;
  for (const blockId of extraction.orderedBlockIds) {
    const block = extraction.document.blocks.find((candidate) => candidate.id === blockId);
    const blockMap = extraction.blockMaps.get(blockId);
    if (!block || !blockMap) continue;
    if (!blockMap.normalized.containsNode(point.node)) {
      sentenceIndex += block.sentences.length;
      continue;
    }
    const offset = blockMap.normalized.normalizedOffsetForPoint(point.node, point.offset, "start");
    // Raw Markdown blocks share one <pre> text node. A source point can therefore
    // belong to the node while still falling outside this particular block.
    if (offset === undefined) {
      sentenceIndex += block.sentences.length;
      continue;
    }
    const localIndex = block.sentences.findIndex(
      (sentence) => offset >= sentence.startOffset && offset < sentence.endOffset,
    );
    if (localIndex >= 0) return sentenceIndex + localIndex;
    const followingIndex = block.sentences.findIndex((sentence) => sentence.startOffset >= offset);
    return sentenceIndex + (followingIndex >= 0 ? followingIndex : block.sentences.length - 1);
  }
  return undefined;
}

const controllerState: { active?: ContentController } = {};

export class ContentController {
  readonly #highlighter = new PageHighlighter();
  #extraction: ExtractedReadingDocument | undefined;
  #dirty = true;
  #url = location.href;
  #mutationTimer: number | undefined;
  #resumeSentenceIndex = 0;
  #sessionSelection: ReadingSelection | undefined;
  #inlineReadRevision = 0;

  start(): void {
    controllerState.active = this;
    chrome.runtime.onMessage.addListener(this.#onMessage);
    window.addEventListener("popstate", this.#checkRoute);
    window.addEventListener("hashchange", this.#checkRoute);
    window.addEventListener(MARKDOWN_VIEW_CHANGED_EVENT, this.#handleMarkdownViewChange);
    window.addEventListener(MARKDOWN_READ_FROM_BLOCK_EVENT, this.#handleMarkdownReadFromBlock);
    this.#patchHistory();
    this.#observeMutations();
  }

  #handleMarkdownViewChange = (): void => {
    if (controllerState.active !== this) return;
    this.#invalidateContent("view-mode-changed");
  };

  #handleMarkdownReadFromBlock = (event: Event): void => {
    if (controllerState.active !== this) return;
    const detail = (event as CustomEvent<MarkdownReadFromBlockDetail>).detail;
    if (!detail || typeof detail.blockKey !== "string") return;
    const revision = ++this.#inlineReadRevision;
    setMarkdownReadControlState(document, detail.blockKey, "preparing");
    const message: ExtensionMessage = {
      type: "read-from-block",
      requestId: createRequestId("read-from-block"),
      source: "content",
      target: "background",
      blockKey: detail.blockKey,
      url: location.href,
    };
    void chrome.runtime
      .sendMessage(message)
      .then((reply: unknown) => {
        if (revision !== this.#inlineReadRevision) return;
        const accepted =
          typeof reply === "object" &&
          reply !== null &&
          (reply as Record<string, unknown>).ok === true;
        setMarkdownReadControlState(document, detail.blockKey, accepted ? "active" : "error");
      })
      .catch(() => {
        if (revision !== this.#inlineReadRevision) return;
        setMarkdownReadControlState(document, detail.blockKey, "error");
      });
  };

  #onMessage = (
    rawMessage: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageReply<ContentResponse>) => void,
  ): boolean | undefined => {
    if (controllerState.active !== this) return undefined;
    if (!isExtensionMessage(rawMessage) || rawMessage.target !== "content") return undefined;
    const message = rawMessage;
    sendResponse(this.#handleMessage(message));
    return true;
  };

  #handleMessage(message: ExtensionMessage): MessageReply<ContentResponse> {
    if (message.type !== "content-command") {
      return this.#error(
        message.requestId,
        "invalid-message",
        "Content script received the wrong message type.",
      );
    }
    const command = message.command;
    try {
      switch (command.type) {
        case "ping":
          return {
            ok: true,
            requestId: message.requestId,
            data: {
              ok: true,
              type: "pong",
              needsMermaid: hasPendingMermaidDiagrams(document),
            },
          };
        case "prepare":
          return {
            ok: true,
            requestId: message.requestId,
            data: this.#prepare(command.startMode, command.restoreSession),
          };
        case "prepare-from-block":
          return {
            ok: true,
            requestId: message.requestId,
            data: this.#prepareFromBlock(command.blockKey),
          };
        case "highlight": {
          this.#resumeSentenceIndex = this.#sentenceIndex(command.sentenceId);
          const shown = this.#highlighter.show(command.blockId, command.sentenceId, {
            ...(command.wordId === undefined ? {} : { wordId: command.wordId }),
            ...(command.sourceStart === undefined ? {} : { sourceStart: command.sourceStart }),
            ...(command.sourceEnd === undefined ? {} : { sourceEnd: command.sourceEnd }),
            ...(command.wordStart === undefined ? {} : { wordStart: command.wordStart }),
            ...(command.wordEnd === undefined ? {} : { wordEnd: command.wordEnd }),
          });
          if (shown) {
            setMarkdownReadActiveElement(
              document,
              this.#extraction?.blockMaps.get(command.blockId)?.element,
            );
          }
          return shown
            ? { ok: true, requestId: message.requestId, data: { ok: true, type: "ack" } }
            : this.#error(
                message.requestId,
                "stale-document",
                "The requested source range is no longer available.",
              );
        }
        case "clear-highlights":
          this.#highlighter.clear();
          this.#inlineReadRevision += 1;
          clearMarkdownReadControlStates(document);
          if (command.resetSession) {
            this.#resumeSentenceIndex = 0;
            this.#sessionSelection = undefined;
          }
          return { ok: true, requestId: message.requestId, data: { ok: true, type: "ack" } };
        case "set-auto-scroll":
          this.#highlighter.setAutoScroll(command.enabled);
          return { ok: true, requestId: message.requestId, data: { ok: true, type: "ack" } };
        case "find-here":
          return {
            ok: true,
            requestId: message.requestId,
            data: this.#prepareFromPoint(command.clientX, command.clientY),
          };
      }
    } catch (error) {
      return this.#error(
        message.requestId,
        "content-error",
        error instanceof Error ? error.message : "Unable to read this page.",
      );
    }
  }

  #prepare(startMode: ReaderStartMode, restoreSession?: "beginning" | "current"): ContentResponse {
    const extraction = this.#ensureExtraction();
    if (extraction.document.sentenceCount === 0) {
      return {
        ok: false,
        type: "error",
        code: "empty-document",
        message: "No readable article or page text was found.",
      };
    }
    const selection =
      startMode === "selection"
        ? mapSelectionToDocument(extraction)
        : restoreSession
          ? this.#selectionForRestoration(restoreSession)
          : undefined;
    if (startMode === "selection" && !selection) {
      return {
        ok: false,
        type: "error",
        code: "selection-unavailable",
        message: "Select readable text on the page, then try again.",
      };
    }
    if (startMode === "selection") {
      this.#sessionSelection = selection;
      this.#resumeSentenceIndex = firstSentenceIndexForSelection(extraction, selection);
    } else if (!restoreSession) {
      this.#sessionSelection = undefined;
    }
    const prepared: Extract<ContentResponse, { ok: true; type: "prepared" }> = {
      ok: true,
      type: "prepared",
      document: extraction.document,
      startSentenceIndex:
        startMode === "here"
          ? Math.min(this.#resumeSentenceIndex, extraction.document.sentenceCount - 1)
          : firstSentenceIndexForSelection(extraction, selection),
      ...(selection === undefined ? {} : { selection }),
    };
    return prepared;
  }

  #prepareFromPoint(clientX: number, clientY: number): ContentResponse {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return {
        ok: false,
        type: "error",
        code: "invalid-point",
        message: "Choose a readable point on the page.",
      };
    }
    const extraction = this.#ensureExtraction();
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    const fallbackRange = position ? undefined : document.caretRangeFromPoint?.(clientX, clientY);
    const point = position
      ? { node: position.offsetNode, offset: position.offset }
      : fallbackRange
        ? { node: fallbackRange.startContainer, offset: fallbackRange.startOffset }
        : undefined;
    const sentenceIndex = point
      ? sentenceIndexForDOMPoint(extraction, point.node, point.offset)
      : undefined;
    if (sentenceIndex === undefined) {
      return {
        ok: false,
        type: "error",
        code: "point-unavailable",
        message: "That point is outside the readable page content.",
      };
    }
    this.#resumeSentenceIndex = sentenceIndex;
    this.#sessionSelection = undefined;
    return this.#prepare("here");
  }

  #prepareFromBlock(blockKey: string): ContentResponse {
    const target = markdownReadTarget(document, blockKey);
    if (!target || !target.isConnected || target.closest("[hidden],[inert]")) {
      return this.#blockUnavailable();
    }
    const style = getComputedStyle(target);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.contentVisibility === "hidden"
    ) {
      return this.#blockUnavailable();
    }

    this.#ensureExtraction();
    const extraction = this.#extraction;
    const blockMap = extraction
      ? Array.from(extraction.blockMaps.values()).find((candidate) => candidate.element === target)
      : undefined;
    if (!extraction || !blockMap) return this.#blockUnavailable();

    let sentenceIndex = 0;
    for (const block of extraction.document.blocks) {
      if (block.id === blockMap.blockId) {
        this.#resumeSentenceIndex = sentenceIndex;
        this.#sessionSelection = undefined;
        return this.#prepare("here");
      }
      sentenceIndex += block.sentences.length;
    }
    return this.#blockUnavailable();
  }

  #blockUnavailable(): ContentResponse {
    return {
      ok: false,
      type: "error",
      code: "block-unavailable",
      message: "That section is no longer available. Choose it again.",
    };
  }

  #ensureExtraction(): ExtractedReadingDocument {
    if (!this.#extraction || this.#dirty) {
      this.#extraction = extractReadingDocument();
      this.#dirty = false;
      this.#sessionSelection = undefined;
      this.#highlighter.setDocument(this.#extraction);
    }
    return this.#extraction;
  }

  #selectionForRestoration(mode: "beginning" | "current"): ReadingSelection | undefined {
    const original = this.#sessionSelection;
    const extraction = this.#extraction;
    if (!original || !extraction || mode === "beginning") return original;
    let sentenceIndex = 0;
    for (const block of extraction.document.blocks) {
      for (const sentence of block.sentences) {
        if (sentenceIndex === this.#resumeSentenceIndex) {
          const startBlockIndex = extraction.orderedBlockIds.indexOf(original.startBlockId);
          const endBlockIndex = extraction.orderedBlockIds.indexOf(original.endBlockId);
          const currentBlockIndex = extraction.orderedBlockIds.indexOf(block.id);
          if (
            startBlockIndex < 0 ||
            endBlockIndex < startBlockIndex ||
            currentBlockIndex < startBlockIndex ||
            currentBlockIndex > endBlockIndex
          ) {
            return original;
          }
          const startOffset =
            block.id === original.startBlockId
              ? Math.max(original.startOffset, sentence.startOffset)
              : sentence.startOffset;
          if (block.id === original.endBlockId && startOffset >= original.endOffset)
            return original;
          return {
            ...original,
            startBlockId: block.id,
            startOffset,
          };
        }
        sentenceIndex += 1;
      }
    }
    return original;
  }

  #sentenceIndex(sentenceId: string): number {
    if (!this.#extraction) return 0;
    let index = 0;
    for (const block of this.#extraction.document.blocks) {
      for (const sentence of block.sentences) {
        if (sentence.id === sentenceId) return index;
        index += 1;
      }
    }
    return this.#resumeSentenceIndex;
  }

  #error(requestId: string, code: string, message: string): MessageReply<ContentResponse> {
    return { ok: false, requestId, error: { code, message } };
  }

  #observeMutations(): void {
    const observer = new MutationObserver((mutations) => {
      if (controllerState.active !== this) return;
      const extraction = this.#extraction;
      if (!extraction) return;
      const meaningful = mutations.some((mutation) =>
        mutationTouchesIndexedContent(mutation, extraction),
      );
      if (!meaningful) return;
      window.clearTimeout(this.#mutationTimer);
      this.#mutationTimer = window.setTimeout(() => {
        if (controllerState.active !== this) return;
        this.#invalidateContent("indexed-content-mutated");
      }, 400);
    });
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  #invalidateContent(
    reason: Extract<ExtensionMessage, { type: "page-invalidated" }>["reason"],
  ): void {
    const hadExtraction = this.#extraction !== undefined;
    window.clearTimeout(this.#mutationTimer);
    this.#mutationTimer = undefined;
    this.#dirty = true;
    this.#extraction = undefined;
    this.#resumeSentenceIndex = 0;
    this.#sessionSelection = undefined;
    this.#highlighter.clear();
    this.#inlineReadRevision += 1;
    clearMarkdownReadControlStates(document);
    if (!hadExtraction) return;
    const message: ExtensionMessage = {
      type: "page-invalidated",
      requestId: createRequestId("content-invalidated"),
      source: "content",
      target: "background",
      url: location.href,
      reason,
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  #patchHistory(): void {
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history) as (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ) => void;
      history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
        original(data, unused, url);
        queueMicrotask(this.#checkRoute);
      }) as History[typeof method];
    }
  }

  #checkRoute = (): void => {
    if (controllerState.active !== this) return;
    if (samePageIgnoringHash(location.href, this.#url)) {
      this.#url = location.href;
      return;
    }
    this.#url = location.href;
    window.clearTimeout(this.#mutationTimer);
    this.#dirty = true;
    this.#extraction = undefined;
    this.#resumeSentenceIndex = 0;
    this.#sessionSelection = undefined;
    this.#highlighter.clear();
    this.#inlineReadRevision += 1;
    clearMarkdownReadControlStates(document);
    const message: ExtensionMessage = {
      type: "page-changed",
      requestId: createRequestId("route"),
      source: "content",
      target: "background",
      url: location.href,
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  };
}
