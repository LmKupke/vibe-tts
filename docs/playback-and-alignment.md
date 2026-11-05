# Playback and alignment

## Normalized reader event layer

Browser speech and audio-file providers have different mechanics but emit the same reader facts: active narration unit, playback position, source character span, pause/resume, completion, and failure.

Browser speech runs one sentence-scoped `SpeechSynthesisUtterance` at a time. `boundary` events contribute the engine's real `charIndex`, optional `charLength`, and `elapsedTime`. If a voice supplies no word boundaries, the sentence remains highlighted and the UI says word focus is unavailable. Seeking or changing rate cancels and restarts the current sentence because Web Speech has no seekable audio clock.

Neural speech returns a complete audio chunk plus zero or more validated `AlignmentEntry` values. The offscreen player reads `HTMLAudioElement.currentTime`; a binary search finds the active entry, whose chunk-relative source offsets are translated into block coordinates. Timers only schedule observation—the media clock is authoritative.

All extension-side character offsets are end-exclusive UTF-16 code-unit offsets, matching JavaScript strings and DOM `Range` offsets. Python providers may produce internal offsets in Unicode code points; the server validates them against the Python source string first, then converts them to UTF-16 code units at the HTTP boundary. This conversion is required for text containing characters outside the Basic Multilingual Plane, such as many emoji. When diagnostics are requested, `alignment_offset_unit` is `utf16_code_units`.

Selection narration uses queue-relative sentence indices and carries the exact clipped source span. Sentence and word highlights are therefore constrained to the selected characters even when a selection begins or ends inside a sentence.

## Queue and cancellation

The current sentence plays while up to three following sentences synthesize. Every load, seek, provider change, or navigation increments a generation and aborts outstanding fetches. A result from an old generation is discarded even if its provider ignored cancellation.

Chrome may tear down an `AUDIO_PLAYBACK` offscreen document after a prolonged silent pause. The content script retains the most recently highlighted sentence and, when relevant, the original selection bounds in memory. If playback controls are used after teardown, the service worker recreates the offscreen document and reconstructs the queue from that sentence, clipped to the remaining selection. Recovery intentionally restarts the sentence; webpage content and sub-sentence playback time are never persisted.

## Validation

Alignment is rejected when offsets escape the source string, spans or times reverse, entries are unordered, or spans unexpectedly overlap. Text/source mismatches are surfaced as warnings. No production adapter distributes words proportionally over clip duration.

Qwen3-TTS currently degrades to sentence-level highlighting because its released local Python wrapper returns waveform and sample rate without word timing. That is a truthful reduction in precision, not an excuse to synthesize timestamps.
