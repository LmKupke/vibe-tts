import { describe, expect, it } from "vitest";

import type { ReadingDocument } from "@vibe-tts/shared";

import { MAX_NARRATION_UNIT_LENGTH, buildNarrationUnits, unitOffsetForSentence } from "./narration";

const document: ReadingDocument = {
  id: "doc",
  version: 1,
  url: "https://example.test",
  blocks: [
    {
      id: "b1",
      type: "paragraph",
      text: "Alpha bravo. Charlie delta.",
      sentences: [
        {
          id: "s1",
          blockId: "b1",
          text: "Alpha bravo.",
          startOffset: 0,
          endOffset: 12,
          words: [
            { id: "w1", sentenceId: "s1", text: "Alpha", startOffset: 0, endOffset: 5 },
            { id: "w2", sentenceId: "s1", text: "bravo", startOffset: 6, endOffset: 11 },
          ],
        },
        {
          id: "s2",
          blockId: "b1",
          text: "Charlie delta.",
          startOffset: 13,
          endOffset: 27,
          words: [
            { id: "w3", sentenceId: "s2", text: "Charlie", startOffset: 13, endOffset: 20 },
            { id: "w4", sentenceId: "s2", text: "delta", startOffset: 21, endOffset: 26 },
          ],
        },
      ],
    },
    {
      id: "b2",
      type: "paragraph",
      text: "Echo foxtrot.",
      sentences: [
        {
          id: "s3",
          blockId: "b2",
          text: "Echo foxtrot.",
          startOffset: 0,
          endOffset: 13,
          words: [
            { id: "w5", sentenceId: "s3", text: "Echo", startOffset: 0, endOffset: 4 },
            { id: "w6", sentenceId: "s3", text: "foxtrot", startOffset: 5, endOffset: 12 },
          ],
        },
      ],
    },
  ],
  sentenceCount: 3,
  wordCount: 6,
};

describe("narration unit construction", () => {
  it("clips the first and last sentence and exposes selection-relative indices", () => {
    const units = buildNarrationUnits(document, {
      startBlockId: "b1",
      startOffset: 8,
      endBlockId: "b2",
      endOffset: 4,
    });

    expect(units.map((unit) => unit.text)).toEqual(["avo.", "Charlie delta.", "Echo"]);
    expect(units.map((unit) => unit.sentenceIndex)).toEqual([0, 1, 2]);
    expect(units[0]).toMatchObject({ sourceStart: 8, sourceEnd: 12 });
    expect(units[0]?.words).toEqual([
      { id: "w2", sentenceId: "s1", text: "avo", startOffset: 8, endOffset: 11 },
    ]);
    expect(units[2]?.words[0]).toMatchObject({ id: "w5", text: "Echo" });
  });

  it("rejects stale selection block identifiers instead of narrating the full page", () => {
    expect(
      buildNarrationUnits(document, {
        startBlockId: "missing",
        startOffset: 0,
        endBlockId: "b2",
        endOffset: 4,
      }),
    ).toEqual([]);
  });

  it("maps requested queue-relative sentences within selected units", () => {
    const units = buildNarrationUnits(document, {
      startBlockId: "b1",
      startOffset: 13,
      endBlockId: "b2",
      endOffset: 13,
    });
    expect(unitOffsetForSentence(units, 0)).toBe(0);
    expect(units.map((unit) => unit.sentenceIndex)).toEqual([0, 1]);
    expect(unitOffsetForSentence(units, 1)).toBe(1);
    expect(unitOffsetForSentence(units, 99)).toBe(1);
  });

  it("splits overlong unpunctuated sentences without losing source offsets", () => {
    const word = "narration ";
    const text = word.repeat(1_100).trimEnd();
    const longDocument: ReadingDocument = {
      id: "long",
      version: 1,
      url: "https://example.test/long",
      blocks: [
        {
          id: "long-block",
          type: "paragraph",
          text,
          sentences: [
            {
              id: "long-sentence",
              blockId: "long-block",
              text,
              startOffset: 0,
              endOffset: text.length,
              words: Array.from({ length: 1_100 }, (_, index) => ({
                id: `word-${index}`,
                sentenceId: "long-sentence",
                text: "narration",
                startOffset: index * word.length,
                endOffset: index * word.length + "narration".length,
              })),
            },
          ],
        },
      ],
      sentenceCount: 1,
      wordCount: 1_100,
    };

    const units = buildNarrationUnits(longDocument);

    expect(units.length).toBeGreaterThan(1);
    expect(units.every((unit) => unit.text.length <= MAX_NARRATION_UNIT_LENGTH)).toBe(true);
    expect(units[0]?.sourceStart).toBe(0);
    expect(units.at(-1)?.sourceEnd).toBe(text.length);
    expect(units.map((unit) => unit.sentenceIndex)).toEqual(units.map((_, index) => index));
    expect(units.flatMap((unit) => unit.words)).toHaveLength(1_100);
  });

  it("never splits a UTF-16 surrogate pair at the hard request boundary", () => {
    const text = `${"a".repeat(MAX_NARRATION_UNIT_LENGTH - 1)}🌍${"b".repeat(20)}`;
    const unicodeDocument: ReadingDocument = {
      id: "unicode-long",
      version: 1,
      url: "https://example.test/unicode-long",
      blocks: [
        {
          id: "unicode-block",
          type: "paragraph",
          text,
          sentences: [
            {
              id: "unicode-sentence",
              blockId: "unicode-block",
              text,
              startOffset: 0,
              endOffset: text.length,
              words: [],
            },
          ],
        },
      ],
      sentenceCount: 1,
      wordCount: 0,
    };

    const units = buildNarrationUnits(unicodeDocument);

    expect(units[0]?.text.endsWith("\ud83c")).toBe(false);
    expect(units[1]?.text.startsWith("\udf0d")).toBe(false);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
  });
});
