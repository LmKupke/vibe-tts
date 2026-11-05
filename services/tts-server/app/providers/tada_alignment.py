"""Verified conversion of TADA token durations to source-word alignment.

TADA normalizes source text before tokenization. Model tokens therefore cannot
be assigned directly to browser source offsets. This module creates an explicit
normalized-character -> source-character map, verifies tokenizer IDs against
``GenerationOutput.input_text_ids``, then aggregates model-token timings into
human-visible words. Every uncertain case raises instead of estimating.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.errors import NativeAlignmentError
from app.schemas import AlignmentEntry

_WORDS = re.compile(r"\w+(?:['\u2019]\w+)*", re.UNICODE)


def _contains_cjk_script(value: str) -> bool:
    r"""Recognize scripts for which ``\w+`` is not a useful word boundary.

    Python's standard regex engine merges an entire Han/Japanese/Korean run,
    unlike browser ``Intl.Segmenter`` implementations. For those runs we emit
    verified tokenizer-span units below. A unit may contain multiple characters
    when a model token does; its native duration is never divided or estimated.
    """

    return any(
        "\u3400" <= character <= "\u4dbf"
        or "\u4e00" <= character <= "\u9fff"
        or "\uf900" <= character <= "\ufaff"
        or "\u3040" <= character <= "\u30ff"
        or "\uac00" <= character <= "\ud7af"
        for character in value
    )


@dataclass(frozen=True, slots=True)
class SourceNormalizationMap:
    source: str
    normalized: str
    # One source half-open span for every normalized character.
    normalized_char_sources: tuple[tuple[int, int], ...]
    operations: tuple[dict[str, Any], ...]

    def source_span(self, normalized_start: int, normalized_end: int) -> tuple[int, int]:
        if normalized_start < 0 or normalized_end > len(self.normalized):
            raise NativeAlignmentError("token offset exceeds normalized text")
        if normalized_start >= normalized_end:
            raise NativeAlignmentError("token has an empty normalized offset span")
        spans = self.normalized_char_sources[normalized_start:normalized_end]
        if not spans:
            raise NativeAlignmentError("token offset has no source mapping")
        start = min(span[0] for span in spans)
        end = max(span[1] for span in spans)
        if start >= end:
            raise NativeAlignmentError("normalized token maps only to inserted characters")
        return start, end


@dataclass(frozen=True, slots=True)
class _TokenTiming:
    token_id: int
    token: str
    normalized_start: int
    normalized_end: int
    source_start: int
    source_end: int
    frames: int
    start_ms: float
    end_ms: float


@dataclass(frozen=True, slots=True)
class _MappedCharacter:
    value: str
    source_start: int
    source_end: int


def build_source_normalization_map(source: str, normalized: str) -> SourceNormalizationMap:
    if not source:
        raise NativeAlignmentError("source text is empty")
    if not normalized:
        raise NativeAlignmentError("TADA normalization removed all source text")

    mapped, operations = _tracked_tada_normalize(source)
    tracked_normalized = "".join(character.value for character in mapped)
    if tracked_normalized != normalized:
        raise NativeAlignmentError(
            "installed TADA normalizer differs from the pinned source-mapping implementation",
            {
                "official_normalized_text": normalized,
                "tracked_normalized_text": tracked_normalized,
                "normalization_operations": operations,
            },
        )
    mapping = tuple((character.source_start, character.source_end) for character in mapped)
    return SourceNormalizationMap(source, normalized, mapping, tuple(operations))


def _tracked_tada_normalize(source: str) -> tuple[list[_MappedCharacter], list[dict[str, Any]]]:
    """Mirror ``hume-tada==0.1.9``'s normalizer while retaining source spans.

    The generated string is always compared with the package's actual
    ``normalize_text`` result before the map is trusted. This is intentionally
    version-sensitive: an upstream rule change disables native alignment until
    its source semantics are reviewed here.
    """

    characters = [_MappedCharacter(value, index, index + 1) for index, value in enumerate(source)]
    operations: list[dict[str, Any]] = []
    unicode_substitutions = (
        ("\u201c", '"'),
        ("\u201d", '"'),
        ("\u201e", '"'),
        ("\u201f", '"'),
        ("\u2018", "'"),
        ("\u2019", "'"),
        ("\u201a", "'"),
        ("\u201b", "'"),
        ("\u2013", "-"),
        ("\u2014", "-"),
        ("\u2015", "-"),
        ("\u2010", "-"),
        ("\u2011", "-"),
        ("\u2026", "..."),
        ("\u2039", "<"),
        ("\u203a", ">"),
        ("\u00ab", "<<"),
        ("\u00bb", ">>"),
    )
    for old, new in unicode_substitutions:
        characters = _replace_mapped(characters, old, new, "unicode_punctuation", operations)

    replacements = (
        ("; ", ". ", "semicolon"),
        ('"', "", "remove_double_quote"),
        (":", ",", "colon"),
        ("(", "", "remove_open_parenthesis"),
        (")", "", "remove_close_parenthesis"),
        ("--", "-", "collapse_double_hyphen"),
        ("-", ", ", "hyphen_to_pause"),
        (",,", ",", "collapse_double_comma"),
        (" '", " ", "remove_left_spaced_apostrophe"),
        ("' ", " ", "remove_right_spaced_apostrophe"),
        ("  ", " ", "collapse_double_space"),
    )
    for old, new, rule in replacements:
        characters = _replace_mapped(characters, old, new, rule, operations)

    # `re.sub(r"\s+([.,?!])", r"\1", text)` removes only the whitespace;
    # preserve the punctuation's own source span.
    value = "".join(character.value for character in characters)
    matches = list(re.finditer(r"\s+([.,?!])", value))
    for match in reversed(matches):
        del characters[match.start() : match.end(1) - 1]
    if matches:
        operations.append({"rule": "space_before_punctuation", "count": len(matches)})

    characters = _map_case(characters, str.lower)
    value = "".join(character.value for character in characters)
    sentence_matches = list(re.finditer(r"([.!?]\s*)(\w)", value))
    for match in reversed(sentence_matches):
        start, end = match.span(2)
        replacement = _case_replacement(characters[start:end], str.upper)
        characters[start:end] = replacement
    if sentence_matches:
        operations.append({"rule": "sentence_initial_uppercase", "count": len(sentence_matches)})

    if characters:
        characters[0:1] = _case_replacement(characters[0:1], str.upper)
        operations.append({"rule": "first_character_uppercase", "count": 1})
    return characters, operations


def _replace_mapped(
    characters: list[_MappedCharacter],
    old: str,
    new: str,
    rule: str,
    operations: list[dict[str, Any]],
) -> list[_MappedCharacter]:
    output: list[_MappedCharacter] = []
    index = 0
    count = 0
    while index < len(characters):
        candidate = "".join(character.value for character in characters[index : index + len(old)])
        if candidate == old:
            consumed = characters[index : index + len(old)]
            if new:
                if len(old) == len(new):
                    output.extend(
                        _MappedCharacter(value, source.source_start, source.source_end)
                        for value, source in zip(new, consumed, strict=True)
                    )
                else:
                    source_start = min(character.source_start for character in consumed)
                    source_end = max(character.source_end for character in consumed)
                    output.extend(_MappedCharacter(value, source_start, source_end) for value in new)
            index += len(old)
            count += 1
        else:
            output.append(characters[index])
            index += 1
    if count:
        operations.append({"rule": rule, "old": old, "new": new, "count": count})
    return output


def _map_case(
    characters: list[_MappedCharacter],
    transform: Any,
) -> list[_MappedCharacter]:
    output: list[_MappedCharacter] = []
    for character in characters:
        output.extend(
            _MappedCharacter(value, character.source_start, character.source_end)
            for value in transform(character.value)
        )
    return output


def _case_replacement(
    characters: list[_MappedCharacter],
    transform: Any,
) -> list[_MappedCharacter]:
    if not characters:
        return []
    source_start = min(character.source_start for character in characters)
    source_end = max(character.source_end for character in characters)
    replacement = transform("".join(character.value for character in characters))
    return [_MappedCharacter(value, source_start, source_end) for value in replacement]


def extract_tada_word_alignment(
    *,
    source_text: str,
    normalized_text: str,
    tokenizer: Any,
    generation_output: Any,
    shift_acoustic: int,
    audio_duration_ms: float,
    frame_ms: float = 20.0,
) -> tuple[list[AlignmentEntry], dict[str, Any]]:
    diagnostics: dict[str, Any] = {
        "source_text": source_text,
        "normalized_text": normalized_text,
        "normalization_changed": source_text != normalized_text,
        "normalizer_contract": "hume-tada==0.1.9/tada.utils.text.normalize_text",
        "diagnostic_source_offset_unit": "unicode_code_points",
        "frame_rate_hz": 1000.0 / frame_ms,
    }
    try:
        source_map = build_source_normalization_map(source_text, normalized_text)
        diagnostics["normalization_operations"] = list(source_map.operations)
        token_ids, offsets = _verified_token_offsets(tokenizer, normalized_text)
        diagnostics["token_count"] = len(token_ids)
        input_ids = _one_dimensional_list(generation_output.input_text_ids[0], "input_text_ids")
        text_end = len(input_ids) - int(shift_acoustic)
        text_start = text_end - len(token_ids)
        if text_start < 0 or text_end > len(input_ids):
            raise NativeAlignmentError("TADA target token slice is outside input_text_ids")
        if input_ids[text_start:text_end] != token_ids:
            raise NativeAlignmentError(
                "TADA input token IDs do not match the normalized source tokens",
                {
                    "expected_token_ids": token_ids,
                    "actual_token_ids": input_ids[text_start:text_end],
                    "text_start_step": text_start,
                    "text_end_step": text_end,
                },
            )

        logs = getattr(generation_output, "step_logs", None)
        if not isinstance(logs, list):
            raise NativeAlignmentError("TADA generation returned no step_logs")
        logs_by_step: dict[int, dict[str, Any]] = {}
        for log in logs:
            if not isinstance(log, dict) or "step" not in log:
                raise NativeAlignmentError("TADA step_logs contain a malformed row")
            step = _integer(log["step"], "step")
            if step in logs_by_step:
                raise NativeAlignmentError(f"TADA step_logs contain duplicate step {step}")
            logs_by_step[step] = log

        raw_time_before = _one_dimensional_list(generation_output.time_before[0], "generation time_before")
        if any(frames < 0 for frames in raw_time_before):
            raise NativeAlignmentError("TADA generation time_before contains a negative frame count")
        # Upstream `_decode_wav` expands each acoustic vector to
        # max(1, time_before[pos]) 50 Hz frames, appends the final value as
        # trailing frames, then `generate()` removes time_before[0] leading
        # frames. The official demo's target-token view starts after that
        # transition element and renders each n_frames_before as the span
        # preceding/owned by that token. We accept native alignment only when
        # both representations agree exactly.
        if len(raw_time_before) < len(token_ids) + 2:
            raise NativeAlignmentError(
                "TADA time_before is too short for the transition, target tokens, and trailing frame"
            )
        expected_waveform_frames = (
            sum(max(1, frames) for frames in raw_time_before[:-1]) + raw_time_before[-1] - raw_time_before[0]
        )
        actual_waveform_frames = audio_duration_ms / frame_ms
        if abs(expected_waveform_frames - actual_waveform_frames) > 1.0:
            raise NativeAlignmentError(
                "TADA time_before does not reproduce the decoded waveform duration",
                {
                    "time_before": raw_time_before,
                    "expected_waveform_frames": expected_waveform_frames,
                    "actual_waveform_frames": actual_waveform_frames,
                },
            )

        timings: list[_TokenTiming] = []
        # The trim fully removes the transition segment when it is positive.
        # A zero transition still decodes one acoustic frame, so preserve it.
        leading_offset_frames = max(1, raw_time_before[0]) - raw_time_before[0]
        elapsed_ms = leading_offset_frames * frame_ms
        token_diagnostics: list[dict[str, Any]] = []
        frame_rows: list[tuple[int, int]] = []
        for token_index, (token_id, offset) in enumerate(zip(token_ids, offsets, strict=True)):
            step = text_start + token_index
            log = logs_by_step.get(step)
            if log is None:
                raise NativeAlignmentError(f"TADA step_logs are missing target step {step}")
            frames = _integer(log.get("n_frames_before"), "n_frames_before")
            frames_after = _integer(log.get("n_frames_after"), "n_frames_after")
            if frames < 0:
                raise NativeAlignmentError(f"TADA step {step} has a negative duration")
            if frames_after < 0:
                raise NativeAlignmentError(f"TADA step {step} has a negative following duration")
            raw_index = token_index + 1
            if frames != raw_time_before[raw_index]:
                raise NativeAlignmentError(
                    f"TADA step {step} duration disagrees with generation time_before",
                    {
                        "step_frames": frames,
                        "time_before_frames": raw_time_before[raw_index],
                        "time_before_index": raw_index,
                    },
                )
            if frames_after != raw_time_before[raw_index + 1]:
                raise NativeAlignmentError(
                    f"TADA step {step} following duration disagrees with generation time_before",
                    {
                        "step_frames_after": frames_after,
                        "time_before_frames": raw_time_before[raw_index + 1],
                        "time_before_index": raw_index + 1,
                    },
                )
            frame_rows.append((frames, frames_after))
            # The decoder always emits at least its acoustic token frame even if
            # the predicted gap is zero.
            decoded_frames = max(1, frames)
            normalized_start, normalized_end = offset
            source_start, source_end = source_map.source_span(normalized_start, normalized_end)
            end_ms = elapsed_ms + decoded_frames * frame_ms
            token_text = str(log.get("token", tokenizer.convert_ids_to_tokens([token_id])[0]))
            timing = _TokenTiming(
                token_id=token_id,
                token=token_text,
                normalized_start=normalized_start,
                normalized_end=normalized_end,
                source_start=source_start,
                source_end=source_end,
                frames=decoded_frames,
                start_ms=elapsed_ms,
                end_ms=end_ms,
            )
            timings.append(timing)
            token_diagnostics.append(
                {
                    "step": step,
                    "token_id": token_id,
                    "model_token": token_text,
                    "normalized_start": normalized_start,
                    "normalized_end": normalized_end,
                    "source_start": source_start,
                    "source_end": source_end,
                    "source_text": source_text[source_start:source_end],
                    "frames": decoded_frames,
                    "frames_after": frames_after,
                    "start_ms": elapsed_ms,
                    "end_ms": end_ms,
                    "mapped_word": None,
                }
            )
            elapsed_ms = end_ms

        tolerance_ms = max(100.0, audio_duration_ms * 0.05)
        if elapsed_ms > audio_duration_ms + tolerance_ms:
            raise NativeAlignmentError(
                "TADA token durations extend beyond the decoded waveform",
                {"token_duration_ms": elapsed_ms, "audio_duration_ms": audio_duration_ms},
            )

        words = list(_WORDS.finditer(source_text))
        if not words:
            diagnostics["tokens"] = token_diagnostics
            return [], diagnostics

        token_owner: dict[int, int] = {}
        alignment_groups: list[tuple[int, int, list[int]]] = []
        for word_index, word in enumerate(words):
            indexes = [
                token_index
                for token_index, token in enumerate(timings)
                if token.source_start < word.end() and token.source_end > word.start()
            ]
            if not indexes:
                raise NativeAlignmentError(
                    f"source word {word.group(0)!r} has no TADA token timing",
                    {"word_start": word.start(), "word_end": word.end()},
                )
            if indexes != list(range(indexes[0], indexes[-1] + 1)):
                raise NativeAlignmentError(f"source word {word.group(0)!r} maps to non-contiguous tokens")
            for token_index in indexes:
                previous_owner = token_owner.get(token_index)
                if previous_owner is not None and previous_owner != word_index:
                    raise NativeAlignmentError(
                        "one TADA token spans multiple human-visible words; refusing to split its duration",
                        {
                            "token_index": token_index,
                            "first_word": words[previous_owner].group(0),
                            "second_word": word.group(0),
                        },
                    )
                token_owner[token_index] = word_index
            if not _contains_cjk_script(word.group(0)):
                alignment_groups.append((word.start(), word.end(), indexes))
                continue

            # Preserve model-token timing granularity for CJK. Splitting one
            # model token into dictionary/character words would fabricate
            # sub-token durations, so each output span owns one or more tokens
            # whose mapped source offsets overlap. Overlapping source mappings
            # (possible after normalization) remain a single unit.
            cjk_groups: list[tuple[int, int, list[int]]] = []
            for token_index in indexes:
                token = timings[token_index]
                start = max(word.start(), token.source_start)
                end = min(word.end(), token.source_end)
                if start >= end:
                    raise NativeAlignmentError("CJK token has no visible source span")
                if cjk_groups and start < cjk_groups[-1][1]:
                    previous_start, previous_end, previous_indexes = cjk_groups[-1]
                    cjk_groups[-1] = (
                        previous_start,
                        max(previous_end, end),
                        [*previous_indexes, token_index],
                    )
                else:
                    cjk_groups.append((start, end, [token_index]))
            alignment_groups.extend(cjk_groups)

        entries: list[AlignmentEntry] = []
        for source_start, source_end, indexes in alignment_groups:
            visible_text = source_text[source_start:source_end]
            for token_index in indexes:
                token_diagnostics[token_index]["mapped_word"] = visible_text
            entries.append(
                AlignmentEntry(
                    text=visible_text,
                    char_start=source_start,
                    char_end=source_end,
                    start_ms=timings[indexes[0]].start_ms,
                    end_ms=timings[indexes[-1]].end_ms,
                )
            )

        diagnostics.update(
            {
                "text_start_step": text_start,
                "text_end_step": text_end,
                "token_duration_ms": elapsed_ms,
                "audio_duration_ms": audio_duration_ms,
                "decoder_time_before": raw_time_before,
                "decoder_expected_frames": expected_waveform_frames,
                "decoder_actual_frames": actual_waveform_frames,
                "leading_trim_frames": raw_time_before[0],
                "leading_residual_frames": leading_offset_frames,
                "trailing_frames": raw_time_before[-1],
                "timing_ownership": (
                    "n_frames_before is the decoded span immediately preceding and owned by its "
                    "target text token, matching the official demo visualization"
                ),
                "frame_rows": frame_rows,
                "tokens": token_diagnostics,
                "word_break_strategy": "unicode_words_with_verified_cjk_token_spans",
            }
        )
        return entries, diagnostics
    except NativeAlignmentError as exc:
        merged = dict(diagnostics)
        merged.update(exc.diagnostics)
        raise NativeAlignmentError(str(exc), merged) from exc


def _verified_token_offsets(tokenizer: Any, text: str) -> tuple[list[int], list[tuple[int, int]]]:
    try:
        encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    except Exception as exc:
        raise NativeAlignmentError(
            "TADA tokenizer does not expose required character offset mapping"
        ) from exc

    try:
        token_ids = _one_dimensional_list(encoded["input_ids"], "tokenizer input_ids")
        raw_offsets = encoded["offset_mapping"]
    except (KeyError, TypeError) as exc:
        raise NativeAlignmentError("TADA tokenizer response has no offset_mapping") from exc
    if (
        raw_offsets
        and isinstance(raw_offsets[0], list)
        and raw_offsets[0]
        and isinstance(raw_offsets[0][0], list)
    ):
        raw_offsets = raw_offsets[0]
    offsets: list[tuple[int, int]] = []
    for raw_offset in raw_offsets:
        if len(raw_offset) != 2:
            raise NativeAlignmentError("TADA tokenizer returned a malformed offset")
        start, end = int(raw_offset[0]), int(raw_offset[1])
        if start < 0 or start >= end or end > len(text):
            raise NativeAlignmentError(f"TADA tokenizer returned unsafe offset ({start}, {end})")
        if offsets and start < offsets[-1][1]:
            raise NativeAlignmentError("TADA tokenizer offsets overlap or are out of order")
        offsets.append((start, end))
    if len(token_ids) != len(offsets):
        raise NativeAlignmentError("TADA tokenizer ID and offset counts differ")

    encoded_ids = [int(value) for value in tokenizer.encode(text, add_special_tokens=False)]
    if encoded_ids != token_ids:
        raise NativeAlignmentError("TADA tokenizer call and encode() returned different IDs")
    covered = [False] * len(text)
    for start, end in offsets:
        for index in range(start, end):
            covered[index] = True
    if any(not covered[index] for index, character in enumerate(text) if not character.isspace()):
        raise NativeAlignmentError("TADA tokenizer offsets do not cover normalized text")
    return token_ids, offsets


def _one_dimensional_list(value: Any, label: str) -> list[int]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, tuple):
        value = list(value)
    if isinstance(value, list) and value and isinstance(value[0], list):
        if len(value) != 1:
            raise NativeAlignmentError(f"{label} is unexpectedly batched")
        value = value[0]
    if not isinstance(value, list):
        raise NativeAlignmentError(f"{label} is not a one-dimensional sequence")
    return [int(item) for item in value]


def _integer(value: Any, label: str) -> int:
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, bool):
        raise NativeAlignmentError(f"{label} is not an integer")
    try:
        integer = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise NativeAlignmentError(f"{label} is not an integer") from exc
    if float(value) != integer:
        raise NativeAlignmentError(f"{label} is not an integer")
    return integer
