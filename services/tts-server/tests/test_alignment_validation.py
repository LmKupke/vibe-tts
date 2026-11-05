from __future__ import annotations

import pytest

from app.errors import AlignmentValidationError
from app.schemas import AlignmentEntry
from app.synthesis.validation import validate_alignment


def entry(text: str, start: int, end: int, start_ms: float, end_ms: float) -> AlignmentEntry:
    return AlignmentEntry(
        text=text,
        char_start=start,
        char_end=end,
        start_ms=start_ms,
        end_ms=end_ms,
    )


def test_validation_accepts_ordered_exact_unicode_alignment() -> None:
    text = "Hi, 世界!"
    values = [entry("Hi", 0, 2, 0, 100), entry("世界", 4, 6, 120, 300)]
    assert validate_alignment(text, values, duration_ms=320) == values


@pytest.mark.parametrize(
    "text,values,message",
    [
        ("hello", [entry("HELLO", 0, 5, 0, 10)], "does not match"),
        ("hello", [entry("hello", 0, 6, 0, 10)], "source text length"),
        (
            "one two",
            [entry("two", 4, 7, 0, 20), entry("one", 0, 3, 20, 40)],
            "source order",
        ),
        (
            "one two",
            [entry("one", 0, 3, 20, 40), entry("two", 4, 7, 30, 50)],
            "time order",
        ),
        ("one", [entry("one", 0, 3, 0, 200)], "audio duration"),
    ],
)
def test_validation_rejects_malformed_provider_output(
    text: str,
    values: list[AlignmentEntry],
    message: str,
) -> None:
    with pytest.raises(AlignmentValidationError, match=message):
        validate_alignment(text, values, duration_ms=100)
