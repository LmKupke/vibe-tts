import { describe, expect, it } from "vitest";

import { segmentBlock } from "./segmentation";

describe("Intl segmentation", () => {
  it("returns block-relative sentence and word offsets", () => {
    const text = "First sentence.  Second repeated repeated word!";
    const sentences = segmentBlock("block-0", text, "en");
    expect(sentences).toHaveLength(2);
    expect(text.slice(sentences[1]?.startOffset, sentences[1]?.endOffset)).toBe(
      "Second repeated repeated word!",
    );
    for (const word of sentences[1]?.words ?? []) {
      expect(text.slice(word.startOffset, word.endOffset)).toBe(word.text);
    }
  });
});
