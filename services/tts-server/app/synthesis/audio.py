"""Small, dependency-free PCM WAV helpers."""

from __future__ import annotations

import io
import math
import struct
import wave
from collections.abc import Iterable


def floats_to_wav(samples: Iterable[float], sample_rate: int) -> bytes:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    pcm = bytearray()
    count = 0
    for sample in samples:
        value = float(sample)
        if not math.isfinite(value):
            raise ValueError("audio contains a non-finite sample")
        integer = round(max(-1.0, min(1.0, value)) * 32767)
        pcm.extend(struct.pack("<h", integer))
        count += 1
    if count == 0:
        raise ValueError("audio is empty")

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(pcm))
    return output.getvalue()


def wav_duration_ms(data: bytes) -> float:
    with wave.open(io.BytesIO(data), "rb") as wav:
        return wav.getnframes() * 1000.0 / wav.getframerate()
