import { describe, expect, it } from "vitest";

import { extractReadingDocument } from "./extractor";
import { firstSentenceIndexForSelection, mapSelectionToDocument } from "./selection";

describe("selection mapping", () => {
  it("maps a selection spanning multiple inline text nodes", () => {
    document.body.innerHTML =
      "<article><p>Choose <strong>these important</strong> words today.</p></article>";
    const extraction = extractReadingDocument();
    const paragraph = document.querySelector("p");
    const first = paragraph?.firstChild;
    const last = paragraph?.lastChild;
    expect(first).toBeInstanceOf(Text);
    expect(last).toBeInstanceOf(Text);
    const range = document.createRange();
    range.setStart(first as Text, 3);
    range.setEnd(last as Text, 6);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const mapped = mapSelectionToDocument(extraction, selection);
    const block = extraction.document.blocks[0];
    expect(mapped).toEqual({
      startBlockId: block?.id,
      startOffset: 3,
      endBlockId: block?.id,
      endOffset: "Choose these important words".length,
    });
  });

  it("maps element-boundary offsets whose children are text nodes", () => {
    document.body.innerHTML = "<article><p>Alpha <strong>beta</strong> gamma</p></article>";
    const extraction = extractReadingDocument();
    const paragraph = document.querySelector("p");
    expect(paragraph).not.toBeNull();
    const range = document.createRange();
    range.setStart(paragraph as HTMLParagraphElement, 0);
    range.setEnd(paragraph as HTMLParagraphElement, 1);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(mapSelectionToDocument(extraction, selection)).toEqual({
      startBlockId: extraction.document.blocks[0]?.id,
      startOffset: 0,
      endBlockId: extraction.document.blocks[0]?.id,
      endOffset: "Alpha ".length,
    });
  });

  it("maps element-boundary offsets around nested inline elements", () => {
    document.body.innerHTML = "<article><p>Alpha <strong>beta</strong> gamma</p></article>";
    const extraction = extractReadingDocument();
    const paragraph = document.querySelector("p");
    expect(paragraph).not.toBeNull();
    const range = document.createRange();
    range.setStart(paragraph as HTMLParagraphElement, 1);
    range.setEnd(paragraph as HTMLParagraphElement, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(mapSelectionToDocument(extraction, selection)).toEqual({
      startBlockId: extraction.document.blocks[0]?.id,
      startOffset: "Alpha ".length,
      endBlockId: extraction.document.blocks[0]?.id,
      endOffset: "Alpha beta".length,
    });
  });

  it("maps a raw Markdown selection through omitted source syntax", () => {
    document.documentElement.innerHTML =
      "<head></head><body><pre># Notes\n\nChoose **these words** and [this label](https://example.test/private).</pre></body>";
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });

    try {
      const preText = document.querySelector("pre")?.firstChild;
      expect(preText).toBeInstanceOf(Text);
      const raw = (preText as Text).data;
      const range = document.createRange();
      range.setStart(preText as Text, raw.indexOf("these"));
      range.setEnd(preText as Text, raw.indexOf(" label") + " label".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const extraction = extractReadingDocument();
      const paragraph = extraction.document.blocks.find((block) => block.type === "paragraph");
      expect(paragraph?.text).toBe("Choose these words and this label.");
      expect(mapSelectionToDocument(extraction, selection)).toEqual({
        startBlockId: paragraph?.id,
        startOffset: "Choose ".length,
        endBlockId: paragraph?.id,
        endOffset: "Choose these words and this label".length,
      });
    } finally {
      Reflect.deleteProperty(document, "contentType");
    }
  });

  it("starts a cross-block Markdown selection at its actual first sentence", () => {
    document.documentElement.innerHTML =
      "<head></head><body><pre># Notes\n\nAlpha one. Alpha two.\n\n- Beta item.\n\nGamma final.</pre></body>";
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });

    try {
      const text = document.querySelector("pre")?.firstChild;
      expect(text).toBeInstanceOf(Text);
      const raw = (text as Text).data;
      const range = document.createRange();
      range.setStart(text as Text, raw.indexOf("two"));
      range.setEnd(text as Text, raw.indexOf("item") + "item".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const extraction = extractReadingDocument();
      const mapped = mapSelectionToDocument(extraction, selection);
      expect(mapped?.startBlockId).toBe(extraction.document.blocks[1]?.id);
      expect(mapped?.endBlockId).toBe(extraction.document.blocks[2]?.id);
      expect(firstSentenceIndexForSelection(extraction, mapped)).toBe(2);
    } finally {
      Reflect.deleteProperty(document, "contentType");
    }
  });

  it("maps Select All across skipped Markdown metadata and trailing whitespace", () => {
    document.documentElement.innerHTML =
      "<head></head><body><pre>---\ntitle: hidden\n---\n\n# Notes\n\nReadable ending.\n</pre></body>";
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });

    try {
      const pre = document.querySelector("pre");
      expect(pre).not.toBeNull();
      const range = document.createRange();
      range.selectNodeContents(pre as HTMLPreElement);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const extraction = extractReadingDocument();
      const first = extraction.document.blocks[0];
      const last = extraction.document.blocks.at(-1);
      expect(mapSelectionToDocument(extraction, selection)).toEqual({
        startBlockId: first?.id,
        startOffset: 0,
        endBlockId: last?.id,
        endOffset: last?.text.length,
      });
    } finally {
      Reflect.deleteProperty(document, "contentType");
    }
  });
});
