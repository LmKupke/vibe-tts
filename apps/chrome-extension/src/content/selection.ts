import type { ReadingSelection } from "@vibe-tts/shared";

import type { ExtractedReadingDocument } from "./extractor";

interface LocatedPoint {
  blockId: string;
  blockIndex: number;
  offset: number;
}

function textPoint(node: Node, offset: number, edge: "start" | "end"): [Text, number] | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    return [text, Math.min(Math.max(0, offset), text.length)];
  }
  const children = Array.from(node.childNodes);
  if (edge === "start") {
    for (
      let index = Math.min(Math.max(0, offset), children.length - 1);
      index < children.length;
      index += 1
    ) {
      const child = children[index];
      if (!child) continue;
      if (child.nodeType === Node.TEXT_NODE) return [child as Text, 0];
      const walker = child.ownerDocument?.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      const text = walker?.nextNode();
      if (text instanceof Text) return [text, 0];
    }
    const last = children.at(-1);
    if (!last) return undefined;
    if (last.nodeType === Node.TEXT_NODE) return [last as Text, (last as Text).length];
    const walker = last.ownerDocument?.createTreeWalker(last, NodeFilter.SHOW_TEXT);
    let current: Node | null | undefined;
    let finalText: Text | undefined;
    while ((current = walker?.nextNode())) if (current instanceof Text) finalText = current;
    return finalText ? [finalText, finalText.length] : undefined;
  }
  for (let index = Math.min(offset - 1, children.length - 1); index >= 0; index -= 1) {
    const child = children[index];
    if (!child) continue;
    if (child.nodeType === Node.TEXT_NODE) return [child as Text, (child as Text).length];
    const walker = child.ownerDocument?.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    let current: Node | null | undefined;
    let last: Text | undefined;
    while ((current = walker?.nextNode())) if (current instanceof Text) last = current;
    if (last) return [last, last.length];
  }
  const first = children[0];
  if (!first) return undefined;
  if (first.nodeType === Node.TEXT_NODE) return [first as Text, 0];
  const walker = first.ownerDocument?.createTreeWalker(first, NodeFilter.SHOW_TEXT);
  const text = walker?.nextNode();
  return text instanceof Text ? [text, 0] : undefined;
}

function locate(
  extraction: ExtractedReadingDocument,
  node: Node,
  rawOffset: number,
  edge: "start" | "end",
): LocatedPoint | undefined {
  const point = textPoint(node, rawOffset, edge);
  if (!point) return undefined;
  let nearest: (LocatedPoint & { distance: number }) | undefined;
  for (let index = 0; index < extraction.orderedBlockIds.length; index += 1) {
    const blockId = extraction.orderedBlockIds[index];
    if (!blockId) continue;
    const blockMap = extraction.blockMaps.get(blockId);
    if (!blockMap?.normalized.containsNode(point[0])) continue;
    const offset = blockMap.normalized.normalizedOffsetForPoint(point[0], point[1], edge);
    if (offset !== undefined) return { blockId, blockIndex: index, offset };

    // Raw Markdown blocks are disjoint spans in one shared <pre> text node.
    // A selection endpoint can sit in skipped frontmatter, a blank line, or a
    // trailing newline. Resolve those gaps toward the selected content: starts
    // move forward to the next block, while ends move back to the prior block.
    const segments = blockMap.normalized.segments.filter(
      (segment) => extraction.registry.nodeFor(segment.nodeId) === point[0],
    );
    const first = segments[0];
    const last = segments.at(-1);
    const candidate =
      edge === "start" && first && point[1] <= first.rawStartOffset
        ? { distance: first.rawStartOffset - point[1], offset: 0 }
        : edge === "end" && last && point[1] >= last.rawEndOffset
          ? {
              distance: point[1] - last.rawEndOffset,
              offset: blockMap.normalized.text.length,
            }
          : undefined;
    if (candidate && (!nearest || candidate.distance < nearest.distance)) {
      nearest = { blockId, blockIndex: index, ...candidate };
    }
  }
  if (!nearest) return undefined;
  return {
    blockId: nearest.blockId,
    blockIndex: nearest.blockIndex,
    offset: nearest.offset,
  };
}

export function mapSelectionToDocument(
  extraction: ExtractedReadingDocument,
  selection: Selection | null = window.getSelection(),
): ReadingSelection | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const start = locate(extraction, range.startContainer, range.startOffset, "start");
  const end = locate(extraction, range.endContainer, range.endOffset, "end");
  if (!start || !end) return undefined;
  if (
    start.blockIndex > end.blockIndex ||
    (start.blockIndex === end.blockIndex && start.offset >= end.offset)
  ) {
    return undefined;
  }
  return {
    startBlockId: start.blockId,
    startOffset: start.offset,
    endBlockId: end.blockId,
    endOffset: end.offset,
  };
}

export function firstSentenceIndexForSelection(
  extraction: ExtractedReadingDocument,
  selection: ReadingSelection | undefined,
): number {
  if (!selection) return 0;
  let sentenceIndex = 0;
  for (const block of extraction.document.blocks) {
    for (const sentence of block.sentences) {
      if (
        block.id === selection.startBlockId &&
        sentence.endOffset > selection.startOffset &&
        (selection.startBlockId !== selection.endBlockId ||
          sentence.startOffset < selection.endOffset)
      ) {
        return sentenceIndex;
      }
      sentenceIndex += 1;
    }
  }
  return 0;
}
