# Vibe TTS local service

This is the optional FastAPI process used by the Chrome extension for local
neural speech. The zero-setup browser-speech provider does not depend on it.

## Run the deterministic development provider

```bash
cd services/tts-server
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
uvicorn app.main:app --host 127.0.0.1 --port 8765
```

The `mock` provider is enabled by default. It emits a real PCM WAV and exact
word timings, making the extension's HTTP/audio/alignment path testable without
model weights or a network connection.

For an environment-file workflow, copy `.env.example` to `.env`, edit it, and
start Uvicorn with `uvicorn app.main:app --env-file .env`. The service reads
environment variables when the application is created; the file is not loaded
implicitly by `app.config`.

## Optional model providers

Heavy dependencies are isolated in extras and models are loaded only on the
first speech request. Merely importing the app, running tests, or querying
health never downloads a checkpoint.

```bash
pip install -e '.[tada]'
export VIBE_TTS_ENABLE_TADA=1
export VIBE_TTS_TADA_PROMPT_AUDIO=/absolute/path/to/reference.wav
export VIBE_TTS_TADA_PROMPT_TRANSCRIPT='Exact words spoken in reference.wav'

# Or, in a separate environment if dependency resolution requires it:
pip install -e '.[qwen]'
export VIBE_TTS_ENABLE_QWEN=1
```

TADA defaults to `HumeAI/tada-3b-ml` with `HumeAI/tada-codec`. Its PyTorch
backend is CUDA-only because that is the supported upstream path. A reference
clip and exact transcript are required; request payloads cannot name arbitrary
local paths or URLs. The backend verifies tokenizer IDs, source-normalization
mapping, token offsets, step logs, and 50 Hz durations before exposing native
word alignment. Any uncertainty fails closed.

TADA is built on Llama 3.2. Before downloading its weights, accept the relevant
Meta Llama license and ensure the server's Hugging Face credentials have access.
For CJK text, the alignment adapter exposes verified model-token source spans
rather than merging the entire script run or inventing sub-token durations; the
extension highlights that exact timed span.

Qwen defaults to `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`. Its checkpoint kind
is discovered after load (`custom_voice`, `voice_design`, or `base`) and only
the corresponding generation API is used. The local API returns complete
waveforms and has no native timing metadata, so Qwen advertises neither
streaming nor native alignment. Word timestamps are never inferred from codec
frames or evenly distributed. CUDA is the supported default; CPU/MPS require
`VIBE_TTS_QWEN_ALLOW_EXPERIMENTAL_DEVICE=1` and should be treated as
experimental until a successful synthesis on that machine.
VoiceDesign checkpoints are reported as non-selectable because the extension
does not yet expose the required per-request instruction. Base checkpoints are
likewise non-selectable until both reference-audio settings are valid.

## Configuration

Boolean values accept `1`, `true`, `yes`, or `on` (case-insensitive). Empty
values fall back to their defaults.

### Service and safety

| Variable                     | Default                          | Meaning                                                                                 |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `VIBE_TTS_HOST`              | `127.0.0.1`                      | Bind host                                                                               |
| `VIBE_TTS_PORT`              | `8765`                           | Bind port                                                                               |
| `VIBE_TTS_DEVICE`            | `auto`                           | Device preference: `auto`, `cpu`, `cuda`, or `mps`; each backend still enforces support |
| `VIBE_TTS_MAX_TEXT_LENGTH`   | `5000`                           | Pipeline text limit in Python characters; lowering is supported                         |
| `VIBE_TTS_ENABLE_MOCK`       | `1`                              | Register the deterministic development provider                                         |
| `VIBE_TTS_ENABLE_TADA`       | `0`                              | Register TADA for lazy loading                                                          |
| `VIBE_TTS_ENABLE_QWEN`       | `0`                              | Register Qwen3-TTS for lazy loading                                                     |
| `VIBE_TTS_OFFLINE`           | `0`                              | Require configured model paths to be complete local snapshots                           |
| `VIBE_TTS_CORS_ORIGINS`      | unset                            | Comma-separated exact extension origins; preferred outside local development            |
| `VIBE_TTS_CORS_ORIGIN_REGEX` | `^chrome-extension://[a-p]{32}$` | Local-development fallback; set blank when exact origins are configured                 |

`VIBE_TTS_MAX_TEXT_LENGTH` can reduce the accepted request size. The public
request schema is also capped at 5,000 characters, so values above 5,000 do not
increase the API limit in this MVP.

### TADA

| Variable                           | Default             | Meaning                                                                |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `VIBE_TTS_TADA_CHECKPOINT`         | `HumeAI/tada-3b-ml` | TADA checkpoint ID or complete local snapshot                          |
| `VIBE_TTS_TADA_ENCODER_CHECKPOINT` | `HumeAI/tada-codec` | Codec/encoder checkpoint ID or complete local snapshot                 |
| `VIBE_TTS_TADA_PROMPT_AUDIO`       | unset               | Absolute path to the administrator-approved reference audio            |
| `VIBE_TTS_TADA_PROMPT_TRANSCRIPT`  | unset               | Exact transcript of the configured reference audio                     |
| `VIBE_TTS_TADA_PROMPT_LANGUAGE`    | unset               | Optional language passed to the TADA encoder                           |
| `VIBE_TTS_TADA_REQUIRE_ALIGNMENT`  | `1`                 | Fail synthesis if verified native word alignment cannot be constructed |

### Qwen3-TTS

| Variable                                  | Default                                | Meaning                                                                       |
| ----------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `VIBE_TTS_QWEN_CHECKPOINT`                | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | Qwen checkpoint ID or complete local snapshot                                 |
| `VIBE_TTS_QWEN_DEFAULT_VOICE`             | `Ryan`                                 | Default speaker for a CustomVoice checkpoint                                  |
| `VIBE_TTS_QWEN_REFERENCE_AUDIO`           | unset                                  | Absolute path to reference audio required by a Base voice-cloning checkpoint  |
| `VIBE_TTS_QWEN_REFERENCE_TRANSCRIPT`      | unset                                  | Exact transcript required with Qwen reference audio                           |
| `VIBE_TTS_QWEN_ALLOW_EXPERIMENTAL_DEVICE` | `0`                                    | Allow CPU/MPS in addition to the CUDA path demonstrated upstream              |
| `VIBE_TTS_QWEN_USE_FLASH_ATTENTION`       | `0`                                    | Request `flash_attention_2` on CUDA; the dependency must already be installed |

API routes are `GET /health`, `GET /v1/providers`, `GET /v1/voices`, and
`POST /v1/speech`. Speech is JSON with Base64 audio so audio and normalized
alignment arrive atomically. Alignment spans are end-exclusive UTF-16 code-unit
offsets so the extension can apply them directly to JavaScript strings and DOM
ranges. Provider-native Python offsets are validated before this wire-format
conversion. Requests are sentence-sized (5,000 characters by default), and
each model provider serializes generation because upstream GPU thread safety is
not guaranteed.

Provider discovery distinguishes `selectable` (enabled, installed, and safe to
lazy-load) from `available` (a real synthesis/decode has succeeded). The exact
lifecycle remains visible in `state`; every provider in this process reports
`local: true`. Voice objects provide both a primary `language` and the complete
`languages` list.

## Security and validation boundary

Keep the service bound to loopback unless you have intentionally added network
authentication and transport security outside this repository. For a stable
installed build, set `VIBE_TTS_CORS_ORIGINS` to its exact
`chrome-extension://<id>` origin and clear the regex fallback. CORS limits
browser callers; it is not authentication. The extension rejects non-loopback
plain HTTP and sends the
current sentence-sized page-text chunk to this process only after the user
selects a neural provider and grants access to the configured origin. Model
reference paths are administrator configuration and cannot be supplied by an
extension request.

The mock provider has been exercised end to end on the current development
host. That host has no supported CUDA setup, so it did not download model
weights or perform real TADA/Qwen synthesis. Automated tests cover adapter
imports, lifecycle and capability contracts, request routing, alignment
validation, and fail-closed behavior. Run a real `/v1/speech` smoke test with
the exact checkpoint, driver, device, and reference material on the intended
CUDA host before deployment.
