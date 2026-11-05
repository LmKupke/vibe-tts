"""Deterministic provider used for development and contract tests."""

from __future__ import annotations

import hashlib
import math
import re

from app.errors import ProviderSynthesisError
from app.providers.base import BaseBackend, RawSynthesisResult
from app.schemas import AlignmentEntry, ProviderCapabilities, SpeechRequest, Voice
from app.synthesis.audio import floats_to_wav

_WORDS = re.compile(r"\w+(?:['\u2019]\w+)*", re.UNICODE)


class MockTTSBackend(BaseBackend):
    id = "mock"
    name = "Deterministic test voice"
    supported_devices = ("cpu",)
    validated_on_load = True
    ready_without_load = True

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            streaming=False,
            voice_selection=True,
            voice_cloning=False,
            voice_design=False,
            native_alignment=True,
            numeric_rate_control=True,
            languages=["und"],
        )

    def voices(self) -> list[Voice]:
        return [
            Voice(
                id="mock-neutral",
                provider_id=self.id,
                name="Mock Neutral",
                language="und",
                languages=["und"],
                description="Deterministic sine segments for local development",
            ),
            Voice(
                id="mock-bright",
                provider_id=self.id,
                name="Mock Bright",
                language="und",
                languages=["und"],
                description="Higher-pitched deterministic development voice",
            ),
        ]

    def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        sample_rate = 16_000
        samples: list[float] = []
        alignment: list[AlignmentEntry] = []
        voice = request.voice_id or "mock-neutral"
        if voice not in {"mock-neutral", "mock-bright"}:
            raise ProviderSynthesisError(f"unknown mock voice: {voice}")
        voice_offset = 90 if voice == "mock-bright" else 0
        gap_samples = max(1, round(sample_rate * 0.035 / request.speed))

        for match in _WORDS.finditer(request.text):
            word = match.group(0)
            start_sample = len(samples)
            # Stable across processes (unlike Python's randomized hash()).
            digest = hashlib.sha256(word.casefold().encode("utf-8")).digest()
            frequency = 180 + voice_offset + int.from_bytes(digest[:2], "big") % 190
            duration_s = max(0.075, (0.105 + min(len(word), 16) * 0.014) / request.speed)
            tone_samples = max(1, round(sample_rate * duration_s))
            ramp = min(round(sample_rate * 0.008), tone_samples // 3)
            for index in range(tone_samples):
                envelope = 1.0
                if ramp:
                    envelope = min(1.0, index / ramp, (tone_samples - 1 - index) / ramp)
                phase = 2 * math.pi * frequency * index / sample_rate
                samples.append(0.16 * max(0.0, envelope) * math.sin(phase))
            end_sample = len(samples)
            alignment.append(
                AlignmentEntry(
                    text=word,
                    char_start=match.start(),
                    char_end=match.end(),
                    start_ms=start_sample * 1000.0 / sample_rate,
                    end_ms=end_sample * 1000.0 / sample_rate,
                )
            )
            samples.extend([0.0] * gap_samples)

        # Punctuation-only input remains valid and produces a short silent clip.
        if not samples:
            samples = [0.0] * round(sample_rate * 0.12)
        else:
            samples.extend([0.0] * round(sample_rate * 0.02))

        audio = floats_to_wav(samples, sample_rate)
        return RawSynthesisResult(
            audio=audio,
            mime_type="audio/wav",
            duration_ms=len(samples) * 1000.0 / sample_rate,
            native_alignment=alignment,
            diagnostics={
                "sample_rate": sample_rate,
                "alignment_source": "constructed",
                "deterministic": True,
            },
        )
