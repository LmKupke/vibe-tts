import type { ReadingWord } from "@vibe-tts/shared";

import type { BlockDOMMap, ExtractedReadingDocument } from "./extractor";

const SENTENCE_HIGHLIGHT = "reader-current-sentence";
const WORD_HIGHLIGHT = "reader-current-word";
const STYLE_ID = "vibe-tts-highlight-styles";
const FALLBACK_ID = "vibe-tts-highlight-overlay";

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

type HighlightConstructorLike = new (...ranges: Range[]) => unknown;

interface HighlightPosition {
  wordId?: string;
  sourceStart?: number;
  sourceEnd?: number;
  wordStart?: number;
  wordEnd?: number;
}

function highlightAPI():
  { registry: HighlightRegistryLike; HighlightConstructor: HighlightConstructorLike } | undefined {
  const css = CSS as typeof CSS & { highlights?: HighlightRegistryLike };
  const constructor = (globalThis as typeof globalThis & { Highlight?: HighlightConstructorLike })
    .Highlight;
  return css.highlights && constructor
    ? { registry: css.highlights, HighlightConstructor: constructor }
    : undefined;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    ::highlight(${SENTENCE_HIGHLIGHT}) {
      background-color: rgba(255, 215, 77, 0.34);
      text-decoration: underline solid rgba(122, 86, 0, 0.62) 1px;
      text-underline-offset: 0.17em;
    }
    ::highlight(${WORD_HIGHLIGHT}) {
      background-color: rgba(255, 176, 0, 0.82);
      color: #17120a;
      text-decoration: underline solid #5e3a00 2px;
      text-underline-offset: 0.17em;
    }
    @media (forced-colors: active) {
      ::highlight(${SENTENCE_HIGHLIGHT}) { text-decoration: underline 2px; }
      ::highlight(${WORD_HIGHLIGHT}) { text-decoration: underline 4px; }
    }
  `;
  (document.head ?? document.documentElement).append(style);
}

class ScrollPolicy {
  #enabled = true;
  #manualUntil = 0;
  #programmaticUntil = 0;

  constructor() {
    const noteManualIntent = (): void => {
      if (performance.now() > this.#programmaticUntil)
        this.#manualUntil = performance.now() + 8_000;
    };
    window.addEventListener("wheel", noteManualIntent, { passive: true });
    window.addEventListener("touchstart", noteManualIntent, { passive: true });
    window.addEventListener("scroll", noteManualIntent, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "].includes(event.key)) {
        noteManualIntent();
      }
    });
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  reveal(range: Range): void {
    if (!this.#enabled || performance.now() < this.#manualUntil) return;
    const rect = range.getBoundingClientRect();
    const comfortableTop = window.innerHeight * 0.18;
    const comfortableBottom = window.innerHeight * 0.82;
    if (rect.top >= comfortableTop && rect.bottom <= comfortableBottom) return;
    const element =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : (range.startContainer as Element);
    if (!element) return;
    this.#programmaticUntil = performance.now() + 1_500;
    if (element.matches("body > pre:only-child")) {
      window.scrollBy({
        behavior: "smooth",
        left: 0,
        top: rect.top + rect.height / 2 - window.innerHeight / 2,
      });
      return;
    }
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }
}

export class PageHighlighter {
  readonly #scroll = new ScrollPolicy();
  #extraction: ExtractedReadingDocument | undefined;
  #lastSentenceId: string | undefined;

  setDocument(extraction: ExtractedReadingDocument): void {
    this.clear();
    this.#extraction = extraction;
    installStyles();
  }

  setAutoScroll(enabled: boolean): void {
    this.#scroll.setEnabled(enabled);
  }

  show(blockId: string, sentenceId: string, position: HighlightPosition = {}): boolean {
    const blockMap = this.#extraction?.blockMaps.get(blockId);
    const sentence = blockMap?.sentences.get(sentenceId);
    if (!blockMap || !sentence) return false;

    const sentenceStart = this.#boundedOffset(
      position.sourceStart,
      sentence.startOffset,
      sentence.endOffset,
      sentence.startOffset,
    );
    const sentenceEnd = this.#boundedOffset(
      position.sourceEnd,
      sentenceStart,
      sentence.endOffset,
      sentence.endOffset,
    );
    const sentenceRange = blockMap.normalized.rangeForOffsets(sentenceStart, sentenceEnd);
    if (!sentenceRange) return false;
    const word = position.wordId
      ? sentence.words.find((candidate) => candidate.id === position.wordId)
      : undefined;
    const exactWordRange = this.#rangeForExactSpan(
      blockMap,
      sentence.startOffset,
      sentence.endOffset,
      position,
    );
    const wordRange =
      exactWordRange ?? (word ? this.#rangeForWord(blockMap, word, position) : undefined);
    const api = highlightAPI();

    if (api) {
      api.registry.set(SENTENCE_HIGHLIGHT, new api.HighlightConstructor(sentenceRange));
      if (wordRange) {
        api.registry.set(WORD_HIGHLIGHT, new api.HighlightConstructor(wordRange));
      } else {
        api.registry.delete(WORD_HIGHLIGHT);
      }
      this.#removeFallback();
    } else {
      this.#paintFallback(sentenceRange, wordRange);
    }

    if (sentenceId !== this.#lastSentenceId) {
      this.#scroll.reveal(sentenceRange);
      this.#lastSentenceId = sentenceId;
    }
    return true;
  }

  clear(): void {
    const api = highlightAPI();
    api?.registry.delete(SENTENCE_HIGHLIGHT);
    api?.registry.delete(WORD_HIGHLIGHT);
    this.#removeFallback();
    this.#lastSentenceId = undefined;
  }

  #rangeForWord(
    blockMap: BlockDOMMap,
    word: ReadingWord,
    position: HighlightPosition,
  ): Range | undefined {
    const start = this.#boundedOffset(
      position.wordStart,
      word.startOffset,
      word.endOffset,
      word.startOffset,
    );
    const end = this.#boundedOffset(position.wordEnd, start, word.endOffset, word.endOffset);
    return blockMap.normalized.rangeForOffsets(start, end);
  }

  #rangeForExactSpan(
    blockMap: BlockDOMMap,
    sentenceStart: number,
    sentenceEnd: number,
    position: HighlightPosition,
  ): Range | undefined {
    if (position.wordStart === undefined || position.wordEnd === undefined) return undefined;
    if (
      !Number.isInteger(position.wordStart) ||
      !Number.isInteger(position.wordEnd) ||
      position.wordStart < sentenceStart ||
      position.wordEnd > sentenceEnd ||
      position.wordStart >= position.wordEnd
    ) {
      return undefined;
    }
    return blockMap.normalized.rangeForOffsets(position.wordStart, position.wordEnd);
  }

  #boundedOffset(value: number | undefined, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  }

  #paintFallback(sentenceRange: Range, wordRange?: Range): void {
    this.#removeFallback();
    const layer = document.createElement("div");
    layer.id = FALLBACK_ID;
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
    });

    this.#appendRects(layer, sentenceRange, "rgba(255, 215, 77, 0.34)", "1px solid #8b6500");
    if (wordRange) {
      this.#appendRects(layer, wordRange, "rgba(255, 176, 0, 0.72)", "2px solid #5e3a00");
    }
    document.documentElement.append(layer);
  }

  #appendRects(layer: HTMLElement, range: Range, background: string, borderBottom: string): void {
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const marker = document.createElement("span");
      Object.assign(marker.style, {
        position: "absolute",
        left: `${rect.left + window.scrollX}px`,
        top: `${rect.top + window.scrollY}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        background,
        borderBottom,
        boxSizing: "border-box",
      });
      layer.append(marker);
    }
  }

  #removeFallback(): void {
    document.getElementById(FALLBACK_ID)?.remove();
  }
}
