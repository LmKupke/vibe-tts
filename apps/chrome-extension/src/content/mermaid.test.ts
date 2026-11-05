import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  bindFunctions: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidMocks.initialize,
    render: mermaidMocks.render,
  },
}));

import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_TEXT_SIZE,
  hasPendingMermaidDiagrams,
  upgradeMermaidCodeBlocks,
} from "./mermaid";
import { runMermaidEntry } from "./mermaid-entry";
import { renderMermaidDiagrams } from "./mermaid-renderer";

function loadMarkdownHtml(markup: string): HTMLElement {
  document.body.innerHTML = `<main id="reader">${markup}</main>`;
  const root = document.getElementById("reader");
  if (!root) throw new Error("Expected a reader root");
  return root;
}

beforeEach(() => {
  mermaidMocks.initialize.mockReset();
  mermaidMocks.render.mockReset();
  mermaidMocks.bindFunctions.mockReset();
});

afterEach(() => {
  delete window.__vibeTtsMermaidRenderPromise;
  document.body.replaceChildren();
});

describe("Mermaid Markdown enhancement", () => {
  it("upgrades only Mermaid fences and preserves the exact source in an ignored fallback", () => {
    const source = "flowchart LR\n  Browser --> Reader\n";
    const root = loadMarkdownHtml(
      `<p>Readable introduction.</p><pre><code class="language-mermaid"></code></pre><pre><code class="language-ts">const untouched = true;</code></pre>`,
    );
    const code = root.querySelector("code.language-mermaid");
    if (!code) throw new Error("Expected Mermaid code");
    code.textContent = source;

    const figures = upgradeMermaidCodeBlocks(root);

    expect(figures).toHaveLength(1);
    const figure = figures[0];
    expect(figure?.dataset.vibeTtsMermaidState).toBe("pending");
    expect(figure?.querySelector(".vibe-md-mermaid__canvas")?.getAttribute("role")).toBe("img");
    expect(figure?.querySelector(".vibe-md-mermaid__canvas")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(figure?.querySelector("aside[role='status']")?.textContent).toBe("Rendering diagram…");
    expect(figure?.querySelector("details > summary")?.textContent).toBe("View diagram source");
    expect(figure?.querySelector("details pre code")?.textContent).toBe(source);
    expect(figure?.dataset.vibeTtsNarrationSkip).toBe("true");
    expect(hasPendingMermaidDiagrams(root)).toBe(true);
    expect(root.querySelector("pre > code.language-ts")?.textContent).toContain("untouched");

    expect(upgradeMermaidCodeBlocks(root)).toHaveLength(0);
    expect(root.querySelectorAll("figure.vibe-md-mermaid")).toHaveLength(1);
  });

  it("recognizes common Mermaid fence spellings without upgrading other code", () => {
    const root = loadMarkdownHtml(`
      <pre><code class="language-Mermaid">flowchart LR\nA --&gt; B\n</code></pre>
      <pre><code class="language-MMD">flowchart LR\nB --&gt; C\n</code></pre>
      <pre><code class="language-{.mermaid}">flowchart LR\nC --&gt; D\n</code></pre>
      <pre><code class="language-typescript">const mermaid = false;</code></pre>
    `);

    expect(upgradeMermaidCodeBlocks(root)).toHaveLength(3);
    expect(root.querySelectorAll("figure.vibe-md-mermaid")).toHaveLength(3);
    expect(root.querySelector("pre > code.language-typescript")?.textContent).toContain(
      "mermaid = false",
    );
  });

  it("guards the standalone entry against overlapping injected runs", async () => {
    const root = loadMarkdownHtml(
      '<pre><code class="language-mermaid">flowchart LR\nA --&gt; B\n</code></pre>',
    );
    upgradeMermaidCodeBlocks(root);
    let finishFirstRender: ((result: { diagramType: string; svg: string }) => void) | undefined;
    const firstRender = new Promise<{ diagramType: string; svg: string }>((resolve) => {
      finishFirstRender = resolve;
    });
    mermaidMocks.render.mockReturnValueOnce(firstRender).mockResolvedValue({
      diagramType: "flowchart-v2",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Later</text></svg>',
    });

    const firstRun = runMermaidEntry(root);
    expect(firstRun).toBe(window.__vibeTtsMermaidRenderPromise);
    root.insertAdjacentHTML(
      "beforeend",
      '<pre><code class="language-mermaid">flowchart LR\nC --&gt; D\n</code></pre>',
    );
    upgradeMermaidCodeBlocks(root);

    expect(runMermaidEntry(root)).toBe(firstRun);
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);

    finishFirstRender?.({
      diagramType: "flowchart-v2",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>First</text></svg>',
    });
    await firstRun;
    expect(window.__vibeTtsMermaidRenderPromise).toBeUndefined();

    await runMermaidEntry(root);
    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
  });

  it("renders an inert, sanitized SVG with the strict VibeTTS configuration", async () => {
    const source = "flowchart LR\n  A --> B\n";
    const root = loadMarkdownHtml('<pre><code class="language-mermaid"></code></pre>');
    const code = root.querySelector("code");
    if (!code) throw new Error("Expected Mermaid code");
    code.textContent = source;
    upgradeMermaidCodeBlocks(root);

    mermaidMocks.render.mockResolvedValue({
      diagramType: "flowchart-v2",
      bindFunctions: mermaidMocks.bindFunctions,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="steal()" style="background:url(https://evil.test/root.png)">
        <style>@import url(https://evil.test/font.css); .safe { fill: url(#arrow); } .bad { stroke: url(https://evil.test/line); }</style>
        <defs><marker id="arrow"><path d="M0 0L5 5" /></marker></defs>
        <a href="https://evil.test" onclick="steal()"><text>Safe label</text></a>
        <script>steal()</script>
        <foreignObject><div>unsafe HTML</div></foreignObject>
        <image href="https://evil.test/pixel.png" />
        <path class="safe" d="M0 0L10 10" onmouseover="steal()" style="stroke:url(javascript:steal())" />
      </svg>`,
    });

    await expect(renderMermaidDiagrams(root)).resolves.toEqual({ rendered: 1, failed: 0 });

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        maxTextSize: MAX_MERMAID_TEXT_SIZE,
        maxEdges: MAX_MERMAID_EDGES,
        deterministicIds: true,
        deterministicIDSeed: "vibe-tts-mermaid",
        theme: "base",
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^vibe-tts-mermaid-/u),
      source,
    );
    expect(mermaidMocks.bindFunctions).not.toHaveBeenCalled();

    const figure = root.querySelector<HTMLElement>("figure.vibe-md-mermaid");
    const canvas = figure?.querySelector<HTMLElement>(".vibe-md-mermaid__canvas");
    const svg = canvas?.shadowRoot?.querySelector("svg");
    expect(figure?.dataset.vibeTtsMermaidState).toBe("rendered");
    expect(figure?.querySelector(".vibe-md-mermaid__canvas")?.hasAttribute("aria-busy")).toBe(
      false,
    );
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.classList.contains("vibe-md-mermaid__svg")).toBe(true);
    expect(svg?.textContent).toContain("Safe label");
    expect(svg?.querySelector("a,script,foreignObject,image")).toBeNull();
    expect(svg?.querySelector("[onload],[onclick],[onmouseover]")).toBeNull();
    expect(svg?.querySelector("style")?.textContent).toContain("url(#arrow)");
    expect(svg?.querySelector("style")?.textContent).not.toMatch(/@import|https?:/u);
    expect(svg?.getAttribute("style")).not.toContain("https:");
    expect(svg?.querySelector("path.safe")?.getAttribute("style")).not.toContain("javascript:");
    expect(canvas?.shadowRoot?.querySelector("style")?.textContent).toContain("max-width: 100%");
    expect(canvas?.shadowRoot?.querySelector("style")?.textContent).toContain(
      "width: max(100%, 40rem)",
    );
    expect(figure?.querySelector("details pre code")?.textContent).toBe(source);
  });

  it("shows a generic per-diagram error and opens the preserved source fallback", async () => {
    const source = "flowchart LR\n  this is not valid\n";
    const root = loadMarkdownHtml('<pre><code class="language-mermaid"></code></pre>');
    const code = root.querySelector("code");
    if (!code) throw new Error("Expected Mermaid code");
    code.textContent = source;
    upgradeMermaidCodeBlocks(root);
    mermaidMocks.render.mockRejectedValue(new Error("Parser detail that should stay private"));

    await expect(renderMermaidDiagrams(root)).resolves.toEqual({ rendered: 0, failed: 1 });

    const figure = root.querySelector<HTMLElement>("figure.vibe-md-mermaid");
    const canvas = figure?.querySelector(".vibe-md-mermaid__canvas");
    const fallback = figure?.querySelector<HTMLDetailsElement>("details.vibe-md-mermaid__source");
    expect(figure?.dataset.vibeTtsMermaidState).toBe("error");
    expect(canvas?.getAttribute("aria-label")).toBe("Mermaid diagram could not be rendered");
    expect(canvas?.hasAttribute("aria-busy")).toBe(false);
    expect(figure?.querySelector("aside[role='status']")?.textContent).toBe(
      "Couldn’t render this Mermaid diagram. Source is preserved below.",
    );
    expect(fallback?.open).toBe(true);
    expect(fallback?.querySelector("code")?.textContent).toBe(source);
    expect(figure?.textContent).not.toContain("Parser detail");
  });

  it("rejects oversized diagram source before calling Mermaid", async () => {
    const source = `flowchart LR\n${"A".repeat(MAX_MERMAID_TEXT_SIZE)}`;
    const root = loadMarkdownHtml('<pre><code class="language-mermaid"></code></pre>');
    const code = root.querySelector("code");
    if (!code) throw new Error("Expected Mermaid code");
    code.textContent = source;
    upgradeMermaidCodeBlocks(root);

    await expect(renderMermaidDiagrams(root)).resolves.toEqual({ rendered: 0, failed: 1 });

    expect(mermaidMocks.render).not.toHaveBeenCalled();
    expect(root.querySelector("figure")?.getAttribute("data-vibe-tts-mermaid-state")).toBe("error");
  });
});
