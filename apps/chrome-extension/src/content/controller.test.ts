import type {
  ContentCommand,
  ContentResponse,
  ExtensionMessage,
  MessageReply,
} from "@vibe-tts/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContentController,
  mutationTouchesIndexedContent,
  samePageIgnoringHash,
  sentenceIndexForDOMPoint,
} from "./controller";
import { extractReadingDocument } from "./extractor";
import { MARKDOWN_READ_FROM_BLOCK_EVENT } from "./markdown-gutter";
import { MARKDOWN_VIEW_CHANGED_EVENT, renderMarkdownReadingView } from "./markdown-view";

type ContentListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageReply<ContentResponse>) => void,
) => boolean | undefined;

class FakeHighlight {
  constructor(..._ranges: Range[]) {}
}

function articleFixture(): Text {
  document.documentElement.innerHTML =
    "<head></head><body><article><p>Alpha one. Beta two. Gamma three.</p></article><aside></aside></body>";
  const text = document.querySelector("p")?.firstChild;
  if (!(text instanceof Text)) throw new Error("Fixture text was not created.");
  return text;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "contentType");
  document.documentElement.removeAttribute("data-vibe-tts-markdown-view");
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("content lifecycle helpers", () => {
  it("ignores hash-only URL changes while detecting meaningful route changes", () => {
    expect(
      samePageIgnoringHash(
        "https://example.test/article#introduction",
        "https://example.test/article#details",
      ),
    ).toBe(true);
    expect(
      samePageIgnoringHash(
        "https://example.test/article?page=1#details",
        "https://example.test/article?page=2#details",
      ),
    ).toBe(false);
  });

  it("maps a DOM caret to the exact indexed sentence", () => {
    const text = articleFixture();
    const extraction = extractReadingDocument();

    expect(sentenceIndexForDOMPoint(extraction, text, text.data.indexOf("Beta"))).toBe(1);
    expect(
      sentenceIndexForDOMPoint(extraction, document.querySelector("aside")!, 0),
    ).toBeUndefined();
  });

  it("maps a raw Markdown caret past earlier blocks sharing the same pre text node", () => {
    document.documentElement.innerHTML =
      "<head></head><body><pre># Heading\n\nFirst sentence.\n\n## Later\n\nTarget sentence.</pre></body>";
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });

    try {
      const text = document.querySelector("pre")?.firstChild;
      expect(text).toBeInstanceOf(Text);
      const extraction = extractReadingDocument();
      const targetOffset = (text as Text).data.indexOf("Target");

      expect(sentenceIndexForDOMPoint(extraction, text as Text, targetOffset)).toBe(3);
    } finally {
      Reflect.deleteProperty(document, "contentType");
    }
  });

  it("distinguishes indexed text mutations from unrelated page chrome", () => {
    const text = articleFixture();
    const extraction = extractReadingDocument();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    document.querySelector("aside")?.append(document.createElement("button"));
    text.data = text.data.replace("Beta", "Delta");
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(records.map((record) => mutationTouchesIndexedContent(record, extraction))).toEqual([
      false,
      true,
    ]);
  });

  it("ignores renderer mutations inside an explicitly narration-skipped figure", () => {
    document.documentElement.innerHTML = `<head></head><body><main><ul><li>Readable item.
      <figure data-vibe-tts-narration-skip="true"><aside>Rendering diagram…</aside></figure>
    </li></ul></main></body>`;
    const extraction = extractReadingDocument();
    const status = document.querySelector("figure aside");
    if (!status) throw new Error("Expected a diagram status");
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    status.textContent = "Mermaid diagram";
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(records).not.toHaveLength(0);
    expect(records.every((record) => !mutationTouchesIndexedContent(record, extraction))).toBe(
      true,
    );
  });
});

describe("rendered Markdown block starts", () => {
  it("prepares exact block starts, emits requests, and synchronizes gutter state", async () => {
    document.documentElement.innerHTML = `<head></head><body><pre># Document heading

Paragraph first sentence. Paragraph second sentence.

Detached target sentence.
</pre></body>`;
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });
    expect(renderMarkdownReadingView()).toBe(true);
    const hiddenTarget = document.createElement("p");
    hiddenTarget.hidden = true;
    hiddenTarget.dataset.vibeTtsReadBlock = "md-hidden";
    hiddenTarget.textContent = "Hidden target sentence.";
    document.querySelector("#vibe-tts-markdown-reader")?.append(hiddenTarget);

    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    let listener: ContentListener | undefined;
    const sendMessage = vi.fn((_message: unknown) => Promise.resolve({ ok: true }));
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: { addListener: (candidate: ContentListener) => (listener = candidate) },
        sendMessage,
      },
    });

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const controller = new ContentController();
    controller.start();

    const request = (command: ContentCommand): MessageReply<ContentResponse> => {
      const message: Extract<ExtensionMessage, { type: "content-command" }> = {
        type: "content-command",
        requestId: `block-${command.type}`,
        source: "background",
        target: "content",
        command,
      };
      let response: MessageReply<ContentResponse> | undefined;
      listener?.(message, {}, (reply) => (response = reply));
      if (!response) throw new Error("Content listener did not reply.");
      return response;
    };

    const prepared = (
      blockKey: string,
    ): Extract<ContentResponse, { ok: true; type: "prepared" }> => {
      const reply = request({ type: "prepare-from-block", blockKey });
      expect(reply.ok).toBe(true);
      expect(reply.data).toMatchObject({ ok: true, type: "prepared" });
      return reply.data as Extract<ContentResponse, { ok: true; type: "prepared" }>;
    };

    const unavailable = (blockKey: string): void => {
      const reply = request({ type: "prepare-from-block", blockKey });
      expect(reply.ok).toBe(true);
      expect(reply.data).toMatchObject({
        ok: false,
        type: "error",
        code: "block-unavailable",
      });
    };

    try {
      expect(prepared("md-0").startSentenceIndex).toBe(0);
      const paragraphStart = prepared("md-1");
      expect(paragraphStart.startSentenceIndex).toBe(1);
      expect(paragraphStart.document.blocks[1]?.sentences).toHaveLength(2);
      expect(paragraphStart.document.blocks[1]?.sentences[0]?.text).toBe(
        "Paragraph first sentence.",
      );

      unavailable("md-missing");
      unavailable("md-hidden");
      document.querySelector("[data-vibe-tts-read-block='md-2']")?.remove();
      unavailable("md-2");

      sendMessage.mockClear();
      window.dispatchEvent(
        new CustomEvent(MARKDOWN_READ_FROM_BLOCK_EVENT, {
          detail: { blockKey: "md-1" },
        }),
      );
      await Promise.resolve();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        type: "read-from-block",
        source: "content",
        target: "background",
        blockKey: "md-1",
        url: location.href,
      });

      const paragraphSentence = paragraphStart.document.blocks[1]?.sentences[0];
      expect(paragraphSentence).toBeDefined();
      request({
        type: "highlight",
        blockId: paragraphSentence?.blockId ?? "",
        sentenceId: paragraphSentence?.id ?? "",
      });
      const gutterButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".vibe-md-read-from-here"),
      );
      const headingButton = gutterButtons.find((button) =>
        button.getAttribute("aria-label")?.includes("Document heading"),
      );
      const paragraphButton = gutterButtons.find((button) =>
        button.getAttribute("aria-label")?.includes("Paragraph first sentence"),
      );
      expect(headingButton?.dataset.vibeTtsReadState).toBe("idle");
      expect(paragraphButton?.dataset.vibeTtsReadState).toBe("active");
      expect(highlights.size).toBeGreaterThan(0);

      sendMessage.mockClear();
      window.dispatchEvent(new Event(MARKDOWN_VIEW_CHANGED_EVENT));
      expect(paragraphButton?.dataset.vibeTtsReadState).toBe("idle");
      expect(highlights.size).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        type: "page-invalidated",
        reason: "view-mode-changed",
      });
    } finally {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    }
  });
});

describe("content controller session memory", () => {
  it("restores a clipped selection and invalidates only when indexed content mutates", async () => {
    vi.useFakeTimers();
    const text = articleFixture();
    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    let listener: ContentListener | undefined;
    const sendMessage = vi.fn((_message: unknown) => Promise.resolve({ ok: true }));
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: { addListener: (candidate: ContentListener) => (listener = candidate) },
        sendMessage,
      },
    });

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const controller = new ContentController();
    controller.start();

    const request = (command: ContentCommand): MessageReply<ContentResponse> => {
      const message: Extract<ExtensionMessage, { type: "content-command" }> = {
        type: "content-command",
        requestId: `test-${command.type}`,
        source: "background",
        target: "content",
        command,
      };
      let response: MessageReply<ContentResponse> | undefined;
      listener?.(message, {}, (reply) => (response = reply));
      if (!response) throw new Error("Content listener did not reply.");
      return response;
    };

    try {
      expect(request({ type: "ping" }).data).toEqual({
        ok: true,
        type: "pong",
        needsMermaid: false,
      });
      const pendingDiagram = document.createElement("figure");
      pendingDiagram.className = "vibe-md-mermaid";
      pendingDiagram.dataset.vibeTtsMermaidState = "pending";
      document.body.append(pendingDiagram);
      expect(request({ type: "ping" }).data).toEqual({
        ok: true,
        type: "pong",
        needsMermaid: true,
      });
      pendingDiagram.remove();

      request({ type: "set-auto-scroll", enabled: false });
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(text, text.data.indexOf("one"));
      range.setEnd(text, text.length);
      selection?.removeAllRanges();
      selection?.addRange(range);

      const prepared = request({ type: "prepare", startMode: "selection" });
      expect(prepared.ok).toBe(true);
      const preparedData = prepared.data as Extract<ContentResponse, { type: "prepared" }>;
      const secondSentence = preparedData.document.blocks[0]?.sentences[1];
      expect(secondSentence).toBeDefined();

      request({
        type: "highlight",
        blockId: secondSentence?.blockId ?? "",
        sentenceId: secondSentence?.id ?? "",
      });
      request({ type: "clear-highlights" });
      const restored = request({
        type: "prepare",
        startMode: "here",
        restoreSession: "current",
      });
      const restoredData = restored.data as Extract<ContentResponse, { type: "prepared" }>;
      expect(restoredData.selection?.startOffset).toBe(secondSentence?.startOffset);
      expect(restoredData.selection?.endOffset).toBe(preparedData.selection?.endOffset);

      Object.defineProperty(document, "caretPositionFromPoint", {
        configurable: true,
        value: () => ({ offsetNode: text, offset: text.data.indexOf("Gamma") }),
      });
      const fromHere = request({ type: "find-here", clientX: 10, clientY: 10 });
      expect(
        (fromHere.data as Extract<ContentResponse, { type: "prepared" }>).startSentenceIndex,
      ).toBe(2);

      request({
        type: "highlight",
        blockId: secondSentence?.blockId ?? "",
        sentenceId: secondSentence?.id ?? "",
      });
      expect(highlights.size).toBeGreaterThan(0);
      sendMessage.mockClear();
      window.dispatchEvent(new Event(MARKDOWN_VIEW_CHANGED_EVENT));
      expect(highlights.size).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        type: "page-invalidated",
        reason: "view-mode-changed",
      });

      window.dispatchEvent(new Event(MARKDOWN_VIEW_CHANGED_EVENT));
      expect(sendMessage).toHaveBeenCalledTimes(1);

      request({ type: "prepare", startMode: "beginning" });
      sendMessage.mockClear();
      document.querySelector("aside")?.append(document.createElement("button"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(sendMessage).not.toHaveBeenCalled();

      text.data = text.data.replace("Gamma", "Omega");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        type: "page-invalidated",
        reason: "indexed-content-mutated",
      });
    } finally {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    }
  });
});
