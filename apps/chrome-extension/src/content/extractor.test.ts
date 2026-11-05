import { afterEach, describe, expect, it } from "vitest";

import { extractReadingDocument, selectReadingRoot } from "./extractor";

function load(body: string, title = "Fixture"): void {
  document.documentElement.innerHTML = `<head><title>${title}</title><style>.hidden{display:none}</style></head><body>${body}</body>`;
}

function loadRawMarkdown(markdown: string, contentType = "text/markdown"): HTMLPreElement {
  load("<pre></pre>", "notes.md");
  const pre = document.querySelector("pre");
  if (!(pre instanceof HTMLPreElement)) throw new Error("Expected raw Markdown pre element");
  pre.textContent = markdown;
  Object.defineProperty(document, "contentType", { configurable: true, value: contentType });
  return pre;
}

afterEach(() => {
  Reflect.deleteProperty(document, "contentType");
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("semantic extraction", () => {
  it("prefers a substantial article over navigation", () => {
    load(`
      <nav><p>Home Products Company Pricing Contact</p></nav>
      <article><h1>A useful title</h1><p>This is the first meaningful sentence. This is another.</p></article>
      <footer><p>Copyright and legal links.</p></footer>
    `);
    expect(selectReadingRoot(document).tagName).toBe("ARTICLE");
    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
    expect(result.document.blocks.map((block) => block.text).join(" ")).not.toContain("Home");
  });

  it("excludes hidden and aria-hidden content", () => {
    load(`
      <main>
        <p>Visible words remain.</p>
        <p hidden>Hidden attribute words.</p>
        <p aria-hidden="true">Assistive-hidden words.</p>
        <p class="hidden">CSS-hidden words.</p>
      </main>
    `);
    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => block.text)).toEqual(["Visible words remain."]);
  });

  it("skips hidden inline subtrees and blocks hidden by an ancestor", () => {
    load(`
      <main>
        <p>Visible <span aria-hidden="true">inline secret</span> words.</p>
        <section class="hidden"><p>Ancestor secret.</p></section>
      </main>
    `);
    const result = extractReadingDocument();
    const text = result.document.blocks.map((block) => block.text).join(" ");
    expect(text).toContain("Visible words.");
    expect(text).not.toContain("inline secret");
    expect(text).not.toContain("Ancestor secret");
  });

  it("extracts lists and quotes as separate semantic blocks", () => {
    load(`
      <article>
        <ul><li>First item.</li><li>Second item.</li></ul>
        <blockquote>A quoted thought.</blockquote>
      </article>
    `);
    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "list-item",
      "list-item",
      "quote",
    ]);
  });

  it("reads rendered Markdown table cells in document order", () => {
    load(`
      <main>
        <table>
          <thead><tr><th>Provider</th><th>Status</th></tr></thead>
          <tbody><tr><td>Browser speech</td><td>Available</td></tr></tbody>
        </table>
      </main>
    `);
    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => [block.type, block.text])).toEqual([
      ["other", "Provider"],
      ["other", "Status"],
      ["other", "Browser speech"],
      ["other", "Available"],
    ]);
  });

  it("does not duplicate nested blockquotes or nested list items", () => {
    load(`
      <article>
        <blockquote><p>One quoted sentence.</p></blockquote>
        <ul><li>Parent item<ul><li>Nested item</li></ul></li></ul>
      </article>
    `);
    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => [block.type, block.text])).toEqual([
      ["quote", "One quoted sentence."],
      ["list-item", "Parent item"],
      ["list-item", "Nested item"],
    ]);
  });
});

describe("inline DOM mapping", () => {
  it("preserves one sentence across strong, em, links, and nested spans", () => {
    load(`
      <article><p>This is <strong>very <em>important</em></strong> <a href="#">information</a>.</p></article>
    `);
    const result = extractReadingDocument();
    const block = result.document.blocks[0];
    expect(block?.text).toBe("This is very important information.");
    expect(block?.sentences).toHaveLength(1);
    const map = block ? result.blockMaps.get(block.id) : undefined;
    const important = block?.sentences[0]?.words.find((word) => word.text === "important");
    const range =
      important && map?.normalized.rangeForOffsets(important.startOffset, important.endOffset);
    expect(range?.toString()).toBe("important");
    expect(range?.startContainer.parentElement?.tagName).toBe("EM");
  });

  it("collapses ordinary whitespace and NBSP without losing exact ranges", () => {
    load(`<main><p>Alpha   <span>beta&nbsp;&nbsp;gamma</span> delta.</p></main>`);
    const result = extractReadingDocument();
    const block = result.document.blocks[0];
    expect(block?.text).toBe("Alpha beta gamma delta.");
    const gamma = block?.sentences[0]?.words.find((word) => word.text === "gamma");
    const range =
      block && gamma
        ? result.blockMaps
            .get(block.id)
            ?.normalized.rangeForOffsets(gamma.startOffset, gamma.endOffset)
        : undefined;
    expect(range?.toString()).toBe("gamma");
  });

  it("maps repeated words by offsets rather than string search", () => {
    load(`<article><p>Go <strong>go</strong> go.</p></article>`);
    const result = extractReadingDocument();
    const block = result.document.blocks[0];
    const words = block?.sentences[0]?.words ?? [];
    expect(words.map((word) => word.text.toLocaleLowerCase())).toEqual(["go", "go", "go"]);
    const second = words[1];
    const range =
      block && second
        ? result.blockMaps
            .get(block.id)
            ?.normalized.rangeForOffsets(second.startOffset, second.endOffset)
        : undefined;
    expect(range?.startContainer.parentElement?.tagName).toBe("STRONG");
  });

  it("keeps Unicode punctuation and deterministic offsets", () => {
    load(`<article lang="en"><p>“Hello,” she said — then paused. Café déjà vu!</p></article>`);
    const result = extractReadingDocument();
    const block = result.document.blocks[0];
    expect(block?.sentences).toHaveLength(2);
    expect(block?.sentences[0]?.text).toBe("“Hello,” she said — then paused.");
    expect(block?.sentences[1]?.words.map((word) => word.text)).toEqual(["Café", "déjà", "vu"]);
  });

  it("omits narration-skipped diagram source nested inside a list item", () => {
    load(`<main><ul><li>Diagram follows.
      <figure data-vibe-tts-narration-skip="true">
        <div role="img" aria-label="Mermaid diagram"></div>
        <details><summary>View diagram source</summary><pre><code>flowchart LR\nSecret --&gt; Hidden</code></pre></details>
      </figure>
    </li></ul></main>`);

    expect(extractReadingDocument().document.blocks.map((block) => block.text)).toEqual([
      "Diagram follows.",
    ]);
  });
});

describe("raw Markdown extraction", () => {
  it("reads semantic prose while omitting Markdown-only syntax and metadata", () => {
    const pre = loadRawMarkdown(`---
title: Internal metadata
---
# Vanta **briefing**

A [visible label](https://example.test/private) and \`inline code\`.
<!-- an internal authoring note -->

- [x] First *item*.
1. Second item.

> Quoted **thought**.

\`\`\`ts
const fencedSecret = true;
\`\`\`

[details]: https://example.test/reference
Read [the reference][details].`);

    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => [block.type, block.text])).toEqual([
      ["heading", "Vanta briefing"],
      ["paragraph", "A visible label and inline code."],
      ["list-item", "First item."],
      ["list-item", "Second item."],
      ["quote", "Quoted thought."],
      ["paragraph", "Read the reference."],
    ]);
    const spokenText = result.document.blocks.map((block) => block.text).join(" ");
    expect(spokenText).not.toContain("example.test");
    expect(spokenText).not.toContain("Internal metadata");
    expect(spokenText).not.toContain("fencedSecret");
    expect(spokenText).not.toContain("authoring note");

    const paragraph = result.document.blocks[1];
    const label = paragraph?.sentences[0]?.words.find((word) => word.text === "visible");
    const labelRange =
      paragraph && label
        ? result.blockMaps
            .get(paragraph.id)
            ?.normalized.rangeForOffsets(label.startOffset, label.endOffset)
        : undefined;
    expect(labelRange?.toString()).toBe("visible");
    expect(labelRange?.startContainer).toBe(pre.firstChild);

    const heading = result.document.blocks[0];
    const reference = result.document.blocks.at(-1);
    const referenceRawOffset = pre.textContent?.indexOf("Read [") ?? -1;
    expect(
      heading
        ? result.blockMaps
            .get(heading.id)
            ?.normalized.normalizedOffsetForPoint(pre.firstChild!, referenceRawOffset)
        : undefined,
    ).toBeUndefined();
    expect(
      reference
        ? result.blockMaps
            .get(reference.id)
            ?.normalized.normalizedOffsetForPoint(pre.firstChild!, referenceRawOffset)
        : undefined,
    ).toBe(0);
  });

  it("supports Setext headings, soft-wrapped paragraphs, and multiline quotes", () => {
    loadRawMarkdown(
      `A Setext title
===============

One soft-wrapped
paragraph continues.

> First quoted sentence.
> Second quoted sentence.`,
      "text/plain",
    );

    const result = extractReadingDocument();
    expect(result.document.blocks.map((block) => [block.type, block.text])).toEqual([
      ["heading", "A Setext title"],
      ["paragraph", "One soft-wrapped paragraph continues."],
      ["quote", "First quoted sentence. Second quoted sentence."],
    ]);
  });

  it("uses the first Markdown heading as the document title when Chrome supplies none", () => {
    loadRawMarkdown("# Local research notes\n\nA useful paragraph.");
    document.title = "";

    expect(extractReadingDocument().document.title).toBe("Local research notes");
  });

  it("never treats a normal webpage pre or nested code sample as a reading document", () => {
    load("<pre># Not a raw Markdown document</pre>");
    expect(extractReadingDocument().document.blocks).toEqual([]);

    loadRawMarkdown("# Still code-shaped", "text/markdown");
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("Expected pre");
    pre.innerHTML = "<code># Nested code is not a raw document</code>";
    expect(extractReadingDocument().document.blocks).toEqual([]);
  });

  it("keeps semantic HTML extraction authoritative over the raw fallback", () => {
    load("<main><p>Rendered prose wins.</p></main><pre># Raw-looking backup</pre>");
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/markdown",
    });
    expect(extractReadingDocument().document.blocks.map((block) => block.text)).toEqual([
      "Rendered prose wins.",
    ]);
  });
});
