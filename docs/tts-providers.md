# TTS providers

## Browser speech

Browser speech is the default and fallback. It requires no TTS server and uses the current Chrome profile's voices. The UI distinguishes `SpeechSynthesisVoice.localService` voices so it does not claim that every OS/browser voice is fully local. Boundary availability varies by voice and platform.

## HTTP provider contract

The extension defaults to `http://127.0.0.1:8765` and requests permission for the configured origin only when the user chooses a neural provider. A non-loopback URL is an explicit trust boundary because the selected server receives the current sentence-sized text chunk.

```http
GET  /health
GET  /v1/providers
GET  /v1/voices?provider_id=tada
POST /v1/speech
```

The speech response is JSON containing base64 audio, MIME type, measured duration, and validated alignment. Alignment character spans are end-exclusive UTF-16 code-unit offsets at the HTTP boundary, matching JavaScript and DOM coordinates. Providers may work in Python Unicode code points internally; the service validates those spans before converting them for the wire. Audio does not pass through the service worker.

## TADA

The server's alignment-sensitive TADA adapter targets the official PyTorch [`hume-tada` 0.1.9 package](https://pypi.org/project/hume-tada/) and the [`HumeAI/tada-1b`](https://huggingface.co/HumeAI/tada-1b) or multilingual [`HumeAI/tada-3b-ml`](https://huggingface.co/HumeAI/tada-3b-ml) checkpoints. Its official output exposes token IDs and 50 Hz step timing. Those are model-token anchors, not visible words, so the adapter verifies tokenizer IDs, maps normalized token spans back to original characters, groups subwords into visible words, and fails closed if counts or timing disagree. The official [TADA repository](https://github.com/HumeAI/tada) is the implementation authority.

CUDA is the documented PyTorch path. Official [MLX TADA](https://github.com/HumeAI/tada/tree/main/apple) is useful on Apple Silicon, but its current public output omits token timing and therefore advertises no native alignment in this MVP.

## Qwen3-TTS

The Qwen adapter uses the official [`qwen-tts`](https://pypi.org/project/qwen-tts/) package and [Qwen3-TTS repository](https://github.com/QwenLM/Qwen3-TTS). It supports the released 1.7B and 0.6B 12 Hz checkpoints and derives voice-clone, voice-design, preset-voice, and instruction capabilities from the loaded checkpoint type.

The current local wrapper returns full waveforms and sample rate. Its `non_streaming_mode` option does not expose incremental audio, and it returns no reliable source timing. Consequently the adapter reports `streaming=false` and `nativeAlignment=false`. Forced alignment is intentionally not bundled until a product requirement and measured provider output justify it.

## Mock provider

The development mock writes known tone/silence segments itself, so its timing is a consequence of generated sample counts rather than a words-per-minute estimate. It is never presented as a production voice.

## Validation status

The browser and mock paths have been exercised end to end without model weights. On the current non-CUDA development host, real TADA and Qwen checkpoints were not downloaded and no real neural model synthesis was run. Their adapters, lazy-load lifecycle, capability reporting, request contracts, alignment validation, and fail-closed behavior are covered by automated tests; each real checkpoint/device combination still needs a synthesis smoke test on its intended CUDA host.
