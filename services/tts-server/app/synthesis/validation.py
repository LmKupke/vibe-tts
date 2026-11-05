"""Strict validation of provider alignment at the trust boundary."""

from __future__ import annotations

import math

from app.errors import AlignmentValidationError
from app.schemas import AlignmentEntry


def validate_alignment(
    text: str,
    entries: list[AlignmentEntry],
    *,
    duration_ms: float | None = None,
) -> list[AlignmentEntry]:
    previous_char_end = 0
    previous_time_end = 0.0
    duration_tolerance = 50.0

    for index, entry in enumerate(entries):
        label = f"alignment[{index}]"
        if entry.char_start > entry.char_end:
            raise AlignmentValidationError(f"{label} has char_start after char_end")
        if entry.char_end > len(text):
            raise AlignmentValidationError(f"{label} exceeds source text length")
        if entry.char_start < previous_char_end:
            raise AlignmentValidationError(f"{label} overlaps or is out of source order")
        if not math.isfinite(entry.start_ms) or not math.isfinite(entry.end_ms):
            raise AlignmentValidationError(f"{label} contains a non-finite timestamp")
        if entry.start_ms > entry.end_ms:
            raise AlignmentValidationError(f"{label} has start_ms after end_ms")
        if entry.start_ms + 1e-6 < previous_time_end:
            raise AlignmentValidationError(f"{label} overlaps or is out of time order")
        if duration_ms is not None and entry.end_ms > duration_ms + duration_tolerance:
            raise AlignmentValidationError(f"{label} ends after the audio duration")
        source_slice = text[entry.char_start : entry.char_end]
        if entry.text != source_slice:
            raise AlignmentValidationError(
                f"{label} text does not match source characters [{entry.char_start}:{entry.char_end}]"
            )
        previous_char_end = entry.char_end
        previous_time_end = entry.end_ms
    return entries
