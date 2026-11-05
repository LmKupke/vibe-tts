# Vibe TTS

**Read with the page.** A Chrome extension that reads webpages and local Markdown aloud, with synchronized sentence and word highlights in the original content.

Built with TypeScript, React, and Chrome Manifest V3. Start with browser speech, or connect the optional local Python service for neural voices.

## What it does

- **Follow along:** highlights the current sentence and, when the voice provides reliable timing, the current word.
- **Control the pace:** play, pause, stop, change speed, skip sentences, or read selected text.
- **Read local Markdown:** switch between source and rendered prose, start from a heading or paragraph, and render bundled Mermaid diagrams offline.
- **Choose a speech backend:** use browser voices immediately, exercise the HTTP pipeline with a deterministic mock provider, or configure optional TADA and Qwen3-TTS adapters.
- **Keep page access temporary:** the toolbar action grants access to the current tab; preferences are stored, page content is not.

## Get started on any machine

You need **Node.js 22+**, npm, Git, and **Chrome 120+**. Python is only required for the optional server.

```bash
git clone https://github.com/LmKupke/vibe-tts.git
cd vibe-tts
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `apps/chrome-extension/dist` inside your clone.
3. Open an article, click the **Vibe TTS** toolbar action, choose a browser voice, and press **Play**.

No API key, model download, or server is required for browser speech. Browser voice availability and word-boundary quality depend on your operating system and voice.

On another computer, repeat these steps. Chrome extension preferences and locally configured models are separate on each machine.

### Read a local Markdown file

In the extension's **Details**, enable **Allow access to file URLs**. Open a `.md` or `.markdown` file in Chrome, reload the tab after changing that permission, and click the Vibe TTS toolbar action.

Use **View source** / **View rendered** to switch views. In rendered view, hover or focus a heading or paragraph to reveal **Read from here**. Mermaid fences render using the bundled runtime; invalid or missing diagram source gets an inline fallback. Switching views stops narration so the next playback can index the active view. Reloading restores Chrome's original raw view without changing the file.

### Keyboard shortcuts

| Action            | Windows / Linux     | macOS                   |
| ----------------- | ------------------- | ----------------------- |
| Play / pause      | Alt + Shift + Space | Control + Shift + Space |
| Previous sentence | Alt + Shift + Left  | Control + Shift + Left  |
| Next sentence     | Alt + Shift + Right | Control + Shift + Right |
| Stop              | Alt + Shift + Down  | Control + Shift + Down  |

Chrome may reserve a shortcut or leave it unassigned. Customize assignments at `chrome://extensions/shortcuts`.

## Optional local speech service

Use **Python 3.11–3.13** and [uv](https://docs.astral.sh/uv/). From the repository root:

```bash
uv sync --project services/tts-server --extra dev
uv run --project services/tts-server uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Configure `http://127.0.0.1:8765` in the extension's side panel and grant access to that origin when prompted. The default mock provider produces deterministic WAV audio and word timings for development; it does not generate spoken narration.

TADA and Qwen3-TTS require separate optional dependencies, checkpoints, and supported hardware. See the [service setup and configuration](services/tts-server/README.md) before enabling them. Real model inference has not been validated on the original non-CUDA development host. Qwen currently provides sentence-level highlighting; TADA word alignment requires a validated adapter and supported CUDA setup.

The service reads process environment variables. For an environment-file workflow, copy `services/tts-server/.env.example` to `services/tts-server/.env`, edit it locally, and pass `--env-file services/tts-server/.env` to Uvicorn. No credentials are required for the default service; any credentials needed for gated checkpoints must stay local.

Keep the service bound to loopback for local use. Remote deployment requires your own authentication and HTTPS; CORS is not authentication.

## Development

```bash
npm run dev              # Rebuild the extension on changes
npm run typecheck        # TypeScript checks
npm run lint             # ESLint
npm run format:check     # Prettier
npm test                 # Unit tests
npm run test:server      # Python tests (install the dev extra first)
npm run build            # Production extension build
```

`npm run check` runs type checking, lint, formatting, JavaScript tests, and server tests. After a rebuild, reload the extension in Chrome; reload the target tab to pick up content-script changes.

For the headed extension smoke test:

```bash
npx playwright install chromium
npm run test:e2e
```

## How it fits together

```text
Webpage / Markdown → semantic document → narration units
                                           ↓
Original DOM highlights ← source offsets ← speech + alignment
```

| Directory               | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `apps/chrome-extension` | Side panel, content extraction, highlighting, and offscreen playback |
| `packages/shared`       | Shared messages, reader state, and alignment contracts               |
| `services/tts-server`   | Optional FastAPI service and speech provider adapters                |
| `fixtures/pages`        | Sample documents for extraction and highlighting tests               |
| `tests`                 | Shared test setup and Playwright extension smoke tests               |
| `docs`                  | Architecture, implementation notes, and troubleshooting              |

Read the [architecture](docs/architecture.md), [DOM mapping](docs/dom-text-mapping.md), [playback and alignment](docs/playback-and-alignment.md), [provider guide](docs/tts-providers.md), and [local development guide](docs/local-development.md).

## Privacy and local configuration

The extension includes no analytics or telemetry. It does not persist webpage content, extracted text, source maps, audio, or alignment; Chrome storage holds preferences only. Browser voices may themselves use remote services, depending on the selected voice.

Choosing a neural provider sends normalized sentence-sized narration units, including a small look-ahead queue, to the configured server. Each request is capped at 4,500 UTF-16 code units. The extension does not upload the entire local file, its path or URL, or the DOM/source map. Only loopback addresses may use plain HTTP; remote servers must use HTTPS.

Local `.env` files, private keys, dependency folders, model weights, caches, and build output are excluded from Git. The committed `.env.example` files contain configuration examples only. Keep access tokens, reference audio, private documents, and machine-specific settings outside tracked files. Before publishing future changes, review `git diff --cached` and, if installed, run:

```bash
gitleaks git --redact --no-banner
```

## Current limits

- Browser voices vary in timing accuracy; highlighting falls back to sentences when word timing is unavailable.
- Chrome can close a silent offscreen document after a long pause. Resume restarts at the last highlighted sentence.
- Chrome's PDF viewer, Google Docs, complex shadow DOM, and cross-origin iframe extraction are not supported in this MVP.
- Starting from an arbitrary point on a normal webpage is not implemented; use selected text or Markdown block controls.
- Optional neural adapters need real synthesis validation on the intended hardware and checkpoint.
