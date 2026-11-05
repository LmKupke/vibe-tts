from __future__ import annotations

from app.schemas import AlignmentEntry
from app.synthesis.utf16 import alignment_to_utf16, codepoint_to_utf16_offset


def test_codepoint_offsets_convert_to_javascript_utf16_units() -> None:
    text = "A🙂 𐐷word"
    assert [codepoint_to_utf16_offset(text, index) for index in range(len(text) + 1)] == [
        0,
        1,
        3,
        4,
        6,
        7,
        8,
        9,
        10,
    ]

    converted = alignment_to_utf16(
        text,
        [AlignmentEntry(text="word", char_start=4, char_end=8, start_ms=10, end_ms=90)],
    )
    assert (converted[0].char_start, converted[0].char_end) == (6, 10)
