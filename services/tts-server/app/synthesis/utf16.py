"""Convert internal Python string spans to the extension's UTF-16 offset contract."""

from __future__ import annotations

from app.schemas import AlignmentEntry


def codepoint_to_utf16_offset(text: str, index: int) -> int:
    if index < 0 or index > len(text):
        raise ValueError(f"code-point offset {index} is outside source text")
    return len(text[:index].encode("utf-16-le", errors="surrogatepass")) // 2


def alignment_to_utf16(text: str, entries: list[AlignmentEntry]) -> list[AlignmentEntry]:
    """Translate validated Python code-point spans for JS String/DOM consumers."""

    return [
        entry.model_copy(
            update={
                "char_start": codepoint_to_utf16_offset(text, entry.char_start),
                "char_end": codepoint_to_utf16_offset(text, entry.char_end),
            }
        )
        for entry in entries
    ]
