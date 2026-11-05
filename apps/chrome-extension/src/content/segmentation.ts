import type { ReadingSentence, ReadingWord } from "@vibe-tts/shared";

interface IndexedSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

function sentenceSegments(text: string, language?: string): IndexedSegment[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
    return Array.from(segmenter.segment(text), ({ segment, index }) => ({ segment, index }));
  }

  const result: IndexedSegment[] = [];
  const pattern = /[^.!?]+(?:[.!?]+[\]})"'’”]*|$)/gu;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined && match[0])
      result.push({ segment: match[0], index: match.index });
  }
  return result.length > 0 ? result : [{ segment: text, index: 0 }];
}

function wordSegments(text: string, language?: string): IndexedSegment[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(language, { granularity: "word" });
    return Array.from(segmenter.segment(text), ({ segment, index, isWordLike }) => ({
      segment,
      index,
      ...(isWordLike === undefined ? {} : { isWordLike }),
    }));
  }

  const result: IndexedSegment[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)) {
    if (match.index !== undefined && match[0]) {
      result.push({ segment: match[0], index: match.index, isWordLike: true });
    }
  }
  return result;
}

export function segmentBlock(blockId: string, text: string, language?: string): ReadingSentence[] {
  const sentences: ReadingSentence[] = [];

  for (const sentenceSegment of sentenceSegments(text, language)) {
    const leadingLength =
      sentenceSegment.segment.length - sentenceSegment.segment.trimStart().length;
    const trimmed = sentenceSegment.segment.trim();
    if (!trimmed) continue;
    const startOffset = sentenceSegment.index + leadingLength;
    const endOffset = startOffset + trimmed.length;
    const sentenceId = `${blockId}:sentence-${sentences.length}`;
    const words: ReadingWord[] = wordSegments(trimmed, language)
      .filter((word) => word.isWordLike !== false && /[\p{L}\p{N}]/u.test(word.segment))
      .map((word, index) => ({
        id: `${sentenceId}:word-${index}`,
        sentenceId,
        text: word.segment,
        startOffset: startOffset + word.index,
        endOffset: startOffset + word.index + word.segment.length,
      }));

    sentences.push({ id: sentenceId, blockId, text: trimmed, startOffset, endOffset, words });
  }

  return sentences;
}
