# Architecture

## System boundary

Vibe TTS is organized around the invariant below. Speech engines sit beneath this chain and do not own it.

```text
web document
  -> semantic ReadingDocument
  -> narration units
  -> time-aligned source character spans
  -> cached DOM ranges
  -> original page highlights
```

## Repository layout

```text
apps/chrome-extension/
  scripts/                 deterministic extension build
  src/background/          MV3 coordination and permissions
  src/content/             extraction, DOM maps, highlights, selection
  src/offscreen/           speech synthesis, audio, queue, clock
  src/sidepanel/           React command surface
  src/storage/             non-content preferences
packages/shared/src/       domain, messages, state, validation, lookup
services/tts-server/app/   FastAPI, registries, lifecycle, providers
fixtures/pages/            extraction and browser fixtures
tests/e2e/                 loaded-extension smoke flows
docs/                      design and operational decisions
```

## Chrome contexts

### Content script

The content script is the only context that stores actual `Node`, `Text`, and `Range` objects. It extracts a serializable `ReadingDocument`, retains the corresponding source map in memory, reconstructs ranges by ID and character offset, paints highlights, maps selections, and applies the user-respecting scroll policy.

For a directly opened local `.md` or `.markdown` file, initialization keeps Chrome's exact raw `<pre>` and inserts a styled semantic `<main>` beside it. A persistent page control switches the active root by hiding and inerting the other one. Neither root is rebuilt, so Mermaid SVG and disclosure state persist; each root also retains its own selection and scroll position. The tab title switches between Chrome's original title in source view and the first rendered H1 when available. The renderer escapes raw HTML and does not automatically load remote images. All changes are tab-local: they do not write to the source file, and reloading restores Chrome's raw display.

Rendered extraction uses the ordinary article path. Source extraction parses Markdown into spoken spans that retain raw offsets while excluding syntax, frontmatter, comments, fenced and standalone code, Mermaid definitions, URL destinations, and page-control copy. A view switch invalidates the cached extraction, clears highlights, and notifies the worker to stop any prepared or playing session; the next prepare builds a map from the active root.

Rendered Markdown also installs a narration-skipped left gutter for H1–H6 and paragraph starts. Each control carries a tab-local block key that resolves to the live rendered element. A `prepare-from-block` command finds that element in the existing `BlockDOMMap`, computes its first sentence's document index, and then uses the same playback and highlight pipeline as every other start mode. The control label and gutter UI never become narration units, and source view hides and inerts the entire gutter.

Mermaid is packaged into the extension build and renders case-insensitive `mermaid`, `mmd`, `{.mermaid}`, and `{.mmd}` fences locally under strict security settings. The integration does not inject a CDN script, enable click callbacks, or permit diagram links. A successful render produces an accessible SVG figure with a source disclosure; a rejected definition produces an isolated error with the same preserved source. Both forms are visual-only and excluded from `ReadingDocument` extraction, so diagram implementation details cannot leak into speech or alignment.

Before Markdown rendering, a fence- and inline-code-aware scanner isolates high-confidence standalone flattened Mermaid SVG style spans left by lossy exporters outside quoted or code examples. Unique markers cross the Markdown parser and become static, accessible source-missing notes before extraction. Prefix and suffix labels on the same exported line are preserved, while the generated CSS and diagnostic remain narration-skipped in both views. This path never requests the Mermaid runtime because no definition exists to render, and the untouched raw source stays available in source view.

### Service worker

The service worker validates and routes typed messages, obtains the active tab, injects the content script under `activeTab`, creates the offscreen document on demand, and stops stale sessions after navigation or tab closure. A block-start request is bound to the content script's originating `sender.tab`; the worker validates its block key and URL instead of looking up whichever tab becomes active later. It is intentionally recoverable because Manifest V3 may suspend it at any time.

### Offscreen document

The offscreen document owns APIs that require a `Window`: `speechSynthesis`, `HTMLAudioElement`, object URLs, the audio playback clock, prefetch cancellation, and the live reader state machine. It never paints UI. It is a recoverable playback context, not durable storage: Chrome may close an `AUDIO_PLAYBACK` offscreen document after prolonged silence.

### Side panel

React renders snapshots and sends commands. It is safe to close and reopen because it is neither the playback clock nor the owner of the reading document.

## State ownership and recovery

Live page content and source maps remain in the content script. Live playback and queue state remain in the offscreen document. For local Markdown, the tab also owns the two mounted view roots plus their in-memory selection and scroll snapshots. The content script remembers the most recently highlighted sentence and any active selection bounds in memory; if Chrome closes the offscreen document during a long pause, the worker reconstructs the remaining queue from that point and restarts the sentence without escaping the selection. The worker stores only identifiers needed to route the current session and can rediscover both contexts after suspension. Only user preferences are written to `chrome.storage`; webpage content is never persisted.

Each prepare/seek/navigation increments a session generation. Async synthesis results carry the generation that created them and are ignored after it changes. Abort controllers cancel network work immediately where supported.

Inline block starts add a shorter-lived cancellation layer around preparation. Content-script and worker revisions suppress stale completion and control-state updates, so the most recent block request wins. A newer inline request, any panel prepare or transport command, navigation, content invalidation, or Markdown view change cancels pending inline work.

## Narration abstraction

The reader consumes `NarrationEvent` values rather than model-specific output. Browser speech emits boundary and lifecycle events directly. Neural providers synthesize audio plus validated alignment, and the audio adapter emits the same normalized position events from `HTMLAudioElement.currentTime`. Provider capability discovery decides which controls are exposed.

The server follows the parallel separation `TTSRegistry -> ModelManager -> TTSBackend -> SynthesisPipeline -> AlignmentRegistry`. Route handlers do not load models or interpret provider-specific metadata.

## Permissions

- `activeTab`: grants source-page access only after a user gesture.
- `scripting`: injects the content script into that one active tab.
- `sidePanel`: hosts the controls beside the source page.
- `offscreen`: provides a recoverable window context for speech and audio.
- `storage`: stores preferences only.
- optional host access: the manifest declares HTTP/HTTPS patterns so Chrome can offer a runtime grant, but the extension requests only the configured TTS server origin when the user selects a neural provider.

No persistent webpage or `file:///*` host permission is requested. Chrome's **Allow access to file URLs** setting must be enabled before an `activeTab` gesture can authorize the current local-file tab; the worker checks that setting and reports actionable recovery copy before injection. Rendering a Markdown file does not widen that grant or provide directory access. Browser speech keeps page text in the browser. Neural speech sends the current sentence-sized chunk to the user-configured server, so non-loopback URLs are an explicit trust boundary and require HTTPS. The extension has no analytics or telemetry and persists no page text, rendered Markdown, DOM map, audio, or alignment data.
