from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.errors import NativeAlignmentError
from app.providers.tada_alignment import (
    build_source_normalization_map,
    extract_tada_word_alignment,
)


class FakeTokenizer:
    def __init__(self, ids: list[int], offsets: list[tuple[int, int]]) -> None:
        self.ids = ids
        self.offsets = offsets

    def __call__(self, text: str, **kwargs):
        assert kwargs == {"add_special_tokens": False, "return_offsets_mapping": True}
        return {"input_ids": self.ids, "offset_mapping": self.offsets}

    def encode(self, text: str, *, add_special_tokens: bool):
        assert add_special_tokens is False
        return self.ids

    def convert_ids_to_tokens(self, values: list[int]):
        return [f"tok-{values[0]}"]


@dataclass
class FakeOutput:
    input_text_ids: list[list[int]]
    step_logs: list[dict]
    time_before: list[list[int]]


def test_normalization_map_preserves_deleted_quotes_and_one_to_many_punctuation() -> None:
    quotes = build_source_normalization_map("“Hello”", "Hello")
    assert quotes.source_span(0, 5) == (1, 6)

    ellipsis = build_source_normalization_map("Wait…", "Wait...")
    assert ellipsis.source_span(4, 7) == (4, 5)


def test_tada_tokens_are_verified_and_aggregated_to_exact_source_words() -> None:
    text = "Hello brave world."
    ids = [10, 11, 12, 13]
    offsets = [(0, 5), (5, 11), (11, 17), (17, 18)]
    tokenizer = FakeTokenizer(ids, offsets)
    prefix = [1, 2]
    shift = 2
    output = FakeOutput(
        input_text_ids=[prefix + ids + [99] * shift],
        step_logs=[
            {"step": 2, "token": "Hello", "n_frames_before": 5, "n_frames_after": 6},
            {"step": 3, "token": " brave", "n_frames_before": 6, "n_frames_after": 7},
            {"step": 4, "token": " world", "n_frames_before": 7, "n_frames_after": 1},
            {"step": 5, "token": ".", "n_frames_before": 1, "n_frames_after": 2},
        ],
        # 3 transition frames are trimmed. The remaining decoder length is
        # 5+6+7+1 target frames plus 2 trailing frames = 21 frames.
        time_before=[[3, 5, 6, 7, 1, 2]],
    )
    alignment, diagnostics = extract_tada_word_alignment(
        source_text=text,
        normalized_text=text,
        tokenizer=tokenizer,
        generation_output=output,
        shift_acoustic=shift,
        audio_duration_ms=420,
    )
    assert [(item.text, item.char_start, item.char_end) for item in alignment] == [
        ("Hello", 0, 5),
        ("brave", 6, 11),
        ("world", 12, 17),
    ]
    assert [(item.start_ms, item.end_ms) for item in alignment] == [
        (0, 100),
        (100, 220),
        (220, 360),
    ]
    assert diagnostics["tokens"][1]["mapped_word"] == "brave"
    assert diagnostics["leading_trim_frames"] == 3
    assert diagnostics["decoder_expected_frames"] == 21
    assert "preceding and owned" in diagnostics["timing_ownership"]


def test_tada_alignment_fails_closed_on_token_id_mismatch() -> None:
    tokenizer = FakeTokenizer([10], [(0, 5)])
    output = FakeOutput(
        input_text_ids=[[1, 999, 88]],
        step_logs=[{"step": 1, "token": "Hello", "n_frames_before": 5, "n_frames_after": 1}],
        time_before=[[2, 5, 1]],
    )
    with pytest.raises(NativeAlignmentError, match="do not match"):
        extract_tada_word_alignment(
            source_text="Hello",
            normalized_text="Hello",
            tokenizer=tokenizer,
            generation_output=output,
            shift_acoustic=1,
            audio_duration_ms=100,
        )


def test_tada_alignment_does_not_split_one_model_token_across_two_words() -> None:
    tokenizer = FakeTokenizer([10], [(0, 11)])
    output = FakeOutput(
        input_text_ids=[[1, 10, 88]],
        step_logs=[{"step": 1, "token": "hello world", "n_frames_before": 10, "n_frames_after": 1}],
        time_before=[[2, 10, 1]],
    )
    with pytest.raises(NativeAlignmentError, match="multiple human-visible words"):
        extract_tada_word_alignment(
            source_text="hello world",
            normalized_text="Hello world",
            tokenizer=tokenizer,
            generation_output=output,
            shift_acoustic=1,
            audio_duration_ms=220,
        )


def test_tada_cjk_alignment_uses_verified_token_spans_without_dividing_timing() -> None:
    text = "你好世界"
    ids = [10, 11]
    tokenizer = FakeTokenizer(ids, [(0, 2), (2, 4)])
    output = FakeOutput(
        input_text_ids=[[1, *ids, 88]],
        step_logs=[
            {"step": 1, "token": "你好", "n_frames_before": 4, "n_frames_after": 6},
            {"step": 2, "token": "世界", "n_frames_before": 6, "n_frames_after": 1},
        ],
        time_before=[[2, 4, 6, 1]],
    )

    alignment, diagnostics = extract_tada_word_alignment(
        source_text=text,
        normalized_text=text,
        tokenizer=tokenizer,
        generation_output=output,
        shift_acoustic=1,
        audio_duration_ms=220,
    )

    assert [(item.text, item.char_start, item.char_end) for item in alignment] == [
        ("你好", 0, 2),
        ("世界", 2, 4),
    ]
    assert [(item.start_ms, item.end_ms) for item in alignment] == [(0, 80), (80, 200)]
    assert diagnostics["word_break_strategy"] == "unicode_words_with_verified_cjk_token_spans"


def test_tada_cjk_alignment_keeps_a_multi_character_model_token_whole() -> None:
    text = "你好世界"
    tokenizer = FakeTokenizer([10], [(0, 4)])
    output = FakeOutput(
        input_text_ids=[[1, 10, 88]],
        step_logs=[{"step": 1, "token": text, "n_frames_before": 10, "n_frames_after": 1}],
        time_before=[[2, 10, 1]],
    )

    alignment, _ = extract_tada_word_alignment(
        source_text=text,
        normalized_text=text,
        tokenizer=tokenizer,
        generation_output=output,
        shift_acoustic=1,
        audio_duration_ms=220,
    )

    assert [(item.text, item.start_ms, item.end_ms) for item in alignment] == [(text, 0, 200)]


def test_tada_alignment_fails_closed_when_decoder_timing_does_not_match_waveform() -> None:
    tokenizer = FakeTokenizer([10], [(0, 5)])
    output = FakeOutput(
        input_text_ids=[[1, 10, 88]],
        step_logs=[{"step": 1, "token": "Hello", "n_frames_before": 5, "n_frames_after": 1}],
        time_before=[[2, 5, 1]],
    )
    with pytest.raises(NativeAlignmentError, match="decoded waveform duration"):
        extract_tada_word_alignment(
            source_text="Hello",
            normalized_text="Hello",
            tokenizer=tokenizer,
            generation_output=output,
            shift_acoustic=1,
            audio_duration_ms=999,
        )
