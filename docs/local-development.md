# Local development

## Prerequisites

- Node.js 22 or later
- Python 3.11 or 3.12
- Chrome 120 or later
- `uv` for the optional Python service

## Extension

```bash
npm install
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/chrome-extension/dist`.

The toolbar action both grants temporary `activeTab` access and opens the side panel. Restricted pages such as `chrome://` and the Chrome Web Store cannot be scripted.

### Local Markdown files

Chrome gates local files separately from ordinary web pages. To render and read a raw `.md` or `.markdown` file:

1. Open `chrome://extensions` and choose **Details** for the unpacked Vibe TTS extension.
2. Enable **Allow access to file URLs**.
3. Reload the `file:///.../name.md` tab after changing the switch.
4. Click the toolbar action on that tab. The injected content script creates the Vibe TTS reading view beside Chrome's raw `<pre>` before extraction.
5. Start reading from the side panel.

The extension checks this Chrome-controlled setting before it tries to inject the content reader. If access is off, it reports `file-access-denied` with the same recovery steps. The production manifest deliberately keeps the `activeTab` model instead of declaring persistent `file:///*` access: the toolbar gesture grants access only to the active file tab until that tab navigates or closes, and Vibe TTS cannot enumerate the containing directory.

The renderer leaves the exact original `<pre>` mounted and inserts semantic HTML as a sibling. A persistent **View source** / **View rendered** control activates one root and makes the other hidden and inert. The rendered root uses the ordinary extractor; the styled monospace source root uses the raw-Markdown mapper so word and sentence highlights land on spoken prose without including syntax, frontmatter, comments, code, Mermaid definitions, URL destinations, or control copy. Raw HTML is disabled in the Markdown parser, and remote images become labeled links so opening a local document does not silently make network requests.

Both roots stay in the DOM for the life of the page. This preserves generated Mermaid SVGs and open disclosures, while independent snapshots restore the selection and page scroll for each view. The document title uses the first rendered H1 when available and returns to Chrome's original title in source view. A view change invalidates the current extraction: highlights clear, prepared or playing narration stops cleanly, and the next Prepare indexes whichever view is active.

Rendered view adds a left-side **Read from here** control to each H1–H6 and eligible paragraph. Hover a block or focus its control to reveal it; the 44×44 targets use a roving tab stop, with Up and Down Arrow moving to the previous or next block. On coarse pointers, the first tap on non-interactive block text reveals the control without starting narration. Taps on links or other interactive descendants, and taps made while text is selected, leave the control alone.

Activating a control starts at that block's first sentence and continues through the remaining document. The preparing control stays visible, the active state adds the live vermilion cue, and the synchronized highlight begins on the same first sentence. If preparation fails, the control exposes a retry label and icon and can be activated again. The gutter is narration-skipped throughout and is hidden and inert when exact raw source is active.

Fenced `mermaid` blocks use the Mermaid dependency compiled into the extension bundle; no CDN script, remote theme, or rendering service is contacted. Fence names are matched case-insensitively, including `mmd` and Pandoc-style `{.mermaid}` / `{.mmd}` aliases. The integration uses strict security mode, disables Mermaid click interactions and links, and gives each rendered figure an accessible label and status plus a collapsible source fallback. Neither the generated SVG text nor the fallback source enters the `ReadingDocument`, so narration continues with the prose around the diagram. Invalid syntax produces an inline diagram error with the original source still available and does not prevent the rest of the Markdown file from rendering or being read.

The renderer also detects high-confidence standalone flattened Mermaid SVG styles produced by lossy webpage exporters outside quoted or code examples. It replaces only the generated CSS span with an accessible, narration-skipped source-missing note; labels or captions concatenated around the span remain intact, and source view keeps the `<pre>` text unchanged as Chrome exposed it. Raw narration skips the recognized CSS too. The note cannot reconstruct a diagram because those exports no longer contain its nodes and edges as Mermaid source.

Rendering does not edit the file. Reloading the tab removes the tab-local reader and returns to Chrome's original raw view; invoke the extension again to recreate both view states. This is also the fastest way to pick up changes to the Markdown file during development.

For rebuild-on-change development:

```bash
npm run dev
```

Reload the extension after background or manifest changes. Content-script changes require reloading the target page.

## Local server

```bash
uv sync --project services/tts-server --extra dev
uv run --project services/tts-server uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

The mock provider works without neural dependencies. Install the appropriate optional group only on a machine intended to run that model. Neural weights are lazy-loaded on first provider use, not at API startup.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:server
npm run build
npm run test:e2e
```

The Playwright loaded-extension smoke test launches Playwright's bundled Chromium in a headed persistent context. Install the matching browser once with `npx playwright install chromium`; the test does not depend on a locally installed branded Google Chrome and contains no platform-conditional skip. The test-only extension copy grants explicit hosts for its synthetic HTTPS page and temporary Markdown fixture so automation can exercise extraction, highlighting, and scrolling without changing the production permission model. Deterministic unit tests cover speech boundaries and highlights without requiring audible CI output.

The mock server is the end-to-end neural-path test target: it returns real PCM WAV audio and exact sample-derived alignment without downloading model weights. The TADA and Qwen adapters are tested at their contracts and failure boundaries, but the current non-CUDA development host has not performed real model synthesis. Run an explicit synthesis smoke test on the intended CUDA machine before treating either optional provider as deployed.

Neural playback sends only normalized narration units, not the complete page or local file. The prefetch window can synthesize the current unit and up to two following units concurrently; each HTTP request contains at most 4,500 UTF-16 code units plus provider, speed, and optional voice/language fields. The source document's file path and URL metadata, raw Markdown source, untouched document text, selections outside those units, and DOM/source maps are not included in synthesis requests.

## Troubleshooting

- **No readable text:** confirm the page uses ordinary semantic HTML and is not a restricted browser page or cross-origin iframe.
- **Local Markdown is rejected:** enable **Allow access to file URLs** in the extension's Details page, reload the local-file tab, and click the toolbar action again.
- **Markdown still looks raw:** confirm the URL ends in `.md` or `.markdown`, then click the toolbar action; rendering begins only after that user gesture. Reloading intentionally returns to the raw Chrome view.
- **Read from here is not visible:** switch to rendered view, then hover or focus a heading or paragraph. On a touch device, tap the block once to reveal its control; raw source intentionally has no active gutter controls.
- **Narration stopped after switching Markdown views:** this is intentional. View changes invalidate the old DOM map; press Play or Read selection again to prepare the active source or rendered view.
- **Mermaid shows an error instead of a diagram:** open the diagram's source disclosure and validate the fenced block. Vibe TTS preserves invalid source in the page and continues rendering and narrating the surrounding document.
- **Mermaid says its source is missing:** the file contains flattened SVG styling rather than a Mermaid definition. Restore or re-export the original fenced `mermaid` block; generated CSS and loose labels are not enough to recover the graph topology.
- **Word highlight stays at sentence level:** the selected browser voice may not emit word boundaries, or the neural provider returned no valid alignment.
- **Server offline:** start the FastAPI service, confirm `/health`, then save the exact server URL in the panel and accept the per-origin permission request.
- **Model unavailable:** inspect `/v1/providers`; optional imports, checkpoint access, device support, and the last lazy-load error are reported there.
- **Resume after a long pause restarts the current sentence:** Chrome may close an `AUDIO_PLAYBACK` offscreen document after roughly 30 seconds of silence. The content script remembers the most recently highlighted sentence in memory, so Resume recreates the offscreen context and prepares from that sentence. Page text is not persisted, and sub-sentence audio position is not recoverable after teardown.
