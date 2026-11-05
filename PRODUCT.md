# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Chrome Manifest V3 extension built with TypeScript, React, and Vite, plus an optional Python/FastAPI local speech service. This stack is specified by the product brief.

## Users

People who want to listen to long-form webpages while staying oriented in the original page, including readers who benefit from synchronized visual focus, hands-free reading, or adjustable narration speed.

## Product Purpose

Turn the primary readable content of the active webpage into controllable narration while highlighting the exact sentence and word being spoken in the original DOM. Success means the zero-setup browser-speech path is dependable, neural engines are optional, and provider changes never disturb extraction, mapping, highlighting, or reader controls.

## Positioning

The product is a source-aware reading system rather than a TTS wrapper: it preserves an explicit, testable chain from semantic text through narration timing back to exact DOM ranges.

## Operating Context

The reader runs in a Chrome side panel while the user remains on the source webpage. A content script owns source extraction and DOM ranges, an offscreen document owns long-lived speech/audio clocks, and a service worker coordinates permissions and contexts. Optional local neural synthesis runs through a user-configured FastAPI server.

## Capabilities and Constraints

- Browser SpeechSynthesis is the always-available baseline and privacy-preserving fallback.
- TADA is the first optional neural provider; Qwen3-TTS follows it.
- Neural providers are loaded lazily and expose only capabilities available at runtime.
- Page content leaves the browser only after the user deliberately selects an external neural provider.
- The extension requests no persistent webpage host access; arbitrary TTS hosts are optional, per-origin permissions.
- Webpage content and reading documents are never persisted.
- The primary target is ordinary semantic HTML. PDF viewers, Google Docs, shadow-heavy editors, and cross-origin frames are explicitly future work.

## Evidence on Hand

The repository began empty. The supplied implementation brief is the sole product authority; there are no existing brand assets, customer claims, benchmarks, or production model artifacts to preserve or invent.

## Product Principles

- Preserve source truth: every spoken character must map deterministically back to the original DOM.
- Use real clocks and real alignment; never fabricate production timing.
- Keep browser speech useful even when every neural component is absent.
- Make privacy boundaries visible and opt-in.
- Separate extraction, narration, buffering, playback, alignment, and rendering so each can evolve independently.

## Accessibility & Inclusion

The side panel must be fully keyboard operable, visibly focused, semantically labelled, understandable without color alone, and compatible with reduced-motion preferences. Page highlights supplement audio and status text rather than serving as the only state signal.
