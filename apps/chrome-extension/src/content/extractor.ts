import type {
  ReadingBlock,
  ReadingBlockType,
  ReadingDocument,
  ReadingSentence,
} from "@vibe-tts/shared";

import { normalizeElementText, TextNodeRegistry, type NormalizedDOMText } from "./dom-map";
import { extractRawMarkdownBlocks } from "./markdown";
import { segmentBlock } from "./segmentation";

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,blockquote,li,th,td";
const ROOT_SELECTOR = "article,main,[role='main']";
const EXCLUDED_SELECTOR =
  "nav,header,footer,aside,form,button,script,style,noscript,template,[aria-hidden='true'],[hidden],[inert],[data-vibe-tts-narration-skip='true']";

export interface BlockDOMMap {
  blockId: string;
  element: Element;
  normalized: NormalizedDOMText;
  sentences: Map<string, ReadingSentence>;
}

export interface ExtractedReadingDocument {
  document: ReadingDocument;
  registry: TextNodeRegistry;
  blockMaps: Map<string, BlockDOMMap>;
  orderedBlockIds: string[];
}

function isElementSuppressed(element: Element): boolean {
  if (element.matches(EXCLUDED_SELECTOR)) return true;
  if (element instanceof HTMLElement) {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.contentVisibility === "hidden"
    ) {
      return true;
    }
    if (Number.parseFloat(style.opacity || "1") === 0) return true;
    if (
      (style.position === "absolute" || style.position === "fixed") &&
      (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)")
    ) {
      return true;
    }
  }
  return false;
}

function isElementVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (isElementSuppressed(current)) return false;
    current = current.parentElement;
  }
  return true;
}

function visibleTextLength(root: Element): number {
  let length = 0;
  for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
    if (isElementVisible(element)) length += (element.textContent ?? "").trim().length;
  }
  return length;
}

function rootScore(root: Element): number {
  const textLength = visibleTextLength(root);
  const paragraphs = root.querySelectorAll("p").length;
  const semanticBlocks = root.querySelectorAll(BLOCK_SELECTOR).length;
  const linkLength = Array.from(root.querySelectorAll("a")).reduce(
    (total, link) => total + (link.textContent ?? "").trim().length,
    0,
  );
  const linkPenalty = textLength > 0 ? (linkLength / textLength) * 600 : 0;
  const roleBonus = root.tagName === "ARTICLE" ? 800 : root.tagName === "MAIN" ? 600 : 450;
  return textLength + paragraphs * 90 + semanticBlocks * 12 + roleBonus - linkPenalty;
}

export function selectReadingRoot(document: Document): Element {
  const candidates = Array.from(document.querySelectorAll(ROOT_SELECTOR)).filter(isElementVisible);
  if (candidates.length === 0) return document.body;
  return candidates.sort((left, right) => rootScore(right) - rootScore(left))[0] ?? document.body;
}

function blockTypeFor(element: Element): ReadingBlockType {
  const tag = element.tagName;
  if (/^H[1-6]$/u.test(tag)) return "heading";
  if (tag === "LI") return "list-item";
  if (tag === "BLOCKQUOTE" || element.closest("blockquote")) return "quote";
  if (tag === "P") return "paragraph";
  return "other";
}

function isCanonicalBlock(element: Element): boolean {
  const containingListItem = element.parentElement?.closest("li");
  if (element.tagName !== "LI" && containingListItem) return false;
  if (
    element.tagName === "BLOCKQUOTE" &&
    element.querySelector("p,li,blockquote,h1,h2,h3,h4,h5,h6")
  ) {
    return false;
  }
  return true;
}

function meaningfulBlock(element: Element, text: string): boolean {
  if (!isElementVisible(element) || !text) return false;
  if (element.matches("p") && text.length < 2) return false;
  if (element.matches("li") && element.closest("nav,[role='navigation'],[role='menu']"))
    return false;
  return /[\p{L}\p{N}]/u.test(text);
}

function stableDocumentId(url: string, blocks: readonly ReadingBlock[]): string {
  let hash = 2166136261;
  const value = `${url}\u0000${blocks.map((block) => block.text).join("\u0001")}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `document-${(hash >>> 0).toString(36)}`;
}

export function extractReadingDocument(
  sourceDocument: Document = document,
): ExtractedReadingDocument {
  const root = selectReadingRoot(sourceDocument);
  const registry = new TextNodeRegistry();
  const blockMaps = new Map<string, BlockDOMMap>();
  const blocks: ReadingBlock[] = [];

  const addBlock = (
    element: Element,
    type: ReadingBlockType,
    normalized: NormalizedDOMText,
  ): void => {
    if (!meaningfulBlock(element, normalized.text)) return;

    const blockId = `block-${blocks.length}`;
    const sentences = segmentBlock(
      blockId,
      normalized.text,
      sourceDocument.documentElement.lang || undefined,
    );
    if (sentences.length === 0) return;
    const block: ReadingBlock = {
      id: blockId,
      type,
      text: normalized.text,
      sentences,
    };
    blocks.push(block);
    blockMaps.set(blockId, {
      blockId,
      element,
      normalized,
      sentences: new Map(sentences.map((sentence) => [sentence.id, sentence])),
    });
  };

  const elements = root.matches(BLOCK_SELECTOR)
    ? [root, ...Array.from(root.querySelectorAll(BLOCK_SELECTOR))]
    : Array.from(root.querySelectorAll(BLOCK_SELECTOR));

  elements.filter(isCanonicalBlock).forEach((element) => {
    const normalized = normalizeElementText(element, registry, {
      shouldSkipElement: (descendant) =>
        isElementSuppressed(descendant) ||
        (element.tagName === "LI" && descendant.matches("ul,ol")),
    });
    addBlock(element, blockTypeFor(element), normalized);
  });

  if (blocks.length === 0) {
    extractRawMarkdownBlocks(sourceDocument, registry, isElementVisible).forEach((block) => {
      addBlock(block.element, block.type, block.normalized);
    });
  }

  const url = sourceDocument.location?.href ?? "about:blank";
  const title =
    sourceDocument.title.trim() || blocks.find((block) => block.type === "heading")?.text;
  const readingDocument: ReadingDocument = {
    id: stableDocumentId(url, blocks),
    version: 1,
    url,
    ...(title ? { title } : {}),
    ...(sourceDocument.documentElement.lang
      ? { language: sourceDocument.documentElement.lang }
      : {}),
    blocks,
    sentenceCount: blocks.reduce((total, block) => total + block.sentences.length, 0),
    wordCount: blocks.reduce(
      (total, block) =>
        total +
        block.sentences.reduce(
          (sentenceTotal, sentence) => sentenceTotal + sentence.words.length,
          0,
        ),
      0,
    ),
  };

  return {
    document: readingDocument,
    registry,
    blockMaps,
    orderedBlockIds: blocks.map((block) => block.id),
  };
}
