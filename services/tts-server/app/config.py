"""Environment-backed service configuration.

This module deliberately has no Pydantic Settings dependency. Configuration is
read once by :func:`Settings.from_env`; importing the app does not inspect or
initialize any ML framework.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _text(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def _optional_text(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip() or None


def _csv(name: str) -> tuple[str, ...]:
    value = os.getenv(name, "")
    return tuple(dict.fromkeys(part.strip().rstrip("/") for part in value.split(",") if part.strip()))


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    device: str = "auto"
    max_text_length: int = 5_000
    enable_mock: bool = True
    enable_tada: bool = False
    enable_qwen: bool = False
    offline: bool = False
    cors_origins: tuple[str, ...] = ()
    cors_origin_regex: str | None = r"^chrome-extension://[a-p]{32}$"

    tada_checkpoint: str = "HumeAI/tada-3b-ml"
    tada_encoder_checkpoint: str = "HumeAI/tada-codec"
    tada_prompt_audio: str | None = None
    tada_prompt_transcript: str | None = None
    tada_prompt_language: str | None = None
    tada_require_alignment: bool = True

    qwen_checkpoint: str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
    qwen_default_voice: str = "Ryan"
    qwen_reference_audio: str | None = None
    qwen_reference_transcript: str | None = None
    qwen_allow_experimental_device: bool = False
    qwen_use_flash_attention: bool = False

    @classmethod
    def from_env(cls) -> Settings:
        port_raw = _text("VIBE_TTS_PORT", "8765")
        max_text_raw = _text("VIBE_TTS_MAX_TEXT_LENGTH", "5000")
        assert port_raw is not None
        assert max_text_raw is not None
        return cls(
            host=_text("VIBE_TTS_HOST", "127.0.0.1") or "127.0.0.1",
            port=int(port_raw),
            device=(_text("VIBE_TTS_DEVICE", "auto") or "auto").lower(),
            max_text_length=int(max_text_raw),
            enable_mock=_bool("VIBE_TTS_ENABLE_MOCK", True),
            enable_tada=_bool("VIBE_TTS_ENABLE_TADA"),
            enable_qwen=_bool("VIBE_TTS_ENABLE_QWEN"),
            offline=_bool("VIBE_TTS_OFFLINE"),
            cors_origins=_csv("VIBE_TTS_CORS_ORIGINS"),
            cors_origin_regex=_optional_text("VIBE_TTS_CORS_ORIGIN_REGEX", r"^chrome-extension://[a-p]{32}$"),
            tada_checkpoint=_text("VIBE_TTS_TADA_CHECKPOINT", "HumeAI/tada-3b-ml") or "HumeAI/tada-3b-ml",
            tada_encoder_checkpoint=_text("VIBE_TTS_TADA_ENCODER_CHECKPOINT", "HumeAI/tada-codec")
            or "HumeAI/tada-codec",
            tada_prompt_audio=_text("VIBE_TTS_TADA_PROMPT_AUDIO"),
            tada_prompt_transcript=_text("VIBE_TTS_TADA_PROMPT_TRANSCRIPT"),
            tada_prompt_language=_text("VIBE_TTS_TADA_PROMPT_LANGUAGE"),
            tada_require_alignment=_bool("VIBE_TTS_TADA_REQUIRE_ALIGNMENT", True),
            qwen_checkpoint=_text("VIBE_TTS_QWEN_CHECKPOINT", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
            or "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            qwen_default_voice=_text("VIBE_TTS_QWEN_DEFAULT_VOICE", "Ryan") or "Ryan",
            qwen_reference_audio=_text("VIBE_TTS_QWEN_REFERENCE_AUDIO"),
            qwen_reference_transcript=_text("VIBE_TTS_QWEN_REFERENCE_TRANSCRIPT"),
            qwen_allow_experimental_device=_bool("VIBE_TTS_QWEN_ALLOW_EXPERIMENTAL_DEVICE"),
            qwen_use_flash_attention=_bool("VIBE_TTS_QWEN_USE_FLASH_ATTENTION"),
        )
