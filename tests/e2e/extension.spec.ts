import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = resolve(import.meta.dirname, "../../apps/chrome-extension/dist");
const reviewPath = resolve(import.meta.dirname, "../../.impeccable/review");

function createTestExtension(hostPermissions: string[] = ["https://reader.test/*"]): {
  path: string;
  dispose: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), "vibe-tts-extension-"));
  cpSync(extensionPath, path, { recursive: true });
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = hostPermissions;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return { path, dispose: () => rmSync(path, { force: true, recursive: true }) };
}

function createMarkdownFixture(): { url: string; source: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "vibe-tts-markdown-"));
  const path = join(directory, "reader-fixture.md");
  const filler = Array.from(
    { length: 70 },
    (_, index) =>
      `## Context ${index + 1}\n\nParagraph ${index + 1} keeps the raw document tall enough to test range scrolling.`,
  ).join("\n\n");
  const source = `---\ntitle: Hidden metadata\n---\n\n# Local Markdown Reader\n\nRead **formatted prose** and [visible labels](https://example.test/private-path), not Markdown punctuation or link destinations.\n\n> A useful quotation keeps its reading hierarchy.\n\n- First readable item\n- Second readable item\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n| Signal | Status |\n| --- | --- |\n| Semantic HTML | Ready |\n\n## Architecture diagram\n\n\`\`\`mermaid\nflowchart LR\n  BrowserMarkdownSourceToken["Markdown file"] --> RenderedReaderTargetToken["Vibe TTS"]\n\`\`\`\n\n## Broken diagram\n\n\`\`\`mermaid\nflowchart LR\n  BrokenMermaidSourceToken -->[\n\`\`\`\n\n![Remote diagram](https://assets.example.test/should-not-load.png)\n\n${filler}\n\n## Final section\n\nTarget sentence sits near the end for exact highlighting.\n`;
  writeFileSync(path, source);
  return {
    url: pathToFileURL(path).href,
    source,
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
}

function createInlineReadMarkdownFixture(): { url: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "vibe-tts-inline-read-"));
  const path = join(directory, "inline-read-fixture.md");
  writeFileSync(
    path,
    `# Inline reading check

Opening text comes before the requested starting point.

## Choose a starting point

This deliberate paragraph is the requested starting point for the inline reading control. Its second sentence should follow after the first.

## Closing section

Trailing text comes after the requested starting point.
`,
  );
  return {
    url: pathToFileURL(path).href,
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
}

async function launchExtension(path: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext("", {
    // Playwright's bundled Chromium retains extension-loading flags that
    // branded Chrome no longer accepts for automated side-loading.
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`, "--no-first-run"],
  });
}

test.describe("loaded extension", () => {
  let context: BrowserContext;

  test.beforeEach(async () => {
    context = await launchExtension(extensionPath);
  });

  test.afterEach(async () => {
    await context?.close();
  });

  test("loads the MV3 worker and accessible side-panel surface", async () => {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await expect(page.getByRole("heading", { name: /read with the page/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /play reading/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /read selection/i })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /voice engine/i })).toBeVisible();
  });

  test("renders the active reader surface without horizontal overflow", async () => {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const bootstrap = {
        snapshot: {
          sessionId: "review-session",
          status: "playing",
          documentTitle: "The Art of Listening",
          documentUrl: "https://example.test/listening",
          currentBlockId: "block-4",
          currentSentenceId: "sentence-8",
          currentSentenceText:
            "Close listening changes the shape of a room before anyone says another word.",
          currentWordId: "word-6",
          currentWordText: "shape",
          currentSentenceIndex: 7,
          sentenceCount: 24,
          positionMs: 2_640,
          durationMs: 6_400,
          playbackRate: 1,
          providerId: "browser",
          voiceId: "browser:review",
          alignmentProviderId: "browser-boundary",
          bufferedSentenceCount: 3,
          autoScroll: true,
          startMode: "beginning",
          hasSelection: false,
          serverConnected: true,
        },
        preferences: {
          playbackRate: 1,
          providerId: "browser",
          voiceId: "browser:review",
          autoScroll: true,
          serverUrl: "http://127.0.0.1:8765",
        },
        catalog: {
          providers: [
            {
              id: "browser",
              name: "Browser speech",
              available: true,
              local: true,
              status: "ready",
              capabilities: {
                streaming: true,
                voiceSelection: true,
                voiceCloning: false,
                voiceDesign: false,
                nativeAlignment: true,
              },
            },
            {
              id: "mock",
              name: "Deterministic local",
              available: true,
              local: true,
              status: "ready",
              capabilities: {
                streaming: false,
                voiceSelection: true,
                voiceCloning: false,
                voiceDesign: false,
                nativeAlignment: true,
              },
            },
          ],
          voices: [
            {
              id: "browser:review",
              name: "System English",
              language: "en-US",
              providerId: "browser",
              isDefault: true,
            },
          ],
          serverConnected: true,
        },
      };
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: (message: { type?: string; requestId?: string }) =>
          Promise.resolve({
            ok: true,
            requestId: message.requestId ?? "review",
            ...(message.type === "request-state" ? { data: bootstrap } : {}),
          }),
      });
    });
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.getByRole("heading", { name: "The Art of Listening" })).toBeVisible();
    await expect(page.getByRole("button", { name: /pause reading/i })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    mkdirSync(reviewPath, { recursive: true });
    await page.screenshot({ path: resolve(reviewPath, "desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 320, height: 740 });
    await expect(page.getByRole("heading", { name: "The Art of Listening" })).toBeVisible();
    const mobileOverflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(mobileOverflow.scrollWidth).toBeLessThanOrEqual(mobileOverflow.clientWidth);
    await page.screenshot({ path: resolve(reviewPath, "mobile.png"), fullPage: true });
  });

  test("prepares a real page, moves exact DOM highlights, and clears them on stop", async () => {
    await context.close();
    const testExtension = createTestExtension();
    context = await launchExtension(testExtension.path);

    try {
      await context.route("https://reader.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html>
            <html><head><title>Reader integration</title></head><body>
              <nav>Skip this navigation.</nav>
              <main><article>
                <h1>Reader integration</h1>
                <p>First <strong>important</strong> sentence. Second sentence moves the focus.</p>
              </article></main>
            </body></html>`,
        }),
      );
      const article = await context.newPage();
      await article.goto("https://reader.test/article");

      let worker = context.serviceWorkers()[0];
      worker ??= await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const harness = await context.newPage();
      await harness.addInitScript(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        Object.defineProperty(globalThis, "__vibeRealSendMessage", {
          configurable: true,
          value: original,
        });
        Object.defineProperty(chrome.runtime, "sendMessage", {
          configurable: true,
          value: (message: { type?: string; requestId?: string }) =>
            Promise.resolve({
              ok: true,
              requestId: message.requestId ?? "harness",
              ...(message.type === "request-state"
                ? {
                    data: {
                      snapshot: {
                        status: "paused",
                        sessionId: "harness",
                        currentSentenceIndex: 0,
                        sentenceCount: 1,
                        positionMs: 0,
                        playbackRate: 1,
                        providerId: "browser",
                        bufferedSentenceCount: 0,
                        autoScroll: true,
                        startMode: "beginning",
                        hasSelection: false,
                      },
                      preferences: {
                        playbackRate: 1,
                        providerId: "browser",
                        autoScroll: true,
                        serverUrl: "http://127.0.0.1:8765",
                      },
                    },
                  }
                : {}),
            }),
        });
      });
      await harness.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await article.bringToFront();

      const prepared = await harness.evaluate(async () => {
        const send = (
          globalThis as typeof globalThis & {
            __vibeRealSendMessage: (message: unknown) => Promise<unknown>;
          }
        ).__vibeRealSendMessage;
        await send({
          type: "panel-command",
          requestId: crypto.randomUUID(),
          source: "sidepanel",
          target: "background",
          command: { type: "prepare", startMode: "beginning" },
        });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Active article tab was not found.");
        const response: unknown = await chrome.tabs.sendMessage(tab.id, {
          type: "content-command",
          requestId: crypto.randomUUID(),
          source: "background",
          target: "content",
          command: { type: "prepare", startMode: "beginning" },
        });
        return response;
      });

      const typedPrepared = prepared as {
        ok: boolean;
        data?: {
          document?: {
            blocks?: Array<{
              id: string;
              sentences: Array<{
                id: string;
                words: Array<{ id: string; text: string }>;
              }>;
            }>;
          };
        };
      };
      expect(typedPrepared.ok).toBe(true);
      const block = typedPrepared.data?.document?.blocks?.find((entry) =>
        entry.sentences.some((sentence) =>
          sentence.words.some((word) => word.text === "important"),
        ),
      );
      const firstSentence = block?.sentences[0];
      const secondSentence = block?.sentences[1];
      const important = firstSentence?.words.find((word) => word.text === "important");
      expect(block).toBeDefined();
      expect(firstSentence).toBeDefined();
      expect(secondSentence).toBeDefined();
      expect(important).toBeDefined();

      const sendContent = async (command: unknown): Promise<void> => {
        await harness.evaluate(async (nextCommand) => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Active article tab was not found.");
          await chrome.tabs.sendMessage(tab.id, {
            type: "content-command",
            requestId: crypto.randomUUID(),
            source: "background",
            target: "content",
            command: nextCommand,
          });
        }, command);
      };

      await sendContent({
        type: "highlight",
        blockId: block?.id,
        sentenceId: firstSentence?.id,
        wordId: important?.id,
      });
      await expect
        .poll(() =>
          article.evaluate(() => ({
            sentence: Array.from(CSS.highlights.get("reader-current-sentence") ?? []).map(
              (range) => (range instanceof Range ? range.toString() : ""),
            ),
            word: Array.from(CSS.highlights.get("reader-current-word") ?? []).map((range) =>
              range instanceof Range ? range.toString() : "",
            ),
          })),
        )
        .toEqual({ sentence: ["First important sentence."], word: ["important"] });

      await sendContent({
        type: "highlight",
        blockId: block?.id,
        sentenceId: secondSentence?.id,
      });
      await expect
        .poll(() =>
          article.evaluate(() =>
            Array.from(CSS.highlights.get("reader-current-sentence") ?? []).map((range) =>
              range instanceof Range ? range.toString() : "",
            ),
          ),
        )
        .toEqual(["Second sentence moves the focus."]);

      await harness.evaluate(async () => {
        const send = (
          globalThis as typeof globalThis & {
            __vibeRealSendMessage: (message: unknown) => Promise<unknown>;
          }
        ).__vibeRealSendMessage;
        await send({
          type: "panel-command",
          requestId: crypto.randomUUID(),
          source: "sidepanel",
          target: "background",
          command: { type: "stop" },
        });
      });
      await expect
        .poll(() =>
          article.evaluate(
            () =>
              !CSS.highlights.has("reader-current-sentence") &&
              !CSS.highlights.has("reader-current-word"),
          ),
        )
        .toBe(true);
    } finally {
      await context.close();
      testExtension.dispose();
    }
  });

  test("renders, reads, highlights, and scrolls a local Markdown file", async () => {
    await context.close();
    const testExtension = createTestExtension(["file:///*"]);
    const markdown = createMarkdownFixture();
    context = await launchExtension(testExtension.path);

    try {
      let remoteImageRequests = 0;
      await context.route("https://assets.example.test/**", async (route) => {
        remoteImageRequests += 1;
        await route.fulfill({
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw1VGwAAAABJRU5ErkJggg==",
            "base64",
          ),
          contentType: "image/png",
        });
      });
      const filePage = await context.newPage();
      await filePage.setViewportSize({ width: 900, height: 360 });
      await filePage.addInitScript(() => {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            Object.defineProperty(globalThis, "__vibeInitialMarkdownTitle", {
              configurable: true,
              value: document.title,
            });
          },
          { once: true },
        );
      });
      await filePage.goto(markdown.url);
      await expect(filePage.locator("body > pre")).toHaveCount(1);
      await expect(filePage.locator("body > pre")).toContainText("# Local Markdown Reader");
      const originalDocumentTitle = await filePage.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __vibeInitialMarkdownTitle?: string;
            }
          ).__vibeInitialMarkdownTitle ?? document.title,
      );

      let worker = context.serviceWorkers()[0];
      worker ??= await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const harness = await context.newPage();
      await harness.addInitScript(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        Object.defineProperty(globalThis, "__vibeRealSendMessage", {
          configurable: true,
          value: original,
        });
        Object.defineProperty(chrome.runtime, "sendMessage", {
          configurable: true,
          value: (message: { type?: string; requestId?: string }) =>
            Promise.resolve({
              ok: true,
              requestId: message.requestId ?? "markdown-harness",
              ...(message.type === "request-state"
                ? {
                    data: {
                      snapshot: {
                        status: "paused",
                        currentSentenceIndex: 0,
                        sentenceCount: 1,
                        positionMs: 0,
                        playbackRate: 1,
                        providerId: "browser",
                        bufferedSentenceCount: 0,
                        autoScroll: true,
                        startMode: "beginning",
                        hasSelection: false,
                      },
                      preferences: {
                        playbackRate: 1,
                        providerId: "browser",
                        autoScroll: true,
                        serverUrl: "http://127.0.0.1:8765",
                      },
                    },
                  }
                : {}),
            }),
        });
      });
      await harness.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await filePage.bringToFront();

      const prepared = await harness.evaluate(async () => {
        const send = (
          globalThis as typeof globalThis & {
            __vibeRealSendMessage: (message: unknown) => Promise<unknown>;
          }
        ).__vibeRealSendMessage;
        await send({
          type: "panel-command",
          requestId: crypto.randomUUID(),
          source: "sidepanel",
          target: "background",
          command: { type: "prepare", startMode: "beginning" },
        });
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Active Markdown tab was not found.");
        const response: unknown = await chrome.tabs.sendMessage(tab.id, {
          type: "content-command",
          requestId: crypto.randomUUID(),
          source: "background",
          target: "content",
          command: { type: "prepare", startMode: "beginning" },
        });
        return response;
      });

      const typedPrepared = prepared as {
        ok: boolean;
        data?: {
          document?: {
            blocks?: Array<{
              id: string;
              text: string;
              sentences: Array<{
                id: string;
                text: string;
                words: Array<{ id: string; text: string }>;
              }>;
            }>;
          };
        };
      };
      expect(typedPrepared.ok).toBe(true);

      const reader = filePage.locator("main#vibe-tts-markdown-reader");
      const source = filePage.locator("pre#vibe-tts-markdown-source");
      const viewToggle = filePage.locator("button#vibe-tts-markdown-view-toggle");
      await expect(reader).toBeVisible();
      await expect(reader).not.toHaveAttribute("inert", "");
      await expect(source).toBeHidden();
      await expect(source).toHaveAttribute("inert", "");
      expect(await source.textContent()).toBe(markdown.source);
      await expect(viewToggle).toBeVisible();
      await expect(viewToggle).toHaveAccessibleName("View source");
      await expect(filePage).toHaveTitle("Local Markdown Reader");
      await expect(
        reader.getByRole("heading", { level: 1, name: "Local Markdown Reader" }),
      ).toBeVisible();
      await expect(reader.locator("strong")).toHaveText("formatted prose");
      await expect(reader.getByRole("link", { name: "visible labels" })).toHaveAttribute(
        "href",
        "https://example.test/private-path",
      );
      await expect(reader.locator("blockquote")).toContainText(
        "A useful quotation keeps its reading hierarchy.",
      );
      await expect(reader.getByRole("listitem")).toHaveCount(2);
      await expect(reader.locator("pre > code.language-ts")).toHaveText("const answer = 42;");
      await expect(reader.getByRole("table")).toBeVisible();
      await expect(reader.getByRole("columnheader", { name: "Signal" })).toBeVisible();
      await expect(reader.getByRole("cell", { name: "Semantic HTML" })).toBeVisible();

      const diagrams = reader.locator("figure.vibe-md-mermaid");
      await expect(diagrams).toHaveCount(2);
      const renderedDiagram = diagrams.nth(0);
      await expect(renderedDiagram).toHaveAttribute("data-vibe-tts-mermaid-state", "rendered");
      const renderedCanvas = renderedDiagram.locator(".vibe-md-mermaid__canvas");
      await expect(renderedCanvas).toHaveAttribute("role", "img");
      await expect(renderedCanvas).toHaveAttribute("aria-label", "Mermaid diagram");
      await expect(renderedCanvas.locator("svg")).toHaveCount(1);
      await expect(renderedCanvas.locator("svg")).toHaveAttribute("aria-hidden", "true");
      await expect(
        renderedDiagram.locator('aside.vibe-md-mermaid__status[role="status"]'),
      ).toHaveText("Mermaid diagram");
      const renderedSource = renderedDiagram.locator("details.vibe-md-mermaid__source");
      await expect(renderedSource.locator("summary")).toHaveText("View diagram source");
      await expect(renderedSource.locator("pre > code.language-mermaid")).toContainText(
        "BrowserMarkdownSourceToken",
      );
      await expect(renderedSource).not.toHaveAttribute("open", "");

      const invalidDiagram = diagrams.nth(1);
      await expect(invalidDiagram).toHaveAttribute("data-vibe-tts-mermaid-state", "error");
      await expect(invalidDiagram.locator(".vibe-md-mermaid__canvas")).toHaveAttribute(
        "aria-label",
        "Mermaid diagram could not be rendered",
      );
      await expect(
        invalidDiagram.locator('aside.vibe-md-mermaid__status[role="status"]'),
      ).toHaveText("Couldn’t render this Mermaid diagram. Source is preserved below.");
      const invalidSource = invalidDiagram.locator("details.vibe-md-mermaid__source");
      await expect(invalidSource).toHaveAttribute("open", "");
      await expect(invalidSource.locator("summary")).toHaveText("View diagram source");
      await expect(invalidSource.locator("pre > code.language-mermaid")).toContainText(
        "BrokenMermaidSourceToken -->[",
      );
      await expect(reader.locator('img[src^="https://assets.example.test/"]')).toHaveCount(0);
      expect(remoteImageRequests).toBe(0);

      const renderedAppearance = await reader.evaluate((element) => {
        const paragraph = element.querySelector("p");
        const link = element.querySelector("a");
        const code = element.querySelector("pre");
        const table = element.querySelector("table");
        if (!paragraph || !link || !code || !table) {
          throw new Error("Rendered Markdown primitives were not found.");
        }
        const paragraphStyle = getComputedStyle(paragraph);
        const linkStyle = getComputedStyle(link);
        const codeStyle = getComputedStyle(code);
        const tableStyle = getComputedStyle(table);
        return {
          codeBackgroundDiffers:
            codeStyle.backgroundColor !== getComputedStyle(element).backgroundColor,
          linkColorDiffers: linkStyle.color !== paragraphStyle.color,
          tableDisplay: tableStyle.display,
          text: paragraph.textContent,
        };
      });
      expect(renderedAppearance).toMatchObject({
        codeBackgroundDiffers: true,
        linkColorDiffers: true,
        tableDisplay: "table",
        text: "Read formatted prose and visible labels, not Markdown punctuation or link destinations.",
      });

      const blocks = typedPrepared.data?.document?.blocks ?? [];
      expect(blocks.some((block) => block.text === "Local Markdown Reader")).toBe(true);
      expect(blocks.some((block) => block.text.includes("Hidden metadata"))).toBe(false);
      expect(blocks.some((block) => block.text.includes("https://example.test"))).toBe(false);
      expect(blocks.some((block) => block.text.includes("**formatted prose**"))).toBe(false);
      expect(
        blocks.some(
          (block) =>
            block.text.includes("BrowserMarkdownSourceToken") ||
            block.text.includes("RenderedReaderTargetToken") ||
            block.text.includes("BrokenMermaidSourceToken") ||
            block.text.includes("flowchart LR"),
        ),
      ).toBe(false);

      const targetBlock = blocks.find((block) => block.text.includes("Target sentence"));
      const targetSentence = targetBlock?.sentences.find((sentence) =>
        sentence.text.includes("Target sentence"),
      );
      const targetWord = targetSentence?.words.find((word) => word.text === "highlighting");
      expect(targetBlock).toBeDefined();
      expect(targetSentence).toBeDefined();
      expect(targetWord).toBeDefined();
      expect(await filePage.evaluate(() => window.scrollY)).toBe(0);

      await harness.evaluate(
        async ({ blockId, sentenceId, wordId }) => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Active Markdown tab was not found.");
          await chrome.tabs.sendMessage(tab.id, {
            type: "content-command",
            requestId: crypto.randomUUID(),
            source: "background",
            target: "content",
            command: { type: "highlight", blockId, sentenceId, wordId },
          });
        },
        {
          blockId: targetBlock?.id ?? "",
          sentenceId: targetSentence?.id ?? "",
          wordId: targetWord?.id ?? "",
        },
      );

      await expect
        .poll(() =>
          filePage.evaluate(() => ({
            scrollY: window.scrollY,
            sentence: Array.from(CSS.highlights.get("reader-current-sentence") ?? []).map(
              (range) => (range instanceof Range ? range.toString() : ""),
            ),
            word: Array.from(CSS.highlights.get("reader-current-word") ?? []).map((range) =>
              range instanceof Range ? range.toString() : "",
            ),
          })),
        )
        .toEqual({
          scrollY: expect.any(Number),
          sentence: ["Target sentence sits near the end for exact highlighting."],
          word: ["highlighting"],
        });
      await expect.poll(() => filePage.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      const horizontalOverflow = await filePage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(horizontalOverflow.scrollWidth).toBeLessThanOrEqual(horizontalOverflow.clientWidth);

      const markdownReviewPath = resolve(reviewPath, "markdown");
      mkdirSync(markdownReviewPath, { recursive: true });
      await filePage.emulateMedia({ reducedMotion: "reduce" });
      await filePage.setViewportSize({ width: 1280, height: 900 });
      await reader
        .getByRole("heading", { level: 2, name: "Architecture diagram" })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      await filePage.screenshot({ path: resolve(markdownReviewPath, "desktop.png") });

      await filePage.setViewportSize({ width: 390, height: 844 });
      await filePage.evaluate(() => window.scrollTo(0, 0));
      const mobileControlLayout = await filePage.evaluate(() => {
        const marker = document.querySelector<HTMLElement>("#vibe-tts-markdown-marker");
        const toggle = document.querySelector<HTMLElement>("#vibe-tts-markdown-view-toggle");
        const heading = document.querySelector<HTMLElement>("#vibe-tts-markdown-reader h1");
        if (!marker || !toggle || !heading)
          throw new Error("Mobile Markdown controls were not found.");
        const toggleBox = toggle.getBoundingClientRect();
        const headingBox = heading.getBoundingClientRect();
        return {
          markerPosition: getComputedStyle(marker).position,
          overlapsHeading:
            toggleBox.left < headingBox.right &&
            toggleBox.right > headingBox.left &&
            toggleBox.top < headingBox.bottom &&
            toggleBox.bottom > headingBox.top,
        };
      });
      expect(mobileControlLayout).toEqual({
        markerPosition: "absolute",
        overlapsHeading: false,
      });
      await reader
        .getByRole("heading", { level: 2, name: "Architecture diagram" })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      const mobileOverflow = await filePage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(mobileOverflow.scrollWidth).toBeLessThanOrEqual(mobileOverflow.clientWidth);
      const mobileToggleBox = await viewToggle.boundingBox();
      expect(mobileToggleBox).not.toBeNull();
      expect(mobileToggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(mobileToggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      const mobileDiagramLayout = await renderedCanvas.evaluate((canvas) => {
        const svg = canvas.shadowRoot?.querySelector("svg");
        if (!(svg instanceof SVGElement)) throw new Error("Rendered Mermaid SVG was not found.");
        return {
          canvasClientWidth: canvas.clientWidth,
          canvasScrollWidth: canvas.scrollWidth,
          svgWidth: svg.getBoundingClientRect().width,
        };
      });
      expect(mobileDiagramLayout.svgWidth).toBeGreaterThanOrEqual(630);
      expect(mobileDiagramLayout.canvasScrollWidth).toBeGreaterThan(
        mobileDiagramLayout.canvasClientWidth,
      );
      await filePage.screenshot({ path: resolve(markdownReviewPath, "mobile.png") });

      await filePage.setViewportSize({ width: 900, height: 360 });
      await filePage.evaluate(() => window.scrollTo(0, 0));

      await renderedSource.evaluate((details) => {
        (details as HTMLDetailsElement).open = true;
        Object.defineProperty(globalThis, "__vibeInitialMermaidFigure", {
          configurable: true,
          value: details.closest("figure"),
        });
        Object.defineProperty(globalThis, "__vibeInitialMermaidSvg", {
          configurable: true,
          value: details.closest("figure")?.querySelector("svg"),
        });
      });
      await viewToggle.focus();
      await expect(viewToggle).toBeFocused();
      const renderedScrollTop = await filePage.evaluate(() => {
        const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        const top = Math.round(max * 0.31);
        scrollTo({ behavior: "instant", left: 0, top });
        return scrollY;
      });

      await filePage.keyboard.press("Enter");
      await expect(viewToggle).toBeFocused();
      await expect(viewToggle).toHaveAccessibleName("View rendered");
      await expect(filePage.locator("html")).toHaveAttribute(
        "data-vibe-tts-markdown-view",
        "source",
      );
      await expect(source).toBeVisible();
      await expect(source).not.toHaveAttribute("inert", "");
      expect(await source.textContent()).toBe(markdown.source);
      await expect(reader).toBeHidden();
      await expect(reader).toHaveAttribute("inert", "");
      await expect(filePage).toHaveTitle(originalDocumentTitle);

      const sourcePrepared = await harness.evaluate<{
        ok: boolean;
        data?: { document?: { blocks?: Array<{ text: string }> } };
      }>(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Active Markdown tab was not found.");
        return chrome.tabs.sendMessage(tab.id, {
          type: "content-command",
          requestId: crypto.randomUUID(),
          source: "background",
          target: "content",
          command: { type: "prepare", startMode: "beginning" },
        });
      });
      expect(sourcePrepared.ok).toBe(true);
      const sourceNarration = (sourcePrepared.data?.document?.blocks ?? [])
        .map((block) => block.text)
        .join("\n");
      expect(sourceNarration).toContain("Local Markdown Reader");
      expect(sourceNarration).toContain("Read formatted prose and visible labels");
      expect(sourceNarration).not.toContain("View source");
      expect(sourceNarration).not.toContain("View rendered");
      expect(sourceNarration).not.toContain("Hidden metadata");
      expect(sourceNarration).not.toContain("https://example.test/private-path");
      expect(sourceNarration).not.toContain("BrowserMarkdownSourceToken");
      expect(sourceNarration).not.toContain("RenderedReaderTargetToken");
      expect(sourceNarration).not.toContain("BrokenMermaidSourceToken");
      expect(sourceNarration).not.toContain("flowchart LR");

      const sourceScrollTop = await filePage.evaluate(() => {
        const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        const top = Math.round(max * 0.18);
        scrollTo(0, top);
        return scrollY;
      });
      await filePage.keyboard.press("Space");
      await expect(viewToggle).toBeFocused();
      await expect(viewToggle).toHaveAccessibleName("View source");
      await expect(filePage.locator("html")).toHaveAttribute(
        "data-vibe-tts-markdown-view",
        "rendered",
      );
      await expect(reader).toBeVisible();
      await expect(source).toBeHidden();
      await expect(filePage).toHaveTitle("Local Markdown Reader");
      await expect
        .poll(() => filePage.evaluate(() => window.scrollY))
        .toBeGreaterThanOrEqual(renderedScrollTop - 2);
      expect(
        await filePage.evaluate(
          (expected) => Math.abs(window.scrollY - expected),
          renderedScrollTop,
        ),
      ).toBeLessThanOrEqual(2);
      await expect(renderedDiagram).toHaveAttribute("data-vibe-tts-mermaid-state", "rendered");
      await expect(renderedSource).toHaveAttribute("open", "");
      expect(
        await renderedDiagram.evaluate(
          (figure) =>
            figure ===
              (
                globalThis as typeof globalThis & {
                  __vibeInitialMermaidFigure?: Element;
                }
              ).__vibeInitialMermaidFigure &&
            figure.querySelector("svg") ===
              (
                globalThis as typeof globalThis & {
                  __vibeInitialMermaidSvg?: SVGElement;
                }
              ).__vibeInitialMermaidSvg,
        ),
      ).toBe(true);

      const secondRenderedScrollTop = await filePage.evaluate(() => {
        const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        const top = Math.round(max * 0.66);
        scrollTo(0, top);
        return scrollY;
      });
      await filePage.keyboard.press("Enter");
      await expect
        .poll(() =>
          filePage.evaluate((expected) => Math.abs(window.scrollY - expected), sourceScrollTop),
        )
        .toBeLessThanOrEqual(2);
      await filePage.keyboard.press("Space");
      await expect
        .poll(() =>
          filePage.evaluate(
            (expected) => Math.abs(window.scrollY - expected),
            secondRenderedScrollTop,
          ),
        )
        .toBeLessThanOrEqual(2);

      await filePage.keyboard.press("Enter");
      await filePage.setViewportSize({ width: 1280, height: 900 });
      await filePage.evaluate(() => window.scrollTo(0, 0));
      await filePage.screenshot({ path: resolve(markdownReviewPath, "source-desktop.png") });
      await filePage.setViewportSize({ width: 390, height: 844 });
      await filePage.evaluate(() => window.scrollTo(0, 0));
      const sourceMobileOverflow = await filePage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(sourceMobileOverflow.scrollWidth).toBeLessThanOrEqual(
        sourceMobileOverflow.clientWidth,
      );
      await filePage.screenshot({ path: resolve(markdownReviewPath, "source-mobile.png") });
    } finally {
      await context.close();
      markdown.dispose();
      testExtension.dispose();
    }
  });

  test("starts local Markdown narration from a hovered gutter control", async () => {
    await context.close();
    const testExtension = createTestExtension(["file:///*"]);
    const markdown = createInlineReadMarkdownFixture();
    context = await launchExtension(testExtension.path);

    try {
      const filePage = await context.newPage();
      await filePage.setViewportSize({ width: 900, height: 560 });
      await filePage.goto(markdown.url);

      let worker = context.serviceWorkers()[0];
      worker ??= await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const harness = await context.newPage();
      await harness.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await filePage.bringToFront();
      const activation: unknown = await harness.evaluate(async () => {
        const response: unknown = await chrome.runtime.sendMessage({
          type: "panel-command",
          requestId: crypto.randomUUID(),
          source: "sidepanel",
          target: "background",
          command: { type: "prepare", startMode: "beginning" },
        });
        return response;
      });
      expect(activation).toMatchObject({ ok: true });

      const reader = filePage.locator("main#vibe-tts-markdown-reader");
      const gutter = reader.locator("aside#vibe-tts-markdown-read-gutter");
      const target = reader.getByText(
        "This deliberate paragraph is the requested starting point for the inline reading control.",
        { exact: false },
      );
      const control = gutter.locator(
        "button.vibe-md-read-from-here[data-vibe-tts-read-for='md-3']",
      );

      await expect(reader).toBeVisible();
      await expect(gutter).toBeVisible();
      await expect(control).toHaveAccessibleName(/read from here: this deliberate paragraph/i);
      await expect(control).toHaveCSS("opacity", "0");

      await target.hover();
      await expect(control).toHaveCSS("opacity", "1");
      const controlBox = await control.boundingBox();
      expect(controlBox).not.toBeNull();
      expect(controlBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(controlBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      await filePage.mouse.move(890, 10);
      await expect(control).toHaveCSS("opacity", "0");
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("opacity", "1");
      const focusedControlBox = await control.boundingBox();
      const targetBox = await target.boundingBox();
      expect(focusedControlBox).not.toBeNull();
      expect(targetBox).not.toBeNull();
      expect((focusedControlBox?.x ?? 0) + (focusedControlBox?.width ?? 0) + 6).toBeLessThanOrEqual(
        targetBox?.x ?? 0,
      );

      await control.click();
      await expect(control).toHaveAttribute("data-vibe-tts-read-state", "active");
      expect(
        await control.evaluate((button) => getComputedStyle(button, "::after").backgroundColor),
      ).toBe("rgb(216, 60, 28)");
      await expect
        .poll(() =>
          filePage.evaluate(() =>
            Array.from(CSS.highlights.get("reader-current-sentence") ?? []).map((range) =>
              range instanceof Range ? range.toString() : "",
            ),
          ),
        )
        .toEqual([
          "This deliberate paragraph is the requested starting point for the inline reading control.",
        ]);
      await expect
        .poll(() =>
          gutter
            .locator("button.vibe-md-read-from-here")
            .evaluateAll((buttons) =>
              buttons
                .filter((button) => getComputedStyle(button).opacity === "1")
                .map((button) => button.getAttribute("aria-label")),
            ),
        )
        .toEqual([expect.stringMatching(/reading from here: this deliberate paragraph/i)]);
      const inlineReviewPath = resolve(reviewPath, "markdown-inline");
      mkdirSync(inlineReviewPath, { recursive: true });
      await filePage.emulateMedia({ reducedMotion: "reduce" });
      await filePage.screenshot({ path: resolve(inlineReviewPath, "desktop.png") });

      const viewToggle = filePage.locator("button#vibe-tts-markdown-view-toggle");
      await viewToggle.click();
      await expect(filePage.locator("html")).toHaveAttribute(
        "data-vibe-tts-markdown-view",
        "source",
      );
      await expect(gutter).toBeHidden();
      await expect(gutter).toHaveAttribute("inert", "");

      await viewToggle.click();
      await expect(filePage.locator("html")).toHaveAttribute(
        "data-vibe-tts-markdown-view",
        "rendered",
      );
      await filePage.setViewportSize({ width: 390, height: 844 });
      await target.scrollIntoViewIfNeeded();
      await target.hover();
      await expect(control).toHaveCSS("opacity", "1");

      const mobileLayout = await filePage.evaluate(() => {
        const paragraph = Array.from(
          document.querySelectorAll<HTMLElement>("#vibe-tts-markdown-reader p"),
        ).find((element) => element.textContent?.startsWith("This deliberate paragraph"));
        const button = document.querySelector<HTMLElement>(
          "#vibe-tts-markdown-read-gutter .vibe-md-read-from-here[data-vibe-tts-read-for='md-3']",
        );
        if (!paragraph || !button) throw new Error("Inline reading target was not found.");
        const paragraphBox = paragraph.getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          buttonRight: buttonBox.right,
          paragraphLeft: paragraphBox.left,
        };
      });
      expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.clientWidth);
      expect(mobileLayout.buttonRight).toBeLessThanOrEqual(mobileLayout.paragraphLeft);
      await filePage.screenshot({ path: resolve(inlineReviewPath, "mobile.png") });
    } finally {
      await context.close();
      markdown.dispose();
      testExtension.dispose();
    }
  });
});
