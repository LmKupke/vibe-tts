import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeElementText, TextNodeRegistry } from "./dom-map";
import { extractReadingDocument, type ExtractedReadingDocument } from "./extractor";
import { PageHighlighter } from "./highlighter";
import { segmentBlock } from "./segmentation";

class FakeHighlight {
  readonly ranges: Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function singleBlockExtraction(element: Element): ExtractedReadingDocument {
  const registry = new TextNodeRegistry();
  const normalized = normalizeElementText(element, registry);
  const sentences = segmentBlock("block-0", normalized.text);
  const block = {
    id: "block-0",
    type: "other" as const,
    text: normalized.text,
    sentences,
  };
  return {
    document: {
      id: "document-test",
      version: 1,
      url: "file:///tmp/reader.md",
      blocks: [block],
      sentenceCount: sentences.length,
      wordCount: sentences.reduce((total, sentence) => total + sentence.words.length, 0),
    },
    registry,
    blockMaps: new Map([
      [
        block.id,
        {
          blockId: block.id,
          element,
          normalized,
          sentences: new Map(sentences.map((sentence) => [sentence.id, sentence])),
        },
      ],
    ]),
    orderedBlockIds: [block.id],
  };
}

afterEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  vi.unstubAllGlobals();
});

describe("page highlighting", () => {
  it("sets and clears cached sentence and word ranges", () => {
    document.body.innerHTML = "<article><p>Read this sentence now.</p></article>";
    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    const extraction = extractReadingDocument();
    const sentence = extraction.document.blocks[0]?.sentences[0];
    const word = sentence?.words[1];
    expect(sentence).toBeDefined();
    expect(word).toBeDefined();

    const highlighter = new PageHighlighter();
    highlighter.setDocument(extraction);
    highlighter.setAutoScroll(false);
    expect(
      highlighter.show(sentence?.blockId ?? "", sentence?.id ?? "", { wordId: word?.id ?? "" }),
    ).toBe(true);
    expect(highlights.get("reader-current-sentence")?.ranges[0]?.toString()).toBe(
      "Read this sentence now.",
    );
    expect(highlights.get("reader-current-word")?.ranges[0]?.toString()).toBe("this");

    highlighter.clear();
    expect(highlights.size).toBe(0);
  });

  it("paints exact clipped selection spans instead of the full edge sentence and word", () => {
    document.body.innerHTML = "<article><p>Read this sentence now.</p></article>";
    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    const extraction = extractReadingDocument();
    const sentence = extraction.document.blocks[0]?.sentences[0];
    const word = sentence?.words[1];
    const highlighter = new PageHighlighter();
    highlighter.setDocument(extraction);
    highlighter.setAutoScroll(false);

    expect(
      highlighter.show(sentence?.blockId ?? "", sentence?.id ?? "", {
        wordId: word?.id ?? "",
        sourceStart: 6,
        sourceEnd: 17,
        wordStart: 6,
        wordEnd: 8,
      }),
    ).toBe(true);
    expect(highlights.get("reader-current-sentence")?.ranges[0]?.toString()).toBe("his sentenc");
    expect(highlights.get("reader-current-word")?.ranges[0]?.toString()).toBe("hi");
  });

  it("paints a verified timed span even when it crosses segmented word boundaries", () => {
    document.body.innerHTML = "<article><p>Read these words together.</p></article>";
    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    const extraction = extractReadingDocument();
    const sentence = extraction.document.blocks[0]?.sentences[0];
    const highlighter = new PageHighlighter();
    highlighter.setDocument(extraction);
    highlighter.setAutoScroll(false);

    expect(
      highlighter.show(sentence?.blockId ?? "", sentence?.id ?? "", {
        wordStart: 5,
        wordEnd: 16,
      }),
    ).toBe(true);
    expect(highlights.get("reader-current-word")?.ranges[0]?.toString()).toBe("these words");
  });

  it("reveals a range inside a document-sized raw pre without scrolling the whole pre", () => {
    document.body.innerHTML = "<pre>First sentence. The target sentence is far below.</pre>";
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();

    const highlights = new Map<string, FakeHighlight>();
    Object.defineProperty(CSS, "highlights", { configurable: true, value: highlights });
    vi.stubGlobal("Highlight", FakeHighlight);

    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    const scrollByDescriptor = Object.getOwnPropertyDescriptor(window, "scrollBy");
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    const scrollBy = vi.fn();
    const scrollIntoView = vi.fn();
    const rect = {
      bottom: 1_220,
      height: 20,
      left: 0,
      right: 200,
      top: 1_200,
      width: 200,
      x: 0,
      y: 1_200,
      toJSON: () => ({}),
    } as DOMRect;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect,
    });
    Object.defineProperty(window, "scrollBy", { configurable: true, value: scrollBy });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const extraction = singleBlockExtraction(pre as HTMLPreElement);
      const sentence = extraction.document.blocks[0]?.sentences[1];
      expect(sentence).toBeDefined();

      const highlighter = new PageHighlighter();
      highlighter.setDocument(extraction);
      expect(highlighter.show("block-0", sentence?.id ?? "")).toBe(true);

      expect(scrollBy).toHaveBeenCalledWith({
        behavior: "smooth",
        left: 0,
        top: rect.top + rect.height / 2 - window.innerHeight / 2,
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRectDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
      if (scrollByDescriptor) {
        Object.defineProperty(window, "scrollBy", scrollByDescriptor);
      } else {
        Reflect.deleteProperty(window, "scrollBy");
      }
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });
});
