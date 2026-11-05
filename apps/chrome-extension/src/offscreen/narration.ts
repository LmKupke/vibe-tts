import type {
  NarrationUnit,
  ReadingDocument,
  ReadingSelection,
  ReadingWord,
} from "@vibe-tts/shared";

interface SelectionBounds {
  startBlockIndex: number;
  endBlockIndex: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Keep individual synthesis requests below the server's 5,000-character
 * contract. The margin leaves room for future provider-side normalization
 * while still producing reasonably large clips for pathological prose with no
 * sentence punctuation.
 */
export const MAX_NARRATION_UNIT_LENGTH = 4_500;

function selectionBounds(
  document: ReadingDocument,
  selection: ReadingSelection | undefined,
): SelectionBounds | undefined {
  if (!selection) return undefined;
  const startBlockIndex = document.blocks.findIndex((block) => block.id === selection.startBlockId);
  const endBlockIndex = document.blocks.findIndex((block) => block.id === selection.endBlockId);
  if (
    startBlockIndex < 0 ||
    endBlockIndex < startBlockIndex ||
    !Number.isInteger(selection.startOffset) ||
    !Number.isInteger(selection.endOffset) ||
    selection.startOffset < 0 ||
    selection.endOffset < 0
  ) {
    return undefined;
  }
  const startBlock = document.blocks[startBlockIndex];
  const endBlock = document.blocks[endBlockIndex];
  if (
    !startBlock ||
    !endBlock ||
    selection.startOffset > startBlock.text.length ||
    selection.endOffset > endBlock.text.length ||
    (startBlockIndex === endBlockIndex && selection.startOffset >= selection.endOffset)
  ) {
    return undefined;
  }
  return {
    startBlockIndex,
    endBlockIndex,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
  };
}

function trimSourceSpan(
  sourceText: string,
  sourceStart: number,
  sourceEnd: number,
): { sourceStart: number; sourceEnd: number; text: string } | undefined {
  const candidate = sourceText.slice(sourceStart, sourceEnd);
  const leadingWhitespace = candidate.length - candidate.trimStart().length;
  const trailingWhitespace = candidate.length - candidate.trimEnd().length;
  const trimmedStart = sourceStart + leadingWhitespace;
  const trimmedEnd = sourceEnd - trailingWhitespace;
  if (trimmedStart >= trimmedEnd) return undefined;
  return {
    sourceStart: trimmedStart,
    sourceEnd: trimmedEnd,
    text: sourceText.slice(trimmedStart, trimmedEnd),
  };
}

function clippedWords(
  blockText: string,
  words: readonly ReadingWord[],
  sourceStart: number,
  sourceEnd: number,
): ReadingWord[] {
  return words.flatMap((word) => {
    const startOffset = Math.max(word.startOffset, sourceStart);
    const endOffset = Math.min(word.endOffset, sourceEnd);
    if (startOffset >= endOffset) return [];
    return [
      {
        ...word,
        text: blockText.slice(startOffset, endOffset),
        startOffset,
        endOffset,
      },
    ];
  });
}

function safeHardEnd(text: string, start: number, requestedEnd: number): number {
  let end = requestedEnd;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return Math.max(start + 1, end);
}

function splitSourceSpan(
  blockText: string,
  words: readonly ReadingWord[],
  sourceStart: number,
  sourceEnd: number,
): Array<{ sourceStart: number; sourceEnd: number; text: string; words: ReadingWord[] }> {
  const spans: Array<{
    sourceStart: number;
    sourceEnd: number;
    text: string;
    words: ReadingWord[];
  }> = [];
  let cursor = sourceStart;

  while (cursor < sourceEnd) {
    const hardEnd = safeHardEnd(
      blockText,
      cursor,
      Math.min(sourceEnd, cursor + MAX_NARRATION_UNIT_LENGTH),
    );
    let candidateEnd = hardEnd;

    if (hardEnd < sourceEnd) {
      const lastWholeWord = words.findLast(
        (word) => word.endOffset > cursor && word.endOffset <= hardEnd,
      );
      if (lastWholeWord) {
        candidateEnd = lastWholeWord.endOffset;
      } else {
        for (let index = hardEnd; index > cursor; index -= 1) {
          if (/\s/u.test(blockText[index - 1] ?? "")) {
            candidateEnd = index;
            break;
          }
        }
      }
    }

    const span = trimSourceSpan(blockText, cursor, candidateEnd);
    if (span) {
      spans.push({
        ...span,
        words: clippedWords(blockText, words, span.sourceStart, span.sourceEnd),
      });
    }
    cursor = candidateEnd;
    while (cursor < sourceEnd && /\s/u.test(blockText[cursor] ?? "")) cursor += 1;
  }

  return spans;
}

/**
 * Flattens document sentences into stable narration units. A selection clips both
 * sentence text and word spans to its exact block-normalized source offsets.
 */
export function buildNarrationUnits(
  document: ReadingDocument,
  selection?: ReadingSelection,
): NarrationUnit[] {
  const bounds = selectionBounds(document, selection);
  if (selection && !bounds) return [];

  const units: NarrationUnit[] = [];
  document.blocks.forEach((block, blockIndex) => {
    block.sentences.forEach((sentence) => {
      if (bounds && (blockIndex < bounds.startBlockIndex || blockIndex > bounds.endBlockIndex)) {
        return;
      }

      const selectionStart =
        bounds && blockIndex === bounds.startBlockIndex ? bounds.startOffset : sentence.startOffset;
      const selectionEnd =
        bounds && blockIndex === bounds.endBlockIndex ? bounds.endOffset : sentence.endOffset;
      const sourceStart = Math.max(sentence.startOffset, selectionStart);
      const sourceEnd = Math.min(sentence.endOffset, selectionEnd);
      for (const span of splitSourceSpan(block.text, sentence.words, sourceStart, sourceEnd)) {
        units.push({
          id: `${document.id}:${sentence.id}:${span.sourceStart}-${span.sourceEnd}`,
          blockId: block.id,
          sentenceId: sentence.id,
          sentenceIndex: units.length,
          text: span.text,
          sourceStart: span.sourceStart,
          sourceEnd: span.sourceEnd,
          words: span.words,
        });
      }
    });
  });

  return units;
}

export function unitOffsetForSentence(
  units: readonly NarrationUnit[],
  sentenceIndex: number,
): number {
  if (units.length === 0) return -1;
  const exact = units.findIndex((unit) => unit.sentenceIndex === sentenceIndex);
  if (exact >= 0) return exact;
  const following = units.findIndex((unit) => unit.sentenceIndex > sentenceIndex);
  return following >= 0 ? following : units.length - 1;
}

export function wordForSourceSpan(
  unit: NarrationUnit,
  sourceStart: number,
  sourceEnd = sourceStart + 1,
): ReadingWord | undefined {
  const direct = unit.words.find(
    (word) => sourceStart >= word.startOffset && sourceStart < word.endOffset,
  );
  if (direct) return direct;
  if (sourceEnd > sourceStart) {
    const overlapping = unit.words.find(
      (word) => word.startOffset < sourceEnd && word.endOffset > sourceStart,
    );
    if (overlapping) return overlapping;
  }
  return unit.words.find((word) => word.startOffset >= sourceStart);
}
