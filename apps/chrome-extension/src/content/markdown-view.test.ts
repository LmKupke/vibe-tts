import { afterEach, describe, expect, it, vi } from "vitest";

import { extractReadingDocument } from "./extractor";
import { MARKDOWN_READ_FROM_BLOCK_EVENT, setMarkdownReadControlState } from "./markdown-gutter";
import { renderMarkdownReadingView } from "./markdown-view";

function loadRawMarkdown(markdown: string, contentType = "text/markdown"): HTMLPreElement {
  document.documentElement.innerHTML = "<head></head><body><pre></pre></body>";
  const pre = document.querySelector("pre");
  if (!(pre instanceof HTMLPreElement)) throw new Error("Expected a pre element");
  pre.textContent = markdown;
  Object.defineProperty(document, "contentType", { configurable: true, value: contentType });
  return pre;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(document, "contentType");
  document.documentElement.removeAttribute("data-vibe-tts-markdown-view");
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("rendered Markdown reading view", () => {
  it("adds contextual native read controls only for rendered headings and paragraphs", () => {
    loadRawMarkdown(`# Heading one

## Heading two

### Heading three

#### Heading four

##### Heading five

###### Heading six

Paragraph seven starts here. It has another sentence.

- List item must not get its own control

| Company | Status |
| --- | --- |
| Vanta | Ready |

\`\`\`mermaid
flowchart LR
  Browser --> Reader
\`\`\`
`);

    expect(renderMarkdownReadingView()).toBe(true);

    const reader = document.querySelector<HTMLElement>("#vibe-tts-markdown-reader");
    const gutter = document.querySelector<HTMLElement>("#vibe-tts-markdown-read-gutter");
    const eligibleBlocks = Array.from(
      reader?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p") ?? [],
    ).filter((block) => !block.closest("li,table,figure,details"));
    const buttons = Array.from(
      gutter?.querySelectorAll<HTMLButtonElement>("button.vibe-md-read-from-here") ?? [],
    );

    expect(gutter).not.toBeNull();
    expect(gutter?.dataset.vibeTtsNarrationSkip).toBe("true");
    expect(eligibleBlocks).toHaveLength(7);
    expect(buttons).toHaveLength(eligibleBlocks.length);
    expect(reader?.querySelectorAll("li .vibe-md-read-from-here")).toHaveLength(0);
    expect(reader?.querySelectorAll("table .vibe-md-read-from-here")).toHaveLength(0);
    expect(reader?.querySelectorAll("figure .vibe-md-read-from-here")).toHaveLength(0);
    expect(reader?.querySelectorAll("details .vibe-md-read-from-here")).toHaveLength(0);

    const blockKeys = eligibleBlocks.map((block) => block.dataset.vibeTtsReadBlock);
    expect(blockKeys.every((blockKey) => /^md-\d+$/u.test(blockKey ?? ""))).toBe(true);
    expect(new Set(blockKeys).size).toBe(eligibleBlocks.length);

    buttons.forEach((button, index) => {
      const target = eligibleBlocks[index];
      expect(button.tagName).toBe("BUTTON");
      expect(button.type).toBe("button");
      expect(button.dataset.vibeTtsReadState).toBe("idle");
      expect(button.getAttribute("aria-label")).toMatch(/read from/i);
      expect(button.getAttribute("aria-label")).toContain(target?.textContent?.trim());
    });

    const firstBlockKey = eligibleBlocks[0]?.dataset.vibeTtsReadBlock;
    expect(firstBlockKey).toBeDefined();
    setMarkdownReadControlState(document, firstBlockKey ?? "", "error");
    expect(buttons[0]?.getAttribute("aria-label")).toMatch(
      /retry from here: heading one.*last attempt failed/i,
    );
    expect(buttons[0]?.querySelector(".vibe-md-read-from-here__retry")).not.toBeNull();
  });

  it("keeps gutter controls out of narration and dispatches their exact block key", () => {
    loadRawMarkdown(`# Start here

Read this exact paragraph. Then continue onward.
`);
    expect(renderMarkdownReadingView()).toBe(true);

    const gutter = document.querySelector<HTMLElement>("#vibe-tts-markdown-read-gutter");
    const paragraph = document.querySelector<HTMLElement>(
      "#vibe-tts-markdown-reader p[data-vibe-tts-read-block]",
    );
    const blockKey = paragraph?.dataset.vibeTtsReadBlock;
    const button = Array.from(
      gutter?.querySelectorAll<HTMLButtonElement>("button.vibe-md-read-from-here") ?? [],
    ).find((candidate) =>
      candidate.getAttribute("aria-label")?.includes("Read this exact paragraph"),
    );
    expect(blockKey).toBeDefined();
    expect(button).toBeDefined();

    const extractionWithControls = extractReadingDocument().document.blocks.map((block) => ({
      type: block.type,
      text: block.text,
      sentences: block.sentences.map((sentence) => sentence.text),
    }));
    gutter?.remove();
    const extractionWithoutControls = extractReadingDocument().document.blocks.map((block) => ({
      type: block.type,
      text: block.text,
      sentences: block.sentences.map((sentence) => sentence.text),
    }));
    document.body.append(gutter as HTMLElement);

    expect(extractionWithControls).toEqual(extractionWithoutControls);
    expect(extractionWithControls.map((block) => block.text).join(" ")).not.toMatch(/read from/i);

    const received: CustomEvent<{ blockKey: string }>[] = [];
    window.addEventListener(MARKDOWN_READ_FROM_BLOCK_EVENT, (event) => {
      received.push(event as CustomEvent<{ blockKey: string }>);
    });
    button?.click();

    expect(received).toHaveLength(1);
    expect(received[0]?.detail).toEqual({ blockKey });
    expect(button?.dataset.vibeTtsReadState).toBe("preparing");
  });

  it("preserves one inert gutter across source-view round trips", () => {
    loadRawMarkdown(`# Toggle controls

The rendered paragraph has a read control.
`);
    expect(renderMarkdownReadingView()).toBe(true);

    const gutter = document.querySelector<HTMLElement>("#vibe-tts-markdown-read-gutter");
    const button = gutter?.querySelector<HTMLButtonElement>(".vibe-md-read-from-here");
    const toggle = document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle");
    expect(gutter).not.toBeNull();
    expect(button).not.toBeNull();

    toggle?.click();
    expect(document.documentElement.dataset.vibeTtsMarkdownView).toBe("source");
    expect(gutter?.hidden).toBe(true);
    expect(gutter?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("#vibe-tts-markdown-source .vibe-md-read-from-here")).toBeNull();

    toggle?.click();
    expect(document.documentElement.dataset.vibeTtsMarkdownView).toBe("rendered");
    expect(document.querySelector("#vibe-tts-markdown-read-gutter")).toBe(gutter);
    expect(gutter?.hidden).toBe(false);
    expect(gutter?.hasAttribute("inert")).toBe(false);
    expect(gutter?.querySelector(".vibe-md-read-from-here")).toBe(button);
    expect(document.querySelectorAll("#vibe-tts-markdown-read-gutter")).toHaveLength(1);
    expect(document.querySelectorAll(".vibe-md-read-from-here")).toHaveLength(2);
  });

  it("supports one-tab-stop arrow navigation when the gutter uses a roving tabindex", () => {
    loadRawMarkdown(`# First target

Second target paragraph.

## Third target
`);
    expect(renderMarkdownReadingView()).toBe(true);

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#vibe-tts-markdown-read-gutter .vibe-md-read-from-here",
      ),
    );
    const tabbable = buttons.filter((button) => button.tabIndex === 0);
    if (tabbable.length !== 1) return;

    tabbable[0]?.focus();
    tabbable[0]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);

    buttons[1]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  });

  it("renders safe semantic Markdown and does not fetch remote images", () => {
    loadRawMarkdown(`---
title: Private metadata
---
# Vanta **briefing**

Read the [source](https://example.test/report) and use \`inline code\`.

<!-- an internal authoring note -->
<script>window.compromised = true</script>

> A useful quote.

- [x] Finished item
- [ ] Open item

\`\`\`ts
const visibleOnly = true;
\`\`\`

\`\`\`mermaid
flowchart LR
  Browser --> Reader
\`\`\`

| Company | Status |
| --- | --- |
| Vanta | Ready |

![Architecture](https://images.example.test/private.png)
`);

    expect(renderMarkdownReadingView()).toBe(true);

    const reader = document.querySelector("main#vibe-tts-markdown-reader");
    expect(reader).not.toBeNull();
    const source = document.querySelector<HTMLPreElement>("pre#vibe-tts-markdown-source");
    expect(source?.hidden).toBe(true);
    expect(source?.hasAttribute("inert")).toBe(true);
    expect(source?.textContent).toContain("# Vanta **briefing**");
    expect(reader?.querySelector("h1")?.innerHTML).toBe("Vanta <strong>briefing</strong>");
    expect(document.title).toBe("Vanta briefing");
    expect(reader?.querySelector("blockquote")?.textContent).toContain("A useful quote.");
    expect(reader?.querySelector("pre code")?.textContent).toContain("visibleOnly");
    const diagram = reader?.querySelector<HTMLElement>("figure.vibe-md-mermaid");
    expect(diagram?.dataset.vibeTtsMermaidState).toBe("pending");
    expect(diagram?.querySelector("details pre code")?.textContent).toContain("Browser --> Reader");
    expect(reader?.querySelector("table")).not.toBeNull();
    expect(reader?.querySelector(".vibe-md-table-scroll")?.getAttribute("role")).toBe("region");

    const link = reader?.querySelector<HTMLAnchorElement>("a[href*='example.test/report']");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(link?.rel).toContain("noreferrer");

    expect(reader?.querySelector("script")).toBeNull();
    expect(reader?.textContent).toContain("<script>window.compromised = true</script>");
    expect(reader?.textContent).not.toContain("authoring note");
    expect(reader?.textContent).not.toContain("Private metadata");

    const tasks = Array.from(reader?.querySelectorAll<HTMLInputElement>("li input") ?? []);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.checked)).toEqual([true, false]);
    expect(reader?.querySelectorAll("li")[0]?.textContent).toBe("Finished item");

    expect(reader?.querySelector("img[src^='https:']")).toBeNull();
    const imageLink = reader?.querySelector<HTMLAnchorElement>(".vibe-md-remote-image__link");
    expect(imageLink?.href).toBe("https://images.example.test/private.png");
    expect(imageLink?.textContent).toContain("Open image");
    expect(reader?.querySelector(".vibe-md-remote-image__label")?.textContent).toBe("Architecture");

    expect(document.getElementById("vibe-tts-markdown-view-styles")).not.toBeNull();
    expect(document.getElementById("vibe-tts-markdown-marker")).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle")?.textContent,
    ).toContain("View source");
    expect(document.querySelector("meta[name='viewport']")?.getAttribute("content")).toBe(
      "width=device-width, initial-scale=1",
    );

    const spokenText = extractReadingDocument()
      .document.blocks.map((block) => block.text)
      .join(" ");
    expect(spokenText).not.toContain("flowchart");
    expect(spokenText).not.toContain("Browser --> Reader");
  });

  it("identifies flattened Mermaid exports without showing or narrating their CSS", () => {
    const flattenedCss = `#mermaid-r5{font-family:inherit;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}${"#mermaid-r5 .node rect{fill:#eee;stroke:#999;}".repeat(12)}#mermaid-r5 .edgePaths .path{stroke:#666;}`;
    const markdown = `# Exported lesson

Before the diagram.

${flattenedCss}

Client

Cache

The diagram caption remains readable.

[&#xE000;VIBE**TTS**FLATTENEDMERMAID-0&#xE001;](https://example.test/marker)
`;
    loadRawMarkdown(markdown);

    expect(renderMarkdownReadingView()).toBe(true);

    const reader = document.querySelector<HTMLElement>("#vibe-tts-markdown-reader");
    const warning = reader?.querySelector<HTMLElement>(".vibe-md-mermaid-export-warning");
    const source = document.querySelector<HTMLPreElement>("#vibe-tts-markdown-source");
    expect(warning?.getAttribute("role")).toBe("note");
    expect(warning?.getAttribute("aria-labelledby")).toBe("vibe-tts-mermaid-export-0-title");
    expect(warning?.getAttribute("aria-describedby")).toBe("vibe-tts-mermaid-export-0-detail");
    expect(warning?.dataset.vibeTtsNarrationSkip).toBe("true");
    expect(warning?.dataset.vibeTtsMermaidSourceLine).toBe("5");
    expect(warning?.textContent).toContain("Diagram source missing");
    expect(reader?.querySelectorAll(".vibe-md-mermaid-export-warning")).toHaveLength(1);
    expect(reader?.textContent).not.toContain("#mermaid-r5");
    expect(reader?.textContent).toContain("The diagram caption remains readable.");
    const authoredMarkerLink = reader?.querySelector<HTMLAnchorElement>(
      "a[href='https://example.test/marker']",
    );
    expect(authoredMarkerLink?.textContent).toBe("\uE000VIBETTSFLATTENEDMERMAID-0\uE001");
    expect(reader?.querySelector("figure.vibe-md-mermaid")).toBeNull();
    expect(source?.textContent).toBe(markdown);

    const spokenText = extractReadingDocument()
      .document.blocks.map((block) => block.text)
      .join(" ");
    expect(spokenText).not.toContain("#mermaid-r5");
    expect(spokenText).not.toContain("Diagram source missing");
    expect(spokenText).toContain("The diagram caption remains readable.");

    document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle")?.click();
    const sourceSpokenText = extractReadingDocument()
      .document.blocks.map((block) => block.text)
      .join(" ");
    expect(source?.textContent).toBe(markdown);
    expect(sourceSpokenText).not.toContain("#mermaid-r5");
    expect(sourceSpokenText).not.toContain("Diagram source missing");
    expect(sourceSpokenText).toContain("Before the diagram.");
    expect(sourceSpokenText).toContain("Client");
    expect(sourceSpokenText).toContain("Cache");
    expect(sourceSpokenText).toContain("The diagram caption remains readable.");
  });

  it("renders case-insensitive Mermaid, mmd, Pandoc, and tilde fence variants", () => {
    loadRawMarkdown(`# Mermaid variants

\`\`\`Mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`mMd
flowchart LR
  B --> C
\`\`\`

\`\`\`{.mermaid}
flowchart LR
  C --> D
\`\`\`

~~~{.MMD}
flowchart LR
  D --> E
~~~
`);

    expect(renderMarkdownReadingView()).toBe(true);
    const diagrams = Array.from(document.querySelectorAll<HTMLElement>("figure.vibe-md-mermaid"));
    expect(diagrams).toHaveLength(4);
    expect(diagrams.every((diagram) => diagram.dataset.vibeTtsMermaidState === "pending")).toBe(
      true,
    );
    expect(diagrams.map((diagram) => diagram.querySelector("code")?.textContent?.trim())).toEqual([
      "flowchart LR\n  A --> B",
      "flowchart LR\n  B --> C",
      "flowchart LR\n  C --> D",
      "flowchart LR\n  D --> E",
    ]);
  });

  it("is conservative and idempotent", () => {
    document.documentElement.innerHTML =
      "<head></head><body><main><h1>Existing page</h1><p>Leave this alone.</p></main></body>";
    Object.defineProperty(document, "contentType", { configurable: true, value: "text/html" });
    expect(renderMarkdownReadingView()).toBe(false);
    expect(document.querySelector("main")?.textContent).toContain("Leave this alone.");

    loadRawMarkdown("# One title\n\nOne paragraph.");
    expect(renderMarkdownReadingView()).toBe(true);
    expect(renderMarkdownReadingView()).toBe(false);
    expect(document.querySelectorAll("#vibe-tts-markdown-reader")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-source")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-marker")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-view-toggle")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-read-gutter")).toHaveLength(1);
  });

  it("preserves the exact raw source and exposes an accessible reversible view action", () => {
    const originalTitle = "notes.md";
    const markdown = `---
title: Private metadata
---
# Toggle **fixture**

Read [the private source](https://example.test/private).

<!-- hidden author note -->

\`\`\`mermaid
flowchart LR
  Raw --> Rendered
\`\`\`

Trailing line.
`;
    loadRawMarkdown(markdown);
    document.title = originalTitle;

    expect(renderMarkdownReadingView()).toBe(true);

    const reader = document.querySelector<HTMLElement>("#vibe-tts-markdown-reader");
    const source = document.querySelector<HTMLPreElement>("#vibe-tts-markdown-source");
    const marker = document.querySelector<HTMLElement>("#vibe-tts-markdown-marker");
    const toggle = document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle");
    expect(reader).not.toBeNull();
    expect(source?.textContent).toBe(markdown);
    expect(source?.hidden).toBe(true);
    expect(source?.hasAttribute("inert")).toBe(true);
    expect(reader?.hidden).toBe(false);
    expect(reader?.hasAttribute("inert")).toBe(false);
    expect(marker?.getAttribute("aria-label")).toBe("Markdown view controls");
    expect(marker?.hasAttribute("aria-hidden")).toBe(false);
    expect(marker?.dataset.vibeTtsNarrationSkip).toBe("true");
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.textContent).toContain("View source");
    expect(toggle?.getAttribute("aria-controls")).toContain("vibe-tts-markdown-reader");
    expect(toggle?.getAttribute("aria-controls")).toContain("vibe-tts-markdown-source");
    expect(document.title).toBe("Toggle fixture");

    toggle?.focus();
    toggle?.click();
    expect(document.activeElement).toBe(toggle);
    expect(document.documentElement.dataset.vibeTtsMarkdownView).toBe("source");
    expect(source?.hidden).toBe(false);
    expect(source?.hasAttribute("inert")).toBe(false);
    expect(reader?.hidden).toBe(true);
    expect(reader?.hasAttribute("inert")).toBe(true);
    expect(toggle?.textContent).toContain("View rendered");
    expect(document.title).toBe(originalTitle);
    expect(source?.textContent).toBe(markdown);

    toggle?.click();
    expect(document.activeElement).toBe(toggle);
    expect(document.documentElement.dataset.vibeTtsMarkdownView).toBe("rendered");
    expect(source?.hidden).toBe(true);
    expect(source?.hasAttribute("inert")).toBe(true);
    expect(reader?.hidden).toBe(false);
    expect(reader?.hasAttribute("inert")).toBe(false);
    expect(toggle?.textContent).toContain("View source");
    expect(document.title).toBe("Toggle fixture");
    expect(source?.textContent).toBe(markdown);

    expect(renderMarkdownReadingView()).toBe(false);
    expect(document.querySelectorAll("#vibe-tts-markdown-reader")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-source")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-marker")).toHaveLength(1);
    expect(document.querySelectorAll("#vibe-tts-markdown-view-toggle")).toHaveLength(1);
  });

  it("keeps one rendered Mermaid placeholder and its state across source round trips", () => {
    loadRawMarkdown(`# Architecture

\`\`\`mermaid
flowchart LR
  Browser --> Reader
\`\`\`
`);
    expect(renderMarkdownReadingView()).toBe(true);

    const diagram = document.querySelector<HTMLElement>("figure.vibe-md-mermaid");
    const toggle = document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle");
    expect(diagram?.dataset.vibeTtsMermaidState).toBe("pending");
    diagram?.setAttribute("data-vibe-tts-mermaid-state", "rendered");

    toggle?.click();
    expect(diagram?.isConnected).toBe(true);
    expect(diagram?.closest("#vibe-tts-markdown-reader")?.hasAttribute("hidden")).toBe(true);

    toggle?.click();
    expect(document.querySelector("figure.vibe-md-mermaid")).toBe(diagram);
    expect(diagram?.dataset.vibeTtsMermaidState).toBe("rendered");
    expect(document.querySelectorAll("figure.vibe-md-mermaid")).toHaveLength(1);
  });

  it("extracts source prose without narrating controls, metadata, URLs, or Mermaid syntax", () => {
    loadRawMarkdown(`---
title: Private metadata
---
# Raw **reading**

Read [the visible label](https://example.test/private).

\`\`\`mermaid
flowchart LR
  Secret --> Syntax
\`\`\`

Closing prose.
`);
    expect(renderMarkdownReadingView()).toBe(true);
    document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle")?.click();

    const extraction = extractReadingDocument();
    expect(extraction.document.blocks.map((block) => [block.type, block.text])).toEqual([
      ["heading", "Raw reading"],
      ["paragraph", "Read the visible label."],
      ["paragraph", "Closing prose."],
    ]);
    const spokenText = extraction.document.blocks.map((block) => block.text).join(" ");
    expect(spokenText).not.toContain("View rendered");
    expect(spokenText).not.toContain("Vibe TTS");
    expect(spokenText).not.toContain("Private metadata");
    expect(spokenText).not.toContain("example.test");
    expect(spokenText).not.toContain("flowchart");
    expect(spokenText).not.toContain("Secret");
  });

  it("restores the last selection belonging to each view", () => {
    const pre = loadRawMarkdown("# Notes\n\nChoose **rendered words** and raw syntax.");
    const rawText = pre.firstChild as Text;
    const initialRange = document.createRange();
    initialRange.setStart(rawText, rawText.data.indexOf("**rendered"));
    initialRange.setEnd(rawText, rawText.data.indexOf("words**") + "words**".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(initialRange);
    expect(renderMarkdownReadingView()).toBe(true);
    expect(selection?.toString()).toBe("rendered words");

    const toggle = document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle");
    toggle?.click();
    expect(selection?.toString()).toBe("**rendered words**");

    const source = document.querySelector<HTMLPreElement>("#vibe-tts-markdown-source");
    const sourceText = source?.firstChild;
    expect(sourceText).toBeInstanceOf(Text);
    const sourceRange = document.createRange();
    sourceRange.setStart(sourceText as Text, (sourceText as Text).data.indexOf("raw syntax"));
    sourceRange.setEnd(
      sourceText as Text,
      (sourceText as Text).data.indexOf("raw syntax") + "raw syntax".length,
    );
    selection?.removeAllRanges();
    selection?.addRange(sourceRange);
    expect(selection?.toString()).toBe("raw syntax");

    toggle?.click();
    expect(selection?.toString()).toBe("rendered words");
    toggle?.click();
    expect(selection?.toString()).toBe("raw syntax");
  });

  it("restores an independent page scroll position for each view", () => {
    loadRawMarkdown("# Notes\n\n" + "A long paragraph. ".repeat(300));
    const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const originalRootHeight = Object.getOwnPropertyDescriptor(
      document.documentElement,
      "scrollHeight",
    );
    const originalBodyHeight = Object.getOwnPropertyDescriptor(document.body, "scrollHeight");
    let scrollY = 200;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    Object.defineProperty(document.body, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((_left, top) => {
      scrollY = top;
    });
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    try {
      expect(renderMarkdownReadingView()).toBe(true);
      const toggle = document.querySelector<HTMLButtonElement>("#vibe-tts-markdown-view-toggle");

      scrollY = 420;
      toggle?.click();
      expect(scrollTo).toHaveBeenLastCalledWith(0, 200);

      scrollY = 720;
      toggle?.click();
      expect(scrollTo).toHaveBeenLastCalledWith(0, 420);
    } finally {
      scrollTo.mockRestore();
      requestAnimationFrame.mockRestore();
      if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
      else Reflect.deleteProperty(window, "scrollY");
      if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
      else Reflect.deleteProperty(window, "innerHeight");
      if (originalRootHeight) {
        Object.defineProperty(document.documentElement, "scrollHeight", originalRootHeight);
      } else {
        Reflect.deleteProperty(document.documentElement, "scrollHeight");
      }
      if (originalBodyHeight) {
        Object.defineProperty(document.body, "scrollHeight", originalBodyHeight);
      } else {
        Reflect.deleteProperty(document.body, "scrollHeight");
      }
    }
  });

  it("preserves a prose selection when Markdown punctuation disappears", () => {
    const pre = loadRawMarkdown(
      "# Notes\n\nChoose **these important words** and keep the selection visible.",
    );
    const text = pre.firstChild;
    expect(text).toBeInstanceOf(Text);
    const source = (text as Text).data;
    const range = document.createRange();
    range.setStart(text as Text, source.indexOf("**these"));
    range.setEnd(text as Text, source.indexOf("words**") + "words**".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(renderMarkdownReadingView()).toBe(true);
    expect(window.getSelection()?.toString()).toBe("these important words");
    expect(document.querySelector("strong")?.textContent).toBe("these important words");
    expect(document.body.textContent).not.toContain("VIBETTSSTART");
    expect(document.body.textContent).not.toContain("VIBETTSEND");
  });

  it("projects Select All past frontmatter and trailing source whitespace", () => {
    const pre = loadRawMarkdown(`---
title: Hidden metadata
---

# Notes

Readable **ending**.
`);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(renderMarkdownReadingView()).toBe(true);
    expect(document.querySelector("#vibe-tts-markdown-reader")?.textContent).not.toContain(
      "Hidden metadata",
    );
    expect(selection?.toString()).toContain("Notes");
    expect(selection?.toString()).toContain("Readable ending.");
    expect(selection?.toString()).not.toContain("---");
  });

  it("keeps selections out of link destinations and formatting delimiters", () => {
    const pre = loadRawMarkdown(
      "# Notes\n\nRead **bold words** and [visible label](https://private.example/path).",
    );
    const text = pre.firstChild as Text;
    const source = text.data;
    const range = document.createRange();
    range.setStart(text, source.indexOf("**bold"));
    range.setEnd(text, source.indexOf("path)") + "path)".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(renderMarkdownReadingView()).toBe(true);
    expect(selection?.toString()).toBe("bold words and visible label");
    expect(document.querySelector("strong")?.textContent).toBe("bold words");
    expect(document.querySelector("a")?.textContent).toBe("visible label");
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://private.example/path");
  });

  it("keeps table syntax intact when a selection touches row delimiters", () => {
    const pre = loadRawMarkdown(`# Notes

| Company | Status |
| --- | --- |
| Vanta | Ready |
`);
    const text = pre.firstChild as Text;
    const source = text.data;
    const range = document.createRange();
    range.setStart(text, source.indexOf("| ---"));
    range.setEnd(text, source.indexOf("Ready |") + "Ready |".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(renderMarkdownReadingView()).toBe(true);
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector("td")?.textContent).toBe("Vanta");
    expect(selection?.toString()).toContain("Vanta");
    expect(selection?.toString()).toContain("Ready");
    expect(document.body.textContent).not.toContain("VIBETTSSTART");
    expect(document.body.textContent).not.toContain("VIBETTSEND");
  });
});
